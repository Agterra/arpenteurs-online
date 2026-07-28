/**
 * Composable effect primitives. Every card effect is built from these; they are
 * the ONLY way card code mutates the game (they defer to state.ts helpers so
 * zone/SBA invariants hold). Grows every milestone.
 */
import type { Ability, EffectContext, Effect } from './dsl'
import type { CardType, Keyword, ManaColor, ObjId, PlayerId } from '#shared/rules/types'
import { parseManaCost } from '#shared/utils/manaCost'
import { apnapOrder, battlefieldCreatures, isCreatureOnBattlefield, moveTo, moveToGraveyard, drawOne, logLine } from '../state'
import { getDef, defKey, registerImplementedToken } from './registry'
import { mintCardId } from '../../game/rng'
// currentPower is safe to import: characteristics is already in this module's
// transitive graph via engine (effects→engine→characteristics); called at runtime only.
import { currentKeywords, currentPower } from '../characteristics'
// fireEntersTriggers/openSacrifice are hoisted function exports; the effects→engine
// edge is a call-time-only cycle (invoked inside effect bodies, never at module
// init), so it is safe — mirrors the existing effects→registry (getDef) cycle.
import { fireEntersTriggers, openDiscard, openSacrifice, remintForHiddenEntry } from '../engine'

// intrinsic OR granted indestructible (Heroic Intervention) — the same check checkSBA's
// damage path uses, so a destroy effect and lethal damage agree on who survives
const isIndestructible = (ctx: EffectContext, id: ObjId) =>
  currentKeywords(ctx.state, ctx.state.objects[id]!).includes('indestructible')

// Object.hasOwn (not `in`) so prototype keys like "__proto__"/"toString" are
// never treated as players — otherwise a forged target could write to a builtin.
const isPlayerId = (ctx: EffectContext, t: ObjId | PlayerId): t is PlayerId =>
  Object.hasOwn(ctx.state.players, t)

/** Colours of the effect's source (spell/ability), for protection-from-colour prevention. */
const sourceColors = (ctx: EffectContext): string[] => {
  const src = ctx.state.objects[ctx.sourceId]
  return src ? getDef(src.defName).colors ?? [] : []
}
/** True if a creature has protection from any of `colors` — printed OR granted (CR 702.16 / 613 layer 6). */
const protectedFromColors = (ctx: EffectContext, obj: { id: ObjId; defName: string }, colors: string[]): boolean => {
  const prot = [
    ...(getDef(obj.defName).protectionFrom ?? []),
    ...ctx.state.protectionGrants.filter((g) => g.objId === obj.id).map((g) => g.color),
  ]
  return prot.some((c) => colors.includes(c))
}

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

/** Deal `base` damage to each target — or `kicked` damage if the spell was kicked (CR 702.33). */
export const dealDamageKicked = (base: number, kicked: number): Effect => (ctx) => dealDamage(ctx.kicked ? kicked : base)(ctx)

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

/**
 * Overloaded mass bounce (Cyclonic Rift): return EVERY nonland permanent the controller does not
 * control to its owner's hand. Battlefield → hand is public → hidden, so each returned id is
 * re-minted (invariant #3) — `returnToHand` does that, and this reuses it one object at a time so
 * commanders are rerouted to the command zone too.
 */
export const returnAllNonlandYouDontControlToHand = (): Effect => (ctx) => {
  const doomed = Object.values(ctx.state.objects).filter(
    (o) => o.zone === 'battlefield' && o.controllerId !== ctx.controllerId && !getDef(o.defName).types.includes('Land'),
  )
  logLine(ctx.state, `Every nonland permanent ${ctx.state.players[ctx.controllerId]!.name} doesn't control is returned to hand.`)
  for (const o of doomed) returnToHand()({ ...ctx, targets: [o.id] })
}

