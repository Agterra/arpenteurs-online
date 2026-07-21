/**
 * Coverage batch MECH14: MADNESS (CR 702.35). When a madness card is discarded, it's exiled and its
 * owner may cast it for the madness cost; if not, it goes to the graveyard. Card: Fiery Temper
 * {1}{R}{R} — 3 damage to any target, Madness {R}.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { openDiscard } from '../../server/rules/engine.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('madness — discard opens a cast-for-madness-cost window', () => {
  it('cast for the madness cost when discarded (deals 3), then to the graveyard', () => {
    const { state, A, B } = makeDuel()
    const ft = putCard(state, A, 'Fiery Temper', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1) // madness cost {R}
    openDiscard(state, [A], 1) // force A to discard a card
    act(state, A, { type: 'r.discard', objIds: [ft] })
    expect(state.pending?.kind).toBe('madness') // window opened
    expect(state.objects[ft]!.zone).toBe('exile') // exiled, not graveyard

    act(state, A, { type: 'r.madness', cast: true, targets: [B] })
    resolve(state, A)
    expect(state.players[B]!.life).toBe(37) // 3 damage
    expect(state.objects[ft]!.zone).toBe('graveyard') // resolved to the graveyard
  })

  it('declining sends the discarded madness card to the graveyard', () => {
    const { state, A } = makeDuel()
    const ft = putCard(state, A, 'Fiery Temper', 'hand')
    toStep(state, 'main1')
    openDiscard(state, [A], 1)
    act(state, A, { type: 'r.discard', objIds: [ft] })
    act(state, A, { type: 'r.madness', cast: false, targets: [] })
    expect(state.objects[ft]!.zone).toBe('graveyard')
    expect(state.pending).toBeNull()
  })
})
