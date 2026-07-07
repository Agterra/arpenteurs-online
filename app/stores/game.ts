/**
 * Client game store — server truth only (PLAN §4: no optimistic state).
 * `applyEvent` is dumb field assignment: events carry resulting values.
 * Seq discipline: any gap → flag `resyncing`, ask the socket (via the bound
 * sender) for a full sync, ignore events until it lands.
 */
import { defineStore } from 'pinia'
import type { CardId, ClientGameState, LogEntry, PlayerId, RedactedCard, ZoneKind } from '#shared/types/game'
import type { EphemeralMsg, GameEventMsg, SyncMsg, ZonePatch } from '#shared/schemas/messages'

export type ConnStatus = 'connecting' | 'open' | 'resyncing' | 'down'

export interface ArrowView {
  fromCardId: CardId
  toCardId: CardId | null
  toPlayerId: PlayerId | null
  actor: PlayerId
}

export interface LastExtra {
  seq: number
  type: string
  actor: PlayerId | null
  extra: Record<string, unknown>
}

const LOG_CAP = 500
const RESYNC_THROTTLE_MS = 5000

export const useGameStore = defineStore('game', {
  state: () => ({
    state: null as ClientGameState | null,
    lastSeq: 0,
    log: [] as LogEntry[],
    conn: 'connecting' as ConnStatus,
    connectedPlayers: [] as PlayerId[],
    arrows: [] as ArrowView[],
    /** transient: last event `extra` payload (dice results, reveals…) for toasts/dialogs */
    lastExtra: null as LastExtra | null,
    _resyncSender: null as (() => void) | null,
    _lastResyncAt: 0,
  }),

  getters: {
    you: (s): PlayerId | null => s.state?.you ?? null,
    /** Players ordered by seat. */
    seatedPlayers: (s) => Object.values(s.state?.players ?? {}).sort((a, b) => a.seat - b.seat),
    myHandIds: (s): CardId[] => {
      if (!s.state) return []
      const hand = s.state.zones.perPlayer[s.state.you]?.hand
      return Array.isArray(hand) ? hand : []
    },
    isMyTurn: (s) => !!s.state && s.state.turn.activePlayer === s.state.you,
  },

  actions: {
    /** The socket composable registers how a resync request is actually sent. */
    bindResyncSender(fn: (() => void) | null) {
      this._resyncSender = fn
    },

    /** Flag desync + request a full sync, at most once per 5 s. */
    requestResync() {
      this.conn = 'resyncing'
      const now = Date.now()
      if (now - this._lastResyncAt >= RESYNC_THROTTLE_MS) {
        this._lastResyncAt = now
        this._resyncSender?.()
      }
    },

    setConn(conn: ConnStatus) {
      this.conn = conn
    },

    setPresence(connected: PlayerId[]) {
      this.connectedPlayers = connected
    },

    applySync(msg: SyncMsg) {
      this.state = msg.state
      this.log = msg.log.slice(-LOG_CAP)
      this.lastSeq = msg.seq
      this.conn = 'open'
    },

    applyEvent(ev: GameEventMsg) {
      if (!this.state) return
      if (this.conn === 'resyncing') {
        this.requestResync() // re-ask (throttled) in case the first request was lost
        return
      }
      if (ev.seq !== this.lastSeq + 1) {
        this.requestResync()
        return
      }
      this.lastSeq = ev.seq
      const s = this.state
      s.seq = ev.seq

      if (ev.cards) for (const card of ev.cards) s.cards[card.id] = card as RedactedCard
      if (ev.removed) for (const id of ev.removed) delete s.cards[id]
      if (ev.zones) for (const patch of ev.zones) applyZonePatch(s, patch)
      if (ev.players)
        for (const patch of ev.players) {
          const player = s.players[patch.id]
          if (player) Object.assign(player, patch)
        }
      if (ev.turn) s.turn = ev.turn
      if (ev.markers) s.markers = ev.markers
      if (ev.status) s.status = ev.status
      if (ev.winnerSeat !== undefined) s.winnerSeat = ev.winnerSeat
      if (ev.peek !== undefined) s.peek = ev.peek // null clears the overlay

      if (ev.log) {
        this.log.push({ seq: ev.seq, ts: ev.ts, actor: ev.actor, kind: ev.type, line: ev.log })
        if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP)
      }
      if (ev.extra) this.lastExtra = { seq: ev.seq, type: ev.type, actor: ev.actor, extra: ev.extra }
    },

    applyEphemeral(msg: EphemeralMsg) {
      if (msg.type === 'card.position') {
        const p = msg.payload as { cardId: CardId; x: number; y: number }
        const card = this.state?.cards[p.cardId]
        if (card) {
          card.x = p.x
          card.y = p.y
        }
      } else if (msg.type === 'card.arrow') {
        const p = msg.payload as { fromCardId: CardId; toCardId?: CardId | null; toPlayerId?: PlayerId | null; on: boolean }
        const toCardId = p.toCardId ?? null
        const toPlayerId = p.toPlayerId ?? null
        this.arrows = this.arrows.filter(
          (a) =>
            !(a.actor === msg.actor && a.fromCardId === p.fromCardId && a.toCardId === toCardId && a.toPlayerId === toPlayerId),
        )
        if (p.on) this.arrows.push({ fromCardId: p.fromCardId, toCardId, toPlayerId, actor: msg.actor })
      } else if (msg.type === 'arrows.clear') {
        this.arrows = []
      }
    },

    /** Local echo of my own battlefield drag (view stays server-truth via the ephemeral broadcast). */
    setLocalCardPosition(cardId: CardId, x: number, y: number) {
      const card = this.state?.cards[cardId]
      if (card) {
        card.x = x
        card.y = y
      }
    },

    reset() {
      this.state = null
      this.lastSeq = 0
      this.log = []
      this.conn = 'connecting'
      this.connectedPlayers = []
      this.arrows = []
      this.lastExtra = null
      this._resyncSender = null
      this._lastResyncAt = 0
    },
  },
})

function applyZonePatch(s: ClientGameState, patch: ZonePatch) {
  if (patch.key === 'stack') {
    if (patch.ids) s.zones.stack = patch.ids
    return
  }
  const sep = patch.key.indexOf(':')
  if (sep < 0) return
  const playerId = patch.key.slice(0, sep)
  const kind = patch.key.slice(sep + 1) as ZoneKind
  const zones = s.zones.perPlayer[playerId]
  if (!zones) return
  if (kind === 'library') {
    if (patch.count !== undefined) zones.library = { count: patch.count }
  } else if (kind === 'hand') {
    // own hand always arrives as ids; opponents as counts
    zones.hand = patch.ids ?? { count: patch.count ?? 0 }
  } else if (kind === 'battlefield' || kind === 'graveyard' || kind === 'exile' || kind === 'command') {
    if (patch.ids) zones[kind] = patch.ids
  }
}
