/**
 * State helpers for the rules engine: zone moves, drawing, mana, object
 * queries. All zone mutations go through here so `obj.zone` and the zone
 * arrays never diverge (same invariant discipline as the manual engine).
 */
import type {
  GameObject,
  ObjId,
  PlayerId,
  RulesGameState,
  RulesZone,
} from '#shared/rules/types'
import { getDef, defKey } from './cards/registry'
import { defIsCreature } from './cards/dsl'
import { mintCardId } from '../game/rng'
import { currentKeywords } from './characteristics'

export function zoneArr(state: RulesGameState, player: PlayerId, zone: RulesZone): ObjId[] {
  return state.zones.perPlayer[player]![zone]
}

export function pullFromCurrentZone(state: RulesGameState, obj: GameObject) {
  if (obj.zone === 'stack') {
    const i = state.zones.stack.findIndex((s) => s.kind === 'spell' && s.id === obj.id)
    if (i >= 0) state.zones.stack.splice(i, 1)
    return
  }
  const arr = zoneArr(state, zoneHolder(state, obj), obj.zone)
  const i = arr.indexOf(obj.id)
  if (i >= 0) arr.splice(i, 1)
}

/** Whose per-player zone array holds this object (battlefield → controller; others → owner). */
function zoneHolder(state: RulesGameState, obj: GameObject): PlayerId {
  return obj.zone === 'battlefield' ? obj.controllerId : obj.ownerId
}

/** Move an object to a non-stack zone (battlefield → controller side, rest → owner side). */
export function moveTo(state: RulesGameState, objId: ObjId, zone: RulesZone, opts: { top?: boolean } = {}) {
  const obj = state.objects[objId]
  if (!obj) return
  pullFromCurrentZone(state, obj)
  obj.zone = zone
  // a transforming DFC reverts to its FRONT face when it leaves the battlefield (CR 712.13)
  if (zone !== 'battlefield') {
    const d = getDef(obj.defName)
    if (d.isBackFace && d.transformsTo) obj.defName = defKey(d.transformsTo)
  }
  clearCombatState(state, obj)
  obj.tapped = false
  obj.damageMarked = 0
  obj.deathtouched = false
  obj.attachedTo = null // an Aura/Equipment leaving the battlefield is no longer attached
  obj.counters = {} // counters fall off when an object changes zones (becomes new)
  // until-end-of-turn effects are tied to the object; leaving the zone ends them
  // (a returning object is a NEW object and must not inherit them)
  if (state.pumps.length) state.pumps = state.pumps.filter((pm) => pm.objId !== objId)
  if (state.setPT.length) state.setPT = state.setPT.filter((s) => s.objId !== objId)
  if (state.loseAbilities.length) state.loseAbilities = state.loseAbilities.filter((id) => id !== objId)
  // a planeswalker ENTERING the battlefield (by ANY path: cast, r.mMove, tutor/search,
  // reanimation) is a fresh permanent — set its starting loyalty + reset once-per-turn.
  // Centralised here so no entry path leaves loyalty undefined (→ instant 0-loyalty SBA death).
  if (zone === 'battlefield') {
    const def = getDef(obj.defName)
    if (def.types.includes('Planeswalker')) {
      obj.loyalty = def.loyalty ?? 0
      obj.loyaltyActivatedThisTurn = false
    }
    // enters-with-counters (counters were just reset above) — before any SBA check so a
    // 0/0-with-counters creature survives; applies on ANY entry path (cast, tutor, move)
    if (def.entersWithCounters) obj.counters['+1/+1'] = def.entersWithCounters
  }
  const holder = zone === 'battlefield' ? obj.controllerId : obj.ownerId
  const arr = zoneArr(state, holder, zone)
  if (opts.top) arr.unshift(obj.id)
  else arr.push(obj.id)
}

