/**
 * Per-viewer redaction for enforced mode — same hidden-information discipline
 * as the manual engine (server/game/visibility.ts): library contents/order are
 * NEVER serialised (count only, owner included); opponent hands are count-only
 * with no ids; everything on battlefield/stack/graveyard/exile is public.
 *
 * M-R0 has no public→hidden zone transitions (no bounce/shuffle effects in the
 * starter set), so ids are stable; re-minting arrives with those effects.
 * tests/unit/rules-leak.spec.ts (CI-blocking) fuzzes random duels and asserts
 * these invariants after every action, for both viewers.
 */
import type {
  LegalActions,
  ObjId,
  PlayerId,
  RulesClientCard,
  RulesClientState,
  RulesGameState,
} from '#shared/rules/types'
import { parseManaCost, planPayment } from '#shared/utils/manaCost'
import { getDef } from './cards/registry'
import { defIsCreature, defIsEquipment, defIsLand } from './cards/dsl'
import { currentKeywords, currentPower, currentToughness, hostCantAttack, hostCantBlock } from './characteristics'
import { battlefieldCreatures, zoneArr } from './state'
import { hasAnyLegalTarget } from './engine'

function visibleTo(state: RulesGameState, id: ObjId, viewer: PlayerId): boolean {
  const obj = state.objects[id]
  if (!obj) return false
  if (obj.zone === 'library') return false
  if (obj.zone === 'hand') return obj.ownerId === viewer
  return true // battlefield, stack, graveyard, exile, command are public
}

export function redactRulesState(state: RulesGameState, viewer: PlayerId): RulesClientState {
  const toClientCard = (obj: RulesGameState['objects'][string]): RulesClientCard => ({
    id: obj.id,
    defName: obj.defName,
    ownerId: obj.ownerId,
    controllerId: obj.controllerId,
    zone: obj.zone,
    tapped: obj.tapped,
    summoningSick: obj.summoningSick,
    damageMarked: obj.damageMarked,
    counters: obj.counters,
    // effective P/T only when the printed body is numeric (a "*"/CDA body has
    // an undefined base — leave it unknown rather than reporting a bogus 0)
    power: defIsCreature(getDef(obj.defName)) && getDef(obj.defName).power != null ? currentPower(state, obj) : null,
    toughness:
      defIsCreature(getDef(obj.defName)) && getDef(obj.defName).toughness != null ? currentToughness(state, obj) : null,
    loyalty: getDef(obj.defName).types.includes('Planeswalker')
      ? (obj.loyalty ?? getDef(obj.defName).loyalty ?? 0)
      : null,
    isCommander: obj.isCommander,
    attachedTo: obj.attachedTo ?? null,
    unimplemented: getDef(obj.defName).unimplemented ?? false,
    keywords: currentKeywords(state, obj),
    attackingDefender: obj.attackingDefender,
    attackingPwId: obj.attackingPwId ?? null,
    blockingAttackerId: obj.blockingAttackerId,
    phasedOut: obj.phasedOut ?? false,
    hidden: false,
  })

  const cards: Record<ObjId, RulesClientCard> = {}
  for (const obj of Object.values(state.objects)) {
    if (!visibleTo(state, obj.id, viewer)) continue
    cards[obj.id] = toClientCard(obj)
  }
  // scry peek: the scrying player (and ONLY them) sees the top-N library cards
  const scry = state.pendingScry && state.pendingScry.player === viewer ? { cardIds: [...state.pendingScry.cardIds] } : null
  if (scry) for (const id of scry.cardIds) if (state.objects[id]) cards[id] = toClientCard(state.objects[id]!)
  // search peek: the searching player (and ONLY them) sees the matching library cards
  const search =
    state.pendingSearch && state.pendingSearch.player === viewer
      ? { matchIds: [...state.pendingSearch.matchIds], dest: state.pendingSearch.dest, count: state.pendingSearch.count }
      : null
  if (search) for (const id of search.matchIds) if (state.objects[id]) cards[id] = toClientCard(state.objects[id]!)

  const perPlayer: RulesClientState['zones']['perPlayer'] = {}
  for (const pid of state.turnOrder) {
    const z = state.zones.perPlayer[pid]!
    perPlayer[pid] = {
      battlefield: z.battlefield,
      graveyard: z.graveyard,
      exile: z.exile,
      command: z.command,
      hand: pid === viewer ? [...z.hand] : { count: z.hand.length },
      library: { count: z.library.length },
    }
  }

  return {
    id: state.id,
    mode: 'enforced',
    you: viewer,
    players: state.players,
    turnOrder: state.turnOrder,
    activePlayer: state.activePlayer,
    step: state.step,
    turnNumber: state.turnNumber,
    priorityPlayer: state.priorityPlayer,
    cards,
    zones: { perPlayer, stack: state.zones.stack },
    legal: computeLegal(state, viewer),
    status: state.status,
    winner: state.winner,
    log: state.log.slice(-120),
    seq: state.seq,
    scry,
    search,
  }
}

