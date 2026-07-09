import { createHash, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

const COOKIE = 'adm'
const MONTH_S = 60 * 60 * 24 * 30

/** Placeholders shipped in .env.example — refuse to run the backoffice with them. */
const INSECURE_DEFAULT_TOKENS = new Set(['change-me-admin', 'change-me'])

/**
 * The effective admin token, or '' (backoffice disabled) when unset or left at a
 * shipped placeholder. Stops an operator who forgot to set a real token from
 * exposing /admin behind a publicly-known value (SEC finding #1 follow-up).
 */
export function effectiveAdminToken(configured: string | null | undefined): string {
  if (!configured) return ''
  return INSECURE_DEFAULT_TOKENS.has(configured) ? '' : configured
}

/**
 * Constant-time admin token comparison. Hashing both sides first makes the
 * buffers equal-length (timingSafeEqual throws otherwise) and avoids leaking
 * length information. An empty/unset configured token never matches anything —
 * the backoffice is disabled until NUXT_ADMIN_TOKEN is set.
 */
export function tokensMatch(submitted: string, configured: string): boolean {
  if (!configured) return false
  const a = createHash('sha256').update(submitted).digest()
  const b = createHash('sha256').update(configured).digest()
  return timingSafeEqual(a, b)
}

export function setAdminCookie(event: H3Event, token: string) {
  setCookie(event, COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !import.meta.dev,
    maxAge: MONTH_S,
    path: '/',
  })
}

export function clearAdminCookie(event: H3Event) {
  deleteCookie(event, COOKIE, { path: '/' })
}

/** Gate for every /api/admin route: re-validates the cookie token on each call. */
export function requireAdmin(event: H3Event): void {
  const configured = effectiveAdminToken(useRuntimeConfig(event).adminToken)
  if (!configured) throw createError({ statusCode: 403, statusMessage: 'Backoffice disabled' })
  const cookie = getCookie(event, COOKIE)
  if (!cookie || !tokensMatch(cookie, configured)) {
    throw createError({ statusCode: 401, statusMessage: 'Admin authentication required' })
  }
}