/**
 * Death/exile interception for commanders: a commander that would hit the
 * graveyard (or exile) returns to the command zone instead. (The real rule is
 * an owner's CHOICE — auto-return is a documented M-R4 simplification; the
 * starter pool has no graveyard synergies that would make you want otherwise.)
 */
export function moveToGraveyard(state: RulesGameState, objId: ObjId) {
  const obj = state.objects[objId]
  if (obj?.isCommander) {
    logLine(state, `${state.players[obj.ownerId]!.name}'s commander returns to the command zone.`)
    moveTo(state, objId, 'command')
    return
  }
  // "dies" triggers fire only for a battlefield → graveyard move (CR 700.4).
  // Collect them (the dying creature's own + any battlefield permanent watching
  // "a/another creature dies") BEFORE the zone changes, then stack them (non-
  // targeted). Note: simultaneous deaths are processed sequentially — a watcher
  // that itself died earlier in the same event won't see later co-deaths.
  const wasBattlefield = !!obj && obj.zone === 'battlefield'
  const dyingIsCreature = wasBattlefield && defIsCreature(getDef(obj!.defName))
  // persist (CR 702.79) / undying (CR 702.92): a creature that dies returns to the battlefield
  // with a counter IF it had no such counter when it died — capture that BEFORE moveTo clears
  // counters. Uses `currentKeywords` (last-known-info at death) so it honors granted keywords AND
  // "loses all abilities" (layer 6): a de-abilitied creature has no undying/persist and stays dead.
  const dyingKw = dyingIsCreature ? currentKeywords(state, obj!) : []
  const undying = dyingKw.includes('undying') && (obj!.counters['+1/+1'] ?? 0) === 0
  const persist = dyingKw.includes('persist') && (obj!.counters['-1/-1'] ?? 0) === 0
  const toFire: { sourceId: ObjId; defName: string; controllerId: PlayerId }[] = []
  if (wasBattlefield && obj) {
    for (const pid of state.turnOrder) {
      for (const id of state.zones.perPlayer[pid]!.battlefield) {
        const p = state.objects[id]
        const ab = p && getDef(p.defName).dies
        if (!p || !ab) continue
        const isSelf = p.id === objId
        const w = ab.watch
        const fires = !w
          ? isSelf
          : dyingIsCreature && !(w.excludeSelf && isSelf) && !(w.controllerOnly && obj.controllerId !== p.controllerId)
        if (fires) toFire.push({ sourceId: p.id, defName: p.defName, controllerId: p.controllerId })
      }
    }
  }
  moveTo(state, objId, 'graveyard')
  for (const t of toFire) {
    state.zones.stack.push({
      id: mintCardId(),
      kind: 'ability',
      trigger: 'dies',
      controllerId: t.controllerId,
      defName: t.defName,
      sourceId: t.sourceId,
      abilityIndex: null,
      targets: [],
    })
    logLine(state, `${getDef(t.defName).name}'s dies ability triggers.`)
  }
  // persist / undying: return the creature to the battlefield under its OWNER's control with the
  // appropriate counter. Applied directly (documented simplification — the true dies-trigger
  // ordering rarely matters). LIMITATION: ETB triggers do NOT re-fire on the return (the current
  // persist/undying cards are vanilla+keyword); a persist creature WITH an ETB is deferred.
  if ((undying || persist) && obj && obj.zone === 'graveyard') {
    obj.controllerId = obj.ownerId
    moveTo(state, objId, 'battlefield')
    obj.counters[undying ? '+1/+1' : '-1/-1'] = 1
    obj.summoningSick = true // re-enters as a new object → summoning sick
    logLine(state, `${getDef(obj.defName).name} returns with a ${undying ? '+1/+1' : '-1/-1'} counter (${undying ? 'undying' : 'persist'}).`)
  }
}

function clearCombatState(state: RulesGameState, obj: GameObject) {
  obj.attackingDefender = null
  obj.attackingPwId = null
  obj.blockingAttackerId = null
  for (const order of Object.values(state.blockOrders)) {
    const i = order.indexOf(obj.id)
    if (i >= 0) order.splice(i, 1)
  }
  delete state.blockOrders[obj.id]
}

