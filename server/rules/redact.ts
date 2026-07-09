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
import { defIsCreature, defIsLand } from './cards/dsl'
import { currentKeywords, currentPower, currentToughness } from './characteristics'
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
    isCommander: obj.isCommander,
    unimplemented: getDef(obj.defName).unimplemented ?? false,
    keywords: currentKeywords(state, obj),
    attackingDefender: obj.attackingDefender,
    blockingAttackerId: obj.blockingAttackerId,
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
            return !c.tapped && (!c.summoningSick || kws.includes('haste')) && !kws.includes('defender')
          })
          .map((c) => c.id),
        attackablePlayerIds: state.turnOrder.filter((p) => p !== viewer && !state.players[p]!.hasLost),
      }
    if (state.pending.kind === 'blockers')
      return {
        ...none,
        needsBlockers: true,
        declarableBlockerIds: battlefieldCreatures(state, viewer)
          .filter((c) => !c.tapped)
          .map((c) => c.id),
        incomingAttackerIds: Object.values(state.objects)
          .filter((o) => o.attackingDefender === viewer)
          .map((o) => o.id),
      }
    if (state.pending.kind === 'trigger') {
      const pt = state.pendingTrigger
      const spec = pt ? (getDef(pt.defName).enters?.targets?.[0] ?? null) : null
      return {
        ...none,
        needsTriggerTargets: true,
        triggerTargetKind: spec?.kind ?? null,
        triggerSourceName: pt ? getDef(pt.defName).name : null,
      }
    }
    if (state.pending.kind === 'discard')
      return { ...none, needsDiscard: true, discardCount: zoneArr(state, viewer, 'hand').length - 7 }
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
    if (planPayment(parseManaCost(def.manaCost), potential).covered) castableIds.push(id)
    // not castable if any of its target specs has no legal target right now
    // (filter-aware: e.g. "artifact or enchantment", "creature an opponent controls")
    const missingTarget = def.spell?.targets?.some((t) => !hasAnyLegalTarget(state, t, viewer))
    if (missingTarget) {
      const i = castableIds.indexOf(id)
      if (i >= 0) castableIds.splice(i, 1)
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
  }
}
