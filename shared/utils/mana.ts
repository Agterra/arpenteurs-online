/**
 * Mana-symbol rendering helpers, shared client/server.
 *
 * MTGJSON stores costs and oracle text with curly-brace symbols: `{2}{R}{R}`,
 * `{T}: Add {G}{G}.`, hybrids `{W/U}` / `{2/W}`, Phyrexian `{W/P}`, etc.
 * Scryfall serves an SVG per symbol at a deterministic, rate-limit-exempt URL:
 *   https://svgs.scryfall.io/card-symbols/<CODE>.svg
 * where CODE = the inner text with `/` removed and letters uppercased
 * (e.g. {W/U} → WU, {2/W} → 2W, {W/P} → WP), with a couple of named specials.
 */

export type ManaToken =
  | { type: 'symbol'; raw: string; code: string }
  | { type: 'text'; text: string }

const SYMBOL_RE = /\{([^}]+)\}/g

/** Map a `{...}` inner string to its Scryfall card-symbol filename code. */
export function symbolCode(inner: string): string {
  const t = inner.trim()
  if (t === '∞') return 'INFINITY'
  if (t === '½') return 'HALF'
  return t.replace(/\//g, '').toUpperCase()
}

export function symbolSvgUrl(code: string): string {
  return `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(code)}.svg`
}

/**
 * Tokenize a mana cost or a chunk of oracle text into an ordered list of
 * symbol and text tokens. Text between/around symbols (including newlines) is
 * preserved verbatim so callers can keep `white-space: pre-line`.
 */
export function parseMana(input: string | null | undefined): ManaToken[] {
  if (!input) return []
  const out: ManaToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  SYMBOL_RE.lastIndex = 0
  while ((m = SYMBOL_RE.exec(input))) {
    if (m.index > last) out.push({ type: 'text', text: input.slice(last, m.index) })
    out.push({ type: 'symbol', raw: m[0], code: symbolCode(m[1]!) })
    last = SYMBOL_RE.lastIndex
  }
  if (last < input.length) out.push({ type: 'text', text: input.slice(last) })
  return out
}

/** True if the string contains at least one `{...}` symbol. */
export function hasManaSymbols(input: string | null | undefined): boolean {
  return !!input && /\{[^}]+\}/.test(input)
}
