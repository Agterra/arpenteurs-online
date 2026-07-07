/**
 * Best-effort detection of what mana a permanent can tap for, so the client can
 * offer a one-click "tap for mana" (the single most repeated table action).
 *
 * This is a CONVENIENCE, not rules enforcement: it covers the common cases
 * (basic lands, dual/fetch-typed lands, "{T}: Add …", "any color") and returns
 * null when unsure, in which case the UI falls back to a plain tap and the
 * player uses the manual mana-pool buttons. Pure + unit-tested.
 */
import type { ManaColor } from '#shared/types/game'

const BASIC_SUBTYPES: Record<string, ManaColor> = {
  plains: 'W',
  island: 'U',
  swamp: 'B',
  mountain: 'R',
  forest: 'G',
  wastes: 'C',
}

export type ManaProduction =
  | { kind: 'fixed'; pips: ManaColor[] } // add exactly these
  | { kind: 'choice'; options: ManaColor[] } // player picks one pip

export interface ManaCardLike {
  typeLine?: string | null
  oracleText?: string | null
}

export function manaProductionFor(card: ManaCardLike): ManaProduction | null {
  const type = (card.typeLine ?? '').toLowerCase()

  // Land basic subtypes — covers basics AND typed nonbasics (shock/dual/fetch
  // land types). One subtype → fixed; several → choose among them.
  if (type.includes('land')) {
    const subs = Object.keys(BASIC_SUBTYPES).filter((b) => new RegExp(`\\b${b}\\b`).test(type))
    if (subs.length === 1) return { kind: 'fixed', pips: [BASIC_SUBTYPES[subs[0]!]!] }
    if (subs.length > 1) return { kind: 'choice', options: subs.map((s) => BASIC_SUBTYPES[s]!) }
  }

  const oracle = (card.oracleText ?? '').toLowerCase()
  if (!oracle.includes('add')) return null

  // "add one mana of any color", "mana of any color" → pick a colour (WUBRG).
  if (/mana of any (one )?colou?r/.test(oracle)) return { kind: 'choice', options: ['W', 'U', 'B', 'R', 'G'] }

  // First "Add …" clause with explicit symbols.
  const m = oracle.match(/add ([^.\n]*)/)
  if (!m) return null
  const clause = m[1]!
  const syms = [...clause.matchAll(/\{([wubrgc])\}/g)].map((x) => x[1]!.toUpperCase() as ManaColor)
  if (!syms.length) return null
  if (/\bor\b/.test(clause) && new Set(syms).size > 1) return { kind: 'choice', options: [...new Set(syms)] }
  return { kind: 'fixed', pips: syms }
}
