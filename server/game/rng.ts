import { randomInt, randomUUID } from 'node:crypto'

/** Crypto Fisher–Yates, in place. */
export function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

export function rollDie(sides: number): number {
  return randomInt(1, sides + 1)
}

export function flipCoin(): 'heads' | 'tails' {
  return randomInt(2) === 0 ? 'heads' : 'tails'
}

/** Card instance ids — re-minted whenever a card enters a hidden zone. */
export function mintCardId(): string {
  return `i_${randomUUID()}`
}
