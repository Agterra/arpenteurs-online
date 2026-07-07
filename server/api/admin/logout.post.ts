export default defineEventHandler((event) => {
  clearAdminCookie(event)
  return { ok: true }
})
