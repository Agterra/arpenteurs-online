/**
 * Coverage batch DSC: forced discard (Mind Rot / "target opponent discards").
 * A spell/ability makes a player discard N cards of THEIR OWN choice — new
 * `pending: 'discard'` variant driven by `pendingDiscard` (distinct from the
 * cleanup discard, which uses hand−7). Reuses the existing discard client UI.
 * Discarding is hand→graveyard (hidden→public, the discarded card is revealed);
 * the player's other hand cards stay hidden — a focused check confirms no leak.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor } from '../../shared/rules/types.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = ReturnType<typeof makeDuel>['state']
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })

describe('Mind Rot — target player discards two cards (their choice)', () => {
  it('opens a discard-2 prompt on the target, who picks which cards to pitch', () => {
    const { state, A, B } = makeDuel()
    const mr = putCard(state, A, 'Mind Rot', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 3)
    act(state, A, { type: 'r.cast', objId: mr, targets: [B] })
    until(state, (s) => s.pending?.kind === 'discard' && s.pending.player === B, 'B must discard 2')

    expect(redactRulesState(state, B).legal.discardCount).toBe(2)
    expect(redactRulesState(state, A).legal.needsDiscard).toBe(false) // only the victim is prompted
    const bHand = [...state.zones.perPlayer[B]!.hand]
    // leak check: A's view carries no id of B's hand
    const aJson = JSON.stringify(redactRulesState(state, A))
    for (const id of bHand) expect(aJson.includes(id)).toBe(false)

    act(state, B, { type: 'r.discard', objIds: bHand.slice(0, 2) })
    until(state, (s) => s.priorityPlayer === A && !s.zones.stack.length, 'Mind Rot resolves')
    expect(state.zones.perPlayer[B]!.hand.length).toBe(bHand.length - 2)
    expect(state.objects[bHand[0]!]!.zone).toBe('graveyard')
    expect(() => act(state, B, { type: 'r.discard', objIds: [] })).toThrow() // no longer pending
  })
})

describe('Ravenous Rats — ETB: target opponent discards a card', () => {
  it('makes only an opponent discard (never yourself)', () => {
    const { state, A, B } = makeDuel()
    const rats = putCard(state, A, 'Ravenous Rats', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    act(state, A, { type: 'r.cast', objId: rats, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'A chooses the ETB target')
    // the target must be an opponent — choosing yourself is illegal
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [A] })).toThrow()
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    until(state, (s) => s.pending?.kind === 'discard' && s.pending.player === B, 'B discards 1')
    const bHand = [...state.zones.perPlayer[B]!.hand]
    act(state, B, { type: 'r.discard', objIds: [bHand[0]!] })
    expect(state.zones.perPlayer[B]!.hand.length).toBe(bHand.length - 1)
  })

  // regression (adversarial review): the test-helper auto-answer must satisfy a
  // player-target trigger (Ravenous Rats' opponent ETB), not feed it a creature id
  it('the until()/toStep helper auto-advances past a player-target ETB trigger', () => {
    const { state, A, B } = makeDuel()
    const rats = putCard(state, A, 'Ravenous Rats', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    const bHand = state.zones.perPlayer[B]!.hand.length
    act(state, A, { type: 'r.cast', objId: rats, targets: [] })
    toStep(state, 'main2') // auto-chooses the opponent + auto-discards — must not throw
    expect(state.zones.perPlayer[B]!.hand.length).toBe(bHand - 1)
  })
})
