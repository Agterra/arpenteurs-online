import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' // base62
// Largest multiple of 62 that fits in a byte: bytes >= 248 are rejected so
// `byte % 62` is uniform (rejection sampling, no modulo bias).
const REJECT_ABOVE = 62 * 4 // 248

/** Crypto-random base62 invite code (default 10 chars ≈ 59.5 bits of entropy). */
export function generateInviteCode(length = 10): string {
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < REJECT_ABOVE && out.length < length) out += ALPHABET[byte % 62]!
    }
  }
  return out
}
