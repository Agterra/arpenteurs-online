import { z } from 'zod'
import { sanitizeUsername } from '#shared/utils/username'

const Body = z.object({ username: z.string().min(1).max(100) })

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const { username: raw } = await readValidatedBody(event, Body.parse)
  const username = sanitizeUsername(raw)
  if (!username) throw createError({ statusCode: 422, statusMessage: 'Invalid username (1–24 visible characters)' })
  const user = await db.user.update({ where: { id: me.id }, data: { username } })
  return { user: { id: user.id, username: user.username } }
})
