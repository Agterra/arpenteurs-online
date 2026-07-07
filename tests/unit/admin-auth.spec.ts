import { describe, expect, it } from 'vitest'
import { tokensMatch } from '../../server/utils/adminAuth.ts'

describe('tokensMatch', () => {
  it('matches identical tokens', () => {
    expect(tokensMatch('change-me-admin', 'change-me-admin')).toBe(true)
  })

  it('rejects a wrong token', () => {
    expect(tokensMatch('wrong-token', 'change-me-admin')).toBe(false)
  })

  it('always rejects when no token is configured (backoffice disabled)', () => {
    expect(tokensMatch('', '')).toBe(false)
    expect(tokensMatch('anything', '')).toBe(false)
  })

  it('does not throw on different-length tokens', () => {
    expect(() => tokensMatch('a', 'a-much-longer-configured-token')).not.toThrow()
    expect(tokensMatch('a', 'a-much-longer-configured-token')).toBe(false)
    expect(tokensMatch('a'.repeat(500), 'short')).toBe(false)
  })

  it('rejects empty submitted token against a configured one', () => {
    expect(tokensMatch('', 'change-me-admin')).toBe(false)
  })
})
