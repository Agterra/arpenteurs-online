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
          expect(json.includes(id), `${pid} hand id ${id} leaked to ${viewer} ${context}`).toBe(false)
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

/** One random-but-legal action for whoever must act; returns false when stuck. */
function randomAction(state: RulesGameState, rnd: () => number): boolean {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!

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
      // randomly bottom some of the peeked cards (exercises scry + library re-mint)
      const toBottom = state.pendingScry.cardIds.filter(() => rnd() < 0.5)
      applyRulesAction(state, p, { type: 'r.scry', toBottom })
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
      const players = state.turnOrder.filter((x) => !state.players[x]!.hasLost)
      const onField = Object.values(state.objects).filter((o) => o.zone === 'battlefield')
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
      const cardIds = ps.matchIds.filter(() => rnd() < 0.5).slice(0, ps.count)
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
    const hand = state.zones.perPlayer[p]!.hand
    applyRulesAction(state, p, { type: 'r.discard', objIds: hand.slice(0, hand.length - 7) })
    return true
  }

  const actor = state.priorityPlayer
  if (!actor) return false
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
        applyRulesAction(state, actor, colors.length ? { type: 'r.tapMana', objId: src, color: pick(colors) } : { type: 'r.tapMana', objId: src })
      }
      try {
        applyRulesAction(state, actor, { type: 'r.foretell', objId: pick(foretellable) })
      } catch { /* not enough mana — the taps above still count as this step's action */ }
      return true
    }
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
        applyRulesAction(state, actor, colors.length ? { type: 'r.tapMana', objId: src, color: pick(colors) } : { type: 'r.tapMana', objId: src })
      }
      try { applyRulesAction(state, actor, { type: 'r.morph', objId: faceUp.id }) } catch { /* can't pay */ }
      return true
    }
    if (morphInHand.length) {
      for (const src of legal.manaSourceIds) {
        if (Object.values(state.players[actor]!.manaPool).reduce((x, y) => x + y, 0) >= 3) break
        const colors = legal.manaSourceColors[src] ?? []
        applyRulesAction(state, actor, colors.length ? { type: 'r.tapMana', objId: src, color: pick(colors) } : { type: 'r.tapMana', objId: src })
      }
      try { applyRulesAction(state, actor, { type: 'r.cast', objId: pick(morphInHand), faceDown: true, targets: [] }) } catch { /* can't pay */ }
      return true
    }
  }

  // occasionally use an activated ability (exercises r.activate incl. sacrifice costs)
  if (legal.activations.length && rnd() < 0.3) {
    const a = pick(legal.activations)
    // pay any mana part by tapping sources (best-effort; passing is the fallback)
    const need = (a.cost.match(/\{/g) ?? []).length
    for (const src of legal.manaSourceIds) {
      const pool = state.players[actor]!.manaPool
      if (Object.values(pool).reduce((x, y) => x + y, 0) >= need) break
      const colors = legal.manaSourceColors[src] ?? []
      applyRulesAction(state, actor, colors.length ? { type: 'r.tapMana', objId: src, color: pick(colors) } : { type: 'r.tapMana', objId: src })
    }
    const myCreatures = Object.values(state.objects)
      .filter((o) => o.zone === 'battlefield' && o.controllerId === actor && getDef(o.defName).types.includes('Creature'))
      .map((o) => o.id)
    const sacrifices = a.sacCost > 0 ? myCreatures.slice(0, a.sacCost) : []
    if (a.sacCost > 0 && sacrifices.length < a.sacCost) return tryPass() // can't pay the cost
    const targets: (ObjId | PlayerId)[] = []
    if (a.targetKind) {
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
      applyRulesAction(state, actor, colors.length ? { type: 'r.tapMana', objId: src, color: pick(colors) } : { type: 'r.tapMana', objId: src })
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
    const modeIdx = def.modes?.length ? Math.floor(rnd() * def.modes.length) : undefined
    const specs = def.modes?.length ? (def.modes[modeIdx!]!.targets ?? []) : (def.spell?.targets ?? [])
    // X spell: pick a small affordable X (0..2); mana needed = base pips + x·(#{X})
    const xCount = (def.manaCost?.match(/\{X\}/g) ?? []).length
    const x = xCount > 0 ? Math.floor(rnd() * 3) : undefined
    const basePips = (def.manaCost?.replace(/\{X\}/g, '').match(/\{/g) ?? []).length
    const need = basePips + (x ?? 0) * xCount
    for (const src of legal.manaSourceIds) {
      const pool = state.players[actor]!.manaPool
      if (Object.values(pool).reduce((a, b) => a + b, 0) >= need) break
      const colors = legal.manaSourceColors[src] ?? []
      applyRulesAction(state, actor, colors.length ? { type: 'r.tapMana', objId: src, color: pick(colors) } : { type: 'r.tapMana', objId: src })
    }
    const targets: (ObjId | PlayerId)[] = []
    for (const spec of specs) {
      for (let i = 0; i < spec.count; i++) {
        const creatures = Object.values(state.objects)
          .filter((o) => o.zone === 'battlefield' && getDef(o.defName).types.includes('Creature'))
          .map((o) => o.id)
        const perms = Object.values(state.objects).filter((o) => o.zone === 'battlefield').map((o) => o.id)
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
        const cands =
          spec.kind === 'creature'
            ? creatures
            : spec.kind === 'permanent'
              ? perms
              : spec.kind === 'player'
                ? players
                : spec.kind === 'graveyardCard'
                  ? graveyardCards
                  : [...creatures, ...players]
        if (!cands.length) return tryPass()
        targets.push(pick(cands))
      }
    }
    try {
      applyRulesAction(state, actor, { type: 'r.cast', objId, targets, x, mode: modeIdx })
    } catch {
      return tryPass() // e.g. pool short after random taps, or illegal modal target — passing is always legal
    }
    return true
  }
  if (roll < 0.55 && legal.manaSourceIds.length) {
    const src = pick(legal.manaSourceIds)
    const colors = legal.manaSourceColors[src] ?? []
    applyRulesAction(state, actor, colors.length ? { type: 'r.tapMana', objId: src, color: pick(colors) } : { type: 'r.tapMana', objId: src })
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
