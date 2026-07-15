/**
 * Coverage batch KW3: shroud (CR 702.18 — can't be targeted by anyone) + prowess (CR 702.108 —
 * "whenever you cast a noncreature spell, +1/+1 until end of turn").
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'
import { currentPower, currentToughness } from '../../server/rules/characteristics.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })

describe('shroud — can\'t be targeted by anyone', () => {
  it('an opponent cannot target a shroud creature', () => {
    const { state, A, B } = makeDuel()
    const lookout = putCard(state, B, 'Elvish Lookout', 'battlefield') // shroud
    const shock = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: shock, targets: [lookout] })).toThrow()
  })
  it('even the controller cannot target their own shroud creature (unlike hexproof)', () => {
    const { state, A } = makeDuel()
    const mine = putCard(state, A, 'Elvish Lookout', 'battlefield')
    const gg = putCard(state, A, 'Giant Growth', 'hand') // your own pump
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: gg, targets: [mine] })).toThrow()
  })
})

describe('prowess — pump on casting a noncreature spell', () => {
  it('a noncreature spell gives your prowess creatures +1/+1', () => {
    const { state, A, B } = makeDuel()
    const swift = putCard(state, A, 'Monastery Swiftspear', 'battlefield') // 1/2 haste + prowess
    const shock = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [B] }) // noncreature spell → prowess pumps at cast
    expect(currentPower(state, state.objects[swift]!)).toBe(2)
    expect(currentToughness(state, state.objects[swift]!)).toBe(3)
  })
  it('a creature spell does NOT trigger prowess', () => {
    const { state, A } = makeDuel()
    const swift = putCard(state, A, 'Monastery Swiftspear', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] }) // creature spell → no prowess
    expect(currentPower(state, state.objects[swift]!)).toBe(1)
    expect(currentToughness(state, state.objects[swift]!)).toBe(2)
  })
})
