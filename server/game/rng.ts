import { randomInt, randomUUID } from 'node:crypto'

/**
 * Test seam for DETERMINISM. Production leaves this null → all randomness below
 * draws from node:crypto (secure, non-reproducible). A test may install a seeded
 * generator via `__setDeterministicRng(mulberry32(seed))` so that a whole game —
 * library shuffles, the first-player pick, and every minted object id — replays
 * identically from the seed. The CI-blocking leak fuzzer relies on this so a
 * failure is reproducible/bisectable from its seed (do NOT ship code that leaves
 * it set — always reset to null in a finally/afterEach).
 */
let testRng: (() => number) | null = null
let idCounter = 0
export function __setDeterministicRng(fn: (() => number) | null): void {
  testRng = fn
  idCounter = 0
}

/** Uniform integer in [0, maxExclusive) from the seeded generator, else crypto. */
export function randomIndex(maxExclusive: number): number {
  if (testRng) return Math.min(maxExclusive - 1, Math.floor(testRng() * maxExclusive))
  return randomInt(maxExclusive)
}

/** Crypto (or seeded) Fisher–Yates, in place. */
export function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1)
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

export function rollDie(sides: number): number {
  return testRng ? randomIndex(sides) + 1 : randomInt(1, sides + 1)
}

export function flipCoin(): 'heads' | 'tails' {
  return randomIndex(2) === 0 ? 'heads' : 'tails'
}

/** Card instance ids — re-minted whenever a card enters a hidden zone. */
export function mintCardId(): string {
  // Deterministic-but-unique when seeded. FIXED WIDTH is required: the leak
  // fuzzer's assertion is a substring test (json.includes(id)), which is safe for
  // UUIDs but would false-positive on a variable-length counter (`i_t8` ⊂ `i_t80`).
  // Equal-length ids can never be substrings of one another.
  return testRng ? `i_t${String(idCounter++).padStart(9, '0')}` : `i_${randomUUID()}`
}
