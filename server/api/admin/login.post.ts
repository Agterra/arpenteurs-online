import { z } from 'zod'

const Body = z.object({ token: z.string().min(1).max(200) })

export default defineEventHandler(async (event) => {
  // Per-IP limiter keyed on the TRUSTED client IP (getClientIp), not h3's
  // spoofable leftmost X-Forwarded-For. Plus a topology-independent global
  // backstop so header rotation can never buy more than 30 guesses/min total —
  // infeasible against a random token (SEC finding #1).
  const tooBusy = () =>
    createError({ statusCode: 429, statusMessage: 'Too many attempts — try again in a minute' })
  const ip = getClientIp(event)
  if (!checkRateLimit(`admin-login:${ip}`, 5, 60_000)) throw tooBusy()
  if (!checkRateLimit('admin-login:global', 30, 60_000)) throw tooBusy()

  const { token } = await readValidatedBody(event, Body.parse)
  const configured = effectiveAdminToken(useRuntimeConfig(event).adminToken)
  if (!configured) throw createError({ statusCode: 403, statusMessage: 'Backoffice disabled' })
  if (!tokensMatch(token, configured)) {
    throw createError({ statusCode: 403, statusMessage: 'Invalid admin token' })
  }

  setAdminCookie(event, token)
  return { ok: true }
})
