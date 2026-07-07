import { flushAllRooms } from '../game/room'

/**
 * Flush every in-memory room to its DB snapshot when Nitro shuts down —
 * makes dev-mode reloads (and clean prod restarts) lossless.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', async () => {
    await flushAllRooms()
  })
})
