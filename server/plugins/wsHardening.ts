/**
 * Cap inbound WebSocket frame size at the transport layer (64 KB).
 *
 * The `ws` server bundled by crossws defaults to a 100 MiB maxPayload, so an
 * authenticated, seated player could otherwise force a large per-frame buffer
 * before our application-level guard runs (SEC finding #3). Nitro exposes no
 * public config for the ws adapter, so we set crossws' `serverOptions` on the
 * h3 app; the node preset passes them straight to `new WebSocketServer(...)`,
 * and its Receiver aborts (close 1009) once a frame exceeds the limit — before
 * the whole message is buffered.
 *
 * Accessing `h3App.websocket` here (after mutating options) resolves and caches
 * the options, guaranteeing the value the node preset reads at startup includes
 * our maxPayload regardless of plugin/preset ordering. Verified: the mutation
 * flows through h3's websocketOptions() and `ws` honours maxPayload.
 *
 * Defense in depth — server/routes/ws/game.ts also drops >64 KB frames by byte
 * length before decoding, which is the fully-supported primary control.
 */
const MAX_WS_PAYLOAD = 64 * 1024

interface WsCapableApp {
  options: { websocket?: { serverOptions?: Record<string, unknown> } & Record<string, unknown> }
  websocket?: { serverOptions?: { maxPayload?: number } }
}

export default defineNitroPlugin((nitroApp) => {
  const h3App = (nitroApp as unknown as { h3App?: WsCapableApp }).h3App
  if (!h3App?.options) return

  h3App.options.websocket = {
    ...(h3App.options.websocket ?? {}),
    serverOptions: {
      ...(h3App.options.websocket?.serverOptions ?? {}),
      maxPayload: MAX_WS_PAYLOAD,
    },
  }

  const applied = h3App.websocket?.serverOptions?.maxPayload
  if (applied !== MAX_WS_PAYLOAD) {
    console.warn('[ws] transport maxPayload not applied; relying on the message-size guard')
  }
})
