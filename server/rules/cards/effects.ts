/**
 * Composable effect primitives. Every card effect is built from these; they are
 * the ONLY way card code mutates the game (they defer to state.ts helpers so
 * zone/SBA invariants hold). Grows every milestone.
 */
import type { Ability, CardDefinition, EffectContext, Effect } from './dsl'
import { hasCreatureType } from './dsl'
import type { CardType, Keyword, ManaColor, ObjId, PlayerId } from '#shared/rules/types'
import { parseManaCost } from '#shared/utils/manaCost'
import { changeLife, putCounters, apnapOrder, battlefieldCreatures, isCreatureOnBattlefield, moveTo, moveToGraveyard, drawOne, logLine } from '../state'
import { getDef, defKey, registerCopyToken, registerImplementedToken } from './registry'
import { mintCardId, randomIndex } from '../../game/rng'
// currentPower is safe to import: characteristics is already in this module's
// transitive graph via engine (effects→engine→characteristics); called at runtime only.
import { currentKeywords, currentPower } from '../characteristics'
// fireEntersTriggers/openSacrifice are hoisted function exports; the effects→engine
// edge is a call-time-only cycle (invoked inside effect bodies, never at module
// init), so it is safe — mirrors the existing effects→registry (getDef) cycle.
import {
  remintCommanderForHand,
  chaosWarpPermanent,
  devotionTo,
  fireEntersTriggers,
  openDiscard,
  openSacrifice,
  remintForHiddenEntry,
  scheduleDelayed,
} from '../engine'

// intrinsic OR granted indestructible (Heroic Intervention) — the same check checkSBA's
// damage path uses, so a destroy effect and lethal damage agree on who survives
/** creature check on a definition (defIsCreature lives in dsl; this avoids an import cycle here) */
const isCreatureDef = (def: { types: CardType[] }) => def.types.includes('Creature')

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
      changeLife(ctx.state, t, -(n))
      logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to ${ctx.state.players[t]!.name}.`)
    } else if (isCreatureOnBattlefield(ctx.state, t)) {
      ctx.state.objects[t]!.damageMarked += n
      logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to ${getDef(ctx.state.objects[t]!.defName).name}.`)
    } else if (isPlaneswalkerOn(ctx.state, t)) {
      // "any target" includes a planeswalker (CR 115.4); damage to one removes that much loyalty
      // (CR 120.3c) and the 0-loyalty SBA then puts it into its owner's graveyard
      const pw = ctx.state.objects[t as ObjId]!
      pw.loyalty = (pw.loyalty ?? 0) - n
      logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to ${getDef(pw.defName).name} — it loses ${n} loyalty.`)
    }
  }
}

/** Is `id` a planeswalker on the battlefield? (damage to "any target" routes to loyalty) */
const isPlaneswalkerOn = (state: EffectContext['state'], id: ObjId | PlayerId) => {
  const o = Object.hasOwn(state.objects, id) ? state.objects[id as ObjId] : undefined
  return !!o && o.zone === 'battlefield' && getDef(o.defName).types.includes('Planeswalker')
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

/**
 * Brainstorm's second half: the controller puts `count` cards from their hand on top of their
 * library, in an order they choose (r.putBack). Hidden → hidden, so no re-mint is needed — the ids
 * were never serialised to anyone else. With fewer cards in hand than `count` they put back what
 * they have; an empty hand is a no-op.
 */
export const putBackOnTop = (count: number): Effect => (ctx) => {
  const hand = ctx.state.zones.perPlayer[ctx.controllerId]!.hand
  const n = Math.min(count, hand.length)
  if (n <= 0) return
  ctx.state.pending = { kind: 'putBack', player: ctx.controllerId }
  ctx.state.pendingPutBack = { player: ctx.controllerId, count: n }
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} puts ${n} card${n === 1 ? '' : 's'} back on top of their library.`)
}

/**
 * Chaos Warp: the OWNER of the target permanent shuffles it into their library, then reveals the
 * top card and puts it onto the battlefield if it is a permanent card. The leak-critical
 * public→hidden re-mint lives in the engine helper.
 */
export const chaosWarpTarget = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    chaosWarpPermanent(ctx.state, t)
  }
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
    if (kwA.includes('wither') || kwA.includes('infect')) putCounters(ctx.state, ob.id, '-1/-1', pa)
    else ob.damageMarked += pa
    if (kwA.includes('deathtouch')) ob.deathtouched = true
  }
  if (bDealsToA) {
    if (kwB.includes('wither') || kwB.includes('infect')) putCounters(ctx.state, oa.id, '-1/-1', pb)
    else oa.damageMarked += pb
    if (kwB.includes('deathtouch')) oa.deathtouched = true
  }
  logLine(ctx.state, `${getDef(oa.defName).name} and ${getDef(ob.defName).name} fight.`)
  // lifelink applies to ANY damage a source deals (CR 702.15e), including fight damage
  if (aDealsToB && kwA.includes('lifelink')) {
    changeLife(ctx.state, oa.controllerId, pa)
    logLine(ctx.state, `${ctx.state.players[oa.controllerId]!.name} gains ${pa} life (lifelink).`)
  }
  if (bDealsToA && kwB.includes('lifelink')) {
    changeLife(ctx.state, ob.controllerId, pb)
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
    // printed ("Dovin's Veto") OR granted by the mana that paid for it (Cavern of Souls)
    if (getDef(item.defName).cantBeCountered || item.cantBeCountered) {
      logLine(ctx.state, `${getDef(item.defName).name} can't be countered.`)
      continue
    }
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
    changeLife(ctx.state, obj.controllerId, power)
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
    changeLife(ctx.state, ctx.controllerId, -(mv))
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
    changeLife(ctx.state, ctx.controllerId, -(mv))
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
  filter: 'basicLand' | 'any' | { landSubtypes: string[] } | { types: CardType[]; maxManaValue?: number }
  dest: 'battlefield' | 'hand' | 'libraryTop' | 'graveyard'
  tapped?: boolean
  /** the tutors: reveal the chosen card (log its name) as it goes on top */
  reveal?: boolean
  count?: number
  /** Fabled Passage: untap the fetched land if its controller then controls ≥ N lands */
  untapIfLandsAtLeast?: number
  /** Myriad Landscape: the picks must SHARE a land type */
  shareSubtype?: boolean
  /** Krosan Verge: the picks must cover both of these subtypes ("a Forest card and a Plains card") */
  pairSubtypes?: [string, string]
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
    // a card-TYPE filter (the tutors: "an artifact or enchantment card") is not land-specific
    if (typeof opts.filter === 'object' && 'types' in opts.filter) {
      if (!opts.filter.types.some((t) => def.types.includes(t))) return false
      // "an artifact card with mana cost {0} or {1}" (Urza's Saga's third chapter)
      if (opts.filter.maxManaValue != null && manaValueOf(def) > opts.filter.maxManaValue) return false
      return true
    }
    if (!def.types.includes('Land')) return false
    if (typeof opts.filter === 'object' && 'landSubtypes' in opts.filter) {
      const wanted = opts.filter.landSubtypes
      return (def.subtypes ?? []).some((st) => wanted.includes(st))
    }
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
    ...(opts.reveal ? { reveal: true } : {}),
    ...(opts.shareSubtype ? { shareSubtype: true } : {}),
    ...(opts.pairSubtypes ? { pairSubtypes: opts.pairSubtypes } : {}),
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
/**
 * Surveil N (CR 701.42): look at the top N cards; the ones you don't keep on top go to your
 * GRAVEYARD. Shares the scry decision (r.scry's `toBottom` list means "to the graveyard" here), so
 * the peek is redacted and re-minted exactly like a scry. `thenDraw` sequences Consider's draw.
 */
export const surveil = (n: number, opts: { thenDraw?: number } = {}): Effect => (ctx) =>
  scry(n, { ...opts, surveil: true })(ctx)

/**
 * Ponder: "Look at the top three cards of your library, then put them back in any order. You may
 * shuffle." Shares the scry decision with `reorder` set — r.scry then reads `order` (or `shuffle`).
 */
export const lookAndReorder = (n: number, opts: { thenDraw?: number } = {}): Effect => (ctx) =>
  scry(n, { ...opts, reorder: true })(ctx)

export const scry = (n: number, opts: { thenDraw?: number; surveil?: boolean; reorder?: boolean } = {}): Effect => (ctx) => {
  const lib = ctx.state.zones.perPlayer[ctx.controllerId]!.library
  const cardIds = lib.slice(0, Math.min(n, lib.length))
  if (!cardIds.length) {
    // nothing to look at, but "…then draw a card" still happens (Opt with an empty library)
    for (let i = 0; i < (opts.thenDraw ?? 0); i++) drawOne(ctx.state, ctx.controllerId)
    return
  }
  ctx.state.pending = { kind: 'scry', player: ctx.controllerId }
  ctx.state.pendingScry = {
    player: ctx.controllerId,
    cardIds,
    ...(opts.thenDraw ? { thenDraw: opts.thenDraw } : {}),
    ...(opts.surveil ? { surveil: true } : {}),
    ...(opts.reorder ? { reorder: true } : {}),
  }
  logLine(
    ctx.state,
    `${ctx.state.players[ctx.controllerId]!.name} ${
      opts.reorder ? `looks at the top ${cardIds.length}` : opts.surveil ? `surveils ${cardIds.length}` : `scries ${cardIds.length}`
    }.`,
  )
}

/** Put N counters of a kind on each target permanent (permanent buffs / shrink). */
export const addCounters = (kind: '+1/+1' | '-1/-1', n: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    putCounters(ctx.state, obj.id, kind, n)
    logLine(ctx.state, `${getDef(obj.defName).name} gets ${n} ${kind} counter${n > 1 ? 's' : ''}.`)
  }
}

