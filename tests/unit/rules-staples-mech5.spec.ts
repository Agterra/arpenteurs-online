/**
 * Coverage batch MECH5: MONSTROSITY (CR 701.31) + ADAPT (CR 701.44) — activated abilities that put
 * +1/+1 counters on a creature ONCE. Adapt does nothing if the creature already has +1/+1 counters;
 * monstrosity does nothing if the creature is already monstrous. Cards: Aerie Bowmasters {3}{G} 3/3
 * reach ("{5}{G}: Adapt 2") and Nessian Asp {4}{G} 4/5 reach ("{6}{G}: Monstrosity 4").
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, who: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === who, 'resolve')

describe('adapt — puts +1/+1 counters only if the creature has none', () => {
  it('Aerie Bowmasters adapts 2 once; a second activation does nothing (it has counters)', () => {
    const { state, A } = makeDuel()
    const bow = putCard(state, A, 'Aerie Bowmasters', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 6) // {5}{G}
    act(state, A, { type: 'r.activate', objId: bow, abilityIndex: 0, targets: [] })
    resolve(state, A)
    expect(state.objects[bow]!.counters['+1/+1']).toBe(2)

    addMana(state, A, 'G', 6)
    act(state, A, { type: 'r.activate', objId: bow, abilityIndex: 0, targets: [] })
    resolve(state, A)
    expect(state.objects[bow]!.counters['+1/+1']).toBe(2) // unchanged — adapt no-ops with counters present
  })
})

describe('monstrosity — becomes monstrous once', () => {
  it('Nessian Asp becomes monstrous (+4/+4); a second activation does nothing', () => {
    const { state, A } = makeDuel()
    const asp = putCard(state, A, 'Nessian Asp', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 7) // {6}{G}
    act(state, A, { type: 'r.activate', objId: asp, abilityIndex: 0, targets: [] })
    resolve(state, A)
    expect(state.objects[asp]!.counters['+1/+1']).toBe(4)
    expect(state.objects[asp]!.monstrous).toBe(true)

    addMana(state, A, 'G', 7)
    act(state, A, { type: 'r.activate', objId: asp, abilityIndex: 0, targets: [] })
    resolve(state, A)
    expect(state.objects[asp]!.counters['+1/+1']).toBe(4) // unchanged — already monstrous
  })
})