/** Overloaded artifact sweeper (Vandalblast): destroy every artifact the controller doesn't control. */
export const destroyAllArtifactsYouDontControl = (): Effect => (ctx) => {
  const all = Object.values(ctx.state.objects).filter(
    (o) => o.zone === 'battlefield' && o.controllerId !== ctx.controllerId && getDef(o.defName).types.includes('Artifact'),
  )
  const doomed = all.filter((o) => !getDef(o.defName).unimplemented && !isIndestructible(ctx, o.id))
  for (const o of doomed) {
    logLine(ctx.state, `${getDef(o.defName).name} is destroyed.`)
    moveToGraveyard(ctx.state, o.id)
  }
  const skipped = all.length - doomed.length
  logLine(
    ctx.state,
    `All artifacts ${ctx.state.players[ctx.controllerId]!.name} doesn't control are destroyed${skipped ? ` — ${skipped} indestructible/unimplemented survive` : ''}.`,
  )
}

/**
 * Two target creatures fight (CR 701.12): each deals damage equal to its power to
 * the other, simultaneously. Expects [creatureA, creatureB] in ctx.targets; if
 * either has already left the battlefield, no fight happens (needs both).
 */
export const fight = (): Effect => (ctx) => {
  const pair = ctx.targets.filter((t): t is ObjId => isCreatureOnBattlefield(ctx.state, t))
  if (pair.length < 2) return
  const [a, b] = pair as [ObjId, ObjId]
  const oa = ctx.state.objects[a]!
  const ob = ctx.state.objects[b]!
  const pa = Math.max(0, currentPower(ctx.state, oa))
  const pb = Math.max(0, currentPower(ctx.state, ob))
  // keywords are read layer-6-aware (currentKeywords), exactly like combat damage —
  // honors granted deathtouch/lifelink and "loses all abilities"
  const kwA = currentKeywords(ctx.state, oa)
  const kwB = currentKeywords(ctx.state, ob)
  // protection from [colour]: fight damage is dealt by the CREATURES, so it's prevented when
  // the recipient is protected from the OTHER creature's colour (CR 702.16e, the D). A source
  // whose damage is fully prevented deals none — so no deathtouch and no lifelink for it.
  const aDealsToB = pa > 0 && !protectedFromColors(ctx, ob, getDef(oa.defName).colors ?? [])
  const bDealsToA = pb > 0 && !protectedFromColors(ctx, oa, getDef(ob.defName).colors ?? [])
  if (aDealsToB) {
    // wither/infect deal fight damage to a creature as -1/-1 counters (CR 702.79a / 702.90a)
    if (kwA.includes('wither') || kwA.includes('infect')) ob.counters['-1/-1'] = (ob.counters['-1/-1'] ?? 0) + pa
    else ob.damageMarked += pa
    if (kwA.includes('deathtouch')) ob.deathtouched = true
  }
  if (bDealsToA) {
    if (kwB.includes('wither') || kwB.includes('infect')) oa.counters['-1/-1'] = (oa.counters['-1/-1'] ?? 0) + pb
    else oa.damageMarked += pb
    if (kwB.includes('deathtouch')) oa.deathtouched = true
  }
  logLine(ctx.state, `${getDef(oa.defName).name} and ${getDef(ob.defName).name} fight.`)
  // lifelink applies to ANY damage a source deals (CR 702.15e), including fight damage
  if (aDealsToB && kwA.includes('lifelink')) {
    ctx.state.players[oa.controllerId]!.life += pa
    logLine(ctx.state, `${ctx.state.players[oa.controllerId]!.name} gains ${pa} life (lifelink).`)
  }
  if (bDealsToA && kwB.includes('lifelink')) {
    ctx.state.players[ob.controllerId]!.life += pb
    logLine(ctx.state, `${ctx.state.players[ob.controllerId]!.name} gains ${pb} life (lifelink).`)
  }
}