/** Put N counters on every creature the controller controls (e.g. Cathars' Crusade). */
export const addCountersToEachControlled = (kind: '+1/+1' | '-1/-1', n: number): Effect => (ctx) => {
  for (const c of battlefieldCreatures(ctx.state, ctx.controllerId)) putCounters(ctx.state, c.id, kind, n)
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
/** All creatures get -X/-X until end of turn, X being the life the caster paid (Toxic Deluge). */
export const weakenAllCreaturesX = (): Effect => (ctx) => weakenAllCreatures(ctx.x ?? 0)(ctx)

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
    changeLife(ctx.state, t, -(life))
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
  putCounters(ctx.state, o.id, '+1/+1', n)
  logLine(ctx.state, `${getDef(o.defName).name} adapts — gets ${n} +1/+1 counter${n === 1 ? '' : 's'}.`)
}

/** Monstrosity N (CR 701.31): if this creature isn't monstrous, put N +1/+1 counters on it and it
 *  becomes monstrous. (The "activate only if not monstrous" restriction is enforced here at
 *  resolution — a documented simplification; the engine has no per-ability activation condition.) */
export const monstrosity = (n: number): Effect => (ctx) => {
  const o = ctx.state.objects[ctx.sourceId]
  if (!o || o.zone !== 'battlefield' || o.monstrous) return
  putCounters(ctx.state, o.id, '+1/+1', n)
  o.monstrous = true
  logLine(ctx.state, `${getDef(o.defName).name} becomes monstrous — gets ${n} +1/+1 counter${n === 1 ? '' : 's'}.`)
}

/** Grant protection from the given colour(s) to each target creature until end of turn (CR 613 layer 6). */
/**
 * Every permanent the controller controls gains `keywords` until end of turn (Heroic
 * Intervention). Unlike a static grant from a permanent, this reaches ANY permanent type —
 * lands and artifacts included (see `currentKeywords`). `creaturesOnly` narrows it to the
 * creatures ("Creatures you control gain indestructible" — Flawless Maneuver).
 */
export const grantKeywordsToControlled = (keywords: Keyword[], opts?: { creaturesOnly?: boolean }): Effect => (ctx) => {
  const all = ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield
  const ids = opts?.creaturesOnly ? all.filter((id) => isCreatureDef(getDef(ctx.state.objects[id]!.defName))) : all
  for (const id of ids) for (const keyword of keywords) (ctx.state.keywordGrants ??= []).push({ objId: id, keyword })
  logLine(
    ctx.state,
    `${ctx.state.players[ctx.controllerId]!.name}'s ${opts?.creaturesOnly ? 'creatures' : 'permanents'} gain ${keywords.join(' and ')} until end of turn.`,
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
  /** "This token gets +1/+1 for each artifact you control" (Urza's Saga's Construct) */
  dynamicPT?: CardDefinition['dynamicPT']
}

/**
 * The Treasure token (CR 111.10-style predefined token): "Artifact — Treasure. {T}, Sacrifice this
 * token: Add one mana of any color." The sacrifice is part of a MANA ability's cost, so it never
 * uses the stack (see r.tapMana) — the colour is chosen on tap, as for any any-colour source.
 */
/** A Food token: "{2}, {T}, Sacrifice this token: You gain 3 life." (Gingerbread Cabin) */
export const FOOD: TokenSpec = {
  name: 'Food',
  types: ['Artifact'],
  subtypes: ['Food'],
  abilities: [
    {
      kind: 'activated',
      cost: { mana: '{2}', tap: true, sacrificeSelf: true },
      // wrapped so `gainLife`, declared later in this module, resolves at call time
      effect: (ctx) => gainLife(3)(ctx),
    },
  ],
}

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
 * Counter each target spell, then its CONTROLLER gets `count` tokens of `spec` — the compensation
 * goes to the countered player, not to you (An Offer You Can't Refuse's Treasures, Swan Song's Bird).
 */
export const counterTargetGrantingToken = (spec: TokenSpec, count: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    const item = ctx.state.zones.stack.find((s) => s.kind === 'spell' && s.id === t)
    if (!item) continue // already resolved / countered
    // printed ("Dovin's Veto") OR granted by the mana that paid for it (Cavern of Souls)
    if (getDef(item.defName).cantBeCountered || item.cantBeCountered) {
      logLine(ctx.state, `${getDef(item.defName).name} can't be countered.`)
      continue
    }
    const victim = item.controllerId
    logLine(ctx.state, `${sourceName(ctx)} counters ${getDef(item.defName).name}.`)
    if (item.flashback) moveTo(ctx.state, item.id, 'exile')
    else moveToGraveyard(ctx.state, item.id)
    spawnTokens(ctx.state, victim, spec, count)
  }
}

/** An Offer You Can't Refuse: counter, then its controller creates `count` Treasures. */
export const counterTargetGrantingTreasures = (count: number): Effect => counterTargetGrantingToken(TREASURE, count)

/** Mint `count` real (mortal) tokens onto `ownerId`'s battlefield. */
function spawnTokens(state: EffectContext['state'], ownerId: PlayerId, spec: TokenSpec, count: number) {
  spawnTokensByDefName(state, ownerId, registerImplementedToken(spec), spec.name, count)
}

/**
 * Mint `count` tokens of an ALREADY-REGISTERED token definition. Shared by the plain token effects and
 * by the copy-token ones (Scute Swarm, Helm of the Host), so a copy token goes through the same
 * doubling replacement effects (CR 616) and fires the same ETB triggers.
 */
function spawnTokensByDefName(
  state: EffectContext['state'],
  ownerId: PlayerId,
  defName: string,
  label: string,
  count: number,
) {
  if (count > 0) state.players[ownerId]!.createdTokenThisTurn = true // Idol of Oblivion's condition
  // token-creation REPLACEMENT effects (CR 616): Doubling Season / Parallel Lives / Anointed
  // Procession each double the count, and several stack multiplicatively
  const doublers = state.zones.perPlayer[ownerId]!.battlefield.filter((id) => {
    const src = state.objects[id]
    return !!src && !src.phasedOut && !state.loseAbilities.includes(id) && getDef(src.defName).tokenReplacement === 'double'
  }).length
  if (doublers && count > 0) {
    const doubled = count * 2 ** doublers
    logLine(state, `${state.players[ownerId]!.name} creates ${doubled} ${label} tokens instead of ${count}.`)
    count = doubled
  }
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
  logLine(state, `${state.players[ownerId]!.name} creates ${count} ${label} token${count > 1 ? 's' : ''}.`)
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
  changeLife(ctx.state, ctx.controllerId, x)
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
  changeLife(ctx.state, ctx.controllerId, n)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} gains ${n} life.`)
}

/** Controller loses N life (payment / drawback). */
export const loseLife = (n: number): Effect => (ctx) => {
  changeLife(ctx.state, ctx.controllerId, -(n))
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} loses ${n} life.`)
}

