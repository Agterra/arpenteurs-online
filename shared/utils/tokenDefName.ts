/**
 * A token permanent's rules-registry defName is `itok:<name>:<p>/<t>:<extra>`
 * (engine token) or `tok:<name>:<p>/<t>:<typeLine>` (manual token). Parse it back
 * so the display endpoint can show a proper name + P/T and look up the token's
 * art (TokenImage keyed by the normalized token type name).
 */
export interface ParsedTokenDefName {
  nameNorm: string
  name: string
  power: string | null
  toughness: string | null
}

export function parseTokenDefName(defName: string): ParsedTokenDefName | null {
  if (!defName.startsWith('itok:') && !defName.startsWith('tok:')) return null
  const parts = defName.split(':')
  const nameNorm = (parts[1] ?? '').trim()
  if (!nameNorm) return null
  const pt = (parts[2] ?? '').split('/')
  const power = pt[0] || null
  const toughness = pt[1] || null
  // the defName carries the normalized (lowercase) name; title-case for display
  const name = nameNorm.replace(/\b\w/g, (c) => c.toUpperCase())
  return { nameNorm, name, power, toughness }
}
