/**
 * Coverage batch MECH8: RETRACE (CR 702.81). You may cast a card from your graveyard by paying its
 * normal cost PLUS discarding a land card. Unlike flashback, it is NOT exiled — it returns to the
 * graveyard on resolution and can be retraced again. Card: Raven's Crime {B} — target player
 * discards a card, Retrace.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const forceOppDiscard = (s: St, B: PlayerId) => {
  until(s, (x) => x.pending?.kind === 'discard' && x.pending.player === B, 'opponent discards')
  act(s, B, { type: 'r.discard', objIds: [s.zones.perPlayer[B]!.hand[0]!] })
}
const settle = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && !x.pending && x.priorityPlayer === A, 'settle')

describe('retrace — recast from the graveyard by discarding a land', () => {
  it("Raven's Crime is cast, then retraced from the graveyard (discarding a land), and is reusable", () => {
    const { state, A, B } = makeDuel()
    const rc = putCard(state, A, "Raven's Crime", 'hand')
    toStep(state, 'main1')

    // normal cast from hand: B discards, Raven's Crime → graveyard
    addMana(state, A, 'B', 1)
    const bHand0 = state.zones.perPlayer[B]!.hand.length
    act(state, A, { type: 'r.cast', objId: rc, targets: [B] })
    forceOppDiscard(state, B)
    settle(state, A)
    expect(state.objects[rc]!.zone).toBe('graveyard')
    expect(state.zones.perPlayer[B]!.hand.length).toBe(bHand0 - 1)

    // retrace from the graveyard: pay {B} + discard a land; B discards again; card stays reusable
    const land = putCard(state, A, 'Mountain', 'hand')
    addMana(state, A, 'B', 1)
    const bHand1 = state.zones.perPlayer[B]!.hand.length
    act(state, A, { type: 'r.cast', objId: rc, targets: [B], retraceLand: land })
    forceOppDiscard(state, B)
    settle(state, A)
    expect(state.objects[land]!.zone).toBe('graveyard') // land discarded as the retrace cost
    expect(state.objects[rc]!.zone).toBe('graveyard') // NOT exiled — retrace is reusable
    expect(state.zones.perPlayer[B]!.hand.length).toBe(bHand1 - 1)
  })

  it('retrace requires actually discarding a land card', () => {
    const { state, A, B } = makeDuel()
    const rc = putCard(state, A, "Raven's Crime", 'graveyard')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: rc, targets: [B] })).toThrow() // no land given
  })
})