/** Each opponent (still in the game) loses N life. */
export const eachOpponentLoses = (n: number): Effect => (ctx) => {
  for (const pid of ctx.state.turnOrder) {
    if (pid === ctx.controllerId) continue
    const p = ctx.state.players[pid]!
    if (!p.hasLost) changeLife(ctx.state, pid, -n)
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
    if (!p.hasLost) changeLife(ctx.state, pid, -n)
  }
  logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to each opponent.`)
}

/** Deal N damage to EACH player, including the source's controller (Flame Rift — symmetric). */
export const dealToEachPlayer = (n: number): Effect => (ctx) => {
  for (const pid of ctx.state.turnOrder) {
    const p = ctx.state.players[pid]!
    if (!p.hasLost) changeLife(ctx.state, pid, -n)
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

/**
 * Add one mana of `color` for each land with `subtype` the controller controls (Cabal Coffers'
 * "{B} for each Swamp you control"). A count-based mana ability, so the engine runs this effect
 * rather than adding a fixed/chosen mana; redact's pre-tap potential pool counts it as one (it
 * re-checks the real pool on tap, and a source that produces MORE than predicted never overpays).
 */
export const addManaPerLandSubtype = (color: ManaColor, subtype: string): Effect => (ctx) => {
  const n = ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield.filter((id) => {
    const def = getDef(ctx.state.objects[id]!.defName)
    return def.types.includes('Land') && (def.subtypes ?? []).includes(subtype)
  }).length
  ctx.state.players[ctx.controllerId]!.manaPool[color] += n
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} adds ${n} {${color}} (one per ${subtype}).`)
}

/**
 * Blood Artist: the target player loses N life and the ability's controller gains N (a drain, not
 * damage — no prevention, no lifelink interaction).
 */
export const drainTargetPlayer = (n: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (!isPlayerId(ctx, t)) continue
    changeLife(ctx.state, t, -(n))
    changeLife(ctx.state, ctx.controllerId, n)
    logLine(ctx.state, `${ctx.state.players[t]!.name} loses ${n} life; ${ctx.state.players[ctx.controllerId]!.name} gains ${n}.`)
  }
}

/**
 * Gray Merchant of Asphodel: each opponent loses X life, where X is the controller's devotion to
 * `color`, and the controller gains the total lost.
 */
export const drainEachOpponentByDevotion = (color: ManaColor): Effect => (ctx) => {
  const x = devotionTo(ctx.state, ctx.controllerId, color)
  if (x <= 0) return
  let gained = 0
  for (const pid of ctx.state.turnOrder) {
    if (pid === ctx.controllerId || ctx.state.players[pid]!.hasLost) continue
    changeLife(ctx.state, pid, -(x))
    gained += x
  }
  changeLife(ctx.state, ctx.controllerId, gained)
  logLine(
    ctx.state,
    `Each opponent loses ${x} life (devotion to {${color}}); ${ctx.state.players[ctx.controllerId]!.name} gains ${gained}.`,
  )
}

/**
 * Boseiju: destroy the target, then ITS controller may search their library for a land with a basic
 * land type and put it onto the battlefield (a search opened for that player — they may take nothing).
 * `basicOnly` narrows the search to actual BASIC lands (Assassin's Trophy).
 */
export const destroyTargetControllerFetchesLand = (opts?: { basicOnly?: boolean }): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    const owner = obj.controllerId
    const nm = getDef(obj.defName).name
    if (isIndestructible(ctx, t)) {
      logLine(ctx.state, `${nm} is indestructible.`)
      continue
    }
    logLine(ctx.state, `${nm} is destroyed.`)
    moveToGraveyard(ctx.state, t)
    // the affected player searches for a land (untapped, per the card) — a basic land for
    // Assassin's Trophy, any land with a basic land type for Boseiju
    searchLibrary({
      filter: opts?.basicOnly ? 'basicLand' : { landSubtypes: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] },
      dest: 'battlefield',
      count: 1,
    })({ ...ctx, controllerId: owner })
  }
}

/** Nature's Claim: destroy each target permanent, then ITS controller gains `life`. */
export const destroyPermanentControllerGains = (life: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    const owner = obj.controllerId
    const nm = getDef(obj.defName).name
    if (isIndestructible(ctx, t)) logLine(ctx.state, `${nm} is indestructible.`)
    else {
      logLine(ctx.state, `${nm} is destroyed.`)
      moveToGraveyard(ctx.state, t)
    }
    changeLife(ctx.state, owner, life)
    logLine(ctx.state, `${ctx.state.players[owner]!.name} gains ${life} life.`)
  }
}

/** Shamanic Revelation: draw one card per creature you control. */
export const drawPerControlledCreature = (): Effect => (ctx) => {
  const n = battlefieldCreatures(ctx.state, ctx.controllerId).length
  for (let i = 0; i < n; i++) drawOne(ctx.state, ctx.controllerId)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} draws ${n} card${n === 1 ? '' : 's'} (one per creature).`)
}

/** Shamanic Revelation's ferocious rider: gain `life` per creature you control with power ≥ `power`. */
export const gainLifePerBigCreature = (power: number, life: number): Effect => (ctx) => {
  const n = battlefieldCreatures(ctx.state, ctx.controllerId).filter((c) => currentPower(ctx.state, c) >= power).length
  if (!n) return
  changeLife(ctx.state, ctx.controllerId, n * life)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} gains ${n * life} life (ferocious).`)
}

/** Aetherflux Reservoir: gain 1 life for each spell its controller has cast this turn. */
export const gainLifePerSpellThisTurn = (): Effect => (ctx) => {
  const n = ctx.state.players[ctx.controllerId]!.spellsThisTurn ?? 0
  if (!n) return
  changeLife(ctx.state, ctx.controllerId, n)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} gains ${n} life (spells cast this turn).`)
}

/**
 * Frantic Search: draw `draw`, then discard `discard`, then untap up to `untap` of your lands. The
 * untap rides on the discard decision (pendingDiscard.thenUntapLands) so it happens AFTER the cards
 * are chosen. SIMPLIFICATION: the printed "untap up to three lands" can untap ANY lands; the engine
 * untaps up to that many of the controller's own tapped lands, which is the only sensible choice.
 */
export const drawThenDiscardThenUntap = (draw: number, discard: number, untap: number): Effect => (ctx) => {
  for (let i = 0; i < draw; i++) drawOne(ctx.state, ctx.controllerId)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} draws ${draw} cards.`)
  const hand = ctx.state.zones.perPlayer[ctx.controllerId]!.hand
  const toDiscard = Math.min(discard, hand.length)
  if (toDiscard > 0) {
    openDiscard(ctx.state, [ctx.controllerId], toDiscard, untap)
    return
  }
  untapOwnLands(ctx.state, ctx.controllerId, untap)
}

/** Untap up to `n` of a player's own tapped lands (Frantic Search's rider). */
export function untapOwnLands(state: EffectContext['state'], player: PlayerId, n: number) {
  let done = 0
  for (const id of state.zones.perPlayer[player]!.battlefield) {
    if (done >= n) break
    const obj = state.objects[id]!
    if (!obj.tapped || !getDef(obj.defName).types.includes('Land')) continue
    obj.tapped = false
    done++
  }
  if (done) logLine(state, `${state.players[player]!.name} untaps ${done} land${done === 1 ? '' : 's'}.`)
}

/**
 * Sun Titan: return each target graveyard card to the battlefield under the ability's controller.
 * (Reanimate's own rider — losing life equal to its mana value — lives in `reanimate`; this is the
 * plain version.)
 */
export const returnFromGraveyardToBattlefield = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'graveyard') continue
    const def = getDef(obj.defName)
    obj.controllerId = ctx.controllerId
    obj.summoningSick = isCreatureDef(def)
    moveTo(ctx.state, t, 'battlefield')
    logLine(ctx.state, `${def.name} returns to the battlefield under ${ctx.state.players[ctx.controllerId]!.name}'s control.`)
    fireEntersTriggers(ctx.state, t)
  }
}

