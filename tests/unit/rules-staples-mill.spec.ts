/**
 * Coverage batch MILL: mill (top of a library → its graveyard). Library → graveyard
 * is hidden → public: the milled cards are legitimately revealed (public zone) with
 * no re-mint; the REST of the library stays hidden — a focused leak check confirms
 * an opponent's view never carries the un-milled library ids.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor } from '../../shared/rules/types.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = ReturnType<typeof makeDuel>['state']
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')

describe('Tome Scour — target player mills five', () => {
  it('moves the top 5 to the graveyard and does not leak the rest of the library', () => {
    const { state, A, B } = makeDuel()
    const ts = putCard(state, A, 'Tome Scour', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    const lib0 = state.zones.perPlayer[B]!.library.length
    act(state, A, { type: 'r.cast', objId: ts, targets: [B] })
    resolve(state, A)
    expect(state.zones.perPlayer[B]!.graveyard.length).toBe(5)
    expect(state.zones.perPlayer[B]!.library.length).toBe(lib0 - 5)
    // leak: A's view carries none of B's REMAINING (hidden) library ids
    const aJson = JSON.stringify(redactRulesState(state, A))
    for (const id of state.zones.perPlayer[B]!.library) expect(aJson.includes(id)).toBe(false)
  })
})

describe('Thought Scour — mill two, then draw', () => {
  it('mills the target and draws for the caster', () => {
    const { state, A, B } = makeDuel()
    const sc = putCard(state, A, 'Thought Scour', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    const aHand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cast', objId: sc, targets: [B] })
    resolve(state, A)
    expect(state.zones.perPlayer[B]!.graveyard.length).toBe(2)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(aHand - 1 + 1) // Thought Scour left hand, drew 1
  })
})

describe('Mind Sculpt — target opponent (never yourself)', () => {
  it('rejects targeting yourself', () => {
    const { state, A } = makeDuel()
    const ms = putCard(state, A, 'Mind Sculpt', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 2)
    expect(() => act(state, A, { type: 'r.cast', objId: ms, targets: [A] })).toThrow()
  })
})
