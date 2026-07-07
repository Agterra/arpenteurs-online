/**
 * In-memory game rooms: single-flight rehydration, the synchronous action
 * pipeline (validate → authorize → reduce → broadcast), write-behind event log,
 * periodic full-state snapshots, presence, eviction. Single-node by design.
 */
import type { Peer } from 'crossws'
import type { LogEntry, PlayerId, ServerGameState } from '#shared/types/game'
import {
  ClientMsg,
  EPHEMERAL_TYPES,
  type ClientMsgT,
  type ServerMsg,
} from '#shared/schemas/messages'
import { ActionError, applyAction } from './reducer'
import { buildEventFor, renderPersistedLog, snapshotVis } from './events'
import { redactStateFor } from './visibility'

const SNAPSHOT_EVERY_ACTIONS = 10
const SNAPSHOT_DEBOUNCE_MS = 5_000
const EVICT_EMPTY_MS = 10 * 60_000
const EVICT_ENDED_MS = 5 * 60_000
const RATE_MAX_TOKENS = 60
const RATE_REFILL_PER_S = 20

interface Bucket {
  tokens: number
  last: number
}

export interface Room {
  gameId: string
  lobbyId: string
  hostId: PlayerId
  state: ServerGameState
  peers: Map<string, { peer: Peer; playerId: PlayerId }>
  buckets: Map<PlayerId, Bucket>
  persistChain: Promise<void>
  paused: boolean
  actionsSinceSnapshot: number
  snapshotTimer: ReturnType<typeof setTimeout> | null
  evictTimer: ReturnType<typeof setTimeout> | null
}

const rooms = new Map<string, Promise<Room>>()

/** Live registry stats for the backoffice — public metadata only, never card contents. */
export async function liveRoomStats() {
  const out: { gameId: string; lobbyId: string; turnNumber: number; step: string; status: string; connectedPlayers: number; seq: number }[] = []
  for (const p of rooms.values()) {
    const room = await p.catch(() => null)
    if (!room) continue
    out.push({
      gameId: room.gameId,
      lobbyId: room.lobbyId,
      turnNumber: room.state.turn.turnNumber,
      step: room.state.turn.step,
      status: room.state.status,
      connectedPlayers: new Set([...room.peers.values()].map((e) => e.playerId)).size,
      seq: room.state.seq,
    })
  }
  return out
}

// ---------- lifecycle ----------

export function getRoom(gameId: string): Promise<Room> {
  let p = rooms.get(gameId)
  if (!p) {
    p = rehydrate(gameId)
    rooms.set(gameId, p)
    p.catch(() => rooms.delete(gameId)) // failed load must not poison the slot
  }
  return p
}

async function rehydrate(gameId: string): Promise<Room> {
  const game = await db.game.findUnique({
    where: { id: gameId },
    include: { lobby: { select: { id: true, hostId: true } } },
  })
  if (!game) throw createError({ statusCode: 404, statusMessage: 'Game not found' })
  const state = game.snapshot as unknown as ServerGameState
  state.seq = game.snapshotSeq
  return {
    gameId,
    lobbyId: game.lobby.id,
    hostId: game.lobby.hostId,
    state,
    peers: new Map(),
    buckets: new Map(),
    persistChain: Promise.resolve(),
    paused: false,
    actionsSinceSnapshot: 0,
    snapshotTimer: null,
    evictTimer: null,
  }
}

export async function evictRoom(room: Room, reason: string) {
  rooms.delete(room.gameId)
  if (room.snapshotTimer) clearTimeout(room.snapshotTimer)
  if (room.evictTimer) clearTimeout(room.evictTimer)
  await writeSnapshot(room).catch((err) =>
    console.error(`[room ${room.gameId}] final snapshot failed (${reason})`, err),
  )
}

/** Flush every live room (Nitro close hook → dev reloads are lossless). */
export async function flushAllRooms() {
  for (const p of rooms.values()) {
    const room = await p.catch(() => null)
    if (room) await writeSnapshot(room).catch(() => {})
  }
}

// ---------- peers & presence ----------

export function attachPeer(room: Room, peer: Peer, playerId: PlayerId) {
  // single session per player: supersede the old peer without flipping presence
  for (const [pid, entry] of room.peers) {
    if (entry.playerId === playerId) {
      room.peers.delete(pid)
      try {
        entry.peer.close(4000, 'superseded by a new connection')
      } catch {}
    }
  }
  room.peers.set(peer.id, { peer, playerId })
  if (room.evictTimer) {
    clearTimeout(room.evictTimer)
    room.evictTimer = null
  }
  broadcastPresence(room)
}

