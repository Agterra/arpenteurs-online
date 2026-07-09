/**
 * Composable effect primitives. Every card effect is built from these; they are
 * the ONLY way card code mutates the game (they defer to state.ts helpers so
 * zone/SBA invariants hold). Grows every milestone.
 */
import type { EffectContext, Effect } from './dsl'
import type { Keyword, ManaColor, ObjId, PlayerId } from '#shared/rules/types'
import { apnapOrder, battlefieldCreatures, isCreatureOnBattlefield, moveTo, moveToGraveyard, drawOne, logLine } from '../state'
import { getDef, registerImplementedToken } from './registry'
import { mintCardId } from '../../game/rng'
// currentPower is safe to import: characteristics is already in this module's
// transitive graph via engine (effects→engine→characteristics); called at runtime only.
import { currentPower } from '../characteristics'
// fireEntersTriggers/openSacrifice are hoisted function exports; the effects→engine
// edge is a call-time-only cycle (invoked inside effect bodies, never at module
// init), so it is safe — mirrors the existing effects→registry (getDef) cycle.
import { fireEntersTriggers, openSacrifice, remintForHiddenEntry } from '../engine'

// intrinsic-keyword check (avoids an effects→characteristics→registry→starter
// import cycle); granted indestructible is honored by checkSBA's damage path
const isIndestructible = (ctx: EffectContext, id: ObjId) =>
  getDef(ctx.state.objects[id]!.defName).keywords?.includes('indestructible') ?? false

// Object.hasOwn (not `in`) so prototype keys like "__proto__"/"toString" are
// never treated as players — otherwise a forged target could write to a builtin.
const isPlayerId = (ctx: EffectContext, t: ObjId | PlayerId): t is PlayerId =>
  Object.hasOwn(ctx.state.players, t)

/** Deal N damage to each target (creature → marked damage; player → life loss). */
export const dealDamage = (n: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) {
      ctx.state.players[t]!.life -= n
      logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to ${ctx.state.players[t]!.name}.`)
    } else if (isCreatureOnBattlefield(ctx.state, t)) {
      ctx.state.objects[t]!.damageMarked += n
      logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to ${getDef(ctx.state.objects[t]!.defName).name}.`)
    }
  }
}

/**
 * Destroy all creatures (board wipe). Skips `unimplemented` (assisted-table)
 * creatures — the engine never auto-removes an unknown; the log reminds players
 * to handle those by hand. Implemented death triggers still fire.
 */
export const destroyAllCreatures = (): Effect => (ctx) => {
  const all = battlefieldCreatures(ctx.state)
  const doomed = all.filter((c) => !getDef(c.defName).unimplemented && !isIndestructible(ctx, c.id))
  for (const c of doomed) moveToGraveyard(ctx.state, c.id)
  const skipped = all.length - doomed.length
  logLine(
    ctx.state,
    `All creatures are destroyed${skipped ? ` — ${skipped} indestructible/unimplemented creature(s) survive` : ''}.`,
  )
}

