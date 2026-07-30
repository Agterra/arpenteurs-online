/**
 * The rules-engine loop (M-R0, 1v1): turn/step machine, priority passing
 * (APNAP for two players), the stack, casting with mana payment + timing,
 * combat, state-based actions, win/loss.
 *
 * Entry points: `startGame(state)` once after setup, then
 * `applyRulesAction(state, actor, msg)` per player action (throws RulesError
 * on anything illegal — enforcement IS the feature).
 */
import type { GameObject, ManaPool, ObjId, PlayerId, PlayerRState, RulesGameState, StackItem } from '#shared/rules/types'
import { currentKeywords, currentPower, currentToughness, hostCantAttack, hostCantBlock } from './characteristics'
import { STEPS } from '#shared/rules/types'
import type { RulesMsgT } from '#shared/rules/messages'
import { parseManaCost, planPayment } from '#shared/utils/manaCost'
import { emptyPool } from '#shared/rules/types'
import { defKey, getDef, isTokenDefName, registerToken } from './cards/registry'
import { mintCardId, shuffleInPlace } from '../game/rng'
import { hasCreatureType, defIsAura, defIsCreature, defIsEquipment, defIsLand, defIsPermanent, defIsSaga, type CardDefinition, type Cost, type TargetSpec, type TargetFilter } from './cards/dsl'
import type { Keyword, ManaColor } from '#shared/rules/types'
import { handCardMatches, proliferateTargets, scry as scryEffect, untapOwnLands } from './cards/effects'
import {
  changeLife,
  putCounters,
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
/**
 * Devotion to a colour (CR 700.5): how many mana symbols of that colour appear in the mana costs of
 * the permanents this player controls. Hybrid/phyrexian pips are not in the pool, so a plain count
 * of the coloured pips is exact for every implemented card.
 */
export function devotionTo(state: RulesGameState, player: PlayerId, color: ManaColor): number {
  let n = 0
  for (const id of zoneArr(state, player, 'battlefield')) {
    const def = getDef(state.objects[id]!.defName)
    if (!def.manaCost) continue
    n += parseManaCost(def.manaCost).colored[color]
  }
  return n
}

/**
 * Total cost reduction the caster's permanents give a spell (Foundry Inspector, the Medallions).
 * Applies to the generic portion only; the caller floors the result at 0.
 */
export function permanentCostReduction(state: RulesGameState, caster: PlayerId, def: CardDefinition): number {
  let total = 0
  for (const id of zoneArr(state, caster, 'battlefield')) {
    const src = getDef(state.objects[id]!.defName)
    const r = src.spellCostReduction
    if (!r) continue
    if (r.types?.length && !r.types.some((t) => def.types.includes(t))) continue
    if (r.colors?.length && !r.colors.some((c) => (def.colors ?? []).includes(c))) continue
    // "creature spells you cast OF THE CHOSEN TYPE cost {1} less" (Herald's Horn)
    if (r.chosenTypeOnly) {
      const chosen = state.objects[id]!.chosenType
      if (!chosen || !def.types.includes('Creature') || !hasCreatureType(def, chosen)) continue
    }
    total += r.amount
  }
  return total
}

/**
 * How many lands this player may play this turn: one, plus any static allowance from their
 * permanents (Exploration), plus one-shot grants from spells (Explore).
 */
export function landDropAllowance(state: RulesGameState, player: PlayerId): number {
  let extra = state.players[player]!.extraLandsThisTurn ?? 0
  for (const id of zoneArr(state, player, 'battlefield')) extra += getDef(state.objects[id]!.defName).extraLandDrops ?? 0
  return 1 + extra
}

/** A channel ability's cost, reduced by your legendary creatures when the card says so. */
export function channelCost(state: RulesGameState, actor: PlayerId, def: CardDefinition) {
  const cost = parseManaCost(def.channel!.cost)
  if (def.channel!.reducedByLegendaries) {
    const legends = zoneArr(state, actor, 'battlefield').filter((id) => {
      const d = getDef(state.objects[id]!.defName)
      return defIsCreature(d) && (d.supertypes?.includes('Legendary') ?? false)
    }).length
    cost.generic = Math.max(0, cost.generic - legends)
  }
  return cost
}

/**
 * The life an activated ability costs right now: its fixed `life` plus, for War Room's
 * `lifeFromCommanderColors`, one per colour of the activating player's commander (see the DSL note
 * — colour identity is approximated by the commander card's printed colours). Shared with redact so
 * the board shows the same number the engine charges.
 */
export function abilityLifeCost(state: RulesGameState, actor: PlayerId, cost: Cost) {
  let life = cost.life ?? 0
  if (cost.lifeFromCommanderColors) {
    const cmd = state.players[actor]!.commanderId
    const colors = cmd && state.objects[cmd] ? (getDef(state.objects[cmd]!.defName).colors ?? []) : []
    life += new Set(colors).size
  }
  return life
}

/** Does a restricted-mana bucket accept being spent on `def`? (CR 106.6) */
function restrictionAllows(
  bucket: NonNullable<PlayerRState['restrictedMana']>[number],
  def: CardDefinition,
): boolean {
  // Path of Ancestry's mana carries a RIDER, not a restriction: it pays for anything
  if (bucket.scryIfSharesCommanderType) return true
  // Three Tree City: "spend this mana only to cast creature spells" (any creature spell)
  if (bucket.creatureSpellsOnly && !def.types.includes('Creature')) return false
  if (bucket.legendary && !(def.supertypes?.includes('Legendary') ?? false)) return false
  if (bucket.creatureType) {
    if (!def.types.includes('Creature')) return false
    if (!hasCreatureType(def, bucket.creatureType)) return false
  }
  return true
}

/**
 * The mana a player can actually spend on casting `def`: their pool plus every RESTRICTED bucket
 * whose "spend this mana only to cast …" clause `def` satisfies. Used by r.cast and by redact, so a
 * highlighted-as-castable card is exactly one the server will accept.
 */
export function spellPayablePool(state: RulesGameState, player: PlayerId, def: CardDefinition): ManaPool {
  const pool = { ...state.players[player]!.manaPool }
  for (const bucket of state.players[player]!.restrictedMana ?? []) {
    if (restrictionAllows(bucket, def)) pool[bucket.color] += bucket.amount
  }
  return pool
}

/**
 * Spend `deduct` on a spell, taking RESTRICTED mana first (it is useless for anything else, and CR
 * 601.2g leaves the choice to the player — spending the restricted mana is never worse). Returns
 * whether any bucket carried the "…and that spell can't be countered" rider.
 */
function spendSpellMana(state: RulesGameState, player: PlayerId, deduct: ManaPool, def: CardDefinition) {
  const p = state.players[player]!
  const buckets = (p.restrictedMana ??= []).filter((b) => restrictionAllows(b, def))
  let uncounterable = false
  let scries = 0
  for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
    let owed = deduct[c]
    for (const bucket of buckets) {
      if (owed <= 0) break
      if (bucket.color !== c || bucket.amount <= 0) continue
      const take = Math.min(owed, bucket.amount)
      bucket.amount -= take
      owed -= take
      if (bucket.uncounterable) uncounterable = true
      // Path of Ancestry: "when that mana is spent to cast a creature spell that shares a creature type
      // with your commander, scry 1"
      if (bucket.scryIfSharesCommanderType && sharesTypeWithCommander(state, player, def)) scries++
    }
    p.manaPool[c] -= owed
  }
  p.restrictedMana = p.restrictedMana!.filter((b) => b.amount > 0)
  return { uncounterable, scries }
}

/** Does `def` share a creature type with this player's commander? (Path of Ancestry's rider) */
function sharesTypeWithCommander(state: RulesGameState, player: PlayerId, def: CardDefinition): boolean {
  if (!def.types.includes('Creature')) return false
  const cmd = state.players[player]!.commanderId
  const cmdDef = cmd && state.objects[cmd] ? getDef(state.objects[cmd]!.defName) : null
  if (!cmdDef) return false
  // changeling shares a type with anything (CR 702.73)
  return (
    (def.keywords ?? []).includes('changeling') ||
    (cmdDef.keywords ?? []).includes('changeling') ||
    (def.subtypes ?? []).some((st) => (cmdDef.subtypes ?? []).includes(st))
  )
}

/**
 * IMPULSE DRAW: may `actor` play this exiled card right now? The window is 'endOfTurn' (the turn it
 * was exiled on) or 'endOfYourNextTurn' (still open on any later turn up to and including the actor's
 * next one — `expireImpulseWindows` closes it at that turn's cleanup, so a live marker means open).
 */
export function isImpulsePlayable(state: RulesGameState, actor: PlayerId, id: ObjId): boolean {
  const obj = state.objects[id]
  if (!obj || obj.zone !== 'exile' || obj.playableBy !== actor || !obj.playableUntil) return false
  if (obj.playableUntil === 'endOfTurn') return state.turnNumber === (obj.playableFromTurn ?? state.turnNumber)
  return true
}

/**
 * Close the impulse windows that end with this turn (called at cleanup): every 'endOfTurn' marker,
 * and an 'endOfYourNextTurn' marker whose owner is the active player on a LATER turn than the one it
 * was made on. The card stays in exile — only the permission expires.
 */
function expireImpulseWindows(state: RulesGameState) {
  for (const obj of Object.values(state.objects)) {
    if (!obj.playableUntil) continue
    const ownTurn = obj.playableBy === state.activePlayer
    const later = state.turnNumber > (obj.playableFromTurn ?? state.turnNumber)
    if (obj.playableUntil === 'endOfTurn' || (ownTurn && later)) {
      delete obj.playableBy
      delete obj.playableUntil
      delete obj.playableFromTurn
    }
  }
}

/**
 * Schedule a DELAYED trigger (CR 603.7). It fires at the given step of a LATER turn than the one it
 * was created on, then is removed.
 */
export function scheduleDelayed(
  state: RulesGameState,
  entry: {
    at: 'nextUpkeep' | 'nextMainPhase'
    player: PlayerId
    defName: string
    key: string
    x?: number
    anyPlayersTurn?: boolean
  },
) {
  ;(state.delayedTriggers ??= []).push({ ...entry, createdTurn: state.turnNumber })
}

/**
 * Fire the delayed triggers due at `at` for the active player: each resolves its effect or, with
 * `unlessPay`, opens the pay-or-else decision. Returns true when a decision was opened (the caller
 * must not grant priority then).
 */
function fireDelayedTriggers(state: RulesGameState, at: 'nextUpkeep' | 'nextMainPhase'): boolean {
  const due = (state.delayedTriggers ?? []).filter(
    (d) =>
      d.at === at &&
      d.createdTurn < state.turnNumber &&
      // "at the beginning of the next turn's upkeep" fires whoever is active (Arcane Denial); the
      // ordinary wording waits for that player's OWN next turn
      (d.anyPlayersTurn || d.player === state.activePlayer),
  )
  if (!due.length) return false
  state.delayedTriggers = (state.delayedTriggers ?? []).filter((d) => !due.includes(d))
  for (const d of due) {
    const body = getDef(d.defName).delayed?.[d.key]
    if (!body) continue
    if (body.unlessPay && !state.pending) {
      state.pending = { kind: 'optionalPay', player: d.player }
      state.pendingOptionalPay = {
        player: d.player,
        beneficiary: d.player,
        cost: body.unlessPay,
        defName: d.defName,
        sourceId: '',
        trigger: 'delayed',
        delayedKey: d.key,
      }
      logLine(state, `${getDef(d.defName).name}: ${name(state, d.player)} must pay ${body.unlessPay}.`)
      continue
    }
    logLine(state, `${getDef(d.defName).name}'s delayed ability triggers.`)
    body.effect({ state, controllerId: d.player, sourceId: '', targets: [], x: d.x })
  }
  checkSBA(state)
  return !!state.pending
}

/**
 * Colours a player's LANDS can additionally produce thanks to a granted mana ability (Chromatic
 * Lantern). Empty when they control no such permanent.
 */
export function grantedLandManaColors(state: RulesGameState, player: PlayerId): ManaColor[] {
  const out = new Set<ManaColor>()
  for (const id of zoneArr(state, player, 'battlefield')) {
    if (state.objects[id]!.phasedOut || state.loseAbilities.includes(id)) continue
    for (const c of getDef(state.objects[id]!.defName).grantsLandManaColors ?? []) out.add(c)
  }
  // "Each land is a Swamp in addition to its other land types" (Urborg / Yavimaya) — GLOBAL, so any
  // player's such permanent gives EVERY land that basic type's intrinsic mana ability (CR 305.7)
  for (const c of globalLandTypeColors(state)) out.add(c)
  return (['W', 'U', 'B', 'R', 'G', 'C'] as const).filter((c) => out.has(c))
}

/** The basic land TYPES granted to every land by a global type-adding static (Urborg, Yavimaya). */
export function globalLandTypes(state: RulesGameState): string[] {
  const out = new Set<string>()
  for (const pid of state.turnOrder) {
    for (const id of zoneArr(state, pid, 'battlefield')) {
      const obj = state.objects[id]
      if (!obj || obj.phasedOut || state.loseAbilities.includes(id)) continue
      const t = getDef(obj.defName).grantsLandTypeToAll
      if (t) out.add(t)
    }
  }
  return [...out]
}
const BASIC_TYPE_COLOR: Record<string, ManaColor> = {
  Plains: 'W',
  Island: 'U',
  Swamp: 'B',
  Mountain: 'R',
  Forest: 'G',
}
/** The mana colours those granted land types bring with them. */
function globalLandTypeColors(state: RulesGameState): ManaColor[] {
  return globalLandTypes(state)
    .map((t) => BASIC_TYPE_COLOR[t])
    .filter((c): c is ManaColor => !!c)
}

/** How many artifacts a player controls (Mox Opal's metalcraft). */
export const controlledArtifacts = (state: RulesGameState, player: PlayerId) =>
  zoneArr(state, player, 'battlefield').filter((id) => getDef(state.objects[id]!.defName).types.includes('Artifact')).length

/**
 * The colours a `dynamicProduces` mana ability can currently make:
 * `yourLands` = every colour a land you control could produce (Reflecting Pool),
 * `yourLegendaries` = every colour among legendary creatures/planeswalkers you control (Mox Amber).
 */
export function dynamicManaColors(
  state: RulesGameState,
  player: PlayerId,
  kind: 'yourLands' | 'yourLegendaries' | 'imprinted',
  sourceId?: ObjId,
): ManaColor[] {
  const out = new Set<ManaColor>()
  // IMPRINT (Chrome Mox): the colours of the card this permanent exiled — nothing imprinted, no mana
  if (kind === 'imprinted') {
    const imprinted = sourceId ? state.objects[sourceId]?.imprintedDefName : undefined
    if (!imprinted) return []
    for (const c of getDef(imprinted).colors ?? []) out.add(c)
    return (['W', 'U', 'B', 'R', 'G', 'C'] as const).filter((c) => out.has(c))
  }
  for (const id of zoneArr(state, player, 'battlefield')) {
    const def = getDef(state.objects[id]!.defName)
    if (kind === 'yourLands') {
      if (!def.types.includes('Land')) continue
      for (const ab of def.abilities ?? []) if (ab.isMana) for (const c of ab.produces ?? []) out.add(c)
    } else {
      const isLegendary = def.supertypes?.includes('Legendary') ?? false
      if (!isLegendary || !(defIsCreature(def) || def.types.includes('Planeswalker'))) continue
      for (const c of def.colors ?? []) out.add(c)
    }
  }
  return (['W', 'U', 'B', 'R', 'G', 'C'] as const).filter((c) => out.has(c))
}

/** How many lands a player controls (Temple of the False God's activation condition). */
export const controlledLands = (state: RulesGameState, player: PlayerId) =>
  zoneArr(state, player, 'battlefield').filter((id) => defIsLand(getDef(state.objects[id]!.defName))).length

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
      // CR 704.5n: the host must still satisfy the Aura's ENCHANT restriction, which is its spell's
      // own target spec — "enchant land" (Wild Growth) is a legal attachment, so a creature-only check
      // would bin it the moment it entered. Equipment always equips creatures.
      const enchantSpec = isAura && !def.reanimatingAura ? def.spell?.targets?.[0] : undefined
      const hostOk =
        !!host &&
        host.zone === 'battlefield' &&
        (enchantSpec && enchantSpec.kind === 'permanent'
          ? matchesFilter(state, host, enchantSpec.filter, obj.controllerId)
          : defIsCreature(getDef(host.defName)) &&
            (!enchantSpec || enchantSpec.kind !== 'creature' || matchesFilter(state, host, enchantSpec.filter, obj.controllerId)))
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

/**
 * Open the next queued as-enters choice (CR 614.12 — the shocklands' "pay N life or it enters
 * tapped"), if any and if no other decision is open. Returns true when one was opened, so callers
 * know not to grant priority. Entries whose permanent already left the battlefield are dropped.
 */
function drainEntersChoices(state: RulesGameState): boolean {
  const queue = (state.entersChoiceQueue ??= [])
  while (queue.length && !state.pending) {
    const next = queue.shift()!
    const obj = state.objects[next.objId]
    if (!obj || obj.zone !== 'battlefield') continue // it left before the choice was made
    if (next.chooseType) {
      // "As this permanent enters, choose a creature type" — its own pending kind (r.chooseType)
      state.pending = { kind: 'typeChoice', player: next.player }
      state.pendingTypeChoice = { player: next.player, objId: next.objId }
      return true
    }
    if (next.discardOrBin) {
      // Mox Diamond (CR 614.12): "you may discard a land card instead; if you don't, put it into its
      // owner's graveyard" — the hand-choice machinery already renders the picker
      state.pending = { kind: 'handChoice', player: next.player }
      state.pendingHandChoice = {
        player: next.player,
        count: next.discardOrBin.count,
        filter: next.discardOrBin.filter,
        dest: 'graveyard',
        optional: true,
        sourceId: next.objId,
        binSourceIfNone: true,
      }
      return true
    }
    if (next.riot) {
      // RIOT (CR 702.137): a +1/+1 counter or haste (r.riot)
      state.pending = { kind: 'riot', player: next.player }
      state.pendingRiot = { player: next.player, objId: next.objId }
      return true
    }
    state.pending = { kind: 'entersChoice', player: next.player }
    state.pendingEntersChoice = next
    return true
  }
  return false
}

