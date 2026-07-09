/**
 * The rules-engine loop (M-R0, 1v1): turn/step machine, priority passing
 * (APNAP for two players), the stack, casting with mana payment + timing,
 * combat, state-based actions, win/loss.
 *
 * Entry points: `startGame(state)` once after setup, then
 * `applyRulesAction(state, actor, msg)` per player action (throws RulesError
 * on anything illegal — enforcement IS the feature).
 */
import type { GameObject, ObjId, PlayerId, RulesGameState, StackItem } from '#shared/rules/types'
import { currentKeywords, currentPower, currentToughness } from './characteristics'
import { STEPS } from '#shared/rules/types'
import type { RulesMsgT } from '#shared/rules/messages'
import { parseManaCost, planPayment } from '#shared/utils/manaCost'
import { getDef, registerToken } from './cards/registry'
import { mintCardId, shuffleInPlace } from '../game/rng'
import { defIsCreature, defIsLand, defIsPermanent, type CardDefinition, type TargetSpec, type TargetFilter } from './cards/dsl'
import type { Keyword } from '#shared/rules/types'
import {
  alivePlayers,
  apnapOrder,
  battlefieldCreatures,
  drawOne,
  emptyManaPools,
  isCreatureOnBattlefield,
  logLine,
  moveTo,
  moveToGraveyard,
  nextInTurnOrder,
  opponentsOf,
  pullFromCurrentZone,
  removePlayersObjects,
  zoneArr,
} from './state'

export class RulesError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

const name = (state: RulesGameState, p: PlayerId) => state.players[p]!.name
const objName = (state: RulesGameState, id: ObjId) => getDef(state.objects[id]!.defName).name
const hasKw = (state: RulesGameState, id: ObjId, kw: Keyword) =>
  currentKeywords(state, state.objects[id]!).includes(kw)
const setCounter = (obj: GameObject, name: string, value: number) => {
  if (value > 0) obj.counters[name] = value
  else delete obj.counters[name]
}

// ---------- state-based actions ----------

export function checkSBA(state: RulesGameState) {
  if (state.status === 'ended') return
  let changed = true
  while (changed) {
    changed = false
    // CR 704.5q: ANY permanent (not just creatures) with both +1/+1 and -1/-1
    // counters removes the same number of each.
    for (const obj of Object.values(state.objects)) {
      if (obj.zone !== 'battlefield') continue
      const plus = obj.counters['+1/+1'] ?? 0
      const minus = obj.counters['-1/-1'] ?? 0
      if (plus > 0 && minus > 0) {
        const n = Math.min(plus, minus)
        setCounter(obj, '+1/+1', plus - n)
        setCounter(obj, '-1/-1', minus - n)
        changed = true
      }
    }
    for (const obj of battlefieldCreatures(state)) {
      const def = getDef(obj.defName)
      // Assisted table: never auto-destroy a card whose rules we don't know
      // (its real toughness may differ, it may be indestructible, etc.). Its
      // controller removes it manually. Implemented creatures die normally.
      if (def.unimplemented) continue
      const toughness = currentToughness(state, obj)
      // indestructible survives lethal damage / deathtouch, but 0-or-less
      // toughness still dies (CR 704.5f is not "destruction")
      const indestructible = hasKw(state, obj.id, 'indestructible')
      if (toughness <= 0 || (!indestructible && (obj.damageMarked >= toughness || obj.deathtouched))) {
        logLine(state, `${def.name} dies.`)
        moveToGraveyard(state, obj.id)
        changed = true
      }
    }
    for (const p of Object.values(state.players)) {
      if (p.hasLost) continue
      if (p.life <= 0) {
        p.hasLost = true
        logLine(state, `${p.name} loses the game (0 life).`)
        changed = true
      } else if (Object.values(p.commanderDamage).some((d) => d >= 21)) {
        p.hasLost = true
        logLine(state, `${p.name} loses to commander damage (21+).`)
        changed = true
      }
    }
    // rule 800.4a: departed players' cards leave; their spells cease to exist
    for (const p of Object.values(state.players)) {
      if (!p.hasLost) continue
      const stillOwns =
        Object.values(state.objects).some((o) => o.ownerId === p.id) ||
        state.zones.stack.some((s) => s.controllerId === p.id)
      if (stillOwns) {
        removePlayersObjects(state, p.id)
        logLine(state, `${p.name} leaves the game — their cards go with them.`)
        changed = true
      }
    }
  }
  const alive = alivePlayers(state)
  if (alive.length <= 1) {
    state.status = 'ended'
    state.winner = alive[0] ?? null
    state.priorityPlayer = null
    state.pending = null
    logLine(state, state.winner ? `${name(state, state.winner)} wins the game!` : 'The game is a draw.')
  }
}

function grantPriority(state: RulesGameState, player: PlayerId) {
  checkSBA(state)
  if (state.status === 'ended') return
  // if the intended holder left the game, priority goes to the next alive
  // player in APNAP order from the active player
  const target = state.players[player]!.hasLost ? apnapOrder(state, state.activePlayer)[0]! : player
  state.priorityPlayer = target
  state.passed = []
}

// ---------- forced sacrifice (edicts / aristocrats) ----------

/**
 * Open a forced-sacrifice prompt for the first player in `players` who controls a
 * creature; the remaining such players wait in a queue (each will be prompted to
 * sacrifice `count`). No-op if nobody controls a creature. Called from edict
 * effects at resolution — leaves `state.pending` set so resolveTop won't grant
 * priority until the sacrifice is made.
 */
export function openSacrifice(state: RulesGameState, players: PlayerId[], count: number) {
  const queue = players.filter((pid) => !state.players[pid]!.hasLost && battlefieldCreatures(state, pid).length > 0)
  if (!queue.length) return
  promptSacrifice(state, queue[0]!, queue.slice(1), count)
}

function promptSacrifice(state: RulesGameState, player: PlayerId, queue: PlayerId[], count: number) {
  const candidates = battlefieldCreatures(state, player).map((c) => c.id)
  // store the ORIGINAL requested count; each player sacrifices min(count, their
  // creatures) — clamped at validation/display, so the queue threads count intact
  state.pending = { kind: 'sacrifice', player }
  state.pendingSacrifice = { player, candidateIds: candidates, count, queue }
}

/** After a sacrifice resolves, prompt the next queued player, else hand priority back. */
function advanceSacrificeQueue(state: RulesGameState) {
  const rawQueue = state.pendingSacrifice?.queue ?? []
  const count = state.pendingSacrifice?.count ?? 1
  state.pending = null
  state.pendingSacrifice = null
  // next queued player who is still in the game and still controls a creature
  const idx = rawQueue.findIndex((pid) => !state.players[pid]!.hasLost && battlefieldCreatures(state, pid).length > 0)
  if (idx >= 0) {
    promptSacrifice(state, rawQueue[idx]!, rawQueue.slice(idx + 1), count)
    return
  }
  checkSBA(state)
  if (!state.pending && state.status === 'active') grantPriority(state, state.activePlayer)
}

/**
 * Invariant #3: re-mint an object's id when it enters a hidden zone (hand or
 * library) from a PUBLIC one, so an opponent who recorded its public id can't
 * track it into a hidden zone. Only the manual `r.mMove` override can make such
 * a public→hidden move today. Commanders keep their id — their identity is
 * public and `player.commanderId` references it.
 */