/** Loran of the Third Path: the controller and a target opponent each draw a card. */
export const eachOfYouAndTargetDraws = (n: number): Effect => (ctx) => {
  for (let i = 0; i < n; i++) drawOne(ctx.state, ctx.controllerId)
  for (const t of ctx.targets) {
    if (!isPlayerId(ctx, t)) continue
    for (let i = 0; i < n; i++) drawOne(ctx.state, t)
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} and ${ctx.state.players[t]!.name} each draw ${n}.`)
  }
}

/**
 * Schedule one of the source card's `delayed` bodies (CR 603.7). `captureX` reads a value off the
 * resolution context to remember (Mana Drain: the countered spell's mana value).
 */
export const scheduleDelayedTrigger = (
  key: string,
  opts: {
    at: 'nextUpkeep' | 'nextMainPhase'
    captureX?: (ctx: EffectContext) => number
    /** "at the beginning of the NEXT TURN's upkeep" — whoever is active then (Arcane Denial) */
    anyPlayersTurn?: boolean
    /** schedule it for each TARGETED player instead of the controller (Arcane Denial's victim) */
    forTargets?: boolean
  } = { at: 'nextUpkeep' },
): Effect => (ctx) => {
  const src = ctx.state.objects[ctx.sourceId]
  const defName = src ? src.defName : ''
  if (!defName) return
  if (opts.forTargets) {
    // the countered spell's CONTROLLER gets the delayed draw, not the caster
    for (const t of ctx.targets) {
      const item = ctx.state.zones.stack.find((x) => x.id === t)
      const who = item ? item.controllerId : isPlayerId(ctx, t) ? (t as PlayerId) : null
      if (!who) continue
      scheduleDelayed(ctx.state, {
        at: opts.at,
        player: who,
        defName,
        key,
        ...(opts.anyPlayersTurn ? { anyPlayersTurn: true } : {}),
      })
      logLine(ctx.state, `${getDef(defName).name} sets up a delayed trigger for ${ctx.state.players[who]!.name}.`)
    }
    return
  }
  scheduleDelayed(ctx.state, {
    at: opts.at,
    player: ctx.controllerId,
    defName,
    key,
    ...(opts.anyPlayersTurn ? { anyPlayersTurn: true } : {}),
    ...(opts.captureX ? { x: opts.captureX(ctx) } : {}),
  })
  logLine(ctx.state, `${getDef(defName).name} sets up a delayed trigger.`)
}

/** Mana Drain: add X mana of `color` (X captured when the delayed trigger was scheduled). */
export const addManaEqualToX = (color: ManaColor): Effect => (ctx) => {
  const n = ctx.x ?? 0
  if (n <= 0) return
  ctx.state.players[ctx.controllerId]!.manaPool[color] += n
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} adds ${n} {${color}}.`)
}

/** Pact of Negation: the controller loses the game (the unpaid half of a pact). */
export const loseTheGame = (): Effect => (ctx) => {
  ctx.state.players[ctx.controllerId]!.hasLost = true
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} loses the game (unpaid pact).`)
}

/** The mana value of the spell this effect is countering / referring to (for captureX). */
export const targetSpellManaValue = (ctx: EffectContext): number => {
  for (const t of ctx.targets) {
    const item = ctx.state.zones.stack.find((st) => st.kind === 'spell' && st.id === t)
    if (item) return manaValueOf(getDef(item.defName))
  }
  return 0
}

/** Takenuma: the controller mills N cards (the target-based `mill` needs a player target). */
export const millSelf = (n: number): Effect => (ctx) => {
  const lib = ctx.state.zones.perPlayer[ctx.controllerId]!.library
  const moved = Math.min(n, lib.length)
  for (let i = 0; i < moved; i++) moveTo(ctx.state, lib[0]!, 'graveyard')
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} mills ${moved} card${moved === 1 ? '' : 's'}.`)
}

/** Bloom Tender: for each COLOUR among permanents you control, add one mana of that colour. */
export const addManaPerColorAmongPermanents = (): Effect => (ctx) => {
  const colors = new Set<ManaColor>()
  for (const id of ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield)
    for (const c of getDef(ctx.state.objects[id]!.defName).colors ?? []) colors.add(c)
  for (const c of colors) ctx.state.players[ctx.controllerId]!.manaPool[c]++
  logLine(
    ctx.state,
    `${ctx.state.players[ctx.controllerId]!.name} adds ${colors.size} mana (one per colour among their permanents).`,
  )
}

/**
 * Windfall: every player discards their ENTIRE hand, then each draws cards equal to the greatest
 * number any one player discarded this way. No decision to make (the whole hand goes), so this
 * needs no discard prompt — unlike the choice-based `playersDiscard`.
 */
export const windfall = (): Effect => (ctx) => {
  const order = apnapOrder(ctx.state, ctx.state.activePlayer)
  let greatest = 0
  for (const pid of order) {
    const hand = ctx.state.zones.perPlayer[pid]!.hand
    const n = hand.length
    greatest = Math.max(greatest, n)
    for (const id of [...hand]) moveToGraveyard(ctx.state, id)
    if (n) logLine(ctx.state, `${ctx.state.players[pid]!.name} discards their hand (${n} card${n === 1 ? '' : 's'}).`)
  }
  for (const pid of order) for (let i = 0; i < greatest; i++) drawOne(ctx.state, pid)
  logLine(ctx.state, `Each player draws ${greatest} card${greatest === 1 ? '' : 's'}.`)
}

/**
 * Mass destroy by card TYPE, optionally narrowed by mana value (Austere Command's four modes:
 * "Destroy all artifacts" / "all enchantments" / "all creatures with mana value 3 or less" /
 * "…4 or greater"). Indestructible permanents survive, and — assisted table — a fallback
 * (unimplemented) card is never auto-destroyed; the count of survivors is logged either way.
 */
export const destroyAllOfType = (
  types: CardType[],
  opts?: { maxManaValue?: number; minManaValue?: number },
): Effect => (ctx) => {
  const matches = Object.values(ctx.state.objects).filter((o) => {
    if (o.zone !== 'battlefield') return false
    const def = getDef(o.defName)
    if (!types.some((t) => def.types.includes(t))) return false
    const mv = manaValueOf(def)
    if (opts?.maxManaValue != null && mv > opts.maxManaValue) return false
    if (opts?.minManaValue != null && mv < opts.minManaValue) return false
    return true
  })
  const doomed = matches.filter((o) => !getDef(o.defName).unimplemented && !isIndestructible(ctx, o.id))
  for (const o of doomed) {
    logLine(ctx.state, `${getDef(o.defName).name} is destroyed.`)
    moveToGraveyard(ctx.state, o.id)
  }
  const skipped = matches.length - doomed.length
  logLine(
    ctx.state,
    `All ${describeSweep(types, opts)} are destroyed${skipped ? ` — ${skipped} indestructible/unimplemented survive` : ''}.`,
  )
}

/**
 * Mass EXILE by card type (Farewell). Exile ignores indestructible, but the assisted-table rule
 * still holds: a fallback card is hand-run, so it is left alone rather than silently removed.
 */
export const exileAllOfType = (types: CardType[]): Effect => (ctx) => {
  const matches = Object.values(ctx.state.objects).filter(
    (o) => o.zone === 'battlefield' && types.some((t) => getDef(o.defName).types.includes(t)),
  )
  const doomed = matches.filter((o) => !getDef(o.defName).unimplemented)
  for (const o of doomed) {
    logLine(ctx.state, `${getDef(o.defName).name} is exiled.`)
    moveTo(ctx.state, o.id, 'exile')
  }
  const skipped = matches.length - doomed.length
  logLine(
    ctx.state,
    `All ${describeSweep(types)} are exiled${skipped ? ` — ${skipped} unimplemented card(s) stay` : ''}.`,
  )
}

/** "Exile all graveyards" (Farewell's fourth mode) — every player's, not a targeted one. */
export const exileAllGraveyards = (): Effect => (ctx) => {
  let n = 0
  for (const pid of ctx.state.turnOrder) {
    const gy = ctx.state.zones.perPlayer[pid]!.graveyard
    n += gy.length
    while (gy.length) moveTo(ctx.state, gy[0]!, 'exile')
  }
  logLine(ctx.state, `All graveyards are exiled (${n} card${n === 1 ? '' : 's'}).`)
}

