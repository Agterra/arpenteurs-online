import { z } from 'zod'
import { sanitizeUsername } from '#shared/utils/username'

const Body = z.object({ username: z.string().min(1).max(100) })

export default defineEventHandler(async (event) => {
  const { username: raw } = await readValidatedBody(event, Body.parse)
  const username = sanitizeUsername(raw)
  if (!username) throw createError({ statusCode: 422, statusMessage: 'Invalid username (1–24 visible characters)' })

  // Idempotent: an existing session just renames (already authenticated → unthrottled)
  const existing = await getSessionUser(event)
  if (existing) {
    const user = await db.user.update({ where: { id: existing.id }, data: { username } })
    return { user: { id: user.id, username: user.username } }
  }

  // New-user creation is unauthenticated and inserts a row per call (usernames
  // are not unique) — throttle it so it can't be scripted to bloat the User
  // table. Per-IP first + topology-independent global backstop (SEC: same class
  // as the cards/decks endpoints; also the root enabler of their per-session caps).
  if (
    !checkRateLimit(`claim:${getClientIp(event)}`, 10, 60_000) ||
    !checkRateLimit('claim:global', 100, 60_000)
  ) {
    throw createError({ statusCode: 429, statusMessage: 'Too many new sessions — try again shortly' })
  }

  const token = mintToken()
  const user = await db.user.create({
    data: { username, tokenHash: hashToken(token) },
  })
  setSessionCookie(event, token)
  return { user: { id: user.id, username: user.username } }
})
