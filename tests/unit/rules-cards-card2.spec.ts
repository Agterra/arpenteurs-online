/**
 * Perpetual card coverage — batch CARD2: Birds of Paradise, Sign in Blood, Faithless Looting.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD2 — staple cards', () => {
  it('Sign in Blood makes the target player draw two and lose 2 life', () => {
    const { state, A, B } = makeDuel()
    const sib = putCard(state, A, 'Sign in Blood', 'hand')
    toStep(state, 'main1')
    const bLib = state.zones.perPlayer[B]!.library.length
    addMana(state, A, 'B', 2)
    act(state, A, { type: 'r.cast', objId: sib, targets: [B] })
    resolve(state, A)
    expect(state.zones.perPlayer[B]!.library.length).toBe(bLib - 2)
    expect(state.players[B]!.life).toBe(38)
  })

  it('Faithless Looting draws two then discards two', () => {
    const { state, A } = makeDuel()
    const fl = putCard(state, A, 'Faithless Looting', 'hand')
    toStep(state, 'main1')
    const lib0 = state.zones.perPlayer[A]!.library.length
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: fl, targets: [] })
    until(state, (s) => s.pending?.kind === 'discard' && s.pending.player === A, 'discard 2')
    act(state, A, { type: 'r.discard', objIds: state.zones.perPlayer[A]!.hand.slice(0, 2) })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 - 2) // drew two
    expect(state.objects[fl]!.zone).toBe('graveyard')
  })
})
