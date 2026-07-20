/**
 * Coverage batch MECH9: BUYBACK (CR 702.27). Paying the optional buyback cost as you cast a spell
 * returns it to your hand instead of the graveyard when it resolves — so it can be cast again.
 * Card: Capsize {1}{U}{U} — return target permanent to its owner's hand, Buyback {3}.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const handHas = (s: St, p: PlayerId, name: string) =>
  s.zones.perPlayer[p]!.hand.some((id) => getDef(s.objects[id]!.defName).name === name)

describe('buyback — return to hand on resolve when the buyback cost is paid', () => {
  it('without buyback, Capsize bounces a permanent and goes to the graveyard', () => {
    const { state, A, B } = makeDuel()
    const cap = putCard(state, A, 'Capsize', 'hand')
    putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 3) // {1}{U}{U}
    act(state, A, { type: 'r.cast', objId: cap, targets: [state.zones.perPlayer[B]!.battlefield[0]!] })
    resolve(state, A)
    expect(state.zones.perPlayer[B]!.battlefield.length).toBe(0) // bounced
    expect(state.objects[cap]!.zone).toBe('graveyard') // no buyback → graveyard
  })

  it('with buyback, Capsize bounces a permanent and returns to hand (re-minted, reusable)', () => {
    const { state, A, B } = makeDuel()
    const cap = putCard(state, A, 'Capsize', 'hand')
    putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 6) // {1}{U}{U} + {3} buyback
    act(state, A, { type: 'r.cast', objId: cap, targets: [state.zones.perPlayer[B]!.battlefield[0]!], buyback: true })
    resolve(state, A)
    expect(state.zones.perPlayer[B]!.battlefield.length).toBe(0) // still bounced
    expect(state.objects[cap]).toBeUndefined() // old stack id was re-minted on entering the hand
    expect(handHas(state, A, 'Capsize')).toBe(true) // returned to hand — castable again
  })
})