/** Every creature you control gains protection from `colors` until end of turn (Akroma's Will). */
export const grantProtectionToControlled = (colors: ManaColor[]): Effect => (ctx) => {
  const ids = ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield.filter((id) =>
    isCreatureDef(getDef(ctx.state.objects[id]!.defName)),
  )
  for (const id of ids) for (const color of colors) ctx.state.protectionGrants.push({ objId: id, color })
  logLine(
    ctx.state,
    `${ctx.state.players[ctx.controllerId]!.name}'s creatures gain protection from ${colors.length === 5 ? 'all colors' : colors.join('/')} until end of turn.`,
  )
}

/** Log wording for a sweep: "artifacts", "creatures with mana value 3 or less", … */
const describeSweep = (types: CardType[], opts?: { maxManaValue?: number; minManaValue?: number }) => {
  const what = types.map((t) => `${t.toLowerCase()}s`).join(' and ')
  if (opts?.maxManaValue != null) return `${what} with mana value ${opts.maxManaValue} or less`
  if (opts?.minManaValue != null) return `${what} with mana value ${opts.minManaValue} or greater`
  return what
}

/**
 * Boros Charm's third mode: each TARGET creature gains `keywords` until end of turn. The
 * controlled-permanents version is grantKeywordsToControlled; this one is target-driven.
 */
export const grantKeywordsToTarget = (keywords: Keyword[]): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    for (const keyword of keywords) (ctx.state.keywordGrants ??= []).push({ objId: t, keyword })
    logLine(
      ctx.state,
      `${getDef(ctx.state.objects[t]!.defName).name} gains ${keywords.join(' and ')} until end of turn.`,
    )
  }
}

/**
 * Return of the Wildspeaker's first mode: "Draw cards equal to the greatest power among non-Human
 * creatures you control." Power is the CURRENT power (counters, pumps and anthems included).
 */
export const drawPerGreatestPowerAmong = (opts: { excludeSubtypes?: string[] }): Effect => (ctx) => {
  const mine = battlefieldCreatures(ctx.state, ctx.controllerId).filter(
    (c) => !(opts.excludeSubtypes ?? []).some((st) => (getDef(c.defName).subtypes ?? []).includes(st)),
  )
  const greatest = mine.reduce((best, c) => Math.max(best, currentPower(ctx.state, c)), 0)
  for (let i = 0; i < greatest; i++) drawOne(ctx.state, ctx.controllerId)
  logLine(
    ctx.state,
    `${ctx.state.players[ctx.controllerId]!.name} draws ${greatest} card${greatest === 1 ? '' : 's'} (greatest power among their ${(opts.excludeSubtypes ?? []).length ? `non-${opts.excludeSubtypes!.join('/non-')} ` : ''}creatures).`,
  )
}

/**
 * Return of the Wildspeaker's second mode: creatures you control get +power/+toughness until end of
 * turn, optionally skipping some subtypes ("Non-Human creatures you control get +3/+3"). Skips
 * `unimplemented` (assisted-table) creatures like every other mass-creature effect.
 */
export const pumpControlled = (power: number, toughness: number, opts?: { excludeSubtypes?: string[] }): Effect => (ctx) => {
  let n = 0
  for (const c of battlefieldCreatures(ctx.state, ctx.controllerId)) {
    const def = getDef(c.defName)
    if (def.unimplemented) continue
    if ((opts?.excludeSubtypes ?? []).some((st) => (def.subtypes ?? []).includes(st))) continue
    ctx.state.pumps.push({ objId: c.id, power, toughness })
    n++
  }
  logLine(
    ctx.state,
    `${n} creature${n === 1 ? '' : 's'} ${ctx.state.players[ctx.controllerId]!.name} controls get +${power}/+${toughness} until end of turn.`,
  )
}

/**
 * IMPULSE DRAW (Jeska's Will, Reckless Impulse, Commune with Lava): exile the top `n` cards of the
 * controller's library face up and let them PLAY those cards for a while — lands included, which is
 * why the marker lives on the object rather than in a cast-only list. `n: 'x'` takes the spell's X.
 * Library → exile is hidden → public, so the cards become known to everyone, exactly as printed.
 */
export const impulseExile = (n: number | 'x', until: 'endOfTurn' | 'endOfYourNextTurn'): Effect => (ctx) => {
  const lib = ctx.state.zones.perPlayer[ctx.controllerId]!.library
  const count = Math.min(n === 'x' ? (ctx.x ?? 0) : n, lib.length)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const id = lib[0]!
    names.push(getDef(ctx.state.objects[id]!.defName).name)
    moveTo(ctx.state, id, 'exile')
    const obj = ctx.state.objects[id]!
    obj.playableBy = ctx.controllerId
    obj.playableUntil = until
    obj.playableFromTurn = ctx.state.turnNumber
  }
  logLine(
    ctx.state,
    count
      ? `${ctx.state.players[ctx.controllerId]!.name} exiles ${names.join(', ')} and may play ${count === 1 ? 'it' : 'them'} ${until === 'endOfTurn' ? 'this turn' : 'until the end of their next turn'}.`
      : `${ctx.state.players[ctx.controllerId]!.name} has no cards left to exile.`,
  )
}

/** Jeska's Will's first mode: add {R} for each card in TARGET opponent's hand. */
export const addManaPerCardInTargetHand = (color: ManaColor): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (!isPlayerId(ctx, t)) continue
    const n = ctx.state.zones.perPlayer[t]!.hand.length
    ctx.state.players[ctx.controllerId]!.manaPool[color] += n
    logLine(
      ctx.state,
      `${ctx.state.players[ctx.controllerId]!.name} adds ${n} {${color}} (one per card in ${ctx.state.players[t]!.name}'s hand).`,
    )
  }
}

/** Sword of Feast and Famine: untap EVERY land you control (not the capped Frantic Search rider). */
export const untapAllOwnLands = (): Effect => (ctx) => {
  untapOwnLands(ctx.state, ctx.controllerId, Number.MAX_SAFE_INTEGER)
}

/**
 * 'Until end of turn, target creature gains "When this creature dies, …"' (Malakir Rebirth, Feign
 * Death, Undying Malice). `key` names the granted body inside the GRANTING card's `grantedAbilities`,
 * so the state stores only names — see RulesGameState.grantedTriggers.
 */
export const grantDiesTriggerUntilEOT = (key: string): Effect => (ctx) => {
  const granterName = getDef(ctx.state.objects[ctx.sourceId]?.defName ?? '').name
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t) || !isCreatureOnBattlefield(ctx.state, t)) continue
    ;(ctx.state.grantedTriggers ??= []).push({
      objId: t,
      defName: ctx.state.objects[ctx.sourceId]!.defName,
      key,
      trigger: 'dies',
    })
    logLine(
      ctx.state,
      `${getDef(ctx.state.objects[t]!.defName).name} gains ${granterName}'s dies ability until end of turn.`,
    )
  }
}

/**
 * The body of that granted ability: return the creature that died to the battlefield TAPPED under its
 * OWNER's control, optionally with a +1/+1 counter (Feign Death / Undying Malice). It resolves while
 * the card sits in the graveyard, so it moves it from there.
 */
export const returnSelfTappedFromGraveyard = (opts?: { plusOneCounter?: boolean }): Effect => (ctx) => {
  const obj = ctx.state.objects[ctx.sourceId]
  if (!obj || obj.zone !== 'graveyard') return
  obj.controllerId = obj.ownerId
  moveTo(ctx.state, ctx.sourceId, 'battlefield')
  obj.tapped = true
  obj.summoningSick = true // it returns as a new object
  if (opts?.plusOneCounter) putCounters(ctx.state, ctx.sourceId, '+1/+1', 1)
  logLine(
    ctx.state,
    `${getDef(obj.defName).name} returns to the battlefield tapped${opts?.plusOneCounter ? ' with a +1/+1 counter' : ''}.`,
  )
}

/**
 * Open a "choose a card from your hand" decision (Growth Spiral's land drop, Chrome Mox's imprint).
 * The picks go to `dest`; `imprint` records the chosen card's def name on the source permanent
 * (CR 702.61). Nothing is revealed to opponents until a card actually moves to a public zone.
 */
