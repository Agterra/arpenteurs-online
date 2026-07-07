import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../../server/utils/scrypt.ts'

describe('scrypt password hashing', () => {
  it('hash → verify roundtrip succeeds', async () => {
    const stored = await hashPassword('hunter2')
    await expect(verifyPassword('hunter2', stored)).resolves.toBe(true)
  })

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('hunter2')
    await expect(verifyPassword('hunter3', stored)).resolves.toBe(false)
    await expect(verifyPassword('', stored)).resolves.toBe(false)
  })

  it('produces the documented storage format', async () => {
    const stored = await hashPassword('correct horse battery staple')
    const parts = stored.split('$')
    expect(parts).toHaveLength(6)
    expect(parts[0]).toBe('scrypt')
    expect(parts[1]).toBe('32768') // N
    expect(parts[2]).toBe('8') // r
    expect(parts[3]).toBe('1') // p
    // base64url, no padding
    expect(parts[4]).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(parts[5]).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(parts[4]!, 'base64url')).toHaveLength(16) // salt
    expect(Buffer.from(parts[5]!, 'base64url')).toHaveLength(64) // keylen
  })

  it('salts randomly — same password hashes differently, both verify', async () => {
    const a = await hashPassword('same password')
    const b = await hashPassword('same password')
    expect(a).not.toBe(b)
    await expect(verifyPassword('same password', a)).resolves.toBe(true)
    await expect(verifyPassword('same password', b)).resolves.toBe(true)
  })

  it('takes the timing-safe compare path: tampered hash of correct length → false', async () => {
    const stored = await hashPassword('hunter2')
    const parts = stored.split('$')
    const hash = Buffer.from(parts[5]!, 'base64url')
    hash[0]! ^= 0xff // flip bits, keep length — timingSafeEqual must return false, not throw
    const tampered = [...parts.slice(0, 5), hash.toString('base64url')].join('$')
    await expect(verifyPassword('hunter2', tampered)).resolves.toBe(false)
  })

  it('returns false (never throws) on malformed stored strings', async () => {
    await expect(verifyPassword('x', '')).resolves.toBe(false)
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false)
    await expect(verifyPassword('x', 'bcrypt$10$abc$def$ghi$jkl')).resolves.toBe(false)
    await expect(verifyPassword('x', 'scrypt$32768$8$1$short$short')).resolves.toBe(false)
    await expect(verifyPassword('x', 'scrypt$NaN$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA')).resolves.toBe(false)
  })
})
