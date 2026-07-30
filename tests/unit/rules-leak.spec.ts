/**
 * CI-BLOCKING hidden-information fuzzer for the ENFORCED (rules-engine) mode —
 * the counterpart of tests/unit/leak.spec.ts for the manual engine.
 *
 * Plays seeded random enforced duels end to end and, after EVERY action,
 * serialises redactRulesState for BOTH viewers asserting:
 *   1. no library id of either player ever appears in any payload
 *   2. no opponent-hand id appears in the other player's payload
 *   3. own hand arrives as ids, opponent hand strictly as {count}
 *   4. history-aware: no id CURRENTLY in a zone hidden from a viewer was EVER
 *      serialised to that viewer before (catches a public→hidden move that
 *      fails to re-mint the id — invariant #3).
 *
 * The fuzzer also injects the assisted-table manual overrides (r.mMove/mDraw/
 * mToken/mTap/mCounter/mMana/mLife), so those new zone-moving paths are covered.
 */
import { describe, expect, it } from 'vitest'
import type { ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'
import { applyRulesAction } from '../../server/rules/engine.ts'
import { redactRulesState, computeLegal } from '../../server/rules/redact.ts'
import { getDef, defKey } from '../../server/rules/cards/registry.ts'
import { currentKeywords } from '../../server/rules/characteristics.ts'
import { makeGameN, putCard, rig, toStep, until } from './rules-helpers.ts'
import { mulberry32 } from './engine-helpers.ts'
import { __setDeterministicRng } from '../../server/game/rng.ts'

// The searching/scrying player legitimately sees their OWN peeked library ids
// (sanctioned actor-only window, CLAUDE.md invariant #2); every other viewer must
// never see them. This set is those sanctioned ids for `viewer`.
function ownPeek(state: RulesGameState, viewer: PlayerId): Set<string> {
  const s = new Set<string>()
  if (state.pendingScry?.player === viewer) for (const id of state.pendingScry.cardIds) s.add(id)
  if (state.pendingSearch?.player === viewer) for (const id of state.pendingSearch.matchIds) s.add(id)
  return s
}

function assertNoLeaks(state: RulesGameState, context: string, seen: Map<PlayerId, Set<string>>) {
  for (const viewer of state.turnOrder) {
    const view = redactRulesState(state, viewer)
    const json = JSON.stringify(view)
    const peek = ownPeek(state, viewer)
    for (const pid of state.turnOrder) {
      for (const id of state.zones.perPlayer[pid]!.library)
        if (!peek.has(id))
          expect(json.includes(id), `library id ${id} leaked to ${viewer} ${context}`).toBe(false)
      if (pid !== viewer)
        for (const id of state.zones.perPlayer[pid]!.hand)
          expect(
            json.includes(id),
            // the card NAME and the log tail make a fuzz failure identifiable: this assertion is how
            // Command Beacon's missing commander re-mint was found
            `${pid} hand id ${id} (${state.objects[id] ? getDef(state.objects[id]!.defName).name : '?'}) leaked to ${viewer} ${context}; log tail: ${state.log.slice(-6).join(' | ')}`,
          ).toBe(false)
    }
    for (const pid of state.turnOrder) {
      const hand = view.zones.perPlayer[pid]!.hand
      expect(Array.isArray(hand), `hand shape for ${pid} seen by ${viewer}`).toBe(pid === viewer)
    }
    // history-aware: an id currently hidden from this viewer must never have been
    // serialised to them earlier (a public→hidden move must re-mint the id).
    const s = seen.get(viewer)!
    for (const obj of Object.values(state.objects)) {
      const hiddenNow = obj.zone === 'library' || (obj.zone === 'hand' && obj.ownerId !== viewer)
      if (hiddenNow)
        expect(s.has(obj.id), `hidden id ${obj.id} was previously serialised to ${viewer} ${context}`).toBe(false)
    }
    for (const id of Object.keys(view.cards)) s.add(id)
  }
}

// coverage counters: the new actions must actually be exercised across the seeded
// games (a green deck alone doesn't guarantee it) — asserted at the end of the run
let pwLoyaltyFired = 0
let pwAttacked = 0
let pwBurned = 0 // a spell/ability aimed its damage at a planeswalker ("any target" — CR 115.4)
let impulsePlayed = 0 // a card exiled by an impulse effect was played straight out of exile (fuzz-only telemetry)

/** One random-but-legal action for whoever must act; returns false when stuck. */
function randomAction(state: RulesGameState, rnd: () => number): boolean {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!
  /** tap one mana source for `who`, paying a sacrifice cost when the source has one (best effort) */
  const tapSourceFor = (who: PlayerId, src: ObjId) => {
    const lg = computeLegal(state, who)
    const colors = lg.manaSourceColors[src] ?? []
    const sacCount = lg.manaSourceSacCost[src] ?? 0
    let sacrifices: ObjId[] | undefined
    if (sacCount) {
      const mine = state.zones.perPlayer[who]!.battlefield.filter(
        (id) => id !== src && getDef(state.objects[id]!.defName).types.includes('Creature'),
      )
      if (mine.length < sacCount) return
      sacrifices = mine.slice(0, sacCount)
    }
    try {
      applyRulesAction(state, who, {
        type: 'r.tapMana',
        objId: src,
        ...(colors.length ? { color: pick(colors) } : {}),
        ...(sacrifices ? { sacrifices } : {}),
      })
    } catch { /* summoning sick, already tapped, … — best effort */ }
  }

  if (state.pending) {
    const p = state.pending.player
    const legal = computeLegal(state, p)
    if (state.pending.kind === 'ward') {
      // pay the ward if affordable (randomly), else decline — both leak-safe. This MUST
      // handle the pending or the fuzzer stalls if a ward trigger ever fires.
      const pay = legal.wardAffordable && rnd() < 0.5
      applyRulesAction(state, p, { type: 'r.ward', pay })
      return true
    }
    if (state.pending.kind === 'cascade') {
      // DECLINE — the exiled (publicly-revealed) cards go to the bottom re-minted, exercising
      // the leak-critical exile→library path; must handle this pending or the fuzzer stalls.
      applyRulesAction(state, p, { type: 'r.cascade', cast: false, targets: [] })
      return true
    }
    if (state.pending.kind === 'attackers') {
      // attack a random legal defender: an opponent player OR an opponent's planeswalker
      // an attack tax (Propaganda / Ghostly Prison) is paid as attackers are declared: float what the
      // chosen defenders charge, else declare nothing — otherwise the run aborts on CANT_PAY
      const taxOf = (d: PlayerId | ObjId) =>
        legal.attackTaxPerCreature[Object.hasOwn(state.players, d) ? (d as PlayerId) : (state.objects[d]?.controllerId ?? '')] ?? 0
      const pws = legal.attackablePlaneswalkerIds
      const foes = [...legal.attackablePlayerIds, ...pws]
      // planeswalkers are weighted: with 2–4 players and rarely more than one PW on the
      // battlefield, a uniform pick makes the attack-a-PW path depend on seed luck (it silently
      // went to 0 when the fuzz deck changed). Weighting keeps that coverage counter meaningful.
      const defender = () => (pws.length && rnd() < 0.5 ? pick(pws) : pick(foes))
      const attacks = foes.length
        ? legal.declarableAttackerIds
            .filter(() => rnd() < 0.6)
            .map((attackerId) => ({ attackerId, defenderId: defender() }))
        : []
      if (attacks.some((a) => legal.attackablePlaneswalkerIds.includes(a.defenderId))) pwAttacked++ // coverage guard
      const totalTax = attacks.reduce((n, a) => n + taxOf(a.defenderId), 0)
      if (totalTax > 0) {
        // tap sources for the tax; if it still can't be covered, attack with nobody
        for (const src of computeLegal(state, p).manaSourceIds) {
          if (Object.values(state.players[p]!.manaPool).reduce((x, y) => x + y, 0) >= totalTax) break
          tapSourceFor(p, src)
        }
        if (Object.values(state.players[p]!.manaPool).reduce((x, y) => x + y, 0) < totalTax) {
          applyRulesAction(state, p, { type: 'r.attackers', attacks: [] })
          return true
        }
      }
      applyRulesAction(state, p, { type: 'r.attackers', attacks })
      return true
    }
    if (state.pending.kind === 'blockers') {
      const attackers = Object.values(state.objects).filter((o) => o.attackingDefender === p)
      // only assign a blocker to an attacker it may LEGALLY block: a flyer can be
      // blocked only by flyers/reach (CR 509.1b). declarableBlockerIds is just the
      // untapped creatures (not filtered by attacker), so the fuzzer must respect
      // evasion itself, else the engine throws BAD_BLOCKER and aborts the run.
      const canBlock = (blockerId: ObjId, atk: (typeof attackers)[number]) => {
        if (!currentKeywords(state, atk).includes('flying')) return true
        const bk = currentKeywords(state, state.objects[blockerId]!)
        return bk.includes('flying') || bk.includes('reach')
      }
      const blocks = legal.declarableBlockerIds
        .filter(() => rnd() < 0.5)
        .map((blockerId) => {
          const legalAtk = attackers.filter((a) => canBlock(blockerId, a))
          return legalAtk.length ? { blockerId, attackerId: pick(legalAtk).id } : null
        })
        .filter((b): b is { blockerId: ObjId; attackerId: ObjId } => b !== null)
      try {
        applyRulesAction(state, p, { type: 'r.blockers', blocks })
      } catch {
        applyRulesAction(state, p, { type: 'r.blockers', blocks: [] }) // any residual illegality (e.g. menace) → decline
      }
      return true
    }
    if (state.pending.kind === 'scry' && state.pendingScry) {
      // Ponder-style reorder: either shuffle, or put every peeked card back in a shuffled order
      if (state.pendingScry.reorder) {
        if (rnd() < 0.5) applyRulesAction(state, p, { type: 'r.scry', toBottom: [], shuffle: true })
        else {
          const order = [...state.pendingScry.cardIds]
          for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1))
            ;[order[i], order[j]] = [order[j]!, order[i]!]
          }
          applyRulesAction(state, p, { type: 'r.scry', toBottom: [], order })
        }
        return true
      }
      // randomly bottom some of the peeked cards (exercises scry/surveil + library re-mint)
      const toBottom = state.pendingScry.cardIds.filter(() => rnd() < 0.5)
      applyRulesAction(state, p, { type: 'r.scry', toBottom })
      return true
    }
    if (state.pending.kind === 'putBack' && state.pendingPutBack) {
      // put back the first N hand cards (Brainstorm). Hand → library is hidden → hidden, but the
      // fuzzer must answer this or it stalls; the history-aware assertion then confirms those ids
      // are still never serialised to anyone else.
      const hand = state.zones.perPlayer[p]!.hand
      applyRulesAction(state, p, { type: 'r.putBack', objIds: hand.slice(0, state.pendingPutBack.count) })
      return true
    }
    if (state.pending.kind === 'optionalPay') {
      // pay the "unless that player pays {N}" tax when affordable (randomly), else decline and let
      // the ability happen (Rhystic Study draws for its controller — a library→hand move, so the
      // history-aware assertion covers the declined branch too). Must be handled or the fuzzer
      // stalls the moment such a trigger resolves.
      applyRulesAction(state, p, { type: 'r.optionalPay', pay: legal.optionalPayAffordable && rnd() < 0.5 })
      return true
    }
    if (state.pending.kind === 'entersChoice') {
      // pay the life (randomly, when affordable) or let the shockland enter tapped — must be
      // handled or the fuzzer stalls the moment one enters, by any path
      applyRulesAction(state, p, { type: 'r.entersChoice', pay: legal.entersChoiceAffordable && rnd() < 0.5 })
      return true
    }
    if (state.pending.kind === 'trigger' && legal.needsTriggerTargets) {
      // choose a random legal target for a TARGETED triggered ability (Bojuka Bog's ETB targets a
      // player). Must be handled or the fuzzer stalls the moment such a trigger fires — mirrors the
      // client's own trigger-target selection (isTriggerTargetCard / canTargetPlayerForTrigger).
      const kind = legal.triggerTargetKind
      // the trigger's own spec carries a FILTER (a Karoo land's ETB wants a LAND YOU CONTROL), so
      // read it off the definition instead of guessing from the kind alone — picking any permanent
      // made the engine reject the choice and aborted the run
      const pt = state.pendingTrigger
      const tdef = pt ? getDef(pt.defName) : undefined
      const tab = tdef && pt
        ? pt.trigger === 'dies' ? tdef.dies
          : pt.trigger === 'attacks' ? tdef.attacks
          : pt.trigger === 'upkeep' ? tdef.upkeep
          : pt.trigger === 'landfall' ? tdef.landEnters
          : tdef.enters
        : undefined
      const spec = tab?.targets?.[0]
      const players = state.turnOrder.filter((x) => !state.players[x]!.hasLost)
      const matches = (o: { id: ObjId; controllerId: PlayerId; defName: string }) => {
        const d = getDef(o.defName)
        if (spec?.filter?.types && !spec.filter.types.some((t) => d.types.includes(t))) return false
        if (spec?.filter?.excludeTypes && spec.filter.excludeTypes.some((t) => d.types.includes(t))) return false
        if (spec?.filter?.controller === 'you' && o.controllerId !== p) return false
        if (spec?.filter?.controller === 'opponent' && o.controllerId === p) return false
        return true
      }
      // a graveyardCard trigger target (Eternal Witness, Sun Titan) — redact hands us the legal ids;
      // an optional trigger may also be declined, which exercises the empty-target path
      if (kind === 'graveyardCard') {
        const gy = legal.triggerGraveyardIds
        const decline = legal.triggerTargetOptional && rnd() < 0.4
        applyRulesAction(state, p, { type: 'r.chooseTargets', targets: decline || !gy.length ? [] : [pick(gy)] })
        return true
      }
      const onField = Object.values(state.objects).filter((o) => o.zone === 'battlefield' && matches(o))
      const creatures = onField.filter((o) => getDef(o.defName).types.includes('Creature')).map((o) => o.id)
      const cands: (ObjId | PlayerId)[] =
        kind === 'player' ? players
        : kind === 'creature' ? creatures
        : kind === 'permanent' ? onField.map((o) => o.id)
        : [...creatures, ...players]
      applyRulesAction(state, p, { type: 'r.chooseTargets', targets: cands.length ? [pick(cands)] : [] })
      return true
    }
    if (state.pending.kind === 'search' && state.pendingSearch) {
      // pick a random legal subset (exercises tutor/ramp + shuffle + re-mint)
      const ps = state.pendingSearch
      let cardIds = ps.matchIds.filter(() => rnd() < 0.5).slice(0, ps.count)
      // Myriad Landscape / Krosan Verge constrain the RELATION between two picks ("that share a land
      // type" / "a Forest card and a Plains card"). Rather than solve it, take a single card whenever
      // the constraint could be violated — every such search is "up to N", so one pick is always legal.
      if ((ps.shareSubtype || ps.pairSubtypes) && cardIds.length > 1) cardIds = cardIds.slice(0, 1)
      applyRulesAction(state, p, { type: 'r.search', cardIds })
      return true
    }
    if (state.pending.kind === 'sacrifice' && state.pendingSacrifice) {
      // choose exactly `count` random creatures to sacrifice (edict / each-player)
      const psac = state.pendingSacrifice
      const poolArr = [...psac.candidateIds]
      const chosen: ObjId[] = []
      while (chosen.length < psac.count && poolArr.length) chosen.push(poolArr.splice(Math.floor(rnd() * poolArr.length), 1)[0]!)
      applyRulesAction(state, p, { type: 'r.sacrifice', objIds: chosen })
      return true
    }
    if (state.pending.kind === 'madness' && state.pendingMadness) {
      // randomly cast the madness card (exiled face-up → public) at a random player, or decline →
      // graveyard; both leak-safe. On any illegality (can't pay / bad target), fall back to decline.
      const foes = state.turnOrder.filter((x) => x !== p && !state.players[x]!.hasLost)
      try {
        if (rnd() < 0.5 && foes.length) applyRulesAction(state, p, { type: 'r.madness', cast: true, targets: [pick(foes)] })
        else applyRulesAction(state, p, { type: 'r.madness', cast: false, targets: [] })
      } catch {
        applyRulesAction(state, p, { type: 'r.madness', cast: false, targets: [] })
      }
      return true
    }
    if (state.pending.kind === 'modes' && state.pendingModes) {
      // a modal TRIGGER ("choose one or more" — Black Market Connections): pick a legal non-empty subset
      const pm = state.pendingModes
      const all = [...Array(pm.labels.length).keys()]
      const picked = pm.oneOrMore ? all.filter(() => rnd() < 0.5) : all.slice(0, pm.count)
      applyRulesAction(state, p, { type: 'r.chooseModes', modes: picked.length ? picked : [all[0]!] })
      return true
    }
    if (state.pending.kind === 'retarget') {
      // "you may choose new targets": keeping them is always legal, so the fuzzer takes that branch —
      // picking a legal new target for an arbitrary stack item would mean re-deriving its specs here
      applyRulesAction(state, p, { type: 'r.retarget', targets: [] })
      return true
    }
    if (state.pending.kind === 'mayDraw' && state.pendingMayDraw) {
      // "up to two" takes any count; "you may draw TWO cards" (Mystic Remora) is all-or-nothing
      const pmd = state.pendingMayDraw
      const count = pmd.exact ? (rnd() < 0.5 ? 0 : pmd.max) : Math.floor(rnd() * (pmd.max + 1))
      applyRulesAction(state, p, { type: 'r.mayDraw', count })
      return true
    }
    if (state.pending.kind === 'revealTop') {
      // "you may reveal it and put it into your hand" (Herald's Horn): take it about half the time —
      // library → hand is hidden → hidden, but the card is REVEALED on the way
      applyRulesAction(state, p, { type: 'r.revealTop', take: rnd() < 0.5 })
      return true
    }
    if (state.pending.kind === 'proliferate') {
      // pick a random subset of the eligible permanents/players (declining is legal too)
      const lg = computeLegal(state, p)
      const objIds = lg.proliferateIds.filter(() => rnd() < 0.5)
      const playerIds = lg.proliferatePlayerIds.filter(() => rnd() < 0.5)
      applyRulesAction(state, p, { type: 'r.proliferate', objIds, playerIds })
      return true
    }
    if (state.pending.kind === 'handChoice') {
      // "you may put a land from your hand onto the battlefield" / Chrome Mox's imprint: take a legal
      // card about half the time, else decline — a hidden→public move either way when it is taken
      const lg = computeLegal(state, p)
      const take = lg.handChoiceIds.length && rnd() < 0.5 ? [pick(lg.handChoiceIds)] : []
      applyRulesAction(state, p, { type: 'r.handChoice', objIds: take })
      return true
    }
    if (state.pending.kind === 'typeChoice') {
      // "As this permanent enters, choose a creature type" — pick from a small pool so some choices
      // match the deck's creatures and the restricted mana is actually spendable
      applyRulesAction(state, p, { type: 'r.chooseType', creatureType: pick(['Bear', 'Elf', 'Ogre', 'Giant', 'Human', 'Beast']) })
      return true
    }
    const hand = state.zones.perPlayer[p]!.hand
    applyRulesAction(state, p, { type: 'r.discard', objIds: hand.slice(0, hand.length - 7) })
    return true
  }

  const actor = state.priorityPlayer
  if (!actor) return false
  /**
   * Tap a mana source, paying a "Sacrifice a creature" mana cost when the source has one (the
   * Altars). Returns false when it cannot be paid, so callers can move on — without this the
   * fuzzer's tap loops threw BAD_SACRIFICE the moment such a source was in play.
   */
  const tapSource = (src: ObjId, legalNow: ReturnType<typeof computeLegal>): boolean => {
    // a filter land (one mana in, two out) is a different shape: pass the pair + the paying colour
    const filt = legalNow.manaFilters.find((f) => f.objId === src)
    if (filt && rnd() < 0.5) {
      const payable = filt.payFrom.filter((c) => state.players[actor]!.manaPool[c] > 0)
      if (payable.length) {
        applyRulesAction(state, actor, {
          type: 'r.tapMana',
          objId: src,
          pair: Math.floor(rnd() * filt.outputs.length),
          payColor: pick(payable),
        })
        return true
      }
    }
    const colors = legalNow.manaSourceColors[src] ?? []
    const sacCount = legalNow.manaSourceSacCost[src] ?? 0
    let sacrifices: ObjId[] | undefined
    if (sacCount) {
      const mine = state.zones.perPlayer[actor]!.battlefield.filter(
        (id) => id !== src && getDef(state.objects[id]!.defName).types.includes('Creature'),
      )
      if (mine.length < sacCount) return false
      sacrifices = mine.slice(0, sacCount)
    }
    try {
      applyRulesAction(state, actor, {
      type: 'r.tapMana',
      objId: src,
      ...(colors.length ? { color: pick(colors) } : {}),
      ...(sacrifices ? { sacrifices } : {}),
      })
    } catch {
      // a mana ability can have its OWN mana cost (Three Tree City's "{2}, {T}: …"): if the pool
      // cannot cover it the tap is refused, which is a legal outcome — move on
      return false
    }
    return true
  }
  // ~15% of the time, exercise an assisted-table manual override instead of a
  // normal action (overrides don't need priority; using the priority holder is
  // just a convenient legal actor). These stay leak-safe by construction.
  if (rnd() < 0.15 && maybeOverride(state, actor, rnd)) return true
  const legal = computeLegal(state, actor)

  // occasionally FORETELL a hand card during your main phase → exiles it face-down, so the
  // history-aware leak check verifies opponents never learn its identity (CR 702.143). Once we
  // commit (a foretellable card is in hand + the roll hits), we tap for the {2} and try, then
  // ALWAYS return — tapping made `legal` stale, so we must not fall through to the normal actions.
  if (actor === state.activePlayer && (state.step === 'main1' || state.step === 'main2') && !state.zones.stack.length && rnd() < 0.25) {
    const foretellable = state.zones.perPlayer[actor]!.hand.filter((id) => getDef(state.objects[id]!.defName).foretellCost)
    if (foretellable.length) {
      for (const src of legal.manaSourceIds) {
        if (Object.values(state.players[actor]!.manaPool).reduce((x, y) => x + y, 0) >= 2) break
        const colors = legal.manaSourceColors[src] ?? []
        tapSource(src, legal)
      }
      try {
        applyRulesAction(state, actor, { type: 'r.foretell', objId: pick(foretellable) })
      } catch { /* not enough mana — the taps above still count as this step's action */ }
      return true
    }
  }

  // occasionally CHANNEL a card from hand (Kamigawa lands): the card is discarded as part of the cost
  // (hand → graveyard, hidden → public) and the ability goes on the stack. Commit-then-return, since
  // tapping for the cost makes `legal` stale.
  if (legal.channelable.length && rnd() < 0.3) {
    const ch = pick(legal.channelable)
    const need = (ch.cost.match(/\{/g) ?? []).length
    for (const src of legal.manaSourceIds) {
      if (Object.values(state.players[actor]!.manaPool).reduce((x, y) => x + y, 0) >= need) break
      tapSource(src, legal)
    }
    const targets: ObjId[] = []
    if (ch.targetKind === 'graveyardCard') {
      // redact hands us the legal graveyard cards; an optional one may also be declined
      const gy = ch.graveyardIds ?? []
      if (gy.length && rnd() < 0.7) targets.push(pick(gy))
    } else if (ch.targetKind) {
      const cands = Object.values(state.objects)
        .filter((o) => o.zone === 'battlefield' && (ch.targetKind === 'permanent' || getDef(o.defName).types.includes('Creature')))
        .map((o) => o.id)
      if (cands.length) targets.push(pick(cands))
    }
    try {
      applyRulesAction(state, actor, { type: 'r.channel', objId: ch.objId, targets })
    } catch { /* pool short after random taps, or the target became illegal */ }
    return true
  }

  // occasionally OVERLOAD a spell (CR 702.96) — overloaded Cyclonic Rift bounces every nonland
  // permanent its caster doesn't control, a many-objects public→hidden move whose re-mints the
  // history-aware assertion then checks. Same commit-then-always-return discipline as above
  // (tapping for mana makes `legal` stale).
  if (legal.overloadable.length && rnd() < 0.3) {
    const o = pick(legal.overloadable)
    const need = (o.cost.match(/\{/g) ?? []).length
    for (const src of legal.manaSourceIds) {
      if (Object.values(state.players[actor]!.manaPool).reduce((x, y) => x + y, 0) >= need) break
      const colors = legal.manaSourceColors[src] ?? []
      tapSource(src, legal)
    }
    try {
      applyRulesAction(state, actor, { type: 'r.cast', objId: o.objId, targets: [], overload: true })
    } catch { /* not enough real mana — the taps above still count as this step's action */ }
    return true
  }

  // occasionally cast a morph card FACE DOWN (2/2) for the fixed {3}, or turn a face-down
  // permanent face up. Same commit-then-always-return discipline (tapping makes `legal` stale).
  if (actor === state.activePlayer && (state.step === 'main1' || state.step === 'main2') && !state.zones.stack.length && rnd() < 0.25) {
    const faceUp = Object.values(state.objects).find((o) => o.zone === 'battlefield' && o.controllerId === actor && o.faceDown)
    const morphInHand = state.zones.perPlayer[actor]!.hand.filter((id) => getDef(state.objects[id]!.defName).morphCost)
    if (faceUp && rnd() < 0.4) {
      for (const src of legal.manaSourceIds) {
        if (Object.values(state.players[actor]!.manaPool).reduce((x, y) => x + y, 0) >= 4) break
        const colors = legal.manaSourceColors[src] ?? []
        tapSource(src, legal)
      }
      try { applyRulesAction(state, actor, { type: 'r.morph', objId: faceUp.id }) } catch { /* can't pay */ }
      return true
    }
    if (morphInHand.length) {
      for (const src of legal.manaSourceIds) {
        if (Object.values(state.players[actor]!.manaPool).reduce((x, y) => x + y, 0) >= 3) break
        const colors = legal.manaSourceColors[src] ?? []
        tapSource(src, legal)
      }
      try { applyRulesAction(state, actor, { type: 'r.cast', objId: pick(morphInHand), faceDown: true, targets: [] }) } catch { /* can't pay */ }
      return true
    }
  }

  // MODAL DFC (CR 712.4): sometimes play the LAND back face of a hand card instead of casting its
  // front — the object changes face as it leaves the hidden hand for the public battlefield
  if (legal.playableBackLandIds.length && rnd() < 0.4) {
    try {
      applyRulesAction(state, actor, { type: 'r.playLand', objId: pick(legal.playableBackLandIds), back: true })
      return true
    } catch { /* land drop spent */ }
  }

  // IMPULSE DRAW: play a card exiled by Jeska's Will / Reckless Impulse straight out of exile — a
  // land uses the land drop, anything else is cast for its printed cost from a PUBLIC zone
  if ((legal.playableExileLandIds.length || legal.castExileIds.length) && rnd() < 0.6) {
    if (legal.playableExileLandIds.length && rnd() < 0.5) {
      const land = pick(legal.playableExileLandIds)
      try {
        applyRulesAction(state, actor, { type: 'r.playLand', objId: land })
        impulsePlayed++ // coverage guard
        return true
      } catch { /* land drop already spent */ }
    } else if (legal.castExileIds.length) {
      const id = pick(legal.castExileIds)
      const def = getDef(state.objects[id]!.defName)
      const need = (def.manaCost?.replace(/\{X\}/g, '').match(/\{/g) ?? []).length
      for (const src of legal.manaSourceIds) {
        if (Object.values(state.players[actor]!.manaPool).reduce((x, y) => x + y, 0) >= need) break
        tapSource(src, legal)
      }
      // only untargeted cards are attempted here: a targeted one needs the same picker the hand
      // path uses, and an illegal guess would just be rejected
      const specs = def.modes?.length ? (def.modes[0]!.targets ?? []) : (def.spell?.targets ?? [])
      if (!specs.length && !def.modeRule) {
        try {
          applyRulesAction(state, actor, { type: 'r.cast', objId: id, targets: [], mode: def.modes?.length ? 0 : undefined })
          impulsePlayed++ // coverage guard
          return true
        } catch { /* can't pay / wrong timing */ }
      }
    }
  }

  // occasionally use an activated ability (exercises r.activate incl. sacrifice costs)
  if (legal.activations.length && rnd() < 0.3) {
    const a = pick(legal.activations)
    // pay any mana part by tapping sources (best-effort; passing is the fallback). Generic pips
    // carry an AMOUNT ({3} is three mana, not one), or a cost like War Room's would never be paid.
    const need = [...a.cost.matchAll(/\{([^}]+)\}/g)].reduce((n, m) => n + (/^\d+$/.test(m[1]!) ? Number(m[1]) : 1), 0)
    for (const src of legal.manaSourceIds) {
      const pool = state.players[actor]!.manaPool
      if (Object.values(pool).reduce((x, y) => x + y, 0) >= need) break
      const colors = legal.manaSourceColors[src] ?? []
      tapSource(src, legal)
    }
    const myCreatures = Object.values(state.objects)
      .filter((o) => o.zone === 'battlefield' && o.controllerId === actor && getDef(o.defName).types.includes('Creature'))
      .map((o) => o.id)
    const sacrifices = a.sacCost > 0 ? myCreatures.slice(0, a.sacCost) : []
    if (a.sacCost > 0 && sacrifices.length < a.sacCost) return tryPass() // can't pay the cost
    const targets: (ObjId | PlayerId)[] = []
    if (a.targetKind === 'graveyardCard') {
      const gy = a.graveyardIds ?? []
      if (!gy.length) return tryPass()
      targets.push(pick(gy))
    } else if (a.targetKind) {
      const allCreatures = Object.values(state.objects)
        .filter((o) => o.zone === 'battlefield' && getDef(o.defName).types.includes('Creature'))
        .map((o) => o.id)
      const players = state.turnOrder.filter((pp) => !state.players[pp]!.hasLost)
      const cands = a.targetKind === 'player' ? players : a.targetKind === 'creature' ? allCreatures : [...allCreatures, ...players]
      if (!cands.length) return tryPass()
      targets.push(pick(cands))
    }
    try {
      applyRulesAction(state, actor, { type: 'r.activate', objId: a.objId, abilityIndex: a.abilityIndex, targets, sacrifices })
    } catch {
      return tryPass()
    }
    return true
  }

  // occasionally activate a planeswalker loyalty ability (the pool's are non-targeted)
  if (legal.loyaltyActivations.length && rnd() < 0.4) {
    const la = pick(legal.loyaltyActivations)
    try {
      applyRulesAction(state, actor, { type: 'r.loyalty', objId: la.objId, abilityIndex: la.abilityIndex, targets: [] })
      pwLoyaltyFired++ // coverage guard: assert this path is actually exercised
    } catch {
      return tryPass()
    }
    return true
  }

  // occasionally equip a piece of Equipment onto one of your creatures (r.equip)
  if (legal.equippableIds.length && rnd() < 0.25) {
    const eqId = pick(legal.equippableIds)
    const eqCost = (getDef(state.objects[eqId]!.defName).equipCost?.match(/\{/g) ?? []).length
    for (const src of legal.manaSourceIds) {
      const pool = state.players[actor]!.manaPool
      if (Object.values(pool).reduce((x, y) => x + y, 0) >= eqCost) break
      const colors = legal.manaSourceColors[src] ?? []
      tapSource(src, legal)
    }
    const mine = Object.values(state.objects)
      .filter((o) => o.zone === 'battlefield' && o.controllerId === actor && getDef(o.defName).types.includes('Creature'))
      .map((o) => o.id)
    if (mine.length) {
      try {
        applyRulesAction(state, actor, { type: 'r.equip', equipmentId: eqId, creatureId: pick(mine) })
      } catch {
        return tryPass()
      }
      return true
    }
  }

  const roll = rnd()

  if (roll < 0.25 && legal.playableLandIds.length) {
    applyRulesAction(state, actor, { type: 'r.playLand', objId: pick(legal.playableLandIds) })
    return true
  }
  if (roll < 0.5 && legal.castableIds.length) {
    const objId = pick(legal.castableIds)
    const def = getDef(state.objects[objId]!.defName)
    // modal ("choose one"): pick a random mode — its targets/effect drive this cast
    const modeIdx = def.modes?.length && !def.modeRule ? Math.floor(rnd() * def.modes.length) : undefined
    // MULTI-mode ("choose two" / "one or more"): pick a legal SET of modes (fuzz games have no
    // commander, so a bothIfCommander card takes exactly one), and collect every chosen mode's targets
    let modeSet: number[] | undefined
    if (def.modeRule && def.modes?.length) {
      const n = def.modes.length
      const count = def.modeRule.count ?? (def.modeRule.oneOrMore ? 1 + Math.floor(rnd() * n) : 1)
      const bag = [...Array(n).keys()]
      modeSet = []
      while (modeSet.length < count && bag.length) modeSet.push(...bag.splice(Math.floor(rnd() * bag.length), 1))
      modeSet.sort((p1, p2) => p1 - p2)
    }
    const specs = modeSet
      ? modeSet.flatMap((i) => def.modes![i]!.targets ?? [])
      : def.modes?.length
        ? (def.modes[modeIdx!]!.targets ?? [])
        : (def.spell?.targets ?? [])
    // X spell: pick a small affordable X (0..2); mana needed = base pips + x·(#{X})
    const xCount = (def.manaCost?.match(/\{X\}/g) ?? []).length
    const x = xCount > 0 ? Math.floor(rnd() * 3) : undefined
    const basePips = (def.manaCost?.replace(/\{X\}/g, '').match(/\{/g) ?? []).length
    const need = basePips + (x ?? 0) * xCount
    for (const src of legal.manaSourceIds) {
      const pool = state.players[actor]!.manaPool
      if (Object.values(pool).reduce((a, b) => a + b, 0) >= need) break
      const colors = legal.manaSourceColors[src] ?? []
      tapSource(src, legal)
    }
    const targets: (ObjId | PlayerId)[] = []
    for (const spec of specs) {
      for (let i = 0; i < spec.count; i++) {
        const creatures = Object.values(state.objects)
          .filter((o) => o.zone === 'battlefield' && getDef(o.defName).types.includes('Creature'))
          .map((o) => o.id)
        // honour a "an opponent controls" / "you control" filter, or a spell like Assassin's Trophy
        // would almost always be aimed at an illegal target and skipped
        const perms = Object.values(state.objects)
          .filter((o) => o.zone === 'battlefield')
          .filter((o) =>
            spec.filter?.controller === 'opponent'
              ? o.controllerId !== actor
              : spec.filter?.controller === 'you'
                ? o.controllerId === actor
                : true,
          )
          .map((o) => o.id)
        const players = state.turnOrder.filter((p) => !state.players[p]!.hasLost)
        // graveyardCard (Raise Dead / Regrowth): pick from the ACTOR's own graveyard,
        // honouring the spec's type filter — this is the leak-critical graveyard→hand path
        const graveyardCards =
          spec.kind === 'graveyardCard'
            ? state.zones.perPlayer[actor]!.graveyard.filter((id) => {
                const d = getDef(state.objects[id]!.defName)
                if (spec.filter?.types && !spec.filter.types.some((t) => d.types.includes(t))) return false
                if (spec.filter?.excludeTypes && spec.filter.excludeTypes.some((t) => d.types.includes(t))) return false
                return true
              })
            : []
        // 'anyTarget' = creature, player OR planeswalker (CR 115.4) — a filter, when present,
        // applies to the permanent side only ("target player or planeswalker" excludes creatures)
        const planeswalkers = Object.values(state.objects)
          .filter((o) => o.zone === 'battlefield' && getDef(o.defName).types.includes('Planeswalker'))
          .map((o) => o.id)
        const anyCands = [
          ...(spec.filter?.excludeTypes?.includes('Creature') ? [] : creatures),
          ...players,
          ...planeswalkers,
        ]
        // "target spell or nonland permanent an opponent controls" (Sink into Stupor): a spell on the
        // stack, else a permanent matching the filter — `perms` already honours the controller filter
        const stackSpells = state.zones.stack.filter((x) => x.kind === 'spell').map((x) => x.id)
        const cands =
          spec.kind === 'creature'
            ? creatures
            : spec.kind === 'permanent'
              ? perms
              : spec.kind === 'player'
                ? players
                : spec.kind === 'graveyardCard'
                  ? graveyardCards
                  : spec.kind === 'spellOrPermanent'
                    ? [...stackSpells, ...perms.filter((id) => !getDef(state.objects[id]!.defName).types.includes('Land'))]
                    : anyCands
        if (!cands.length) return tryPass()
        // deliberately bias toward a planeswalker when one is on the board: burn is the only way
        // this new target class is reached, and a fuzz game's planeswalkers are attacked to death
        // early, so an unbiased pick left the pwBurned coverage guard asserting nothing
        const pwCands = planeswalkers.filter((id) => cands.includes(id))
        // the FIRST legal chance always takes the planeswalker, then it is a coin flip: fuzz games
        // attack their walkers to death early, so leaving this to chance made the pwBurned coverage
        // guard depend on the deck's shuffle (it silently dropped to zero twice while tuning it)
        const chosenTarget =
          spec.kind === 'anyTarget' && pwCands.length && (pwBurned === 0 || rnd() < 0.5) ? pick(pwCands) : pick(cands)
        if (spec.kind === 'anyTarget' && planeswalkers.includes(chosenTarget as ObjId)) pwBurned++ // coverage guard
        targets.push(chosenTarget)
      }
    }
    // cast-time additional costs (Village Rites: sacrifice a creature; Thrill of Possibility:
    // discard a card) — pay them, so the sacrifice/discard paths (and the dies triggers a sacrifice
    // fires ABOVE the spell) are exercised rather than the cast just being skipped
    const extra = legal.castExtraCost.find((c) => c.objId === objId)
    let sacrifices: ObjId[] | undefined
    let discards: ObjId[] | undefined
    if (extra) {
      if (extra.sacrifice) {
        const pool = state.zones.perPlayer[actor]!.battlefield.filter((id) => {
          const d = getDef(state.objects[id]!.defName)
          return extra.sacFilter === 'creature' ? d.types.includes('Creature') : d.types.includes('Creature') || d.types.includes('Artifact')
        })
        if (pool.length < extra.sacrifice) return tryPass()
        sacrifices = pool.slice(0, extra.sacrifice)
      }
      if (extra.discard) {
        const hand = state.zones.perPlayer[actor]!.hand.filter((id) => id !== objId)
        if (hand.length < extra.discard) return tryPass()
        discards = hand.slice(0, extra.discard)
      }
    }
    try {
      applyRulesAction(state, actor, { type: 'r.cast', objId, targets, x, mode: modeIdx, modes: modeSet, sacrifices, discards })
    } catch {
      return tryPass() // e.g. pool short after random taps, or illegal modal target — passing is always legal
    }
    return true
  }
  if (roll < 0.55 && legal.manaSourceIds.length) {
    const src = pick(legal.manaSourceIds)
    const colors = legal.manaSourceColors[src] ?? []
    if (!tapSource(src, legal)) return tryPass()
    return true
  }
  return tryPass()

  function tryPass(): boolean {
    applyRulesAction(state, actor!, { type: 'r.pass' })
    return true
  }
}

/** Fire one random assisted-table manual override for `actor`; false if none apply. */
function maybeOverride(state: RulesGameState, actor: PlayerId, rnd: () => number): boolean {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!
  const z = state.zones.perPlayer[actor]!
  // include commanders now: r.mMove reroutes a commander bound for a hidden zone
  // to the command zone, so this also fuzz-covers that leak guard.
  const bf = z.battlefield
  const acts: (() => void)[] = [
    () => applyRulesAction(state, actor, { type: 'r.mMana', color: 'C', delta: 1 }),
    () => applyRulesAction(state, actor, { type: 'r.mLife', delta: 1 }), // gain only — never ends games
  ]
  // keep boards realistic (and the fuzzer fast): only spawn tokens up to a small cap
  if (z.battlefield.length < 6)
    acts.push(() =>
      applyRulesAction(state, actor, {
        type: 'r.mToken',
        name: 'Zombie',
        power: 2,
        toughness: 2,
        typeLine: 'Token Creature — Zombie',
      }),
    )
  if (z.library.length) acts.push(() => applyRulesAction(state, actor, { type: 'r.mDraw', n: 1 }))
  if (bf.length) {
    const id = pick(bf)
    // public→hidden move (must re-mint the id) + a couple of in-place edits
    acts.push(() =>
      applyRulesAction(state, actor, {
        type: 'r.mMove',
        objId: id,
        zone: rnd() < 0.5 ? 'hand' : 'library',
        pos: rnd() < 0.5 ? 'top' : 'bottom',
      }),
    )
    acts.push(() => applyRulesAction(state, actor, { type: 'r.mMove', objId: id, zone: 'graveyard' }))
    acts.push(() => applyRulesAction(state, actor, { type: 'r.mTap', objId: id, tapped: !state.objects[id]!.tapped }))
    acts.push(() => applyRulesAction(state, actor, { type: 'r.mCounter', objId: id, name: '+1/+1', delta: 1 }))
  }
  if (z.hand.length)
    // hidden→public move (a card leaving hand onto the battlefield)
    acts.push(() => applyRulesAction(state, actor, { type: 'r.mMove', objId: pick(z.hand), zone: 'battlefield' }))
  pick(acts)()
  return true
}

// Deck for the fuzzer, chosen to exercise the leak-critical re-mint paths and the
// sacrifice machinery. It includes a B/R scry land (ETB scry → scry + library
// re-mint + dual-colour tap), Solemn Simulacrum ({4}, ETB search a basic → tutor/
// ramp search + shuffle + re-mint), and the B4 sacrifice cards — Fleshbag Marauder
// (ETB: each player sacrifices → the queued-edict path), Diabolic Edict (targeted
// edict), and Viscera Seer (a sac-outlet activated ability with a sacrifice cost,
// which the r.activate branch below drives). Black mana (Swamps + the B/R temple)
// is present so the black cards are actually castable.
const FUZZ_DECK = [
  ...Array(12).fill('Mountain'),
  ...Array(12).fill('Swamp'),
  ...Array(16).fill('Forest'), // enough green that Nissa ({1}{G}{G}) is reliably castable
  ...Array(4).fill('Temple of Malice'),
  ...Array(4).fill('Solemn Simulacrum'),
  ...Array(4).fill('Fleshbag Marauder'),
  ...Array(4).fill('Diabolic Edict'),
  ...Array(4).fill('Viscera Seer'),
  // batch T turn-based triggers: Phyrexian Arena (upkeep draw+lose → exercises the
  // upkeep firing + a library→hand each turn), Bitterblossom (upkeep token → ETB
  // watchers), Borderland Marauder (attacks self-pump → the attacks-trigger firing)
  ...Array(2).fill('Phyrexian Arena'),
  ...Array(2).fill('Bitterblossom'),
  ...Array(3).fill('Borderland Marauder'),
  // batch AE: an Aura (targeted spell → attaches on resolution, dies with host) and
  // an Equipment (enters unattached → exercises the r.equip attach path)
  ...Array(2).fill('Unholy Strength'),
  ...Array(2).fill('Bonesplitter'),
  // batch MX: an X spell (Blaze — X damage to any target, exercises r.cast.x) and a
  // modal spell (Abrade — exercises r.cast.mode + per-mode targeting)
  ...Array(3).fill('Blaze'),
  ...Array(2).fill('Abrade'),
  // batch PW: a planeswalker (Nissa; green mana above covers her {1}{G}{G}) — exercises
  // enters-with-loyalty, the r.loyalty action, token/counter/gain effects, and SBA
  ...Array(4).fill('Nissa, Voice of Zendikar'),
  // batch GY: graveyard recursion — Raise Dead ({B}, creature-only) and Regrowth
  // ({1}{G}, any card). Both move a card graveyard(public)→hand(hidden), the leak-
  // critical re-mint path (invariant #3); the fuzzer fills graveyards via combat
  // deaths and r.mMove, so these are reliably castable with black/green mana present.
  ...Array(3).fill('Raise Dead'),
  ...Array(3).fill('Regrowth'),
  // batch WARD: a warded creature ({1}{G} 3/1 Ward {2}) — when an opponent's removal
  // (Shock/Bolt/Blaze) targets it, the ward trigger fires and the fuzzer's ward branch
  // pays-or-declines; exercises the new r.ward action + 'ward' pending end to end.
  ...Array(3).fill('Tomakul Honor Guard'),
  // batch CASCADE: a cascade spell ({2}{R}{G} 3/1 haste) — casting it exiles from the top
  // of the library (public) and the fuzzer declines, sending the revealed cards to the
  // bottom RE-MINTED; the history-aware assertion then guards that leak-critical path.
  ...Array(3).fill('Bloodbraid Elf'),
  // batch MECH14: a madness card ({1}{R}{R} instant, Madness {R}) — when discarded (cleanup or an
  // effect) it's exiled face-up and the fuzzer's madness branch casts it or declines; exercises the
  // r.madness action + the exile→cast/graveyard paths, leak-checked after every action.
  ...Array(3).fill('Fiery Temper'),
  // batch MECH15: a foretell card ({3}{U} 2/3 flying, Foretell {2}{U}) — the fuzzer foretells it
  // (exile FACE DOWN), so assertNoLeaks verifies opponents never learn its identity in exile.
  ...Array(3).fill('Augury Raven'),
  // batch MECH16: a morph card ({3}{R}{R} 3/1 first strike, Morph {2}{R}{R}) — the fuzzer casts it
  // FACE DOWN (2/2) and sometimes turns it up; the deterministic morph test checks the name never
  // leaks on the stack or battlefield.
  ...Array(3).fill('Battering Craghorn'),
  // batch CARD5: Cultivate ({2}{G}) — a SPLIT library search (up to two basic lands, one onto the
  // battlefield tapped, the OTHER into the hand, then shuffle). Exercises the new split routing in
  // r.search: the searched land sent library→hand must be re-minted (invariant #3) and the library
  // reshuffled+re-minted, so the history-aware assertion guards that peek→hidden-hand path.
  ...Array(3).fill('Cultivate'),
  // batch CARD9: a sac-self fetch land (Evolving Wilds) — the fuzzer's r.activate branch pays
  // "{T}, Sacrifice this land" and the ability then searches the library from the GRAVEYARD, so the
  // library peek + shuffle re-mint is leak-checked on an ABILITY (not just a spell) path; and
  // Bojuka Bog, whose ETB exiles a targeted player's graveyard (public → public, no re-mint).
  ...Array(3).fill('Evolving Wilds'),
  ...Array(2).fill('Bojuka Bog'),
  // batch CARD10: an until-EOT keyword grant over ALL your permanents (Heroic Intervention —
  // hexproof/indestructible now reach lands and artifacts, so redaction runs with granted
  // keywords on non-creatures) and a targeted activated ability on a land (Rogue's Passage).
  ...Array(3).fill('Heroic Intervention'),
  ...Array(2).fill("Rogue's Passage"),
  // batch CARD11: a fetch land — "{T}, Pay 1 life, Sacrifice this land: search for a Swamp or
  // Mountain card" (the deck is Swamp/Mountain-heavy, so it reliably finds one). Exercises the new
  // life cost together with the sac-self + library-search-from-the-graveyard path.
  ...Array(3).fill('Bloodstained Mire'),
  // batch CARD12: a shockland (Swamp Mountain, so Bloodstained Mire can also fetch it) — exercises
  // the new as-enters CHOICE pending on both the play-a-land and the fetched-mid-search paths.
  ...Array(3).fill('Blood Crypt'),
  // batch CARD13: Skullclamp (equip → +1/-1 kills 1-toughness creatures, and the equipped-creature
  // -dies trigger draws TWO cards — a library→hand path off a death) and Fabled Passage (a fetch
  // whose land enters tapped then conditionally untaps).
  ...Array(2).fill('Skullclamp'),
  ...Array(2).fill('Fabled Passage'),
  // batch CARD14: Pitiless Plunderer — creature deaths are frequent in a fuzz game, so Treasure
  // tokens appear and the fuzzer's mana-tapping loops then exercise the new
  // "{T}, Sacrifice this token" MANA-ability cost (a mana source that removes itself).
  ...Array(2).fill('Pitiless Plunderer'),
  // batch CARD15: an overload spell. Overloaded Cyclonic Rift returns EVERY nonland permanent its
  // caster doesn't control to hand — battlefield(public) → hand(hidden) for many objects at once,
  // so the history-aware assertion checks every one of those ids was re-minted (invariant #3).
  ...Array(3).fill('Cyclonic Rift'),
  // batch CARD16: Rhystic Study — every opponent cast opens the pay-or-let-them-draw decision, so
  // the fuzzer exercises the new pending on both branches (declining draws a card = library→hand).
  ...Array(2).fill('Rhystic Study'),
  // batch CARD17: mana that hurts — Ancient Tomb (2 damage per tap) and a pain land whose colour
  // ability costs 1 life, so the fuzzer's tapping loops drive both damage paths (and can kill).
  ...Array(2).fill('Ancient Tomb'),
  ...Array(2).fill('Sulfurous Springs'),
  // batch CARD18: Toxic Deluge (X paid in LIFE — the fuzzer casts it like any spell, so the
  // additional-cost path runs) and Smothering Tithe, whose DRAW trigger taxes every opponent draw
  // (including each draw step), exercising the draw-trigger → optionalPay chain constantly.
  ...Array(2).fill('Toxic Deluge'),
  ...Array(2).fill('Smothering Tithe'),
  // batch CARD19: a check land (its enters-tapped condition is evaluated on every entry path) and
  // Swan Song, whose counter hands the countered player a Bird token.
  ...Array(3).fill('Dragonskull Summit'),
  ...Array(2).fill('Swan Song'),
  // batch CARD20: Chaos Warp (battlefield → library, the leak-critical public→hidden shuffle whose
  // re-mints the history-aware assertion checks) and Brainstorm (draw 3, put 2 back on top).
  ...Array(3).fill('Chaos Warp'),
  ...Array(3).fill('Brainstorm'),
  // batch CARD21: a Talisman (two mana abilities, the coloured one costing 1 life), a battle land
  // (its basics condition is checked on every entry) and Sakura-Tribe Elder (sac-self fetch).
  ...Array(2).fill('Talisman of Indulgence'),
  ...Array(2).fill('Smoldering Marsh'),
  ...Array(2).fill('Sakura-Tribe Elder'),
  // batch CARD22: a tutor whose pick goes on TOP of the library — the searcher legitimately peeked
  // at those ids, so the shuffle + re-mint + re-order path must leave nothing trackable, which the
  // history-aware assertion checks; plus Lotus Petal (a sac-self mana source).
  ...Array(3).fill('Vampiric Tutor'),
  ...Array(2).fill('Lotus Petal'),
  // batch CARD23: Blood Artist — a TARGETED dies trigger, so every fuzz death now opens a trigger
  // target choice (the branch added for Bojuka Bog), and Prismatic Vista (life + sac + fetch).
  ...Array(2).fill('Blood Artist'),
  ...Array(2).fill('Prismatic Vista'),
  // batch CARD24: cast-time additional costs — the fuzzer pays them from `legal.castExtraCost`, so
  // both the sacrifice (its dies triggers landing above the spell) and the discard (hand→graveyard,
  // hidden→public) run under the leak assertions.
  ...Array(2).fill('Village Rites'),
  ...Array(2).fill('Thrill of Possibility'),
  // batch CARD25: Opt (a scry cantrip), Explore (an extra land drop) and Crop Rotation (sacrifice a
  // LAND, then fetch any land — a library search whose pick can itself be a tapland).
  ...Array(2).fill('Opt'),
  ...Array(2).fill('Explore'),
  ...Array(2).fill('Crop Rotation'),
  // batch CARD26: Gray Merchant (a devotion-sized drain on ETB) and a Triome (a tapland with
  // Cycling {3}, so the fuzzer's cycling branch runs on a land too).
  ...Array(2).fill('Gray Merchant of Asphodel'),
  ...Array(2).fill('Ketria Triome'),
  // batch CARD27: a reveal land (its hand check runs on every entry), Exploration (a static extra
  // land drop) and Morbid Opportunist (a once-per-turn dies trigger among many deaths).
  ...Array(2).fill('Foreboding Ruins'),
  ...Array(2).fill('Exploration'),
  ...Array(2).fill('Morbid Opportunist'),
  // batch CARD28: a Karoo land (its ETB bounces one of your lands — battlefield→hand, re-minted) and
  // Rampaging Baloths (landfall, so every land drop makes a token) + Entomb (library→graveyard).
  ...Array(2).fill('Dimir Aqueduct'),
  ...Array(2).fill('Rampaging Baloths'),
  ...Array(2).fill('Entomb'),
  // batch CARD29: Guttersnipe (a typed cast trigger firing on most fuzz casts), Aetherflux Reservoir
  // (a per-turn spell counter + a 50-life ability) and Land Tax (an intervening "if" upkeep search).
  ...Array(2).fill('Guttersnipe'),
  ...Array(2).fill('Aetherflux Reservoir'),
  ...Array(2).fill('Land Tax'),
  // batch CARD30: Consider (surveil 1 → the graveyard, then a sequenced draw) and a surveil land, so
  // the shared scry decision runs in BOTH modes under the history-aware assertion.
  ...Array(3).fill('Consider'),
  ...Array(2).fill('Undercity Sewers'),
  // batch CARD31: Ashnod's Altar (a TAPLESS mana ability whose cost is sacrificing a creature — the
  // fuzzer taps mana sources constantly, so this runs often) and Gamble (tutor to hand + a random
  // discard, i.e. hidden→hidden then hidden→public).
  ...Array(2).fill("Ashnod's Altar"),
  ...Array(2).fill('Gamble'),
  // batch CARD32: a filter land — its hybrid payment + three-way output choice is a mana shape no
  // other card has, and the fuzzer uses it whenever it has a payable colour in the pool.
  ...Array(3).fill('Graven Cairns'),
  // batch CARD33: an attack tax, so the fuzzer must float mana to attack (or declare nobody), and
  // Frantic Search, whose discard carries the untap-lands follow-up.
  ...Array(2).fill('Ghostly Prison'),
  ...Array(2).fill('Frantic Search'),
  // batch CARD34: Eternal Witness (an OPTIONAL graveyard-card ETB trigger — graveyard→hand, the
  // re-mint path) and Sun Titan (the same shape returning a permanent to the battlefield).
  ...Array(3).fill('Eternal Witness'),
  ...Array(2).fill('Sun Titan'),
  // batch CARD35: Ponder (the reorder mode of the shared peek, plus a sequenced draw) and Chromatic
  // Lantern (every land gains an any-colour ability, so the fuzzer's taps go through the granted path).
  ...Array(3).fill('Ponder'),
  ...Array(2).fill('Chromatic Lantern'),
  // batch CARD36: Mana Drain (a DELAYED trigger that pays out at its controller's next main phase)
  // and Pact of Negation (a delayed pay-or-lose, so the fuzzer's optionalPay branch can end a game).
  ...Array(2).fill('Mana Drain'),
  ...Array(2).fill('Pact of Negation'),
  // batch CARD37: two CHANNEL lands — used from hand, discarding the card as part of the cost, so the
  // fuzzer exercises a hand→graveyard cost plus an ability on the stack from a card that is now gone.
  ...Array(2).fill('Otawara, Soaring City'),
  ...Array(2).fill('Sokenzan, Crucible of Defiance'),
  // batch CARD38: graveyard targets on an ACTIVATED ability (Buried Ruin) and on a CHANNEL ability
  // (Takenuma) — both move a card graveyard→hand, the leak-critical re-mint path.
  ...Array(2).fill('Buried Ruin'),
  ...Array(2).fill('Takenuma, Abandoned Mire'),
  // batch CARD39: Windfall (EVERY player's hand → the graveyard at once, then everyone draws the
  // greatest count — a mass hidden→public move followed by many library→hand draws), Assassin's
  // Trophy (its search belongs to the OPPONENT whose permanent died, so a peek is opened for a
  // player who is not the actor), Ash Barrens (landcycling: a hand→graveyard cost whose ability then
  // searches the library) and War Room (an activated ability with a mana + tap + life cost).
  ...Array(2).fill('Windfall'),
  ...Array(2).fill("Assassin's Trophy"),
  ...Array(2).fill('Ash Barrens'),
  ...Array(2).fill('War Room'),
  // batch CARD40: Farewell — a MULTI-mode spell ("choose one or more"), so the fuzzer sends a SET of
  // modes and a single resolution sweeps several categories at once (battlefield → exile for many
  // objects, plus every graveyard). The few Plains are only there to make {4}{W}{W} reachable; Austere
  // Command is deliberately left out — same code path with a fixed count, and a second white sweeper
  // would distort this otherwise B/R/G deck.
  ...Array(4).fill('Plains'),
  ...Array(2).fill('Farewell'),
  // batch CARD41: Boros Charm (its first mode targets a PLAYER OR PLANESWALKER — an any-target whose
  // permanent side excludes creatures, so the fuzzer's target picker must respect the filter) and
  // Return of the Wildspeaker (a mass pump / greatest-power draw, no targets).
  // batch CARD42: impulse draw — Reckless Impulse and Jeska's Will exile the top of the library
  // (hidden → PUBLIC) and let their controller play those cards from exile, so the fuzzer casts and
  // plays lands out of exile while the history-aware assertion watches the ids.
  // batch CARD43: a "deals combat damage to a player" trigger on an EQUIPMENT (Sword of Feast and
  // Famine — the damaged player discards, i.e. an opponent's hidden→public move driven by MY trigger,
  // and all my lands untap) and Professional Face-Breaker, whose "one or more creatures you control"
  // wording fires once per damaged player and whose Treasure sacrifice feeds an impulse exile.
  // batch CARD44: a type-choosing land whose second ability makes RESTRICTED mana — the fuzzer must
  // answer the as-enters choice, and its mana must never pay for something that doesn't match (the
  // engine keeps it out of the open pool entirely).
  // batch CARD45: a modal DFC — the fuzzer plays its land back face about as often as it casts the
  // front, so the hidden-hand → public-battlefield move happens under BOTH faces.
  // batch CARD46: a granted "when this creature dies, return it" ability — deaths are constant in a
  // fuzz game, so the granted trigger fires often and returns a card graveyard→battlefield (public →
  // public, but it puts a NEW object on the battlefield mid-combat, which the assertions watch).
  // batch CARD47: Growth Spiral (a LAND moved hand→battlefield by a decision, i.e. hidden→public
  // outside the land-drop path) and Chrome Mox (imprint: hand→exile, and its mana colours then depend
  // on the exiled card).
  // batch CARD48: Sensei's Divining Top — its {T} ability puts ITSELF on top of the library, the
  // leak-critical public→hidden move, and it has TWO activated abilities so the fuzzer's activation
  // branch now picks among several on one permanent.
  // batch CARD49: Mana Vault — it does NOT untap in the untap step, opens a may-pay decision at every
  // upkeep of its controller (the mirror of the unless-pay branch the fuzzer already answers) and can
  // whittle its controller down at their draw step.
  // batch CARD50: replacement effects — Hardened Scales makes every +1/+1 counter one bigger and
  // Parallel Lives doubles every token, so the fuzzer's counter and token paths run through the new
  // single funnel constantly (Bitterblossom / Rampaging Baloths / the Altars all feed it).
  // batch CARD51: proliferate — Evolution Sage fires on every land drop (constant in a fuzz game) and
  // Karn's Bastion offers it as an activated ability, so the new multi-select decision is answered
  // often, and its counters run through the CARD50 replacement funnel.
  // batch CARD52: Animate Dead (a graveyard→battlefield reanimating AURA whose leaves-the-battlefield
  // trigger then sacrifices what it animated — two new trigger timings, both firing often once fuzz
  // graveyards fill up) and The Ozolith, whose combat trigger collects counters from anything leaving.
  // batch CARD53: two of the Eldraine cycle — Witch's Cottage moves a card graveyard→LIBRARY TOP (the
  // leak-critical public→hidden re-mint) when it enters untapped, and Dwarven Mine's untapped ETB makes
  // a token; both also exercise the subtype-counting enters-tapped condition on every entry path.
  // batch CARD54: The One Ring — its cast-only ETB shields its controller from targeting and damage for
  // a full turn cycle (so the fuzzer's spells must respect an untargetable player), and its burden
  // counters make it draw ever more cards while bleeding life.
  // batch CARD55: Urza's Saga — a SAGA that is PLAYED as a land (the entry path that had no lore
  // counter at all until this batch), grants itself two abilities as its chapters tick over, makes
  // board-counting Construct tokens and fetches an artifact before sacrificing itself.
  // batch CARD56: Herald's Horn — its upkeep look opens the reveal-top decision every turn cycle (an
  // actor-only peek at ONE library card, so the history-aware assertion watches that id), and its
  // type-gated discount changes what the fuzzer can afford.
  // batch CARD57: Myriad Landscape — a sac-fetch whose search takes TWO cards at once with a
  // share-a-land-type constraint, so the fuzzer's search branch now has to satisfy a relation between
  // its picks (it takes one card when it cannot).
  // batch CARD58: Urborg makes EVERY land (both players') a Swamp, so the fuzzer's mana taps go through
  // the granted-colour path constantly and swampwalk turns on for the whole table; Garruk's Uprising
  // draws whenever a big creature you control enters.
  // batch CARD59: Arcane Denial — a counter whose compensation lands at the NEXT turn's upkeep, so the
  // fuzzer answers a may-draw decision on somebody else's turn (library→hand for a non-active player).
  // batch CARD60: Deflecting Swat — targets a SPELL OR ABILITY on the stack and opens the re-aim
  // decision. Fuzz games have no commanders, so it is cast for its {2}{R}; the fuzzer keeps the targets.
  // batch CARD61: Mystic Remora — a cumulative-upkeep permanent (an age counter and a growing
  // pay-or-sacrifice decision every one of its controller's upkeeps) whose all-or-nothing draw fires on
  // every opponent noncreature spell, so both decisions are answered constantly.
  // batch CARD62: Black Market Connections — a MODAL TRIGGER at every one of its controller's first main
  // phases, so the fuzzer answers a mode choice each turn cycle and pays life for it (it can lose a game).
  // batch CARD63: Victimize — TWO graveyard targets (the fuzzer's cast branch must pick two distinct
  // creature cards from its own graveyard) whose sacrifice DECISION carries the reanimation follow-up.
  // batch CARD64: Tireless Provisioner — a MODAL landfall trigger, so the fuzzer answers a mode choice on
  // every land drop (the most frequent trigger in a fuzz game), and Command Beacon, whose sac ability
  // moves a COMMANDER command-zone→hand.
  // batch CARD65: Sink into Stupor — its front bounces a SPELL off the stack into its owner's HIDDEN hand
  // (a public→hidden re-mint the history-aware assertion watches) and its back is a pay-3-life land.
  // batch CARD66: Roaming Throne — it DOUBLES the triggered abilities of your creatures of the type it
  // chose, so fuzz games see doubled dies/ETB triggers (including targeted ones, whose extra instance
  // waits in extraTriggerQueue for the first target choice to be answered), and Three Tree City, whose
  // mana scales with your creatures of that type.
  ...Array(2).fill('Roaming Throne'),
  ...Array(2).fill('Three Tree City'),
  ...Array(3).fill('Sink into Stupor'),
  ...Array(2).fill('Tireless Provisioner'),
  ...Array(2).fill('Command Beacon'),
  ...Array(2).fill('Victimize'),
  ...Array(2).fill('Black Market Connections'),
  ...Array(2).fill('Mystic Remora'),
  ...Array(2).fill('Deflecting Swat'),
  ...Array(2).fill('Arcane Denial'),
  ...Array(2).fill('Urborg, Tomb of Yawgmoth'),
  ...Array(2).fill("Garruk's Uprising"),
  ...Array(3).fill('Myriad Landscape'),
  ...Array(2).fill("Herald's Horn"),
  ...Array(3).fill("Urza's Saga"),
  ...Array(2).fill('The One Ring'),
  ...Array(3).fill("Witch's Cottage"),
  ...Array(2).fill('Dwarven Mine'),
  ...Array(2).fill('Animate Dead'),
  ...Array(2).fill('The Ozolith'),
  ...Array(2).fill('Evolution Sage'),
  ...Array(2).fill("Karn's Bastion"),
  ...Array(2).fill('Hardened Scales'),
  ...Array(2).fill('Parallel Lives'),
  ...Array(2).fill('Mana Vault'),
  ...Array(2).fill("Sensei's Divining Top"),
  ...Array(2).fill('Growth Spiral'),
  ...Array(2).fill('Chrome Mox'),
  ...Array(3).fill('Feign Death'),
  ...Array(3).fill('Bala Ged Recovery'),
  ...Array(3).fill('Unclaimed Territory'),
  ...Array(2).fill('Sword of Feast and Famine'),
  ...Array(2).fill('Professional Face-Breaker'),
  ...Array(3).fill('Reckless Impulse'),
  ...Array(2).fill("Jeska's Will"),
  ...Array(2).fill('Boros Charm'),
  ...Array(2).fill('Return of the Wildspeaker'),
  ...Array(6).fill('Shock'),
  ...Array(4).fill('Lightning Bolt'),
  ...Array(4).fill('Gray Ogre'),
]

describe('enforced-mode hidden-information fuzzing (CI-blocking)', () => {
  it('never leaks library or opponent-hand ids across seeded random 2/3/4-player games', () => {
    const cases: [number, number][] = [
      [2, 11],
      [3, 4242],
      [4, 20260707],
      [4, 909090],
    ]
    pwLoyaltyFired = 0
    pwAttacked = 0
    pwBurned = 0
    impulsePlayed = 0
    try {
      for (const [nPlayers, seed] of cases) {
        const rnd = mulberry32(seed)
        // seed EVERY source of randomness (library shuffle, first-player pick, id
        // minting AND action choices) from the same stream so the game replays
        // identically from `seed` — a failure here is reproducible/bisectable.
        __setDeterministicRng(rnd)
        const { state } = makeGameN(nPlayers, FUZZ_DECK)
        // Give EVERY player a planeswalker up front so "an opponent's planeswalker is attackable"
        // holds from turn 1. Casting Nissa off the shuffled deck and keeping her alive until
        // someone's declare-attackers is pure seed luck (it silently dropped to zero when this
        // deck changed), which would leave the pwAttacked coverage guard below asserting nothing.
        for (const p of state.turnOrder) {
          const pw = putCard(state, p, 'Nissa, Voice of Zendikar', 'battlefield')
          // putCard bypasses moveTo (where loyalty is normally initialised), so set it here or the
          // 0-loyalty SBA kills her instantly
          state.objects[pw]!.loyalty = getDef(defKey('Nissa, Voice of Zendikar')).loyalty ?? 0
        }
        const seen = new Map<PlayerId, Set<string>>(state.turnOrder.map((p) => [p, new Set<string>()]))
        assertNoLeaks(state, `(${nPlayers}p seed ${seed}, initial)`, seen)
        let steps = 0
        while (state.status === 'active' && steps < 1500) {
          steps++
          if (!randomAction(state, rnd)) break
          assertNoLeaks(state, `(${nPlayers}p seed ${seed}, action ${steps}, step ${state.step})`, seen)
        }
        expect(steps).toBeGreaterThan(50) // the fuzzer actually exercised the engine
      }
    } finally {
      __setDeterministicRng(null) // never leave the deterministic seam set for other suites
    }
    // invariant #4: the new actions must actually be exercised by the fuzzer, not left
    // as dead code (a planeswalker never castable / never attacked)
    expect(pwLoyaltyFired).toBeGreaterThan(0)
    expect(pwAttacked).toBeGreaterThan(0)
    // (pwBurned is telemetry, not a guard: a fuzz game's planeswalkers are attacked to death long
    //  before an any-target burn spell happens to be castable — measured at 0 of 6 such casts — so the
    //  planeswalker-damage path is pinned by the deterministic test below instead.)
    // Execution budget only — NOT part of the leak assertion. This fuzzes 4 games (2/3/4-player)
    // to a 1500-step cap, redacting the full state for every viewer after EVERY action (history-
    // aware). The 3/4-player games run to the cap (random play rarely ends them), so the work is
    // large but BOUNDED — it cannot hang. Generous timeout so CPU-load variance can't flake CI;
    // the leak coverage (seeds, step depth, per-action check) is unchanged.
  }, 420_000)

  // Deterministic coverage of the graveyard→hand recursion re-mint (invariant #3),
  // run through the SAME history-aware machinery as the fuzzer. The random loop can't
  // be relied on to line up (recursion in hand + coloured mana + a matching graveyard
  // card + the cast roll, all at once), so this drives it explicitly: it would FAIL
  // if returnFromGraveyard stopped re-minting, because B saw the graveyard id and the
  // same id would then surface in A's hidden hand.
  it('re-mints a card returned from graveyard to hand (history-aware, deterministic)', () => {
    __setDeterministicRng(mulberry32(5150))
    try {
      const { state } = makeGameN(2, FUZZ_DECK)
      const A = state.activePlayer
      const B = state.turnOrder.find((p) => p !== A)!
      const seen = new Map<PlayerId, Set<string>>(state.turnOrder.map((p) => [p, new Set<string>()]))
      toStep(state, 'main1')
      const gyId = putCard(state, A, 'Grizzly Bears', 'graveyard')
      const rd = putCard(state, A, 'Raise Dead', 'hand')
      // record the current (public-graveyard) view — B genuinely sees the graveyard id now
      assertNoLeaks(state, '(gy setup)', seen)
      expect(seen.get(B)!.has(gyId)).toBe(true)
      applyRulesAction(state, A, { type: 'r.mMana', color: 'B', delta: 1 })
      applyRulesAction(state, A, { type: 'r.cast', objId: rd, targets: [gyId] })
      until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'Raise Dead resolves')
      // the creature is back in A's hand with a FRESH id (old graveyard id destroyed)
      expect(state.objects[gyId]).toBeUndefined()
      const returned = state.zones.perPlayer[A]!.hand.find((id) => getDef(state.objects[id]!.defName).name === 'Grizzly Bears')
      expect(returned, 'Grizzly Bears returned to hand').toBeTruthy()
      expect(returned).not.toBe(gyId)
      // history-aware: B must not see the re-minted hand id, and the old (seen) id must
      // not resurface in any zone hidden from B.
      assertNoLeaks(state, '(gy after return)', seen)
    } finally {
      __setDeterministicRng(null)
    }
  })

  // Deterministic hidden-information coverage for FORETELL (CR 702.143): a foretold card sits in
  // exile FACE DOWN — opponents must never learn its identity. Driven explicitly (the random loop
  // can't be relied on to line up the {2} + a foretell card in hand) through the leak machinery.
  it('never leaks a foretold (face-down) card to opponents (history-aware, deterministic)', () => {
    __setDeterministicRng(mulberry32(720))
    try {
      const { state } = makeGameN(2, FUZZ_DECK)
      const A = state.activePlayer
      const B = state.turnOrder.find((p) => p !== A)!
      const seen = new Map<PlayerId, Set<string>>(state.turnOrder.map((p) => [p, new Set<string>()]))
      toStep(state, 'main1')
      const raven = putCard(state, A, 'Augury Raven', 'hand')
      applyRulesAction(state, A, { type: 'r.mMana', color: 'U', delta: 2 })
      applyRulesAction(state, A, { type: 'r.foretell', objId: raven })
      expect(state.objects[raven]!.faceDown).toBe(true)
      // B sees a face-down exile card with NO identity; the redacted stream must not name it
      const forB = redactRulesState(state, B)
      expect(forB.cards[raven]?.defName).toBeNull()
      expect(JSON.stringify(forB).includes('Augury Raven')).toBe(false)
      // the full leak sweep passes after the foretell, and every subsequent step
      assertNoLeaks(state, '(foretold)', seen)
      for (let i = 0; i < 40 && state.status === 'active'; i++) {
        if (!randomAction(state, mulberry32(720 + i))) break
        assertNoLeaks(state, `(foretold, step ${i})`, seen)
      }
    } finally {
      __setDeterministicRng(null)
    }
  })

  // Deterministic hidden-information coverage for MORPH (CR 702.37): a face-down creature's identity
  // must never leak to opponents — on the STACK (while being cast) or on the battlefield. Name-based
  // (assertNoLeaks is id-based; a face-down creature's id is public, but its NAME must not be).
  it('never leaks a face-down (morph) creature name to opponents, on the stack or battlefield', () => {
    __setDeterministicRng(mulberry32(909))
    try {
      const { state } = makeGameN(2, FUZZ_DECK)
      const A = state.activePlayer
      const B = state.turnOrder.find((p) => p !== A)!
      const seen = new Map<PlayerId, Set<string>>(state.turnOrder.map((p) => [p, new Set<string>()]))
      toStep(state, 'main1')
      const cra = putCard(state, A, 'Battering Craghorn', 'hand')
      applyRulesAction(state, A, { type: 'r.mMana', color: 'R', delta: 3 })
      applyRulesAction(state, A, { type: 'r.cast', objId: cra, faceDown: true, targets: [] })
      // ON THE STACK, face down: the opponent must not see the card name
      expect(JSON.stringify(redactRulesState(state, B)).includes('Battering Craghorn')).toBe(false)
      until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'morph resolves')
      // ON THE BATTLEFIELD, face down: still hidden; the redacted card carries no defName
      const forB = redactRulesState(state, B)
      expect(JSON.stringify(forB).includes('Battering Craghorn')).toBe(false)
      expect(forB.cards[cra]?.defName).toBeNull()
      expect(forB.cards[cra]?.power).toBe(2)
      assertNoLeaks(state, '(face-down)', seen)
      // turn it face up → now revealed to the opponent
      applyRulesAction(state, A, { type: 'r.mMana', color: 'R', delta: 4 })
      applyRulesAction(state, A, { type: 'r.morph', objId: cra })
      expect(redactRulesState(state, B).cards[cra]?.defName).toBe(defKey('Battering Craghorn'))
    } finally {
      __setDeterministicRng(null)
    }
  })

  // Deterministic leak-fuzzer coverage for the new r.cycle action (CLAUDE.md: new actions
  // need leak-fuzzer coverage). Cycling moves a card hand(hidden)→graveyard(public) as a
  // cost, then draws (library→hand). It's leak-safe by construction, but this drives it
  // through the SAME history-aware machinery to regression-guard that (a) the reveal
  // leaks no other hidden id and (b) the draw stays hidden from opponents.
  it('cycles a card (hidden→public reveal + draw) with no leak (history-aware, deterministic)', () => {
    __setDeterministicRng(mulberry32(3131))
    try {
      const { state } = makeGameN(2, FUZZ_DECK)
      const A = state.activePlayer
      const B = state.turnOrder.find((p) => p !== A)!
      const seen = new Map<PlayerId, Set<string>>(state.turnOrder.map((p) => [p, new Set<string>()]))
      toStep(state, 'main1')
      const moor = putCard(state, A, 'Barren Moor', 'hand') // Cycling {B}
      const libBefore = state.zones.perPlayer[A]!.library.length
      assertNoLeaks(state, '(cycle setup)', seen)
      applyRulesAction(state, A, { type: 'r.mMana', color: 'B', delta: 1 })
      applyRulesAction(state, A, { type: 'r.cycle', objId: moor })
      until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'cycling resolves')
      // cost paid (discarded to the public graveyard) + drew a card
      expect(state.zones.perPlayer[A]!.graveyard.includes(moor)).toBe(true)
      expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore - 1)
      assertNoLeaks(state, '(after cycle)', seen)
    } finally {
      __setDeterministicRng(null)
    }
  })

  // "ANY TARGET" INCLUDES A PLANESWALKER (CARD41): burn aimed at one removes loyalty instead of
  // marking damage, and the 0-loyalty SBA kills it. Pinned here rather than in the fuzz loop, whose
  // planeswalkers are attacked to death long before an any-target spell is castable.
  it('burn aimed at a planeswalker removes loyalty, with no leak (history-aware, deterministic)', () => {
    __setDeterministicRng(mulberry32(1717))
    try {
      const { state } = makeGameN(2, FUZZ_DECK)
      const A = state.activePlayer
      const B = state.turnOrder.find((p) => p !== A)!
      const seen = new Map<PlayerId, Set<string>>(state.turnOrder.map((p) => [p, new Set<string>()]))
      toStep(state, 'main1')
      const pw = putCard(state, B, 'Nissa, Voice of Zendikar', 'battlefield')
      state.objects[pw]!.loyalty = 3
      const shock = putCard(state, A, 'Shock', 'hand')
      assertNoLeaks(state, '(pw setup)', seen)
      applyRulesAction(state, A, { type: 'r.mMana', color: 'R', delta: 1 })
      applyRulesAction(state, A, { type: 'r.cast', objId: shock, targets: [pw] })
      until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the Shock resolves')
      expect(state.objects[pw]!.loyalty).toBe(1)
      assertNoLeaks(state, '(after burning the planeswalker)', seen)
      const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
      applyRulesAction(state, A, { type: 'r.mMana', color: 'R', delta: 1 })
      applyRulesAction(state, A, { type: 'r.cast', objId: bolt, targets: [pw] })
      until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the Bolt resolves')
      expect(state.objects[pw]!.zone).toBe('graveyard') // 0 loyalty → CR 704.5i
      assertNoLeaks(state, '(after it died)', seen)
    } finally {
      __setDeterministicRng(null)
    }
  })

  // IMPULSE DRAW (CARD42): the top of a HIDDEN library becomes PUBLIC in exile and its controller
  // then plays it from there. The fuzz loop exercises this too, but whether an impulse spell is drawn
  // and affordable is shuffle luck, so the path is pinned deterministically here.
  it('impulse draw: library → exile → played, with no leak (history-aware, deterministic)', () => {
    __setDeterministicRng(mulberry32(4242))
    try {
      const { state } = makeGameN(2, FUZZ_DECK)
      const A = state.activePlayer
      const seen = new Map<PlayerId, Set<string>>(state.turnOrder.map((p) => [p, new Set<string>()]))
      toStep(state, 'main1')
      const impulse = putCard(state, A, 'Reckless Impulse', 'hand')
      assertNoLeaks(state, '(impulse setup)', seen)
      applyRulesAction(state, A, { type: 'r.mMana', color: 'R', delta: 1 })
      applyRulesAction(state, A, { type: 'r.mMana', color: 'C', delta: 1 })
      applyRulesAction(state, A, { type: 'r.cast', objId: impulse, targets: [] })
      until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the impulse resolves')
      const exiled = state.zones.perPlayer[A]!.exile.filter((id) => state.objects[id]!.playableBy === A)
      expect(exiled.length).toBe(2)
      assertNoLeaks(state, '(after exiling the top two)', seen)
      // play whichever of the two can be played right now. Float plenty of every colour first: which
      // cards the seeded shuffle exiles changes whenever FUZZ_DECK changes, so this must not depend on
      // the two cards' colours (an earlier version asserted a RED cast and broke on the next batch).
      for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as const) applyRulesAction(state, A, { type: 'r.mMana', color: c, delta: 6 })
      const legal = computeLegal(state, A)
      expect(legal.playableExileLandIds.length + legal.castExileIds.length).toBeGreaterThan(0)
      if (legal.playableExileLandIds.length) {
        applyRulesAction(state, A, { type: 'r.playLand', objId: legal.playableExileLandIds[0]! })
        expect(state.objects[legal.playableExileLandIds[0]!]!.zone).toBe('battlefield')
      } else {
        const id = legal.castExileIds[0]!
        // only an untargeted card is cast here (a targeted one needs a legal target picked)
        const def = getDef(state.objects[id]!.defName)
        if (!def.spell?.targets?.length && !def.modes?.length) {
          applyRulesAction(state, A, { type: 'r.cast', objId: id, targets: [] })
          until(state, (x) => !x.zones.stack.length, 'the exiled card resolves')
        }
      }
      assertNoLeaks(state, '(after playing from exile)', seen)
      // the window closes at the end of A's NEXT turn and the cards stay in exile
      const turn = state.turnNumber
      until(state, (s) => s.activePlayer === A && s.turnNumber > turn && s.step === 'main1', "A's next turn")
      // an id can VANISH here: a card played out of exile and later returned to a hidden zone is
      // re-minted (invariant #3), so `objects[id]` is gone — that is a pass, not a failure
      until(state, (s) => exiled.every((id) => !s.objects[id]?.playableUntil) || s.turnNumber > turn + 2, 'the window closing')
      for (const id of exiled) {
        if (state.objects[id]?.zone === 'exile') expect(state.objects[id]!.playableUntil).toBeUndefined()
      }
      assertNoLeaks(state, '(after the window closed)', seen)
    } finally {
      __setDeterministicRng(null)
    }
  })

  // Deterministic leak-fuzzer coverage for the new r.ward action (CLAUDE.md: new actions
  // need leak-fuzzer coverage). Ward's counter/payment touch only public zones (stack →
  // graveyard, pool), but this drives the pay path through the history-aware machinery.
  it('ward: pay-or-counter resolves with no leak (history-aware, deterministic)', () => {
    __setDeterministicRng(mulberry32(7007))
    try {
      const { state } = makeGameN(2, FUZZ_DECK)
      const A = state.activePlayer
      const B = state.turnOrder.find((p) => p !== A)!
      const seen = new Map<PlayerId, Set<string>>(state.turnOrder.map((p) => [p, new Set<string>()]))
      toStep(state, 'main1')
      const warded = putCard(state, B, 'Tomakul Honor Guard', 'battlefield') // 3/1 Ward {2}
      const shock = putCard(state, A, 'Shock', 'hand')
      applyRulesAction(state, A, { type: 'r.mMana', color: 'R', delta: 3 }) // {R} Shock + {2} ward
      assertNoLeaks(state, '(ward setup)', seen)
      applyRulesAction(state, A, { type: 'r.cast', objId: shock, targets: [warded] })
      // pass priority both ways → the ward trigger (top of stack) resolves → pending ward for A
      applyRulesAction(state, A, { type: 'r.pass' })
      applyRulesAction(state, B, { type: 'r.pass' })
      expect(state.pending?.kind).toBe('ward')
      assertNoLeaks(state, '(ward pending)', seen)
      applyRulesAction(state, A, { type: 'r.ward', pay: true })
      until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'Shock resolves after ward')
      expect(state.objects[warded]!.zone).toBe('graveyard') // ward paid → Shock resolves → 3/1 dies
      assertNoLeaks(state, '(ward after)', seen)
    } finally {
      __setDeterministicRng(null)
    }
  })

  // Deterministic leak-fuzzer coverage for cascade's leak-critical path: cards exiled from the
  // library are REVEALED (public), then the passed-over cards return to the bottom of the
  // library (hidden). They MUST be re-minted, or an opponent who saw them in exile could track
  // them in the hidden library (invariant #3). Declining sends ALL exiled cards to the bottom.
  it('cascade: exiled cards return to the bottom re-minted (history-aware, deterministic)', () => {
    __setDeterministicRng(mulberry32(4242))
    try {
      const { state } = makeGameN(2, FUZZ_DECK)
      const A = state.activePlayer
      const B = state.turnOrder.find((p) => p !== A)!
      const seen = new Map<PlayerId, Set<string>>(state.turnOrder.map((p) => [p, new Set<string>()]))
      rig(state, A, { hand: ['Bloodbraid Elf'], libraryTop: ['Mountain', 'Shock'], librarySize: 6 })
      until(state, (s) => s.step === 'main1' && s.priorityPlayer === A && !s.zones.stack.length, 'main1')
      applyRulesAction(state, A, { type: 'r.mMana', color: 'R', delta: 3 })
      applyRulesAction(state, A, { type: 'r.mMana', color: 'G', delta: 1 })
      const bbe = state.zones.perPlayer[A]!.hand.find((id) => getDef(state.objects[id]!.defName).name === 'Bloodbraid Elf')!
      applyRulesAction(state, A, { type: 'r.cast', objId: bbe, targets: [] })
      applyRulesAction(state, A, { type: 'r.pass' })
      applyRulesAction(state, B, { type: 'r.pass' }) // cascade trigger resolves → exile Mountain + Shock (hit)
      expect(state.pending?.kind).toBe('cascade')
      // both exiled cards are public in exile now — B has genuinely seen their ids
      assertNoLeaks(state, '(cascade exiled)', seen)
      const exiled = [...state.pendingCascade!.exiledIds]
      expect(exiled.some((id) => seen.get(B)!.has(id))).toBe(true)
      applyRulesAction(state, A, { type: 'r.cascade', cast: false, targets: [] }) // decline → all to the bottom
      until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'Bloodbraid resolves')
      // the once-revealed exile ids must be gone (re-minted); none may resurface in the hidden library
      for (const id of exiled) expect(state.objects[id]).toBeUndefined()
      assertNoLeaks(state, '(cascade after)', seen)
    } finally {
      __setDeterministicRng(null)
    }
  })
})