export const chooseFromHand = (opts: {
  count?: number
  filter: 'land' | 'nonartifactNonland' | 'any'
  dest: 'battlefield' | 'exile'
  optional?: boolean
  imprint?: boolean
}): Effect => (ctx) => {
  const hand = ctx.state.zones.perPlayer[ctx.controllerId]!.hand
  const eligible = hand.filter((id) => handCardMatches(ctx.state, id, opts.filter))
  if (!eligible.length) {
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} has no eligible card in hand.`)
    return
  }
  ctx.state.pending = { kind: 'handChoice', player: ctx.controllerId }
  ctx.state.pendingHandChoice = {
    player: ctx.controllerId,
    count: opts.count ?? 1,
    filter: opts.filter,
    dest: opts.dest,
    optional: opts.optional ?? true,
    ...(opts.imprint ? { imprint: true, sourceId: ctx.sourceId } : {}),
  }
}

/** Does a card in hand match a hand-choice filter? (shared with the engine's validation) */
export function handCardMatches(state: EffectContext['state'], id: ObjId, filter: 'land' | 'nonartifactNonland' | 'any') {
  const def = getDef(state.objects[id]!.defName)
  if (filter === 'land') return def.types.includes('Land')
  if (filter === 'nonartifactNonland') return !def.types.includes('Artifact') && !def.types.includes('Land')
  return true
}

/**
 * Sensei's Divining Top: "Draw a card, then put this artifact on top of its owner's library."
 * Battlefield → library is PUBLIC → HIDDEN, so the id must be re-minted (invariant #3) or an opponent
 * who noted the Top's battlefield id could follow it into the library.
 */
export const drawThenSelfOnTopOfLibrary = (): Effect => (ctx) => {
  const obj = ctx.state.objects[ctx.sourceId]
  drawOne(ctx.state, ctx.controllerId)
  if (!obj || obj.zone !== 'battlefield') return
  const name = getDef(obj.defName).name
  moveTo(ctx.state, ctx.sourceId, 'library', { top: true })
  remintForHiddenEntry(ctx.state, ctx.sourceId, true)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} draws a card and puts ${name} on top of their library.`)
}

/** "Untap this artifact" (Mana Vault's upkeep payment, the Monoliths' activated ability). */
export const untapSelf = (): Effect => (ctx) => {
  const obj = ctx.state.objects[ctx.sourceId]
  if (!obj || obj.zone !== 'battlefield' || !obj.tapped) return
  obj.tapped = false
  logLine(ctx.state, `${getDef(obj.defName).name} untaps.`)
}

/** "…it deals N damage to you" (Mana Vault's draw-step trigger). */
export const damageToController = (n: number): Effect => (ctx) => {
  changeLife(ctx.state, ctx.controllerId, -(n))
  logLine(
    ctx.state,
    `${getDef(ctx.state.objects[ctx.sourceId]?.defName ?? '').name} deals ${n} damage to ${ctx.state.players[ctx.controllerId]!.name}.`,
  )
}

/**
 * PROLIFERATE (CR 701.28): open the choice for the controller — any number of permanents and/or
 * players that already have a counter, each of which then gets one more of every kind it has.
 * `times` runs it that many times, each with its own choice (Contagion Engine proliferates twice).
 * No eligible permanent or player → nothing to choose, so no prompt.
 */
export const proliferate = (times = 1): Effect => (ctx) => {
  if (!proliferateTargets(ctx.state).permanents.length && !proliferateTargets(ctx.state).players.length) {
    logLine(ctx.state, `Nothing has a counter — proliferate does nothing.`)
    return
  }
  ctx.state.pending = { kind: 'proliferate', player: ctx.controllerId }
  ctx.state.pendingProliferate = { player: ctx.controllerId, remaining: times }
}

/**
 * Contagion Engine's ETB: put `n` counters of `kind` on each creature a TARGET player controls (real
 * counters, unlike the until-end-of-turn `weakenControlledCreatures`). Skips fallback cards, like every
 * other mass-creature effect, and goes through putCounters so replacements apply.
 */
export const countersOnEachCreatureOfTarget = (kind: '+1/+1' | '-1/-1', n: number): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (!isPlayerId(ctx, t)) continue
    for (const c of battlefieldCreatures(ctx.state, t)) {
      if (getDef(c.defName).unimplemented) continue
      putCounters(ctx.state, c.id, kind, n)
    }
    logLine(ctx.state, `Each creature ${ctx.state.players[t]!.name} controls gets ${n} ${kind} counter${n === 1 ? '' : 's'}.`)
  }
}

/**
 * Helm of the Host: "create a token that's a copy of equipped creature, except the token isn't
 * legendary. That token gains haste." The copy is a full definition copy (registerCopyToken), so the
 * token has the original's abilities and triggers, not just its P/T.
 */
export const createCopyOfAttached = (): Effect => (ctx) => {
  const equipment = ctx.state.objects[ctx.sourceId]
  const hostId = equipment?.attachedTo
  const host = hostId ? ctx.state.objects[hostId] : undefined
  if (!host || host.zone !== 'battlefield') return
  const defName = registerCopyToken(getDef(host.defName), { dropLegendary: true, addKeywords: ['haste'] })
  const id = mintCardId()
  ctx.state.objects[id] = {
    id,
    defName,
    ownerId: ctx.controllerId,
    controllerId: ctx.controllerId,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false, // it has haste
    damageMarked: 0,
    counters: {},
    isCommander: false,
    attackingDefender: null,
    blockingAttackerId: null,
  }
  ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield.push(id)
  ctx.state.players[ctx.controllerId]!.createdTokenThisTurn = true
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} creates a token copy of ${getDef(host.defName).name} (with haste).`)
  fireEntersTriggers(ctx.state, id)
}

/**
 * The Ozolith: "Whenever a creature you control leaves the battlefield, if it had counters on it, put
 * those counters on The Ozolith." The leaving creature arrives as the trigger's implicit target and its
 * counters are read from `lastCounters` (last known information — moveTo has already cleared them).
 */
export const moveLastCountersToSelf = (): Effect => (ctx) => {
  const src = ctx.state.objects[ctx.sourceId]
  if (!src || src.zone !== 'battlefield') return
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const gone = ctx.state.objects[t]
    const had = gone?.lastCounters ?? {}
    let moved = 0
    for (const [kind, n] of Object.entries(had)) {
      if (n > 0) {
        putCounters(ctx.state, ctx.sourceId, kind, n)
        moved += n
      }
    }
    if (moved) logLine(ctx.state, `${getDef(src.defName).name} gains ${moved} counter${moved === 1 ? '' : 's'} from ${getDef(gone!.defName).name}.`)
  }
}

/** The Ozolith's combat trigger: move ALL counters from this permanent onto a target creature. */
export const moveAllCountersToTarget = (): Effect => (ctx) => {
  const src = ctx.state.objects[ctx.sourceId]
  if (!src || src.zone !== 'battlefield') return
  const target = ctx.targets.find((t) => !isPlayerId(ctx, t) && isCreatureOnBattlefield(ctx.state, t))
  if (target == null) return
  const counters = { ...src.counters }
  src.counters = {}
  let moved = 0
  for (const [kind, n] of Object.entries(counters)) {
    if (n > 0) {
      putCounters(ctx.state, target as ObjId, kind, n)
      moved += n
    }
  }
  if (moved)
    logLine(
      ctx.state,
      `${moved} counter${moved === 1 ? '' : 's'} move from ${getDef(src.defName).name} onto ${getDef(ctx.state.objects[target as ObjId]!.defName).name}.`,
    )
}

/** Animate Dead: "that creature's controller sacrifices it" as the Aura leaves the battlefield. */
export const sacrificeFormerHost = (): Effect => (ctx) => {
  const aura = ctx.state.objects[ctx.sourceId]
  const hostId = aura?.attachedTo ?? aura?.lastAttachedTo
  const host = hostId ? ctx.state.objects[hostId] : undefined
  if (!host || host.zone !== 'battlefield') return
  logLine(ctx.state, `${getDef(host.defName).name} is sacrificed (${getDef(aura!.defName).name} left the battlefield).`)
  moveToGraveyard(ctx.state, host.id)
}

/**
 * The Eldraine cycle (Mystic Sanctuary, Witch's Cottage): put a TARGET card from your graveyard on top
 * of your library. Graveyard → library is PUBLIC → HIDDEN, so the id is re-minted (invariant #3) —
 * otherwise an opponent who noted the graveyard id could follow it into the library.
 */
export const graveyardCardOnTopOfLibrary = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'graveyard') continue
    const label = getDef(obj.defName).name
    moveTo(ctx.state, t, 'library', { top: true })
    remintForHiddenEntry(ctx.state, t, true)
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} puts ${label} on top of their library.`)
  }
}

