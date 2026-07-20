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
  const base = state.loseAbilities.includes(obj.id) ? [] : (getDef(obj.defName).keywords ?? [])
  if (obj.zone !== 'battlefield') return [...base]
  // keyword grants ("creatures you control have vigilance", auras/equipment) reach
  // only CREATURES — a land/artifact/planeswalker never receives a granted keyword
  if (!defIsCreature(getDef(obj.defName))) return [...base]
  let objSubtypes: string[] | null = null
  let set: Set<Keyword> | null = null
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
  return { power: baseP(state, obj) + c + s.p + p.p, toughness: baseT(state, obj) + c + s.t + p.t }
}

export function currentPower(state: RulesGameState, obj: GameObject): number {
  return currentPT(state, obj).power
}

export function currentToughness(state: RulesGameState, obj: GameObject): number {
  return currentPT(state, obj).toughness
}
