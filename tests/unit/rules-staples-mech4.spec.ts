/**
 * Coverage batch MECH4: CONVOKE (CR 702.51). As you cast a convoke spell you may tap untapped
 * creatures you control; each pays for {1} or one mana of that creature's colours. Card: Siege
 * Wurm {4}{G}{G} 5/5 trample, convoke.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, who: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === who, 'resolve')

describe('convoke — tap creatures to help pay a spell', () => {
  it('two green creatures pay the {G}{G}, a red creature pays {1}; the rest comes from mana', () => {
    const { state, A } = makeDuel()
    const wurm = putCard(state, A, 'Siege Wurm', 'hand') // {4}{G}{G}
    const bear1 = putCard(state, A, 'Grizzly Bears', 'battlefield') // green
    const bear2 = putCard(state, A, 'Grizzly Bears', 'battlefield') // green
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield') // red
    toStep(state, 'main1')
    // convoke covers {G}{G} (two green creatures) + {1} (the red creature) → {3} left to pay
    addMana(state, A, 'G', 3)
    act(state, A, { type: 'r.cast', objId: wurm, convoke: [bear1, bear2, ogre], targets: [] })
    resolve(state, A)

    expect(state.objects[wurm]!.zone).toBe('battlefield')
    expect(state.objects[bear1]!.tapped).toBe(true)
    expect(state.objects[bear2]!.tapped).toBe(true)
    expect(state.objects[ogre]!.tapped).toBe(true)
    const pool = state.players[A]!.manaPool
    expect(pool.W + pool.U + pool.B + pool.R + pool.G + pool.C).toBe(0) // all 3 mana spent
  })

  it("cannot convoke a creature you don't control", () => {
    const { state, A, B } = makeDuel()
    const wurm = putCard(state, A, 'Siege Wurm', 'hand')
    const theirBear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 6) // could pay the whole cost, but the convoke list is illegal
    expect(() => act(state, A, { type: 'r.cast', objId: wurm, convoke: [theirBear], targets: [] })).toThrow()
  })
})