/** Deal N damage to each creature (sweeper). Skips `unimplemented` creatures (assisted table). */
export const damageAllCreatures = (n: number): Effect => (ctx) => {
  const cols = sourceColors(ctx)
  for (const c of battlefieldCreatures(ctx.state)) {
    if (getDef(c.defName).unimplemented) continue
    if (protectedFromColors(ctx, c, cols)) continue // protection from the source's colour
    c.damageMarked += n
  }
  logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to each creature.`)
}

/** Counter each target spell on the stack — put it into its owner's graveyard, EXCEPT a flashed-
 *  back spell, which is exiled as it leaves the stack (CR 702.34e) so it can't be recast. (A
 *  countered Adventure goes to the graveyard — its exile is only on resolution, CR 715.3d.) */
export const counterTarget = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    const item = ctx.state.zones.stack.find((s) => s.kind === 'spell' && s.id === t)
    if (!item) continue // already resolved / countered
    logLine(ctx.state, `${sourceName(ctx)} counters ${getDef(item.defName).name}.`)
    if (item.flashback) moveTo(ctx.state, item.id, 'exile')
    else moveToGraveyard(ctx.state, item.id) // pulls it off the stack, into the graveyard
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

/**
 * Each target player mills N (puts the top N of their library into their graveyard).
 * Library → graveyard is hidden → public: the milled cards are legitimately revealed
 * (they go face-up to a public zone) and need NO re-mint; the rest of the library
 * stays hidden. Milling an empty/short library just mills what's there.
 */
export const mill = (n: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (!isPlayerId(ctx, t)) continue
    const lib = ctx.state.zones.perPlayer[t]!.library
    const moved = Math.min(n, lib.length)
    for (let i = 0; i < moved; i++) moveTo(ctx.state, lib[0]!, 'graveyard') // always the current top
    logLine(ctx.state, `${ctx.state.players[t]!.name} mills ${moved} card${moved === 1 ? '' : 's'}.`)
  }
}

/**
 * Exile each target player's whole graveyard (Bojuka Bog). Graveyard → exile is
 * public → public (face-up exile), so no id re-mint is needed (invariant #3 covers
 * hidden-zone entry only) and nothing new is revealed.
 */
export const exileGraveyard = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (!isPlayerId(ctx, t)) continue
    const gy = ctx.state.zones.perPlayer[t]!.graveyard
    const n = gy.length
    for (let i = 0; i < n; i++) moveTo(ctx.state, gy[0]!, 'exile') // always the current first card
    logLine(ctx.state, `${ctx.state.players[t]!.name}'s graveyard is exiled (${n} card${n === 1 ? '' : 's'}).`)
  }
}

/**
 * Return each target graveyard card to its OWNER's hand (recursion — Raise Dead,
 * Regrowth). LEAK-CRITICAL: graveyard → hand is public → hidden, so the id MUST be
 * re-minted (invariant #3) or an opponent who recorded the public graveyard id could
 * track it into the hidden hand.
 */
/** Mana value of a card def (generic + all coloured/colourless pips) — CR 202.3. */
const manaValueOf = (def: { manaCost?: string }): number => {
  const c = parseManaCost(def.manaCost)
  return c.generic + (['W', 'U', 'B', 'R', 'G', 'C'] as const).reduce((n, col) => n + c.colored[col], 0)
}

/** Destroy the target permanent, then its destroyer loses life equal to that permanent's mana value
 *  (e.g. Feed the Swarm). Life is lost even if the permanent is indestructible — the destroy is tried. */
