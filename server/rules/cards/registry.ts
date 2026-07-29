/**
 * Card-definition registry: normalized name → CardDefinition. A deck is
 * enforceable iff every card name resolves here. Sets register at module load.
 */
import { norm } from '#shared/utils/norm'
import type { CardDefinition } from './dsl'
import { defIsValidCommander } from './dsl'
import { buildFallbackDef, type CatalogCardData } from './fallback'
import { STARTER_SET } from './starter'

const registry = new Map<string, CardDefinition>()

export function registerSet(defs: CardDefinition[]) {
  for (const def of defs) {
    const key = norm(def.name)
    // fail fast on a duplicate definition — a silent last-write-wins overwrite hides
    // divergence (two defs for one card) and illusory "coverage" (re-adding an existing card)
    if (registry.has(key)) throw new Error(`Duplicate card definition for "${def.name}"`)
    registry.set(key, def)
    // transforming DFC (CR 712): also register the back face and cross-link them so `transform()`
    // can swap `defName` between the two (getDef then returns the current face automatically)
    if (def.back) {
      const backKey = norm(def.back.name)
      if (registry.has(backKey)) throw new Error(`Duplicate card definition for "${def.back.name}"`)
      def.transformsTo = def.back.name
      def.back.transformsTo = def.name
      def.back.isBackFace = true
      registry.set(backKey, def.back)
    }
    // MODAL DFC (CR 712.4): same registration + cross-link, but the back face is a LAND that is
    // PLAYED instead of casting the front (r.playLand with `back`), not transformed into
    if (def.modalBack) {
      const backKey = norm(def.modalBack.name)
      if (registry.has(backKey)) throw new Error(`Duplicate card definition for "${def.modalBack.name}"`)
      def.transformsTo = def.modalBack.name
      def.modalBack.transformsTo = def.name
      def.modalBack.isBackFace = true
      registry.set(backKey, def.modalBack)
    }
  }
}
registerSet(STARTER_SET)

export function findDef(name: string): CardDefinition | undefined {
  return registry.get(norm(name))
}

/** Every registered definition (implemented set + any fallbacks registered so far). */
export function allDefs(): CardDefinition[] {
  return [...registry.values()]
}

/** Lookup by pre-normalized key (GameObject.defName). Throws on unknown — that's a bug. */
export function getDef(defName: string): CardDefinition {
  const def = registry.get(defName)
  if (!def) throw new Error(`No card definition for "${defName}"`)
  return def
}

export const defKey = (name: string) => norm(name)

/** Which of these card names have no IMPLEMENTED definition yet (assisted-table fallbacks don't count). */
export function unimplementedNames(names: string[]): string[] {
  return [...new Set(names.filter((n) => !isImplemented(n)))]
}

/** True if a card has a hand-coded (non-fallback) definition. */
export function isImplemented(name: string): boolean {
  const def = registry.get(norm(name))
  return !!def && !def.unimplemented
}

/**
 * Register an assisted-table fallback for a card the engine doesn't implement,
 * derived from its catalog data. Idempotent; NEVER overwrites a real definition
 * (so implementing a card later automatically wins). Fallback bodies are pure
 * functions of catalog data, so global registration is safe across games.
 */
export function registerFallback(catalog: CatalogCardData): CardDefinition {
  const key = norm(catalog.name)
  const existing = registry.get(key)
  if (existing && !existing.unimplemented) return existing
  const def = buildFallbackDef(catalog)
  registry.set(key, def)
  return def
}

/** Display names of every card that may currently be a commander in enforced mode. */
export function implementedCommanderNames(): string[] {
  return [...registry.values()].filter(defIsValidCommander).map((d) => d.name).sort()
}

/**
 * Every hand-coded (non-fallback) card in the implemented pool — the coverage ledger. Excludes
 * token def keys (`tok:`/`itok:`), assisted-table fallbacks (`unimplemented`), and DFC back faces
 * (counted as part of their front). Sorted by display name.
 */
export function implementedCardNames(): string[] {
  return [...registry.entries()]
    .filter(([key, def]) => !key.startsWith('tok:') && !key.startsWith('itok:') && !def.unimplemented && !def.isBackFace)
    .map(([, def]) => def.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Register (idempotently) an ad-hoc token definition for a manual token, keyed
 * by its shape so identical tokens dedupe. Returns the def key to mint against.
 */
export function registerToken(spec: {
  name: string
  power?: number
  toughness?: number
  typeLine?: string
}): string {
  const key = `tok:${norm(spec.name)}:${spec.power ?? ''}/${spec.toughness ?? ''}:${norm(spec.typeLine ?? '')}`
  if (!registry.has(key)) {
    registry.set(key, {
      name: spec.name,
      types: spec.power != null || /creature/i.test(spec.typeLine ?? '') ? ['Creature'] : ['Artifact'],
      power: spec.power,
      toughness: spec.toughness,
      unimplemented: true,
    })
  }
  return key
}

/**
 * Register a token that is a COPY of an existing card definition (Helm of the Host). The copy keeps
 * everything — abilities, triggers, statics — so it behaves like the original; `dropLegendary` strips
 * the supertype ("except the token isn't legendary") and `addKeywords` grants the extras (haste).
 * A copy of a double-faced card copies the FACE, so the back-face links are dropped.
 */
export function registerCopyToken(
  def: CardDefinition,
  opts: { dropLegendary?: boolean; addKeywords?: import('#shared/rules/types').Keyword[] } = {},
): string {
  const kws = [...new Set([...(def.keywords ?? []), ...(opts.addKeywords ?? [])])]
  const key = `itok:copy:${norm(def.name)}:${opts.dropLegendary ? 'nl' : ''}:${kws.join('.')}`
  if (!registry.has(key)) {
    const { back: _back, modalBack: _modalBack, transformsTo: _t, isBackFace: _b, ...rest } = def
    registry.set(key, {
      ...rest,
      supertypes: opts.dropLegendary ? (def.supertypes ?? []).filter((st) => st !== 'Legendary') : def.supertypes,
      keywords: kws,
    })
  }
  return key
}

/** Is `defName` a token def key? Tokens (manual `tok:` or engine `itok:`) exist only on
 *  the battlefield — CR 704.5d removes one as an SBA once it reaches any other zone. */
export function isTokenDefName(defName: string): boolean {
  return defName.startsWith('tok:') || defName.startsWith('itok:')
}

/** Register an ENGINE-created token (a real, mortal permanent — dies to SBA, has keywords),
 *  as opposed to a manual (`unimplemented`) token. Idempotent. */
export function registerImplementedToken(spec: {
  name: string
  power?: number
  toughness?: number
  subtypes?: string[]
  keywords?: import('#shared/rules/types').Keyword[]
  types?: CardDefinition['types']
  /** activated abilities the token has (a Treasure's "{T}, Sacrifice this token: Add one mana…") */
  abilities?: CardDefinition['abilities']
}): string {
  const key = `itok:${norm(spec.name)}:${spec.power ?? ''}/${spec.toughness ?? ''}:${(spec.keywords ?? []).join('.')}`
  if (!registry.has(key)) {
    registry.set(key, {
      name: spec.name,
      types: spec.types ?? ['Creature'],
      subtypes: spec.subtypes,
      power: spec.power,
      toughness: spec.toughness,
      keywords: spec.keywords,
      abilities: spec.abilities,
    })
  }
  return key
}