/** Deal N damage to each creature (sweeper). Skips `unimplemented` creatures (assisted table). */
export const damageAllCreatures = (n: number): Effect => (ctx) => {
  for (const c of battlefieldCreatures(ctx.state)) {
    if (getDef(c.defName).unimplemented) continue
    c.damageMarked += n
  }
  logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to each creature.`)
}

/** Counter each target spell on the stack — it's removed and put into its owner's graveyard. */
export const counterTarget = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    const item = ctx.state.zones.stack.find((s) => s.kind === 'spell' && s.id === t)
    if (!item) continue // already resolved / countered
    logLine(ctx.state, `${sourceName(ctx)} counters ${getDef(item.defName).name}.`)
    moveToGraveyard(ctx.state, item.id) // pulls it off the stack, into the graveyard
  }
}

/** Destroy each target creature (no regeneration in M-R0; indestructible survives). */
export const destroyTarget = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    if (isIndestructible(ctx, t)) {
      logLine(ctx.state, `${getDef(ctx.state.objects[t]!.defName).name} is indestructible.`)
      continue
    }
    logLine(ctx.state, `${getDef(ctx.state.objects[t]!.defName).name} is destroyed.`)
    moveToGraveyard(ctx.state, t)
  }
}

/**
 * Exile each target permanent. Public zone → no re-mint, no leak surface.
 * Indestructible does NOT save. A commander instead goes to its command zone
 * (owner's-choice simplification, matching moveToGraveyard).
 */
export const exileTarget = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    const nm = getDef(obj.defName).name
    if (obj.isCommander) {
      moveTo(ctx.state, t, 'command')
      logLine(ctx.state, `${nm} is exiled — its owner puts it in the command zone.`)
    } else {
      moveTo(ctx.state, t, 'exile')
      logLine(ctx.state, `${nm} is exiled.`)
    }
  }
}

/**
 * Each target creature's controller gains life equal to that creature's power
 * (Swords to Plowshares). Compose BEFORE exileTarget so the power is read while
 * the creature is still on the battlefield.
 */
export const gainLifeEqualToPowerForController = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    const obj = ctx.state.objects[t]!
    const power = Math.max(0, currentPower(ctx.state, obj))
    ctx.state.players[obj.controllerId]!.life += power
    logLine(ctx.state, `${ctx.state.players[obj.controllerId]!.name} gains ${power} life.`)
  }
}

/**
 * Return each target permanent to its owner's hand (bounce). LEAK-CRITICAL:
 * battlefield→hand is public→hidden, so the id MUST be re-minted (invariant #3)
 * or opponents could track the card. A COMMANDER instead goes to the command
 * zone (CR 903.9 owner's-choice, auto-routed like death/exile) — never to a
 * hidden hand, whose id would otherwise leak via player.commanderId.
 */
export const returnToHand = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    const nm = getDef(obj.defName).name
    if (obj.isCommander) {
      moveTo(ctx.state, t, 'command')
      logLine(ctx.state, `${nm} returns to the command zone.`)
    } else {
      moveTo(ctx.state, t, 'hand')
      remintForHiddenEntry(ctx.state, t, true) // public→hidden: re-mint the id
      logLine(ctx.state, `${nm} returns to its owner's hand.`)
    }
  }
}

/** Controller draws N cards. */
export const drawCards = (n: number): Effect => (ctx) => {
  for (let i = 0; i < n; i++) drawOne(ctx.state, ctx.controllerId)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} draws ${n} card${n > 1 ? 's' : ''}.`)
}

/**
 * Search the controller's library (tutor / land ramp). Pauses for them to pick
 * ≤count matching cards; the engine then moves the picks to `dest` and shuffles +
 * re-mints the library (r.search). Match ids are revealed ONLY to the actor
 * (sanctioned peek, invariant #2). Finds nothing → no pause.
 */
export const searchLibrary = (opts: {
  filter: 'basicLand' | 'any'
  dest: 'battlefield' | 'hand'
  tapped?: boolean
  count?: number
}): Effect => (ctx) => {
  const lib = ctx.state.zones.perPlayer[ctx.controllerId]!.library
  const matchIds = lib.filter((id) => {
    if (opts.filter === 'any') return true
    const def = getDef(ctx.state.objects[id]!.defName)
    return def.types.includes('Land') && (def.supertypes?.includes('Basic') ?? false)
  })
  const who = ctx.state.players[ctx.controllerId]!.name
  if (!matchIds.length) {
    logLine(ctx.state, `${who} searches their library but finds nothing.`)
    return
  }
  ctx.state.pending = { kind: 'search', player: ctx.controllerId }
  ctx.state.pendingSearch = {
    player: ctx.controllerId,
    matchIds,
    dest: opts.dest,
    tapped: opts.tapped ?? false,
    count: opts.count ?? 1,
  }
  logLine(ctx.state, `${who} searches their library.`)
}

/**
 * Force a sacrifice (edict). `who: 'target'` → each targeted player sacrifices
 * `count` creature(s) of their choice; `who: 'each'` → every player still in the
 * game sacrifices (APNAP order, active player first). Players controlling no
 * creature are skipped; the engine prompts the rest one at a time (r.sacrifice).
 */
export const playersSacrifice = (who: 'target' | 'each', count = 1): Effect => (ctx) => {
  const players =
    who === 'target'
      ? ctx.state.turnOrder.filter((p) => ctx.targets.includes(p) && !ctx.state.players[p]!.hasLost)
      : apnapOrder(ctx.state, ctx.state.activePlayer)
  openSacrifice(ctx.state, players, count)
}

/** Scry N: pause for the controller to look at the top N and bottom any (CR 701.18). */
export const scry = (n: number): Effect => (ctx) => {
  const lib = ctx.state.zones.perPlayer[ctx.controllerId]!.library
  const cardIds = lib.slice(0, Math.min(n, lib.length))
  if (!cardIds.length) return
  ctx.state.pending = { kind: 'scry', player: ctx.controllerId }
  ctx.state.pendingScry = { player: ctx.controllerId, cardIds }
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} scries ${cardIds.length}.`)
}