/** What the viewer may do right now — drives the client's affordances. */
export function computeLegal(state: RulesGameState, viewer: PlayerId): LegalActions {
  const none: LegalActions = {
    hasPriority: false,
    canPass: false,
    playableLandIds: [],
    castableIds: [],
    manaSourceIds: [],
    manaSourceColors: {},
    declarableAttackerIds: [],
    declarableBlockerIds: [],
    attackablePlayerIds: [],
    attackablePlaneswalkerIds: [],
    incomingAttackerIds: [],
    needsAttackers: false,
    needsBlockers: false,
    needsDiscard: false,
    discardCount: 0,
    needsSacrifice: false,
    sacrificeCount: 0,
    sacrificeableIds: [],
    needsTriggerTargets: false,
    triggerTargetKind: null,
    triggerSourceName: null,
    activations: [],
    equippableIds: [],
    loyaltyActivations: [],
    cyclable: [],
    kickable: [],
    needsWard: false,
    wardCost: '',
    wardAffordable: false,
    needsCascade: false,
    cascadeHitId: null,
    cascadeTargetKind: null,
    cascadeCanFreeCast: false,
  }
  if (state.status !== 'active' || state.players[viewer]?.hasLost) return none

  if (state.pending) {
    if (state.pending.player !== viewer) return none
    if (state.pending.kind === 'attackers')
      return {
        ...none,
        needsAttackers: true,
        declarableAttackerIds: battlefieldCreatures(state, viewer)
          .filter((c) => {
            const kws = currentKeywords(state, c) // includes granted haste/defender
            return !c.tapped && (!c.summoningSick || kws.includes('haste')) && !kws.includes('defender') && !hostCantAttack(state, c)
          })
          .map((c) => c.id),
        attackablePlayerIds: state.turnOrder.filter((p) => p !== viewer && !state.players[p]!.hasLost),
        // opponents' planeswalkers are also attackable
        attackablePlaneswalkerIds: Object.values(state.objects)
          .filter((o) => o.zone === 'battlefield' && o.controllerId !== viewer && !state.players[o.controllerId]!.hasLost && getDef(o.defName).types.includes('Planeswalker'))
          .map((o) => o.id),
      }
    if (state.pending.kind === 'blockers')
      return {
        ...none,
        needsBlockers: true,
        declarableBlockerIds: battlefieldCreatures(state, viewer)
          .filter((c) => !c.tapped && !hostCantBlock(state, c))
          .map((c) => c.id),
        incomingAttackerIds: Object.values(state.objects)
          .filter((o) => o.attackingDefender === viewer)
          .map((o) => o.id),
      }
    if (state.pending.kind === 'trigger') {
      const pt = state.pendingTrigger
      // read the ability for the ACTUAL trigger kind (not just enters) so a future
      // targeted dies/attacks/upkeep trigger surfaces the right target kind
      const def = pt ? getDef(pt.defName) : null
      const ab = def && pt
        ? pt.trigger === 'dies' ? def.dies : pt.trigger === 'attacks' ? def.attacks : pt.trigger === 'upkeep' ? def.upkeep : def.enters
        : null
      const spec = ab?.targets?.[0] ?? null
      return {
        ...none,
        needsTriggerTargets: true,
        triggerTargetKind: spec?.kind ?? null,
        triggerSourceName: pt ? getDef(pt.defName).name : null,
      }
    }
    if (state.pending.kind === 'discard')
      return {
        ...none,
        needsDiscard: true,
        // forced discard (Mind Rot / each-player) uses its own count; cleanup uses hand−7
        discardCount: state.pendingDiscard
          ? Math.min(state.pendingDiscard.count, zoneArr(state, viewer, 'hand').length)
          : zoneArr(state, viewer, 'hand').length - 7,
      }
    if (state.pending.kind === 'sacrifice' && state.pendingSacrifice) {
      // show the live intersection (snapshot ∩ still-controlled creatures), matching
      // the engine's self-healing validation, so a manually-moved candidate drops out
      const live = new Set(battlefieldCreatures(state, viewer).map((c) => c.id))
      const valid = state.pendingSacrifice.candidateIds.filter((id) => live.has(id))
      return {
        ...none,
        needsSacrifice: true,
        sacrificeCount: Math.min(state.pendingSacrifice.count, valid.length),
        sacrificeableIds: valid,
      }
    }
    if (state.pending.kind === 'ward' && state.pendingWard) {
      // the payer chooses to pay the ward cost (from their current pool) or let the
      // triggering spell/ability be countered
      return {
        ...none,
        needsWard: true,
        wardCost: state.pendingWard.cost,
        wardAffordable: planPayment(parseManaCost(state.pendingWard.cost), state.players[viewer]!.manaPool).covered,
      }
    }
    if (state.pending.kind === 'cascade' && state.pendingCascade) {
      // the caster may cast the revealed hit for free. The client can deliver a single target of
      // a battlefield/player kind, or no target at all; modal / multi-target / spell / graveyardCard
      // hits need input the client can't yet supply, so they're flagged neither castable-here nor
      // target-clickable (banner offers Decline only). The SERVER still accepts a full r.cascade.
      const hit = state.objects[state.pendingCascade.hitId]
      const def = hit ? getDef(hit.defName) : null
      const modal = !!def?.modes?.length
      const specs = modal ? [] : (def?.spell?.targets ?? [])
      const totalTargets = specs.reduce((n, s) => n + s.count, 0)
      const single = !modal && specs.length === 1 && specs[0]!.count === 1 ? specs[0]!.kind : null
      const clientKind = single === 'creature' || single === 'permanent' || single === 'anyTarget' || single === 'player' ? single : null
      return {
        ...none,
        needsCascade: true,
        cascadeHitId: state.pendingCascade.hitId,
        cascadeTargetKind: clientKind,
        cascadeCanFreeCast: !modal && totalTargets === 0,
      }
    }
    return none // scry / search: driven by the actor-only scry/search fields, no action buttons
  }

  if (state.priorityPlayer !== viewer) return none

  // untapped permanents with a mana ability + the potential pool they enable
  const manaSourceIds: ObjId[] = []
  const potential = { ...state.players[viewer]!.manaPool }
  const manaSourceColors: LegalActions['manaSourceColors'] = {}
  for (const obj of Object.values(state.objects)) {
    if (obj.zone !== 'battlefield' || obj.controllerId !== viewer || obj.tapped) continue
    const ability = getDef(obj.defName).abilities?.find((a) => a.kind === 'activated' && a.isMana && a.cost.tap)
    if (!ability) continue
    manaSourceIds.push(obj.id)
    // only chooseColor sources prompt a colour picker; fixed-output rocks (Signets) don't
    manaSourceColors[obj.id] = ability.chooseColor ? (ability.produces ?? []) : []
    // only cost-free {T} sources add to the pre-tap potential; cost-bearing rocks
    // (Signets need input mana) are re-validated by the server on tap
    if (!ability.cost.mana) {
      const c = ability.produces?.[0]
      if (c) potential[c]++
    }
  }

  // non-mana activated abilities usable now (server re-checks mana on activate)
  const activations: LegalActions['activations'] = []
  for (const obj of Object.values(state.objects)) {
    if (obj.zone !== 'battlefield' || obj.controllerId !== viewer) continue
    const def = getDef(obj.defName)
    def.abilities?.forEach((ab, i) => {
      if (ab.kind !== 'activated' || ab.isMana) return
      if (ab.cost.tap) {
        if (obj.tapped) return
        if (defIsCreature(def) && obj.summoningSick && !currentKeywords(state, obj).includes('haste')) return
      }
      // a sacrifice cost is only payable if the player controls enough creatures
      const sacCost = ab.cost.sacrifice?.count ?? 0
      if (sacCost > battlefieldCreatures(state, viewer).length) return
      activations.push({ objId: obj.id, abilityIndex: i, targetKind: ab.targets?.[0]?.kind ?? null, cost: ab.cost.mana ?? '', sacCost })
    })
  }

  const isMain =
    (state.step === 'main1' || state.step === 'main2') &&
    state.activePlayer === viewer &&
    state.zones.stack.length === 0

  const playableLandIds: ObjId[] = []
  const castableIds: ObjId[] = []

  // your commander in the command zone: castable at sorcery speed for cost + tax
  const me = state.players[viewer]!
  if (me.commanderId && state.objects[me.commanderId]?.zone === 'command' && isMain) {
    const cmdDef = getDef(state.objects[me.commanderId]!.defName)
    const cost = parseManaCost(cmdDef.manaCost)
    cost.generic += 2 * me.commanderTax
    if (planPayment(cost, potential).covered) castableIds.push(me.commanderId)
  }

  for (const id of zoneArr(state, viewer, 'hand')) {
    const def = getDef(state.objects[id]!.defName)
    if (defIsLand(def)) {
      if (isMain && state.players[viewer]!.landsPlayedThisTurn < 1) playableLandIds.push(id)
      continue
    }
    const timingOk = def.types.includes('Instant') || isMain || (def.keywords?.includes('flash') ?? false)
    if (!timingOk) continue
    // {X} isn't counted by parseManaCost, so this checks the base cost (x=0) — the
    // player then picks X up to what their pool covers
    if (planPayment(parseManaCost(def.manaCost), potential).covered) castableIds.push(id)
    // not castable if no legal targets: for a modal spell at least ONE mode must have
    // all its targets legal; otherwise every target spec of the plain spell must be
    // satisfiable (filter-aware: "artifact or enchantment", "creature an opponent controls")
    const srcColors = def.colors ?? [] // for protection-from-colour castability checks
    const missingTarget = def.modes?.length
      ? !def.modes.some((m) => (m.targets ?? []).every((t) => hasAnyLegalTarget(state, t, viewer, srcColors)))
      : (def.spell?.targets?.some((t) => !hasAnyLegalTarget(state, t, viewer, srcColors)) ?? false)
    if (missingTarget) {
      const i = castableIds.indexOf(id)
      if (i >= 0) castableIds.splice(i, 1)
    }
  }

  // loyalty abilities usable now: sorcery speed, your planeswalker, not yet used this
  // turn, and (for a negative cost) enough loyalty to pay it
  const loyaltyActivations: LegalActions['loyaltyActivations'] = []
  if (isMain) {
    for (const obj of Object.values(state.objects)) {
      if (obj.zone !== 'battlefield' || obj.controllerId !== viewer || obj.loyaltyActivatedThisTurn) continue
      const def = getDef(obj.defName)
      if (!def.types.includes('Planeswalker')) continue
      def.loyaltyAbilities?.forEach((la, i) => {
        if ((obj.loyalty ?? 0) + la.cost >= 0) loyaltyActivations.push({ objId: obj.id, abilityIndex: i, cost: la.cost })
      })
    }
  }

  // Castable cards that have a kicker — the client offers a "kick" toggle in the payment
  // panel (adding the kicker's mana to the cost). Only castable cards qualify (base cost
  // already affordable + targets legal); whether the caster can also afford the kicker is
  // gated client-side by the payment panel and re-checked by r.cast.
  const kickable: LegalActions['kickable'] = []
  for (const id of castableIds) {
    const kc = getDef(state.objects[id]!.defName).kickerCost
    if (kc) kickable.push({ objId: id, cost: kc })
  }

  // Cards you can cycle right now: cycling is instant speed (any time you have priority),
  // so this is not gated on isMain; affordability from the pre-tap potential pool (the
  // server re-checks against the actual pool). Only implemented cards carry cyclingCost,
  // so fallbacks are never auto-offered (assisted table).
  const cyclable: LegalActions['cyclable'] = []
  for (const id of zoneArr(state, viewer, 'hand')) {
    const def = getDef(state.objects[id]!.defName)
    if (!def.cyclingCost) continue
    if (planPayment(parseManaCost(def.cyclingCost), potential).covered) cyclable.push({ objId: id, cost: def.cyclingCost })
  }

  // Equipment you can equip right now: sorcery speed, you control a creature, and
  // the equip cost is affordable from the pre-tap potential pool (server re-checks)
  const equippableIds: ObjId[] = []
  if (isMain && battlefieldCreatures(state, viewer).length > 0) {
    for (const obj of Object.values(state.objects)) {
      if (obj.zone !== 'battlefield' || obj.controllerId !== viewer) continue
      const def = getDef(obj.defName)
      // unimplemented Equipment has no known equip cost → never auto-offer it (assisted table)
      if (!defIsEquipment(def) || def.unimplemented) continue
      if (planPayment(parseManaCost(def.equipCost), potential).covered) equippableIds.push(obj.id)
    }
  }

  return {
    ...none,
    hasPriority: true,
    canPass: true,
    playableLandIds,
    castableIds,
    manaSourceIds,
    manaSourceColors,
    activations,
    equippableIds,
    loyaltyActivations,
    cyclable,
    kickable,
  }
}
