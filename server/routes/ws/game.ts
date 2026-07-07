/**
 * Game WebSocket endpoint: wss://host/ws/game?g=<gameId>
 * Auth: the sid cookie rides the same-origin upgrade request. Because of
 * nuxt#33829 (upgrade context doesn't reach open()), the cookie is re-parsed
 * in open() from peer.request. Origin is strictly validated (CSWSH defense).
 */
import type { Peer } from 'crossws'
import { getRoom, attachPeer, detachPeer, handleMessage, sendSync } from '../../game/room'

function gameIdFrom(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url, 'http://local').searchParams.get('g')
  } catch {
    return null
  }
}

function originAllowed(origin: string | null): boolean {
  const allowed = useRuntimeConfig().publicOrigin
  if (!origin) return false
  if (import.meta.dev && origin.startsWith('http://localhost')) return true
  return origin === allowed
}

async function resolvePeer(peer: Peer) {
  const cookie = peer.request?.headers?.get('cookie')
  const token = tokenFromCookieHeader(cookie)
  const user = await getUserFromToken(token)
  if (!user) return null
  const gameId = gameIdFrom(peer.request?.url)
  if (!gameId) return null
  const membership = await db.gamePlayer.findUnique({
    where: { gameId_userId: { gameId, userId: user.id } },
  })
  if (!membership) return null
  return { user, gameId }
}

// peer.id → resolved identity (avoids a DB roundtrip per message)
const identities = new Map<string, { playerId: string; gameId: string }>()

export default defineWebSocketHandler({
  async upgrade(req) {
    if (!originAllowed(req.headers.get('origin'))) return new Response('Forbidden origin', { status: 403 })
    const token = tokenFromCookieHeader(req.headers.get('cookie'))
    const user = await getUserFromToken(token)
    if (!user) return new Response('Unauthorized', { status: 401 })
    const gameId = new URL(req.url).searchParams.get('g')
    if (!gameId) return new Response('Missing game id', { status: 400 })
    const membership = await db.gamePlayer.findUnique({
      where: { gameId_userId: { gameId, userId: user.id } },
    })
    if (!membership) return new Response('Not a player of this game', { status: 403 })
    // context is NOT propagated to open() (nuxt#33829) — open() re-resolves
  },

  async open(peer) {
    const resolved = await resolvePeer(peer)
    if (!resolved) return peer.close(4001, 'unauthorized')
    identities.set(peer.id, { playerId: resolved.user.id, gameId: resolved.gameId })
    try {
      const room = await getRoom(resolved.gameId)
      attachPeer(room, peer, resolved.user.id)
      await sendSync(room, peer, resolved.user.id)
    } catch (err) {
      console.error(`[ws] open failed for game ${resolved.gameId}`, err)
      peer.close(4002, 'game unavailable')
    }
  },

  async message(peer, message) {
    const id = identities.get(peer.id)
    if (!id) return
    const text = message.text()
    if (text.length > 64_000) return // flood/OOM guard before any JSON parsing
    if (text === 'ping') return peer.send('pong')
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return peer.send(JSON.stringify({ t: 'error', code: 'BAD_JSON', message: 'Not JSON' }))
    }
    try {
      const room = await getRoom(id.gameId)
      await handleMessage(room, peer, id.playerId, json)
    } catch (err) {
      console.error(`[ws] message failed`, err)
    }
  },

  async close(peer) {
    const id = identities.get(peer.id)
    identities.delete(peer.id)
    if (!id) return
    const room = await getRoom(id.gameId).catch(() => null)
    if (room) detachPeer(room, peer)
  },
})