/**
 * "You gain protection from everything until your next turn" (The One Ring), optionally with "your life
 * total can't change" (Teferi's Protection). Both flags are cleared at the player's next untap step.
 */
export const protectionFromEverything = (opts?: { lifeCantChange?: boolean }): Effect => (ctx) => {
  const p = ctx.state.players[ctx.controllerId]!
  p.protectedFromEverything = true
  if (opts?.lifeCantChange) p.lifeCantChange = true
  logLine(
    ctx.state,
    `${p.name} gains protection from everything until their next turn${opts?.lifeCantChange ? ' and their life total cannot change' : ''}.`,
  )
}

/**
 * "All permanents you control phase out" (Teferi's Protection) — CR 702.26. They phase back in at the
 * start of that player's next untap step, which `runPhasing` already handles for anything phased out
 * without a `phasedOutBy` host.
 */
export const phaseOutAllYouControl = (): Effect => (ctx) => {
  const ids = [...ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield]
  for (const id of ids) {
    const obj = ctx.state.objects[id]
    if (!obj || obj.phasedOut) continue
    obj.phasedOut = true
    obj.phasedOutBy = undefined // phases in on its own at its controller's next untap step
  }
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name}'s ${ids.length} permanents phase out.`)
}

/**
 * The One Ring: "{T}: Put a burden counter on this artifact, then draw a card for each burden counter
 * on it." The counter goes through putCounters (so a doubler applies), and the draw count is read AFTER.
 */
export const burdenCounterThenDraw = (): Effect => (ctx) => {
  putCounters(ctx.state, ctx.sourceId, 'burden', 1)
  const n = ctx.state.objects[ctx.sourceId]?.counters['burden'] ?? 0
  for (let i = 0; i < n; i++) drawOne(ctx.state, ctx.controllerId)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} draws ${n} card${n === 1 ? '' : 's'} (burden counters).`)
}

/** The One Ring's upkeep: "you lose 1 life for each burden counter on this artifact." */
export const loseLifePerBurdenCounter = (): Effect => (ctx) => {
  const n = ctx.state.objects[ctx.sourceId]?.counters['burden'] ?? 0
  if (!n) return
  changeLife(ctx.state, ctx.controllerId, -n)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} loses ${n} life (burden counters).`)
}

/**
 * Herald's Horn: "look at the top card of your library. If it's a creature card of the chosen type, you
 * may reveal it and put it into your hand." The look is actor-only; the decision only opens when the
 * card actually matches, so a non-matching top card reveals nothing at all (not even that it was seen).
 */
export const lookTopTakeIfChosenType = (): Effect => (ctx) => {
  const src = ctx.state.objects[ctx.sourceId]
  const chosen = src?.chosenType
  const top = ctx.state.zones.perPlayer[ctx.controllerId]!.library[0]
  if (!top || !chosen) return
  const def = getDef(ctx.state.objects[top]!.defName)
  if (!def.types.includes('Creature') || !hasCreatureType(def, chosen)) {
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} looks at the top card of their library.`)
    return
  }
  ctx.state.pending = { kind: 'revealTop', player: ctx.controllerId }
  ctx.state.pendingRevealTop = {
    player: ctx.controllerId,
    cardId: top,
    sourceName: getDef(src!.defName).name,
  }
}

/**
 * "…may draw up to N cards" (Arcane Denial's compensation) — a 0..N choice for its controller. `label`
 * is passed explicitly because this runs from a DELAYED trigger, which has no source object to name
 * (the card is long gone from the stack by then).
 */
export const mayDrawUpTo = (max: number, label: string, opts?: { exact?: boolean }): Effect => (ctx) => {
  ctx.state.pending = { kind: 'mayDraw', player: ctx.controllerId }
  ctx.state.pendingMayDraw = {
    player: ctx.controllerId,
    max,
    sourceName: label,
    ...(opts?.exact ? { exact: true } : {}),
  }
}

/**
 * Deflecting Swat: "You may choose new targets for target spell or ability." Opens the re-aim decision
 * for THIS spell's controller; the new targets are validated against the targeted item's own specs, so
 * they must be legal for ITS controller (CR 115.7b) — that is what makes redirecting a Bolt back at its
 * caster legal while an illegal aim is refused.
 */
export const chooseNewTargets = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const item = ctx.state.zones.stack.find((x) => x.id === t)
    if (!item || !item.targets.length) continue
    ctx.state.pending = { kind: 'retarget', player: ctx.controllerId }
    ctx.state.pendingRetarget = {
      player: ctx.controllerId,
      itemId: item.id,
      sourceName: getDef(item.defName).name,
    }
    return
  }
}

/**
 * Victimize: "Sacrifice a creature. If you do, return the chosen cards to the battlefield tapped." The
 * targets are the graveyard cards; the sacrifice is a decision, so the return rides along on it and only
 * happens if a creature was actually sacrificed (no creature to sacrifice → nothing returns).
 */
export const sacrificeThenReturnTargetsTapped = (): Effect => (ctx) => {
  const cards = ctx.targets.filter((t): t is ObjId => !isPlayerId(ctx, t) && ctx.state.objects[t]?.zone === 'graveyard')
  if (!battlefieldCreatures(ctx.state, ctx.controllerId).length) {
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} controls no creature to sacrifice.`)
    return
  }
  openSacrifice(ctx.state, [ctx.controllerId], 1, { thenReturnTapped: cards })
}

/**
 * Command Beacon: "Put your commander into your hand from the command zone." The command zone is public
 * and everyone knows what your commander is, so this needs no re-mint (remintForHiddenEntry declines for
 * a commander for exactly that reason).
 */
export const commanderFromCommandZoneToHand = (): Effect => (ctx) => {
  const cmd = ctx.state.players[ctx.controllerId]!.commanderId
  const obj = cmd ? ctx.state.objects[cmd] : undefined
  if (!obj || obj.zone !== 'command') {
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name}'s commander is not in the command zone.`)
    return
  }
  const label = getDef(obj.defName).name
  moveTo(ctx.state, obj.id, 'hand')
  // the command zone is PUBLIC, so keeping the id would let an opponent follow the card into the hidden
  // hand (the leak fuzzer caught exactly that). Re-mint it and migrate the commander bookkeeping.
  remintCommanderForHand(ctx.state, obj.id)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} puts ${label} into their hand.`)
}

/**
 * Sink into Stupor: "Return target spell or nonland permanent an opponent controls to its owner's hand."
 * A SPELL on the stack goes to its owner's hand (it never resolves, and it is not "countered"); a
 * permanent takes the ordinary bounce path. Either way the card enters a HIDDEN zone from a public one, so
 * its id is re-minted (invariant #3).
 */
export const returnSpellOrPermanentToHand = (): Effect => (ctx) => {
  for (const t of ctx.targets) {
    if (isPlayerId(ctx, t)) continue
    const item = ctx.state.zones.stack.find((x) => x.kind === 'spell' && x.id === t)
    if (item) {
      const label = getDef(item.defName).name
      moveTo(ctx.state, t, 'hand')
      remintForHiddenEntry(ctx.state, t, true)
      logLine(ctx.state, `${label} is returned to its owner's hand from the stack.`)
      continue
    }
    const obj = ctx.state.objects[t]
    if (!obj || obj.zone !== 'battlefield') continue
    returnToHand()({ ...ctx, targets: [t] })
  }
}

/** An effect that does nothing — for a card whose whole body is handled structurally (Animate Dead). */
export const noop = (): Effect => () => {}

/** Everything that can be proliferated right now: permanents with any counter, players with poison. */
export function proliferateTargets(state: EffectContext['state']) {
  const permanents: ObjId[] = []
  for (const pid of state.turnOrder) {
    for (const id of state.zones.perPlayer[pid]!.battlefield) {
      const obj = state.objects[id]
      if (obj && Object.values(obj.counters).some((n) => n > 0)) permanents.push(id)
    }
  }
  const players = state.turnOrder.filter((pid) => !state.players[pid]!.hasLost && state.players[pid]!.poison > 0)
  return { permanents, players }
}