/** Put N counters of a kind on each target permanent (permanent buffs / shrink). */
export const addCounters = (kind: '+1/+1' | '-1/-1', n: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    obj.counters[kind] = (obj.counters[kind] ?? 0) + n
    logLine(ctx.state, `${getDef(obj.defName).name} gets ${n} ${kind} counter${n > 1 ? 's' : ''}.`)
  }
}

/** Put N counters on every creature the controller controls (e.g. Cathars' Crusade). */
export const addCountersToEachControlled = (kind: '+1/+1' | '-1/-1', n: number): Effect => (ctx) => {
  for (const c of battlefieldCreatures(ctx.state, ctx.controllerId)) c.counters[kind] = (c.counters[kind] ?? 0) + n
  logLine(
    ctx.state,
    `Each creature ${ctx.state.players[ctx.controllerId]!.name} controls gets ${n} ${kind} counter${n > 1 ? 's' : ''}.`,
  )
}

/** Give each target creature +power/+toughness until end of turn (CR 613 layer 7c). */
export const pump = (power: number, toughness: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    ctx.state.pumps.push({ objId: t, power, toughness })
    logLine(
      ctx.state,
      `${getDef(ctx.state.objects[t]!.defName).name} gets +${power}/+${toughness} until end of turn.`,
    )
  }
}

export interface TokenSpec {
  name: string
  power?: number
  toughness?: number
  subtypes?: string[]
  keywords?: Keyword[]
}

/** Mint `count` real (mortal) tokens onto `ownerId`'s battlefield. */
function spawnTokens(state: EffectContext['state'], ownerId: PlayerId, spec: TokenSpec, count: number) {
  const defName = registerImplementedToken(spec)
  const created: ObjId[] = []
  for (let i = 0; i < count; i++) {
    const id = mintCardId()
    state.objects[id] = {
      id,
      defName,
      ownerId,
      controllerId: ownerId,
      zone: 'battlefield',
      tapped: false,
      summoningSick: true,
      damageMarked: 0,
      counters: {},
      isCommander: false,
      attackingDefender: null,
      blockingAttackerId: null,
    }
    state.zones.perPlayer[ownerId]!.battlefield.push(id)
    created.push(id)
  }
  logLine(state, `${state.players[ownerId]!.name} creates ${count} ${spec.name} token${count > 1 ? 's' : ''}.`)
  // Tokens ENTER the battlefield → fire ETB triggers (self + "whenever a creature
  // you control/another creature enters" watchers: Soul Warden, Impact Tremors…).
  for (const id of created) fireEntersTriggers(state, id)
}

/** Create `count` tokens on the controller's battlefield. */
export const createToken = (spec: TokenSpec, count = 1): Effect => (ctx) => spawnTokens(ctx.state, ctx.controllerId, spec, count)

