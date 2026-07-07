export default defineEventHandler(async (event) => {
  const user = await getSessionUser(event)
  if (!user) return { user: null }
  return { user: { id: user.id, username: user.username } }
})
