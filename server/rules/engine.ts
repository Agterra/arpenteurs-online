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
import { currentKeywords, currentPower, currentToughness, hostCantAttack, hostCantBlock } from './characteristics'
import { STEPS } from '#shared/rules/types'
import type { RulesMsgT } from '#shared/rules/messages'
import { parseManaCost, planPayment } from '#shared/utils/manaCost'
import { getDef, isTokenDefName, registerToken } from './cards/registry'
import { mintCardId, shuffleInPlace } from '../game/rng'
import { defIsAura, defIsCreature, defIsEquipment, defIsLand, defIsPermanent, defIsSaga, type CardDefinition, type TargetSpec, type TargetFilter } from './cards/dsl'
import type { Keyword, ManaColor } from '#shared/rules/types'
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
/**
 * CR 402.2 exception — does this player control a permanent granting "you have no maximum hand
 * size" (Reliquary Tower, Thought Vessel)? Checked live at cleanup, so it follows the permanent.
 */
const hasNoMaxHandSize = (state: RulesGameState, player: PlayerId) =>
  zoneArr(state, player, 'battlefield').some((id) => getDef(state.objects[id]!.defName).noMaxHandSize)

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
      // CR 704.5q: ±1/+1 / -1/-1 counters annihilate
      const plus = obj.counters['+1/+1'] ?? 0
      const minus = obj.counters['-1/-1'] ?? 0
      if (plus > 0 && minus > 0) {
        const n = Math.min(plus, minus)
        setCounter(obj, '+1/+1', plus - n)
        setCounter(obj, '-1/-1', minus - n)
        changed = true
      }
      // CR 714.4: sacrifice a Saga once its lore counters ≥ its final chapter AND no chapter of it
      // is still on the stack / awaiting a target (folded into this scan to avoid a second pass —
      // `lore` is only set on Sagas, so the fast path is a single map read for every other object)
      if (obj.counters.lore) {
        const def = getDef(obj.defName)
        if (defIsSaga(def) && !def.unimplemented && obj.counters.lore >= def.saga!.chapters.length) {
          const chapterPending =
            state.zones.stack.some((s) => s.sagaChapter != null && s.sourceId === obj.id) ||
            (state.pendingTrigger?.sagaChapter != null && state.pendingTrigger.sourceId === obj.id)
          if (!chapterPending) {
            logLine(state, `${def.name} is sacrificed (final chapter complete).`)
            moveToGraveyard(state, obj.id)
            changed = true
          }
        }
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
    // CR 704.5d: a token in a zone other than the battlefield ceases to exist. Its
    // dies/leaves-the-battlefield triggers are already on the stack (queued by
    // moveToGraveyard before the move, using last-known info), so removing the object
    // now is safe. Without this, a dead token lingers forever in the graveyard — and
    // graveyard recursion could return it to hand and re-cast it for free.
    for (const obj of Object.values(state.objects)) {
      if (obj.zone === 'battlefield' || !isTokenDefName(obj.defName)) continue
      pullFromCurrentZone(state, obj)
      delete state.objects[obj.id]
      changed = true
    }
    // CR 704.5m/n: an Aura attached to nothing (or an illegal host) is put into its
    // owner's graveyard; Equipment whose host is gone simply becomes unattached.
    for (const obj of Object.values(state.objects)) {
      if (obj.zone !== 'battlefield') continue
      const def = getDef(obj.defName)
      // assisted table: never auto-destroy/auto-unattach an UNIMPLEMENTED aura/equipment
      // (its real rules are hand-run) — mirrors the creature-death SBA guard above
      if (def.unimplemented) continue
      // Bestow (CR 702.103d): a bestowed permanent whose enchanted creature is gone stops being an
      // Aura and becomes a creature (it stays on the battlefield, unattached).
      if (obj.bestowed) {
        if (obj.attachedTo == null || !isCreatureOnBattlefield(state, obj.attachedTo)) {
          obj.bestowed = false
          obj.attachedTo = null
          logLine(state, `${def.name} becomes a creature (its enchanted creature left).`)
          changed = true
        }
        continue
      }
      const isAura = defIsAura(def)
      if (!isAura && !defIsEquipment(def)) continue
      const host = obj.attachedTo ? state.objects[obj.attachedTo] : null
      const hostOk = !!host && host.zone === 'battlefield' && defIsCreature(getDef(host.defName))
      if (isAura && !hostOk) {
        logLine(state, `${def.name} is put into the graveyard (nothing to enchant).`)
        moveToGraveyard(state, obj.id)
        changed = true
      } else if (!isAura && obj.attachedTo && !hostOk) {
        obj.attachedTo = null // Equipment stays on the battlefield, just unattaches
        changed = true
      }
    }
    // CR 704.5i: a planeswalker with 0 loyalty is put into its owner's graveyard
    for (const obj of Object.values(state.objects)) {
      if (obj.zone !== 'battlefield') continue
      const def = getDef(obj.defName)
      if (def.unimplemented || !def.types.includes('Planeswalker')) continue // hand-run unknown PWs
      if ((obj.loyalty ?? 0) <= 0) {
        logLine(state, `${def.name} has no loyalty and is put into the graveyard.`)
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
      } else if (p.poison >= 10) {
        p.hasLost = true
        logLine(state, `${p.name} loses the game (10+ poison).`)
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

// ---------- forced discard (Mind Rot / each-player discards) ----------

/** Open a forced-discard prompt for the first player in `players` with cards in hand;
 *  the rest queue (each discards `count`). No-op if nobody has cards. */
export function openDiscard(state: RulesGameState, players: PlayerId[], count: number) {
  const queue = players.filter((pid) => !state.players[pid]!.hasLost && zoneArr(state, pid, 'hand').length > 0)
  if (!queue.length) return
  promptDiscard(state, queue[0]!, queue.slice(1), count)
}
function promptDiscard(state: RulesGameState, player: PlayerId, queue: PlayerId[], count: number) {
  state.pending = { kind: 'discard', player }
  state.pendingDiscard = { player, count, queue }
}
/** After a forced discard resolves, prompt the next queued player, else hand priority back. */
function advanceDiscardQueue(state: RulesGameState) {
  const rawQueue = state.pendingDiscard?.queue ?? []
  const count = state.pendingDiscard?.count ?? 1
  state.pending = null
  state.pendingDiscard = null
  const idx = rawQueue.findIndex((pid) => !state.players[pid]!.hasLost && zoneArr(state, pid, 'hand').length > 0)
  if (idx >= 0) {
    promptDiscard(state, rawQueue[idx]!, rawQueue.slice(idx + 1), count)
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
    const wardTriggeringId = state.pendingWard?.triggeringId
    const cascadeExiled = state.pendingCascade?.exiledIds
    state.pending = null
    state.pendingTrigger = null // a departed player's trigger is removed
    state.pendingScry = null
    state.pendingWard = null
    state.pendingCascade = null
    if (kind === 'ward') {
      // the payer left → they can't pay the ward → the triggering spell/ability is countered
      const item = wardTriggeringId ? state.zones.stack.find((s) => s.id === wardTriggeringId) : undefined
      if (item) counterStackItem(state, item)
      grantPriority(state, state.activePlayer)
    } else if (kind === 'cascade') {
      // the decider left → decline the free cast; bottom everything exiled
      if (cascadeExiled) bottomExiled(state, player, cascadeExiled)
      grantPriority(state, state.activePlayer)
    } else if (kind === 'blockers') {
      if (!state.blockersDone.includes(player)) state.blockersDone.push(player)
      advanceBlockersQueue(state)
    } else if (kind === 'discard') {
      // a FORCED discard (Mind Rot / each-player) must skip the leaver and prompt the
      // next queued player; only the cleanup discard ends the turn
      if (state.pendingDiscard) advanceDiscardQueue(state)
      else finishCleanup(state) // their hand left the game with them
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

/**
 * Phasing (CR 702.26 / 502.1). At the start of the active player's untap step, simultaneously:
 * their phased-OUT permanents phase in, and their permanents with `phasing` (currently phased in)
 * phase out. A permanent that phases out drags its attachments out with it (indirect phasing,
 * CR 702.26e), tracked via `phasedOutBy` so they phase back in only with that host. Phasing in/out
 * never counts as entering/leaving, so it fires no ETB/LTB and resets no summoning sickness.
 */
function runPhasing(state: RulesGameState, ap: PlayerId) {
  const all = Object.values(state.objects)
  // sets are disjoint (phased-out vs phased-in), so snapshotting isn't required, but compute both
  // from the current state before mutating to keep the "simultaneous" semantics obvious
  const phaseIn = all.filter((o) => o.phasedOut && o.phasedOutBy === undefined && o.controllerId === ap)
  const phaseOut = all.filter(
    (o) =>
      !o.phasedOut &&
      o.zone === 'battlefield' &&
      o.controllerId === ap &&
      currentKeywords(state, o).includes('phasing'),
  )
  for (const host of phaseIn) {
    host.phasedOut = false
    for (const att of all)
      if (att.phasedOutBy === host.id) {
        att.phasedOut = false
        att.phasedOutBy = undefined
      }
    logLine(state, `${objName(state, host.id)} phases in.`)
  }
  for (const host of phaseOut) {
    host.phasedOut = true
    for (const att of all)
      if (att.zone === 'battlefield' && att.attachedTo === host.id) {
        att.phasedOut = true
        att.phasedOutBy = host.id
      }
    logLine(state, `${objName(state, host.id)} phases out.`)
  }
}

function beginStep(state: RulesGameState) {
  if (state.status === 'ended') return
  const ap = state.activePlayer
  switch (state.step) {
    case 'untap': {
      const p = state.players[ap]!
      p.landsPlayedThisTurn = 0
      // CR 502.1 — phasing happens FIRST, before permanents untap
      runPhasing(state, ap)
      for (const obj of Object.values(state.objects)) {
        if (obj.zone === 'battlefield' && obj.controllerId === ap && !obj.phasedOut) {
          obj.tapped = false
          obj.summoningSick = false
          obj.loyaltyActivatedThisTurn = false // a new turn re-enables one loyalty ability per PW
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
          !hasKw(state, c.id, 'defender') &&
          !hostCantAttack(state, c), // e.g. Pacifism
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
        obj.attackingPwId = null
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
      if (hand.length > 7 && !hasNoMaxHandSize(state, ap)) {
        state.pending = { kind: 'discard', player: ap }
        return
      }
      finishCleanup(state)
      return
    }
    case 'upkeep': {
      fireUpkeepTriggers(state) // "at the beginning of your upkeep" triggers onto the stack
      advanceSuspend(state) // CR 702.62c/d: remove a time counter from each suspended card; cast at 0
      // a targeted upkeep trigger sets pending → its controller chooses first
      if (!state.pending) grantPriority(state, ap)
      return
    }
    case 'main1': {
      advanceSagas(state) // CR 714.3: "after your draw step" add a lore counter to each of AP's Sagas
      if (!state.pending) grantPriority(state, ap)
      return
    }
    default:
      // main1, begin_combat, main2, end — plain priority steps
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
  state.protectionGrants = []
  state.keywordGrants = []
  state.unblockable = []
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
    // an attacker aimed at a planeswalker deals its damage to that PW's loyalty, not
    // the defending player (and commander damage doesn't apply to a planeswalker)
    const dmgTarget = attacker.attackingPwId ?? attacker.attackingDefender
    const asCommander = attacker.attackingPwId ? undefined : attacker.isCommander ? attacker.id : undefined
    if (!wasBlocked) {
      hits.push({ source: attacker.id, target: dmgTarget, amount: power, fromCommander: asCommander })
      continue
    }
    const blockers = (state.blockOrders[attacker.id] ?? []).filter((b) => isCreatureOnBattlefield(state, b))
    // BANDING (CR 702.22h, defensive — faithful subset): if any blocker has banding, the DEFENDING
    // player assigns this attacker's combat damage. The deterministic optimal defence is to funnel
    // ALL of it onto the banding creature, sparing the rest of the block and negating trample
    // (excess is assigned, not trampled). Offensive banding + attacking-as-a-band are out of scope
    // (documented) — they need multi-attacker bands / an interactive assignment order this model lacks.
    const bandSink = blockers.find((b) => hasKw(state, b, 'banding'))
    if (bandSink) {
      hits.push({ source: attacker.id, target: bandSink, amount: power })
      continue
    }
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
      hits.push({ source: attacker.id, target: dmgTarget, amount: remaining, fromCommander: asCommander })
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
    let dealt = false // did this hit actually land on a valid recipient?
    const infect = hasKw(state, hit.source, 'infect')
    if (Object.hasOwn(state.players, hit.target)) {
      const victim = state.players[hit.target as PlayerId]!
      dealt = true
      if (infect) {
        // infect deals damage to players as poison counters, not life loss (CR 702.90b) — and
        // it is NOT commander damage
        victim.poison += hit.amount
        logLine(state, `${victim.name} gets ${hit.amount} poison counter${hit.amount === 1 ? '' : 's'} (${victim.poison} total).`)
      } else if (hit.fromCommander) {
        victim.life -= hit.amount
        victim.commanderDamage[hit.fromCommander] = (victim.commanderDamage[hit.fromCommander] ?? 0) + hit.amount
        logLine(state, `${victim.name} takes ${hit.amount} commander damage (${victim.commanderDamage[hit.fromCommander]} total).`)
      } else {
        victim.life -= hit.amount
        logLine(state, `${victim.name} takes ${hit.amount} combat damage.`)
      }
    } else if (isCreatureOnBattlefield(state, hit.target)) {
      const t = state.objects[hit.target as ObjId]!
      // protection from [colour]: prevent combat damage from a source of that colour (the D)
      const srcCols = state.objects[hit.source] ? getDef(state.objects[hit.source]!.defName).colors ?? [] : []
      if (protectionColorsOf(state, t).some((c) => srcCols.includes(c))) {
        logLine(state, `${getDef(t.defName).name} is protected — ${hit.amount} damage prevented.`)
      } else if (infect || hasKw(state, hit.source, 'wither')) {
        // wither/infect deal damage to creatures as -1/-1 counters (CR 702.90a / 702.79a)
        t.counters['-1/-1'] = (t.counters['-1/-1'] ?? 0) + hit.amount
        dealt = true
        if (deadly && hit.amount > 0) t.deathtouched = true
        logLine(state, `${getDef(t.defName).name} gets ${hit.amount} -1/-1 counter${hit.amount === 1 ? '' : 's'}.`)
      } else {
        t.damageMarked += hit.amount
        dealt = true
        if (deadly && hit.amount > 0) t.deathtouched = true
      }
    } else if (isPlaneswalkerOnBattlefield(state, hit.target)) {
      // combat damage to a planeswalker removes that much loyalty (CR 120.3c); SBA kills it at 0
      const pw = state.objects[hit.target as ObjId]!
      pw.loyalty = (pw.loyalty ?? 0) - hit.amount
      dealt = true
      logLine(state, `${getDef(pw.defName).name} loses ${hit.amount} loyalty (combat damage).`)
    }
    // lifelink: gain life ONLY for damage actually dealt — a target that left the
    // battlefield before this sub-step (e.g. a planeswalker killed by first strike)
    // receives none, so lifelink gains nothing (CR 119.3 / 702.15e)
    if (dealt && hit.amount > 0 && hasKw(state, hit.source, 'lifelink')) {
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
  return kind === 'dies' ? def.dies : kind === 'attacks' ? def.attacks : kind === 'upkeep' ? def.upkeep : def.enters
}

const TRIGGER_LABEL: Record<NonNullable<StackItem['trigger']>, string> = {
  etb: 'enters-the-battlefield',
  dies: 'dies',
  attacks: 'attacks',
  upkeep: 'upkeep',
}

/** Resolve a triggered ability (enters / dies / attacks) or an activated ability. */
function resolveAbility(state: RulesGameState, item: StackItem) {
  // cycling's ability (CR 702.29): the card was already discarded as a cost; the ability
  // resolving just draws a card for its controller.
  if (item.cycling) {
    drawOne(state, item.controllerId)
    logLine(state, `${name(state, item.controllerId)} draws a card (cycling).`)
    checkSBA(state)
    return
  }
  // ward's ability (CR 702.21): if the triggering spell/ability is still on the stack, the
  // payer must pay the ward cost or it's countered — open a pay-or-counter decision.
  if (item.ward) {
    const target = state.zones.stack.find((s) => s.id === item.ward!.triggeringId)
    if (!target) return // already resolved / countered — ward does nothing
    state.pending = { kind: 'ward', player: item.ward.payer }
    state.pendingWard = { player: item.ward.payer, triggeringId: item.ward.triggeringId, cost: item.ward.cost }
    logLine(state, `Ward: ${name(state, item.ward.payer)} must pay ${item.ward.cost} or ${getDef(target.defName).name} is countered.`)
    return
  }
  // cascade's ability (CR 702.85): dig the library and open the may-cast-free decision
  if (item.cascade) {
    resolveCascade(state, item)
    return
  }
  // Saga chapter ability (CR 714): resolve def.saga.chapters[n-1]; the SBA sacrifice (after the
  // final chapter leaves the stack) is handled in checkSBA.
  if (item.sagaChapter != null) {
    const chapter = getDef(item.defName).saga?.chapters[item.sagaChapter - 1]
    if (chapter) {
      const specs = flattenSpecs(chapter.targets)
      let targets = item.targets
      if (specs.length) {
        targets = item.targets.filter((t, i) => specs[i] && isLegalTarget(state, specs[i]!, t, item.controllerId, getDef(item.defName).colors ?? []))
        if (!targets.length) {
          logLine(state, `${getDef(item.defName).name}'s chapter ${item.sagaChapter} fizzles (targets are gone).`)
          checkSBA(state)
          return
        }
      }
      chapter.effect({ state, controllerId: item.controllerId, sourceId: item.sourceId, targets })
    }
    checkSBA(state)
    return
  }
  const def = getDef(item.defName)
  const ability =
    item.loyaltyIndex != null
      ? def.loyaltyAbilities?.[item.loyaltyIndex]
      : item.abilityIndex != null
        ? def.abilities?.[item.abilityIndex]
        : abilityFor(def, item.trigger ?? 'etb')
  if (!ability) return
  const specs = flattenSpecs(ability.targets)
  let targets = item.targets
  if (specs.length) {
    targets = item.targets.filter((t, i) => specs[i] && isLegalTarget(state, specs[i]!, t, item.controllerId, getDef(item.defName).colors ?? []))
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
  // Adventure (CR 715.3d): resolve the adventure's effect, then EXILE the card ("on an adventure")
  // so its owner may later cast the creature from exile — not the normal graveyard/permanent path.
  if (item.adventure && def.adventure) {
    const adv = def.adventure
    const specs = flattenSpecs(adv.targets)
    if (specs.length) {
      const stillLegal = item.targets.filter((t, i) => specs[i] && isLegalTarget(state, specs[i]!, t, item.controllerId, def.colors ?? []))
      if (!stillLegal.length) {
        logLine(state, `${adv.name} fizzles (all targets illegal).`)
        moveToGraveyard(state, obj.id) // didn't resolve → graveyard, not exile (715.3d only on resolution)
        checkSBA(state)
        return
      }
      adv.effect({ state, controllerId: item.controllerId, sourceId: item.id, targets: stillLegal, x: item.x })
    } else {
      adv.effect({ state, controllerId: item.controllerId, sourceId: item.id, targets: [], x: item.x })
    }
    moveTo(state, obj.id, 'exile') // exile is public (face-up) — id unchanged, mirrors cascade exile
    obj.adventured = true
    logLine(state, `${adv.name} goes on an adventure (exiled — the creature can be cast from exile).`)
    checkSBA(state)
    return
  }
  // Bestow (CR 702.103): enters the battlefield as an Aura attached to the target creature. If the
  // target is gone on resolution, the spell doesn't resolve (fizzle → graveyard); it does NOT enter
  // as a creature (that only happens when the enchanted creature later leaves — handled in checkSBA).
  if (item.bestow) {
    const tgt = item.targets[0]
    if (tgt == null || !isCreatureOnBattlefield(state, tgt)) {
      logLine(state, `${def.name} fizzles (no legal creature to enchant).`)
      moveToGraveyard(state, obj.id)
      checkSBA(state)
      return
    }
    obj.controllerId = item.controllerId
    obj.bestowed = true
    moveTo(state, obj.id, 'battlefield') // moveTo clears attachedTo
    obj.attachedTo = tgt as ObjId // set AFTER moveTo
    logLine(state, `${def.name} enters attached to ${objName(state, tgt as ObjId)} (bestow).`)
    fireEntersTriggers(state, obj.id)
    checkSBA(state)
    return
  }
  const chosen = activeSpell(def, item.mode) // the picked mode for a modal spell, else the plain spell
  const specs = flattenSpecs(chosen?.targets)
  let auraTarget: ObjId | null = null
  if (specs.length) {
    const stillLegal = item.targets.filter((t, i) => specs[i] && isLegalTarget(state, specs[i]!, t, item.controllerId, getDef(item.defName).colors ?? []))
    if (!stillLegal.length) {
      logLine(state, `${def.name} fizzles (all targets illegal).`)
      spellToRest(state, obj.id, item) // flashback → exile, else graveyard
      checkSBA(state)
      return
    }
    chosen?.effect({ state, controllerId: item.controllerId, sourceId: item.id, targets: stillLegal, x: item.x, kicked: item.kicked })
    if (defIsAura(def)) auraTarget = stillLegal[0] as ObjId // an Aura enters attached to its target
  } else {
    chosen?.effect({ state, controllerId: item.controllerId, sourceId: item.id, targets: [], x: item.x, kicked: item.kicked })
  }

  if (defIsPermanent(def)) {
    // a morph spell enters as a face-down 2/2 creature (CR 707.2) — no name is logged/leaked
    obj.faceDown = item.faceDown ?? false
    logLine(state, obj.faceDown ? `A face-down creature enters the battlefield.` : `${def.name} enters the battlefield.`)
    obj.controllerId = item.controllerId
    obj.summoningSick = defIsCreature(def)
    // suspend (CR 702.62e): a creature cast from suspend enters with haste
    if (item.suspendHaste && defIsCreature(def)) obj.summoningSick = false
    moveTo(state, obj.id, 'battlefield') // moveTo initialises loyalty for a planeswalker (CR 306.5b)
    if (auraTarget) obj.attachedTo = auraTarget // set AFTER moveTo (which clears attachedTo)
    if (def.entersTapped) obj.tapped = true // e.g. Worn Powerstone (cast, enters tapped)
    fireEntersTriggers(state, obj.id) // a face-down creature has no own ETB (guarded in fireEntersTriggers)
    // Saga (CR 714.2b/3): a lore counter is added as it enters → chapter I triggers
    if (defIsSaga(def)) {
      obj.counters.lore = 1
      queueSagaChapter(state, obj.id, 1)
    }
    // Evoke (CR 702.74): sacrifice it as it enters. Its ETB triggers were just queued above and
    // resolve independently (they don't need the source on the battlefield), so e.g. Mulldrifter
    // still draws two cards even though it's already dying.
    if (item.evoke) {
      logLine(state, `${def.name} is sacrificed (evoke).`)
      moveToGraveyard(state, obj.id)
    }
  } else if (item.buyback) {
    // buyback (CR 702.27): a RESOLVED spell returns to its owner's hand instead of the graveyard
    // (public stack → hidden hand → re-mint the id, invariant #3). Fizzle still goes to graveyard.
    moveTo(state, obj.id, 'hand')
    remintForHiddenEntry(state, obj.id, true)
    logLine(state, `${def.name} returns to its owner's hand (buyback).`)
  } else {
    spellToRest(state, obj.id, item)
  }
  checkSBA(state)
}

/** Where an instant/sorcery goes as it leaves the stack: EXILE if it was flashed back (CR 702.34e),
 *  otherwise the graveyard. Used on resolution and on fizzle. */
function spellToRest(state: RulesGameState, id: ObjId, item: StackItem) {
  if (item.flashback) {
    moveTo(state, id, 'exile') // exile is public — id unchanged; can't be flashed back again
    logLine(state, `${getDef(item.defName).name} is exiled (flashback).`)
  } else {
    moveToGraveyard(state, id)
  }
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
        ? isSelf && !subject.faceDown // plain ETB — a face-down creature has no own ETB (CR 707.2)
        : subjectIsCreature &&
          !(w.excludeSelf && isSelf) &&
          !(w.controllerOnly && subject.controllerId !== p.controllerId)
      if (fires) queueTriggeredAbility(state, p.id, 'etb')
    }
  }
}

/**
 * Put a triggered ability (etb / dies / attacks / upkeep) on the stack, reading
 * the source object's current definition + controller. Non-targeted → straight on
 * the stack; targeted → pending target choice (removed instead if no legal target
 * exists, CR 603.3c). The dies trigger keeps its own bespoke pusher in state.ts
 * (it must snapshot watchers BEFORE the zone change).
 */
function queueTriggeredAbility(state: RulesGameState, sourceId: ObjId, kind: NonNullable<StackItem['trigger']>) {
  const obj = state.objects[sourceId]
  if (!obj) return
  const def = getDef(obj.defName)
  const ability = abilityFor(def, kind)
  if (!ability) return
  const controllerId = obj.controllerId
  const label = TRIGGER_LABEL[kind]
  const specs = flattenSpecs(ability.targets)
  if (!specs.length) {
    state.zones.stack.push({ id: mintCardId(), kind: 'ability', trigger: kind, controllerId, defName: obj.defName, sourceId, abilityIndex: null, targets: [] })
    logLine(state, `${def.name}'s ${label} ability triggers.`)
    return
  }
  if (!specs.every((spec) => hasAnyLegalTarget(state, spec, controllerId, def.colors ?? []))) {
    logLine(state, `${def.name}'s trigger has no legal target and is removed.`)
    return
  }
  state.pending = { kind: 'trigger', player: controllerId }
  state.pendingTrigger = { sourceId, defName: obj.defName, controllerId, trigger: kind }
  logLine(state, `${def.name}'s ${label} ability triggers — ${name(state, controllerId)} chooses a target.`)
}

/**
 * Put a Saga chapter ability on the stack (CR 714.2c). Non-targeted → straight on the stack;
 * targeted → pending target choice (removed instead if no legal target, CR 603.3c) via the same
 * pendingTrigger flow as other triggers, tagged with `sagaChapter`.
 */
function queueSagaChapter(state: RulesGameState, sourceId: ObjId, chapter: number) {
  const obj = state.objects[sourceId]
  if (!obj) return
  const def = getDef(obj.defName)
  const ability = def.saga?.chapters[chapter - 1]
  if (!ability) return
  const controllerId = obj.controllerId
  const specs = flattenSpecs(ability.targets)
  if (!specs.length) {
    state.zones.stack.push({ id: mintCardId(), kind: 'ability', sagaChapter: chapter, controllerId, defName: obj.defName, sourceId, abilityIndex: null, targets: [] })
    logLine(state, `${def.name} — chapter ${chapter} triggers.`)
    return
  }
  if (!specs.every((spec) => hasAnyLegalTarget(state, spec, controllerId, def.colors ?? []))) {
    logLine(state, `${def.name}'s chapter ${chapter} has no legal target and is removed.`)
    return
  }
  state.pending = { kind: 'trigger', player: controllerId }
  state.pendingTrigger = { sourceId, defName: obj.defName, controllerId, trigger: 'etb', sagaChapter: chapter }
  logLine(state, `${def.name} — chapter ${chapter} triggers — ${name(state, controllerId)} chooses a target.`)
}

/**
 * Ward (CR 702.21): after a spell/ability (`triggeringId`, already on the stack) targets
 * permanents, put a ward trigger on the stack ABOVE it for each targeted permanent that
 * has ward and is controlled by an OPPONENT of `caster`. On resolution the ward trigger
 * makes `caster` pay the ward cost or the spell/ability is countered.
 */
function queueWardTriggers(state: RulesGameState, triggeringId: ObjId, targets: (ObjId | PlayerId)[], caster: PlayerId) {
  for (const t of targets) {
    const obj = state.objects[t as ObjId]
    if (!obj || obj.zone !== 'battlefield') continue
    const cost = getDef(obj.defName).ward
    if (!cost || obj.controllerId === caster) continue // ward only fires for an OPPONENT's spell/ability
    state.zones.stack.push({
      id: mintCardId(),
      kind: 'ability',
      ward: { triggeringId, cost, payer: caster },
      controllerId: obj.controllerId,
      defName: obj.defName,
      sourceId: obj.id,
      abilityIndex: null,
      targets: [],
    })
    logLine(state, `${getDef(obj.defName).name}'s ward triggers.`)
  }
}

/** Remove a spell/ability from the stack (ward counter). A spell goes to its graveyard; a
 *  (synthetic) ability is just spliced off. */
function counterStackItem(state: RulesGameState, item: StackItem) {
  logLine(state, `${getDef(item.defName).name} is countered by ward.`)
  if (item.kind === 'spell') {
    moveToGraveyard(state, item.id) // pulls it off the stack, into the graveyard
  } else {
    const i = state.zones.stack.findIndex((s) => s.id === item.id)
    if (i >= 0) state.zones.stack.splice(i, 1)
  }
}

/** Mana value (converted mana cost) of a card definition — generic + all coloured pips. */
function manaValue(def: CardDefinition): number {
  const c = parseManaCost(def.manaCost)
  return c.generic + (['W', 'U', 'B', 'R', 'G', 'C'] as const).reduce((n, col) => n + c.colored[col], 0)
}

/** Cascade (CR 702.85): put a cascade trigger on the stack ABOVE the just-cast spell. */
function queueCascade(state: RulesGameState, casterId: PlayerId, sourceId: ObjId, mv: number) {
  state.zones.stack.push({
    id: mintCardId(),
    kind: 'ability',
    cascade: { mv },
    controllerId: casterId,
    defName: state.objects[sourceId]!.defName,
    sourceId,
    abilityIndex: null,
    targets: [],
  })
  logLine(state, `${getDef(state.objects[sourceId]!.defName).name}'s cascade triggers.`)
}

/** Resolve a cascade trigger: exile from the top of the caster's library until a nonland with
 *  mana value < the cascade spell's; if found, open the may-cast-free decision, else bottom all. */
function resolveCascade(state: RulesGameState, item: StackItem) {
  const player = item.controllerId
  const mv = item.cascade!.mv
  const lib = zoneArr(state, player, 'library')
  const exiledIds: ObjId[] = []
  let hitId: ObjId | null = null
  while (lib.length) {
    const topId = lib[0]!
    moveTo(state, topId, 'exile') // exiled face-up (public) — id unchanged (exile is public)
    exiledIds.push(topId)
    const def = getDef(state.objects[topId]!.defName)
    if (!defIsLand(def) && manaValue(def) < mv) {
      hitId = topId
      break
    }
  }
  logLine(state, `Cascade exiles ${exiledIds.length} card${exiledIds.length === 1 ? '' : 's'}${hitId ? `, hitting ${getDef(state.objects[hitId]!.defName).name}` : ' (no hit)'}.`)
  if (hitId) {
    state.pending = { kind: 'cascade', player }
    state.pendingCascade = { player, hitId, exiledIds }
  } else {
    bottomExiled(state, player, exiledIds) // library exhausted: bottom everything
  }
}

/** Free-cast a card from exile (cascade / suspend): validate targets, then put it on the stack for
 *  {0}. `suspendHaste` marks a suspended creature so it enters with haste (CR 702.62e). */
function freeCastFromExile(
  state: RulesGameState,
  cardId: ObjId,
  controllerId: PlayerId,
  targets: (ObjId | PlayerId)[],
  mode: number | undefined,
  opts: { reason?: 'cascade' | 'suspend'; suspendHaste?: boolean } = {},
) {
  const obj = state.objects[cardId]
  if (!obj || obj.zone !== 'exile') throw new RulesError('BAD_CASCADE', 'That card is no longer exiled')
  const def = getDef(obj.defName)
  const chosen = activeSpell(def, mode)
  const specs = flattenSpecs(chosen?.targets)
  if (targets.length !== specs.length)
    throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
  targets.forEach((t, i) => {
    if (!isLegalTarget(state, specs[i]!, t, controllerId, getDef(obj.defName).colors ?? [])) throw new RulesError('BAD_TARGETS', 'Illegal target')
  })
  pullFromCurrentZone(state, obj)
  obj.zone = 'stack'
  state.zones.stack.push({
    id: obj.id,
    kind: 'spell',
    controllerId,
    defName: obj.defName,
    sourceId: obj.id,
    abilityIndex: null,
    targets: [...targets],
    mode: def.modes?.length ? (mode ?? 0) : undefined,
    suspendHaste: opts.suspendHaste || undefined,
    // free cast: no mana paid; X is 0 (x omitted)
  })
  logLine(state, `${name(state, controllerId)} casts ${def.name} for free (${opts.reason ?? 'cascade'}).`)
  // ward still applies to a free cast that targets an opponent's warded permanent
  queueWardTriggers(state, obj.id, targets, controllerId)
  // a free cast is still "casting a spell" (CR 702.85e / 702.62e) → prowess triggers
  applyProwess(state, controllerId, def)
}

/** Put the given exiled cards on the bottom of `player`'s library in a random order, then
 *  re-mint the whole library so the (publicly revealed) exiled ids can't be tracked. */
function bottomExiled(state: RulesGameState, player: PlayerId, ids: ObjId[]) {
  const order = shuffleInPlace([...ids])
  for (const id of order) if (state.objects[id]?.zone === 'exile') moveTo(state, id, 'library') // appends → bottom
  remintLibrary(state, player)
  if (ids.length) logLine(state, `${name(state, player)} puts ${ids.length} card${ids.length === 1 ? '' : 's'} on the bottom of their library.`)
}

/** Prowess (CR 702.108): casting a NONCREATURE spell pumps the caster's prowess creatures +1/+1
 *  until end of turn. Shared by the normal cast (r.cast) and the cascade free-cast. */
function applyProwess(state: RulesGameState, caster: PlayerId, def: CardDefinition) {
  if (def.types.includes('Creature')) return
  for (const c of battlefieldCreatures(state, caster))
    if (currentKeywords(state, c).includes('prowess')) {
      state.pumps.push({ objId: c.id, power: 1, toughness: 1 })
      logLine(state, `${objName(state, c.id)} gets +1/+1 (prowess).`)
    }
}

const LANDWALK: [Keyword, string][] = [
  ['islandwalk', 'Island'],
  ['swampwalk', 'Swamp'],
  ['mountainwalk', 'Mountain'],
  ['forestwalk', 'Forest'],
  ['plainswalk', 'Plains'],
]
/** True if `player` controls a land with the given subtype (for landwalk evasion). */
function controlsLandType(state: RulesGameState, player: PlayerId, subtype: string): boolean {
  return state.zones.perPlayer[player]!.battlefield.some((id) => {
    const def = getDef(state.objects[id]!.defName)
    return defIsLand(def) && (def.subtypes?.includes(subtype) ?? false)
  })
}
const sharesColor = (a: CardDefinition, b: CardDefinition): boolean => (a.colors ?? []).some((c) => (b.colors ?? []).includes(c))
/** Colours this permanent has protection from — printed (`def.protectionFrom`) + granted (until-EOT
 *  `state.protectionGrants`, CR 613 layer 6). */
const protectionColorsOf = (state: RulesGameState, obj: GameObject): ManaColor[] => [
  ...(getDef(obj.defName).protectionFrom ?? []),
  ...state.protectionGrants.filter((g) => g.objId === obj.id).map((g) => g.color),
]

/**
 * Why `blocker` may NOT block `attacker` (evasion — CR 509.1b / 702), or null if it legally can.
 * Centralises flying + the evasion keywords so `r.blockers` (and any future block-legality check)
 * share one source of truth.
 */
function blockRestriction(state: RulesGameState, blocker: GameObject, attacker: GameObject): string | null {
  const a = objName(state, attacker.id)
  const b = objName(state, blocker.id)
  const akw = currentKeywords(state, attacker)
  const bkw = currentKeywords(state, blocker)
  const aDef = getDef(attacker.defName)
  const bDef = getDef(blocker.defName)
  if (aDef.cantBeBlocked) return `${a} can't be blocked`
  // until-end-of-turn "can't be blocked" (Rogue's Passage)
  if (state.unblockable?.includes(attacker.id)) return `${a} can't be blocked this turn`
  // landwalk: unblockable if the defending player controls a land of that type
  if (attacker.attackingDefender)
    for (const [kw, sub] of LANDWALK)
      if (akw.includes(kw) && controlsLandType(state, attacker.attackingDefender, sub)) return `${a} can't be blocked (${kw})`
  // flying: only flyers/reach may block
  if (akw.includes('flying') && !bkw.includes('flying') && !bkw.includes('reach')) return `${b} can't block a flyer`
  // shadow: symmetric — a creature can block or be blocked ONLY by creatures with shadow
  if (akw.includes('shadow') !== bkw.includes('shadow')) return `${b} can't block (shadow)`
  // horsemanship: one-directional — can't be blocked except by creatures with horsemanship
  if (akw.includes('horsemanship') && !bkw.includes('horsemanship')) return `${b} can't block (horsemanship)`
  // fear: only artifact or black creatures may block
  if (akw.includes('fear') && !bDef.types.includes('Artifact') && !(bDef.colors?.includes('B') ?? false)) return `${b} can't block (fear)`
  // intimidate: only artifact creatures or creatures sharing a colour with the attacker
  if (akw.includes('intimidate') && !bDef.types.includes('Artifact') && !sharesColor(aDef, bDef)) return `${b} can't block (intimidate)`
  // skulk: can't be blocked by a creature with greater power
  if (akw.includes('skulk') && currentPower(state, blocker) > currentPower(state, attacker)) return `${b} has greater power (skulk)`
  // protection from [colour]: can't be blocked by a creature of that colour (CR 702.16, the B)
  if (protectionColorsOf(state, attacker).some((c) => (bDef.colors ?? []).includes(c))) return `${b} can't block (protection)`
  return null
}

/** Fire "at the beginning of your upkeep" triggers for the active player's permanents. */
function fireUpkeepTriggers(state: RulesGameState) {
  const ap = state.activePlayer
  for (const id of [...state.zones.perPlayer[ap]!.battlefield]) {
    const obj = state.objects[id]
    if (!obj || !getDef(obj.defName).upkeep) continue
    queueTriggeredAbility(state, id, 'upkeep')
    // LIMITATION: if a TARGETED upkeep trigger pends, later upkeep permanents this
    // turn are dropped (not deferred). No implemented card has a targeted upkeep
    // trigger; add a trigger queue before shipping one.
    if (state.pending) break
  }
}

/**
 * Suspend (CR 702.62c/d): at the beginning of the active player's upkeep, remove a time counter
 * from each of their suspended cards (exiled, has a `time` counter). When the last is removed, cast
 * a NON-targeted suspended card for free (a creature gains haste). A targeted suspended card is left
 * for a manual cast — auto-casting with a target choice is a documented follow-up.
 */
function advanceSuspend(state: RulesGameState) {
  const ap = state.activePlayer
  for (const id of [...state.zones.perPlayer[ap]!.exile]) {
    const obj = state.objects[id]
    if (!obj || !getDef(obj.defName).suspend || (obj.counters.time ?? 0) <= 0) continue
    obj.counters.time = (obj.counters.time ?? 0) - 1
    const def = getDef(obj.defName)
    logLine(state, `${def.name} — remove a time counter (${obj.counters.time} left).`)
    if (obj.counters.time === 0) {
      const specs = flattenSpecs(activeSpell(def, undefined)?.targets)
      if (specs.length === 0)
        freeCastFromExile(state, id, ap, [], undefined, { reason: 'suspend', suspendHaste: defIsCreature(def) })
      else logLine(state, `${def.name} must be cast manually (targeted suspend isn't auto-cast yet).`)
    }
  }
}

/**
 * CR 714.3: after the active player's draw step (i.e. as their precombat main phase begins), put
 * a lore counter on each Saga they control; the newly-reached chapter ability triggers. Mirrors
 * fireUpkeepTriggers' documented limitation: if a targeted chapter pends, later Sagas this turn are
 * dropped — no implemented multi-Saga-same-turn-targeted case exists yet.
 */
function advanceSagas(state: RulesGameState) {
  const ap = state.activePlayer
  for (const id of [...state.zones.perPlayer[ap]!.battlefield]) {
    const obj = state.objects[id]
    if (!obj || !defIsSaga(getDef(obj.defName))) continue
    const lore = (obj.counters.lore ?? 0) + 1
    obj.counters.lore = lore
    queueSagaChapter(state, id, lore)
    if (state.pending) break
  }
}

// ---------- targeting ----------

/** The active spell body for a (possibly modal) card given the chosen mode index. */
function activeSpell(def: CardDefinition, mode: number | null | undefined) {
  // split card (CR 709): the chosen half is selected by mode (0 = left, 1 = right)
  if (def.split) return mode === 1 ? def.split.right : def.split.left
  return def.modes?.length ? def.modes[mode ?? 0] : def.spell
}
/** How many {X} symbols the mana cost has (X spells multiply the chosen X by this). */
function xCountOf(def: CardDefinition): number {
  return (def.manaCost?.match(/\{X\}/g) ?? []).length
}

function flattenSpecs(specs?: TargetSpec[]): TargetSpec[] {
  const out: TargetSpec[] = []
  for (const spec of specs ?? []) for (let i = 0; i < spec.count; i++) out.push(spec)
  return out
}

/** Prototype-safe "is this id a permanent on the battlefield?" (any permanent type). */
function isPermanentOnBattlefield(state: RulesGameState, t: ObjId | PlayerId): boolean {
  // a phased-out permanent is treated as not existing → not a legal target (CR 702.26e)
  return Object.hasOwn(state.objects, t) && state.objects[t as ObjId]!.zone === 'battlefield' && !state.objects[t as ObjId]!.phasedOut
}

/** Is `id` a planeswalker on the battlefield controlled by one of `opponents`? (legal attack target) */
function isAttackablePlaneswalker(state: RulesGameState, id: ObjId | PlayerId, opponents: PlayerId[]): boolean {
  const o = Object.hasOwn(state.objects, id) ? state.objects[id as ObjId] : undefined
  return !!o && o.zone === 'battlefield' && getDef(o.defName).types.includes('Planeswalker') && opponents.includes(o.controllerId)
}
/** Is `id` a planeswalker on the battlefield? (combat-damage-to-loyalty routing) */
function isPlaneswalkerOnBattlefield(state: RulesGameState, id: ObjId | PlayerId): boolean {
  const o = Object.hasOwn(state.objects, id) ? state.objects[id as ObjId] : undefined
  return !!o && o.zone === 'battlefield' && getDef(o.defName).types.includes('Planeswalker')
}

/** Does a graveyard card satisfy the type part of a filter? (owner is checked by callers) */
function graveyardCardMatches(state: RulesGameState, id: ObjId, filter: TargetFilter | undefined): boolean {
  const obj = state.objects[id]
  if (!obj || obj.zone !== 'graveyard') return false
  const def = getDef(obj.defName)
  if (filter?.types && !filter.types.some((ty) => def.types.includes(ty))) return false
  if (filter?.excludeTypes && filter.excludeTypes.some((ty) => def.types.includes(ty))) return false
  return true
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
export function hasAnyLegalTarget(state: RulesGameState, spec: TargetSpec, byController: PlayerId, srcColors: readonly ManaColor[] = []): boolean {
  if (spec.kind === 'spell')
    return state.zones.stack.some((s) => s.kind === 'spell' && !spec.filter?.excludeTypes?.some((x) => getDef(s.defName).types.includes(x)))
  if (spec.kind === 'player')
    return spec.filter?.controller === 'opponent' ? opponentsOf(state, byController).length > 0 : alivePlayers(state).length > 0
  if (spec.kind === 'anyTarget') return alivePlayers(state).length > 0
  if (spec.kind === 'graveyardCard') {
    // a card in a graveyard (recursion). "your graveyard" = owned by the caster.
    const owners = spec.filter?.controller === 'you' ? [byController] : state.turnOrder
    for (const pid of owners)
      for (const id of state.zones.perPlayer[pid]!.graveyard)
        if (graveyardCardMatches(state, id, spec.filter)) return true
    return false
  }
  // creature / permanent (possibly filtered): scan battlefield for a legal target
  for (const pid of state.turnOrder)
    for (const id of state.zones.perPlayer[pid]!.battlefield)
      if (isLegalTarget(state, spec, id, byController, srcColors)) return true
  return false
}

function isLegalTarget(state: RulesGameState, spec: TargetSpec, t: ObjId | PlayerId, byController: PlayerId, srcColors: readonly ManaColor[] = []): boolean {
  if (spec.kind === 'spell') {
    const item = state.zones.stack.find((s) => s.kind === 'spell' && s.id === (t as ObjId))
    if (!item) return false
    // spell-target filter (e.g. Negate "noncreature spell"): reject excluded card types
    if (spec.filter?.excludeTypes?.some((x) => getDef(item.defName).types.includes(x))) return false
    return true
  }
  // Object.hasOwn (not `in`) so prototype keys can't masquerade as players
  const isPlayer = Object.hasOwn(state.players, t) && !state.players[t as PlayerId]!.hasLost
  // isCreatureOnBattlefield already guards prototype keys (real object + zone check)
  const isCreature = isCreatureOnBattlefield(state, t)
  const isPermanent = isPermanentOnBattlefield(state, t)
  if (isPermanent) {
    const obj = state.objects[t as ObjId]!
    const kws = currentKeywords(state, obj)
    // shroud: can't be targeted by anyone, including its controller (CR 702.18)
    if (kws.includes('shroud')) return false
    // hexproof: a permanent can't be targeted by its controller's opponents
    if (obj.controllerId !== byController && kws.includes('hexproof')) return false
    // protection from [colour]: can't be targeted by a source of that colour (any controller — CR 702.16e)
    if (protectionColorsOf(state, obj).some((c) => srcColors.includes(c))) return false
  }
  if (spec.kind === 'player') {
    if (spec.filter?.controller === 'opponent') return isPlayer && t !== byController
    if (spec.filter?.controller === 'you') return isPlayer && t === byController
    return isPlayer
  }
  if (spec.kind === 'graveyardCard') {
    const obj = Object.hasOwn(state.objects, t) ? state.objects[t as ObjId] : undefined
    if (!obj || obj.zone !== 'graveyard') return false
    if (spec.filter?.controller === 'you' && obj.ownerId !== byController) return false
    if (spec.filter?.controller === 'opponent' && obj.ownerId === byController) return false
    return graveyardCardMatches(state, t as ObjId, spec.filter)
  }
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
      if (!obj || obj.zone !== 'battlefield' || obj.phasedOut || obj.controllerId !== actor)
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
      if (!obj || obj.zone !== 'battlefield' || obj.phasedOut || obj.controllerId !== actor)
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
      const srcColors = getDef(obj.defName).colors ?? [] // for protection-from-colour target checks
      if (msg.targets.length !== specs.length)
        throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
      msg.targets.forEach((t, i) => {
        if (!isLegalTarget(state, specs[i]!, t, actor, srcColors)) throw new RulesError('BAD_TARGETS', 'Illegal target')
      })
      if (ability.cost.tap) obj.tapped = true
      const abilityStackId = mintCardId()
      state.zones.stack.push({
        id: abilityStackId,
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
      // "Sacrifice this permanent" as a cost (Evolving Wilds, Mind Stone) — same ordering: the
      // ability is already on the stack, so it still resolves after its source is gone
      if (ability.cost.sacrificeSelf) {
        logLine(state, `${name(state, actor)} sacrifices ${objName(state, obj.id)}.`)
        moveToGraveyard(state, obj.id)
      }
      // ward (CR 702.21): a targeted opponent-controlled permanent with ward triggers now
      queueWardTriggers(state, abilityStackId, msg.targets, actor)
      grantPriority(state, actor) // CR 116.4: caster/activator keeps priority; pass chain restarts
      break
    }

    case 'r.cast': {
      requirePriority(state, actor)
      const candidate = state.objects[msg.objId]
      const castingAdventure = !!msg.adventure
      // castable from your hand, your commander from the command zone, or (Adventure, CR 715) the
      // creature side of a card you own that's in exile having been cast as its adventure
      const fromCommand =
        !!candidate && candidate.zone === 'command' && candidate.ownerId === actor && candidate.isCommander
      const fromExileAdv =
        !castingAdventure && !!candidate && candidate.zone === 'exile' && candidate.adventured === true && candidate.ownerId === actor
      // Flashback (CR 702.34): cast an instant/sorcery from your graveyard for its flashback cost
      const fromFlashback =
        !castingAdventure && !!candidate && candidate.zone === 'graveyard' && candidate.ownerId === actor && !!getDef(candidate.defName).flashbackCost
      // Retrace (CR 702.81): cast from your graveyard for its normal cost + discard a land card
      const fromRetrace =
        !castingAdventure && !!candidate && candidate.zone === 'graveyard' && candidate.ownerId === actor && !!getDef(candidate.defName).retrace
      // Escape (CR 702.139): cast from your graveyard for the escape cost + exile N other GY cards
      const fromEscape =
        !castingAdventure && !!candidate && candidate.zone === 'graveyard' && candidate.ownerId === actor && !!getDef(candidate.defName).escape
      // Foretell (CR 702.143): cast the face-down foretold card from exile on a LATER turn
      const fromForetell =
        !castingAdventure && !!candidate && candidate.zone === 'exile' && candidate.faceDown === true && candidate.ownerId === actor &&
        !!getDef(candidate.defName).foretellCost && (candidate.foretoldTurn ?? state.turnNumber) < state.turnNumber
      const obj = fromCommand || fromExileAdv || fromFlashback || fromRetrace || fromEscape || fromForetell ? candidate! : requireInHand(state, actor, msg.objId)
      const def = getDef(obj.defName)
      if (castingAdventure && !def.adventure) throw new RulesError('NO_ADVENTURE', 'That card has no adventure')
      const adv = castingAdventure ? def.adventure! : null
      // bestow (CR 702.103): cast the creature as an Aura for its bestow cost (targets a creature)
      const castingBestow = !adv && !fromFlashback && !fromRetrace && !!msg.bestow
      if (castingBestow && !def.bestowCost) throw new RulesError('NO_BESTOW', 'That card has no bestow')
      // evoke (CR 702.74): cast for the evoke cost, then sacrifice it as it enters
      const castingEvoke = !adv && !castingBestow && !fromFlashback && !fromRetrace && !!msg.evoke
      if (castingEvoke && !def.evokeCost) throw new RulesError('NO_EVOKE', 'That card has no evoke')
      // morph (CR 702.37): cast face down as a 2/2 for a fixed {3}
      const castingFaceDown = !adv && !castingBestow && !castingEvoke && !fromFlashback && !fromRetrace && !fromEscape && !fromForetell && !!msg.faceDown
      if (castingFaceDown && !def.morphCost) throw new RulesError('NO_MORPH', 'That card has no morph')
      // split card (CR 709): the chosen half is selected by mode (0 = left, 1 = right)
      if (!adv && !castingBestow && def.split && msg.mode !== 0 && msg.mode !== 1) throw new RulesError('BAD_MODE', 'Choose a split half')
      const splitHalf = !adv && !castingBestow && def.split ? (msg.mode === 1 ? def.split.right : def.split.left) : null
      // the "face" being cast: the adventure half, a split half, or the card's main face
      const faceTypes = adv ? adv.types : splitHalf ? splitHalf.types : def.types
      const faceManaCost = adv ? adv.manaCost : splitHalf ? splitHalf.manaCost : castingBestow ? def.bestowCost! : castingEvoke ? def.evokeCost! : castingFaceDown ? '{3}' : fromFlashback ? def.flashbackCost! : fromEscape ? def.escape!.cost : fromForetell ? def.foretellCost! : def.manaCost
      if (defIsLand(def) && !adv && !splitHalf) throw new RulesError('IS_A_LAND', 'Lands are played, not cast')
      const instantSpeed = faceTypes.includes('Instant') || (!adv && !splitHalf && !castingBestow && hasKw(state, obj.id, 'flash'))
      if (!instantSpeed && (actor !== state.activePlayer || !isMainPhase(state) || state.zones.stack.length))
        throw new RulesError('TIMING', 'That can only be cast in your main phase with an empty stack')

      // modal "choose one": validate the chosen mode; targets come from that mode (main face only)
      if (!adv && !castingBestow && !def.split && def.modes?.length && (msg.mode == null || msg.mode < 0 || msg.mode >= def.modes.length))
        throw new RulesError('BAD_MODE', 'Choose a valid mode')
      // bestow forces a single "target creature" (the host); otherwise use the chosen face's targets
      const chosen = adv ? { targets: adv.targets, effect: adv.effect } : activeSpell(def, msg.mode)
      const specs = castingBestow ? flattenSpecs([{ kind: 'creature', count: 1 }]) : flattenSpecs(chosen?.targets)
      const srcColors = def.colors ?? [] // for protection-from-colour target checks
      if (msg.targets.length !== specs.length)
        throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
      msg.targets.forEach((t, i) => {
        if (!isLegalTarget(state, specs[i]!, t, actor, srcColors)) throw new RulesError('BAD_TARGETS', 'Illegal target')
      })

      // X spells: the chosen X is added to the generic cost, once per {X} symbol (main face only)
      const xCount = adv ? 0 : xCountOf(def)
      if (xCount > 0 && msg.x == null) throw new RulesError('NEEDS_X', 'Choose a value for X')
      const x = msg.x ?? 0
      const cost = parseManaCost(faceManaCost)
      if (fromCommand) cost.generic += 2 * state.players[actor]!.commanderTax // commander tax (CR 903.8)
      cost.generic += x * xCount
      // kicker (CR 702.33): an optional additional cost chosen as the spell is cast (main face only)
      const kicked = !adv && !!msg.kicked
      if (kicked) {
        if (!def.kickerCost) throw new RulesError('NO_KICKER', 'That spell has no kicker')
        const kc = parseManaCost(def.kickerCost)
        cost.generic += kc.generic
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) cost.colored[c] += kc.colored[c]
      }
      // buyback (CR 702.27): optional additional cost; on resolution the spell returns to hand
      const buyback = !adv && !splitHalf && !!msg.buyback
      if (buyback) {
        if (!def.buybackCost) throw new RulesError('NO_BUYBACK', 'That spell has no buyback')
        const bc = parseManaCost(def.buybackCost)
        cost.generic += bc.generic
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) cost.colored[c] += bc.colored[c]
      }
      // static generic cost reduction (CR 601.2f) — e.g. Blasphemous Act "{1} less per creature".
      // Applied after cost increases, before convoke; floored at 0, coloured pips untouched.
      if (!adv && !splitHalf && def.costReduction) cost.generic = Math.max(0, cost.generic - def.costReduction(state))
      // convoke (CR 702.51): tap creatures you control to pay for {1} or a matching-colour pip
      // (main face only). Validated + planned against a local `cost` here; creatures are tapped
      // only after the remaining mana payment is confirmed below (no partial mutation on failure).
      const convokeIds = !adv && def.convoke ? (msg.convoke ?? []) : []
      const convokeCreatures: GameObject[] = []
      if (convokeIds.length) {
        const seen = new Set<ObjId>()
        for (const id of convokeIds) {
          if (seen.has(id)) throw new RulesError('BAD_CONVOKE', 'A creature can convoke once')
          seen.add(id)
          const c = state.objects[id]
          if (!c || c.zone !== 'battlefield' || c.phasedOut || c.controllerId !== actor || !defIsCreature(getDef(c.defName)) || c.tapped)
            throw new RulesError('BAD_CONVOKE', 'Convoke needs your untapped creatures')
          const cols = getDef(c.defName).colors ?? []
          const payColor = (['W', 'U', 'B', 'R', 'G'] as const).find((col) => cols.includes(col) && cost.colored[col] > 0)
          if (payColor) cost.colored[payColor]--
          else if (cost.generic > 0) cost.generic--
          else throw new RulesError('BAD_CONVOKE', 'A convoked creature has nothing left to pay for')
          convokeCreatures.push(c)
        }
      }
      // retrace (CR 702.81): additional cost is discarding a land card from hand — validate now,
      // discard only after the mana payment is confirmed (atomic; no partial mutation on failure)
      let retraceLand: GameObject | null = null
      if (fromRetrace) {
        const l = msg.retraceLand ? state.objects[msg.retraceLand] : undefined
        if (!l || l.zone !== 'hand' || l.ownerId !== actor || !defIsLand(getDef(l.defName)))
          throw new RulesError('BAD_RETRACE', 'Retrace requires discarding a land card from your hand')
        retraceLand = l
      }
      // escape (CR 702.139): exile exactly N OTHER cards from your graveyard as an additional cost
      let escapeExile: ObjId[] = []
      if (fromEscape) {
        escapeExile = [...new Set(msg.escapeExile ?? [])]
        const need = def.escape!.exileCount
        if (escapeExile.length !== need) throw new RulesError('BAD_ESCAPE', `Exile exactly ${need} other cards`)
        for (const id of escapeExile) {
          const g = state.objects[id]
          if (id === obj.id || !g || g.zone !== 'graveyard' || g.ownerId !== actor)
            throw new RulesError('BAD_ESCAPE', 'Escape exiles other cards from your graveyard')
        }
      }
      const payment = planPayment(cost, state.players[actor]!.manaPool)
      if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      const pool = state.players[actor]!.manaPool
      for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      for (const c of convokeCreatures) c.tapped = true // convoke is paid by tapping (CR 702.51c)
      if (retraceLand) {
        moveToGraveyard(state, retraceLand.id) // discard the land (hand→graveyard) as the retrace cost
        logLine(state, `${name(state, actor)} discards ${getDef(retraceLand.defName).name} (retrace).`)
      }
      for (const id of escapeExile) moveTo(state, id, 'exile') // exile the N cards as the escape cost
      if (escapeExile.length) logLine(state, `${name(state, actor)} exiles ${escapeExile.length} cards (escape).`)

      pullFromCurrentZone(state, obj)
      obj.zone = 'stack'
      obj.adventured = false // whether cast from hand or recast from exile, it's now on the stack
      obj.faceDown = castingFaceDown // a foretold card is revealed as cast; a morph is cast face down
      if (fromCommand) state.players[actor]!.commanderTax++
      state.zones.stack.push({
        id: obj.id,
        kind: 'spell',
        controllerId: actor,
        defName: obj.defName,
        sourceId: obj.id,
        abilityIndex: null,
        targets: msg.targets,
        x: xCount > 0 ? x : undefined,
        mode: !adv && (def.modes?.length || def.split) ? (msg.mode ?? 0) : undefined,
        faceDown: castingFaceDown || undefined,
        kicked: kicked || undefined,
        adventure: castingAdventure || undefined,
        flashback: fromFlashback || undefined,
        buyback: buyback || undefined,
        bestow: castingBestow || undefined,
        evoke: castingEvoke || undefined,
      })
      const targetNames = msg.targets.map((t) =>
        Object.hasOwn(state.players, t) ? name(state, t as PlayerId) : objName(state, t as ObjId),
      )
      logLine(
        state,
        castingFaceDown
          ? `${name(state, actor)} casts a face-down creature.` // no name — it's face down (morph)
          : `${name(state, actor)} casts ${adv ? adv.name : splitHalf ? splitHalf.name : def.name}${adv ? ' (adventure)' : fromFlashback ? ' (flashback)' : fromRetrace ? ' (retrace)' : fromEscape ? ' (escape)' : fromForetell ? ' (foretold)' : fromCommand ? ' from the command zone' : ''}${targetNames.length ? ` targeting ${targetNames.join(', ')}` : ''}.`,
      )
      // ward (CR 702.21): any targeted opponent-controlled permanent with ward triggers now
      queueWardTriggers(state, obj.id, msg.targets, actor)
      // cascade (CR 702.85): "when you cast this spell" — trigger goes on the stack above it
      if (def.cascade) queueCascade(state, actor, obj.id, manaValue(def))
      // prowess (CR 702.108): applied directly at cast (same end state as the stacked trigger,
      // which resolves before the spell; prowess pumps are effectively never responded to). An
      // adventure is a noncreature spell, so cast off the face's types.
      applyProwess(state, actor, adv ? { ...def, types: adv.types } : def)
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
        if (!obj || obj.zone !== 'battlefield' || obj.phasedOut || obj.controllerId !== actor || !defIsCreature(getDef(obj.defName)))
          throw new RulesError('BAD_ATTACKER', 'Not a creature you control')
        if (obj.tapped) throw new RulesError('BAD_ATTACKER', `${objName(state, attackerId)} is tapped`)
        if (obj.summoningSick && !hasKw(state, attackerId, 'haste'))
          throw new RulesError('BAD_ATTACKER', `${objName(state, attackerId)} has summoning sickness`)
        if (hasKw(state, attackerId, 'defender'))
          throw new RulesError('BAD_ATTACKER', `${objName(state, attackerId)} has defender and can't attack`)
        if (hostCantAttack(state, obj))
          throw new RulesError('BAD_ATTACKER', `${objName(state, attackerId)} can't attack`)
        // the defender is an alive opponent, OR a planeswalker an opponent controls
        if (!opponents.includes(defenderId) && !isAttackablePlaneswalker(state, defenderId, opponents))
          throw new RulesError('BAD_ATTACKER', 'Attack an opponent, or a planeswalker they control')
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
        const pw = state.objects[defenderId]
        if (pw && getDef(pw.defName).types.includes('Planeswalker')) {
          obj.attackingDefender = pw.controllerId // the defending player is the PW's controller (for blocks)
          obj.attackingPwId = defenderId
        } else {
          obj.attackingDefender = defenderId
          obj.attackingPwId = null
        }
      }
      logLine(
        state,
        `${name(state, actor)} attacks: ${msg.attacks
          .map((a) => `${objName(state, a.attackerId)} → ${Object.hasOwn(state.players, a.defenderId) ? name(state, a.defenderId) : objName(state, a.defenderId)}`)
          .join(', ')}.`,
      )
      // exalted (CR 702.90): if exactly ONE creature attacked, each exalted permanent its
      // controller controls pumps that lone attacker +1/+1 (stacks). battle cry (CR 702.91):
      // each attacker with battle cry gives every OTHER attacking creature +1/+0. Both applied
      // directly — same end state as the stacked triggers, which resolve before combat damage.
      if (msg.attacks.length === 1) {
        const loneId = msg.attacks[0]!.attackerId
        const exalted = battlefieldCreatures(state, actor).filter((c) => currentKeywords(state, c).includes('exalted')).length
        for (let i = 0; i < exalted; i++) state.pumps.push({ objId: loneId, power: 1, toughness: 1 })
        if (exalted) logLine(state, `${objName(state, loneId)} gets +${exalted}/+${exalted} (exalted).`)
      }
      for (const { attackerId } of msg.attacks) {
        if (!currentKeywords(state, state.objects[attackerId]!).includes('battle cry')) continue
        for (const other of msg.attacks) if (other.attackerId !== attackerId) state.pumps.push({ objId: other.attackerId, power: 1, toughness: 0 })
        logLine(state, `${objName(state, attackerId)} shouts a battle cry (+1/+0 to each other attacker).`)
      }
      // "whenever this attacks" triggers go on the stack now (CR 508.4), in the
      // order the attackers were declared; the attacker chooses the order among
      // simultaneous ones (declaration order is a fine deterministic approximation)
      for (const { attackerId } of msg.attacks) {
        if (getDef(state.objects[attackerId]!.defName).attacks) queueTriggeredAbility(state, attackerId, 'attacks')
        // same LIMITATION as upkeep: a targeted attacks trigger pending would drop
        // later attackers' triggers (none of the implemented attacks triggers target)
        if (state.pending) break
      }
      // a targeted attacks trigger set pending → its controller chooses first
      if (!state.pending) grantPriority(state, actor)
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
        if (!blocker || blocker.zone !== 'battlefield' || blocker.phasedOut || blocker.controllerId !== actor || !defIsCreature(getDef(blocker.defName)))
          throw new RulesError('BAD_BLOCKER', 'Not a creature you control')
        if (blocker.tapped) throw new RulesError('BAD_BLOCKER', `${objName(state, blockerId)} is tapped`)
        if (hostCantBlock(state, blocker)) throw new RulesError('BAD_BLOCKER', `${objName(state, blockerId)} can't block`)
        const attacker = state.objects[attackerId]
        if (!attacker || attacker.attackingDefender !== actor)
          throw new RulesError('BAD_BLOCKER', 'That creature is not attacking you')
        // evasion: flying / fear / intimidate / skulk / shadow / horsemanship / landwalk / unblockable
        const restriction = blockRestriction(state, blocker, attacker)
        if (restriction) throw new RulesError('BAD_BLOCKER', restriction)
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
        // flanking (CR 702.25): a blocker WITHOUT flanking that blocks a flanking attacker gets
        // -1/-1 until EOT (per flanking instance) — applied directly; SBA can then kill a
        // 0-toughness blocker before combat damage
        if (hasKw(state, attackerId, 'flanking') && !hasKw(state, blockerId, 'flanking')) {
          const n = currentKeywords(state, state.objects[attackerId]!).filter((k) => k === 'flanking').length || 1
          for (let i = 0; i < n; i++) state.pumps.push({ objId: blockerId, power: -1, toughness: -1 })
          logLine(state, `${objName(state, blockerId)} gets -${n}/-${n} (flanking).`)
        }
      }
      logLine(
        state,
        msg.blocks.length
          ? `${name(state, actor)} blocks with ${msg.blocks.map((b) => objName(state, b.blockerId)).join(', ')}.`
          : `${name(state, actor)} declares no blockers.`,
      )
      checkSBA(state) // a flanking -1/-1 may reduce a blocker to 0 toughness
      state.blockersDone.push(actor)
      advanceBlockersQueue(state) // next attacked defender declares, or AP gets priority
      break
    }

    case 'r.discard': {
      if (state.pending?.kind !== 'discard' || state.pending.player !== actor)
        throw new RulesError('NOT_PENDING', 'Not waiting for your discard')
      const hand = zoneArr(state, actor, 'hand')
      const forced = state.pendingDiscard // a Mind-Rot-style forced discard vs the cleanup discard
      // forced: discard min(count, hand); cleanup: discard down to 7
      const need = forced ? Math.min(forced.count, hand.length) : hand.length - 7
      const ids = [...new Set(msg.objIds)]
      if (ids.length !== need) throw new RulesError('BAD_DISCARD', `Discard exactly ${need}`)
      for (const id of ids)
        if (!hand.includes(id)) throw new RulesError('BAD_DISCARD', 'Not in your hand')
      // Madness (CR 702.35): a discarded madness card is EXILED and its owner gets a cast-or-
      // graveyard window instead of going straight to the graveyard. One window at a time — the
      // first madness card among the discards opens it; the rest go to the graveyard now (a
      // documented simplification for the rare multi-madness discard).
      const madnessId = ids.find((id) => getDef(state.objects[id]!.defName).madnessCost)
      for (const id of ids) {
        if (id === madnessId) continue
        moveToGraveyard(state, id)
      }
      logLine(state, `${name(state, actor)} discards ${ids.length} card${ids.length > 1 ? 's' : ''}.`)
      if (madnessId != null) {
        moveTo(state, madnessId, 'exile') // exile face-up; the hand id was never serialised so no leak
        state.pending = { kind: 'madness', player: actor }
        state.pendingMadness = { player: actor, cardId: madnessId, resume: forced ? 'forced' : 'cleanup' }
        logLine(state, `${getDef(state.objects[madnessId]!.defName).name} — madness: ${name(state, actor)} may cast it.`)
        break // defer finishCleanup / advanceDiscardQueue until the madness window resolves
      }
      if (forced) advanceDiscardQueue(state)
      else finishCleanup(state)
      break
    }

    case 'r.madness': {
      if (state.pending?.kind !== 'madness' || state.pending.player !== actor || !state.pendingMadness)
        throw new RulesError('NOT_PENDING', 'Not waiting for your madness decision')
      const pm = state.pendingMadness
      const obj = state.objects[pm.cardId]
      const def = obj ? getDef(obj.defName) : undefined
      if (msg.cast && obj && def?.madnessCost) {
        // cast for the madness cost. Validate targets + affordability BEFORE clearing the pending
        // (throw-before-mutate) so a failed cast can be retried as a decline.
        const chosen = activeSpell(def, msg.mode)
        const specs = flattenSpecs(chosen?.targets)
        const srcColors = def.colors ?? []
        if (msg.targets.length !== specs.length) throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
        msg.targets.forEach((t, i) => {
          if (!isLegalTarget(state, specs[i]!, t, actor, srcColors)) throw new RulesError('BAD_TARGETS', 'Illegal target')
        })
        const cost = parseManaCost(def.madnessCost)
        const pool = state.players[actor]!.manaPool
        const payment = planPayment(cost, pool)
        if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
        state.pending = null
        state.pendingMadness = null
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
        pullFromCurrentZone(state, obj)
        obj.zone = 'stack'
        state.zones.stack.push({ id: obj.id, kind: 'spell', controllerId: actor, defName: obj.defName, sourceId: obj.id, abilityIndex: null, targets: [...msg.targets], mode: def.modes?.length ? (msg.mode ?? 0) : undefined })
        logLine(state, `${name(state, actor)} casts ${def.name} (madness).`)
        queueWardTriggers(state, obj.id, msg.targets, actor)
        applyProwess(state, actor, def)
        // resume the interrupted discard flow: forced → continue the queue; cleanup → the spell
        // resolves via priority, then the step (still 'cleanup') finishes cleanup naturally
        if (pm.resume === 'forced') advanceDiscardQueue(state)
        else grantPriority(state, actor)
      } else {
        state.pending = null
        state.pendingMadness = null
        if (obj) moveToGraveyard(state, obj.id) // declined → to the graveyard
        if (pm.resume === 'forced') advanceDiscardQueue(state)
        else finishCleanup(state)
      }
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
      for (let i = 0; i < chosen.length; i++) {
        const id = chosen[i]!
        const obj = state.objects[id]
        if (!obj) continue
        // split (Cultivate/Kodama's Reach): first pick → `first`, the rest → `rest`
        const route = ps.split ? (i === 0 ? ps.split.first : ps.split.rest) : { dest: ps.dest, tapped: ps.tapped }
        if (route.dest === 'battlefield') {
          obj.controllerId = actor
          obj.summoningSick = defIsCreature(getDef(obj.defName))
          moveTo(state, id, 'battlefield')
          if (route.tapped) obj.tapped = true
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

    case 'r.equip': {
      requirePriority(state, actor)
      if (msg.equipmentId === msg.creatureId) throw new RulesError('BAD_EQUIP', "Equipment can't equip itself")
      const equip = state.objects[msg.equipmentId]
      if (!equip || equip.zone !== 'battlefield' || equip.phasedOut || equip.controllerId !== actor || !defIsEquipment(getDef(equip.defName)))
        throw new RulesError('NOT_EQUIPMENT', "That isn't your Equipment on the battlefield")
      // assisted table: an unimplemented Equipment's equip cost is unknown — the engine
      // must NOT auto-equip it at a fabricated {0} cost; it's hand-run via overrides
      if (getDef(equip.defName).unimplemented)
        throw new RulesError('UNIMPLEMENTED', 'Equip this card by hand — its rules are not automated')
      // equip is sorcery-speed (CR 301.5c): your main phase, empty stack
      if (actor !== state.activePlayer || !isMainPhase(state) || state.zones.stack.length)
        throw new RulesError('TIMING', 'Equip only during your main phase with an empty stack')
      const creature = state.objects[msg.creatureId]
      if (!creature || creature.zone !== 'battlefield' || creature.phasedOut || creature.controllerId !== actor || !defIsCreature(getDef(creature.defName)))
        throw new RulesError('BAD_EQUIP', 'Attach to a creature you control')
      // protection from [colour]: can't be equipped by a coloured Equipment of that colour (the E)
      if (protectionColorsOf(state, creature).some((c) => (getDef(equip.defName).colors ?? []).includes(c)))
        throw new RulesError('BAD_EQUIP', `${objName(state, creature.id)} has protection from that Equipment`)
      // pay the equip cost from the pool (atomic — throws before attaching)
      const cost = parseManaCost(getDef(equip.defName).equipCost)
      const pool = state.players[actor]!.manaPool
      const payment = planPayment(cost, pool)
      if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      // immediate attach (documented simplification: equip does not use the stack here)
      equip.attachedTo = creature.id
      state.passed = [] // an action restarts the pass chain (CR 116.4)
      logLine(state, `${name(state, actor)} equips ${objName(state, equip.id)} to ${objName(state, creature.id)}.`)
      checkSBA(state)
      break
    }

    case 'r.cycle': {
      requirePriority(state, actor) // cycling is instant speed — any time you have priority
      const obj = requireInHand(state, actor, msg.objId)
      const def = getDef(obj.defName)
      if (!def.cyclingCost) throw new RulesError('NO_CYCLING', "That card doesn't have cycling")
      // pay the mana part of the cost (atomic — throws before the discard)
      const cost = parseManaCost(def.cyclingCost)
      const pool = state.players[actor]!.manaPool
      const payment = planPayment(cost, pool)
      if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      // "Discard this card" is the rest of the cost — paid now (hand→graveyard). No re-mint:
      // the hand id was never serialised to opponents (hand is count-only), so revealing it
      // in the public graveyard leaks nothing (invariants #2/#3).
      moveTo(state, obj.id, 'graveyard')
      logLine(state, `${name(state, actor)} cycles ${def.name}.`)
      // cycling uses the stack (CR 702.29c): the draw is its effect, resolved after priority
      state.zones.stack.push({
        id: mintCardId(),
        kind: 'ability',
        cycling: true,
        controllerId: actor,
        defName: obj.defName,
        sourceId: obj.id,
        abilityIndex: null,
        targets: [],
      })
      grantPriority(state, actor) // activator keeps priority; pass chain restarts (CR 116.4)
      break
    }

    case 'r.suspend': {
      requirePriority(state, actor)
      const obj = requireInHand(state, actor, msg.objId)
      const def = getDef(obj.defName)
      if (!def.suspend) throw new RulesError('NO_SUSPEND', "That card doesn't have suspend")
      // suspend at the time you could cast the card: instant speed only for an instant
      const instantSpeed = def.types.includes('Instant')
      if (!instantSpeed && (actor !== state.activePlayer || !isMainPhase(state) || state.zones.stack.length))
        throw new RulesError('TIMING', 'Suspend only in your main phase with an empty stack')
      // pay the suspend cost (atomic — throws before exiling)
      const cost = parseManaCost(def.suspend.cost)
      const pool = state.players[actor]!.manaPool
      const payment = planPayment(cost, pool)
      if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      // exile it face-up with N time counters (exile is public — no re-mint needed; the hand id
      // was never serialised to opponents, so revealing it now leaks nothing — invariants #2/#3)
      moveTo(state, obj.id, 'exile')
      obj.counters.time = def.suspend.n
      logLine(state, `${name(state, actor)} suspends ${def.name} with ${def.suspend.n} time counter${def.suspend.n === 1 ? '' : 's'}.`)
      grantPriority(state, actor) // a special action; the actor keeps priority, pass chain restarts
      break
    }

    case 'r.foretell': {
      requirePriority(state, actor)
      const obj = requireInHand(state, actor, msg.objId)
      const def = getDef(obj.defName)
      if (!def.foretellCost) throw new RulesError('NO_FORETELL', "That card doesn't have foretell")
      // foretelling is a special action during your turn (sorcery-speed timing here)
      if (actor !== state.activePlayer || !isMainPhase(state) || state.zones.stack.length)
        throw new RulesError('TIMING', 'Foretell only during your main phase with an empty stack')
      const cost = parseManaCost('{2}') // the fixed foretell cost (CR 702.143c)
      const pool = state.players[actor]!.manaPool
      const payment = planPayment(cost, pool)
      if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      // exile it FACE DOWN — opponents never learn what it is (the redactor sends no defName).
      // No re-mint: the hand id was never serialised to opponents, and the face-down exile id
      // they now see carries no identity (invariants #2/#3).
      moveTo(state, obj.id, 'exile')
      obj.faceDown = true
      obj.foretoldTurn = state.turnNumber
      logLine(state, `${name(state, actor)} foretells a card.`) // no card name — it's face down
      grantPriority(state, actor)
      break
    }

    case 'r.morph': {
      requirePriority(state, actor) // turning face up is a special action, any time you have priority
      const obj = state.objects[msg.objId]
      if (!obj || obj.zone !== 'battlefield' || obj.controllerId !== actor || !obj.faceDown)
        throw new RulesError('NOT_FACE_DOWN', 'That is not your face-down permanent')
      const def = getDef(obj.defName)
      if (!def.morphCost) throw new RulesError('NO_MORPH', 'That card has no morph cost')
      const cost = parseManaCost(def.morphCost)
      const pool = state.players[actor]!.manaPool
      const payment = planPayment(cost, pool)
      if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      obj.faceDown = false // revealed — its real characteristics apply now (no stack, not "casting")
      logLine(state, `${name(state, actor)} turns ${def.name} face up.`)
      state.passed = [] // a special action restarts the pass chain (CR 116.4)
      checkSBA(state) // its real toughness now applies
      break
    }

    case 'r.ward': {
      if (state.pending?.kind !== 'ward' || state.pending.player !== actor || !state.pendingWard)
        throw new RulesError('NOT_PENDING', 'Not waiting for your ward payment')
      const pw = state.pendingWard
      const item = state.zones.stack.find((s) => s.id === pw.triggeringId)
      state.pending = null
      state.pendingWard = null
      if (item) {
        const pool = state.players[actor]!.manaPool
        const payment = planPayment(parseManaCost(pw.cost), pool)
        if (msg.pay && payment.covered) {
          for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
          logLine(state, `${name(state, actor)} pays ${pw.cost} for ward.`)
        } else {
          // declined, or can't actually afford it → the spell/ability is countered
          counterStackItem(state, item)
        }
      }
      // resume: active player gets priority; the pass/resolve loop continues the stack
      if (state.status === 'active') grantPriority(state, state.activePlayer)
      break
    }

    case 'r.cascade': {
      if (state.pending?.kind !== 'cascade' || state.pending.player !== actor || !state.pendingCascade)
        throw new RulesError('NOT_PENDING', 'Not waiting for your cascade')
      const pc = state.pendingCascade
      const hit = state.objects[pc.hitId]
      const willCast = msg.cast && !!hit && hit.zone === 'exile'
      // validate targets BEFORE any mutation so a bad choice leaves the decision open to retry
      if (willCast) freeCastFromExile(state, pc.hitId, actor, msg.targets, msg.mode)
      state.pending = null
      state.pendingCascade = null
      // the passed-over cards (+ the hit if declined) go to the bottom in a random order
      const toBottom = pc.exiledIds.filter((id) => id !== pc.hitId)
      if (!willCast) toBottom.push(pc.hitId)
      bottomExiled(state, actor, toBottom)
      if (state.status === 'active') grantPriority(state, state.activePlayer)
      break
    }

    case 'r.loyalty': {
      requirePriority(state, actor)
      const pw = state.objects[msg.objId]
      const pwDef = pw && getDef(pw.defName)
      if (!pw || !pwDef || pw.zone !== 'battlefield' || pw.controllerId !== actor || !pwDef.types.includes('Planeswalker'))
        throw new RulesError('NOT_YOURS', "That isn't your planeswalker on the battlefield")
      // loyalty abilities are sorcery-speed (CR 606.3) and once per turn per planeswalker
      if (actor !== state.activePlayer || !isMainPhase(state) || state.zones.stack.length)
        throw new RulesError('TIMING', 'Loyalty abilities are used in your main phase with an empty stack')
      if (pw.loyaltyActivatedThisTurn) throw new RulesError('ONCE_PER_TURN', 'That planeswalker already used a loyalty ability this turn')
      const la = pwDef.loyaltyAbilities?.[msg.abilityIndex]
      if (!la) throw new RulesError('NO_ABILITY', 'No such loyalty ability')
      // pay the loyalty cost: a negative cost needs enough loyalty (CR 606.5)
      const newLoyalty = (pw.loyalty ?? 0) + la.cost
      if (newLoyalty < 0) throw new RulesError('CANT_PAY', 'Not enough loyalty for that ability')
      const specs = flattenSpecs(la.targets)
      const srcColors = getDef(pw.defName).colors ?? [] // for protection-from-colour target checks
      if (msg.targets.length !== specs.length)
        throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
      msg.targets.forEach((t, i) => {
        if (!isLegalTarget(state, specs[i]!, t, actor, srcColors)) throw new RulesError('BAD_TARGETS', 'Illegal target')
      })
      pw.loyalty = newLoyalty // loyalty cost is paid as the ability is activated
      pw.loyaltyActivatedThisTurn = true
      const loyaltyStackId = mintCardId()
      state.zones.stack.push({
        id: loyaltyStackId,
        kind: 'ability',
        loyaltyIndex: msg.abilityIndex,
        controllerId: actor,
        defName: pw.defName,
        sourceId: pw.id,
        abilityIndex: null,
        targets: [...msg.targets],
      })
      logLine(state, `${name(state, actor)} activates ${pwDef.name}'s ${la.cost >= 0 ? '+' : ''}${la.cost} ability (loyalty ${pw.loyalty}).`)
      // ward (CR 702.21): a targeted loyalty ability an opponent controls also triggers ward
      queueWardTriggers(state, loyaltyStackId, msg.targets, actor)
      grantPriority(state, actor) // activator keeps priority (CR 605.3 / 116.4)
      break
    }

    case 'r.chooseTargets': {
      if (state.pending?.kind !== 'trigger' || state.pending.player !== actor || !state.pendingTrigger)
        throw new RulesError('NOT_PENDING', 'Not waiting for your target choice')
      const pt = state.pendingTrigger
      const def = getDef(pt.defName)
      // a Saga chapter's targets come from def.saga.chapters[n-1]; other triggers from abilityFor
      const specs = flattenSpecs(
        pt.sagaChapter != null ? def.saga?.chapters[pt.sagaChapter - 1]?.targets : abilityFor(def, pt.trigger)?.targets,
      )
      const srcColors = def.colors ?? [] // for protection-from-colour target checks
      if (msg.targets.length !== specs.length)
        throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
      msg.targets.forEach((t, i) => {
        if (!isLegalTarget(state, specs[i]!, t, actor, srcColors)) throw new RulesError('BAD_TARGETS', 'Illegal target')
      })
      const triggerStackId = mintCardId()
      state.zones.stack.push({
        id: triggerStackId,
        kind: 'ability',
        trigger: pt.sagaChapter != null ? undefined : pt.trigger,
        sagaChapter: pt.sagaChapter,
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
      // ward (CR 702.21): a targeted TRIGGERED ability an opponent controls also triggers ward
      queueWardTriggers(state, triggerStackId, msg.targets, pt.controllerId)
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
