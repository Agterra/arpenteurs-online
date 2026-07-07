export default defineEventHandler((event) => {
  requireAdmin(event)
  if (!startReimport()) {
    throw createError({ statusCode: 409, statusMessage: 'An import is already running' })
  }
  return { started: true }
})
