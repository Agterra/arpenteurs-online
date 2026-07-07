/**
 * Parse a mana COST string and plan how to pay it from a mana pool. Used by the
 * cast dialog to show "you still need X" and to deduct on payment.
 *
 * Convenience only — no rules enforcement. Hybrid/Phyrexian/monohybrid pips are
 * approximated as 1 generic each (the player can adjust the pool manually); the
 * true symbols are still shown via ManaSymbols.
 */
import type { ManaColor } from '#shared/types/game'
import { parseMana } from './mana'

export type ManaPool = Record<ManaColor, number>
const COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']
const zero = (): ManaPool => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })

export interface ManaCost {
  generic: number
  colored: ManaPool // per-colour requirement (C = colorless requirement)
  symbols: string[] // pip codes in order, for display
  hasX: boolean
}

export function parseManaCost(cost: string | null | undefined): ManaCost {
  const colored = zero()
  let generic = 0
  let hasX = false
  const symbols: string[] = []
  // For split/adventure "A // B" costs, price the front half.
  const first = (cost ?? '').split(' // ')[0] ?? ''
  for (const tok of parseMana(first)) {
    if (tok.type !== 'symbol') continue
    const code = tok.code
    symbols.push(code)
    if (/^\d+$/.test(code)) generic += parseInt(code, 10)
    else if (code === 'X' || code === 'Y' || code === 'Z') hasX = true
    else if (code in colored) colored[code as ManaColor]++
    else generic += 1 // hybrid / Phyrexian / snow / etc. → approximate
  }
  return { generic, colored, symbols, hasX }
}

export interface Payment {
  deduct: ManaPool // how much to remove from each colour
  shortfall: number // pips the pool can't cover
  covered: boolean
}

/** Greedy payment: colour/colourless requirements first, then generic from the rest. */
export function planPayment(cost: ManaCost, pool: ManaPool): Payment {
  const remaining: ManaPool = { ...pool }
  const deduct = zero()
  let shortfall = 0

  for (const c of COLORS) {
    const pay = Math.min(cost.colored[c], remaining[c])
    deduct[c] += pay
    remaining[c] -= pay
    shortfall += cost.colored[c] - pay
  }

  // generic: spend colourless first, then whatever is most plentiful
  let gen = cost.generic
  const order = [...COLORS].sort((a, b) => (a === 'C' ? -1 : b === 'C' ? 1 : remaining[b] - remaining[a]))
  for (const c of order) {
    if (gen <= 0) break
    const pay = Math.min(gen, remaining[c])
    deduct[c] += pay
    remaining[c] -= pay
    gen -= pay
  }
  shortfall += gen

  return { deduct, shortfall, covered: shortfall === 0 }
}

export const totalPips = (cost: ManaCost): number =>
  cost.generic + COLORS.reduce((n, c) => n + cost.colored[c], 0)
