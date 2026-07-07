/**
 * Game WebSocket transport. Opened in onMounted only (SSR-safe), auto-reconnect
 * with exponential backoff (0.5 s → 8 s, forever), heartbeat 'ping' every 15 s
 * (close + reconnect when no 'pong' within 10 s). Routes ServerMsg by `t` into
 * the game store; exposes `send` which drops + toasts when the socket is down.
 */
import type { ClientMsgT, ServerMsg } from '#shared/schemas/messages'
import { useGameStore } from '~/stores/game'

const HEARTBEAT_MS = 15_000
const PONG_TIMEOUT_MS = 10_000
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 8_000

export function useGameSocket(gameId: string) {
  const store = useGameStore()
  const toast = useToast()

  let ws: WebSocket | null = null
  let disposed = false
  let backoff = BACKOFF_MIN_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null

  function wsUrl(): string {
    return `${location.origin.replace(/^http/, 'ws')}/ws/game?g=${gameId}`
  }

  function rawSend(action: ClientMsgT): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(action))
    return true
  }

  /** Send a game action; when the socket is down the action is dropped with a toast. */
  function send(action: ClientMsgT): boolean {
    if (rawSend(action)) return true
    toast.add({
      title: 'Not connected',
      description: 'Action dropped — reconnecting to the game…',
      color: 'warning',
      icon: 'i-lucide-unplug',
    })
    return false
  }

  function route(msg: ServerMsg) {
    switch (msg.t) {
      case 'sync':
        store.applySync(msg)
        break
      case 'event':
        store.applyEvent(msg)
        break
      case 'ephemeral':
        store.applyEphemeral(msg)
        break
      case 'presence':
        store.setPresence(msg.connected)
        break
      case 'error':
        toast.add({ title: 'Rejected', description: msg.message, color: 'error', icon: 'i-lucide-shield-x' })
        break
    }
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send('ping')
      pongTimer ??= setTimeout(() => {
        // no pong in time → assume a dead link, force the reconnect path
        pongTimer = null
        ws?.close()
      }, PONG_TIMEOUT_MS)
    }, HEARTBEAT_MS)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    if (pongTimer) clearTimeout(pongTimer)
    pongTimer = null
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff)
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
  }

  function connect() {
    if (disposed) return
    store.setConn(store.state ? 'resyncing' : 'connecting')
    try {
      ws = new WebSocket(wsUrl())
    } catch {
      store.setConn('down')
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      backoff = BACKOFF_MIN_MS
      startHeartbeat() // server pushes a fresh sync on open; the sync flips conn to 'open'
    }
    ws.onmessage = (e: MessageEvent) => {
      if (e.data === 'pong') {
        if (pongTimer) clearTimeout(pongTimer)
        pongTimer = null
        return
      }
      let msg: ServerMsg
      try {
        msg = JSON.parse(e.data as string) as ServerMsg
      } catch {
        return
      }
      route(msg)
    }
    ws.onclose = () => {
      stopHeartbeat()
      if (disposed) return
      store.setConn('down')
      scheduleReconnect()
    }
    ws.onerror = () => ws?.close()
  }

  onMounted(() => {
    store.bindResyncSender(() => rawSend({ type: 'resync' }))
    connect()
  })

  onBeforeUnmount(() => {
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    stopHeartbeat()
    store.bindResyncSender(null)
    ws?.close()
    ws = null
  })

  return { send }
}
