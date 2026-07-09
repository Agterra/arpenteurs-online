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
  for (const def of defs) registry.set(norm(def.name), def)
}
registerSet(STARTER_SET)

export function findDef(name: string): CardDefinition | undefined {
  return registry.get(norm(name))
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

/** Register an ENGINE-created token (a real, mortal permanent — dies to SBA, has keywords),
 *  as opposed to a manual (`unimplemented`) token. Idempotent. */
export function registerImplementedToken(spec: {
  name: string
  power?: number
  toughness?: number
  subtypes?: string[]
  keywords?: import('#shared/rules/types').Keyword[]
  types?: CardDefinition['types']
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
    })
  }
  return key
}