export const destroyLoseLifeEqualToMV = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    const def = getDef(obj.defName)
    const mv = manaValueOf(def)
    if (isIndestructible(ctx, t)) logLine(ctx.state, `${def.name} is indestructible.`)
    else {
      logLine(ctx.state, `${def.name} is destroyed.`)
      moveToGraveyard(ctx.state, t)
    }
    ctx.state.players[ctx.controllerId]!.life -= mv
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} loses ${mv} life.`)
  }
}

/** Reanimate: put the target creature card from a graveyard onto the battlefield under YOUR control;
 *  you lose life equal to its mana value (control-changing entry, so ETB triggers fire). */
export const reanimate = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'graveyard') continue
    const def = getDef(obj.defName)
    const mv = manaValueOf(def)
    obj.controllerId = ctx.controllerId // enters under the reanimator's control (holder for battlefield)
    obj.summoningSick = true
    moveTo(ctx.state, t, 'battlefield')
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} reanimates ${def.name}.`)
    fireEntersTriggers(ctx.state, t)
    ctx.state.players[ctx.controllerId]!.life -= mv
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} loses ${mv} life.`)
  }
}

export const returnFromGraveyard = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'graveyard') continue
    const nm = getDef(obj.defName).name
    const who = ctx.state.players[obj.ownerId]!.name
    // A COMMANDER goes to the command zone, never a hidden hand: it's exempt from
    // re-mint and its id is broadcast as player.commanderId, so a hidden-hand commander
    // would let an opponent track that id (invariant #3) — matches returnToHand/exileTarget.
    if (obj.isCommander) {
      moveTo(ctx.state, t, 'command')
      logLine(ctx.state, `${who} returns ${nm} from their graveyard to the command zone.`)
      continue
    }
    moveTo(ctx.state, t, 'hand') // non-battlefield zones are owner-side → the owner's hand
    remintForHiddenEntry(ctx.state, t, true) // public → hidden: re-mint the id
    logLine(ctx.state, `${who} returns ${nm} from their graveyard to their hand.`)
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
  // 'basicLand' = any Basic land; 'any' = any card; { landSubtypes } = a land with one of these
  // subtypes (e.g. Farseek → Plains/Island/Swamp/Mountain, Nature's Lore → Forest — basic OR not).
  filter: 'basicLand' | 'any' | { landSubtypes: string[] }
  dest: 'battlefield' | 'hand'
  tapped?: boolean
  count?: number
  /** Fabled Passage: untap the fetched land if its controller then controls ≥ N lands */
  untapIfLandsAtLeast?: number
  /** Split destination — e.g. Cultivate: first pick → battlefield tapped, rest → hand. */
  split?: {
    first: { dest: 'battlefield' | 'hand'; tapped: boolean }
    rest: { dest: 'battlefield' | 'hand'; tapped: boolean }
  }
}): Effect => (ctx) => {
  const lib = ctx.state.zones.perPlayer[ctx.controllerId]!.library
  const matchIds = lib.filter((id) => {
    if (opts.filter === 'any') return true
    const def = getDef(ctx.state.objects[id]!.defName)
    if (!def.types.includes('Land')) return false
    if (typeof opts.filter === 'object') return (def.subtypes ?? []).some((st) => opts.filter.landSubtypes.includes(st))
    return def.supertypes?.includes('Basic') ?? false // 'basicLand'
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
    ...(opts.untapIfLandsAtLeast != null ? { untapIfLandsAtLeast: opts.untapIfLandsAtLeast } : {}),
    ...(opts.split ? { split: opts.split } : {}),
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

/**
 * Force a discard. `who: 'target'` → each targeted player discards `count` cards of
 * their choice; `who: 'each'` → every player still in the game (APNAP order). Players
 * with an empty hand are skipped; the engine prompts the rest one at a time (r.discard).
 */
export const playersDiscard = (who: 'target' | 'each', count = 1): Effect => (ctx) => {
  const players =
    who === 'target'
      ? ctx.state.turnOrder.filter((p) => ctx.targets.includes(p) && !ctx.state.players[p]!.hasLost)
      : apnapOrder(ctx.state, ctx.state.activePlayer)
  openDiscard(ctx.state, players, count)
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

/**
 * Each creature a TARGET PLAYER controls gets -base/-base until end of turn — or
 * -kicked/-kicked if the spell was kicked (Marsh Casualties). Negative toughness that
 * reaches 0 kills via SBA (checked after resolution). Applies via the same until-EOT
 * pump machinery as `pump`.
 */
export const weakenControlledCreatures = (base: number, kicked: number): Effect => (ctx) => {
  const n = ctx.kicked ? kicked : base
  for (const t of ctx.targets) {
    if (!isPlayerId(ctx, t)) continue
    // skip `unimplemented` (assisted-table) creatures — the engine never auto-modifies a
    // card whose rules it doesn't know (mirrors damageAllCreatures / destroyAllCreatures /
    // earthquakeX); those are hand-run.
    for (const c of battlefieldCreatures(ctx.state, t)) {
      if (getDef(c.defName).unimplemented) continue
      ctx.state.pumps.push({ objId: c.id, power: -n, toughness: -n })
    }
    logLine(ctx.state, `Creatures ${ctx.state.players[t]!.name} controls get -${n}/-${n} until end of turn.`)
  }
}

/**
 * Every creature (both players') gets -N/-N until end of turn — Languish. Skips
 * `unimplemented` (assisted-table) creatures like the other mass-creature effects;
 * 0-toughness dies by SBA after resolution. Pumps expire at cleanup.
 */
export const weakenAllCreatures = (n: number): Effect => (ctx) => {
  for (const c of battlefieldCreatures(ctx.state)) {
    if (getDef(c.defName).unimplemented) continue
    ctx.state.pumps.push({ objId: c.id, power: -n, toughness: -n })
  }
  logLine(ctx.state, `All creatures get -${n}/-${n} until end of turn.`)
}

/**
 * Path to Exile: exile the target creature, then its CONTROLLER may search their library for a
 * basic land and put it onto the battlefield tapped (a search opened for that player — who may be
 * an opponent — resolved via r.search; they can decline by taking nothing).
 */
export const exileTargetControllerFetchesLand = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    const controller = ctx.state.objects[t]!.controllerId
    const nm = getDef(ctx.state.objects[t]!.defName).name
    moveTo(ctx.state, t, 'exile')
    logLine(ctx.state, `${nm} is exiled.`)
    const matchIds = ctx.state.zones.perPlayer[controller]!.library.filter((id) => {
      const d = getDef(ctx.state.objects[id]!.defName)
      return d.types.includes('Land') && (d.supertypes?.includes('Basic') ?? false)
    })
    if (matchIds.length) {
      ctx.state.pending = { kind: 'search', player: controller }
      ctx.state.pendingSearch = { player: controller, matchIds, dest: 'battlefield', tapped: true, count: 1 }
      logLine(ctx.state, `${ctx.state.players[controller]!.name} may search for a basic land.`)
    }
  }
}

/** Each target player draws `draw` cards and loses `life` life (e.g. Sign in Blood). */
export const targetPlayerDrawDrain = (draw: number, life: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (!isPlayerId(ctx, t)) continue
    for (let i = 0; i < draw; i++) drawOne(ctx.state, t)
    ctx.state.players[t]!.life -= life
    logLine(ctx.state, `${ctx.state.players[t]!.name} draws ${draw} and loses ${life} life.`)
  }
}

/** The controller discards `n` cards of their choice (e.g. Faithless Looting's "discard two cards"). */
export const selfDiscard = (n: number): Effect => (ctx) => openDiscard(ctx.state, [ctx.controllerId], n)

/** Transform this permanent (CR 712): swap its defName to the other face. getDef then returns the
 *  new face everywhere, so P/T / types / keywords / abilities all change together. */
export const transform = (): Effect => (ctx) => {
  const o = ctx.state.objects[ctx.sourceId]
  if (!o || o.zone !== 'battlefield') return
  const to = getDef(o.defName).transformsTo
  if (!to) return
  o.defName = defKey(to)
  logLine(ctx.state, `${getDef(o.defName).name} transforms.`)
}

/** Delver-style upkeep (CR 712): look at the top card of your library; if it's an instant or
 *  sorcery, transform this permanent. (The look isn't broadcast — a documented simplification of
 *  the "you may reveal" clause; the transform itself is the public tell.) */
export const lookTransformIfInstantSorcery = (): Effect => (ctx) => {
  const topId = ctx.state.zones.perPlayer[ctx.controllerId]!.library[0]
  if (!topId) return
  logLine(ctx.state, `${getDef(ctx.state.objects[ctx.sourceId]!.defName).name} looks at the top card of their library.`)
  const topTypes = getDef(ctx.state.objects[topId]!.defName).types
  if (topTypes.includes('Instant') || topTypes.includes('Sorcery')) transform()(ctx)
}

/** Adapt N (CR 701.44): if this creature has NO +1/+1 counters, put N +1/+1 counters on it. */
export const adapt = (n: number): Effect => (ctx) => {
  const o = ctx.state.objects[ctx.sourceId]
  if (!o || o.zone !== 'battlefield') return
  if ((o.counters['+1/+1'] ?? 0) > 0) {
    logLine(ctx.state, `${getDef(o.defName).name} doesn't adapt (it already has +1/+1 counters).`)
    return
  }
  o.counters['+1/+1'] = (o.counters['+1/+1'] ?? 0) + n
  logLine(ctx.state, `${getDef(o.defName).name} adapts — gets ${n} +1/+1 counter${n === 1 ? '' : 's'}.`)
}

