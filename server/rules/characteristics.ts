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
import { defIsCreature } from './cards/dsl'
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
  // "of the chosen type": the type this source's controller picked as it entered (Patchwork Banner).
  // No type chosen yet (it left before the choice) → the effect applies to nothing.
  if (affects.subtypeChosen && !(src.chosenType && objSubtypes.includes(src.chosenType))) return false
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
      if (!src || src.phasedOut || state.loseAbilities.includes(id)) continue // phased-out / no-ability source gives no anthem/grant
      const def = getDef(src.defName)
      // Aura/Equipment attached to this host contributes its P/T grant (CR 613 layer 7c)
      if (src.attachedTo === obj.id && def.grantsToHost) {
        p += def.grantsToHost.power ?? 0
        t += def.grantsToHost.toughness ?? 0
      }
      const statics = def.statics
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
  // a face-down (morph) creature has no printed keywords (CR 707.2); "loses all abilities" strips them too
  const base = obj.faceDown || state.loseAbilities.includes(obj.id) ? [] : (getDef(obj.defName).keywords ?? [])
  if (obj.zone !== 'battlefield') return [...base]
  let objSubtypes: string[] | null = null
  let set: Set<Keyword> | null = null
  // until-end-of-turn grants (Heroic Intervention) reach ANY permanent type — "permanents you
  // control gain hexproof and indestructible" must protect your lands and artifacts too
  for (const g of state.keywordGrants ?? []) {
    if (g.objId !== obj.id) continue
    set ??= new Set<Keyword>(base)
    set.add(g.keyword)
  }
  // static grants from a permanent ("creatures you control have vigilance", auras/equipment) reach
  // only CREATURES — a land/artifact/planeswalker never receives one of those
  if (!defIsCreature(getDef(obj.defName))) return set ? [...set] : [...base]
  for (const pid of state.turnOrder) {
    for (const id of state.zones.perPlayer[pid]!.battlefield) {
      const src = state.objects[id]
      if (!src || src.phasedOut || state.loseAbilities.includes(id)) continue // phased-out / no-ability source grants nothing
      const def = getDef(src.defName)
      // keywords granted by an Aura/Equipment attached to this host (CR 613 layer 6)
      if (src.attachedTo === obj.id && def.grantsToHost?.keywords?.length) {
        set ??= new Set<Keyword>(base)
        for (const kw of def.grantsToHost.keywords) set.add(kw)
      }
      const grants = def.staticKeywords
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

/** Does any Aura/Equipment attached to `obj` impose a can't-attack / can't-block restriction? */
function hostRestriction(state: RulesGameState, obj: GameObject, which: 'cantAttack' | 'cantBlock'): boolean {
  if (obj.zone !== 'battlefield') return false
  for (const pid of state.turnOrder) {
    for (const id of state.zones.perPlayer[pid]!.battlefield) {
      const src = state.objects[id]
      if (src && !src.phasedOut && src.attachedTo === obj.id && (getDef(src.defName).grantsToHost?.[which] ?? false)) return true
    }
  }
  return false
}
export const hostCantAttack = (state: RulesGameState, obj: GameObject) => hostRestriction(state, obj, 'cantAttack')
export const hostCantBlock = (state: RulesGameState, obj: GameObject) => hostRestriction(state, obj, 'cantBlock')

/**
 * Effective power AND toughness in a single pass (CR 613 layer 7). Computing both together does the
 * battlefield-scanning `staticPT`/`pumpPT` work ONCE rather than twice — the redactor calls this for
 * every object × every viewer × every action, so halving that scan is a large win for the leak
 * fuzzer and live redaction. `currentPower`/`currentToughness` delegate here.
 */
export function currentPT(state: RulesGameState, obj: GameObject): { power: number; toughness: number } {
  const c = counterPT(obj)
  const s = staticPT(state, obj)
  const p = pumpPT(state, obj)
  // a face-down (morph) permanent is a 2/2 with no printed characteristics (CR 707.2), still
  // affected by counters/anthems/pumps
  const bp = obj.faceDown ? 2 : baseP(state, obj)
  const bt = obj.faceDown ? 2 : baseT(state, obj)
  return { power: bp + c + s.p + p.p, toughness: bt + c + s.t + p.t }
}

export function currentPower(state: RulesGameState, obj: GameObject): number {
  return currentPT(state, obj).power
}

export function currentToughness(state: RulesGameState, obj: GameObject): number {
  return currentPT(state, obj).toughness
}
