export default defineEventHandler((event) => {
  requireAdmin(event)
  return {
    running: isReimportRunning(),
    logTail: reimportLogTail(50),
  }
})
