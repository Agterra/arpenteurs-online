/**
 * Perpetual card coverage — batch CARD4: Feed the Swarm, Reanimate.
 * Both share the "lose life equal to a card's mana value" primitive (manaValueOf).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD4 — lose-life-equal-to-mana-value staples', () => {
  it("Feed the Swarm destroys an opponent's permanent and the caster loses life equal to its mana value", () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield') // {1}{G} → mana value 2
    const feed = putCard(state, A, 'Feed the Swarm', 'hand')
    toStep(state, 'main1')
    // can't target your own creature (opponent-controlled only)
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: feed, targets: [mine] })).toThrow()
    act(state, A, { type: 'r.cast', objId: feed, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard') // destroyed
    expect(state.players[A]!.life).toBe(38) // 40 − mana value 2
  })

  it('Reanimate puts a creature card from a graveyard onto the battlefield under your control and drains its mana value', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, B, 'Grizzly Bears', 'graveyard') // {1}{G} → mana value 2, owned by B
    const rean = putCard(state, A, 'Reanimate', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.cast', objId: rean, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('battlefield')
    expect(state.objects[bear]!.controllerId).toBe(A) // under the reanimator's control
    expect(state.objects[bear]!.ownerId).toBe(B) // owner unchanged
    expect(state.players[A]!.life).toBe(38) // 40 − mana value 2
  })
})
