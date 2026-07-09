/**
 * Trusted client IP for security rate-limiting.
 *
 * h3's `getRequestIP(event, { xForwardedFor: true })` returns the LEFTMOST
 * X-Forwarded-For value, which is fully client-controlled: Traefik appends the
 * real client IP to the header but does not strip a spoofed one, so the leftmost
 * token is attacker-supplied. Keying a limiter on it lets an attacker rotate the
 * header to land every request in a fresh bucket (SEC finding #1).
 *
 * This app runs behind exactly ONE trusted reverse proxy (Traefik → app, single
 * node — see the helm chart). With one trusted hop the real client IP is the
 * RIGHTMOST X-Forwarded-For value — the one Traefik itself appended — so we take
 * that and ignore everything the client may have prepended. With no proxy in
 * front (local/direct) there is no X-Forwarded-For and we use the socket address.
 *
 * NOTE: this assumes a single trusted proxy. If more proxy hops are ever added
 * in front of the app, this must count trusted hops from the right instead.
 */
import type { H3Event } from 'h3'

export function trustedClientIp(
  xForwardedFor: string | null | undefined,
  socketAddr: string | null | undefined,
): string {
  if (xForwardedFor) {
    const parts = xForwardedFor
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length) return parts[parts.length - 1]!
  }
  return socketAddr || 'unknown'
}

/** Resolve the trusted client IP from an h3 event (see trustedClientIp). */
export function getClientIp(event: H3Event): string {
  return trustedClientIp(
    getRequestHeader(event, 'x-forwarded-for'),
    event.node?.req?.socket?.remoteAddress,
  )
}
