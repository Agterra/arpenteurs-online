/**
 * Coverage batch MECH11: EVOKE (CR 702.74). Cast a creature for its cheaper evoke cost; it's
 * sacrificed as it enters, but its enters-the-battlefield triggers still resolve. Card: Mulldrifter
 * {4}{U} 2/2 flying, "When it enters, draw two cards. Evoke {2}{U}".
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('evoke — cast cheaper, sacrificed on enter, ETB still fires', () => {
  it('evoked Mulldrifter draws two cards, then is sacrificed to the graveyard', () => {
    const { state, A } = makeDuel()
    const mull = putCard(state, A, 'Mulldrifter', 'hand')
    toStep(state, 'main1')
    const lib0 = state.zones.perPlayer[A]!.library.length
    addMana(state, A, 'U', 3) // evoke cost {2}{U}
    act(state, A, { type: 'r.cast', objId: mull, evoke: true, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 - 2) // ETB drew two cards
    expect(state.objects[mull]!.zone).toBe('graveyard') // sacrificed on enter (evoke)
  })

  it('cast normally, Mulldrifter stays on the battlefield (and still draws two)', () => {
    const { state, A } = makeDuel()
    const mull = putCard(state, A, 'Mulldrifter', 'hand')
    toStep(state, 'main1')
    const lib0 = state.zones.perPlayer[A]!.library.length
    addMana(state, A, 'U', 5) // {4}{U}
    act(state, A, { type: 'r.cast', objId: mull, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 - 2)
    expect(state.objects[mull]!.zone).toBe('battlefield') // not sacrificed
  })
})
