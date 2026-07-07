/**
 * Tiny in-memory fixed-window attempt limiter (single-node by design premise).
 * Returns true when the attempt is allowed, false when the caller should 429.
 * Expired buckets are swept periodically (piggybacked on calls — no timers,
 * so dev HMR reloads never leak intervals).
 */
interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const CLEANUP_EVERY_MS = 60_000
let nextCleanupAt = 0

function cleanup(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
  nextCleanupAt = now + CLEANUP_EVERY_MS
}

export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  if (now >= nextCleanupAt) cleanup(now)

  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (bucket.count >= max) return false
  bucket.count++
  return true
}
