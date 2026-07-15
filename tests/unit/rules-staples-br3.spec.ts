/**
 * Coverage batch BR3: Cloudkin Seer {2}{U} 2/1 flying with an ETB "draw a card" — a cantrip
 * flyer via the existing ETB-draw primitive (drawCards(1)). (The other iconic bodies this
 * batch first drafted — Serra Angel / Vampire Nighthawk / Colossal Dreadmaw — already existed
 * in the pool; the review caught the duplication and they were dropped.)
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'
import { currentKeywords } from '../../server/rules/characteristics.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })

describe('Cloudkin Seer {2}{U} 2/1 flying — ETB draw a card', () => {
  it('draws one card when it enters, and flies', () => {
    const { state, A } = makeDuel()
    const cs = putCard(state, A, 'Cloudkin Seer', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 3)
    const lib0 = state.zones.perPlayer[A]!.library.length
    act(state, A, { type: 'r.cast', objId: cs, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 - 1) // ETB drew one
    expect(state.objects[cs]!.zone).toBe('battlefield')
    expect(currentKeywords(state, state.objects[cs]!)).toContain('flying')
  })
})
