/**
 * Coverage batch CYC: cycling (CR 702.29) — "[cost], Discard this card: Draw a card",
 * an activated ability usable only from the hand at INSTANT speed. Implemented as a
 * dedicated `r.cycle` action (so the battlefield-only r.activate core is untouched): the
 * mana cost is paid, the card is discarded (hand→graveyard) as the rest of the cost, and
 * a cycling ability goes on the stack whose resolution draws a card.
 *
 * Leak note: hand→graveyard is hidden→public. No re-mint is needed — the hand id was
 * never serialised to opponents (hands are count-only), so revealing it in the public
 * graveyard leaks nothing; the drawn card (library→hand) stays hidden.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'
import { redactRulesState, computeLegal } from '../../server/rules/redact.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')

describe('cycling — discard the card as a cost, then draw', () => {
  it('discards immediately (cost), puts an ability on the stack, and draws on resolution', () => {
    const { state, A } = makeDuel()
    const moor = putCard(state, A, 'Barren Moor', 'hand') // Cycling {B}
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    const libBefore = state.zones.perPlayer[A]!.library.length
    const handBefore = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cycle', objId: moor })
    // the card is discarded as a cost immediately; the draw waits on the stack
    expect(state.zones.perPlayer[A]!.graveyard.includes(moor)).toBe(true)
    expect(state.zones.perPlayer[A]!.hand.includes(moor)).toBe(false)
    expect(state.zones.stack.length).toBe(1)
    resolve(state, A)
    // drew exactly one: library −1, hand net unchanged (−1 cycled, +1 drawn)
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore - 1)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore)
    expect(state.players[A]!.manaPool.B).toBe(0) // the {B} was spent
  })

  it('rejects cycling with no mana to pay the cost', () => {
    const { state, A } = makeDuel()
    const moor = putCard(state, A, 'Barren Moor', 'hand')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.cycle', objId: moor })).toThrow()
    // nothing changed — still in hand, no stack item
    expect(state.zones.perPlayer[A]!.hand.includes(moor)).toBe(true)
    expect(state.zones.stack.length).toBe(0)
  })

  it('rejects cycling a card that has no cycling ability', () => {
    const { state, A } = makeDuel()
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 3)
    expect(() => act(state, A, { type: 'r.cycle', objId: bolt })).toThrow()
  })
})

describe('cycling is instant speed (not gated on the main phase)', () => {
  it('is offered by computeLegal during a combat step when affordable', () => {
    const { state, A } = makeDuel()
    const moor = putCard(state, A, 'Barren Moor', 'hand')
    toStep(state, 'begin_combat')
    addMana(state, A, 'B', 1)
    const legal = computeLegal(state, A)
    expect(legal.cyclable.some((c) => c.objId === moor && c.cost === '{B}')).toBe(true)
  })
})

describe('cycling — hidden-information safety', () => {
  it('reveals the cycled card in the public graveyard but leaks no hand/library ids', () => {
    const { state, A, B } = makeDuel()
    const moor = putCard(state, A, 'Barren Moor', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.cycle', objId: moor })
    resolve(state, A)
    const bJson = JSON.stringify(redactRulesState(state, B))
    // the cycled card is public in A's graveyard...
    expect(bJson.includes(moor)).toBe(true)
    // ...but A's remaining hidden hand + library never leak to B (incl. the drawn card)
    for (const id of state.zones.perPlayer[A]!.library) expect(bJson.includes(id)).toBe(false)
    for (const id of state.zones.perPlayer[A]!.hand) expect(bJson.includes(id)).toBe(false)
  })
})
