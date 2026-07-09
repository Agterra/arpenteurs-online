import { describe, expect, it } from 'vitest'
import { trustedClientIp } from '../../server/utils/clientIp.ts'

/**
 * Security regression for the admin-login brute-force bypass (SEC finding #1):
 * h3's getRequestIP takes the LEFTMOST X-Forwarded-For value, which is fully
 * client-controlled. In our single-trusted-proxy deployment (Traefik → app)
 * the real client IP is the RIGHTMOST XFF value — the hop Traefik appended.
 * A limiter keyed on that must not be resettable by rotating a spoofed header.
 */
describe('trustedClientIp', () => {
  it('ignores a client-spoofed leftmost X-Forwarded-For value', () => {
    // attacker prepends a fake IP; Traefik appends the true client 9.9.9.9
    expect(trustedClientIp('1.2.3.4, 9.9.9.9', 'traefik-pod-ip')).toBe('9.9.9.9')
  })

  it('takes the rightmost (trusted-proxy-appended) value through several spoofed hops', () => {
    expect(trustedClientIp('1.1.1.1, 2.2.2.2, 3.3.3.3, 9.9.9.9', 'p')).toBe('9.9.9.9')
  })

  it('yields the SAME key regardless of the rotating spoofed prefix (no bucket reset)', () => {
    const a = trustedClientIp('1.1.1.1, 9.9.9.9', 'p')
    const b = trustedClientIp('2.2.2.2, 9.9.9.9', 'p')
    const c = trustedClientIp('deadbeef, 9.9.9.9', 'p')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('falls back to the socket address when there is no X-Forwarded-For', () => {
    expect(trustedClientIp(null, '10.0.0.5')).toBe('10.0.0.5')
    expect(trustedClientIp(undefined, '10.0.0.5')).toBe('10.0.0.5')
    expect(trustedClientIp('', '10.0.0.5')).toBe('10.0.0.5')
  })

  it('tolerates whitespace and empty entries', () => {
    expect(trustedClientIp('  1.2.3.4 ,  9.9.9.9  ', 'p')).toBe('9.9.9.9')
    expect(trustedClientIp('9.9.9.9, ,', 'p')).toBe('9.9.9.9')
  })

  it('returns "unknown" when nothing is available', () => {
    expect(trustedClientIp(null, null)).toBe('unknown')
    expect(trustedClientIp(undefined, undefined)).toBe('unknown')
    expect(trustedClientIp('', '')).toBe('unknown')
  })
})
