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
import { getDef } from './cards/registry'
import { defIsCreature } from './cards/dsl'
import { mintCardId } from '../game/rng'

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
  clearCombatState(state, obj)
  obj.tapped = false
  obj.damageMarked = 0
  obj.deathtouched = false
  obj.counters = {} // counters fall off when an object changes zones (becomes new)
  // until-end-of-turn effects are tied to the object; leaving the zone ends them
  // (a returning object is a NEW object and must not inherit them)
  if (state.pumps.length) state.pumps = state.pumps.filter((pm) => pm.objId !== objId)
  if (state.setPT.length) state.setPT = state.setPT.filter((s) => s.objId !== objId)
  if (state.loseAbilities.length) state.loseAbilities = state.loseAbilities.filter((id) => id !== objId)
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
}

function clearCombatState(state: RulesGameState, obj: GameObject) {
  obj.attackingDefender = null
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
  return !!obj && obj.zone === 'battlefield' && defIsCreature(getDef(obj.defName))
}

export function battlefieldCreatures(state: RulesGameState, controller?: PlayerId): GameObject[] {
  return Object.values(state.objects).filter(
    (o) =>
      o.zone === 'battlefield' &&
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
