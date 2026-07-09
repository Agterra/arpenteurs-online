/**
 * Coverage batch B3: filtered target kinds (TargetSpec.filter). Type filters
 * (Naturalize = artifact/enchantment) and controller filters (Ravenous Chupacabra
 * = a creature an opponent controls). Leak-safe (battlefield→graveyard is public).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'

type St = ReturnType<typeof makeDuel>['state']
const tapLands = (state: St, A: string) => {
  for (const id of [...state.zones.perPlayer[A]!.battlefield]) {
    const hasMana = getDef(state.objects[id]!.defName).abilities?.some((a) => a.kind === 'activated' && a.isMana)
    if (hasMana) act(state, A, { type: 'r.tapMana', objId: id })
  }
}

describe('Naturalize — type-filtered removal (artifact or enchantment)', () => {
  it('destroys an artifact and leaves creatures untouched', () => {
    const { state, A, B } = makeDuel()
    const nat = putCard(state, A, 'Naturalize', 'hand')
    putCard(state, A, 'Forest', 'battlefield')
    putCard(state, A, 'Forest', 'battlefield')
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    tapLands(state, A)
    act(state, A, { type: 'r.cast', objId: nat, targets: [rock] })
    until(state, (s) => !s.zones.stack.length, 'naturalize resolves')
    expect(state.objects[rock]!.zone).toBe('graveyard')
    expect(state.objects[bear]!.zone).toBe('battlefield')
  })

  it('cannot target a creature (filter rejects it)', () => {
    const { state, A, B } = makeDuel()
    const nat = putCard(state, A, 'Naturalize', 'hand')
    putCard(state, A, 'Forest', 'battlefield')
    putCard(state, A, 'Forest', 'battlefield')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    tapLands(state, A)
    expect(() => act(state, A, { type: 'r.cast', objId: nat, targets: [bear] })).toThrow()
  })
})

describe('Ravenous Chupacabra — controller-filtered ETB removal', () => {
  it('its ETB destroys an opponent creature but cannot target your own', () => {
    const { state, A, B } = makeDuel()
    const chup = putCard(state, A, 'Ravenous Chupacabra', 'hand')
    for (let i = 0; i < 4; i++) putCard(state, A, 'Swamp', 'battlefield')
    const oppBear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    tapLands(state, A)
    act(state, A, { type: 'r.cast', objId: chup, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'chupacabra ETB')
    // cannot destroy your own creature (the Chupacabra itself)
    const self = state.zones.perPlayer[A]!.battlefield.find((id) => getDef(state.objects[id]!.defName).name === 'Ravenous Chupacabra')!
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [self] })).toThrow()
    // legal: the opponent's creature
    act(state, A, { type: 'r.chooseTargets', targets: [oppBear] })
    until(state, (s) => !s.zones.stack.length, 'ETB resolves')
    expect(state.objects[oppBear]!.zone).toBe('graveyard')
  })
})
