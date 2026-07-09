/**
 * Continuous characteristics (CR 613 — the "layer system"). Computes a
 * permanent's CURRENT power/toughness from its printed base plus the continuous
 * effects that apply to it, so combat and state-based actions read effective
 * values rather than the printed card.
 *
 * Implemented so far (layer 7): base P/T, static anthems/lords from other
 * permanents (7c), until-end-of-turn pumps (7c), and +1/+1 / -1/-1 counters
 * (7d). All are additive here, so their relative sublayer order is numerically
 * irrelevant. Layer 6 (keyword granting) and 7b ("set" P/T) will slot in later.
 */
import type { GameObject, Keyword, RulesGameState } from '#shared/rules/types'
import type { AffectsFilter } from './cards/dsl'
import { getDef } from './cards/registry'

/** Net +1/+1 minus -1/-1 counters on a permanent (other counters don't change P/T). */
function counterPT(obj: GameObject): number {
  return (obj.counters['+1/+1'] ?? 0) - (obj.counters['-1/-1'] ?? 0)
}

/** Base P/T after CR 613 layer 7b (a "set" effect overrides the printed value; last wins). */
function baseP(state: RulesGameState, obj: GameObject): number {
  let v = getDef(obj.defName).power ?? 0
  for (const s of state.setPT) if (s.objId === obj.id) v = s.power
  return v
}
function baseT(state: RulesGameState, obj: GameObject): number {
  let v = getDef(obj.defName).toughness ?? 0
  for (const s of state.setPT) if (s.objId === obj.id) v = s.toughness
  return v
}

/** Does a static effect from `src` reach creature `obj`? */
function affectsMatch(affects: AffectsFilter, src: GameObject, obj: GameObject, objSubtypes: string[]): boolean {
  if (affects.controllerOnly && src.controllerId !== obj.controllerId) return false
  if (affects.excludeSelf && src.id === obj.id) return false
  if (affects.subtype && !objSubtypes.includes(affects.subtype)) return false
  return true
}

/** Static anthem/lord modifiers applying to `obj`. Iterates battlefield zone arrays
 *  directly (no allocation) and skips non-source permanents — O(1)-ish when nobody
 *  has an anthem out (the common case). */
function staticPT(state: RulesGameState, obj: GameObject): { p: number; t: number } {
  let p = 0
  let t = 0
  if (obj.zone !== 'battlefield') return { p, t } // continuous effects only touch the battlefield
  let objSubtypes: string[] | null = null
  for (const pid of state.turnOrder) {
    for (const id of state.zones.perPlayer[pid]!.battlefield) {
      const src = state.objects[id]
      if (!src || state.loseAbilities.includes(id)) continue // a source with no abilities gives no anthem
      const statics = getDef(src.defName).statics
      if (!statics) continue
      objSubtypes ??= getDef(obj.defName).subtypes ?? []
      for (const s of statics) {
        if (affectsMatch(s.affects, src, obj, objSubtypes)) {
          p += s.power
          t += s.toughness
        }
      }
    }
  }
  return { p, t }
}

/** Effective keywords: the printed set plus any granted by battlefield statics (CR 613 layer 6). */
export function currentKeywords(state: RulesGameState, obj: GameObject): Keyword[] {
  // "loses all abilities" (layer 6) strips its OWN (intrinsic) keywords; grants
  // from other permanents still apply.
  const base = state.loseAbilities.includes(obj.id) ? [] : (getDef(obj.defName).keywords ?? [])
  if (obj.zone !== 'battlefield') return [...base]
  let objSubtypes: string[] | null = null
  let set: Set<Keyword> | null = null
  for (const pid of state.turnOrder) {
    for (const id of state.zones.perPlayer[pid]!.battlefield) {
      const src = state.objects[id]
      if (!src || state.loseAbilities.includes(id)) continue // no-ability source grants nothing
      const grants = getDef(src.defName).staticKeywords
      if (!grants) continue
      objSubtypes ??= getDef(obj.defName).subtypes ?? []
      for (const g of grants) {
        if (affectsMatch(g.affects, src, obj, objSubtypes)) {
          set ??= new Set<Keyword>(base)
          for (const kw of g.keywords) set.add(kw)
        }
      }
    }
  }
  return set ? [...set] : base
}

/** Until-end-of-turn pump total for `obj`. */
function pumpPT(state: RulesGameState, obj: GameObject): { p: number; t: number } {
  let p = 0
  let t = 0
  if (obj.zone !== 'battlefield') return { p, t }
  for (const pm of state.pumps) {
    if (pm.objId === obj.id) {
      p += pm.power
      t += pm.toughness
    }
  }
  return { p, t }
}

export function currentPower(state: RulesGameState, obj: GameObject): number {
  return baseP(state, obj) + counterPT(obj) + staticPT(state, obj).p + pumpPT(state, obj).p
}

export function currentToughness(state: RulesGameState, obj: GameObject): number {
  return baseT(state, obj) + counterPT(obj) + staticPT(state, obj).t + pumpPT(state, obj).t
}