/** Monstrosity N (CR 701.31): if this creature isn't monstrous, put N +1/+1 counters on it and it
 *  becomes monstrous. (The "activate only if not monstrous" restriction is enforced here at
 *  resolution — a documented simplification; the engine has no per-ability activation condition.) */
export const monstrosity = (n: number): Effect => (ctx) => {
  const o = ctx.state.objects[ctx.sourceId]
  if (!o || o.zone !== 'battlefield' || o.monstrous) return
  o.counters['+1/+1'] = (o.counters['+1/+1'] ?? 0) + n
  o.monstrous = true
  logLine(ctx.state, `${getDef(o.defName).name} becomes monstrous — gets ${n} +1/+1 counter${n === 1 ? '' : 's'}.`)
}

/** Grant protection from the given colour(s) to each target creature until end of turn (CR 613 layer 6). */
/**
 * Every permanent the controller controls gains `keywords` until end of turn (Heroic
 * Intervention). Unlike a static grant from a permanent, this reaches ANY permanent type —
 * lands and artifacts included (see `currentKeywords`).
 */
export const grantKeywordsToControlled = (keywords: Keyword[]): Effect => (ctx) => {
  const ids = ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield
  for (const id of ids) for (const keyword of keywords) (ctx.state.keywordGrants ??= []).push({ objId: id, keyword })
  logLine(
    ctx.state,
    `${ctx.state.players[ctx.controllerId]!.name}'s permanents gain ${keywords.join(' and ')} until end of turn.`,
  )
}

