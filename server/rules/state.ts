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
// call-time-only cycle (state → engine): queueTriggeredAbility is a hoisted function export and is
// only ever invoked inside moveToGraveyard, never at module init — mirrors effects.ts → engine.
import { queueGrantedTrigger, queueTriggeredAbility } from './engine'

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
  const wasBattlefield = obj.zone === 'battlefield'
  pullFromCurrentZone(state, obj)
  obj.zone = zone
  // a transforming DFC reverts to its FRONT face when it leaves the battlefield (CR 712.13)
  if (zone !== 'battlefield') {
    const d = getDef(obj.defName)
    if (d.isBackFace && d.transformsTo) obj.defName = defKey(d.transformsTo)
  }
  // leaves-the-battlefield triggers (CR 603.6d): collected BEFORE the counters are cleared, and fired
  // after the move so the object is already gone (Animate Dead's sacrifice, The Ozolith's counters)
  const leftBattlefield = wasBattlefield && zone !== 'battlefield'
  const ltbFire: ObjId[] = []
  if (leftBattlefield) {
    obj.lastCounters = { ...obj.counters } // last known information for a trigger that reads them
    if (obj.attachedTo) obj.lastAttachedTo = obj.attachedTo // Animate Dead: whom it was enchanting
    const leavingIsCreature = defIsCreature(getDef(obj.defName))
    // its OWN "when this permanent leaves the battlefield" trigger (Animate Dead): it has already been
    // pulled out of the battlefield zone array, so the watcher scan below would never see it
    if (getDef(obj.defName).leavesBattlefield && !getDef(obj.defName).leavesBattlefield!.watch) ltbFire.push(obj.id)
    for (const pid of state.turnOrder) {
      for (const id of state.zones.perPlayer[pid]!.battlefield) {
        const p = state.objects[id]
        const ab = p && getDef(p.defName).leavesBattlefield
        if (!p || !ab) continue
        const isSelf = p.id === objId
        const w = ab.watch
        const fires = !w
          ? isSelf
          : leavingIsCreature && !(w.excludeSelf && isSelf) && !(w.controllerOnly && obj.controllerId !== p.controllerId)
        if (fires) ltbFire.push(p.id)
      }
    }
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
    // "This permanent enters tapped" (Guildgates, Temples, Bojuka Bog…). Centralised here so EVERY
    // entry path agrees: it used to be applied only where a land was played or a spell resolved, so
    // a tapland FETCHED by a search (Crop Rotation → Bojuka Bog) entered untapped.
    if (def.entersTapped) obj.tapped = true
    // enters-with-counters (counters were just reset above) — before any SBA check so a
    // 0/0-with-counters creature survives; applies on ANY entry path (cast, tutor, move)
    if (def.entersWithCounters) putCounters(state, obj.id, '+1/+1', def.entersWithCounters)
    // as-enters choice (CR 614.12, shocklands): QUEUE the pay-life-or-tapped decision for its
    // controller on ANY entry path (played, fetched, moved). It is opened by
    // `drainEntersChoices` once the current decision (e.g. the search being answered) is done, so
    // several permanents entering at once each get their own choice and no pending is clobbered.
    const payLife = def.entersTappedUnlessPayLife
    if (payLife) (state.entersChoiceQueue ??= []).push({ player: obj.controllerId, objId: obj.id, life: payLife })
    // "As this permanent enters, choose a creature type" (CR 614.12c) — the same queue, so a type
    // choice and a shockland's pay-life choice entering together are asked one after the other
    if (def.entersChooseType)
      (state.entersChoiceQueue ??= []).push({ player: obj.controllerId, objId: obj.id, life: 0, chooseType: true })
    // check lands: "enters tapped UNLESS you control an Island or a Mountain" — evaluated here so
    // every entry path (played, fetched, reanimated, moved by hand) agrees
    const need = def.entersTappedUnlessControlLandType
    if (need?.length) {
      const has = zoneArr(state, obj.controllerId, 'battlefield').some((id) => {
        const other = state.objects[id]
        if (!other || other.id === obj.id) return false
        const d = getDef(other.defName)
        return d.types.includes('Land') && (d.subtypes ?? []).some((st) => need.includes(st))
      })
      if (!has) obj.tapped = true
    }
    // battle lands: "enters tapped unless you control two or more BASIC lands"
    const needBasics = def.entersTappedUnlessBasicsAtLeast
    if (needBasics) {
      const basics = zoneArr(state, obj.controllerId, 'battlefield').filter((id) => {
        const other = state.objects[id]
        if (!other || other.id === obj.id) return false
        const d = getDef(other.defName)
        return d.types.includes('Land') && (d.supertypes ?? []).includes('Basic')
      }).length
      if (basics < needBasics) obj.tapped = true
    }
    // the reveal lands: "unless you reveal an Island or Swamp card from your hand" — revealed
    // automatically when the controller holds one (and logged, so the reveal is really public)
    const revealTypes = def.entersTappedUnlessRevealFromHand
    if (revealTypes?.length) {
      const shown = zoneArr(state, obj.controllerId, 'hand').find((id) => {
        const d = getDef(state.objects[id]!.defName)
        return d.types.includes('Land') && (d.subtypes ?? []).some((st) => revealTypes.includes(st))
      })
      if (shown) logLine(state, `${state.players[obj.controllerId]!.name} reveals ${getDef(state.objects[shown]!.defName).name}.`)
      else obj.tapped = true
    }
    // Battlebond lands: "unless you have two or more OPPONENTS" (a duel always taps them)
    const needFoes = def.entersTappedUnlessOpponentsAtLeast
    if (needFoes) {
      const foes = state.turnOrder.filter((pid) => pid !== obj.controllerId && !state.players[pid]!.hasLost).length
      if (foes < needFoes) obj.tapped = true
    }
    // slow lands: "unless you control two or more OTHER lands"
    const needLands = def.entersTappedUnlessOtherLandsAtLeast
    if (needLands) {
      const others = zoneArr(state, obj.controllerId, 'battlefield').filter((id) => {
        const other = state.objects[id]
        return !!other && other.id !== obj.id && getDef(other.defName).types.includes('Land')
      }).length
      if (others < needLands) obj.tapped = true
    }
  }
  const holder = zone === 'battlefield' ? obj.controllerId : obj.ownerId
  const arr = zoneArr(state, holder, zone)
  if (opts.top) arr.unshift(obj.id)
  else arr.push(obj.id)
  // …now that the move is complete, the leaves-the-battlefield triggers go on the stack. The leaving
  // object is passed as their implicit target so an effect can read it (its `lastCounters` included).
  for (const src of ltbFire) queueTriggeredAbility(state, src, 'leavesBattlefield', [objId])
}