export function remintForHiddenEntry(state: RulesGameState, oldId: ObjId, fromPublic: boolean) {
  const obj = state.objects[oldId]
  if (!obj || obj.isCommander || !fromPublic) return
  const zone = obj.zone
  if (zone !== 'hand' && zone !== 'library') return // only hidden zones re-mint
  const newId = mintCardId()
  const arr = zoneArr(state, obj.ownerId, zone) // hidden zones are always owner-side
  const i = arr.indexOf(oldId)
  if (i >= 0) arr[i] = newId
  obj.id = newId
  state.objects[newId] = obj
  delete state.objects[oldId]
}

/** Re-mint every id in a player's library (post-shuffle / post-bottom) so an id that
 *  was once visible (a mulliganed hand) can't be tracked into the hidden library. */
function remintLibrary(state: RulesGameState, pid: PlayerId) {
  const lib = zoneArr(state, pid, 'library')
  for (let i = 0; i < lib.length; i++) {
    const oldId = lib[i]!
    const obj = state.objects[oldId]
    if (!obj) continue
    const newId = mintCardId()
    obj.id = newId
    state.objects[newId] = obj
    delete state.objects[oldId]
    lib[i] = newId
  }
}

/** Leave the mulligan phase and begin turn 1 once every remaining player has kept. */
function finishMulligans(state: RulesGameState) {
  state.status = 'active'
  logLine(state, 'All players have kept — the game begins.')
  startGame(state)
}
function maybeFinishMulligans(state: RulesGameState) {
  if (state.status !== 'mulligans') return
  const alive = alivePlayers(state)
  if (alive.length && alive.every((pid) => state.players[pid]!.keptHand)) finishMulligans(state)
}

/**
 * Safety net run after every action: if control flow (a pending decision or
 * priority) points at a player who has since left the game — e.g. a player who
 * drove their own life to 0 via a manual override while it was their turn to
 * declare attackers/blockers or discard — hand the decision/priority off so the
 * remaining players aren't wedged. `checkSBA` only clears these when the game
 * ENDS (≤1 player left); this covers the ≥2-players-remain case.
 */
function repairControlFlow(state: RulesGameState) {
  if (state.status !== 'active') return
  if (state.pending && state.players[state.pending.player]!.hasLost) {
    const { kind, player } = state.pending
    state.pending = null
    state.pendingTrigger = null // a departed player's trigger is removed
    state.pendingScry = null
    if (kind === 'blockers') {
      if (!state.blockersDone.includes(player)) state.blockersDone.push(player)
      advanceBlockersQueue(state)
    } else if (kind === 'discard') {
      finishCleanup(state) // their hand left the game with them
    } else if (kind === 'sacrifice') {
      // the departed player's own mandated sacrifice lapses, but the rest of an
      // each-player queue must still resolve — skip them, prompt the next player
      // (advanceSacrificeQueue clears the now-stale pendingSacrifice for us)
      advanceSacrificeQueue(state)
    } else {
      grantPriority(state, state.activePlayer) // attackers/trigger: none declared (508.8 skip applies)
    }
    return
  }
  if (state.priorityPlayer && state.players[state.priorityPlayer]!.hasLost) {
    state.passed = state.passed.filter((p) => !state.players[p]!.hasLost)
    grantPriority(state, state.activePlayer)
  }
}

// ---------- turn machine ----------

export function startGame(state: RulesGameState) {
  beginStep(state)
}

function nextStep(state: RulesGameState) {
  emptyManaPools(state)
  state.priorityPlayer = null
  // CR 508.8: if no attackers were DECLARED, skip declare_blockers and
  // combat_damage (but never the declare_attackers step itself — CR 508.4).
  if (state.step === 'declare_attackers' && !state.attackersDeclaredThisCombat) {
    state.step = 'end_combat'
    beginStep(state)
    return
  }
  const i = STEPS.indexOf(state.step)
  if (i === STEPS.length - 1) return // cleanup handles turn change itself
  state.step = STEPS[i + 1]!
  beginStep(state)
}

function nextTurn(state: RulesGameState) {
  emptyManaPools(state)
  // walk the FULL seating order forward from the (possibly eliminated) active
  // player to the next living player — CR 800.4a keeps the seat rotation intact
  state.activePlayer =
    nextInTurnOrder(state, state.activePlayer, (p) => !state.players[p]!.hasLost) ?? state.activePlayer
  state.turnNumber++
  state.step = 'untap'
  logLine(state, `Turn ${state.turnNumber} — ${name(state, state.activePlayer)}.`)
  beginStep(state)
}

function beginStep(state: RulesGameState) {
  if (state.status === 'ended') return
  const ap = state.activePlayer
  switch (state.step) {
    case 'untap': {
      const p = state.players[ap]!
      p.landsPlayedThisTurn = 0
      for (const obj of Object.values(state.objects)) {
        if (obj.zone === 'battlefield' && obj.controllerId === ap) {
          obj.tapped = false
          obj.summoningSick = false
        }
      }
      // no player receives priority during untap
      nextStep(state)
      return
    }
    case 'draw': {
      const isVeryFirstDraw = state.turnNumber === 1 && ap === state.turnOrder[0] && state.firstTurnSkipDraw
      if (isVeryFirstDraw) logLine(state, `${name(state, ap)} skips the first draw.`)
      else if (!state.players[ap]!.hasLost) {
        drawOne(state, ap)
        logLine(state, `${name(state, ap)} draws a card.`)
      }
      grantPriority(state, ap)
      return
    }
    case 'declare_attackers': {
      state.attackersDeclaredThisCombat = false
      state.blockersDone = []
      const eligible = battlefieldCreatures(state, ap).filter(
        (c) =>
          !c.tapped &&
          (!c.summoningSick || hasKw(state, c.id, 'haste')) &&
          !hasKw(state, c.id, 'defender'),
      )
      if (!eligible.length || state.players[ap]!.hasLost) {
        // the step still occurs and grants priority (CR 508.4); the skip of the
        // later combat steps happens on the way out, in nextStep (CR 508.8)
        logLine(state, `${name(state, ap)} has no attackers.`)
        grantPriority(state, ap)
        return
      }
      state.pending = { kind: 'attackers', player: ap }
      return
    }
    case 'declare_blockers': {
      advanceBlockersQueue(state)
      return
    }
    case 'combat_damage': {
      dealAllCombatDamage(state)
      grantPriority(state, ap) // runs SBA + handles a game end
      return
    }
    case 'end_combat': {
      for (const obj of Object.values(state.objects)) {
        obj.attackingDefender = null
        obj.blockingAttackerId = null
      }
      state.blockOrders = {}
      state.attackersDeclaredThisCombat = false
      state.blockersDone = []
      grantPriority(state, ap)
      return
    }
    case 'cleanup': {
      const hand = zoneArr(state, ap, 'hand')
      if (hand.length > 7) {
        state.pending = { kind: 'discard', player: ap }
        return
      }
      finishCleanup(state)
      return
    }
    default:
      // upkeep, main1, begin_combat, main2, end — plain priority steps
      grantPriority(state, ap)
  }
}

