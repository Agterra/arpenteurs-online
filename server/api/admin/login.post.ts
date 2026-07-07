import { z } from 'zod'

const Body = z.object({ token: z.string().min(1).max(200) })

export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  if (!checkRateLimit(`admin-login:${ip}`, 5, 60_000)) {
    throw createError({ statusCode: 429, statusMessage: 'Too many attempts — try again in a minute' })
  }

  const { token } = await readValidatedBody(event, Body.parse)
  const configured = useRuntimeConfig(event).adminToken
  if (!configured) throw createError({ statusCode: 403, statusMessage: 'Backoffice disabled' })
  if (!tokensMatch(token, configured)) {
    throw createError({ statusCode: 403, statusMessage: 'Invalid admin token' })
  }

  setAdminCookie(event, token)
  return { ok: true }
})
