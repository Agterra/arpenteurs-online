/**
 * "Assisted table" fallback definitions. For a card the engine doesn't
 * implement, we still know its PRINTED body from the catalog (type line, P/T,
 * mana cost, oracle text). We build a minimal CardDefinition from that so the
 * card can be cast and can fight — but with NO coded abilities/effect, flagged
 * `unimplemented` so the engine never auto-destroys it and its text is left to
 * the players (manual overrides). See docs/RULES-ENGINE.md.
 */
import type { CardType, ManaColor } from '#shared/rules/types'
import type { CardDefinition, Effect } from './dsl'
import { manaProductionFor } from '#shared/utils/manaAbilities'

// Inlined (not imported from ./effects) to avoid a registry→fallback→effects→
// registry import cycle that breaks module initialization.
const addManaEffect =
  (...colors: ManaColor[]): Effect =>
  (ctx) => {
    for (const c of colors) ctx.state.players[ctx.controllerId]!.manaPool[c]++
  }

export interface CatalogCardData {
  name: string
  typeLine: string
  manaCost?: string | null
  power?: string | null
  toughness?: string | null
  loyalty?: string | null
  oracleText?: string | null
  colors?: string[] | null
}

const SUPERTYPES = new Set(['Legendary', 'Basic', 'Snow', 'World', 'Ongoing', 'Host'])
const CARD_TYPES = new Set<CardType>([
  'Land',
  'Creature',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Planeswalker',
  'Battle',
])

/** Parse "Legendary Creature — Angel Horror" → {types, supertypes, subtypes}. */
export function parseTypeLine(typeLine: string): {
  types: CardType[]
  supertypes: string[]
  subtypes: string[]
} {
  const [leftRaw, rightRaw = ''] = typeLine.split(/[—–-]/).map((s) => s.trim())
  const left = (leftRaw ?? '').split(/\s+/).filter(Boolean)
  const supertypes = left.filter((t) => SUPERTYPES.has(t))
  const types = left.filter((t): t is CardType => CARD_TYPES.has(t as CardType))
  const subtypes = rightRaw ? rightRaw.split(/\s+/).filter(Boolean) : []
  return { types, supertypes, subtypes }
}

const intOrUndef = (s?: string | null): number | undefined =>
  // only a plain integer is a known body; "*", "X", "1+*" → undefined (dynamic P/T)
  s != null && /^\d+$/.test(s.trim()) ? Number.parseInt(s, 10) : undefined

/**
 * Build an unimplemented fallback definition from catalog data. If the card is
 * a permanent with a fixed mana ability detectable from its oracle text (basic
 * lands, simple mana rocks/dorks), we attach that as a one-click convenience;
 * "any colour" / choice sources are left for the manual mana override.
 */
export function buildFallbackDef(c: CatalogCardData): CardDefinition {
  const { types, supertypes, subtypes } = parseTypeLine(c.typeLine)
  const def: CardDefinition = {
    name: c.name,
    types: types.length ? types : ['Artifact'], // never empty; harmless placeholder
    supertypes,
    subtypes,
    manaCost: c.manaCost ?? undefined,
    colors: (c.colors ?? undefined) as ManaColor[] | undefined,
    power: intOrUndef(c.power),
    toughness: intOrUndef(c.toughness),
    loyalty: intOrUndef(c.loyalty), // so an unimplemented planeswalker shows its real starting loyalty
    oracleText: c.oracleText ?? undefined,
    unimplemented: true,
  }

  const prod = manaProductionFor({ typeLine: c.typeLine, oracleText: c.oracleText })
  if (prod?.kind === 'fixed' && prod.pips.length) {
    def.abilities = [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: prod.pips, effect: addManaEffect(...prod.pips) },
    ]
  }
  // choice / any-colour mana sources: no auto ability — the player taps and uses
  // the manual mana override (r.mMana) to add the colour they choose.
  return def
}