/**
 * Multiplayer block declarations: each attacked defender declares in APNAP
 * order. Defenders with no untapped creatures auto-declare none. When the
 * queue is exhausted, the active player receives priority (CR 509.4).
 */
function advanceBlockersQueue(state: RulesGameState) {
  const attacked = new Set(
    Object.values(state.objects)
      .map((o) => o.attackingDefender)
      .filter((d): d is PlayerId => !!d),
  )
  for (const defender of apnapOrder(state, state.activePlayer)) {
    if (defender === state.activePlayer || !attacked.has(defender)) continue
    if (state.blockersDone.includes(defender)) continue
    const eligible = battlefieldCreatures(state, defender).filter((c) => !c.tapped)
    if (!eligible.length) {
      logLine(state, `${name(state, defender)} declares no blockers.`)
      state.blockersDone.push(defender)
      continue
    }
    state.pending = { kind: 'blockers', player: defender }
    return
  }
  state.pending = null
  grantPriority(state, state.activePlayer)
}

function finishCleanup(state: RulesGameState) {
  for (const obj of Object.values(state.objects)) {
    obj.damageMarked = 0
    obj.deathtouched = false
  }
  state.pumps = [] // until-end-of-turn effects wear off
  state.setPT = []
  state.loseAbilities = []
  state.pending = null
  if (state.status === 'ended') return
  nextTurn(state)
}

// ---------- combat damage ----------

/**
 * Combat damage step: a first-strike/double-strike sub-step (only if any
 * combatant has one of those), then the regular sub-step (CR 510). Priority
 * between the two sub-steps is skipped (M-R0 simplification).
 */
function dealAllCombatDamage(state: RulesGameState) {
  const anyFirstStrike = battlefieldCreatures(state).some(
    (c) =>
      (c.attackingDefender || c.blockingAttackerId) &&
      (hasKw(state, c.id, 'first strike') || hasKw(state, c.id, 'double strike')),
  )
  if (anyFirstStrike) {
    dealCombatDamage(state, 'first')
    checkSBA(state)
  }
  if (state.status !== 'ended') dealCombatDamage(state, 'regular')
}

/**
 * Deal combat damage for one sub-step. `pass` is 'first' (first-strike +
 * double-strike sources) or 'regular' (double-strike + non-first-strike
 * sources). Handles deathtouch (any damage is lethal), trample (excess spills
 * to the defending player), and lifelink (source's controller gains life).
 */
function dealCombatDamage(state: RulesGameState, pass: 'first' | 'regular') {
  const actsThisPass = (id: ObjId): boolean => {
    const first = hasKw(state, id, 'first strike')
    const double = hasKw(state, id, 'double strike')
    return pass === 'first' ? first || double : double || !first
  }
  type Hit = { source: ObjId; target: ObjId | PlayerId; amount: number; fromCommander?: ObjId }
  const hits: Hit[] = []

  for (const attacker of battlefieldCreatures(state)) {
    if (!attacker.attackingDefender || !actsThisPass(attacker.id)) continue
    const power = currentPower(state, attacker)
    if (power <= 0) continue
    const deadly = hasKw(state, attacker.id, 'deathtouch')
    const trample = hasKw(state, attacker.id, 'trample')
    const wasBlocked = attacker.id in state.blockOrders
    if (!wasBlocked) {
      hits.push({
        source: attacker.id,
        target: attacker.attackingDefender,
        amount: power,
        fromCommander: attacker.isCommander ? attacker.id : undefined,
      })
      continue
    }
    const blockers = (state.blockOrders[attacker.id] ?? []).filter((b) => isCreatureOnBattlefield(state, b))
    let remaining = power
    blockers.forEach((blockerId, idx) => {
      if (remaining <= 0) return
      const b = state.objects[blockerId]!
      // lethal = enough to destroy (deathtouch: 1); non-trample piles any surplus
      // onto the last blocker (matches the M-R0 assignment), trample saves it.
      const lethal = deadly ? 1 : Math.max(1, currentToughness(state, b) - b.damageMarked)
      const amount = !trample && idx === blockers.length - 1 ? remaining : Math.min(remaining, lethal)
      hits.push({ source: attacker.id, target: blockerId, amount })
      remaining -= amount
    })
    // trample: leftover after lethal-to-all-blockers spills to the defending
    // player — including when NO blocker survives to damage (CR 510.1c), so we
    // must NOT gate this on blockers.length (this branch is blocked-only; an
    // unblocked attacker already took the early return above)
    if (trample && remaining > 0) {
      hits.push({
        source: attacker.id,
        target: attacker.attackingDefender,
        amount: remaining,
        fromCommander: attacker.isCommander ? attacker.id : undefined,
      })
    }
  }
  // blockers strike back (still on battlefield, still blocking a live attacker)
  for (const blocker of battlefieldCreatures(state)) {
    if (!blocker.blockingAttackerId || !actsThisPass(blocker.id)) continue
    const attacker = state.objects[blocker.blockingAttackerId]
    if (!attacker || attacker.zone !== 'battlefield') continue
    const power = currentPower(state, blocker)
    if (power > 0) hits.push({ source: blocker.id, target: attacker.id, amount: power })
  }

  // apply simultaneously
  for (const hit of hits) {
    const deadly = hasKw(state, hit.source, 'deathtouch')
    if (Object.hasOwn(state.players, hit.target)) {
      const victim = state.players[hit.target as PlayerId]!
      victim.life -= hit.amount
      if (hit.fromCommander) {
        victim.commanderDamage[hit.fromCommander] = (victim.commanderDamage[hit.fromCommander] ?? 0) + hit.amount
        logLine(state, `${victim.name} takes ${hit.amount} commander damage (${victim.commanderDamage[hit.fromCommander]} total).`)
      } else {
        logLine(state, `${victim.name} takes ${hit.amount} combat damage.`)
      }
    } else if (isCreatureOnBattlefield(state, hit.target)) {
      const t = state.objects[hit.target as ObjId]!
      t.damageMarked += hit.amount
      if (deadly && hit.amount > 0) t.deathtouched = true
    }
    // lifelink: the SOURCE's controller gains life equal to the damage dealt
    if (hit.amount > 0 && hasKw(state, hit.source, 'lifelink')) {
      const controller = state.objects[hit.source]?.controllerId
      if (controller && state.players[controller]) {
        state.players[controller]!.life += hit.amount
        logLine(state, `${state.players[controller]!.name} gains ${hit.amount} life (lifelink).`)
      }
    }
  }
}

// ---------- the stack ----------

function resolveTop(state: RulesGameState) {
  const item = state.zones.stack.pop()
  if (!item) return
  state.passed = []
  if (item.kind === 'spell') resolveSpell(state, item)
  else if (item.kind === 'ability') resolveAbility(state, item)
  // a targeted trigger sets `pending` for its controller's choice — don't grant
  // priority until they've chosen (r.chooseTargets does it)
  if (!state.pending) grantPriority(state, state.activePlayer)
}

/** The triggered ability on `def` for a given trigger kind. */
function abilityFor(def: CardDefinition, kind: StackItem['trigger']) {
  return kind === 'dies' ? def.dies : kind === 'attacks' ? def.attacks : def.enters
}

