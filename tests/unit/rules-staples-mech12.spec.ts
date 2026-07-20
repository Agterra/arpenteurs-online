/**
 * Coverage batch MECH12: ESCAPE (CR 702.139). Cast a card from your graveyard by paying the escape
 * cost AND exiling N other cards from your graveyard. Unlike flashback it is NOT self-exiled — it
 * resolves normally and can be escaped again. Card: Woe Strider {1}{B} 3/2 (ETB Goat token;
 * "Sacrifice a creature: Scry 1"; Escape—{3}{B}, exile four other cards).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('escape — recast from the graveyard by exiling other cards', () => {
  it('Woe Strider escapes: exiles four graveyard cards, enters (ETB Goat), and is not self-exiled', () => {
    const { state, A } = makeDuel()
    const woe = putCard(state, A, 'Woe Strider', 'graveyard')
    const fodder = [0, 1, 2, 3].map(() => putCard(state, A, 'Mountain', 'graveyard'))
    toStep(state, 'main1')
    addMana(state, A, 'B', 4) // escape cost {3}{B}
    act(state, A, { type: 'r.cast', objId: woe, targets: [], escapeExile: fodder })
    resolve(state, A)

    expect(state.objects[woe]!.zone).toBe('battlefield') // entered as a creature, NOT exiled
    for (const id of fodder) expect(state.objects[id]!.zone).toBe('exile') // the escape cost
    const goat = Object.values(state.objects).find((o) => o.controllerId === A && o.zone === 'battlefield' && getDef(o.defName).name === 'Goat')
    expect(goat, 'ETB Goat token').toBeTruthy()
  })

  it('escape requires exiling exactly N other cards', () => {
    const { state, A } = makeDuel()
    const woe = putCard(state, A, 'Woe Strider', 'graveyard')
    const fodder = [0, 1].map(() => putCard(state, A, 'Mountain', 'graveyard')) // only 2, need 4
    toStep(state, 'main1')
    addMana(state, A, 'B', 4)
    expect(() => act(state, A, { type: 'r.cast', objId: woe, targets: [], escapeExile: fodder })).toThrow()
  })
})