/** Gamble: discard a card at random from the controller's hand. */
export const discardAtRandom = (n: number): Effect => (ctx) => {
  for (let i = 0; i < n; i++) {
    const hand = ctx.state.zones.perPlayer[ctx.controllerId]!.hand
    if (!hand.length) return
    const id = hand[randomIndex(hand.length)]!
    logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} discards ${getDef(ctx.state.objects[id]!.defName).name} at random.`)
    moveToGraveyard(ctx.state, id)
  }
}

/** Mana Geyser: add {R} for each TAPPED land the controller's opponents control. */
export const addManaPerOpponentTappedLand = (color: ManaColor): Effect => (ctx) => {
  let n = 0
  for (const pid of ctx.state.turnOrder) {
    if (pid === ctx.controllerId) continue
    n += ctx.state.zones.perPlayer[pid]!.battlefield.filter((id) => {
      const o = ctx.state.objects[id]!
      return o.tapped && getDef(o.defName).types.includes('Land')
    }).length
  }
  ctx.state.players[ctx.controllerId]!.manaPool[color] += n
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} adds ${n} {${color}} (one per tapped opposing land).`)
}

/** Exsanguinate: each opponent loses X life and the controller gains the total lost. */
export const drainEachOpponentX = (): Effect => (ctx) => {
  const x = ctx.x ?? 0
  if (x <= 0) return
  let gained = 0
  for (const pid of ctx.state.turnOrder) {
    if (pid === ctx.controllerId || ctx.state.players[pid]!.hasLost) continue
    changeLife(ctx.state, pid, -(x))
    gained += x
  }
  changeLife(ctx.state, ctx.controllerId, gained)
  logLine(ctx.state, `Each opponent loses ${x} life; ${ctx.state.players[ctx.controllerId]!.name} gains ${gained}.`)
}

/** Aetherize: return every ATTACKING creature to its owner's hand (each id re-minted by returnToHand). */
export const returnAllAttackersToHand = (): Effect => (ctx) => {
  const attackers = Object.values(ctx.state.objects).filter((o) => o.zone === 'battlefield' && o.attackingDefender)
  if (!attackers.length) return
  logLine(ctx.state, `All ${attackers.length} attacking creature(s) are returned to their owners' hands.`)
  for (const o of attackers) returnToHand()({ ...ctx, targets: [o.id] })
}

/** "You may play an additional land this turn." (Explore) */
export const extraLandDrop = (n: number): Effect => (ctx) => {
  const p = ctx.state.players[ctx.controllerId]!
  p.extraLandsThisTurn = (p.extraLandsThisTurn ?? 0) + n
  logLine(ctx.state, `${p.name} may play ${n} additional land${n === 1 ? '' : 's'} this turn.`)
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
    if (!p.hasLost) changeLife(ctx.state, pid, -n)
  }
  logLine(ctx.state, `${sourceName(ctx)} deals ${n} damage to each non-flying creature and each player.`)
}

/**
 * HIDEAWAY N (CR 702.76): "look at the top N cards of your library, exile one face down, then put the
 * rest on the bottom of your library in a random order." Opens the actor-only look; `r.hideaway`
 * finishes it (the exile is face down, so its id is re-minted on the way in — invariant #3).
 */
export const hideaway = (n: number): Effect => (ctx) => {
  const lib = ctx.state.zones.perPlayer[ctx.controllerId]!.library
  const cardIds = lib.slice(0, n)
  const src = ctx.state.objects[ctx.sourceId]
  const sourceName = src ? getDef(src.defName).name : 'Hideaway'
  if (!cardIds.length) {
    logLine(ctx.state, `${sourceName}'s hideaway finds an empty library.`)
    return
  }
  ctx.state.pending = { kind: 'hideaway', player: ctx.controllerId }
  ctx.state.pendingHideaway = { player: ctx.controllerId, sourceId: ctx.sourceId, sourceName, cardIds }
}

/**
 * A hideaway land's second ability: "You may play the exiled card without paying its mana cost if
 * <condition>." The condition is checked as the ability RESOLVES (CR 702.76b) — if it doesn't hold,
 * nothing happens and the card stays hidden for a later attempt.
 */
export const playHiddenCard = (condition: { kind: 'totalPower'; n: number }): Effect => (ctx) => {
  const src = ctx.state.objects[ctx.sourceId]
  const sourceName = src ? getDef(src.defName).name : 'Hideaway'
  const hidden = Object.values(ctx.state.objects).find(
    (o) => o.hiddenBy === ctx.sourceId && o.zone === 'exile' && o.ownerId === ctx.controllerId,
  )
  if (!hidden) {
    logLine(ctx.state, `${sourceName} has no card hidden away.`)
    return
  }
  const total = battlefieldCreatures(ctx.state, ctx.controllerId).reduce((n, c) => n + Math.max(0, currentPower(ctx.state, c)), 0)
  if (total < condition.n) {
    logLine(ctx.state, `${sourceName}: your creatures' total power is only ${total} (needs ${condition.n}) — nothing happens.`)
    return
  }
  ctx.state.pending = { kind: 'freePlay', player: ctx.controllerId }
  ctx.state.pendingFreePlay = {
    player: ctx.controllerId,
    cardId: hidden.id,
    sourceId: ctx.sourceId,
    sourceName,
    isLand: getDef(hidden.defName).types.includes('Land'),
  }
}

/**
 * Scute Swarm: "Landfall — Whenever a land you control enters, if you control six or more lands,
 * create a token that's a copy of Scute Swarm. Otherwise, create a 1/1 green Insect creature token."
 * The copy is a full definition copy (registerCopyToken), so each copy has the landfall trigger too —
 * which is the card's whole point.
 */
export const copySelfIfLandsAtLeast = (n: number, otherwise: TokenSpec): Effect => (ctx) => {
  const src = ctx.state.objects[ctx.sourceId]
  const lands = ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield.filter((id) =>
    getDef(ctx.state.objects[id]!.defName).types.includes('Land'),
  ).length
  if (lands < n || !src) {
    spawnTokens(ctx.state, ctx.controllerId, otherwise, 1)
    return
  }
  const selfName = getDef(src.defName).name
  logLine(ctx.state, `${selfName} creates a token copy of itself (${lands} lands).`)
  spawnTokensByDefName(ctx.state, ctx.controllerId, registerCopyToken(getDef(src.defName), {}), `${selfName} copy`, 1)
}

/**
 * AMASS N (CR 701.44): "put N +1/+1 counters on an Army you control. If you don't control an Army,
 * create a 0/0 black <type> Army creature token first." The token is a real token, so it goes through
 * the shared minting path (doublers, ETB triggers).
 */
export const amass = (type: string, n: number): Effect => (ctx) => {
  const mine = ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield
  let army = mine.find((id) => (getDef(ctx.state.objects[id]!.defName).subtypes ?? []).includes('Army'))
  if (!army) {
    spawnTokens(ctx.state, ctx.controllerId, { name: `${type} Army`, power: 0, toughness: 0, subtypes: [type, 'Army'] }, 1)
    army = ctx.state.zones.perPlayer[ctx.controllerId]!.battlefield.find((id) =>
      (getDef(ctx.state.objects[id]!.defName).subtypes ?? []).includes('Army'),
    )
  }
  if (!army) return
  putCounters(ctx.state, army, '+1/+1', n)
  logLine(ctx.state, `${ctx.state.players[ctx.controllerId]!.name} amasses ${type} ${n}.`)
}

/**
 * "When this Equipment enters, attach it to target creature you control" (Mithril Coat). Attaching is
 * not equipping, so it ignores the equip cost and timing; the target is this trigger's own target.
 */
export const attachToTarget = (): Effect => (ctx) => {
  const equipment = ctx.state.objects[ctx.sourceId]
  const target = ctx.targets.find((t) => !isPlayerId(ctx, t)) as ObjId | undefined
  const host = target ? ctx.state.objects[target] : undefined
  if (!equipment || equipment.zone !== 'battlefield' || !host || host.zone !== 'battlefield') return
  equipment.attachedTo = host.id
  logLine(ctx.state, `${getDef(equipment.defName).name} is attached to ${getDef(host.defName).name}.`)
}

/** Run several effects in order. */
export const sequence = (...effects: Effect[]): Effect => (ctx) => {
  for (const e of effects) e(ctx)
}

function sourceName(ctx: EffectContext): string {
  const obj = ctx.state.objects[ctx.sourceId]
  return obj ? getDef(obj.defName).name : 'A spell'
}