/** Resolve a triggered ability (enters / dies / attacks) or an activated ability. */
function resolveAbility(state: RulesGameState, item: StackItem) {
  const def = getDef(item.defName)
  const ability = item.abilityIndex != null ? def.abilities?.[item.abilityIndex] : abilityFor(def, item.trigger ?? 'etb')
  if (!ability) return
  const specs = flattenSpecs(ability.targets)
  let targets = item.targets
  if (specs.length) {
    targets = item.targets.filter((t, i) => specs[i] && isLegalTarget(state, specs[i]!, t, item.controllerId))
    if (!targets.length) {
      logLine(state, `${def.name}'s ability fizzles (targets are gone).`)
      return
    }
  }
  // a triggered ability resolves even if its source has since left the battlefield
  ability.effect({ state, controllerId: item.controllerId, sourceId: item.sourceId, targets })
  checkSBA(state)
}

function resolveSpell(state: RulesGameState, item: StackItem) {
  const obj = state.objects[item.id]
  if (!obj) return
  const def = getDef(item.defName)
  const specs = flattenTargetSpecs(def)
  if (specs.length) {
    const stillLegal = item.targets.filter((t, i) => specs[i] && isLegalTarget(state, specs[i]!, t, item.controllerId))
    if (!stillLegal.length) {
      logLine(state, `${def.name} fizzles (all targets illegal).`)
      moveToGraveyard(state, obj.id)
      checkSBA(state)
      return
    }
    def.spell?.effect({ state, controllerId: item.controllerId, sourceId: item.id, targets: stillLegal })
  } else {
    def.spell?.effect({ state, controllerId: item.controllerId, sourceId: item.id, targets: [] })
  }

  if (defIsPermanent(def)) {
    logLine(state, `${def.name} enters the battlefield.`)
    obj.controllerId = item.controllerId
    obj.summoningSick = defIsCreature(def)
    moveTo(state, obj.id, 'battlefield')
    if (def.entersTapped) obj.tapped = true // e.g. Worn Powerstone (cast, enters tapped)
    fireEntersTriggers(state, obj.id)
  } else {
    moveToGraveyard(state, obj.id)
  }
  checkSBA(state)
}

/**
 * Fire every enters-the-battlefield trigger that responds to `subjectId` entering:
 * the subject's own ETB (plain `enters`) plus any battlefield permanent watching
 * "another/any creature enters" (Soul Warden). Each is put on the stack / pends
 * for a target via `triggerEnters`.
 */
export function fireEntersTriggers(state: RulesGameState, subjectId: ObjId) {
  const subject = state.objects[subjectId]
  if (!subject) return
  const subjectIsCreature = defIsCreature(getDef(subject.defName))
  for (const pid of state.turnOrder) {
    for (const id of [...state.zones.perPlayer[pid]!.battlefield]) {
      const p = state.objects[id]
      const ab = p && getDef(p.defName).enters
      if (!p || !ab) continue
      const isSelf = p.id === subjectId
      const w = ab.watch
      const fires = !w
        ? isSelf // plain ETB
        : subjectIsCreature &&
          !(w.excludeSelf && isSelf) &&
          !(w.controllerOnly && subject.controllerId !== p.controllerId)
      if (fires) triggerEnters(state, p.id, p.defName, p.controllerId)
    }
  }
}

/** An enters-the-battlefield trigger: non-targeted → straight on the stack; targeted →
 *  pending target choice (removed instead if no legal target exists, CR 603.3c). */
function triggerEnters(state: RulesGameState, sourceId: ObjId, defName: string, controllerId: PlayerId) {
  const def = getDef(defName)
  const specs = flattenSpecs(def.enters?.targets)
  if (!specs.length) {
    state.zones.stack.push({ id: mintCardId(), kind: 'ability', trigger: 'etb', controllerId, defName, sourceId, abilityIndex: null, targets: [] })
    logLine(state, `${def.name}'s enters-the-battlefield ability triggers.`)
    return
  }
  if (!specs.every((spec) => hasAnyLegalTarget(state, spec, controllerId))) {
    logLine(state, `${def.name}'s trigger has no legal target and is removed.`)
    return
  }
  state.pending = { kind: 'trigger', player: controllerId }
  state.pendingTrigger = { sourceId, defName, controllerId, trigger: 'etb' }
  logLine(state, `${def.name}'s enters-the-battlefield ability triggers — ${name(state, controllerId)} chooses a target.`)
}

// ---------- targeting ----------

function flattenSpecs(specs?: TargetSpec[]): TargetSpec[] {
  const out: TargetSpec[] = []
  for (const spec of specs ?? []) for (let i = 0; i < spec.count; i++) out.push(spec)
  return out
}
function flattenTargetSpecs(def: CardDefinition): TargetSpec[] {
  return flattenSpecs(def.spell?.targets)
}

/** Prototype-safe "is this id a permanent on the battlefield?" (any permanent type). */
function isPermanentOnBattlefield(state: RulesGameState, t: ObjId | PlayerId): boolean {
  return Object.hasOwn(state.objects, t) && state.objects[t as ObjId]!.zone === 'battlefield'
}

/** Does `obj` satisfy `spec.filter` (types/subtypes/controller) for the targeting player? */
function matchesFilter(state: RulesGameState, obj: GameObject, filter: TargetFilter | undefined, byController: PlayerId): boolean {
  if (!filter) return true
  const def = getDef(obj.defName)
  if (filter.types && !filter.types.some((t) => def.types.includes(t))) return false
  if (filter.excludeTypes && filter.excludeTypes.some((t) => def.types.includes(t))) return false
  if (filter.subtypes && !filter.subtypes.some((st) => def.subtypes?.includes(st) ?? false)) return false
  if (filter.controller === 'you' && obj.controllerId !== byController) return false
  if (filter.controller === 'opponent' && obj.controllerId === byController) return false
  return true
}

/** Is there at least one legal target for `spec` right now? (drives CR 603.3c trigger removal + client castability) */
export function hasAnyLegalTarget(state: RulesGameState, spec: TargetSpec, byController: PlayerId): boolean {
  if (spec.kind === 'spell') return state.zones.stack.some((s) => s.kind === 'spell')
  if (spec.kind === 'player' || spec.kind === 'anyTarget') return alivePlayers(state).length > 0
  // creature / permanent (possibly filtered): scan battlefield for a legal target
  for (const pid of state.turnOrder)
    for (const id of state.zones.perPlayer[pid]!.battlefield)
      if (isLegalTarget(state, spec, id, byController)) return true
  return false
}

