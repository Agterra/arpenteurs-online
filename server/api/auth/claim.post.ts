import { z } from 'zod'
import { sanitizeUsername } from '#shared/utils/username'

const Body = z.object({ username: z.string().min(1).max(100) })

export default defineEventHandler(async (event) => {
  const { username: raw } = await readValidatedBody(event, Body.parse)
  const username = sanitizeUsername(raw)
  if (!username) throw createError({ statusCode: 422, statusMessage: 'Invalid username (1–24 visible characters)' })

  // Idempotent: an existing session just renames
  const existing = await getSessionUser(event)
  if (existing) {
    const user = await db.user.update({ where: { id: existing.id }, data: { username } })
    return { user: { id: user.id, username: user.username } }
  }

  const token = mintToken()
  const user = await db.user.create({
    data: { username, tokenHash: hashToken(token) },
  })
  setSessionCookie(event, token)
  return { user: { id: user.id, username: user.username } }
})