/** Target creature can't be blocked this turn (Rogue's Passage). */
export const makeUnblockable = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    const list = (ctx.state.unblockable ??= [])
    if (!list.includes(t)) list.push(t)
    logLine(ctx.state, `${getDef(ctx.state.objects[t]!.defName).name} can't be blocked this turn.`)
  }
}

export const grantProtection = (colors: ManaColor[]): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    for (const color of colors) ctx.state.protectionGrants.push({ objId: t, color })
    logLine(ctx.state, `${getDef(ctx.state.objects[t]!.defName).name} gains protection from ${colors.join('/')} until end of turn.`)
  }
}

export interface TokenSpec {
  name: string
  power?: number
  toughness?: number
  subtypes?: string[]
  keywords?: Keyword[]
  /** non-creature tokens (a Treasure is an Artifact) */
  types?: CardType[]
  /** the token's own activated abilities (a Treasure's mana ability) */
  abilities?: Ability[]
}

/**
 * The Treasure token (CR 111.10-style predefined token): "Artifact — Treasure. {T}, Sacrifice this
 * token: Add one mana of any color." The sacrifice is part of a MANA ability's cost, so it never
 * uses the stack (see r.tapMana) — the colour is chosen on tap, as for any any-colour source.
 */
export const TREASURE: TokenSpec = {
  name: 'Treasure',
  types: ['Artifact'],
  subtypes: ['Treasure'],
  abilities: [
    {
      kind: 'activated',
      cost: { tap: true, sacrificeSelf: true },
      isMana: true,
      produces: ['W', 'U', 'B', 'R', 'G'],
      chooseColor: true,
      // unused for a colour-choice source (the engine adds the chosen colour); wrapped in a lambda
      // so `addMana`, declared later in this module, is resolved at call time and not at init
      effect: (ctx) => addMana('W')(ctx),
    },
  ],
}

