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
  ManaColor,
  ObjId,
  PlayerId,
  RulesClientCard,
  RulesClientState,
  RulesGameState,
} from '#shared/rules/types'
import { parseManaCost, planPayment } from '#shared/utils/manaCost'
import { getDef } from './cards/registry'
import { defIsCreature, defIsEquipment, defIsLand, type CardDefinition } from './cards/dsl'
import { currentKeywords, currentPT, hostCantAttack, hostCantBlock } from './characteristics'
import { battlefieldCreatures, zoneArr } from './state'
import { controlledArtifacts, controlledLands, dynamicManaColors, hasAnyLegalTarget, landDropAllowance, permanentCostReduction } from './engine'

function visibleTo(state: RulesGameState, id: ObjId, viewer: PlayerId): boolean {
  const obj = state.objects[id]
  if (!obj) return false
  if (obj.zone === 'library') return false
  if (obj.zone === 'hand') return obj.ownerId === viewer
  return true // battlefield, stack, graveyard, exile, command are public
}

export function redactRulesState(state: RulesGameState, viewer: PlayerId): RulesClientState {
  const toClientCard = (obj: RulesGameState['objects'][string]): RulesClientCard => {
    // Face-down (foretell / morph): a NON-owner never learns the identity — send no defName, no
    // characteristics beyond the public shell (a face-down creature reads as a 2/2 with no name).
    // The owner gets the real card (below) but the client still renders it face-down.
    if (obj.faceDown && obj.ownerId !== viewer) {
      const onBattlefield = obj.zone === 'battlefield'
      return {
        id: obj.id,
        defName: null,
        ownerId: obj.ownerId,
        controllerId: obj.controllerId,
        zone: obj.zone,
        tapped: obj.tapped,
        summoningSick: obj.summoningSick,
        damageMarked: obj.damageMarked,
        counters: {},
        power: onBattlefield ? 2 : null, // a face-down permanent is a 2/2 (CR 707.2 / morph)
        toughness: onBattlefield ? 2 : null,
        loyalty: null,
        isCommander: false,
        attachedTo: null,
        unimplemented: false,
        keywords: [],
        attackingDefender: obj.attackingDefender,
        attackingPwId: null,
        blockingAttackerId: obj.blockingAttackerId,
        phasedOut: false,
        adventured: false,
        faceDown: true,
        hidden: true,
      }
    }
    // cache the def and compute effective P/T ONCE per object (redaction is the fuzzer's hot path)
    const def = getDef(obj.defName)
    // a bestowed permanent is an Aura, not a creature (CR 702.103) — no creature P/T while attached
    const isCrea = defIsCreature(def) && !obj.bestowed
    const pt = isCrea ? currentPT(state, obj) : null
    return {
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
    power: pt && def.power != null ? pt.power : null,
    toughness: pt && def.toughness != null ? pt.toughness : null,
    loyalty: def.types.includes('Planeswalker') ? (obj.loyalty ?? def.loyalty ?? 0) : null,
    isCommander: obj.isCommander,
    attachedTo: obj.attachedTo ?? null,
    unimplemented: def.unimplemented ?? false,
    keywords: currentKeywords(state, obj),
    attackingDefender: obj.attackingDefender,
    attackingPwId: obj.attackingPwId ?? null,
    blockingAttackerId: obj.blockingAttackerId,
    phasedOut: obj.phasedOut ?? false,
    adventured: obj.adventured ?? false,
    faceDown: obj.faceDown ?? false,
    hidden: false,
    }
  }

  const cards: Record<ObjId, RulesClientCard> = {}
  for (const obj of Object.values(state.objects)) {
    if (!visibleTo(state, obj.id, viewer)) continue
    cards[obj.id] = toClientCard(obj)
  }
  // scry peek: the scrying player (and ONLY them) sees the top-N library cards
  const scry =
    state.pendingScry && state.pendingScry.player === viewer
      ? { cardIds: [...state.pendingScry.cardIds], ...(state.pendingScry.surveil ? { surveil: true } : {}) }
      : null
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
    // the stack is public EXCEPT a face-down (morph) spell — blank its defName for non-owners so
    // casting a face-down creature never leaks its identity via the stack
    zones: {
      perPlayer,
      stack: state.zones.stack.map((s) => {
        const src = state.objects[s.sourceId]
        return src?.faceDown && src.ownerId !== viewer ? { ...s, defName: '' } : s
      }),
    },
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
    manaSourceSacCost: {},
    manaFilters: [],
    declarableAttackerIds: [],
    declarableBlockerIds: [],
    attackablePlayerIds: [],
    attackTaxPerCreature: {},
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
    overloadable: [],
    freeCastable: [],
    castExtraCost: [],
    needsWard: false,
    wardCost: '',
    wardAffordable: false,
    needsPutBack: false,
    putBackCount: 0,
    needsOptionalPay: false,
    optionalPayCost: '',
    optionalPaySourceName: '',
    optionalPayAffordable: false,
    needsEntersChoice: false,
    entersChoiceLife: 0,
    entersChoiceName: '',
    entersChoiceAffordable: false,
    needsCascade: false,
    cascadeHitId: null,
    cascadeTargetKind: null,
    cascadeCanFreeCast: false,
    flashbackable: [],
    retraceable: [],
    escapable: [],
    evokable: [],
    bestowable: [],
    suspendable: [],
    adventurable: [],
    castExileIds: [],
    buybackable: [],
  }
  if (state.status !== 'active' || state.players[viewer]?.hasLost) return none

  if (state.pending) {
    if (state.pending.player !== viewer) return none
    if (state.pending.kind === 'attackers') {
      // what each opponent charges per attacker sent their way (Propaganda / Ghostly Prison)
      const attackTaxPerCreature: Record<PlayerId, number> = {}
      for (const pid of state.turnOrder) {
        if (pid === viewer || state.players[pid]!.hasLost) continue
        let t = 0
        for (const id of zoneArr(state, pid, 'battlefield')) t += getDef(state.objects[id]!.defName).attackTax ?? 0
        if (t) attackTaxPerCreature[pid] = t
      }
      return {
        ...none,
        attackTaxPerCreature,
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
    if (state.pending.kind === 'putBack' && state.pendingPutBack) {
      // the picker runs over the viewer's OWN hand, which they already see — no new information
      return { ...none, needsPutBack: true, putBackCount: state.pendingPutBack.count }
    }
    if (state.pending.kind === 'optionalPay' && state.pendingOptionalPay) {
      // the spell's caster may pay the tax; declining lets the ability happen (Rhystic Study)
      const pop = state.pendingOptionalPay
      return {
        ...none,
        needsOptionalPay: true,
        optionalPayCost: pop.cost,
        optionalPaySourceName: getDef(pop.defName).name,
        optionalPayAffordable: planPayment(parseManaCost(pop.cost), state.players[viewer]!.manaPool).covered,
      }
    }
    if (state.pending.kind === 'entersChoice' && state.pendingEntersChoice) {
      // its controller pays the life (keeping it untapped) or declines and it enters tapped
      const pec = state.pendingEntersChoice
      const obj = state.objects[pec.objId]
      return {
        ...none,
        needsEntersChoice: true,
        entersChoiceLife: pec.life,
        entersChoiceName: obj ? getDef(obj.defName).name : '',
        entersChoiceAffordable: state.players[viewer]!.life >= pec.life,
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
  const manaSourceSacCost: LegalActions['manaSourceSacCost'] = {}
  const manaFilters: LegalActions['manaFilters'] = []
  for (const obj of Object.values(state.objects)) {
    if (obj.zone !== 'battlefield' || obj.controllerId !== viewer) continue
    // a permanent may have SEVERAL mana abilities (a pain land: "{T}: Add {C}" plus a coloured one
    // that hurts) — the picker offers every colour any of them can make, and r.tapMana selects the
    // ability from the requested colour
    const manaAbilities = (getDef(obj.defName).abilities ?? []).filter(
      (a) =>
        a.kind === 'activated' &&
        a.isMana &&
        // a {T} ability needs the permanent untapped; a tapless one (Ashnod's Altar) does not
        (a.cost.tap ? !obj.tapped : true) &&
        // "Pay N life" mana abilities (Mana Confluence) are only usable at life ≥ N (CR 119.4)
        (a.cost.life ?? 0) <= state.players[viewer]!.life &&
        // "Activate only if you control five or more lands" (Temple of the False God)
        (a.requiresLandsAtLeast == null || controlledLands(state, viewer) >= a.requiresLandsAtLeast) &&
        // metalcraft (Mox Opal)
        (a.requiresArtifactsAtLeast == null || controlledArtifacts(state, viewer) >= a.requiresArtifactsAtLeast) &&
        // a sacrifice cost needs a creature to pay it (the Altars)
        (!a.cost.sacrifice || battlefieldCreatures(state, viewer).length >= a.cost.sacrifice.count) &&
        // a dynamic source with nothing to copy produces nothing (Reflecting Pool with no lands)
        (!a.dynamicProduces || dynamicManaColors(state, viewer, a.dynamicProduces).length > 0),
    )
    if (!manaAbilities.length) continue
    manaSourceIds.push(obj.id)
    // only chooseColor sources prompt a colour picker; fixed-output rocks (Signets) don't
    // several abilities → the player picks among ALL their colours (a pain land's {C} plus its two
    // painful colours); a single ability prompts only when it is itself a colour choice
    // a dynamic source's choices come from the board (Reflecting Pool, Mox Amber)
    const colorsOf = (a: (typeof manaAbilities)[number]) =>
      a.filter ? [] : a.dynamicProduces ? dynamicManaColors(state, viewer, a.dynamicProduces) : (a.produces ?? [])
    manaSourceColors[obj.id] =
      manaAbilities.length > 1
        ? [...new Set(manaAbilities.flatMap(colorsOf))]
        : manaAbilities[0]!.chooseColor || manaAbilities[0]!.dynamicProduces
          ? colorsOf(manaAbilities[0]!)
          : []
    // a filter ability is offered only while its hybrid cost is actually payable from the pool
    for (const a of manaAbilities) {
      if (!a.filter) continue
      if (a.cost.tap && obj.tapped) continue
      if (!a.filter.payFrom.some((c) => state.players[viewer]!.manaPool[c] > 0)) continue
      manaFilters.push({ objId: obj.id, payFrom: [...a.filter.payFrom], outputs: a.filter.outputs.map((o) => [...o] as [ManaColor, ManaColor]) })
    }
    const sacNeeded = Math.max(0, ...manaAbilities.map((a) => a.cost.sacrifice?.count ?? 0))
    if (sacNeeded) manaSourceSacCost[obj.id] = sacNeeded
    // only cost-free {T} sources add to the pre-tap potential; cost-bearing rocks
    // (Signets need input mana) are re-validated by the server on tap
    const free = manaAbilities.find((a) => !a.cost.mana)
    if (free) {
      const c = free.produces?.[0]
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
      // "pay N life" is payable only at life ≥ N (CR 119.4) — mirrors the engine's check
      const lifeCost = ab.cost.life ?? 0
      if (lifeCost > state.players[viewer]!.life) return
      activations.push({ objId: obj.id, abilityIndex: i, targetKind: ab.targets?.[0]?.kind ?? null, cost: ab.cost.mana ?? '', sacCost, lifeCost })
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
      if (isMain && state.players[viewer]!.landsPlayedThisTurn < landDropAllowance(state, viewer))
        playableLandIds.push(id)
      continue
    }
    const timingOk = def.types.includes('Instant') || isMain || (def.keywords?.includes('flash') ?? false)
    if (!timingOk) continue
    // {X} isn't counted by parseManaCost, so this checks the base cost (x=0) — the
    // player then picks X up to what their pool covers. Apply any dynamic generic cost
    // reduction (e.g. Blasphemous Act) so the reduced affordability is reflected here.
    const castCost = parseManaCost(def.manaCost)
    if (def.costReduction) castCost.generic = Math.max(0, castCost.generic - def.costReduction(state))
    // and the reduction the viewer's own permanents give it (Foundry Inspector, the Medallions) —
    // same function as r.cast, so the highlight can't drift from what the server will accept
    const fromPermanents = permanentCostReduction(state, viewer, def)
    if (fromPermanents) castCost.generic = Math.max(0, castCost.generic - fromPermanents)
    if (planPayment(castCost, potential).covered) castableIds.push(id)
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

  // Overload (CR 702.96): an ALTERNATIVE cost, so affordability is judged against the overload
  // cost itself (not the printed one) from the pre-tap potential pool; the server re-checks on
  // r.cast. Sorcery-speed cards are gated on the main phase like any other cast.
  const overloadable: LegalActions['overloadable'] = []
  for (const id of zoneArr(state, viewer, 'hand')) {
    const def = getDef(state.objects[id]!.defName)
    if (!def.overload) continue
    if (!def.types.includes('Instant') && !isMain) continue
    if (planPayment(parseManaCost(def.overload.cost), potential).covered) overloadable.push({ objId: id, cost: def.overload.cost })
  }

  // Free casts: "if you control a commander, you may cast this without paying its mana cost" — no
  // mana needed at all, so the only gates are controlling a commander and the spell's own timing.
  const freeCastable: ObjId[] = []
  {
    const hasCommander = zoneArr(state, viewer, 'battlefield').some((id) => state.objects[id]!.isCommander)
    if (hasCommander)
      for (const id of zoneArr(state, viewer, 'hand')) {
        const def = getDef(state.objects[id]!.defName)
        if (!def.freeIfCommander) continue
        if (!def.types.includes('Instant') && !isMain) continue
        freeCastable.push(id)
      }
  }

  // Castable cards that also demand a cast-time additional cost (sacrifice / discard). Only cards
  // whose other costs are already payable are listed; the server re-validates the picks.
  const castExtraCost: LegalActions['castExtraCost'] = []
  const unpayableExtra = new Set<ObjId>()
  for (const id of [...castableIds, ...freeCastable]) {
    const ac = getDef(state.objects[id]!.defName).additionalCost
    if (!ac) continue
    // is the additional cost payable at all? (no creature to sacrifice → the spell is uncastable)
    const sacCount = ac.sacrifice?.count ?? 0
    const sacPool = sacCount
      ? zoneArr(state, viewer, 'battlefield').filter((pid) => {
          const d = getDef(state.objects[pid]!.defName)
          return ac.sacrifice!.filter === 'creature'
            ? defIsCreature(d)
            : ac.sacrifice!.filter === 'land'
              ? defIsLand(d)
              : defIsCreature(d) || d.types.includes('Artifact')
        }).length
      : 0
    const discardCount = ac.discard ?? 0
    const handOthers = zoneArr(state, viewer, 'hand').filter((h) => h !== id).length
    if (sacCount > sacPool || discardCount > handOthers) {
      unpayableExtra.add(id)
      continue
    }
    castExtraCost.push({
      objId: id,
      sacrifice: sacCount,
      sacFilter: ac.sacrifice?.filter ?? 'creature',
      discard: discardCount,
    })
  }
  // a spell whose additional cost cannot be paid is not castable at all (CR 601.2h)
  const castableFinal = castableIds.filter((id) => !unpayableExtra.has(id))
  castableIds.length = 0
  castableIds.push(...castableFinal)
  const freeFinal = freeCastable.filter((id) => !unpayableExtra.has(id))
  freeCastable.length = 0
  freeCastable.push(...freeFinal)

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

  // --- alternative / other-zone casts (the client renders these as extra cast buttons) ---
  // affordability is checked against the pre-tap `potential` pool; the server re-validates on r.cast
  const affordable = (costStr: string | null | undefined) => !!costStr && planPayment(parseManaCost(costStr), potential).covered
  // the plain spell's targets are all satisfiable (so a targeted alt-cast is worth offering)
  const targetsOk = (def: CardDefinition) => {
    const srcColors = def.colors ?? []
    return !(def.spell?.targets?.some((t) => !hasAnyLegalTarget(state, t, viewer, srcColors)) ?? false)
  }
  const hasLandInHand = zoneArr(state, viewer, 'hand').some((id) => defIsLand(getDef(state.objects[id]!.defName)))
  const haveCreatureTarget = battlefieldCreatures(state).length > 0 // bestow can enchant any creature

  const gy = zoneArr(state, viewer, 'graveyard')
  const flashbackable: LegalActions['flashbackable'] = []
  const retraceable: LegalActions['retraceable'] = []
  const escapable: LegalActions['escapable'] = []
  for (const id of gy) {
    const def = getDef(state.objects[id]!.defName)
    const timingOk = def.types.includes('Instant') || isMain
    if (def.flashbackCost && timingOk && affordable(def.flashbackCost) && targetsOk(def))
      flashbackable.push({ objId: id, cost: def.flashbackCost })
    if (def.retrace && timingOk && affordable(def.manaCost) && hasLandInHand && targetsOk(def))
      retraceable.push({ objId: id, cost: def.manaCost ?? '' })
    // escape: need `exileCount` OTHER cards in the graveyard to exile as the cost
    if (def.escape && timingOk && affordable(def.escape.cost) && gy.length - 1 >= def.escape.exileCount && targetsOk(def))
      escapable.push({ objId: id, cost: def.escape.cost, exileCount: def.escape.exileCount })
  }

  const evokable: LegalActions['evokable'] = []
  const bestowable: LegalActions['bestowable'] = []
  const suspendable: LegalActions['suspendable'] = []
  const adventurable: LegalActions['adventurable'] = []
  for (const id of zoneArr(state, viewer, 'hand')) {
    const def = getDef(state.objects[id]!.defName)
    if (def.evokeCost && isMain && affordable(def.evokeCost) && targetsOk(def)) evokable.push({ objId: id, cost: def.evokeCost })
    if (def.bestowCost && isMain && affordable(def.bestowCost) && haveCreatureTarget) bestowable.push({ objId: id, cost: def.bestowCost })
    if (def.suspend && (def.types.includes('Instant') || isMain) && affordable(def.suspend.cost)) suspendable.push({ objId: id, cost: def.suspend.cost })
    if (def.adventure) {
      const adv = def.adventure
      const advTimingOk = adv.types.includes('Instant') || isMain
      const advTargetsOk = !(adv.targets?.some((t) => !hasAnyLegalTarget(state, t, viewer, def.colors ?? [])) ?? false)
      if (advTimingOk && affordable(adv.manaCost) && advTargetsOk) adventurable.push({ objId: id, cost: adv.manaCost, name: adv.name })
    }
  }

  // exiled adventurer cards whose creature side you can cast from exile (sorcery speed)
  const castExileIds: ObjId[] = []
  if (isMain) {
    for (const id of zoneArr(state, viewer, 'exile')) {
      const o = state.objects[id]!
      if (o.adventured && o.ownerId === viewer && affordable(getDef(o.defName).manaCost)) castExileIds.push(id)
    }
  }

  // castable cards with buyback → the client offers a "buyback" toggle (like kicker)
  const buybackable: LegalActions['buybackable'] = []
  for (const id of castableIds) {
    const bc = getDef(state.objects[id]!.defName).buybackCost
    if (bc) buybackable.push({ objId: id, cost: bc })
  }

  return {
    ...none,
    hasPriority: true,
    canPass: true,
    playableLandIds,
    castableIds,
    manaSourceIds,
    manaSourceColors,
    manaSourceSacCost,
    manaFilters,
    activations,
    equippableIds,
    loyaltyActivations,
    cyclable,
    kickable,
    overloadable,
    freeCastable,
    castExtraCost,
    flashbackable,
    retraceable,
    escapable,
    evokable,
    bestowable,
    suspendable,
    adventurable,
    castExileIds,
    buybackable,
  }
}
