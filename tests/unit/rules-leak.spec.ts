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
import { getDef } from '../../server/rules/cards/registry.ts'
import { makeGameN } from './rules-helpers.ts'
import { mulberry32 } from './engine-helpers.ts'

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

/** One random-but-legal action for whoever must act; returns false when stuck. */
function randomAction(state: RulesGameState, rnd: () => number): boolean {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!

  if (state.pending) {
    const p = state.pending.player
    const legal = computeLegal(state, p)
    if (state.pending.kind === 'attackers') {
      const foes = legal.attackablePlayerIds
      const attacks = foes.length
        ? legal.declarableAttackerIds
            .filter(() => rnd() < 0.6)
            .map((attackerId) => ({ attackerId, defenderId: pick(foes) }))
        : []
      applyRulesAction(state, p, { type: 'r.attackers', attacks })
      return true
    }
    if (state.pending.kind === 'blockers') {
      const attackers = Object.values(state.objects).filter((o) => o.attackingDefender === p)
      const blocks = legal.declarableBlockerIds
        .filter(() => rnd() < 0.5)
        .map((blockerId) => ({ blockerId, attackerId: pick(attackers).id }))
      applyRulesAction(state, p, { type: 'r.blockers', blocks: attackers.length ? blocks : [] })
      return true
    }
    if (state.pending.kind === 'scry' && state.pendingScry) {
      // randomly bottom some of the peeked cards (exercises scry + library re-mint)
      const toBottom = state.pendingScry.cardIds.filter(() => rnd() < 0.5)
      applyRulesAction(state, p, { type: 'r.scry', toBottom })
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

  const roll = rnd()

  if (roll < 0.25 && legal.playableLandIds.length) {
    applyRulesAction(state, actor, { type: 'r.playLand', objId: pick(legal.playableLandIds) })
    return true
  }
  if (roll < 0.5 && legal.castableIds.length) {
    const objId = pick(legal.castableIds)
    const def = getDef(state.objects[objId]!.defName)
    // pay: tap sources until the pool covers (legal.castableIds guarantees potential)
    const need = (def.manaCost?.match(/\{/g) ?? []).length
    for (const src of legal.manaSourceIds) {
      const pool = state.players[actor]!.manaPool
      if (Object.values(pool).reduce((a, b) => a + b, 0) >= need) break
      const colors = legal.manaSourceColors[src] ?? []
      applyRulesAction(state, actor, colors.length ? { type: 'r.tapMana', objId: src, color: pick(colors) } : { type: 'r.tapMana', objId: src })
    }
    const specs = def.spell?.targets ?? []
    const targets: (ObjId | PlayerId)[] = []
    for (const spec of specs) {
      for (let i = 0; i < spec.count; i++) {
        const creatures = Object.values(state.objects)
          .filter((o) => o.zone === 'battlefield' && getDef(o.defName).types.includes('Creature'))
          .map((o) => o.id)
        const players = state.turnOrder.filter((p) => !state.players[p]!.hasLost)
        const cands =
          spec.kind === 'creature' ? creatures : spec.kind === 'player' ? players : [...creatures, ...players]
        if (!cands.length) return tryPass()
        targets.push(pick(cands))
      }
    }
    try {
      applyRulesAction(state, actor, { type: 'r.cast', objId, targets })
    } catch {
      return tryPass() // e.g. pool short after random taps — passing is always legal
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
  ...Array(20).fill('Mountain'),
  ...Array(14).fill('Swamp'),
  ...Array(4).fill('Temple of Malice'),
  ...Array(4).fill('Solemn Simulacrum'),
  ...Array(4).fill('Fleshbag Marauder'),
  ...Array(4).fill('Diabolic Edict'),
  ...Array(4).fill('Viscera Seer'),
  ...Array(6).fill('Shock'),
  ...Array(6).fill('Lightning Bolt'),
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
    for (const [nPlayers, seed] of cases) {
      const rnd = mulberry32(seed)
      const { state } = makeGameN(nPlayers, FUZZ_DECK)
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
  }, 180_000)
})