/** Create `count` Treasure tokens for `who` — the controller, or each targeted player. */
export const createTreasures = (count: number, who: 'you' | 'targets' = 'you'): Effect => (ctx) => {
  if (who === 'you') return void spawnTokens(ctx.state, ctx.controllerId, TREASURE, count)
  for (const t of ctx.targets) if (isPlayerId(ctx, t)) spawnTokens(ctx.state, t, TREASURE, count)
}

/**
 * Counter each target spell, then its CONTROLLER creates `count` Treasure tokens (An Offer You
 * Can't Refuse — the compensation goes to the countered player, not to you).
 */
export const counterTargetGrantingTreasures = (count: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    const item = ctx.state.zones.stack.find((s) => s.kind === 'spell' && s.id === t)
    if (!item) continue // already resolved / countered
    const victim = item.controllerId
    logLine(ctx.state, `${sourceName(ctx)} counters ${getDef(item.defName).name}.`)
    if (item.flashback) moveTo(ctx.state, item.id, 'exile')
    else moveToGraveyard(ctx.state, item.id)
    spawnTokens(ctx.state, victim, TREASURE, count)
  }
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

/** Controller gains X life and draws X cards, where X = lands they control (Nissa ult). */
export const gainAndDrawEqualToLands = (): Effect => (ctx) => {
  const x = ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield.filter((id) =>
    getDef(ctx.state.objects[id]!.defName).types.includes('Land'),
  ).length
  ctx.state.players[ctx.controllerId]!.life += x
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} gains ${x} life.`)
  for (let i = 0; i < x; i++) drawOne(ctx.state, ctx.controllerId)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} draws ${x} card${x === 1 ? '' : 's'}.`)
}

/** Put N loyalty counters on each OTHER planeswalker the controller controls (Ajani −2 rider). */
export const addLoyaltyToOtherPlaneswalkers = (n: number): Effect => (ctx) => {
  for (const id of ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield) {
    const o = ctx.state.objects[id]
    if (!o || o.id === ctx.sourceId) continue
    if (getDef(o.defName).types.includes('Planeswalker')) o.loyalty = (o.loyalty ?? 0) + n
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

/** Deal N damage to EACH player, including the source's controller (Flame Rift — symmetric). */
export const dealToEachPlayer = (n: number): Effect => (ctx) => {
  for (const pid of ctx.state.turnOrder) {
    const p = ctx.state.players[pid]!
    if (!p.hasLost) p.life -= n
  }
  logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to each player.`)
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

// ---------- X-spell effects (read ctx.x, the chosen value of X) ----------

/** Deal X damage to each target (Blaze, Disintegrate-base). */
export const dealDamageX = (): Effect => (ctx) => dealDamage(ctx.x ?? 0)(ctx)
/** Controller draws X cards (Mind Spring). */
export const drawCardsX = (): Effect => (ctx) => drawCards(ctx.x ?? 0)(ctx)
/** Controller gains X life (Sphinx's Revelation rider). */
export const gainLifeX = (): Effect => (ctx) => gainLife(ctx.x ?? 0)(ctx)
/** Earthquake: deal X damage to each creature WITHOUT flying and to each player. */
export const earthquakeX = (): Effect => (ctx) => {
  const n = ctx.x ?? 0
  const cols = sourceColors(ctx)
  for (const c of battlefieldCreatures(ctx.state)) {
    if (getDef(c.defName).unimplemented) continue // assisted table: skip unknown creatures
    if (currentKeywords(ctx.state, c).includes('flying')) continue
    if (protectedFromColors(ctx, c, cols)) continue // protection from the source's colour
    c.damageMarked += n
  }
  for (const pid of ctx.state.turnOrder) {
    const p = ctx.state.players[pid]!
    if (!p.hasLost) p.life -= n
  }
  logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to each non-flying creature and each player.`)
}

/** Run several effects in order. */
export const sequence = (...effects: Effect[]): Effect => (ctx) => {
  for (const e of effects) e(ctx)
}

function sourceName(ctx: EffectContext): string {
  const obj = ctx.state.objects[ctx.sourceId]
  return obj ? getDef(obj.defName).name : 'A spell'
}
