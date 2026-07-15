/**
 * Coverage batch KIK: kicker (CR 702.33) — an OPTIONAL additional mana cost chosen as the
 * spell is cast; if paid, the spell is "kicked" and its effect (reading ctx.kicked) does
 * more/different. Threaded r.cast.kicked → StackItem.kicked → EffectContext.kicked.
 *   - Burst Lightning {R}, Kicker {4}: 2 damage to any target, 4 if kicked.
 *   - Marsh Casualties {B}{B}, Kicker {3}: target player's creatures get -1/-1 (or -2/-2).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, putFallback, toStep, until } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'
import { currentPower, currentToughness } from '../../server/rules/characteristics.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')

describe('Burst Lightning {R} (Kicker {4}) — 2 damage, or 4 if kicked', () => {
  it('deals 2 damage when cast without the kicker', () => {
    const { state, A, B } = makeDuel()
    const bl = putCard(state, A, 'Burst Lightning', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    const life0 = state.players[B]!.life
    act(state, A, { type: 'r.cast', objId: bl, targets: [B] })
    resolve(state, A)
    expect(state.players[B]!.life).toBe(life0 - 2)
  })

  it('deals 4 damage when kicked (and consumes the extra {4})', () => {
    const { state, A, B } = makeDuel()
    const bl = putCard(state, A, 'Burst Lightning', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 5) // {R} + {4}
    const life0 = state.players[B]!.life
    act(state, A, { type: 'r.cast', objId: bl, targets: [B], kicked: true })
    resolve(state, A)
    expect(state.players[B]!.life).toBe(life0 - 4)
    // all five red were spent (1 base + 4 kicker)
    expect(state.players[A]!.manaPool.R).toBe(0)
  })

  it('rejects kicking when the extra mana is not available', () => {
    const { state, A, B } = makeDuel()
    const bl = putCard(state, A, 'Burst Lightning', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1) // only the base {R}, not the {4} kicker
    expect(() => act(state, A, { type: 'r.cast', objId: bl, targets: [B], kicked: true })).toThrow()
    // nothing happened — still in hand, mana untouched
    expect(state.zones.perPlayer[A]!.hand.includes(bl)).toBe(true)
    expect(state.players[A]!.manaPool.R).toBe(1)
  })

  it('rejects kicked on a spell that has no kicker', () => {
    const { state, A, B } = makeDuel()
    const shock = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 5)
    expect(() => act(state, A, { type: 'r.cast', objId: shock, targets: [B], kicked: true })).toThrow()
  })
})

describe('Marsh Casualties {B}{B} (Kicker {3}) — -1/-1, or -2/-2 if kicked', () => {
  it('gives a target player\'s creatures -1/-1 without the kicker', () => {
    const { state, A, B } = makeDuel()
    const gb = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2
    const mc = putCard(state, A, 'Marsh Casualties', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    act(state, A, { type: 'r.cast', objId: mc, targets: [B] })
    resolve(state, A)
    // 2/2 → 1/1, survives
    expect(state.objects[gb]!.zone).toBe('battlefield')
    expect(currentPower(state, state.objects[gb]!)).toBe(1)
    expect(currentToughness(state, state.objects[gb]!)).toBe(1)
  })

  it('gives -2/-2 when kicked (killing a 2/2 via SBA)', () => {
    const { state, A, B } = makeDuel()
    const gb = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2
    const mc = putCard(state, A, 'Marsh Casualties', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    addMana(state, A, 'R', 3) // the {3} kicker (generic)
    act(state, A, { type: 'r.cast', objId: mc, targets: [B], kicked: true })
    resolve(state, A)
    // 2/2 → 0/0, dies as a state-based action
    expect(state.objects[gb]!.zone).toBe('graveyard')
  })

  // Assisted-table consistency (folded in from the review): a mass -N/-N must skip
  // UNIMPLEMENTED (fallback) creatures, like the other mass-creature effects — the engine
  // never auto-modifies a card whose rules it can't run; those are hand-run.
  it('does not modify an unimplemented (assisted-table) creature', () => {
    const { state, A, B } = makeDuel()
    const fb = putFallback(
      state,
      B,
      { name: 'Mystery Behemoth', typeLine: 'Creature — Beast', manaCost: '{4}{G}', power: '2', toughness: '2' },
      'battlefield',
    )
    const mc = putCard(state, A, 'Marsh Casualties', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    addMana(state, A, 'R', 3)
    act(state, A, { type: 'r.cast', objId: mc, targets: [B], kicked: true })
    resolve(state, A)
    // untouched: still a 2/2 on the battlefield (hand-run, not auto-weakened)
    expect(state.objects[fb]!.zone).toBe('battlefield')
    expect(currentToughness(state, state.objects[fb]!)).toBe(2)
    expect(currentPower(state, state.objects[fb]!)).toBe(2)
  })
})
