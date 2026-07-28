/**
 * Perpetual card coverage — batch CARD17: mana that hurts. Ancient Tomb ({C}{C} for 2 damage),
 * City of Brass (any colour for 1 damage), Mana Confluence (a mana ability with a "Pay 1 life"
 * COST) and the ten pain lands, whose two mana abilities are selected by the colour asked for.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState

const PAIN: [string, ManaColor, ManaColor][] = [
  ['Shivan Reef', 'U', 'R'],
  ['Battlefield Forge', 'R', 'W'],
  ['Caves of Koilos', 'W', 'B'],
  ['Yavimaya Coast', 'G', 'U'],
  ['Llanowar Wastes', 'B', 'G'],
  ['Underground River', 'U', 'B'],
  ['Adarkar Wastes', 'W', 'U'],
  ['Sulfurous Springs', 'B', 'R'],
  ['Karplusan Forest', 'R', 'G'],
  ['Brushland', 'G', 'W'],
]

describe('CARD17 — Ancient Tomb / City of Brass / Mana Confluence', () => {
  it('Ancient Tomb adds {C}{C} and deals 2 damage to you', () => {
    const { state, A } = makeDuel()
    const tomb = putCard(state, A, 'Ancient Tomb', 'battlefield')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.tapMana', objId: tomb })
    expect(state.players[A]!.manaPool.C).toBe(2)
    expect(state.players[A]!.life).toBe(life - 2)
    expect(state.log.some((l) => /Ancient Tomb deals 2 damage/.test(l))).toBe(true)
  })

  it('City of Brass adds the chosen colour and deals 1 damage', () => {
    const { state, A } = makeDuel()
    const city = putCard(state, A, 'City of Brass', 'battlefield')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.tapMana', objId: city, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(1)
    expect(state.players[A]!.life).toBe(life - 1)
  })

  it('Mana Confluence pays 1 LIFE as a cost, and is unusable below it', () => {
    const { state, A } = makeDuel()
    const conf = putCard(state, A, 'Mana Confluence', 'battlefield')
    toStep(state, 'main1')
    state.players[A]!.life = 1
    act(state, A, { type: 'r.tapMana', objId: conf, color: 'W' })
    expect(state.players[A]!.manaPool.W).toBe(1)
    expect(state.players[A]!.life).toBe(0)
    // at 0 life the ability is neither offered nor accepted (CR 119.4)
    const conf2 = putCard(state, A, 'Mana Confluence', 'battlefield')
    expect(computeLegal(state, A).manaSourceIds).not.toContain(conf2)
    expect(() => act(state, A, { type: 'r.tapMana', objId: conf2, color: 'W' })).toThrow(/Not enough life/)
  })

  it('a colour is required for the any-colour lands', () => {
    const { state, A } = makeDuel()
    const city = putCard(state, A, 'City of Brass', 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.tapMana', objId: city })).toThrow(/CHOOSE_COLOR|Choose which colour/i)
    expect(state.players[A]!.life).toBe(40) // rejected before any mutation
  })
})

describe('CARD17 — the ten pain lands', () => {
  for (const [land, a, b] of PAIN) {
    it(`${land}: {C} is free, {${a}}/{${b}} costs 1 life`, () => {
      const { state, A } = makeDuel()
      const painless = putCard(state, A, land, 'battlefield')
      const painful = putCard(state, A, land, 'battlefield')
      toStep(state, 'main1')
      const life = state.players[A]!.life
      // asking for {C} selects the first ability — no damage
      act(state, A, { type: 'r.tapMana', objId: painless, color: 'C' })
      expect(state.players[A]!.manaPool.C).toBe(1)
      expect(state.players[A]!.life).toBe(life)
      // asking for a colour selects the second ability — 1 damage
      act(state, A, { type: 'r.tapMana', objId: painful, color: b })
      expect(state.players[A]!.manaPool[b]).toBe(1)
      expect(state.players[A]!.life).toBe(life - 1)
    })
  }

  it('redact offers every colour a pain land can make, colourless included', () => {
    const { state, A } = makeDuel()
    const reef = putCard(state, A, 'Shivan Reef', 'battlefield')
    toStep(state, 'main1')
    const legal = computeLegal(state, A)
    expect(legal.manaSourceIds).toContain(reef)
    expect(legal.manaSourceColors[reef]).toEqual(['C', 'U', 'R'])
  })

  it('a pain land cannot make a colour it does not produce', () => {
    const { state, A } = makeDuel()
    const reef = putCard(state, A, 'Shivan Reef', 'battlefield') // U/R
    toStep(state, 'main1')
    // no ability produces {G} → rejected outright, rather than silently making {C} instead
    expect(() => act(state, A, { type: 'r.tapMana', objId: reef, color: 'G' })).toThrow(/can't make \{G\}/i)
    expect(state.players[A]!.manaPool.G).toBe(0)
  })

  it('the mana really pays for a spell, damage included', () => {
    const { state, A } = makeDuel()
    const reef = putCard(state, A, 'Shivan Reef', 'battlefield')
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: reef, color: 'R' })
    expect(state.players[A]!.life).toBe(39)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [A] })
    expect(state.zones.stack.length).toBe(1) // paid entirely from the pain land's red mana
  })
})