/**
 * Death/exile interception for commanders: a commander that would hit the
 * graveyard (or exile) returns to the command zone instead. (The real rule is
 * an owner's CHOICE — auto-return is a documented M-R4 simplification; the
 * starter pool has no graveyard synergies that would make you want otherwise.)
 */
/**
 * Add `n` counters of `kind` to a permanent, applying every counter-placement REPLACEMENT effect its
 * controller has (CR 616): Hardened Scales' "that many plus one", Doubling Season / Branching
 * Evolution / Corpsejack Menace's "twice that many". CR 616.1 lets the affected object's controller
 * order the replacements; "+1" first and doubling last is the ordering they would always choose, so
 * that is what this does (Scales + Season on one counter → (1+1)×2 = 4).
 *
 * This is the ONE place counters are added, so every source (enters-with, undying/persist, an effect,
 * wither damage) is covered. A manual override (r.mCounter) deliberately bypasses it: the players are
 * hand-running something the engine doesn't know.
 * LIMITATION: a planeswalker's starting loyalty is modelled as `obj.loyalty`, not as counters, so
 * Doubling Season does not double it.
 */
export function putCounters(state: RulesGameState, objId: ObjId, kind: string, n: number): number {
  const obj = state.objects[objId]
  if (!obj || n <= 0) return 0
  let total = n
  const isCreature = defIsCreature(getDef(obj.defName))
  const replacers: { mode: 'plusOne' | 'double' }[] = []
  if (obj.zone === 'battlefield') {
    for (const id of zoneArr(state, obj.controllerId, 'battlefield')) {
      const src = state.objects[id]
      if (!src || src.phasedOut || state.loseAbilities.includes(id)) continue
      const rep = getDef(src.defName).counterReplacement
      if (!rep) continue
      if (rep.only && rep.only !== kind) continue
      if (rep.scope === 'creaturesYouControl' && !isCreature) continue
      replacers.push({ mode: rep.mode })
    }
  }
  for (const r of replacers) if (r.mode === 'plusOne') total += 1
  for (const r of replacers) if (r.mode === 'double') total *= 2
  obj.counters[kind] = (obj.counters[kind] ?? 0) + total
  if (total !== n)
    logLine(state, `${getDef(obj.defName).name} gets ${total} ${kind} counters instead of ${n} (replacement effect).`)
  return total
}

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
          : w.scope === 'attachedCreature'
            ? // "whenever EQUIPPED creature dies" (Skullclamp): only for its own host, read
              // before moveTo clears `attachedTo`
              dyingIsCreature && p.attachedTo === objId
            : dyingIsCreature && !(w.excludeSelf && isSelf) && !(w.controllerOnly && obj.controllerId !== p.controllerId)
        if (fires) toFire.push({ sourceId: p.id, defName: p.defName, controllerId: p.controllerId })
      }
    }
  }
  moveTo(state, objId, 'graveyard')
  // Push each collected trigger through the engine's queue so a TARGETED dies trigger (Blood
  // Artist's "target player loses 1 life") opens its target choice; the local push used before
  // always sent empty targets, so such a trigger fizzled on resolution. Non-targeted triggers take
  // the same path as before. (The engine import is a call-time-only cycle, as in effects.ts.)
  for (const t of toFire) queueTriggeredAbility(state, t.sourceId, 'dies')
  // a dies ability GRANTED until end of turn (Malakir Rebirth / Feign Death) fires for the creature
  // that gained it — its body lives in the granting card's definition, so it is queued separately
  for (const g of state.grantedTriggers ?? []) {
    if (g.objId !== objId || g.trigger !== 'dies' || !wasBattlefield) continue
    queueGrantedTrigger(state, objId, g.defName, g.key)
  }
  // persist / undying: return the creature to the battlefield under its OWNER's control with the
  // appropriate counter. Applied directly (documented simplification — the true dies-trigger
  // ordering rarely matters). LIMITATION: ETB triggers do NOT re-fire on the return (the current
  // persist/undying cards are vanilla+keyword); a persist creature WITH an ETB is deferred.
  if ((undying || persist) && obj && obj.zone === 'graveyard') {
    obj.controllerId = obj.ownerId
    moveTo(state, objId, 'battlefield')
    putCounters(state, objId, undying ? '+1/+1' : '-1/-1', 1)
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
  // "Whenever an opponent draws a card, …" (Smothering Tithe) — one trigger per card drawn, and
  // never for the pre-game draws (status is 'mulligans' then). Pushed straight onto the stack like
  // the dies triggers above; `castPayer` is the player who drew, i.e. who may pay the tax.
  if (state.status !== 'active') return
  for (const pid of state.turnOrder) {
    for (const id of state.zones.perPlayer[pid]!.battlefield) {
      const p = state.objects[id]
      const ab = p && getDef(p.defName).drawnCard
      if (!p || !ab || p.phasedOut) continue
      if (ab.watch?.opponentsOnly && p.controllerId === player) continue
      state.zones.stack.push({
        id: mintCardId(),
        kind: 'ability',
        trigger: 'draw',
        controllerId: p.controllerId,
        defName: p.defName,
        sourceId: p.id,
        abilityIndex: null,
        targets: [],
        castPayer: player,
      })
      logLine(state, `${getDef(p.defName).name}'s draw ability triggers.`)
    }
  }
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
  for (const p of Object.values(state.players)) {
    p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
    p.restrictedMana = [] // restricted mana empties with the pool (CR 500.4)
  }
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
