import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Lobby password hashing — node:crypto scrypt, zero deps.
 * N=2^15, r=8, p=1, keylen=64, salt 16 bytes (scrypt memory = N*r*128 = 32 MiB,
 * maxmem must exceed it). Storage format: scrypt$N$r$p$<saltB64url>$<hashB64url>
 */
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 64
const MAXMEM = 128 * 1024 * 1024

function derive(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEYLEN)
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

/** Constant-time verify against a stored `scrypt$N$r$p$salt$hash` string. Malformed input → false, never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || r < 1 || p < 1) return false
  const salt = Buffer.from(parts[4]!, 'base64url')
  const expected = Buffer.from(parts[5]!, 'base64url')
  if (salt.length < 8 || expected.length < 16) return false
  try {
    const actual = await derive(password, salt, N, r, p, expected.length)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
