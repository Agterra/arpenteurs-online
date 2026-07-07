/**
 * Token auto-suggestion (PLAN §4): pure parse of an oracle text into TokenSpec
 * prefills for the token dialog. Two stages:
 *   1. named-artifact table (Treasure, Food, Clue…) — canned, always correct;
 *   2. regex grammar over each sentence containing "create" — quantity word,
 *      optional "tapped", P/T, color words, capitalized subtype words, and a
 *      "with <abilities>" tail.
 * Anything unparseable is skipped gracefully — the dialog never blocks on us.
 */
import type { ManaColor, TokenSpec } from '../types/game'

const NAMED_ARTIFACTS: Record<string, TokenSpec> = {
  Treasure: named('Treasure', "{T}, Sacrifice this artifact: Add one mana of any color."),
  Food: named('Food', '{2}, {T}, Sacrifice this artifact: You gain 3 life.'),
  Clue: named('Clue', '{2}, Sacrifice this artifact: Draw a card.'),
  Blood: named('Blood', '{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.'),
  Gold: named('Gold', 'Sacrifice this artifact: Add one mana of any color.'),
  Map: named('Map', '{1}, {T}, Sacrifice this artifact: Target creature you control explores. Activate only as a sorcery.'),
  Powerstone: named('Powerstone', "{T}: Add {C}. This mana can't be spent to cast a nonartifact spell."),
  Incubator: named('Incubator', '{2}: Transform this artifact.'),
  Junk: named('Junk', '{T}, Sacrifice this artifact: Exile the top card of your library. You may play that card this turn. Activate only as a sorcery.'),
}

function named(name: string, text: string): TokenSpec {
  return { name, pt: null, colors: [], typeLine: `Token Artifact — ${name}`, text, fromCatalogId: null }
}

const QUANTITY = /^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|that many|\d+)$/i
const COLOR_WORDS: Record<string, ManaColor> = {
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
}
const COLOR_ORDER: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']
const TYPE_WORDS = new Set(['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'battle'])
const PT = /^(\d+|x|\*)\/(\d+|x|\*)$/i
/** Words we silently tolerate inside a token descriptor ("a number of 1/1 …"). */
const FILLER = new Set(['tapped', 'legendary', 'colorless', 'and', 'or', 'of', 'number', 'additional', 'more'])

/** One "<quantity> … token(s)" clause; quantity words are consumed for matching only. */
const DESCRIPTOR =
  /(?:^|\s)(a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|that many|\d+)\s+([^.;:]*?)\btokens?\b/i

const TAIL_CUTTERS = [
  /\s+for each\b[\s\S]*$/i,
  /\s+where\b[\s\S]*$/i,
  /\s+equal to\b[\s\S]*$/i,
  /\s+unless\b[\s\S]*$/i,
  /\s+named\b[\s\S]*$/i,
  /,?\s+then\b[\s\S]*$/i,
]

const strip = (w: string) => w.replace(/^["'’(]+|[,."'’)]+$/g, '')

function parseDescriptor(descriptor: string, withTail: string | null): TokenSpec[] {
  const words = descriptor.split(/\s+/).filter(Boolean)
  if (!words.length) return []

  // Stage 1: named-artifact table wins outright.
  const namedHits = words.map(strip).filter((w) => Object.hasOwn(NAMED_ARTIFACTS, w))
  if (namedHits.length) return [...new Set(namedHits)].map((w) => NAMED_ARTIFACTS[w]!)

  // Stage 2: generic grammar.
  let pt: string | null = null
  const colors = new Set<ManaColor>()
  const subtypes: string[] = []
  const typeWords: string[] = []
  for (const raw of words) {
    const w = strip(raw)
    if (!w) continue
    const lw = w.toLowerCase()
    if (PT.test(lw)) {
      if (!pt) pt = w.toUpperCase() // 'x/x' → 'X/X'; '1/1' and '*/*' unchanged
    } else if (COLOR_WORDS[lw]) {
      colors.add(COLOR_WORDS[lw]!)
    } else if (TYPE_WORDS.has(lw)) {
      typeWords.push(lw[0]!.toUpperCase() + lw.slice(1))
    } else if (QUANTITY.test(lw) || FILLER.has(lw)) {
      continue
    } else if (/^[A-Z]/.test(w)) {
      subtypes.push(w)
    }
    // unknown lowercase words ("copy", "those", …) are tolerated but grant nothing
  }
  if (!subtypes.length || !typeWords.length) return [] // unparseable → graceful no-op

  let text = ''
  if (withTail) {
    let tail = withTail
    for (const cut of TAIL_CUTTERS) tail = tail.replace(cut, '')
    tail = tail.replace(/[.,;\s]+$/, '').trim()
    if (tail) text = tail[0]!.toUpperCase() + tail.slice(1)
  }

  return [
    {
      name: subtypes.join(' '),
      pt,
      colors: [...colors].sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b)),
      typeLine: `Token ${typeWords.join(' ')} — ${subtypes.join(' ')}`,
      text,
      fromCatalogId: null,
    },
  ]
}

export function parseTokenSuggestions(oracleText: string): TokenSpec[] {
  if (!oracleText || typeof oracleText !== 'string') return []
  const specs: TokenSpec[] = []
  const seen = new Set<string>()

  const sentences = oracleText.split(/(?<=\.)\s+|\n/)
  for (const sentence of sentences) {
    const createMatch = sentence.match(/\bcreates?\b/i)
    if (!createMatch) continue
    const after = sentence.slice(createMatch.index! + createMatch[0].length)
    // "…token with deathtouch and a 3/3 … token with lifelink" → separate clauses
    const parts = after.split(/\s+and\s+(?=an?\s+(?:\d+|x|\*)\/)/i)
    for (const part of parts) {
      const m = part.match(DESCRIPTOR)
      if (!m) continue
      const rest = part.slice(m.index! + m[0].length)
      const withMatch = rest.match(/^\s+with\s+([\s\S]+)$/i)
      for (const spec of parseDescriptor(m[2]!, withMatch ? withMatch[1]! : null)) {
        const key = JSON.stringify(spec)
        if (seen.has(key)) continue
        seen.add(key)
        specs.push(spec)
      }
    }
  }
  return specs
}
