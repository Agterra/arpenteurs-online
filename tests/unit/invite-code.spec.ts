import { describe, expect, it } from 'vitest'
import { generateInviteCode } from '../../server/utils/inviteCode.ts'

describe('generateInviteCode', () => {
  it('is 10 chars by default', () => {
    expect(generateInviteCode()).toHaveLength(10)
  })

  it('respects a custom length', () => {
    expect(generateInviteCode(4)).toHaveLength(4)
    expect(generateInviteCode(32)).toHaveLength(32)
  })

  it('only uses the base62 alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateInviteCode()).toMatch(/^[0-9A-Za-z]{10}$/)
    }
  })

  it('generates 1000 unique codes', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 1000; i++) codes.add(generateInviteCode())
    expect(codes.size).toBe(1000)
  })

  it('eventually emits characters from the whole alphabet (rejection sampling sanity)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) for (const ch of generateInviteCode()) seen.add(ch)
    // 5000 draws over 62 symbols — statistically certain to cover everything
    expect(seen.size).toBe(62)
  })
})
