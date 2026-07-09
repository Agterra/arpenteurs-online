import { describe, expect, it } from 'vitest'
import { effectiveAdminToken, tokensMatch } from '../../server/utils/adminAuth.ts'

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

describe('effectiveAdminToken', () => {
  it('treats the shipped placeholder as unset (backoffice disabled)', () => {
    // .env.example ships NUXT_ADMIN_TOKEN="change-me-admin"; an operator who
    // forgot to change it must not expose /admin behind a public value.
    expect(effectiveAdminToken('change-me-admin')).toBe('')
    expect(effectiveAdminToken('change-me')).toBe('')
  })

  it('treats unset/blank as disabled', () => {
    expect(effectiveAdminToken('')).toBe('')
    expect(effectiveAdminToken(null)).toBe('')
    expect(effectiveAdminToken(undefined)).toBe('')
  })

  it('passes a real configured token through unchanged', () => {
    expect(effectiveAdminToken('s3cret-operator-token')).toBe('s3cret-operator-token')
  })
})
