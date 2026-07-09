/**
 * Coverage batch B5: cost-bearing mana abilities (Signets: "{1},{T}: Add {W}{U}")
 * and honoring entersTapped on CAST permanents (Worn Powerstone). Also regresses
 * the chooseColor migration for guildgates/dorks/rocks.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'

type St = ReturnType<typeof makeDuel>['state']

describe('Signets — {1},{T}: add two fixed colours (net +1 mana, fixing)', () => {
  it('pays {1} from the pool and produces its two colours', () => {
    const { state, A } = makeDuel()
    const island = putCard(state, A, 'Island', 'battlefield')
    const signet = putCard(state, A, 'Azorius Signet', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: island }) // pool: U=1
    act(state, A, { type: 'r.tapMana', objId: signet }) // pay {1} (the U), add W+U
    expect(state.players[A]!.manaPool.W).toBe(1)
    expect(state.players[A]!.manaPool.U).toBe(1)
    expect(state.objects[signet]!.tapped).toBe(true)
  })

  it('cannot be activated without mana to pay its {1}', () => {
    const { state, A } = makeDuel()
    const signet = putCard(state, A, 'Azorius Signet', 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.tapMana', objId: signet })).toThrow()
    expect(state.objects[signet]!.tapped).toBe(false) // atomic: not tapped on failed payment
  })
})

describe('entersTapped honored on cast permanents', () => {
  it('Worn Powerstone enters the battlefield tapped when cast', () => {
    const { state, A } = makeDuel()
    const wp = putCard(state, A, 'Worn Powerstone', 'hand')
    for (let i = 0; i < 3; i++) putCard(state, A, 'Forest', 'battlefield')
    toStep(state, 'main1')
    for (const id of [...state.zones.perPlayer[A]!.battlefield]) {
      const hasMana = getDef(state.objects[id]!.defName).abilities?.some((a) => a.kind === 'activated' && a.isMana)
      if (hasMana) act(state, A, { type: 'r.tapMana', objId: id })
    }
    act(state, A, { type: 'r.cast', objId: wp, targets: [] })
    until(state, (s) => !s.zones.stack.length, 'worn powerstone resolves')
    const onBf = state.zones.perPlayer[A]!.battlefield.find((id) => getDef(state.objects[id]!.defName).name === 'Worn Powerstone')!
    expect(state.objects[onBf]!.tapped).toBe(true)
  })
})

describe('chooseColor migration regression', () => {
  it('a guildgate still lets you pick which colour to add', () => {
    const { state, A } = makeDuel()
    const gate = putCard(state, A, 'Azorius Guildgate', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: gate, color: 'W' })
    expect(state.players[A]!.manaPool.W).toBe(1)
    expect(state.players[A]!.manaPool.U).toBe(0)
  })
})