/**
 * "Whenever enchanted land is tapped for mana, its controller adds {G}." (Wild Growth) — CR 605.1b:
 * this is a triggered MANA ability, so it never uses the stack; the mana is added as part of the tap
 * that triggered it. Fires once per attached permanent that has the ability.
 */
function fireTappedForMana(state: RulesGameState, tappedId: ObjId) {
  const tapped = state.objects[tappedId]
  if (!tapped) return
  for (const obj of Object.values(state.objects)) {
    if (obj.zone !== 'battlefield' || obj.attachedTo !== tappedId || obj.phasedOut) continue
    if (state.loseAbilities.includes(obj.id)) continue
    const add = getDef(obj.defName).tappedForMana
    if (!add) continue
    state.players[tapped.controllerId]!.manaPool[add.color] += add.amount
    logLine(
      state,
      `${objName(state, obj.id)} adds ${add.amount} {${add.color}} for ${name(state, tapped.controllerId)} (${objName(state, tappedId)} was tapped for mana).`,
    )
  }
}

// ---------- forced sacrifice (edicts / aristocrats) ----------

/**
 * Open a forced-sacrifice prompt for the first player in `players` who controls a
 * creature; the remaining such players wait in a queue (each will be prompted to
 * sacrifice `count`). No-op if nobody controls a creature. Called from edict
 * effects at resolution — leaves `state.pending` set so resolveTop won't grant
 * priority until the sacrifice is made.
 */
export function openSacrifice(
  state: RulesGameState,
  players: PlayerId[],
  count: number,
  opts?: { thenReturnTapped?: ObjId[] },
) {
  const queue = players.filter((pid) => !state.players[pid]!.hasLost && battlefieldCreatures(state, pid).length > 0)
  if (!queue.length) return
  promptSacrifice(state, queue[0]!, queue.slice(1), count, opts)
}

function promptSacrifice(
  state: RulesGameState,
  player: PlayerId,
  queue: PlayerId[],
  count: number,
  opts?: { thenReturnTapped?: ObjId[] },
) {
  const candidates = battlefieldCreatures(state, player).map((c) => c.id)
  // store the ORIGINAL requested count; each player sacrifices min(count, their
  // creatures) — clamped at validation/display, so the queue threads count intact
  state.pending = { kind: 'sacrifice', player }
  state.pendingSacrifice = {
    player,
    candidateIds: candidates,
    count,
    queue,
    ...(opts?.thenReturnTapped ? { thenReturnTapped: [...opts.thenReturnTapped] } : {}),
  }
}