function isLegalTarget(state: RulesGameState, spec: TargetSpec, t: ObjId | PlayerId, byController: PlayerId): boolean {
  if (spec.kind === 'spell') return state.zones.stack.some((s) => s.kind === 'spell' && s.id === (t as ObjId))
  // Object.hasOwn (not `in`) so prototype keys can't masquerade as players
  const isPlayer = Object.hasOwn(state.players, t) && !state.players[t as PlayerId]!.hasLost
  // isCreatureOnBattlefield already guards prototype keys (real object + zone check)
  const isCreature = isCreatureOnBattlefield(state, t)
  const isPermanent = isPermanentOnBattlefield(state, t)
  // hexproof: a permanent can't be targeted by its controller's opponents
  if (isPermanent) {
    const obj = state.objects[t as ObjId]!
    if (obj.controllerId !== byController && currentKeywords(state, obj).includes('hexproof')) return false
  }
  if (spec.kind === 'player') return isPlayer
  if (spec.kind === 'creature')
    return isCreature && matchesFilter(state, state.objects[t as ObjId]!, spec.filter, byController)
  if (spec.kind === 'permanent')
    return isPermanent && matchesFilter(state, state.objects[t as ObjId]!, spec.filter, byController)
  return isPlayer || isCreature // anyTarget
}

// ---------- player actions ----------

function requirePriority(state: RulesGameState, actor: PlayerId) {
  if (state.status === 'ended') throw new RulesError('GAME_ENDED', 'The game is over')
  if (state.pending) throw new RulesError('PENDING', `Waiting for ${name(state, state.pending.player)}'s ${state.pending.kind}`)
  if (state.priorityPlayer !== actor) throw new RulesError('NO_PRIORITY', "You don't have priority")
}

function requireInHand(state: RulesGameState, actor: PlayerId, objId: ObjId) {
  const obj = state.objects[objId]
  if (!obj || obj.zone !== 'hand' || obj.ownerId !== actor)
    throw new RulesError('NOT_IN_HAND', 'That card is not in your hand')
  return obj
}

const isMainPhase = (state: RulesGameState) => state.step === 'main1' || state.step === 'main2'