/** Destroy each target permanent (any type). Indestructible survives; a commander goes to the command zone. */
export const destroyPermanent = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    if (isIndestructible(ctx, t)) {
      logLine(ctx.state, `${getDef(obj.defName).name} is indestructible.`)
      continue
    }
    logLine(ctx.state, `${getDef(obj.defName).name} is destroyed.`)
    moveToGraveyard(ctx.state, t)
  }
}

/**
 * Destroy each target permanent, then ITS controller creates one token
 * (Beast Within / Generous Gift). The token is made even if the permanent was
 * indestructible (the destroy simply fails; the rider still happens).
 */
export const destroyPermanentGrantToken = (spec: TokenSpec): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    const controller = obj.controllerId
    if (isIndestructible(ctx, t)) logLine(ctx.state, `${getDef(obj.defName).name} is indestructible.`)
    else {
      logLine(ctx.state, `${getDef(obj.defName).name} is destroyed.`)
      moveToGraveyard(ctx.state, t)
    }
    spawnTokens(ctx.state, controller, spec, 1)
  }
}

/** Controller gains N life. */
export const gainLife = (n: number): Effect => (ctx) => {
  ctx.state.players[ctx.controllerId]!.life += n
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} gains ${n} life.`)
}

/** Controller loses N life (payment / drawback). */
export const loseLife = (n: number): Effect => (ctx) => {
  ctx.state.players[ctx.controllerId]!.life -= n
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} loses ${n} life.`)
}

/** Each opponent (still in the game) loses N life. */
export const eachOpponentLoses = (n: number): Effect => (ctx) => {
  for (const pid of ctx.state.turnOrder) {
    if (pid === ctx.controllerId) continue
    const p = ctx.state.players[pid]!
    if (!p.hasLost) p.life -= n
  }
  logLine(ctx.state, `Each opponent loses ${n} life.`)
}

/**
 * Deal N damage to each opponent (still in the game). Distinct from
 * eachOpponentLoses: the printed text says "deals damage" (matters for
 * damage-based interactions), and commander-damage tracking would attach here
 * if a source were a commander (not the case for the current pingers).
 */
export const dealToEachOpponent = (n: number): Effect => (ctx) => {
  for (const pid of ctx.state.turnOrder) {
    if (pid === ctx.controllerId) continue
    const p = ctx.state.players[pid]!
    if (!p.hasLost) p.life -= n
  }
  logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to each opponent.`)
}

/** Set each target creature's base power/toughness until end of turn (CR 613 layer 7b). */
export const setBasePT = (power: number, toughness: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    ctx.state.setPT.push({ objId: t, power, toughness })
    logLine(ctx.state, `${getDef(ctx.state.objects[t]!.defName).name} becomes ${power}/${toughness} until end of turn.`)
  }
}

/** Each target creature loses all abilities until end of turn (CR 613 layer 6). */
export const loseAllAbilities = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    if (!ctx.state.loseAbilities.includes(t)) ctx.state.loseAbilities.push(t)
    logLine(ctx.state, `${getDef(ctx.state.objects[t]!.defName).name} loses all abilities until end of turn.`)
  }
}

/** The source gets +power/+toughness until end of turn (self-pump, e.g. firebreathing). */
export const pumpSelf = (power: number, toughness: number): Effect => (ctx) => {
  if (!isCreatureOnBattlefield(ctx.state, ctx.sourceId)) return
  ctx.state.pumps.push({ objId: ctx.sourceId, power, toughness })
  logLine(ctx.state, `${getDef(ctx.state.objects[ctx.sourceId]!.defName).name} gets +${power}/+${toughness} until end of turn.`)
}

/** Add mana to the controller's pool (mana abilities — no stack). */
export const addMana = (...colors: ManaColor[]): Effect => (ctx) => {
  for (const c of colors) ctx.state.players[ctx.controllerId]!.manaPool[c]++
}

/** Run several effects in order. */
export const sequence = (...effects: Effect[]): Effect => (ctx) => {
  for (const e of effects) e(ctx)
}

function sourceName(ctx: EffectContext): string {
  const obj = ctx.state.objects[ctx.sourceId]
  return obj ? getDef(obj.defName).name : 'A spell'
}
