import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import type { User } from '../generated/prisma/client'

const COOKIE = 'sid'
const YEAR_S = 60 * 60 * 24 * 365
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

export function setSessionCookie(event: H3Event, token: string) {
  setCookie(event, COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !import.meta.dev,
    maxAge: YEAR_S,
    path: '/',
  })
}

export async function getUserFromToken(token: string | undefined | null): Promise<User | null> {
  if (!token) return null
  const user = await db.user.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!user) return null
  if (Date.now() - user.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await db.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
  }
  return user
}

export async function getSessionUser(event: H3Event): Promise<User | null> {
  if (event.context.sessionUser !== undefined) return event.context.sessionUser as User | null
  const user = await getUserFromToken(getCookie(event, COOKIE))
  event.context.sessionUser = user
  return user
}

export async function requireUser(event: H3Event): Promise<User> {
  const user = await getSessionUser(event)
  if (!user) throw createError({ statusCode: 401, statusMessage: 'No session — claim a username first' })
  return user
}

/** For the ws upgrade path: parse the raw Cookie header (no h3 event there). */
export function tokenFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === COOKIE) return decodeURIComponent(rest.join('='))
  }
  return null
}