/** Draw one card; drawing from an empty library loses the game (flagged, SBA ends it). */
export function drawOne(state: RulesGameState, player: PlayerId) {
  const lib = zoneArr(state, player, 'library')
  const top = lib[0]
  if (!top) {
    state.players[player]!.hasLost = true
    state.log.push(`${state.players[player]!.name} tries to draw from an empty library and loses.`)
    return
  }
  const obj = state.objects[top]!
  pullFromCurrentZone(state, obj)
  obj.zone = 'hand'
  zoneArr(state, player, 'hand').push(obj.id)
}

export function isCreatureOnBattlefield(state: RulesGameState, id: ObjId | PlayerId): boolean {
  const obj = state.objects[id as ObjId]
  // phased-out (CR 702.26e) and bestowed-as-Aura (CR 702.103) permanents aren't creatures here
  return !!obj && obj.zone === 'battlefield' && !obj.phasedOut && !obj.bestowed && defIsCreature(getDef(obj.defName))
}

export function battlefieldCreatures(state: RulesGameState, controller?: PlayerId): GameObject[] {
  return Object.values(state.objects).filter(
    (o) =>
      o.zone === 'battlefield' &&
      !o.phasedOut && // phased-out permanents don't exist for combat/SBA/sweepers (CR 702.26e)
      !o.bestowed && // a bestowed permanent is an Aura, not a creature (CR 702.103)
      defIsCreature(getDef(o.defName)) &&
      (controller === undefined || o.controllerId === controller),
  )
}

export function emptyManaPools(state: RulesGameState) {
  for (const p of Object.values(state.players)) p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
}

export function alivePlayers(state: RulesGameState): PlayerId[] {
  return state.turnOrder.filter((p) => !state.players[p]!.hasLost)
}

/**
 * The next player in seating order strictly after `from` (regardless of whether
 * `from` itself is still alive) satisfying `pred`. Used for correct turn
 * rotation and APNAP priority continuation even when `from` was eliminated.
 */
export function nextInTurnOrder(
  state: RulesGameState,
  from: PlayerId,
  pred: (p: PlayerId) => boolean,
): PlayerId | null {
  const order = state.turnOrder
  const start = order.indexOf(from)
  for (let k = 1; k <= order.length; k++) {
    const p = order[(start + k) % order.length]!
    if (pred(p)) return p
  }
  return null
}

export function opponentsOf(state: RulesGameState, player: PlayerId): PlayerId[] {
  return alivePlayers(state).filter((p) => p !== player)
}

/** Turn order rotated to start at `from` (APNAP basis), alive players only. */
export function apnapOrder(state: RulesGameState, from: PlayerId): PlayerId[] {
  const order = state.turnOrder
  const i = Math.max(0, order.indexOf(from))
  const rotated = [...order.slice(i), ...order.slice(0, i)]
  return rotated.filter((p) => !state.players[p]!.hasLost)
}

/**
 * Rule 800.4a: when a player leaves a multiplayer game, all objects they OWN
 * leave the game, and spells/abilities they CONTROL on the stack cease to
 * exist. Their combat involvement dissolves.
 */
export function removePlayersObjects(state: RulesGameState, pid: PlayerId) {
  state.zones.stack = state.zones.stack.filter((item) => {
    if (item.controllerId !== pid && state.objects[item.id]?.ownerId !== pid) return true
    return false
  })
  for (const obj of Object.values(state.objects)) {
    if (obj.ownerId === pid) {
      pullFromCurrentZone(state, obj)
      delete state.objects[obj.id]
    } else if (obj.attackingDefender === pid) {
      obj.attackingDefender = null // combat against the departed player ends
    }
  }
}

export function logLine(state: RulesGameState, line: string) {
  state.log.push(line)
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300)
}