export function detachPeer(room: Room, peer: Peer) {
  const entry = room.peers.get(peer.id)
  if (!entry) return
  room.peers.delete(peer.id)
  broadcastPresence(room)
  if (room.peers.size === 0) {
    void writeSnapshot(room).catch(() => {})
    room.evictTimer = setTimeout(
      () => {
        if (room.peers.size === 0) void evictRoom(room, 'empty')
      },
      room.state.status === 'ended' ? EVICT_ENDED_MS : EVICT_EMPTY_MS,
    )
  }
}

function send(peer: Peer, msg: ServerMsg) {
  peer.send(JSON.stringify(msg))
}

function broadcastPresence(room: Room) {
  const connected = [...new Set([...room.peers.values()].map((e) => e.playerId))]
  for (const { peer } of room.peers.values()) send(peer, { t: 'presence', connected })
}

// ---------- sync ----------

export async function sendSync(room: Room, peer: Peer, playerId: PlayerId) {
  const state = redactStateFor(playerId, room.state)
  const log = await loadLogTail(room, playerId)
  send(peer, { t: 'sync', seq: room.state.seq, state, log })
}

async function loadLogTail(room: Room, playerId: PlayerId): Promise<LogEntry[]> {
  const seat = room.state.players[playerId]?.seat
  const rows = await db.gameEvent.findMany({
    where: { gameId: room.gameId },
    orderBy: { seq: 'desc' },
    take: 200,
  })
  return rows
    .reverse()
    .map((r) => {
      const priv = (r.privateLines as Record<string, string> | null)?.[String(seat)]
      const line = priv ?? r.publicLine
      if (!line) return null
      return {
        seq: r.seq,
        ts: r.createdAt.getTime(),
        actor: null,
        kind: r.type,
        line,
      } satisfies LogEntry
    })
    .filter((l): l is LogEntry => !!l)
}

// ---------- persistence ----------

function persistEvent(
  room: Room,
  seq: number,
  actorSeat: number | null,
  type: string,
  publicLine: string | null,
  privateLines: Record<number, string> | null,
) {
  room.persistChain = room.persistChain.then(async () => {
    let attempts = 0
    for (;;) {
      try {
        await db.gameEvent.create({
          data: { gameId: room.gameId, seq, actorSeat, type, publicLine, privateLines: privateLines ?? undefined },
        })
        room.paused = false
        return
      } catch (err) {
        attempts++
        console.error(`[room ${room.gameId}] event persist failed (attempt ${attempts})`, err)
        // never continue past a gap: pause the room and retry with backoff
        room.paused = true
        if (attempts >= 5) {
          await writeSnapshot(room).catch(() => {})
          console.error(`[room ${room.gameId}] giving up on event ${seq} — snapshot forced, room degraded`)
          room.paused = false
          return
        }
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempts, 5_000)))
      }
    }
  })
}

async function writeSnapshot(room: Room) {
  await room.persistChain.catch(() => {})
  await db.game.update({
    where: { id: room.gameId },
    data: { snapshot: room.state as never, snapshotSeq: room.state.seq },
  })
  room.actionsSinceSnapshot = 0
}

function maybeSnapshot(room: Room, force = false) {
  room.actionsSinceSnapshot++
  if (force || room.actionsSinceSnapshot >= SNAPSHOT_EVERY_ACTIONS) {
    if (room.snapshotTimer) clearTimeout(room.snapshotTimer)
    room.snapshotTimer = null
    void writeSnapshot(room).catch((err) => console.error(`[room ${room.gameId}] snapshot failed`, err))
    return
  }
  if (!room.snapshotTimer) {
    room.snapshotTimer = setTimeout(() => {
      room.snapshotTimer = null
      void writeSnapshot(room).catch(() => {})
    }, SNAPSHOT_DEBOUNCE_MS)
  }
}

// ---------- game end → lobby transition ----------

async function finalizeEndedGame(room: Room) {
  await writeSnapshot(room).catch(() => {})
  await db.game.update({
    where: { id: room.gameId },
    data: { status: 'FINISHED', endedAt: new Date(), winnerSeat: room.state.winnerSeat },
  })
  await db.lobby.update({ where: { id: room.lobbyId }, data: { status: 'OPEN' } })
  await db.lobbySeat.updateMany({ where: { lobbyId: room.lobbyId }, data: { isReady: false } })
}

// ---------- rate limiting ----------