export function applyRulesAction(state: RulesGameState, actor: PlayerId, msg: RulesMsgT) {
  if (state.status === 'ended' && msg.type !== 'r.concede')
    throw new RulesError('GAME_ENDED', 'The game is over')
  if (!state.players[actor]) throw new RulesError('NOT_SEATED', 'You are not in this game')
  if (state.players[actor]!.hasLost) throw new RulesError('LOST', 'You are out of the game')
  // during the mulligan phase only mulligan/keep/concede are legal
  if (state.status === 'mulligans' && msg.type !== 'r.mulligan' && msg.type !== 'r.keep' && msg.type !== 'r.concede')
    throw new RulesError('MULLIGANS', 'Keep or mulligan your opening hand first')

  switch (msg.type) {
    case 'r.pass': {
      requirePriority(state, actor)
      state.passed.push(actor)
      const order = apnapOrder(state, state.activePlayer)
      if (order.every((p) => state.passed.includes(p))) {
        state.priorityPlayer = null
        if (state.zones.stack.length) resolveTop(state)
        else if (state.step === 'cleanup') finishCleanup(state)
        else nextStep(state)
      } else {
        // CR 117.4: priority continues to the next living, not-yet-passed player
        // to the LEFT of the passer — not back to the active player
        state.priorityPlayer =
          nextInTurnOrder(state, actor, (p) => !state.players[p]!.hasLost && !state.passed.includes(p)) ?? null
      }
      break
    }

    case 'r.playLand': {
      requirePriority(state, actor)
      if (actor !== state.activePlayer || !isMainPhase(state) || state.zones.stack.length)
        throw new RulesError('TIMING', 'Lands are played in your main phase with an empty stack')
      const p = state.players[actor]!
      if (p.landsPlayedThisTurn >= 1) throw new RulesError('LAND_LIMIT', 'Already played a land this turn')
      const obj = requireInHand(state, actor, msg.objId)
      if (!defIsLand(getDef(obj.defName))) throw new RulesError('NOT_A_LAND', 'That is not a land')
      moveTo(state, obj.id, 'battlefield')
      if (getDef(obj.defName).entersTapped) obj.tapped = true // e.g. a Guildgate
      p.landsPlayedThisTurn++
      state.passed = []
      logLine(state, `${name(state, actor)} plays ${objName(state, obj.id)}${obj.tapped ? ' (tapped)' : ''}.`)
      fireEntersTriggers(state, obj.id) // ETB lands (e.g. scry Temples) trigger on being played
      break
    }

    case 'r.tapMana': {
      requirePriority(state, actor)
      const obj = state.objects[msg.objId]
      if (!obj || obj.zone !== 'battlefield' || obj.controllerId !== actor)
        throw new RulesError('NOT_YOURS', "You don't control that permanent")
      if (state.loseAbilities.includes(obj.id)) throw new RulesError('NO_MANA_ABILITY', 'That permanent has lost all abilities')
      const ability = getDef(obj.defName).abilities?.find((a) => a.kind === 'activated' && a.isMana)
      if (!ability) throw new RulesError('NO_MANA_ABILITY', 'No mana ability')
      // only {T} mana abilities (with an OPTIONAL mana cost, e.g. Signets' {1});
      // a cost-free untapped ability would be activatable unboundedly (infinite mana)
      if (!ability.cost.tap) throw new RulesError('UNSUPPORTED', 'Only {T} mana abilities are supported')
      if (obj.tapped) throw new RulesError('TAPPED', 'Already tapped')
      // a creature's {T} mana ability (mana dork) still needs it to not be summoning sick (CR 302.6)
      if (defIsCreature(getDef(obj.defName)) && obj.summoningSick && !hasKw(state, obj.id, 'haste'))
        throw new RulesError('SUMMONING_SICK', `${objName(state, obj.id)} can't tap for mana yet`)
      const produces = ability.produces ?? []
      // colour CHOICE (guildgate/dork/rock): validate the choice up front
      if (ability.chooseColor && (!msg.color || !produces.includes(msg.color)))
        throw new RulesError('CHOOSE_COLOR', `Choose which colour (${produces.join('/')})`)
      // pay the ability's own mana cost first (e.g. a Signet's {1}) — atomic: throws before tapping
      if (ability.cost.mana) {
        const cost = parseManaCost(ability.cost.mana)
        const pool = state.players[actor]!.manaPool
        const payment = planPayment(cost, pool)
        if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      }
      obj.tapped = true
      if (ability.chooseColor) state.players[actor]!.manaPool[msg.color!]++
      else ability.effect({ state, controllerId: actor, sourceId: obj.id, targets: [] }) // fixed output
      // activating an ability is an action: the pass chain restarts (CR 116.4)
      state.passed = []
      break
    }

    case 'r.activate': {
      requirePriority(state, actor)
      const obj = state.objects[msg.objId]
      if (!obj || obj.zone !== 'battlefield' || obj.controllerId !== actor)
        throw new RulesError('NOT_YOURS', "You don't control that permanent")
      if (state.loseAbilities.includes(obj.id)) throw new RulesError('NO_ABILITY', 'That permanent has lost all abilities')
      const ability = getDef(obj.defName).abilities?.[msg.abilityIndex]
      if (!ability || ability.kind !== 'activated' || ability.isMana)
        throw new RulesError('NO_ABILITY', 'No such activated ability')
      if (ability.cost.tap) {
        if (obj.tapped) throw new RulesError('TAPPED', 'Already tapped')
        // a creature's {T} ability needs it to have been under control since your
        // last turn (CR 302.6) — unless it has haste
        if (defIsCreature(getDef(obj.defName)) && obj.summoningSick && !hasKw(state, obj.id, 'haste'))
          throw new RulesError('SUMMONING_SICK', `${objName(state, obj.id)} can't use a tap ability yet`)
      }
      // validate the sacrifice cost (if any) BEFORE mutating anything — the
      // creatures are actually sacrificed AFTER the ability is on the stack, so
      // their dies triggers land above it and resolve first (CR 603.3b ordering)
      const sacCost = ability.cost.sacrifice
      const sacIds = sacCost ? [...new Set(msg.sacrifices ?? [])] : []
      if (sacCost) {
        if (sacIds.length !== sacCost.count)
          throw new RulesError('BAD_SACRIFICE', `Sacrifice exactly ${sacCost.count} creature${sacCost.count === 1 ? '' : 's'}`)
        for (const id of sacIds) {
          const s = state.objects[id]
          if (!s || s.zone !== 'battlefield' || s.controllerId !== actor || !defIsCreature(getDef(s.defName)))
            throw new RulesError('BAD_SACRIFICE', 'Not a creature you control')
        }
      }
      // pay the mana part of the cost (only {T} + generic/colored mana supported)
      if (ability.cost.mana) {
        const cost = parseManaCost(ability.cost.mana)
        const pool = state.players[actor]!.manaPool
        const payment = planPayment(cost, pool)
        if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      }
      // targets chosen now (like casting)
      const specs = flattenSpecs(ability.targets)
      if (msg.targets.length !== specs.length)
        throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
      msg.targets.forEach((t, i) => {
        if (!isLegalTarget(state, specs[i]!, t, actor)) throw new RulesError('BAD_TARGETS', 'Illegal target')
      })
      if (ability.cost.tap) obj.tapped = true
      state.zones.stack.push({
        id: mintCardId(),
        kind: 'ability',
        abilityIndex: msg.abilityIndex,
        controllerId: actor,
        defName: obj.defName,
        sourceId: obj.id,
        targets: [...msg.targets],
      })
      logLine(state, `${name(state, actor)} activates ${objName(state, obj.id)}'s ability.`)
      // pay the sacrifice cost now (after the ability is on the stack): dies
      // triggers push above it and resolve first
      for (const id of sacIds) {
        logLine(state, `${name(state, actor)} sacrifices ${objName(state, id)}.`)
        moveToGraveyard(state, id)
      }
      grantPriority(state, actor) // CR 116.4: caster/activator keeps priority; pass chain restarts
      break
    }

    case 'r.cast': {
      requirePriority(state, actor)
      // castable from your hand, or your commander from the command zone
      const candidate = state.objects[msg.objId]
      const fromCommand =
        !!candidate && candidate.zone === 'command' && candidate.ownerId === actor && candidate.isCommander
      const obj = fromCommand ? candidate! : requireInHand(state, actor, msg.objId)
      const def = getDef(obj.defName)
      if (defIsLand(def)) throw new RulesError('IS_A_LAND', 'Lands are played, not cast')
      const instantSpeed = def.types.includes('Instant') || hasKw(state, obj.id, 'flash')
      if (!instantSpeed && (actor !== state.activePlayer || !isMainPhase(state) || state.zones.stack.length))
        throw new RulesError('TIMING', 'That can only be cast in your main phase with an empty stack')

      const specs = flattenTargetSpecs(def)
      if (msg.targets.length !== specs.length)
        throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
      msg.targets.forEach((t, i) => {
        if (!isLegalTarget(state, specs[i]!, t, actor)) throw new RulesError('BAD_TARGETS', 'Illegal target')
      })

      const cost = parseManaCost(def.manaCost)
      if (fromCommand) cost.generic += 2 * state.players[actor]!.commanderTax // commander tax (CR 903.8)
      const payment = planPayment(cost, state.players[actor]!.manaPool)
      if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      const pool = state.players[actor]!.manaPool
      for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]

      pullFromCurrentZone(state, obj)
      obj.zone = 'stack'
      if (fromCommand) state.players[actor]!.commanderTax++
      state.zones.stack.push({
        id: obj.id,
        kind: 'spell',
        controllerId: actor,
        defName: obj.defName,
        sourceId: obj.id,
        abilityIndex: null,
        targets: msg.targets,
      })
      const targetNames = msg.targets.map((t) =>
        Object.hasOwn(state.players, t) ? name(state, t as PlayerId) : objName(state, t as ObjId),
      )
      logLine(
        state,
        `${name(state, actor)} casts ${def.name}${fromCommand ? ' from the command zone' : ''}${targetNames.length ? ` targeting ${targetNames.join(', ')}` : ''}.`,
      )
      // caster receives priority again (rule 601.2i / 117.3c)
      grantPriority(state, actor)
      break
    }

    case 'r.attackers': {
      if (state.pending?.kind !== 'attackers' || state.pending.player !== actor)
        throw new RulesError('NOT_PENDING', 'Not waiting for your attackers')
      const seenAttackers = new Set<ObjId>()
      const opponents = opponentsOf(state, actor)
      for (const { attackerId, defenderId } of msg.attacks) {
        if (seenAttackers.has(attackerId)) throw new RulesError('BAD_ATTACKER', 'A creature attacks once')
        seenAttackers.add(attackerId)
        const obj = state.objects[attackerId]
        if (!obj || obj.zone !== 'battlefield' || obj.controllerId !== actor || !defIsCreature(getDef(obj.defName)))
          throw new RulesError('BAD_ATTACKER', 'Not a creature you control')
        if (obj.tapped) throw new RulesError('BAD_ATTACKER', `${objName(state, attackerId)} is tapped`)
        if (obj.summoningSick && !hasKw(state, attackerId, 'haste'))
          throw new RulesError('BAD_ATTACKER', `${objName(state, attackerId)} has summoning sickness`)
        if (hasKw(state, attackerId, 'defender'))
          throw new RulesError('BAD_ATTACKER', `${objName(state, attackerId)} has defender and can't attack`)
        if (!opponents.includes(defenderId))
          throw new RulesError('BAD_ATTACKER', 'You can only attack an opponent still in the game')
      }
      state.pending = null
      if (!msg.attacks.length) {
        // the priority round of declare_attackers still happens; nextStep will
        // skip declare_blockers + combat_damage (CR 508.8)
        logLine(state, `${name(state, actor)} declares no attackers.`)
        grantPriority(state, actor)
        break
      }
      state.attackersDeclaredThisCombat = true
      for (const { attackerId, defenderId } of msg.attacks) {
        const obj = state.objects[attackerId]!
        if (!hasKw(state, attackerId, 'vigilance')) obj.tapped = true // vigilance: stays untapped
        obj.attackingDefender = defenderId
      }
      logLine(
        state,
        `${name(state, actor)} attacks: ${msg.attacks
          .map((a) => `${objName(state, a.attackerId)} → ${name(state, a.defenderId)}`)
          .join(', ')}.`,
      )
      grantPriority(state, actor)
      break
    }

    case 'r.blockers': {
      if (state.pending?.kind !== 'blockers' || state.pending.player !== actor)
        throw new RulesError('NOT_PENDING', 'Not waiting for your blockers')
      const seen = new Set<ObjId>()
      for (const { blockerId, attackerId } of msg.blocks) {
        if (seen.has(blockerId)) throw new RulesError('BAD_BLOCKER', 'A creature can block only one attacker')
        seen.add(blockerId)
        const blocker = state.objects[blockerId]
        if (!blocker || blocker.zone !== 'battlefield' || blocker.controllerId !== actor || !defIsCreature(getDef(blocker.defName)))
          throw new RulesError('BAD_BLOCKER', 'Not a creature you control')
        if (blocker.tapped) throw new RulesError('BAD_BLOCKER', `${objName(state, blockerId)} is tapped`)
        const attacker = state.objects[attackerId]
        if (!attacker || attacker.attackingDefender !== actor)
          throw new RulesError('BAD_BLOCKER', 'That creature is not attacking you')
        // evasion: only flyers/reach may block a flyer (CR 509.1b)
        if (hasKw(state, attackerId, 'flying') && !hasKw(state, blockerId, 'flying') && !hasKw(state, blockerId, 'reach'))
          throw new RulesError('BAD_BLOCKER', `${objName(state, blockerId)} can't block a flyer`)
      }
      // menace: an attacker must be blocked by two or more creatures (CR 509.1c)
      const blockerCount = new Map<ObjId, number>()
      for (const { attackerId } of msg.blocks) blockerCount.set(attackerId, (blockerCount.get(attackerId) ?? 0) + 1)
      for (const [attackerId, n] of blockerCount)
        if (n === 1 && hasKw(state, attackerId, 'menace'))
          throw new RulesError('BAD_BLOCKER', `${objName(state, attackerId)} has menace — it needs two or more blockers`)
      state.pending = null
      for (const { blockerId, attackerId } of msg.blocks) {
        state.objects[blockerId]!.blockingAttackerId = attackerId
        ;(state.blockOrders[attackerId] ??= []).push(blockerId)
      }
      logLine(
        state,
        msg.blocks.length
          ? `${name(state, actor)} blocks with ${msg.blocks.map((b) => objName(state, b.blockerId)).join(', ')}.`
          : `${name(state, actor)} declares no blockers.`,
      )
      state.blockersDone.push(actor)
      advanceBlockersQueue(state) // next attacked defender declares, or AP gets priority
      break
    }

    case 'r.discard': {
      if (state.pending?.kind !== 'discard' || state.pending.player !== actor)
        throw new RulesError('NOT_PENDING', 'Not waiting for your discard')
      const hand = zoneArr(state, actor, 'hand')
      const need = hand.length - 7
      const ids = [...new Set(msg.objIds)]
      if (ids.length !== need) throw new RulesError('BAD_DISCARD', `Discard exactly ${need}`)
      for (const id of ids)
        if (!hand.includes(id)) throw new RulesError('BAD_DISCARD', 'Not in your hand')
      for (const id of ids) moveToGraveyard(state, id)
      logLine(state, `${name(state, actor)} discards ${ids.length} card${ids.length > 1 ? 's' : ''}.`)
      finishCleanup(state)
      break
    }

    case 'r.scry': {
      if (state.pending?.kind !== 'scry' || state.pending.player !== actor || !state.pendingScry)
        throw new RulesError('NOT_PENDING', 'Not waiting for your scry')
      const ps = state.pendingScry
      const bottom = [...new Set(msg.toBottom)]
      for (const id of bottom) if (!ps.cardIds.includes(id)) throw new RulesError('BAD_SCRY', 'Not among the scried cards')
      const lib = zoneArr(state, actor, 'library')
      // remove the scried cards from the top, then re-place: kept on top (original
      // relative order), bottomed cards at the bottom
      const kept = ps.cardIds.filter((id) => !bottom.includes(id))
      for (const id of ps.cardIds) {
        const i = lib.indexOf(id)
        if (i >= 0) lib.splice(i, 1)
      }
      lib.unshift(...kept)
      lib.push(...bottom)
      remintLibrary(state, actor) // end the peek so post-scry ids can't be tracked
      state.pending = null
      state.pendingScry = null
      logLine(state, `${name(state, actor)} keeps ${kept.length} on top, puts ${bottom.length} on the bottom.`)
      grantPriority(state, actor)
      break
    }

    case 'r.search': {
      if (state.pending?.kind !== 'search' || state.pending.player !== actor || !state.pendingSearch)
        throw new RulesError('NOT_PENDING', 'Not waiting for your search')
      const ps = state.pendingSearch
      const chosen = [...new Set(msg.cardIds)]
      if (chosen.length > ps.count) throw new RulesError('BAD_SEARCH', `Choose at most ${ps.count}`)
      for (const id of chosen) if (!ps.matchIds.includes(id)) throw new RulesError('BAD_SEARCH', 'Not among the matches')
      for (const id of chosen) {
        const obj = state.objects[id]
        if (!obj) continue
        if (ps.dest === 'battlefield') {
          obj.controllerId = actor
          obj.summoningSick = defIsCreature(getDef(obj.defName))
          moveTo(state, id, 'battlefield')
          if (ps.tapped) obj.tapped = true
          fireEntersTriggers(state, id)
        } else if (obj.isCommander) {
          moveTo(state, id, 'command') // a commander never enters a hidden hand
        } else {
          moveTo(state, id, 'hand')
          remintForHiddenEntry(state, id, true) // library→hand: fresh id (invariant #3)
        }
      }
      // shuffle + re-mint the whole library so the peeked ids can't be tracked
      shuffleInPlace(zoneArr(state, actor, 'library'))
      remintLibrary(state, actor)
      state.pendingSearch = null
      // a fetched permanent's targeted ETB may have set its own pending — don't clobber it
      if (state.pending?.kind === 'search') {
        state.pending = null
        grantPriority(state, actor)
      }
      logLine(state, `${name(state, actor)} found ${chosen.length} card${chosen.length === 1 ? '' : 's'} and shuffles.`)
      checkSBA(state)
      break
    }

    case 'r.sacrifice': {
      if (state.pending?.kind !== 'sacrifice' || state.pending.player !== actor || !state.pendingSacrifice)
        throw new RulesError('NOT_PENDING', 'Not waiting for your sacrifice')
      const ps = state.pendingSacrifice
      const chosen = [...new Set(msg.objIds)]
      // validate against the CURRENT board (intersected with the prompt snapshot),
      // never the pinned snapshot alone: a manual override (r.mMove) can bounce a
      // candidate to hand and re-mint its id between prompt and choice, which would
      // otherwise make the sacrifice unsatisfiable and wedge the game. Recomputing
      // live self-heals — sacrifice all you have if fewer than `count` remain.
      const live = new Set(battlefieldCreatures(state, actor).map((c) => c.id))
      const valid = ps.candidateIds.filter((id) => live.has(id))
      const need = Math.min(ps.count, valid.length)
      if (chosen.length !== need)
        throw new RulesError('BAD_SACRIFICE', `Sacrifice exactly ${need} creature${need === 1 ? '' : 's'}`)
      for (const id of chosen)
        if (!valid.includes(id)) throw new RulesError('BAD_SACRIFICE', 'Not among your creatures')
      for (const id of chosen) {
        logLine(state, `${name(state, actor)} sacrifices ${objName(state, id)}.`)
        moveToGraveyard(state, id) // fires dies triggers
      }
      advanceSacrificeQueue(state)
      break
    }

    case 'r.chooseTargets': {
      if (state.pending?.kind !== 'trigger' || state.pending.player !== actor || !state.pendingTrigger)
        throw new RulesError('NOT_PENDING', 'Not waiting for your target choice')
      const pt = state.pendingTrigger
      const def = getDef(pt.defName)
      const specs = flattenSpecs(abilityFor(def, pt.trigger)?.targets)
      if (msg.targets.length !== specs.length)
        throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
      msg.targets.forEach((t, i) => {
        if (!isLegalTarget(state, specs[i]!, t, actor)) throw new RulesError('BAD_TARGETS', 'Illegal target')
      })
      state.zones.stack.push({
        id: mintCardId(),
        kind: 'ability',
        trigger: pt.trigger,
        controllerId: pt.controllerId,
        defName: pt.defName,
        sourceId: pt.sourceId,
        abilityIndex: null,
        targets: [...msg.targets],
      })
      const tnames = msg.targets.map((t) => (Object.hasOwn(state.players, t) ? name(state, t as PlayerId) : objName(state, t as ObjId)))
      logLine(state, `${def.name} targets ${tnames.join(', ')}.`)
      state.pending = null
      state.pendingTrigger = null
      grantPriority(state, state.activePlayer)
      break
    }

    // ---- manual overrides (assisted table) ----
    // Cockatrice-style freedom for the parts the engine can't run: allowed any
    // time the game is active, only on your OWN objects, and never touch the
    // engine's turn/priority/stack machinery. They don't consume priority.
    case 'r.mMove': {
      const obj = state.objects[msg.objId]
      if (!obj || (obj.ownerId !== actor && obj.controllerId !== actor))
        throw new RulesError('NOT_YOURS', 'Not your card')
      if (obj.zone === 'library')
        throw new RulesError('USE_DRAW', 'Move from the library with Draw, not by hand (library order is secret)')
      const fromPublic = obj.zone !== 'hand' // (library already refused above)
      // a commander never enters a hidden zone (its stable id is broadcast as
      // commanderId, and it's exempt from re-mint) — reroute it to the command zone
      const dest = obj.isCommander && (msg.zone === 'hand' || msg.zone === 'library') ? 'command' : msg.zone
      moveTo(state, obj.id, dest, { top: msg.pos === 'top' })
      remintForHiddenEntry(state, obj.id, fromPublic)
      logLine(state, `${name(state, actor)} manually moves a card to ${dest}.`)
      checkSBA(state) // the move may change a creature's effective toughness (e.g. an anthem left)
      break
    }
    case 'r.mLife': {
      state.players[actor]!.life += msg.delta
      logLine(state, `${name(state, actor)} sets life to ${state.players[actor]!.life} (manual).`)
      checkSBA(state)
      break
    }
    case 'r.mMana': {
      const pool = state.players[actor]!.manaPool
      pool[msg.color] = Math.max(0, pool[msg.color] + msg.delta)
      break
    }
    case 'r.mTap': {
      const obj = state.objects[msg.objId]
      if (!obj || obj.zone !== 'battlefield' || obj.controllerId !== actor)
        throw new RulesError('NOT_YOURS', "You don't control that permanent")
      obj.tapped = msg.tapped
      break
    }
    case 'r.mDraw': {
      const lib = zoneArr(state, actor, 'library')
      const n = Math.min(msg.n, lib.length)
      for (let i = 0; i < n; i++) moveTo(state, lib[0]!, 'hand')
      logLine(state, `${name(state, actor)} draws ${n} (manual).`)
      break
    }
    case 'r.mToken': {
      const defName = registerToken(msg)
      const id = mintCardId()
      state.objects[id] = {
        id,
        defName,
        ownerId: actor,
        controllerId: actor,
        zone: 'battlefield',
        tapped: false,
        summoningSick: true,
        damageMarked: 0,
        counters: {},
        isCommander: false,
        attackingDefender: null,
        blockingAttackerId: null,
      }
      zoneArr(state, actor, 'battlefield').push(id)
      logLine(state, `${name(state, actor)} creates a ${msg.name} token.`)
      break
    }
    case 'r.mCounter': {
      const obj = state.objects[msg.objId]
      if (!obj || obj.zone !== 'battlefield' || obj.controllerId !== actor)
        throw new RulesError('NOT_YOURS', "You don't control that permanent")
      obj.counters[msg.name] = Math.max(0, (obj.counters[msg.name] ?? 0) + msg.delta)
      if (obj.counters[msg.name] === 0) delete obj.counters[msg.name]
      checkSBA(state) // -1/-1 counters can be lethal; +1/+1 & -1/-1 annihilate (704.5q)
      break
    }

    // ---- London mulligan (pre-game) ----
    case 'r.mulligan': {
      const p = state.players[actor]!
      if (p.keptHand) throw new RulesError('KEPT', 'You already kept your hand')
      const hand = zoneArr(state, actor, 'hand')
      const lib = zoneArr(state, actor, 'library')
      while (hand.length) {
        const id = hand.pop()!
        state.objects[id]!.zone = 'library'
        lib.push(id)
      }
      shuffleInPlace(lib)
      remintLibrary(state, actor) // ids that were in hand must not be trackable once hidden
      for (let i = 0; i < 7 && lib.length; i++) drawOne(state, actor)
      p.mullCount++
      logLine(state, `${name(state, actor)} mulligans (will keep ${Math.max(0, 7 - p.mullCount)}, mulligan #${p.mullCount}).`)
      break
    }
    case 'r.keep': {
      const p = state.players[actor]!
      if (p.keptHand) throw new RulesError('KEPT', 'You already kept your hand')
      const hand = zoneArr(state, actor, 'hand')
      const need = Math.min(p.mullCount, hand.length)
      const ids = [...new Set(msg.toBottom)]
      if (ids.length !== need)
        throw new RulesError('BAD_BOTTOM', `Put exactly ${need} card${need === 1 ? '' : 's'} on the bottom`)
      for (const id of ids) if (!hand.includes(id)) throw new RulesError('BAD_BOTTOM', 'Not in your hand')
      const lib = zoneArr(state, actor, 'library')
      for (const id of ids) {
        hand.splice(hand.indexOf(id), 1)
        state.objects[id]!.zone = 'library'
        lib.push(id) // bottom of the library (index 0 is the top)
      }
      remintLibrary(state, actor)
      p.keptHand = true
      logLine(state, `${name(state, actor)} keeps ${hand.length} card${hand.length === 1 ? '' : 's'}.`)
      break
    }

    case 'r.concede': {
      if (state.status === 'ended') return // no-op after the game is over
      state.players[actor]!.hasLost = true
      logLine(state, `${name(state, actor)} concedes.`)
      checkSBA(state) // flags + 800.4a removal + possible game end
      // repairControlFlow (below) unwedges any pending/priority the leaver held
      break
    }
  }

  // if this action removed the player who owed a decision or held priority,
  // hand control off so the remaining players can continue (multiplayer).
  repairControlFlow(state)
  maybeFinishMulligans(state) // start the game once every remaining player has kept
  state.seq++
}