/** After a sacrifice resolves, prompt the next queued player, else hand priority back. */
function advanceSacrificeQueue(state: RulesGameState) {
  const rawQueue = state.pendingSacrifice?.queue ?? []
  const count = state.pendingSacrifice?.count ?? 1
  // a dies trigger from THIS sacrifice may already have opened its own decision (Blood Artist wants a
  // target): clearing `pending` blindly used to swallow it, so only the sacrifice's own pending is cleared
  const otherPending = state.pending && state.pending.kind !== 'sacrifice' ? state.pending : null
  state.pending = null
  state.pendingSacrifice = null
  if (otherPending) {
    state.pending = otherPending
    return
  }
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
export function openDiscard(state: RulesGameState, players: PlayerId[], count: number, thenUntapLands = 0) {
  const queue = players.filter((pid) => !state.players[pid]!.hasLost && zoneArr(state, pid, 'hand').length > 0)
  if (!queue.length) return
  promptDiscard(state, queue[0]!, queue.slice(1), count, thenUntapLands)
}
function promptDiscard(state: RulesGameState, player: PlayerId, queue: PlayerId[], count: number, thenUntapLands = 0) {
  state.pending = { kind: 'discard', player }
  state.pendingDiscard = { player, count, queue, ...(thenUntapLands ? { thenUntapLands } : {}) }
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
/**
 * Re-mint a COMMANDER's id as it enters a hidden zone (Command Beacon: command zone → hand). The plain
 * re-mint declines for a commander because commander identity is public and several tallies are keyed on
 * its object id — so this one migrates that bookkeeping (`commanderId` and every player's commander-damage
 * tally) onto the new id. Without it the old, publicly-seen id would sit in a hidden hand, which the
 * leak fuzzer flagged: an opponent who noted the command-zone id could follow the card into the hand.
 */
export function remintCommanderForHand(state: RulesGameState, oldId: ObjId) {
  const obj = state.objects[oldId]
  if (!obj || (obj.zone !== 'hand' && obj.zone !== 'library')) return
  const newId = mintCardId()
  const arr = zoneArr(state, obj.ownerId, obj.zone)
  const i = arr.indexOf(oldId)
  if (i >= 0) arr[i] = newId
  obj.id = newId
  state.objects[newId] = obj
  delete state.objects[oldId]
  for (const p of Object.values(state.players)) {
    if (p.commanderId === oldId) p.commanderId = newId
    if (Object.hasOwn(p.commanderDamage, oldId)) {
      p.commanderDamage[newId] = p.commanderDamage[oldId]!
      delete p.commanderDamage[oldId]
    }
  }
}

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
export function remintLibrary(state: RulesGameState, pid: PlayerId) {
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

/**
 * Chaos Warp: shuffle a permanent into its OWNER's library, then reveal the top card and put it
 * onto the battlefield if it is a permanent card. Battlefield → library is public → hidden, so the
 * shuffled permanent AND the whole library are re-minted (invariant #3): nobody may follow that id
 * into the library. The revealed card's NAME is public (a log line), which is exactly what the card
 * says; its id stays unserialised while it is in the library, and it is re-minted if it stays there.
 */
export function chaosWarpPermanent(state: RulesGameState, objId: ObjId) {
  const obj = state.objects[objId]
  if (!obj || obj.zone !== 'battlefield') return
  const owner = obj.ownerId
  const nm = getDef(obj.defName).name
  if (obj.isCommander) {
    // a commander never enters a hidden zone (it would keep its stable, broadcast id)
    moveTo(state, objId, 'command')
    logLine(state, `${nm} returns to the command zone instead of being shuffled away.`)
    return
  }
  moveTo(state, objId, 'library')
  remintForHiddenEntry(state, objId, true) // public → hidden: fresh id
  const lib = zoneArr(state, owner, 'library')
  shuffleInPlace(lib)
  remintLibrary(state, owner)
  logLine(state, `${nm} is shuffled into ${name(state, owner)}'s library.`)
  const topId = lib[0]
  if (!topId) return
  const topDef = getDef(state.objects[topId]!.defName)
  logLine(state, `${name(state, owner)} reveals ${topDef.name}.`)
  if (defIsPermanent(topDef)) {
    state.objects[topId]!.controllerId = owner
    state.objects[topId]!.summoningSick = defIsCreature(topDef)
    moveTo(state, topId, 'battlefield')
    logLine(state, `${topDef.name} enters the battlefield.`)
    fireEntersTriggers(state, topId)
  } else {
    // it stays on top, revealed — re-mint so the publicly revealed id can't be tracked later
    remintForHiddenEntry(state, topId, true)
  }
  checkSBA(state)
}

/**
 * CR 103.6: after the last player keeps and BEFORE turn 1 begins, a player holding a card that says
 * "if this card is in your opening hand, you may begin the game with it on the battlefield" is offered
 * that choice. Gemstone Caverns adds "and you're not the starting player". Offered one player at a
 * time in turn order; `queue` holds the rest.
 */
function openingPlayOffer(state: RulesGameState, pid: PlayerId): ObjId | null {
  const starting = state.turnOrder[0]
  for (const id of zoneArr(state, pid, 'hand')) {
    const def = getDef(state.objects[id]!.defName)
    const bg = def.beginGameOnBattlefield
    if (!bg) continue
    if (bg.onlyIfNotStartingPlayer && pid === starting) continue
    return id
  }
  return null
}

/** Open the next eligible player's opening-hand offer; returns false when nobody is left to ask. */
function advanceOpeningPlays(state: RulesGameState, queue: PlayerId[]): boolean {
  const rest = [...queue]
  while (rest.length) {
    const pid = rest.shift()!
    if (state.players[pid]!.hasLost) continue
    const objId = openingPlayOffer(state, pid)
    if (!objId) continue
    state.pending = { kind: 'openingPlay', player: pid }
    state.pendingOpeningPlay = { player: pid, objId, defName: state.objects[objId]!.defName, queue: rest }
    return true
  }
  return false
}

/** Leave the mulligan phase and begin turn 1 once every remaining player has kept. */
function finishMulligans(state: RulesGameState) {
  logLine(state, 'All players have kept — the game begins.')
  // the opening-hand offers happen while the game is still in its pre-game state, so an accepted
  // permanent is on the battlefield before turn 1's untap step
  if (advanceOpeningPlays(state, state.turnOrder)) return
  state.status = 'active'
  startGame(state)
}

/** Every opening-hand offer answered → begin turn 1. */
function finishOpeningPlays(state: RulesGameState) {
  state.pending = null
  state.pendingOpeningPlay = null
  state.status = 'active'
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
    const entersChoiceObjId = state.pendingEntersChoice?.objId
    const optionalPay = state.pendingOptionalPay
    state.pendingPutBack = null // a departed player's put-back lapses (their cards left with them)
    state.pending = null
    state.pendingTrigger = null // a departed player's trigger is removed
    state.pendingScry = null
    state.pendingWard = null
    state.pendingCascade = null
    state.pendingEntersChoice = null
    state.pendingOptionalPay = null
    // a departed player's hideaway look / free-play offer lapses: the cards they were looking at stay
    // in their library, which leaves the game with them (removePlayersObjects)
    state.pendingHideaway = null
    state.pendingFreePlay = null
    state.pendingOpeningPlay = null
    state.pendingRiot = null
    if (kind === 'optionalPay') {
      // the payer left → they can't pay, so the ability happens for its controller
      if (optionalPay && !state.players[optionalPay.beneficiary]!.hasLost) {
        const d = getDef(optionalPay.defName)
        const ab =
          optionalPay.trigger === 'delayed'
            ? d.delayed?.[optionalPay.delayedKey ?? '']
            : optionalPay.trigger === 'draw'
              ? d.drawnCard
              : d.castSpell
        ab?.effect({ state, controllerId: optionalPay.beneficiary, sourceId: optionalPay.sourceId, targets: [] })
      }
      grantPriority(state, state.activePlayer)
    } else if (kind === 'entersChoice') {
      // the chooser left → treat it as a decline (the permanent is tapped), then carry on
      const obj = entersChoiceObjId ? state.objects[entersChoiceObjId] : undefined
      if (obj && obj.zone === 'battlefield') obj.tapped = true
      if (!drainDecisions(state)) grantPriority(state, state.activePlayer)
    } else if (kind === 'ward') {
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
      p.noncreatureSpellsThisTurn = 0
      p.extraLandsThisTurn = 0
      p.spellsThisTurn = 0
      p.createdTokenThisTurn = false // Idol of Oblivion: "only if you created a token this turn"
      // "until your next turn" — Teferi's Protection / The One Ring's shield ends as that turn begins
      if (p.protectedFromEverything || p.lifeCantChange) {
        p.protectedFromEverything = false
        p.lifeCantChange = false
        logLine(state, `${p.name}'s protection from everything ends.`)
      }
      // CR 502.1 — phasing happens FIRST, before permanents untap
      runPhasing(state, ap)
      for (const obj of Object.values(state.objects)) {
        if (obj.zone === 'battlefield' && obj.controllerId === ap && !obj.phasedOut) {
          // "This permanent doesn't untap during your untap step." (Mana Vault, the Monoliths)
          if (!getDef(obj.defName).doesNotUntap) obj.tapped = false
          obj.summoningSick = false
          obj.loyaltyActivatedThisTurn = false
      obj.triggeredThisTurn = false // a new turn re-enables one loyalty ability per PW
        }
      }
      // no player receives priority during untap
      nextStep(state)
      return
    }
    case 'draw': {
      // "except the first card they draw in EACH of their draw steps" — count afresh per draw step
      state.players[ap]!.drawsThisDrawStep = 0
      // "At the beginning of your draw step, …" (Mana Vault's self-damage) — before the draw
      for (const id of [...state.zones.perPlayer[ap]!.battlefield]) {
        if (!getDef(state.objects[id]?.defName ?? '').drawStep) continue
        queueTriggeredAbility(state, id, 'drawStep')
      }
      const isVeryFirstDraw = state.turnNumber === 1 && ap === state.turnOrder[0] && state.firstTurnSkipDraw
      if (isVeryFirstDraw) logLine(state, `${name(state, ap)} skips the first draw.`)
      else if (!state.players[ap]!.hasLost) {
        drawOne(state, ap)
        logLine(state, `${name(state, ap)} draws a card.`)
      }
      grantPriority(state, ap)
      return
    }
    case 'begin_combat': {
      // "At the beginning of combat on your turn, …" (CR 506.1) — Helm of the Host, The Ozolith
      for (const id of [...state.zones.perPlayer[ap]!.battlefield]) {
        if (!getDef(state.objects[id]?.defName ?? '').beginCombat) continue
        queueTriggeredAbility(state, id, 'beginCombat')
        if (state.pending) break // a targeted one waits for its choice (the rest are dropped)
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
      if (fireDelayedTriggers(state, 'nextUpkeep')) return // a pay-or-else decision is open
      if (fireCumulativeUpkeep(state)) return // cumulative upkeep: pay-or-sacrifice comes first
      fireUpkeepTriggers(state) // "at the beginning of your upkeep" triggers onto the stack
      advanceSuspend(state) // CR 702.62c/d: remove a time counter from each suspended card; cast at 0
      // a targeted upkeep trigger sets pending → its controller chooses first
      if (!state.pending) grantPriority(state, ap)
      return
    }
    case 'main1': {
      if (fireDelayedTriggers(state, 'nextMainPhase')) return // Mana Drain's mana / a pay-or-else
      // "At the beginning of your first main phase, …" (Black Market Connections)
      for (const id of [...state.zones.perPlayer[ap]!.battlefield]) {
        if (!getDef(state.objects[id]?.defName ?? '').firstMain) continue
        queueTriggeredAbility(state, id, 'firstMain')
        if (state.pending) break
      }
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
  state.grantedTriggers = [] // granted "until end of turn" triggered abilities wear off
  expireImpulseWindows(state) // "you may play them this turn" / "…until the end of your next turn"
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
      // "you gain protection from everything" (Teferi's Protection, The One Ring): all damage to that
      // player is prevented — CR 702.16e — so nothing is dealt and no lifelink is gained
      if (victim.protectedFromEverything) {
        logLine(state, `${victim.name} has protection from everything — ${hit.amount} damage prevented.`)
        continue
      }
      dealt = true
      if (infect) {
        // infect deals damage to players as poison counters, not life loss (CR 702.90b) — and
        // it is NOT commander damage
        victim.poison += hit.amount
        logLine(state, `${victim.name} gets ${hit.amount} poison counter${hit.amount === 1 ? '' : 's'} (${victim.poison} total).`)
      } else if (hit.fromCommander) {
        changeLife(state, hit.target as PlayerId, -hit.amount)
        victim.commanderDamage[hit.fromCommander] = (victim.commanderDamage[hit.fromCommander] ?? 0) + hit.amount
        logLine(state, `${victim.name} takes ${hit.amount} commander damage (${victim.commanderDamage[hit.fromCommander]} total).`)
      } else {
        changeLife(state, hit.target as PlayerId, -hit.amount)
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
        putCounters(state, t.id, '-1/-1', hit.amount)
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
        changeLife(state, controller, hit.amount)
        logLine(state, `${state.players[controller]!.name} gains ${hit.amount} life (lifelink).`)
      }
    }
  }
  fireCombatDamageTriggers(state, hits)
}

/** One assignment of combat damage: who dealt it, to what, how much (and as which commander). */
type Hit = { source: ObjId; target: ObjId | PlayerId; amount: number; fromCommander?: ObjId }

/**
 * "Whenever … deals combat damage to a player, …" (CR 603.2) — fired after a whole damage sub-step
 * has been applied, so all of it is simultaneous. Three wordings, in the order a player reads them:
 *   - the creature itself (`combatDamage` with no watch),
 *   - the creature an Equipment/Aura is attached to (`watch.scope: 'attachedCreature'`),
 *   - "one or more creatures you control" (`watch.scope: 'anyCreature'`), which triggers ONCE per
 *     damaged player however many of that player's attackers connected.
 * Each trigger receives the damaged player as its implicit target when it declares no targets.
 */
function fireCombatDamageTriggers(state: RulesGameState, hits: Hit[]) {
  const toPlayers = hits.filter((h) => h.amount > 0 && Object.hasOwn(state.players, h.target))
  if (!toPlayers.length) return
  for (const hit of toPlayers) {
    const src = state.objects[hit.source]
    if (!src) continue
    const victim = hit.target as PlayerId
    if (getDef(src.defName).combatDamage && !getDef(src.defName).combatDamage!.watch) {
      queueTriggeredAbility(state, src.id, 'combatDamage', [victim])
    }
    for (const att of Object.values(state.objects)) {
      if (att.zone !== 'battlefield' || att.attachedTo !== src.id) continue
      if (getDef(att.defName).combatDamage?.watch?.scope === 'attachedCreature')
        queueTriggeredAbility(state, att.id, 'combatDamage', [victim])
    }
  }
  // the "one or more creatures you control" wording: one trigger per (source permanent, victim)
  for (const watcher of Object.values(state.objects)) {
    if (watcher.zone !== 'battlefield') continue
    const ability = getDef(watcher.defName).combatDamage
    if (ability?.watch?.scope !== 'anyCreature') continue
    const victims = new Set<PlayerId>()
    for (const hit of toPlayers) {
      const src = state.objects[hit.source]
      if (!src) continue
      if (ability.watch.controllerOnly && src.controllerId !== watcher.controllerId) continue
      victims.add(hit.target as PlayerId)
    }
    for (const victim of victims) queueTriggeredAbility(state, watcher.id, 'combatDamage', [victim])
  }
}

// ---------- the stack ----------

function resolveTop(state: RulesGameState) {
  const item = state.zones.stack.pop()
  if (!item) return
  state.passed = []
  if (item.kind === 'spell') resolveSpell(state, item)
  else if (item.kind === 'ability') resolveAbility(state, item)
  drainDecisions(state) // an as-enters choice, else a deferred extra trigger instance
  // a targeted trigger sets `pending` for its controller's choice — don't grant
  // priority until they've chosen (r.chooseTargets does it)
  if (!state.pending) grantPriority(state, state.activePlayer)
}

/** The triggered ability on `def` for a given trigger kind. */
function abilityFor(def: CardDefinition, kind: StackItem['trigger']) {
  return kind === 'dies' ? def.dies
    : kind === 'attacks' ? def.attacks
    : kind === 'upkeep' ? def.upkeep
    : kind === 'cast' ? def.castSpell
    : kind === 'draw' ? def.drawnCard
    : kind === 'landfall' ? def.landEnters
    : kind === 'combatDamage' ? def.combatDamage
    : kind === 'drawStep' ? def.drawStep
    : kind === 'beginCombat' ? def.beginCombat
    : kind === 'leavesBattlefield' ? def.leavesBattlefield
    : kind === 'etbWatch' ? def.entersWatch
    : kind === 'firstMain' ? def.firstMain
    : def.enters
}

const TRIGGER_LABEL: Record<NonNullable<StackItem['trigger']>, string> = {
  etb: 'enters-the-battlefield',
  dies: 'dies',
  attacks: 'attacks',
  upkeep: 'upkeep',
  cast: 'cast',
  draw: 'draw',
  landfall: 'landfall',
  combatDamage: 'combat damage',
  drawStep: 'draw step',
  beginCombat: 'beginning of combat',
  leavesBattlefield: 'leaves-the-battlefield',
  etbWatch: 'enters-the-battlefield',
  firstMain: 'first main phase',
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
  // a CHANNEL ability (the card was discarded as its cost): run its effect, honouring targets
  if (item.channel) {
    const cd = getDef(item.defName).channel
    if (cd) {
      const specs = flattenSpecs(cd.targets)
      let targets = item.targets
      if (specs.length) {
        targets = item.targets.filter((t, i) => specs[i] && isLegalTarget(state, specs[i]!, t, item.controllerId, getDef(item.defName).colors ?? []))
        // an all-optional target list may legitimately be empty (Takenuma channelled for the mill
        // alone) — only a chosen-but-now-illegal target fizzles the ability
        if (!targets.length && !(specs.every((sp) => sp.optional) && item.targets.length === 0)) {
          logLine(state, `${getDef(item.defName).name}'s channel ability fizzles (targets are gone).`)
          checkSBA(state)
          return
        }
      }
      cd.effect({ state, controllerId: item.controllerId, sourceId: item.sourceId, targets })
    }
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
  // a MODAL trigger (Black Market Connections): its controller chooses the modes, then the chosen ones
  // resolve in printed order — the same rule a modal spell follows (CR 601.2b)
  if (item.trigger === 'firstMain' || item.trigger === 'landfall') {
    const def0 = getDef(item.defName)
    const ability = item.trigger === 'firstMain' ? def0.firstMain : def0.landEnters
    if (ability?.modes?.length) {
      state.pending = { kind: 'modes', player: item.controllerId }
      state.pendingModes = {
        player: item.controllerId,
        sourceId: item.sourceId,
        sourceName: def0.name,
        defName: item.defName,
        trigger: item.trigger,
        count: ability.modeRule?.count ?? 1,
        oneOrMore: !!ability.modeRule?.oneOrMore,
        labels: ability.modes.map((m) => m.label),
      }
      logLine(state, `${def0.name}: ${name(state, item.controllerId)} chooses its mode${ability.modes.length > 1 ? 's' : ''}.`)
      return
    }
  }
  // a GRANTED triggered ability (Malakir Rebirth's "when this creature dies, …"): the body comes from
  // the granting card, the source is the permanent that gained it
  if (item.grantedKey) {
    const ability = getDef(item.defName).grantedAbilities?.[item.grantedKey]
    if (ability) ability.effect({ state, controllerId: item.controllerId, sourceId: item.sourceId, targets: item.targets })
    checkSBA(state)
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
  // "At the beginning of your upkeep, you may pay {4}. If you do, untap this artifact." (Mana Vault):
  // the mirror of unlessPay — the effect happens only when the cost IS paid
  if (item.trigger === 'upkeep') {
    const ability = getDef(item.defName).upkeep
    if (ability?.mayPay && !state.players[item.controllerId]!.hasLost) {
      state.pending = { kind: 'optionalPay', player: item.controllerId }
      state.pendingOptionalPay = {
        player: item.controllerId,
        beneficiary: item.controllerId,
        cost: ability.mayPay,
        defName: item.defName,
        sourceId: item.sourceId,
        trigger: 'upkeep',
        effectOnPay: true,
      }
      logLine(state, `${getDef(item.defName).name}: ${name(state, item.controllerId)} may pay ${ability.mayPay}.`)
      return
    }
  }
  // cast-trigger with an "…unless that player pays {N}" clause (Rhystic Study, Esper Sentinel):
  // open the decision for the player who cast the spell; the effect happens only if they decline.
  if (item.trigger === 'cast' || item.trigger === 'draw') {
    const d = getDef(item.defName)
    const cd = item.trigger === 'draw' ? d.drawnCard : d.castSpell
    const payer = item.castPayer
    if (cd && (cd.unlessPay || cd.unlessPayFromPower) && payer && !state.players[payer]!.hasLost) {
      const src = state.objects[item.sourceId]
      const cost = 'unlessPayFromPower' in cd && cd.unlessPayFromPower
        ? `{${src && src.zone === 'battlefield' ? Math.max(0, currentPower(state, src)) : 0}}`
        : cd.unlessPay!
      state.pending = { kind: 'optionalPay', player: payer }
      state.pendingOptionalPay = { player: payer, beneficiary: item.controllerId, cost, defName: item.defName, sourceId: item.sourceId, trigger: item.trigger }
      logLine(state, `${getDef(item.defName).name}: ${name(state, payer)} may pay ${cost}.`)
      return
    }
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
      // an all-optional ability that was put on the stack with no target simply does nothing
      const declined = specs.every((sp) => sp.optional) && item.targets.length === 0
      logLine(state, declined ? `${def.name}'s ability is declined.` : `${def.name}'s ability fizzles (targets are gone).`)
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
  // MULTI-mode (CR 700.2 / 608.2c): each chosen mode resolves in printed order, taking its own
  // slice of the target list. A mode whose targets have all become illegal is skipped (only that
  // mode "fizzles"); the spell itself still resolves, so it always goes to the graveyard below.
  if (item.modes?.length && def.modes?.length) {
    let at = 0
    for (const i of item.modes) {
      const mode = def.modes[i]
      if (!mode) continue
      const specs = flattenSpecs(mode.targets)
      const slice = item.targets.slice(at, at + specs.length)
      at += specs.length
      const stillLegal = slice.filter((t, k) => specs[k] && isLegalTarget(state, specs[k]!, t, item.controllerId, def.colors ?? []))
      if (specs.length && !stillLegal.length) {
        logLine(state, `${def.name}'s "${mode.label}" does nothing (no legal target).`)
        continue
      }
      logLine(state, `${def.name} — ${mode.label}.`)
      mode.effect({ state, controllerId: item.controllerId, sourceId: item.id, targets: stillLegal, x: item.x, kicked: item.kicked })
    }
    spellToRest(state, obj.id, item)
    checkSBA(state)
    return
  }
  // overload (CR 702.96): the untargeted "each" body replaces the printed, targeted one
  const chosen = item.overloaded && def.overload ? { targets: undefined, effect: def.overload.effect } : activeSpell(def, item.mode)
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
    // Animate Dead: the Aura's target is a creature CARD IN A GRAVEYARD — put it onto the battlefield
    // under the Aura's controller first, then attach to it (the object keeps its id: graveyard and
    // battlefield are both public, so no re-mint is due)
    if (def.reanimatingAura) {
      const cardId = stillLegal[0] as ObjId
      const card = state.objects[cardId]
      if (card && card.zone === 'graveyard') {
        card.controllerId = item.controllerId
        moveTo(state, cardId, 'battlefield')
        card.summoningSick = true
        logLine(state, `${objName(state, cardId)} returns to the battlefield under ${name(state, item.controllerId)}'s control.`)
        fireEntersTriggers(state, cardId)
      }
      auraTarget = cardId
    }
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
    obj.enteredByCast = true // The One Ring's ETB reads this ("if you cast it")
    if (auraTarget) obj.attachedTo = auraTarget // set AFTER moveTo (which clears attachedTo)
    // MULTIKICKER: "enters with a charge counter for each time it was kicked" (Everflowing Chalice)
    if (def.entersWithCounterPerKick && item.kickedCount)
      putCounters(state, obj.id, def.entersWithCounterPerKick, item.kickedCount)
    // RIOT (CR 702.137) — printed on the card, or granted to your creature SPELLS by another
    // permanent (Rhythm of the Wild). Only a creature that resolved as a spell can have it, which is
    // exactly this path; queued like the shocklands' as-enters choice so several are asked in turn.
    if (
      defIsCreature(def) &&
      (def.riot ||
        zoneArr(state, item.controllerId, 'battlefield').some(
          (id) => getDef(state.objects[id]!.defName).grantsRiotToYourCreatureSpells,
        ))
    )
      (state.entersChoiceQueue ??= []).push({ player: item.controllerId, objId: obj.id, life: 0, riot: true })
    // (entersTapped is applied by moveTo for every entry path)
    fireEntersTriggers(state, obj.id) // a face-down creature has no own ETB (guarded in fireEntersTriggers)
    // (a Saga's first lore counter + chapter I are added by moveTo, on every entry path)
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
      if (!p) continue
      // landfall: "whenever a LAND YOU CONTROL enters" (Rampaging Baloths). Checked BEFORE the ETB
      // branch bails out — a landfall permanent usually has no `enters` ability of its own.
      if (getDef(p.defName).landEnters && defIsLand(getDef(subject.defName)) && subject.controllerId === p.controllerId)
        queueTriggeredAbility(state, p.id, 'landfall')
      const ab = getDef(p.defName).enters
      const isSelf = p.id === subjectId
      const w = ab?.watch
      // NOTE: this must NOT bail out when the permanent has no `enters` ability — a card whose only
      // ETB-adjacent ability is the separate `entersWatch` below (The Great Henge) would never fire.
      const fires = !ab
        ? false
        : !w
          ? isSelf && !subject.faceDown // plain ETB — a face-down creature has no own ETB (CR 707.2)
          : subjectIsCreature &&
            !(w.excludeSelf && isSelf) &&
            !(w.controllerOnly && subject.controllerId !== p.controllerId) &&
            // "whenever a creature WITH POWER 4 OR GREATER you control enters" (Garruk's Uprising)
            (w.minPower == null || currentPower(state, subject) >= w.minPower) &&
            !(w.nontokenOnly && isTokenDefName(subject.defName))
      if (fires) queueTriggeredAbility(state, p.id, 'etb', undefined, subjectId)
      // a separate ETB WATCHER, for a card that also has its own enters trigger (Garruk's Uprising)
      const watcher = getDef(p.defName).entersWatch
      const ww = watcher?.watch
      if (
        watcher &&
        ww &&
        subjectIsCreature &&
        !(ww.excludeSelf && isSelf) &&
        !(ww.controllerOnly && subject.controllerId !== p.controllerId) &&
        (ww.minPower == null || currentPower(state, subject) >= ww.minPower) &&
        !(ww.nontokenOnly && isTokenDefName(subject.defName))
      )
        // the ENTERING creature rides along as an implicit target, so a watcher can act on it
        // ("put a +1/+1 counter on it and draw a card" — The Great Henge)
        queueTriggeredAbility(state, p.id, 'etbWatch', [subjectId], subjectId)
    }
  }
}

/**
 * "Whenever an opponent casts a spell, …" (CR 603.2). Called from r.cast once the spell is on the
 * stack: each matching battlefield permanent's ability goes ABOVE it, so the trigger resolves
 * first (that is what lets Rhystic Study tax the spell before it resolves). `castPayer` records who
 * cast the spell — the player who may pay the "unless" cost.
 */
function queueCastTriggers(state: RulesGameState, caster: PlayerId, spellDef: CardDefinition) {
  const isCreatureSpell = spellDef.types.includes('Creature')
  for (const pid of state.turnOrder) {
    for (const id of [...state.zones.perPlayer[pid]!.battlefield]) {
      const p = state.objects[id]
      const ab = p && getDef(p.defName).castSpell
      if (!p || !ab || p.phasedOut || state.loseAbilities.includes(p.id)) continue
      const w = ab.watch
      if (w?.opponentsOnly && p.controllerId === caster) continue
      if (w?.selfOnly && p.controllerId !== caster) continue // "whenever YOU cast…" (Beast Whisperer)
      if (w?.noncreatureOnly && isCreatureSpell) continue
      if (w?.creatureOnly && !isCreatureSpell) continue
      if (w?.typesOnly?.length && !w.typesOnly.some((t) => spellDef.types.includes(t))) continue
      // "whenever you cast a creature spell OF THE CHOSEN TYPE" (Vanquisher's Banner)
      if (w?.chosenTypeOnly) {
        const chosen = state.objects[id]?.chosenType
        if (!chosen || !spellDef.types.includes('Creature') || !hasCreatureType(spellDef, chosen)) continue
      }
      // "their FIRST noncreature spell each turn" — the counter is incremented by r.cast before
      // this runs, so the first such spell of the turn is the one that makes it 1
      if (w?.firstEachTurn && (state.players[caster]!.noncreatureSpellsThisTurn ?? 0) !== 1) continue
      state.zones.stack.push({
        id: mintCardId(),
        kind: 'ability',
        trigger: 'cast',
        controllerId: p.controllerId,
        defName: p.defName,
        sourceId: p.id,
        abilityIndex: null,
        targets: [],
        castPayer: caster,
      })
      logLine(state, `${getDef(p.defName).name}'s cast ability triggers.`)
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
/** Does this PERMANENT have creature type `type`? (changeling, plus Roaming Throne's own chosen type) */
export function objHasCreatureType(state: RulesGameState, obj: GameObject, type: string): boolean {
  const def = getDef(obj.defName)
  if (def.isChosenTypeItself && obj.chosenType === type) return true
  return hasCreatureType(def, type)
}

/**
 * How many extra instances a triggered ability from `sourceId` gets (Roaming Throne). The doubler must be a
 * DIFFERENT permanent, under the same controller, and the source must be a creature of the type it chose.
 */
function extraTriggerInstances(state: RulesGameState, sourceId: ObjId, enteringSubjectId?: ObjId): number {
  const src = state.objects[sourceId]
  if (!src) return 0
  const srcIsCreature = defIsCreature(getDef(src.defName))
  // Panharmonicon: "if an ARTIFACT OR CREATURE ENTERING causes a triggered ability of a permanent you
  // control to trigger, that ability triggers an additional time". Only the ETB paths pass the entering
  // object, so its presence IS the "caused by something entering" test; its types do the rest.
  const subject = enteringSubjectId ? state.objects[enteringSubjectId] : undefined
  const subjectDef = subject ? getDef(subject.defName) : undefined
  const enteringQualifies = !!subjectDef && (subjectDef.types.includes('Artifact') || subjectDef.types.includes('Creature'))
  let extra = 0
  for (const id of zoneArr(state, src.controllerId, 'battlefield')) {
    const doubler = state.objects[id]
    if (!doubler || doubler.phasedOut || state.loseAbilities.includes(id)) continue
    const def = getDef(doubler.defName)
    if (def.doublesEnterTriggers && enteringQualifies) {
      extra++ // Panharmonicon doubles its OWN ETB-caused triggers too (it is "a permanent you control")
      continue
    }
    if (id === sourceId) continue // the chosen-type doubler says "ANOTHER creature you control"
    if (!def.doublesChosenTypeTriggers || !doubler.chosenType) continue
    if (!srcIsCreature) continue
    if (!defIsCreature(def)) continue // "another CREATURE you control" is the doubler's own requirement
    if (objHasCreatureType(state, src, doubler.chosenType)) extra++
  }
  return extra
}

/**
 * Put any extra trigger instances that were deferred (because the first one opened a target choice) on the
 * stack now. Called wherever a pending is resolved, so they land as soon as the engine is free.
 */
export function drainExtraTriggers(state: RulesGameState): boolean {
  const queue = state.extraTriggerQueue
  while (queue.length && !state.pending) {
    const next = queue.shift()!
    // emit DIRECTLY: re-entering queueTriggeredAbility would re-run its gates — a once-per-turn ability
    // (Morbid Opportunist) would be swallowed by its own `triggeredThisTurn` flag, and an intervening
    // "if" would be re-checked against a board that has since changed (CR 603.4 checks it as it triggers)
    emitTriggerInstance(state, next.sourceId, next.kind, next.targets)
  }
  return !!state.pending
}

/** Open the next queued decision: as-enters choices first, then any deferred extra trigger instances. */
function drainDecisions(state: RulesGameState): boolean {
  return drainEntersChoices(state) || drainExtraTriggers(state)
}

export function queueTriggeredAbility(
  state: RulesGameState,
  sourceId: ObjId,
  kind: NonNullable<StackItem['trigger']>,
  implicitTargets?: (ObjId | PlayerId)[],
  /** for an ETB trigger: the object whose entry caused it (Panharmonicon reads its types) */
  subjectId?: ObjId,
) {
  const obj = state.objects[sourceId]
  if (!obj) return
  const def = getDef(obj.defName)
  const ability = abilityFor(def, kind)
  if (!ability) return
  // an intervening "if" clause (Land Tax) — a false condition means it never triggers
  if ('condition' in ability && ability.condition && !ability.condition(state, obj.controllerId, sourceId)) return
  // "This ability triggers only once each turn." (Morbid Opportunist)
  if ('oncePerTurn' in ability && ability.oncePerTurn) {
    if (obj.triggeredThisTurn) return
    obj.triggeredThisTurn = true
  }
  const label = TRIGGER_LABEL[kind]
  const specs = flattenSpecs(ability.targets)
  // Roaming Throne: "…it triggers an additional time" — the count is decided ONCE, as the ability
  // triggers. The first instance is emitted now; a TARGETED extra waits in extraTriggerQueue, because the
  // engine holds a single pending at a time, and is emitted as soon as the previous choice is answered.
  const extra = extraTriggerInstances(state, sourceId, subjectId)
  emitTriggerInstance(state, sourceId, kind, implicitTargets)
  if (extra > 0) {
    for (let i = 0; i < extra; i++) {
      if (specs.length) state.extraTriggerQueue.push({ sourceId, kind, targets: [...(implicitTargets ?? [])] })
      else emitTriggerInstance(state, sourceId, kind, implicitTargets)
    }
    logLine(state, `${def.name}'s ${label} ability triggers an additional time.`)
  }
  return
}

/**
 * Put ONE instance of a triggered ability on the stack (or open its target choice). The gates — the
 * intervening "if", once-per-turn — live in `queueTriggeredAbility` and are deliberately NOT re-run here,
 * so a doubled or deferred instance behaves like the one that triggered with it.
 */
function emitTriggerInstance(
  state: RulesGameState,
  sourceId: ObjId,
  kind: NonNullable<StackItem['trigger']>,
  implicitTargets?: (ObjId | PlayerId)[],
) {
  const obj = state.objects[sourceId]
  if (!obj) return
  const def = getDef(obj.defName)
  const ability = abilityFor(def, kind)
  if (!ability) return
  const controllerId = obj.controllerId
  const label = TRIGGER_LABEL[kind]
  const specs = flattenSpecs(ability.targets)
  if (!specs.length) {
    // a combat-damage trigger with no target specs receives the DAMAGED PLAYER implicitly, so
    // "that player discards a card" resolves without asking anyone to choose
    state.zones.stack.push({
      id: mintCardId(),
      kind: 'ability',
      trigger: kind,
      controllerId,
      defName: obj.defName,
      sourceId,
      abilityIndex: null,
      targets: implicitTargets ? [...implicitTargets] : [],
    })
    logLine(state, `${def.name}'s ${label} ability triggers.`)
    return
  }
  if (specs.every((sp) => sp.optional) && !specs.every((spec) => hasAnyLegalTarget(state, spec, controllerId, def.colors ?? []))) {
    // optional targeting with nothing legal: the trigger still goes on the stack, targetless
    state.zones.stack.push({ id: mintCardId(), kind: 'ability', trigger: kind, controllerId, defName: obj.defName, sourceId, abilityIndex: null, targets: [] })
    logLine(state, `${def.name}'s ${label} ability triggers (no target).`)
    return
  }
  if (!specs.every((spec) => hasAnyLegalTarget(state, spec, controllerId, def.colors ?? []))) {
    logLine(state, `${def.name}'s trigger has no legal target and is removed.`)
    return
  }
  // only ONE decision can be open at a time, so a targeted instance that arrives while another is
  // pending waits in extraTriggerQueue (drained by drainDecisions). Several instances of the same
  // trigger can arrive back-to-back — a doubled trigger, or one watcher firing per card of a
  // multi-card draw (Orcish Bowmasters vs Divination) — and clobbering the open pending lost one.
  if (state.pending) {
    state.extraTriggerQueue.push({ sourceId, kind, targets: [...(implicitTargets ?? [])] })
    logLine(state, `${def.name}'s ${label} ability triggers (waiting for the current choice).`)
    return
  }
  state.pending = { kind: 'trigger', player: controllerId }
  state.pendingTrigger = { sourceId, defName: obj.defName, controllerId, trigger: kind }
  logLine(state, `${def.name}'s ${label} ability triggers — ${name(state, controllerId)} chooses a target.`)
}

/** Chapter I of a Saga that has just entered (CR 714.2b) — called from moveTo on every entry path. */
export function queueSagaChapterOnEntry(state: RulesGameState, objId: ObjId) {
  queueSagaChapter(state, objId, 1)
}

/**
 * Put a GRANTED triggered ability on the stack — one a permanent gained until end of turn (Malakir
 * Rebirth: 'that creature gains "When this creature dies, …"'). The body lives in the granting card's
 * `grantedAbilities`, but the ability's SOURCE is the permanent that gained it (its effect reads
 * ctx.sourceId), and its controller is that permanent's controller.
 */
export function queueGrantedTrigger(state: RulesGameState, objId: ObjId, defName: string, key: string) {
  const obj = state.objects[objId]
  if (!obj) return
  const ability = getDef(defName).grantedAbilities?.[key]
  if (!ability) return
  const controllerId = obj.controllerId
  // a GRANTED dies ability is still "a triggered ability of a creature you control", so Roaming Throne
  // doubles it as well; these bodies never target, so no deferral is needed
  // a granted DIES ability isn't caused by anything entering, so no subject → no Panharmonicon
  const copies = 1 + extraTriggerInstances(state, objId)
  for (let i = 0; i < copies; i++) {
    state.zones.stack.push({
      id: mintCardId(),
      kind: 'ability',
      trigger: 'dies',
      controllerId,
      defName,
      sourceId: objId,
      abilityIndex: null,
      grantedKey: key,
      targets: [],
    })
  }
  logLine(
    state,
    `${getDef(obj.defName).name}'s granted dies ability triggers${copies > 1 ? ` ${copies} times` : ''}.`,
  )
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
    // ward is a triggered ability of that permanent, so its controller's Roaming Throne doubles it: the
    // caster then faces the cost twice (each ward ability is its own pay-or-counter decision)
    // ward is a "becomes the target" trigger, not an entry one → only the chosen-type doubler applies
    const copies = 1 + extraTriggerInstances(state, obj.id)
    for (let i = 0; i < copies; i++) {
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
    }
    logLine(state, `${getDef(obj.defName).name}'s ward triggers${copies > 1 ? ` ${copies} times` : ''}.`)
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
  opts: { reason?: 'cascade' | 'suspend' | 'hideaway'; suspendHaste?: boolean } = {},
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
  // a global type grant (Urborg) makes EVERY land that type, so swampwalk turns on for everyone
  const granted = globalLandTypes(state).includes(subtype)
  return state.zones.perPlayer[player]!.battlefield.some((id) => {
    const def = getDef(state.objects[id]!.defName)
    return defIsLand(def) && (granted || (def.subtypes?.includes(subtype) ?? false))
  })
}
const sharesColor = (a: CardDefinition, b: CardDefinition): boolean => (a.colors ?? []).some((c) => (b.colors ?? []).includes(c))
/** Colours this permanent has protection from — printed (`def.protectionFrom`) + granted (until-EOT
 *  `state.protectionGrants`, CR 613 layer 6). */
const protectionColorsOf = (state: RulesGameState, obj: GameObject): ManaColor[] => [
  ...(getDef(obj.defName).protectionFrom ?? []),
  ...state.protectionGrants.filter((g) => g.objId === obj.id).map((g) => g.color),
  // "Equipped creature has protection from black and from green" (the Swords) — a static grant from
  // whatever is attached to this permanent (CR 613 layer 6), like grantsToHost's keywords
  ...Object.values(state.objects).flatMap((src) =>
    src.zone === 'battlefield' && src.attachedTo === obj.id ? (getDef(src.defName).grantsToHost?.protectionFrom ?? []) : [],
  ),
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
  // an Equipment/Aura granting "can't be blocked" (Whispersilk Cloak)
  for (const id of state.zones.perPlayer[attacker.controllerId]!.battlefield) {
    const src = state.objects[id]
    if (src?.attachedTo === attacker.id && getDef(src.defName).grantsToHost?.cantBeBlocked)
      return `${a} can't be blocked (${objName(state, id)})`
  }
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
/**
 * CUMULATIVE UPKEEP (CR 702.24): as its controller's upkeep begins, put an age counter on the permanent
 * and open the pay-or-sacrifice decision for the TOTAL (per-counter cost × counters). Declining
 * sacrifices it. Returns true when a decision was opened (only the first such permanent is handled per
 * upkeep — the same one-pending limitation the targeted upkeep triggers carry).
 */
function fireCumulativeUpkeep(state: RulesGameState): boolean {
  const ap = state.activePlayer
  for (const id of [...state.zones.perPlayer[ap]!.battlefield]) {
    const obj = state.objects[id]
    const per = obj && getDef(obj.defName).cumulativeUpkeep
    if (!obj || !per) continue
    putCounters(state, id, 'age', 1)
    const n = obj.counters.age ?? 1
    const cost = parseManaCost(per)
    const total = `${cost.generic * n ? `{${cost.generic * n}}` : ''}${(['W', 'U', 'B', 'R', 'G', 'C'] as const)
      .map((c) => `{${c}}`.repeat(cost.colored[c] * n))
      .join('')}` || '{0}'
    state.pending = { kind: 'optionalPay', player: ap }
    state.pendingOptionalPay = {
      player: ap,
      beneficiary: ap,
      cost: total,
      defName: obj.defName,
      sourceId: id,
      trigger: 'upkeep',
      cumulativeUpkeep: true,
    }
    logLine(
      state,
      `${getDef(obj.defName).name} gets an age counter (${n}) — ${name(state, ap)} must pay ${total} or sacrifice it.`,
    )
    return true
  }
  return false
}

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
/**
 * Validate the chosen modes of a MULTI-mode spell ("choose two" / "choose one or more" / "choose
 * both if you control a commander") and return them in PRINTED order (CR 601.2b). Returns null for
 * a card that isn't multi-mode. Duplicates are rejected (CR 700.2d: each mode is chosen at most once).
 */
export function chosenModes(
  state: RulesGameState,
  actor: PlayerId,
  def: CardDefinition,
  picked: number[] | undefined,
): number[] | null {
  const rule = def.modeRule
  if (!rule || !def.modes?.length) return null
  const ids = [...new Set(picked ?? [])]
  if (ids.length !== (picked ?? []).length) throw new RulesError('BAD_MODE', 'Each mode may be chosen only once')
  if (ids.some((i) => i < 0 || i >= def.modes!.length)) throw new RulesError('BAD_MODE', 'Choose a valid mode')
  const hasCommander = zoneArr(state, actor, 'battlefield').some((id) => state.objects[id]!.isCommander)
  const max = rule.count ?? (rule.oneOrMore ? def.modes.length : hasCommander ? 2 : 1)
  const min = rule.count ?? 1
  if (ids.length < min || ids.length > max)
    throw new RulesError(
      'BAD_MODE',
      min === max ? `Choose exactly ${min} mode${min === 1 ? '' : 's'}` : `Choose ${min} to ${max} modes`,
    )
  return ids.sort((x, y) => x - y)
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
  if (filter?.minManaValue != null && defManaValue(def) < filter.minManaValue) return false
  if (filter?.maxManaValue != null && defManaValue(def) > filter.maxManaValue) return false
  return true
}

/** Does `obj` satisfy `spec.filter` (types/subtypes/controller) for the targeting player? */
/** Mana value of a card definition (generic + every coloured pip) — CR 202.3. */
export function defManaValue(def: CardDefinition): number {
  const c = parseManaCost(def.manaCost)
  return c.generic + (['W', 'U', 'B', 'R', 'G', 'C'] as const).reduce((n, col) => n + c.colored[col], 0)
}

function matchesFilter(state: RulesGameState, obj: GameObject, filter: TargetFilter | undefined, byController: PlayerId): boolean {
  if (!filter) return true
  const def = getDef(obj.defName)
  if (filter.types && !filter.types.some((t) => def.types.includes(t))) return false
  if (filter.excludeTypes && filter.excludeTypes.some((t) => def.types.includes(t))) return false
  // object-aware: a CHANGELING is every creature type (CR 702.73) and Roaming Throne IS its own chosen
  // type, so "target Goblin" must accept both. A printed-subtypes-only check missed them.
  if (filter.subtypes && !filter.subtypes.some((st) => objHasCreatureType(state, obj, st))) return false
  // "target LEGENDARY creature you control" (Mithril Coat)
  if (filter.supertypes && !filter.supertypes.every((sup) => (def.supertypes ?? []).includes(sup))) return false
  if (filter.controller === 'you' && obj.controllerId !== byController) return false
  if (filter.controller === 'opponent' && obj.controllerId === byController) return false
  if (filter.minManaValue != null && defManaValue(def) < filter.minManaValue) return false
  if (filter.maxManaValue != null && defManaValue(def) > filter.maxManaValue) return false
  if (filter.excludeBasic && (def.supertypes?.includes('Basic') ?? false)) return false
  if (filter.attackingOrBlocking && !obj.attackingDefender && !obj.blockingAttackerId) return false
  return true
}

/** Is there at least one legal target for `spec` right now? (drives CR 603.3c trigger removal + client castability) */
export function hasAnyLegalTarget(state: RulesGameState, spec: TargetSpec, byController: PlayerId, srcColors: readonly ManaColor[] = []): boolean {
  // "target spell or ability" (Deflecting Swat): anything on the stack that HAS targets to re-aim
  if (spec.kind === 'spellOrAbility') return state.zones.stack.some((s) => s.targets.length > 0)
  // "target spell or nonland permanent an opponent controls" (Sink into Stupor)
  if (spec.kind === 'spellOrPermanent') {
    if (state.zones.stack.some((s) => s.kind === 'spell')) return true
    for (const pid of state.turnOrder)
      for (const id of state.zones.perPlayer[pid]!.battlefield)
        if (isLegalTarget(state, spec, id, byController, srcColors)) return true
    return false
  }
  if (spec.kind === 'spell')
    return state.zones.stack.some(
      (s) =>
        s.kind === 'spell' &&
        !spec.filter?.excludeTypes?.some((x) => getDef(s.defName).types.includes(x)) &&
        (!spec.filter?.types || spec.filter.types.some((x) => getDef(s.defName).types.includes(x))),
    )
  if (spec.kind === 'player')
    return spec.filter?.controller === 'opponent' ? opponentsOf(state, byController).length > 0 : alivePlayers(state).length > 0
  if (spec.kind === 'anyTarget') return alivePlayers(state).length > 0
  // a spec asking for SEVERAL targets needs that many distinct legal ones (Victimize chooses two
  // creature cards; with one in the graveyard it is not castable at all — CR 601.2c)
  const need = Math.max(1, spec.count ?? 1)
  let found = 0
  if (spec.kind === 'graveyardCard') {
    // a card in a graveyard (recursion). "your graveyard" = owned by the caster.
    const owners = spec.filter?.controller === 'you' ? [byController] : state.turnOrder
    for (const pid of owners)
      for (const id of state.zones.perPlayer[pid]!.graveyard)
        if (graveyardCardMatches(state, id, spec.filter) && ++found >= need) return true
    return false
  }
  // creature / permanent (possibly filtered): scan battlefield for legal targets
  for (const pid of state.turnOrder)
    for (const id of state.zones.perPlayer[pid]!.battlefield)
      if (isLegalTarget(state, spec, id, byController, srcColors) && ++found >= need) return true
  return false
}

export function isLegalTarget(state: RulesGameState, spec: TargetSpec, t: ObjId | PlayerId, byController: PlayerId, srcColors: readonly ManaColor[] = []): boolean {
  if (spec.kind === 'spellOrAbility') {
    // a spell OR a triggered/activated ability on the stack, and only one that actually has targets
    const item = state.zones.stack.find((s) => s.id === (t as ObjId))
    return !!item && item.targets.length > 0
  }
  if (spec.kind === 'spellOrPermanent') {
    // a SPELL on the stack, or a permanent matching the filter (Sink into Stupor: nonland, theirs)
    const item = state.zones.stack.find((s) => s.kind === 'spell' && s.id === (t as ObjId))
    if (item) return true
    const obj = Object.hasOwn(state.objects, t) ? state.objects[t as ObjId] : undefined
    if (!obj || obj.zone !== 'battlefield') return false
    return matchesFilter(state, obj, spec.filter, byController)
  }
  if (spec.kind === 'spell') {
    const item = state.zones.stack.find((s) => s.kind === 'spell' && s.id === (t as ObjId))
    if (!item) return false
    // spell-target filter (e.g. Negate "noncreature spell"): reject excluded card types
    if (spec.filter?.excludeTypes?.some((x) => getDef(item.defName).types.includes(x))) return false
    // positive list (Swan Song: "enchantment, instant, or sorcery spell")
    if (spec.filter?.types && !spec.filter.types.some((x) => getDef(item.defName).types.includes(x))) return false
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
  // "protection from everything": an OPPONENT's spell or ability can't target that player (CR 702.16e)
  const playerShielded =
    isPlayer && t !== byController && (state.players[t as PlayerId]!.protectedFromEverything ?? false)
  if (spec.kind === 'player') {
    if (playerShielded) return false
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
  // anyTarget = "any target" (CR 115.4): a creature, a player, OR a planeswalker. A filter applies to
  // the permanent side only, which is how "target player or planeswalker" is expressed (Boros Charm:
  // anyTarget + excludeTypes ['Creature']).
  if (isPlayer) return !playerShielded
  if (isCreature || isPlaneswalkerOnBattlefield(state, t))
    return matchesFilter(state, state.objects[t as ObjId]!, spec.filter, byController)
  return false
}

// ---------- player actions ----------

/**
 * Grand Abolisher: during its controller's turn, their OPPONENTS can't cast spells or activate
 * abilities of artifacts, creatures or enchantments. Checked at the top of r.cast / r.activate.
 */
function requireNotAbolished(state: RulesGameState, actor: PlayerId, kind: 'cast' | 'activate', sourceDef?: CardDefinition) {
  if (actor === state.activePlayer) return
  const abolisher = zoneArr(state, state.activePlayer, 'battlefield').find(
    (id) => getDef(state.objects[id]!.defName).opponentsCantActOnYourTurn,
  )
  if (!abolisher) return
  // only those three permanent types are locked down for activations; casting is locked entirely
  if (kind === 'activate') {
    const t = sourceDef?.types ?? []
    if (!t.includes('Artifact') && !t.includes('Creature') && !t.includes('Enchantment')) return
  }
  throw new RulesError('ABOLISHED', `${objName(state, abolisher)} stops you during its controller's turn`)
}

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
  // r.openingPlay is the one action that belongs to the window AFTER the last keep but BEFORE turn 1
  if (
    state.status === 'mulligans' &&
    msg.type !== 'r.mulligan' &&
    msg.type !== 'r.keep' &&
    msg.type !== 'r.openingPlay' &&
    msg.type !== 'r.concede'
  )
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
      if (p.landsPlayedThisTurn >= landDropAllowance(state, actor))
        throw new RulesError('LAND_LIMIT', 'Already played a land this turn')
      // a land exiled by an impulse effect is PLAYED from exile (it still uses the land drop)
      const impulseLand = isImpulsePlayable(state, actor, msg.objId) ? state.objects[msg.objId]! : null
      const obj = impulseLand ?? requireInHand(state, actor, msg.objId)
      // MODAL DFC (CR 712.4): playing the back face turns the card into that face as it leaves the
      // hand; it then enters through the normal land path (so entersTapped / pay-life still apply)
      if (msg.back) {
        const modalBack = getDef(obj.defName).modalBack
        if (!modalBack) throw new RulesError('NOT_A_LAND', 'That card has no land back face')
        obj.defName = defKey(modalBack.name)
      }
      if (!defIsLand(getDef(obj.defName))) throw new RulesError('NOT_A_LAND', 'That is not a land')
      moveTo(state, obj.id, 'battlefield')
      // (entersTapped is applied by moveTo for every entry path)
      p.landsPlayedThisTurn++
      state.passed = []
      logLine(state, `${name(state, actor)} plays ${objName(state, obj.id)}${obj.tapped ? ' (tapped)' : ''}.`)
      fireEntersTriggers(state, obj.id) // ETB lands (e.g. scry Temples) trigger on being played
      drainEntersChoices(state) // a shockland asks its controller to pay life or enter tapped
      break
    }

    case 'r.tapMana': {
      requirePriority(state, actor)
      const obj = state.objects[msg.objId]
      if (!obj || obj.zone !== 'battlefield' || obj.phasedOut || obj.controllerId !== actor)
        throw new RulesError('NOT_YOURS', "You don't control that permanent")
      if (state.loseAbilities.includes(obj.id)) throw new RulesError('NO_MANA_ABILITY', 'That permanent has lost all abilities')
      // Urza's Saga: its "{T}: Add {C}" only exists from chapter I onwards
      const loreNow = obj.counters.lore ?? 0
      const loreGate = (getDef(obj.defName).abilities ?? []).filter(
        (a) => a.kind === 'activated' && a.isMana && (a.requiresLoreAtLeast == null || loreNow >= a.requiresLoreAtLeast),
      )
      if (!loreGate.length && (getDef(obj.defName).abilities ?? []).some((a) => a.requiresLoreAtLeast != null))
        throw new RulesError('NO_MANA_ABILITY', 'That ability has not been granted yet')
      // a permanent can have SEVERAL mana abilities (the pain lands: "{T}: Add {C}" and "{T}: Add
      // {a} or {b}, deals 1 damage to you") — pick the one that can produce the requested colour,
      // else the first (so every existing single-ability call site is unchanged)
      const manaAbilities = (getDef(obj.defName).abilities ?? []).filter((a) => a.kind === 'activated' && a.isMana)
      // a filter ability is selected by the caller passing a `pair` (its output choice)
      const filterAbility = msg.pair != null ? manaAbilities.find((a) => a.filter) : undefined
      const ability =
        filterAbility || (msg.color && manaAbilities.find((a) => (a.produces ?? []).includes(msg.color!))) || manaAbilities[0]
      // a colour GRANTED to your lands (Chromatic Lantern) or to EVERY land (Urborg / Yavimaya): tap the
      // land and add it, whatever the land's own abilities produce. Checked BEFORE the no-ability throw:
      // a land with no mana ability of its own (Urborg itself) must still be able to use the grant.
      if (
        msg.color &&
        defIsLand(getDef(obj.defName)) &&
        grantedLandManaColors(state, actor).includes(msg.color) &&
        !manaAbilities.some((a) =>
          (a.dynamicProduces ? dynamicManaColors(state, actor, a.dynamicProduces, obj.id) : (a.produces ?? [])).includes(msg.color!),
        )
      ) {
        if (obj.tapped) throw new RulesError('TAPPED', 'Already tapped')
        obj.tapped = true
        state.players[actor]!.manaPool[msg.color]++
        logLine(state, `${name(state, actor)} taps ${objName(state, obj.id)} for {${msg.color}} (granted).`)
        state.passed = []
        break
      }
      if (!ability) throw new RulesError('NO_MANA_ABILITY', 'No mana ability')
      // asking for a colour none of its mana abilities can make is illegal (rather than silently
      // falling back to another ability's output)
      if (
        msg.color &&
        !ability.filter &&
        !manaAbilities.some((a) =>
          (a.dynamicProduces ? dynamicManaColors(state, actor, a.dynamicProduces, obj.id) : (a.produces ?? [])).includes(msg.color!),
        )
      )
        throw new RulesError('CHOOSE_COLOR', `${objName(state, obj.id)} can't make {${msg.color}}`)
      // a mana ability must have SOME consuming cost, or it could be activated unboundedly (infinite
      // mana): {T} for the usual sources, or a sacrifice / life / mana cost (the Altars have no {T} —
      // their cost is sacrificing a creature, which is finite)
      const manaCost = ability.cost
      if (!manaCost.tap && !manaCost.sacrifice && !manaCost.sacrificeSelf && !manaCost.life && !manaCost.mana)
        throw new RulesError('UNSUPPORTED', 'That mana ability has no cost the engine can pay')
      if (manaCost.tap && obj.tapped) throw new RulesError('TAPPED', 'Already tapped')
      // a creature's {T} mana ability (mana dork) still needs it to not be summoning sick (CR 302.6)
      if (manaCost.tap && defIsCreature(getDef(obj.defName)) && obj.summoningSick && !hasKw(state, obj.id, 'haste'))
        throw new RulesError('SUMMONING_SICK', `${objName(state, obj.id)} can't tap for mana yet`)
      // FILTER ability (the filter lands): pay one mana of payFrom, add the chosen pair
      if (ability.filter) {
        const f = ability.filter
        const out = msg.pair != null ? f.outputs[msg.pair] : undefined
        if (!out) throw new RulesError('CHOOSE_OUTPUT', 'Choose which two mana to add')
        const payColor = msg.payColor && f.payFrom.includes(msg.payColor) ? msg.payColor : undefined
        if (!payColor) throw new RulesError('CHOOSE_COLOR', `Pay one ${f.payFrom.map((c) => `{${c}}`).join(' or ')}`)
        const pool = state.players[actor]!.manaPool
        if (pool[payColor] < 1) throw new RulesError('CANT_PAY', `No {${payColor}} in your pool`)
        if (ability.cost.tap && obj.tapped) throw new RulesError('TAPPED', 'Already tapped')
        pool[payColor]--
        if (ability.cost.tap) obj.tapped = true
        pool[out[0]]++
        pool[out[1]]++
        logLine(state, `${name(state, actor)} filters {${payColor}} into {${out[0]}}{${out[1]}} with ${objName(state, obj.id)}.`)
        state.passed = []
        break
      }
      // a dynamic source's colours come from the board (Reflecting Pool, Mox Amber)
      const produces = ability.dynamicProduces
        ? dynamicManaColors(state, actor, ability.dynamicProduces, obj.id)
        : (ability.produces ?? [])
      if (ability.dynamicProduces && !produces.length) throw new RulesError('NO_MANA', 'It can produce no mana right now')
      // colour CHOICE (guildgate/dork/rock): validate the choice up front
      if (ability.chooseColor && (!msg.color || !produces.includes(msg.color)))
        throw new RulesError('CHOOSE_COLOR', `Choose which colour (${produces.join('/')})`)
      // "Pay N life" as part of a mana ability's cost (Mana Confluence) — CR 119.4, checked
      // before any mutation
      // "Activate only if you control five or more lands." (Temple of the False God)
      if (ability.requiresLandsAtLeast != null && controlledLands(state, actor) < ability.requiresLandsAtLeast)
        throw new RulesError('NOT_ACTIVE', `Needs ${ability.requiresLandsAtLeast} lands`)
      // metalcraft (Mox Opal)
      if (ability.requiresArtifactsAtLeast != null && controlledArtifacts(state, actor) < ability.requiresArtifactsAtLeast)
        throw new RulesError('NOT_ACTIVE', `Needs ${ability.requiresArtifactsAtLeast} artifacts`)
      // a counter condition on a MANA ability (Gemstone Caverns' any-colour half needs its luck counter)
      if (ability.requiresCounter && (obj.counters[ability.requiresCounter.kind] ?? 0) < ability.requiresCounter.min)
        throw new RulesError('NOT_ACTIVE', `Needs ${ability.requiresCounter.min} ${ability.requiresCounter.kind} counter(s)`)
      // a "Sacrifice a creature" cost on a MANA ability (Ashnod's Altar, Phyrexian Altar/Tower):
      // validated before any mutation, paid below once the colour choice is known
      const manaSacCost = ability.cost.sacrifice
      const manaSacIds = manaSacCost ? [...new Set(msg.sacrifices ?? [])] : []
      if (manaSacCost) {
        if (manaSacIds.length !== manaSacCost.count)
          throw new RulesError('BAD_SACRIFICE', `Sacrifice exactly ${manaSacCost.count} creature${manaSacCost.count === 1 ? '' : 's'}`)
        for (const id of manaSacIds) {
          const c = state.objects[id]
          if (!c || c.zone !== 'battlefield' || c.controllerId !== actor || !defIsCreature(getDef(c.defName)))
            throw new RulesError('BAD_SACRIFICE', 'Not a creature you control')
        }
      }
      const manaLifeCost = abilityLifeCost(state, actor, ability.cost)
      if (manaLifeCost > state.players[actor]!.life)
        throw new RulesError('CANT_PAY', `Not enough life (need ${manaLifeCost})`)
      // pay the ability's own mana cost first (e.g. a Signet's {1}) — atomic: throws before tapping
      if (ability.cost.mana) {
        const cost = parseManaCost(ability.cost.mana)
        const pool = state.players[actor]!.manaPool
        const payment = planPayment(cost, pool)
        if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      }
      if (manaCost.tap) obj.tapped = true
      if (manaLifeCost) {
        changeLife(state, actor, -manaLifeCost)
        logLine(state, `${name(state, actor)} pays ${manaLifeCost} life for ${objName(state, obj.id)}.`)
      }
      if (ability.chooseColor && ability.manaEqualToDevotion) {
        const n = devotionTo(state, actor, msg.color!)
        state.players[actor]!.manaPool[msg.color!] += n
        logLine(state, `${name(state, actor)} adds ${n} {${msg.color}} (devotion).`)
      } else if (ability.chooseColor && ability.manaEqualToChosenTypeCount) {
        // Three Tree City: as many mana as you control creatures of the type IT chose as it entered, and
        // that mana is spendable only on CREATURE spells (see manaRestriction.creatureSpellsOnly)
        const chosen = obj.chosenType
        // object-aware: a changeling counts, and so does a permanent that IS its own chosen type
        // (Roaming Throne) — a def-level check would miss the latter
        const n = chosen ? battlefieldCreatures(state, actor).filter((c) => objHasCreatureType(state, c, chosen)).length : 0
        if (n > 0) {
          ;(state.players[actor]!.restrictedMana ??= []).push({
            color: msg.color!,
            amount: n,
            ...(ability.manaRestriction?.creatureSpellsOnly ? { creatureSpellsOnly: true } : {}),
          })
        }
        logLine(
          state,
          `${name(state, actor)} adds ${n} {${msg.color}} (${chosen ?? 'no type'} creatures they control${
            ability.manaRestriction?.creatureSpellsOnly ? '; only for creature spells' : ''
          }).`,
        )
      } else if (ability.manaRestriction) {
        // RESTRICTED mana (Cavern of Souls, Delighted Halfling): its own bucket, spendable only on a
        // matching spell. A chosenTypeOnly source with no type chosen yet makes nothing useful, which
        // can't happen in practice (the type is chosen as it enters).
        const restriction = ability.manaRestriction
        const bucket = {
          color: msg.color!,
          amount: 1,
          ...(restriction.chosenTypeOnly ? { creatureType: obj.chosenType ?? '' } : {}),
          ...(restriction.legendaryOnly ? { legendary: true } : {}),
          ...(restriction.uncounterable ? { uncounterable: true } : {}),
          ...(restriction.alsoTypeAbilities ? { typeAbilities: true } : {}),
          ...(restriction.scryIfSharesCommanderType ? { scryIfSharesCommanderType: true } : {}),
        }
        ;(state.players[actor]!.restrictedMana ??= []).push(bucket)
        if (restriction.scryIfSharesCommanderType) {
          logLine(state, `${name(state, actor)} adds {${msg.color}} (scries 1 if spent on a creature sharing a type with their commander).`)
        } else {
          const only = restriction.legendaryOnly ? 'legendary spells' : `${obj.chosenType ?? 'the chosen type'} creature spells`
          logLine(state, `${name(state, actor)} adds {${msg.color}} (only for ${only}).`)
        }
      } else if (ability.manaEqualToCounters) {
        // "{T}: Add {C} for each charge counter on this permanent." (Everflowing Chalice)
        const n = obj.counters[ability.manaEqualToCounters] ?? 0
        const col = ability.produces?.[0] ?? 'C'
        state.players[actor]!.manaPool[col] += n
        logLine(state, `${name(state, actor)} adds ${n} {${col}} (${ability.manaEqualToCounters} counters).`)
      } else if (ability.chooseColor) state.players[actor]!.manaPool[msg.color!]++
      else ability.effect({ state, controllerId: actor, sourceId: obj.id, targets: [] }) // fixed output
      // TRIGGERED MANA ABILITY (CR 605.1b — Wild Growth): an Aura attached to the tapped permanent
      // that adds mana whenever it is tapped for mana. It doesn't use the stack, so the mana lands
      // now, in the TAPPED permanent's controller's pool as printed.
      fireTappedForMana(state, obj.id)
      // pay a mana ability's sacrifice cost (the Altars) — after the mana is in the pool, so a dies
      // trigger that wants to spend it sees it
      for (const id of manaSacIds) {
        logLine(state, `${name(state, actor)} sacrifices ${objName(state, id)} for mana.`)
        moveToGraveyard(state, id)
      }
      if (manaSacIds.length) checkSBA(state)
      // a mana ability that hurts (Ancient Tomb, City of Brass, the pain lands)
      if (ability.damageOnTapForMana) {
        changeLife(state, actor, -ability.damageOnTapForMana)
        logLine(state, `${objName(state, obj.id)} deals ${ability.damageOnTapForMana} damage to ${name(state, actor)}.`)
      }
      // "Sacrifice this token" as part of a MANA ability's cost (a Treasure). Mana abilities never
      // use the stack, so the mana is already in the pool and the source goes now; the 704.5d SBA
      // then removes the token from the graveyard.
      if (ability.cost.sacrificeSelf) {
        logLine(state, `${name(state, actor)} sacrifices ${objName(state, obj.id)} for mana.`)
        moveToGraveyard(state, obj.id)
        checkSBA(state)
      }
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
      requireNotAbolished(state, actor, 'activate', getDef(obj.defName))
      const ability = getDef(obj.defName).abilities?.[msg.abilityIndex]
      if (!ability || ability.kind !== 'activated' || ability.isMana)
        throw new RulesError('NO_ABILITY', 'No such activated ability')
      // "Activate only if this permanent has a luck counter on it." (Gemstone Caverns)
      if (ability.requiresCounter && (obj.counters[ability.requiresCounter.kind] ?? 0) < ability.requiresCounter.min)
        throw new RulesError('NOT_ACTIVE', `Needs ${ability.requiresCounter.min} ${ability.requiresCounter.kind} counter(s)`)
      if (ability.requiresCreatedToken && !state.players[actor]!.createdTokenThisTurn)
        throw new RulesError('NO_ABILITY', 'You have not created a token this turn')
      // a Saga chapter's self-granted ability exists only once that chapter has been reached
      if (ability.requiresLoreAtLeast != null && (obj.counters.lore ?? 0) < ability.requiresLoreAtLeast)
        throw new RulesError('NO_ABILITY', 'That ability has not been granted yet')
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
          if (!s || s.zone !== 'battlefield' || s.controllerId !== actor) throw new RulesError('BAD_SACRIFICE', "You don't control that")
          // "Sacrifice a Treasure" (Professional Face-Breaker) vs "Sacrifice a creature"
          const ok =
            sacCost.filter === 'treasure'
              ? (getDef(s.defName).subtypes ?? []).includes('Treasure')
              : defIsCreature(getDef(s.defName))
          if (!ok) throw new RulesError('BAD_SACRIFICE', sacCost.filter === 'treasure' ? 'Not a Treasure you control' : 'Not a creature you control')
        }
      }
      // "Pay N life" (CR 119.4) — validated before any mutation, paid below with the other costs
      const lifeCost = abilityLifeCost(state, actor, ability.cost)
      if (lifeCost > state.players[actor]!.life)
        throw new RulesError('CANT_PAY', `Not enough life (need ${lifeCost})`)
      // pay the mana part of the cost. Secluded Courtyard's mana may also pay to "activate an ability
      // of a creature source of the chosen type", so those buckets join the pool for such a source.
      if (ability.cost.mana) {
        const cost = parseManaCost(ability.cost.mana)
        const srcDef = getDef(obj.defName)
        const buckets = (state.players[actor]!.restrictedMana ??= []).filter(
          (bk) =>
            bk.typeAbilities &&
            !!bk.creatureType &&
            srcDef.types.includes('Creature') &&
            // object-aware: a changeling / own-chosen-type source counts (CR 702.73)
            objHasCreatureType(state, obj, bk.creatureType),
        )
        const merged = { ...state.players[actor]!.manaPool }
        for (const bk of buckets) merged[bk.color] += bk.amount
        const payment = planPayment(cost, merged)
        if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
        const pool = state.players[actor]!.manaPool
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) {
          let owed = payment.deduct[c]
          for (const bk of buckets) {
            if (owed <= 0) break
            if (bk.color !== c || bk.amount <= 0) continue
            const take = Math.min(owed, bk.amount)
            bk.amount -= take
            owed -= take
          }
          pool[c] -= owed
        }
        state.players[actor]!.restrictedMana = state.players[actor]!.restrictedMana!.filter((bk) => bk.amount > 0)
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
      if (lifeCost) {
        changeLife(state, actor, -lifeCost)
        logLine(state, `${name(state, actor)} pays ${lifeCost} life.`)
      }
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
      requireNotAbolished(state, actor, 'cast')
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
      // IMPULSE DRAW: a card exiled by Jeska's Will / Reckless Impulse is cast from exile for its
      // normal cost while its window is open (a LAND from the same window is played with r.playLand)
      const fromExileImpulse =
        !castingAdventure && !!candidate && isImpulsePlayable(state, actor, msg.objId) && !defIsLand(getDef(candidate.defName))
      const obj =
        fromCommand || fromExileAdv || fromFlashback || fromRetrace || fromEscape || fromForetell || fromExileImpulse
          ? candidate!
          : requireInHand(state, actor, msg.objId)
      const def = getDef(obj.defName)
      if (castingAdventure && !def.adventure) throw new RulesError('NO_ADVENTURE', 'That card has no adventure')
      const adv = castingAdventure ? def.adventure! : null
      // bestow (CR 702.103): cast the creature as an Aura for its bestow cost (targets a creature)
      const castingBestow = !adv && !fromFlashback && !fromRetrace && !!msg.bestow
      if (castingBestow && !def.bestowCost) throw new RulesError('NO_BESTOW', 'That card has no bestow')
      // evoke (CR 702.74): cast for the evoke cost, then sacrifice it as it enters
      const castingEvoke = !adv && !castingBestow && !fromFlashback && !fromRetrace && !!msg.evoke
      if (castingEvoke && !def.evokeCost) throw new RulesError('NO_EVOKE', 'That card has no evoke')
      // overload (CR 702.96): cast for the overload cost — an ALTERNATIVE cost with an untargeted
      // body ("change 'target' to 'each'")
      const castingOverload = !adv && !castingBestow && !castingEvoke && !fromFlashback && !fromRetrace && !!msg.overload
      if (castingOverload && !def.overload) throw new RulesError('NO_OVERLOAD', 'That spell has no overload')
      // morph (CR 702.37): cast face down as a 2/2 for a fixed {3}
      const castingFaceDown = !adv && !castingBestow && !castingEvoke && !fromFlashback && !fromRetrace && !fromEscape && !fromForetell && !!msg.faceDown
      if (castingFaceDown && !def.morphCost) throw new RulesError('NO_MORPH', 'That card has no morph')
      // split card (CR 709): the chosen half is selected by mode (0 = left, 1 = right)
      if (!adv && !castingBestow && def.split && msg.mode !== 0 && msg.mode !== 1) throw new RulesError('BAD_MODE', 'Choose a split half')
      const splitHalf = !adv && !castingBestow && def.split ? (msg.mode === 1 ? def.split.right : def.split.left) : null
      // the "face" being cast: the adventure half, a split half, or the card's main face
      const faceTypes = adv ? adv.types : splitHalf ? splitHalf.types : def.types
      const faceManaCost = adv ? adv.manaCost : splitHalf ? splitHalf.manaCost : castingOverload ? def.overload!.cost : castingBestow ? def.bestowCost! : castingEvoke ? def.evokeCost! : castingFaceDown ? '{3}' : fromFlashback ? def.flashbackCost! : fromEscape ? def.escape!.cost : fromForetell ? def.foretellCost! : def.manaCost
      if (defIsLand(def) && !adv && !splitHalf) throw new RulesError('IS_A_LAND', 'Lands are played, not cast')
      const instantSpeed = faceTypes.includes('Instant') || (!adv && !splitHalf && !castingBestow && hasKw(state, obj.id, 'flash'))
      if (!instantSpeed && (actor !== state.activePlayer || !isMainPhase(state) || state.zones.stack.length))
        throw new RulesError('TIMING', 'That can only be cast in your main phase with an empty stack')

      // MULTI-mode ("choose two" / "one or more" / "both with a commander"): the picks come in on
      // msg.modes and every chosen mode's targets are collected, in printed order
      const multiModes = !adv && !castingBestow && !def.split ? chosenModes(state, actor, def, msg.modes) : null
      // modal "choose one": validate the chosen mode; targets come from that mode (main face only)
      if (!adv && !castingBestow && !def.split && !multiModes && def.modes?.length && (msg.mode == null || msg.mode < 0 || msg.mode >= def.modes.length))
        throw new RulesError('BAD_MODE', 'Choose a valid mode')
      // bestow forces a single "target creature" (the host); otherwise use the chosen face's targets
      const chosen = adv ? { targets: adv.targets, effect: adv.effect } : activeSpell(def, msg.mode)
      const specs = castingOverload
        ? [] // overloaded: "target" became "each", so nothing is targeted
        : castingBestow
          ? flattenSpecs([{ kind: 'creature', count: 1 }])
          : multiModes
            ? multiModes.flatMap((i) => flattenSpecs(def.modes![i]!.targets))
            : flattenSpecs(chosen?.targets)
      const srcColors = def.colors ?? [] // for protection-from-colour target checks
      // "you MAY … target X" / "up to one target X" (CR 601.2c): declining is legal, so an all-optional
      // spec list accepts zero targets and the ability simply does nothing on resolution
      const allOptional = specs.length > 0 && specs.every((sp) => sp.optional)
      if (msg.targets.length !== specs.length && !(allOptional && msg.targets.length === 0))
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
      // MULTIKICKER (CR 702.33b): the kicker may be paid any number of times, so the count — not just
      // a boolean — drives the cost and rides the stack item
      // a count above 1 is only meaningful for a MULTIkicker — refuse it outright rather than
      // silently treating it as a single kick
      if ((msg.kickerCount ?? 0) > 1 && !def.multikicker)
        throw new RulesError('NO_KICKER', 'That kicker can only be paid once')
      const kickerCount = !adv ? (def.multikicker ? (msg.kickerCount ?? (msg.kicked ? 1 : 0)) : msg.kicked ? 1 : 0) : 0
      const kicked = kickerCount > 0
      if (kicked) {
        if (!def.kickerCost) throw new RulesError('NO_KICKER', 'That spell has no kicker')
        const kc = parseManaCost(def.kickerCost)
        cost.generic += kc.generic * kickerCount
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) cost.colored[c] += kc.colored[c] * kickerCount
      }
      // buyback (CR 702.27): optional additional cost; on resolution the spell returns to hand
      const buyback = !adv && !splitHalf && !!msg.buyback
      if (buyback) {
        if (!def.buybackCost) throw new RulesError('NO_BUYBACK', 'That spell has no buyback')
        const bc = parseManaCost(def.buybackCost)
        cost.generic += bc.generic
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) cost.colored[c] += bc.colored[c]
      }
      // "If you control a commander, you may cast this spell without paying its mana cost."
      const castingFree = !adv && !splitHalf && !!msg.free
      if (castingFree) {
        if (!def.freeIfCommander) throw new RulesError('NO_FREE_CAST', 'That spell has no free cast')
        const hasCommander = zoneArr(state, actor, 'battlefield').some((id) => state.objects[id]!.isCommander)
        if (!hasCommander) throw new RulesError('NO_COMMANDER', 'You control no commander')
      }
      // "As an additional cost to cast this spell, sacrifice a creature / discard a card."
      // Validated here (before ANY mutation); paid below, once the mana payment is confirmed.
      const extra = !adv && !splitHalf ? def.additionalCost : undefined
      const sacIds = extra?.sacrifice ? [...new Set(msg.sacrifices ?? [])] : []
      const discardIds = extra?.discard ? [...new Set(msg.discards ?? [])] : []
      if (extra?.sacrifice) {
        if (sacIds.length !== extra.sacrifice.count)
          throw new RulesError('BAD_SACRIFICE', `Sacrifice exactly ${extra.sacrifice.count}`)
        for (const id of sacIds) {
          const o = state.objects[id]
          const d = o ? getDef(o.defName) : null
          const ok =
            !!o && !!d && o.zone === 'battlefield' && o.controllerId === actor &&
            (extra.sacrifice.filter === 'creature'
              ? defIsCreature(d)
              : extra.sacrifice.filter === 'land'
                ? defIsLand(d)
                : defIsCreature(d) || d.types.includes('Artifact'))
          if (!ok) throw new RulesError('BAD_SACRIFICE', 'Not a legal permanent to sacrifice')
        }
      }
      if (extra?.discard) {
        if (discardIds.length !== extra.discard) throw new RulesError('BAD_DISCARD', `Discard exactly ${extra.discard}`)
        const hand = zoneArr(state, actor, 'hand')
        for (const id of discardIds) {
          if (id === obj.id) throw new RulesError('BAD_DISCARD', "That's the spell you're casting")
          if (!hand.includes(id)) throw new RulesError('BAD_DISCARD', 'Not a card in your hand')
        }
      }
      // "As an additional cost to cast this spell, pay X life." (Toxic Deluge) — X is chosen by the
      // caster and is NOT added to the mana cost; validated here (CR 119.4), paid below with the
      // rest of the costs so a failed cast never drains life.
      const lifeX = !adv && !splitHalf && def.additionalLifeCostX ? (msg.x ?? 0) : 0
      if (def.additionalLifeCostX && !adv && !splitHalf) {
        if (msg.x == null) throw new RulesError('NEEDS_X', 'Choose how much life to pay')
        if (lifeX > state.players[actor]!.life) throw new RulesError('CANT_PAY', `Not enough life (need ${lifeX})`)
      }
      // static generic cost reduction (CR 601.2f) — e.g. Blasphemous Act "{1} less per creature".
      // Applied after cost increases, before convoke; floored at 0, coloured pips untouched.
      if (!adv && !splitHalf && def.costReduction) cost.generic = Math.max(0, cost.generic - def.costReduction(state, actor))
      // cost reduction from the caster's PERMANENTS (Foundry Inspector, the Medallions)
      if (!adv && !splitHalf) {
        const fromPermanents = permanentCostReduction(state, actor, def)
        if (fromPermanents) cost.generic = Math.max(0, cost.generic - fromPermanents)
      }
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
      // a PITCH alternative cost (Force of Will): 1 life + exiling a card of the right colour from your
      // hand REPLACES the mana cost entirely (CR 118.9)
      const pitch = def.pitchCost
      const castingPitch = !adv && !castingBestow && !!msg.pitch
      if (castingPitch) {
        if (!pitch) throw new RulesError('NO_PITCH', 'That spell has no alternative cost')
        const ids = [...new Set(msg.exiles ?? [])]
        if (ids.length !== 1) throw new RulesError('BAD_PITCH', 'Exile exactly one card')
        const hand = zoneArr(state, actor, 'hand')
        for (const id of ids) {
          if (!hand.includes(id) || id === obj.id) throw new RulesError('BAD_PITCH', 'That card is not in your hand')
          if (!(getDef(state.objects[id]!.defName).colors ?? []).includes(pitch.color))
            throw new RulesError('BAD_PITCH', `Exile a ${pitch.color} card`)
        }
        if (state.players[actor]!.life < pitch.life) throw new RulesError('CANT_PAY', `Not enough life (need ${pitch.life})`)
        cost.generic = 0
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) cost.colored[c] = 0
        changeLife(state, actor, -pitch.life)
        for (const id of ids) {
          logLine(state, `${name(state, actor)} exiles ${objName(state, id)} and pays ${pitch.life} life (alternative cost).`)
          moveTo(state, id, 'exile')
        }
      }
      // a free cast (commander alternative cost) pays no mana at all
      if (castingFree) {
        cost.generic = 0
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) cost.colored[c] = 0
      }
      // RESTRICTED mana ("spend this mana only to cast a creature spell of the chosen type") is
      // available only to a spell that satisfies it, and is spent before the open pool
      const payment = planPayment(cost, spellPayablePool(state, actor, def))
      if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      const spent = spendSpellMana(state, actor, payment.deduct, def)
      const pathScries = spent.scries // Path of Ancestry: scry 1 per rider-mana spent on a matching creature
      for (const c of convokeCreatures) c.tapped = true // convoke is paid by tapping (CR 702.51c)
      if (lifeX) {
        changeLife(state, actor, -lifeX)
        logLine(state, `${name(state, actor)} pays ${lifeX} life (additional cost).`)
      }
      // discards are part of the cost, so they happen before the spell is on the stack
      for (const id of discardIds) {
        logLine(state, `${name(state, actor)} discards ${objName(state, id)} (additional cost).`)
        moveToGraveyard(state, id)
      }
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
        // {X} in the mana cost OR an X paid in life (Toxic Deluge) — the effect reads ctx.x
        x: xCount > 0 ? x : lifeX ? lifeX : undefined,
        mode: !adv && !multiModes && (def.modes?.length || def.split) ? (msg.mode ?? 0) : undefined,
        modes: multiModes ?? undefined,
        // uncounterable from the mana that paid for it (Cavern of Souls) OR from a static another
        // permanent grants your creature spells (Rhythm of the Wild) — stamped as it's cast, so it
        // survives that permanent leaving before the spell resolves
        cantBeCountered:
          spent.uncounterable ||
          (defIsCreature(def) &&
            zoneArr(state, actor, 'battlefield').some((id) => getDef(state.objects[id]!.defName).yourCreatureSpellsUncounterable)) ||
          undefined,
        faceDown: castingFaceDown || undefined,
        kicked: kicked || undefined,
        kickedCount: kickerCount > 0 ? kickerCount : undefined,
        adventure: castingAdventure || undefined,
        flashback: fromFlashback || undefined,
        buyback: buyback || undefined,
        bestow: castingBestow || undefined,
        evoke: castingEvoke || undefined,
        overloaded: castingOverload || undefined,
      })
      const targetNames = msg.targets.map((t) => {
        if (Object.hasOwn(state.players, t)) return name(state, t as PlayerId)
        // a target can be a triggered ABILITY on the stack (Deflecting Swat), whose synthetic id has no
        // object of its own — name it after its source card
        if (state.objects[t as ObjId]) return objName(state, t as ObjId)
        const item = state.zones.stack.find((x) => x.id === t)
        return item ? `${getDef(item.defName).name}'s ability` : 'something'
      })
      logLine(
        state,
        castingFaceDown
          ? `${name(state, actor)} casts a face-down creature.` // no name — it's face down (morph)
          : `${name(state, actor)} casts ${adv ? adv.name : splitHalf ? splitHalf.name : def.name}${adv ? ' (adventure)' : fromFlashback ? ' (flashback)' : fromRetrace ? ' (retrace)' : fromEscape ? ' (escape)' : fromForetell ? ' (foretold)' : fromCommand ? ' from the command zone' : ''}${targetNames.length ? ` targeting ${targetNames.join(', ')}` : ''}.`,
      )
      // the sacrifice is paid AFTER the spell is on the stack, so its dies triggers land above it
      // and resolve first (CR 603.3b) — the same ordering as an activated ability's sac cost
      for (const id of sacIds) {
        logLine(state, `${name(state, actor)} sacrifices ${objName(state, id)} (additional cost).`)
        moveToGraveyard(state, id)
      }
      // Path of Ancestry's rider: its mana was spent on a creature sharing a type with the commander
      for (let i = 0; i < pathScries; i++) scryEffect(1)({ state, controllerId: actor, sourceId: obj.id, targets: [] })
      // ward (CR 702.21): any targeted opponent-controlled permanent with ward triggers now
      queueWardTriggers(state, obj.id, msg.targets, actor)
      // cascade (CR 702.85): "when you cast this spell" — trigger goes on the stack above it
      if (def.cascade) queueCascade(state, actor, obj.id, manaValue(def))
      // "Whenever an opponent casts a spell…" (CR 603.2) — count the cast first (Esper Sentinel's
      // "first noncreature spell each turn" reads the counter), then queue the triggers above it.
      // The face being cast decides creature-ness (an adventure/split half is a noncreature spell).
      const castFaceTypes = adv ? adv.types : splitHalf ? splitHalf.types : def.types
      if (!castFaceTypes.includes('Creature')) {
        const pl = state.players[actor]!
        pl.noncreatureSpellsThisTurn = (pl.noncreatureSpellsThisTurn ?? 0) + 1
      }
      state.players[actor]!.spellsThisTurn = (state.players[actor]!.spellsThisTurn ?? 0) + 1
      queueCastTriggers(state, actor, adv ? { ...def, types: adv.types } : splitHalf ? { ...def, types: splitHalf.types } : def)
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
      // attack taxes (Propaganda / Ghostly Prison, CR 508.1g): each defender's taxing permanents
      // charge the attacking player per creature aimed at that defender. Validated + paid BEFORE any
      // attacker is marked, so an unaffordable declaration changes nothing.
      {
        let tax = 0
        for (const { defenderId } of msg.attacks) {
          const defPlayer = Object.hasOwn(state.players, defenderId)
            ? (defenderId as PlayerId)
            : state.objects[defenderId]?.controllerId
          if (!defPlayer || defPlayer === actor) continue
          for (const id of zoneArr(state, defPlayer, 'battlefield')) {
            const t = getDef(state.objects[id]!.defName).attackTax
            if (t) tax += t
          }
        }
        if (tax > 0) {
          const pool = state.players[actor]!.manaPool
          const payment = planPayment({ generic: tax, colored: emptyPool(), symbols: [], hasX: false }, pool)
          if (!payment.covered) throw new RulesError('CANT_PAY', `Attacking costs {${tax}} (short ${payment.shortfall})`)
          for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
          logLine(state, `${name(state, actor)} pays {${tax}} to attack.`)
        }
      }
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
        // "Whenever equipped creature attacks, …" (Sword of the Animist): the trigger lives on the
        // Equipment/Aura attached to the attacker, not on the creature
        for (const att of Object.values(state.objects)) {
          if (att.zone !== 'battlefield' || att.attachedTo !== attackerId) continue
          if (getDef(att.defName).attacks?.watch?.scope === 'attachedCreature') queueTriggeredAbility(state, att.id, 'attacks')
        }
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
      // Frantic Search: "…then untap up to three lands" — after the discard, before priority returns
      const untapAfter = forced?.thenUntapLands ?? 0
      if (untapAfter) untapOwnLands(state, actor, untapAfter)
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
      // Ponder-style REORDER: the peeked cards go back on top in the chosen order, or the player
      // shuffles instead. Nothing is bottomed or binned, so this path is separate from scry/surveil.
      if (ps.reorder) {
        const stillInLib = ps.cardIds.filter((id) => lib.includes(id))
        const chosen = [...new Set(msg.order ?? stillInLib)].filter((id) => stillInLib.includes(id))
        if (!msg.shuffle && chosen.length !== stillInLib.length)
          throw new RulesError('BAD_SCRY', `Order all ${stillInLib.length} cards, or shuffle`)
        for (const id of stillInLib) {
          const i = lib.indexOf(id)
          if (i >= 0) lib.splice(i, 1)
        }
        if (msg.shuffle) {
          lib.push(...stillInLib)
          shuffleInPlace(lib)
          logLine(state, `${name(state, actor)} shuffles their library.`)
        } else {
          lib.unshift(...chosen)
          logLine(state, `${name(state, actor)} puts ${chosen.length} cards back on top in a chosen order.`)
        }
        remintLibrary(state, actor) // end the peek so the looked-at ids can't be tracked
        const draws = ps.thenDraw ?? 0
        state.pending = null
        state.pendingScry = null
        if (draws) {
          for (let i = 0; i < draws; i++) drawOne(state, actor)
          logLine(state, `${name(state, actor)} draws ${draws} card${draws === 1 ? '' : 's'}.`)
        }
        grantPriority(state, actor)
        break
      }
      // remove the scried cards from the top, then re-place: kept on top (original
      // relative order), bottomed cards at the bottom
      // only cards STILL in the library are re-placed: anything that left it meanwhile (a card drawn
      // by an effect resolving during the peek) must not be re-inserted, or its id would live in two
      // zones at once and the following re-mint would strand it
      const stillThere = ps.cardIds.filter((id) => lib.includes(id))
      const kept = stillThere.filter((id) => !bottom.includes(id))
      const bottomed = stillThere.filter((id) => bottom.includes(id))
      for (const id of stillThere) {
        const i = lib.indexOf(id)
        if (i >= 0) lib.splice(i, 1)
      }
      lib.unshift(...kept)
      // surveil (CR 701.42): the cards not kept go to the GRAVEYARD instead of the library bottom
      if (ps.surveil) for (const id of bottomed) moveToGraveyard(state, id)
      else lib.push(...bottomed)
      remintLibrary(state, actor) // end the peek so post-scry ids can't be tracked
      const thenDraw = ps.thenDraw ?? 0
      state.pending = null
      state.pendingScry = null
      logLine(
        state,
        `${name(state, actor)} keeps ${kept.length} on top, ${ps.surveil ? `puts ${bottomed.length} into the graveyard` : `puts ${bottomed.length} on the bottom`}.`,
      )
      // "…then draw a card" (Opt / Preordain) — AFTER the scry, never during it
      if (thenDraw) {
        for (let i = 0; i < thenDraw; i++) drawOne(state, actor)
        logLine(state, `${name(state, actor)} draws ${thenDraw} card${thenDraw === 1 ? '' : 's'}.`)
      }
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
      // "…that share a land type" (Myriad Landscape): two picks must have a subtype in common
      if (ps.shareSubtype && chosen.length === 2) {
        const [a, b] = chosen.map((id) => getDef(state.objects[id]!.defName).subtypes ?? [])
        if (!a!.some((st) => b!.includes(st)))
          throw new RulesError('BAD_SEARCH', 'Those cards share no land type')
      }
      // "a Forest card and a Plains card" (Krosan Verge): the picks must cover both subtypes
      if (ps.pairSubtypes && chosen.length > 1) {
        const have = chosen.map((id) => getDef(state.objects[id]!.defName).subtypes ?? [])
        for (const want of ps.pairSubtypes)
          if (!have.some((sts) => sts.includes(want)))
            throw new RulesError('BAD_SEARCH', `Choose a ${want} card too`)
      }
      // 'libraryTop' picks (the tutors) stay in the library: they are shuffled with everything
      // else, re-minted, and only THEN moved to the top — otherwise the searcher, who legitimately
      // saw the peeked id, could keep following that id inside the hidden library (invariant #3).
      const topPicks: GameObject[] = []
      for (let i = 0; i < chosen.length; i++) {
        const id = chosen[i]!
        const obj = state.objects[id]
        if (!obj) continue
        // split (Cultivate/Kodama's Reach): first pick → `first`, the rest → `rest`
        const route = ps.split ? (i === 0 ? ps.split.first : ps.split.rest) : { dest: ps.dest, tapped: ps.tapped }
        if (ps.reveal) logLine(state, `${name(state, actor)} reveals ${getDef(obj.defName).name}.`)
        if (route.dest === 'graveyard') {
          // Entomb: library → graveyard is hidden → PUBLIC, so no re-mint is needed (the card is
          // legitimately revealed by arriving in a public zone)
          moveToGraveyard(state, id)
        } else if (route.dest === 'libraryTop') {
          topPicks.push(obj)
        } else if (route.dest === 'battlefield') {
          obj.controllerId = actor
          obj.summoningSick = defIsCreature(getDef(obj.defName))
          moveTo(state, id, 'battlefield')
          if (route.tapped) obj.tapped = true
          // Fabled Passage: "…then if you control four or more lands, untap that land" — counted
          // after it entered, so the fetched land counts itself
          if (ps.untapIfLandsAtLeast != null && obj.tapped) {
            const lands = zoneArr(state, actor, 'battlefield').filter((lid) => defIsLand(getDef(state.objects[lid]!.defName))).length
            if (lands >= ps.untapIfLandsAtLeast) {
              obj.tapped = false
              logLine(state, `${objName(state, id)} is untapped (${lands} lands).`)
            }
          }
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
      // now put the tutored cards on top, in pick order (their ids were re-minted in place above,
      // so reading obj.id here gives the fresh id)
      if (topPicks.length) {
        const lib = zoneArr(state, actor, 'library')
        for (const obj of [...topPicks].reverse()) {
          const at = lib.indexOf(obj.id)
          if (at >= 0) lib.splice(at, 1)
          lib.unshift(obj.id)
        }
      }
      state.pendingSearch = null
      // a fetched permanent's targeted ETB may have set its own pending — don't clobber it
      if (state.pending?.kind === 'search') {
        state.pending = null
        // a fetched shockland owes its controller an as-enters choice before anyone gets priority
        if (!drainEntersChoices(state)) grantPriority(state, actor)
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
      const thenReturn = ps.thenReturnTapped ?? []
      for (const id of chosen) {
        logLine(state, `${name(state, actor)} sacrifices ${objName(state, id)}.`)
        moveToGraveyard(state, id) // fires dies triggers
      }
      // Victimize: "…if you do, return the chosen cards to the battlefield tapped" — the sacrifice HAS
      // happened at this point, so the continuation runs (a creature that left the graveyard meanwhile is
      // simply skipped)
      for (const id of thenReturn) {
        const card = state.objects[id]
        if (!card || card.zone !== 'graveyard') continue
        card.controllerId = actor
        moveTo(state, id, 'battlefield')
        card.tapped = true
        card.summoningSick = true
        logLine(state, `${objName(state, id)} returns to the battlefield tapped.`)
        fireEntersTriggers(state, id)
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

    case 'r.channel': {
      requirePriority(state, actor)
      const obj = requireInHand(state, actor, msg.objId)
      const def = getDef(obj.defName)
      if (!def.channel) throw new RulesError('NO_CHANNEL', 'That card has no channel ability')
      // validate targets + mana BEFORE anything is spent (the discard is part of the cost)
      const specs = flattenSpecs(def.channel.targets)
      const allOptional = specs.length > 0 && specs.every((sp) => sp.optional)
      if (msg.targets.length !== specs.length && !(allOptional && msg.targets.length === 0))
        throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
      msg.targets.forEach((t, i) => {
        if (!isLegalTarget(state, specs[i]!, t, actor, def.colors ?? [])) throw new RulesError('BAD_TARGETS', 'Illegal target')
      })
      const cost = channelCost(state, actor, def)
      const pool = state.players[actor]!.manaPool
      const payment = planPayment(cost, pool)
      if (!payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
      // discard the card as the rest of the cost: hand → graveyard is hidden → PUBLIC, so no re-mint
      const channelId = obj.id
      moveToGraveyard(state, channelId)
      const abilityId = mintCardId()
      state.zones.stack.push({
        id: abilityId,
        kind: 'ability',
        channel: true,
        controllerId: actor,
        defName: obj.defName,
        sourceId: channelId,
        abilityIndex: null,
        targets: [...msg.targets],
      })
      logLine(state, `${name(state, actor)} channels ${def.name}.`)
      queueWardTriggers(state, abilityId, msg.targets, actor)
      grantPriority(state, actor)
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

    case 'r.putBack': {
      if (state.pending?.kind !== 'putBack' || state.pending.player !== actor || !state.pendingPutBack)
        throw new RulesError('NOT_PENDING', 'Not waiting for your put-back')
      const need = state.pendingPutBack.count
      const chosen = [...new Set(msg.objIds)]
      if (chosen.length !== need) throw new RulesError('BAD_PUTBACK', `Choose exactly ${need} card${need === 1 ? '' : 's'}`)
      const hand = zoneArr(state, actor, 'hand')
      for (const id of chosen) if (!hand.includes(id)) throw new RulesError('BAD_PUTBACK', 'Not a card in your hand')
      state.pending = null
      state.pendingPutBack = null
      // the FIRST id ends up on top: put them back in reverse so each unshift lands above the last.
      // Re-mint each one: a hand id IS serialised to its owner, and the redactor treats the library
      // as unknown to everyone, so keeping the id would leave the owner's own view able to follow a
      // card into the library — exactly the tracking vector invariant #3 forbids (the leak fuzzer's
      // history-aware check catches it). The player still learns what they put on top from the log.
      for (const id of [...chosen].reverse()) {
        moveTo(state, id, 'library', { top: true })
        remintForHiddenEntry(state, id, true)
      }
      logLine(state, `${name(state, actor)} puts ${chosen.length} card${chosen.length === 1 ? '' : 's'} on top of their library.`)
      if (state.status === 'active') grantPriority(state, state.activePlayer)
      break
    }

    case 'r.optionalPay': {
      if (state.pending?.kind !== 'optionalPay' || state.pending.player !== actor || !state.pendingOptionalPay)
        throw new RulesError('NOT_PENDING', 'Not waiting for your payment')
      const pop = state.pendingOptionalPay
      const pool = state.players[actor]!.manaPool
      const payment = planPayment(parseManaCost(pop.cost), pool)
      // pay only if they chose to AND can actually afford it; anything else = decline
      const paid = msg.pay && payment.covered
      if (msg.pay && !payment.covered) throw new RulesError('CANT_PAY', `Not enough mana (short ${payment.shortfall})`)
      state.pending = null
      state.pendingOptionalPay = null
      const d = getDef(pop.defName)
      const body =
        pop.trigger === 'delayed'
          ? d.delayed?.[pop.delayedKey ?? '']
          : pop.trigger === 'draw'
            ? d.drawnCard
            : pop.trigger === 'upkeep'
              ? d.upkeep
              : d.castSpell
      if (paid) {
        for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) pool[c] -= payment.deduct[c]
        if (pop.cumulativeUpkeep) {
          logLine(state, `${name(state, actor)} pays ${pop.cost} to keep ${getDef(pop.defName).name}.`)
        } else if (pop.effectOnPay) {
          // "you may pay {4}. If you do, untap this artifact." — paying is what makes it happen
          logLine(state, `${name(state, actor)} pays ${pop.cost} for ${d.name}.`)
          body?.effect({ state, controllerId: pop.beneficiary, sourceId: pop.sourceId, targets: [] })
        } else {
          logLine(state, `${name(state, actor)} pays ${pop.cost} — ${d.name}'s ability does nothing.`)
        }
      } else if (pop.cumulativeUpkeep) {
        // CR 702.24: not paying the cumulative upkeep sacrifices the permanent
        logLine(state, `${name(state, actor)} declines — ${getDef(pop.defName).name} is sacrificed (cumulative upkeep).`)
        if (state.objects[pop.sourceId]?.zone === 'battlefield') moveToGraveyard(state, pop.sourceId)
      } else {
        logLine(state, `${name(state, actor)} declines to pay ${pop.cost}.`)
        if (!pop.effectOnPay) body?.effect({ state, controllerId: pop.beneficiary, sourceId: pop.sourceId, targets: [] })
      }
      // resume: the active player gets priority and the stack keeps resolving (CR 117.3c)
      if (state.status === 'active') grantPriority(state, state.activePlayer)
      checkSBA(state)
      break
    }

    case 'r.entersChoice': {
      if (state.pending?.kind !== 'entersChoice' || state.pending.player !== actor || !state.pendingEntersChoice)
        throw new RulesError('NOT_PENDING', 'Not waiting for your as-enters choice')
      const pec = state.pendingEntersChoice
      state.pending = null
      state.pendingEntersChoice = null
      const obj = state.objects[pec.objId]
      // CR 119.4: you may pay the life only at life ≥ N; otherwise (and on a decline) it's tapped
      const paid = msg.pay && state.players[actor]!.life >= pec.life
      if (obj && obj.zone === 'battlefield') {
        if (paid) {
          changeLife(state, actor, -pec.life)
          logLine(state, `${name(state, actor)} pays ${pec.life} life — ${objName(state, obj.id)} enters untapped.`)
        } else {
          obj.tapped = true
          logLine(state, `${objName(state, obj.id)} enters tapped.`)
        }
      }
      // the next queued as-enters choice first (two shocklands can enter together), else resume:
      // the active player gets priority (CR 117.3c) and checkSBA runs (paying to 0 life loses)
      if (!drainDecisions(state)) grantPriority(state, state.activePlayer)
      break
    }

    case 'r.proliferate': {
      if (state.pending?.kind !== 'proliferate' || state.pending.player !== actor || !state.pendingProliferate)
        throw new RulesError('NOT_PENDING', 'Not waiting for your proliferate')
      const eligible = proliferateTargets(state)
      const objIds = [...new Set(msg.objIds)]
      const playerIds = [...new Set(msg.playerIds)] as PlayerId[]
      for (const id of objIds)
        if (!eligible.permanents.includes(id)) throw new RulesError('BAD_CHOICE', 'That permanent has no counter')
      for (const pid of playerIds)
        if (!eligible.players.includes(pid)) throw new RulesError('BAD_CHOICE', 'That player has no counter')
      const remaining = state.pendingProliferate.remaining - 1
      state.pending = null
      state.pendingProliferate = null
      // "give each another counter of each kind already there" — every kind, one more each. It goes
      // through putCounters, so Hardened Scales / Doubling Season apply to what proliferate adds.
      for (const id of objIds) {
        const obj = state.objects[id]!
        for (const [kind, n] of Object.entries(obj.counters)) if (n > 0) putCounters(state, id, kind, 1)
        logLine(state, `${objName(state, id)} gets another counter of each kind (proliferate).`)
      }
      for (const pid of playerIds) {
        state.players[pid]!.poison++
        logLine(state, `${name(state, pid)} gets another poison counter (proliferate) — ${state.players[pid]!.poison} total.`)
      }
      if (!objIds.length && !playerIds.length) logLine(state, `${name(state, actor)} proliferates nothing.`)
      // Contagion Engine: "Then do it again." — a fresh choice, with eligibility recomputed
      if (remaining > 0) {
        const next = proliferateTargets(state)
        if (next.permanents.length || next.players.length) {
          state.pending = { kind: 'proliferate', player: actor }
          state.pendingProliferate = { player: actor, remaining }
        }
      }
      if (!state.pending) {
        checkSBA(state)
        if (state.status === 'active') grantPriority(state, state.activePlayer)
      }
      break
    }

    case 'r.handChoice': {
      if (state.pending?.kind !== 'handChoice' || state.pending.player !== actor || !state.pendingHandChoice)
        throw new RulesError('NOT_PENDING', 'Not waiting for your hand choice')
      const phc = state.pendingHandChoice
      const ids = [...new Set(msg.objIds)]
      if (ids.length > phc.count) throw new RulesError('BAD_CHOICE', `Choose at most ${phc.count}`)
      if (!ids.length && !phc.optional) throw new RulesError('BAD_CHOICE', `Choose ${phc.count}`)
      const hand = zoneArr(state, actor, 'hand')
      for (const id of ids) {
        if (!hand.includes(id)) throw new RulesError('BAD_CHOICE', 'That card is not in your hand')
        if (!handCardMatches(state, id, phc.filter)) throw new RulesError('BAD_CHOICE', 'That card does not qualify')
      }
      state.pending = null
      state.pendingHandChoice = null
      for (const id of ids) {
        // IMPRINT (CR 702.61): record the exiled card on the source before it moves
        if (phc.imprint && phc.sourceId && state.objects[phc.sourceId]) {
          state.objects[phc.sourceId]!.imprintedDefName = state.objects[id]!.defName
        }
        const what = objName(state, id)
        if (phc.dest === 'graveyard') moveToGraveyard(state, id) // a DISCARD (Mox Diamond's cost)
        else moveTo(state, id, phc.dest)
        logLine(
          state,
          phc.dest === 'battlefield'
            ? `${name(state, actor)} puts ${what} onto the battlefield.`
            : phc.dest === 'graveyard'
              ? `${name(state, actor)} discards ${what}.`
              : `${name(state, actor)} exiles ${what}${phc.imprint ? ' (imprint)' : ''}.`,
        )
        if (phc.dest === 'battlefield') {
          fireEntersTriggers(state, id)
          drainEntersChoices(state)
        }
      }
      if (!ids.length) logLine(state, `${name(state, actor)} declines.`)
      // Mox Diamond: the discard WAS the cost of entering — without it the permanent is put into its
      // owner's graveyard (CR 614.12; it was never really on the battlefield, so nothing triggers off
      // its "death" beyond the usual graveyard move)
      if (phc.binSourceIfNone && !ids.length && phc.sourceId) {
        const src = state.objects[phc.sourceId]
        if (src && src.zone === 'battlefield') {
          logLine(state, `${objName(state, src.id)} is put into its owner's graveyard (nothing discarded).`)
          moveToGraveyard(state, src.id)
        }
      }
      if (!drainDecisions(state)) grantPriority(state, state.activePlayer)
      break
    }

    case 'r.chooseModes': {
      if (state.pending?.kind !== 'modes' || state.pending.player !== actor || !state.pendingModes)
        throw new RulesError('NOT_PENDING', 'Not waiting for your modes')
      const pm = state.pendingModes
      // read the ability off the CARD, not the object: the permanent can be gone by now (it died while its
      // trigger sat on the stack), and a trigger still resolves on last known information (CR 603.10)
      const srcDef = getDef(pm.defName)
      const ability = pm.trigger === 'firstMain' ? srcDef.firstMain : srcDef.landEnters
      if (!ability?.modes?.length) {
        state.pending = null
        state.pendingModes = null
        if (state.status === 'active') grantPriority(state, state.activePlayer)
        break
      }
      const ids = [...new Set(msg.modes)].sort((a, b) => a - b)
      // compare against the RAW list: comparing the deduped set with itself never catches a duplicate
      if (ids.length !== msg.modes.length) throw new RulesError('BAD_MODE', 'Each mode may be chosen only once')
      if (ids.some((i) => i < 0 || i >= (ability?.modes?.length ?? 0))) throw new RulesError('BAD_MODE', 'Choose a valid mode')
      const min = pm.oneOrMore ? 1 : pm.count
      const max = pm.oneOrMore ? (ability?.modes?.length ?? 0) : pm.count
      if (ids.length < min || ids.length > max)
        throw new RulesError('BAD_MODE', min === max ? `Choose exactly ${min}` : `Choose ${min} to ${max} modes`)
      state.pending = null
      state.pendingModes = null
      for (const i of ids) {
        const mode = ability?.modes?.[i]
        if (!mode) continue
        logLine(state, `${pm.sourceName} — ${mode.label}.`)
        mode.effect({ state, controllerId: actor, sourceId: pm.sourceId, targets: [] })
      }
      checkSBA(state)
      if (!state.pending && state.status === 'active') grantPriority(state, state.activePlayer)
      break
    }

    case 'r.retarget': {
      if (state.pending?.kind !== 'retarget' || state.pending.player !== actor || !state.pendingRetarget)
        throw new RulesError('NOT_PENDING', 'Not waiting for your new targets')
      const prt = state.pendingRetarget
      const item = state.zones.stack.find((x) => x.id === prt.itemId)
      if (item && msg.targets.length) {
        // the item keeps its OWN targeting restrictions, judged for ITS controller (CR 115.7b)
        const def = getDef(item.defName)
        const body = item.kind === 'spell' ? activeSpell(def, item.mode) : abilityFor(def, item.trigger)
        const specs = flattenSpecs(body?.targets)
        if (msg.targets.length !== specs.length)
          throw new RulesError('BAD_TARGETS', `Needs exactly ${specs.length} target${specs.length === 1 ? '' : 's'}`)
        msg.targets.forEach((t, i) => {
          if (!isLegalTarget(state, specs[i]!, t, item.controllerId, def.colors ?? []))
            throw new RulesError('BAD_TARGETS', 'Illegal new target')
        })
        item.targets = [...msg.targets]
        logLine(
          state,
          `${name(state, actor)} chooses new targets for ${prt.sourceName}: ${msg.targets
            .map((t) => (Object.hasOwn(state.players, t) ? name(state, t as PlayerId) : objName(state, t as ObjId)))
            .join(', ')}.`,
        )
      } else {
        logLine(state, `${name(state, actor)} leaves ${prt.sourceName}'s targets unchanged.`)
      }
      state.pending = null
      state.pendingRetarget = null
      if (!state.pending) grantPriority(state, state.activePlayer)
      break
    }

    case 'r.mayDraw': {
      if (state.pending?.kind !== 'mayDraw' || state.pending.player !== actor || !state.pendingMayDraw)
        throw new RulesError('NOT_PENDING', 'Not waiting for your draw')
      const pmd = state.pendingMayDraw
      if (msg.count > pmd.max) throw new RulesError('BAD_CHOICE', `Draw at most ${pmd.max}`)
      // "you may draw TWO cards" is all-or-nothing, unlike "up to two" (Mystic Remora vs Arcane Denial)
      if (pmd.exact && msg.count !== 0 && msg.count !== pmd.max)
        throw new RulesError('BAD_CHOICE', `Draw ${pmd.max} or none`)
      state.pending = null
      state.pendingMayDraw = null
      for (let i = 0; i < msg.count; i++) drawOne(state, actor)
      logLine(
        state,
        msg.count
          ? `${name(state, actor)} draws ${msg.count} card${msg.count === 1 ? '' : 's'} (${pmd.sourceName}).`
          : `${name(state, actor)} declines to draw (${pmd.sourceName}).`,
      )
      if (!state.pending && state.status === 'active') grantPriority(state, state.activePlayer)
      break
    }

    case 'r.revealTop': {
      if (state.pending?.kind !== 'revealTop' || state.pending.player !== actor || !state.pendingRevealTop)
        throw new RulesError('NOT_PENDING', 'Not waiting for your reveal')
      const prt = state.pendingRevealTop
      state.pending = null
      state.pendingRevealTop = null
      const card = state.objects[prt.cardId]
      if (msg.take && card && card.zone === 'library') {
        // library → hand is hidden → hidden, but the card was REVEALED on the way, so the log names it
        const label = getDef(card.defName).name
        moveTo(state, prt.cardId, 'hand')
        remintForHiddenEntry(state, prt.cardId, false)
        logLine(state, `${name(state, actor)} reveals ${label} and puts it into their hand (${prt.sourceName}).`)
      } else {
        // the card stays on top — but its id was published to this player during the peek, so it must
        // be re-minted or that player could keep tracking it while it is hidden again (invariant #3,
        // the same reason the scry handler re-mints the library once its peek closes)
        remintForHiddenEntry(state, prt.cardId, true)
        logLine(state, `${name(state, actor)} leaves the card on top of their library.`)
      }
      if (!state.pending) grantPriority(state, state.activePlayer)
      break
    }

    case 'r.riot': {
      if (state.pending?.kind !== 'riot' || state.pending.player !== actor || !state.pendingRiot)
        throw new RulesError('NOT_PENDING', 'Not waiting for your riot choice')
      const pr = state.pendingRiot
      state.pending = null
      state.pendingRiot = null
      const obj = state.objects[pr.objId]
      if (obj && obj.zone === 'battlefield') {
        if (msg.haste) {
          obj.summoningSick = false // haste (CR 702.10) — it can attack and tap right away
          logLine(state, `${objName(state, obj.id)} enters with haste (riot).`)
        } else {
          putCounters(state, obj.id, '+1/+1', 1)
          logLine(state, `${objName(state, obj.id)} enters with a +1/+1 counter (riot).`)
        }
      }
      if (!drainDecisions(state)) grantPriority(state, state.activePlayer)
      break
    }

    case 'r.chooseType': {
      if (state.pending?.kind !== 'typeChoice' || state.pending.player !== actor || !state.pendingTypeChoice)
        throw new RulesError('NOT_PENDING', 'Not waiting for your creature-type choice')
      const ptc = state.pendingTypeChoice
      state.pending = null
      state.pendingTypeChoice = null
      const obj = state.objects[ptc.objId]
      // normalise to Title Case so "goblin" and "Goblin" match a card's subtypes
      const chosen = msg.creatureType.trim().replace(/\s+/g, ' ')
      const typeName = chosen.charAt(0).toUpperCase() + chosen.slice(1).toLowerCase()
      if (obj && obj.zone === 'battlefield') {
        obj.chosenType = typeName
        logLine(state, `${name(state, actor)} chooses ${typeName} for ${objName(state, obj.id)}.`)
      }
      if (!drainDecisions(state)) grantPriority(state, state.activePlayer)
      break
    }

    case 'r.hideaway': {
      if (state.pending?.kind !== 'hideaway' || state.pending.player !== actor || !state.pendingHideaway)
        throw new RulesError('NOT_PENDING', 'Not waiting for your hideaway choice')
      const ph = state.pendingHideaway
      if (!ph.cardIds.includes(msg.objId)) throw new RulesError('BAD_HIDEAWAY', 'Not one of the cards you are looking at')
      const chosen = state.objects[msg.objId]
      if (!chosen || chosen.zone !== 'library') throw new RulesError('BAD_HIDEAWAY', 'That card is no longer there')
      state.pending = null
      state.pendingHideaway = null
      // exile it FACE DOWN. No re-mint: library ids are never serialised to anyone, the peek that
      // revealed this one went to its owner alone, and the face-down exile id opponents now see
      // carries no identity (invariants #2/#3) — the same reasoning as foretell.
      moveTo(state, chosen.id, 'exile')
      chosen.faceDown = true
      chosen.hiddenBy = ph.sourceId
      // the rest go to the BOTTOM in a random order, then the library is re-minted so the ids the
      // looking player just saw can't be tracked
      const lib = zoneArr(state, actor, 'library')
      const rest = shuffleInPlace(ph.cardIds.filter((id) => id !== chosen.id && state.objects[id]?.zone === 'library'))
      for (const id of rest) {
        const i = lib.indexOf(id)
        if (i >= 0) lib.splice(i, 1)
        lib.push(id)
      }
      remintLibrary(state, actor)
      logLine(state, `${name(state, actor)} hides a card away with ${ph.sourceName} and puts ${rest.length} card${rest.length === 1 ? '' : 's'} on the bottom.`)
      if (!drainDecisions(state)) grantPriority(state, state.activePlayer)
      break
    }

    case 'r.freePlay': {
      if (state.pending?.kind !== 'freePlay' || state.pending.player !== actor || !state.pendingFreePlay)
        throw new RulesError('NOT_PENDING', 'Not waiting for your free play')
      const pfp = state.pendingFreePlay
      const card = state.objects[pfp.cardId]
      if (!msg.play || !card || card.zone !== 'exile') {
        // declined (or the card vanished): it simply stays hidden away
        state.pending = null
        state.pendingFreePlay = null
        if (msg.play === false) logLine(state, `${name(state, actor)} declines to play ${pfp.sourceName}'s hidden card.`)
        if (!drainDecisions(state)) grantPriority(state, state.activePlayer)
        break
      }
      const cardDef = getDef(card.defName)
      if (defIsLand(cardDef)) {
        // playing a land is still a land play (CR 305.2b: one per turn unless an effect says otherwise)
        const p = state.players[actor]!
        if (p.landsPlayedThisTurn >= 1 + (p.extraLandsThisTurn ?? 0))
          throw new RulesError('LAND_DROP', 'You have already played a land this turn')
        state.pending = null
        state.pendingFreePlay = null
        card.faceDown = undefined
        delete card.hiddenBy
        p.landsPlayedThisTurn++
        moveTo(state, card.id, 'battlefield')
        logLine(state, `${name(state, actor)} plays ${cardDef.name} from under ${pfp.sourceName}.`)
      } else {
        // validate the targets BEFORE clearing the decision, so a bad choice can be retried
        card.faceDown = undefined
        freeCastFromExile(state, card.id, actor, msg.targets ?? [], msg.mode, { reason: 'hideaway' })
        delete card.hiddenBy
        state.pending = null
        state.pendingFreePlay = null
      }
      if (!drainDecisions(state) && state.status === 'active') grantPriority(state, state.activePlayer)
      break
    }

    case 'r.openingPlay': {
      if (state.pending?.kind !== 'openingPlay' || state.pending.player !== actor || !state.pendingOpeningPlay)
        throw new RulesError('NOT_PENDING', 'Not waiting for your opening-hand choice')
      const pop = state.pendingOpeningPlay
      const obj = state.objects[pop.objId]
      const def = getDef(pop.defName)
      const bg = def.beginGameOnBattlefield!
      const hand = zoneArr(state, actor, 'hand')
      if (msg.play) {
        if (!obj || !hand.includes(obj.id)) throw new RulesError('BAD_OPENING', 'That card is not in your hand')
        const exileCount = bg.exileFromHand ?? 0
        const exiles = [...new Set(msg.exileIds ?? [])]
        if (exiles.length !== exileCount)
          throw new RulesError('BAD_OPENING', `Exile exactly ${exileCount} card${exileCount === 1 ? '' : 's'} from your hand`)
        for (const id of exiles)
          if (id === obj.id || !hand.includes(id)) throw new RulesError('BAD_OPENING', 'Not another card in your hand')
        // CR 103.6: it is PUT onto the battlefield before the game begins, so nothing triggers
        hand.splice(hand.indexOf(obj.id), 1)
        obj.zone = 'battlefield'
        zoneArr(state, actor, 'battlefield').push(obj.id)
        if (bg.counter) putCounters(state, obj.id, bg.counter, 1)
        logLine(state, `${name(state, actor)} begins the game with ${def.name} on the battlefield.`)
        for (const id of exiles) {
          moveTo(state, id, 'exile') // face up: "exile a card from your hand" reveals it
          logLine(state, `${name(state, actor)} exiles ${getDef(state.objects[id]!.defName).name} for ${def.name}.`)
        }
      } else {
        logLine(state, `${name(state, actor)} keeps ${def.name} in hand.`)
      }
      state.pending = null
      state.pendingOpeningPlay = null
      if (!advanceOpeningPlays(state, pop.queue)) finishOpeningPlays(state)
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
      // "you MAY … target X" / "up to one target X" (CR 601.2c): the player may decline, so an
      // all-optional spec list also accepts an empty target list (the ability then does nothing)
      const triggerAllOptional = specs.length > 0 && specs.every((sp) => sp.optional)
      if (msg.targets.length !== specs.length && !(triggerAllOptional && msg.targets.length === 0))
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
      // Roaming Throne: a doubled TARGETED trigger waited for this choice — its extra instance (which
      // chooses its own targets) goes on the stack now
      if (!drainDecisions(state)) grantPriority(state, state.activePlayer)
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

  // a permanent that entered by ANY path (including a manual r.mMove) may owe an as-enters choice, and a
  // doubled TARGETED trigger may owe its extra instance (Roaming Throne); the per-site drains open those
  // before priority is granted, and this is the catch-all so a queued decision can never be left
  // stranded by a handler that has none. Safe: it only sets `pending` when nothing else is open.
  drainDecisions(state)
  // if this action removed the player who owed a decision or held priority,
  // hand control off so the remaining players can continue (multiplayer).
  repairControlFlow(state)
  maybeFinishMulligans(state) // start the game once every remaining player has kept
  state.seq++
}