function takeToken(room: Room, playerId: PlayerId): boolean {
  const now = Date.now()
  let b = room.buckets.get(playerId)
  if (!b) {
    b = { tokens: RATE_MAX_TOKENS, last: now }
    room.buckets.set(playerId, b)
  }
  b.tokens = Math.min(RATE_MAX_TOKENS, b.tokens + ((now - b.last) / 1000) * RATE_REFILL_PER_S)
  b.last = now
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

// ---------- the message pipeline ----------

export async function handleMessage(room: Room, peer: Peer, playerId: PlayerId, raw: unknown) {
  if (!takeToken(room, playerId)) return send(peer, { t: 'error', code: 'RATE_LIMITED', message: 'Slow down' })

  const parsed = ClientMsg.safeParse(raw)
  if (!parsed.success)
    return send(peer, { t: 'error', code: 'BAD_MSG', message: parsed.error.issues[0]?.message ?? 'Invalid message' })
  const msg = parsed.data

  if (msg.type === 'resync') return sendSync(room, peer, playerId)
  if (EPHEMERAL_TYPES.has(msg.type)) return handleEphemeral(room, peer, playerId, msg)
  if (room.paused) return send(peer, { t: 'error', code: 'SERVER_PAUSED', message: 'Server is catching up, retry shortly' })

  // turn control: active player or host (etiquette guard); everything else self-scoped in the reducer
  if (msg.type.startsWith('turn.') && playerId !== room.state.turn.activePlayer && playerId !== room.hostId)
    return send(peer, { t: 'error', code: 'NOT_ACTIVE', message: 'Only the active player (or host) drives the turn' })
  // ending the game (with an arbitrary winner) is host-only; anyone can still concede
  if (msg.type === 'game.finish' && playerId !== room.hostId)
    return send(peer, { t: 'error', code: 'HOST_ONLY', message: 'Only the host can end the game' })

  // ---- synchronous section: no awaits between visibility snapshot and broadcast ----
  const before = snapshotVis(room.state)
  let result
  try {
    result = applyAction(room.state, playerId, msg)
  } catch (err) {
    if (err instanceof ActionError) return send(peer, { t: 'error', code: err.code, message: err.message })
    console.error(`[room ${room.gameId}] reducer crash on ${msg.type}`, err)
    return send(peer, { t: 'error', code: 'INTERNAL', message: 'Action failed' })
  }
  room.state.seq++
  const after = snapshotVis(room.state)

  for (const { peer: p, playerId: viewer } of room.peers.values()) {
    try {
      send(p, buildEventFor(viewer, room.state, playerId, msg, result, before, after))
    } catch (err) {
      console.error(`[room ${room.gameId}] event build failed for ${viewer}`, err)
      void sendSync(room, p, viewer).catch(() => {})
    }
  }
  // ---- end synchronous section ----

  const { publicLine, privateLines } = renderPersistedLog(room.state, playerId, msg, result, before, after)
  const actorSeat = room.state.players[playerId]?.seat ?? null
  persistEvent(room, room.state.seq, actorSeat, msg.type, publicLine, privateLines)

  // arrows are combat-scoped: clear them whenever the turn state moves
  if (msg.type.startsWith('turn.')) broadcastEphemeral(room, playerId, 'arrows.clear', {})

  if (room.state.status === 'ended' && result.status) {
    maybeSnapshot(room, true)
    void finalizeEndedGame(room).catch((err) => console.error(`[room ${room.gameId}] finalize failed`, err))
  } else {
    maybeSnapshot(room, msg.type === 'deck.keep' || msg.type === 'game.concede')
  }
}

function handleEphemeral(room: Room, peer: Peer, playerId: PlayerId, msg: ClientMsgT) {
  if (msg.type === 'card.position') {
    const card = room.state.cards[msg.cardId]
    if (!card || card.controllerId !== playerId || card.zone.kind !== 'battlefield')
      return send(peer, { t: 'error', code: 'NOT_CONTROLLER', message: "You don't control this card" })
    card.x = msg.x
    card.y = msg.y
    broadcastEphemeral(room, playerId, 'card.position', { cardId: msg.cardId, x: msg.x, y: msg.y })
  } else if (msg.type === 'card.arrow') {
    broadcastEphemeral(room, playerId, 'card.arrow', {
      fromCardId: msg.fromCardId,
      toCardId: msg.toCardId ?? null,
      toPlayerId: msg.toPlayerId ?? null,
      on: msg.on,
    })
  }
}

function broadcastEphemeral(
  room: Room,
  actor: PlayerId,
  type: 'card.position' | 'card.arrow' | 'arrows.clear',
  payload: Record<string, unknown>,
) {
  for (const { peer } of room.peers.values()) send(peer, { t: 'ephemeral', type, actor, payload })
}
