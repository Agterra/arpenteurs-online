/**
 * Perpetual card coverage — batch CARD26: devotion (Gray Merchant of Asphodel, Nykthos), cost
 * reduction from a PERMANENT (Foundry Inspector, the Medallions) and four land cycles — the original
 * duals, the tri-lands, the Triomes and the artifact lands.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, makeGameN, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { devotionTo } from '../../server/rules/engine.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

const DUALS: [string, ManaColor, ManaColor, string, string][] = [
  ['Underground Sea', 'U', 'B', 'Island', 'Swamp'],
  ['Volcanic Island', 'U', 'R', 'Island', 'Mountain'],
  ['Tropical Island', 'G', 'U', 'Forest', 'Island'],
  ['Tundra', 'W', 'U', 'Plains', 'Island'],
  ['Badlands', 'B', 'R', 'Swamp', 'Mountain'],
  ['Scrubland', 'W', 'B', 'Plains', 'Swamp'],
  ['Bayou', 'B', 'G', 'Swamp', 'Forest'],
  ['Plateau', 'R', 'W', 'Mountain', 'Plains'],
  ['Savannah', 'G', 'W', 'Forest', 'Plains'],
  ['Taiga', 'R', 'G', 'Mountain', 'Forest'],
]
const TRI: [string, ManaColor, ManaColor, ManaColor][] = [
  ['Arcane Sanctum', 'W', 'U', 'B'],
  ['Crumbling Necropolis', 'U', 'B', 'R'],
  ['Savage Lands', 'B', 'R', 'G'],
  ['Jungle Shrine', 'R', 'G', 'W'],
  ['Seaside Citadel', 'G', 'W', 'U'],
  ['Nomad Outpost', 'R', 'W', 'B'],
  ['Mystic Monastery', 'U', 'R', 'W'],
  ['Opulent Palace', 'B', 'G', 'U'],
  ['Frontier Bivouac', 'G', 'U', 'R'],
  ['Sandsteppe Citadel', 'W', 'B', 'G'],
]
const TRIOMES: [string, ManaColor, string][] = [
  ['Ketria Triome', 'R', 'Mountain'],
  ["Jetmir's Garden", 'W', 'Plains'],
  ["Spara's Headquarters", 'U', 'Island'],
  ['Indatha Triome', 'G', 'Forest'],
  ['Raugrin Triome', 'W', 'Plains'],
  ['Savai Triome', 'B', 'Swamp'],
  ['Zagoth Triome', 'U', 'Island'],
  ["Raffine's Tower", 'B', 'Swamp'],
  ["Xander's Lounge", 'R', 'Mountain'],
  ["Ziatora's Proving Ground", 'G', 'Forest'],
]
const ART_LANDS: [string, ManaColor][] = [
  ['Seat of the Synod', 'U'],
  ['Great Furnace', 'R'],
  ['Tree of Tales', 'G'],
  ['Ancient Den', 'W'],
  ['Vault of Whispers', 'B'],
]

describe('CARD26 — devotion', () => {
  it('counts coloured pips among the permanents you control only', () => {
    const { state, A, B } = makeDuel()
    expect(devotionTo(state, A, 'B')).toBe(0)
    putCard(state, A, 'Vampire Nighthawk', 'battlefield') // {1}{B}{B} → 2
    putCard(state, A, 'Blood Artist', 'battlefield') // {1}{B} → 1
    putCard(state, A, 'Sol Ring', 'battlefield') // colourless → 0
    putCard(state, B, 'Blood Artist', 'battlefield') // an opponent's → 0
    putCard(state, A, 'Murder', 'hand') // not on the battlefield → 0
    expect(devotionTo(state, A, 'B')).toBe(3)
  })

  it('Gray Merchant drains each opponent for your devotion and gains that much', () => {
    const { state } = makeGameN(3)
    const A = state.activePlayer
    const foes = state.turnOrder.filter((p) => p !== A)
    putCard(state, A, 'Vampire Nighthawk', 'battlefield') // 2 black pips
    const gary = putCard(state, A, 'Gray Merchant of Asphodel', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.cast', objId: gary, targets: [] })
    resolve(state, A)
    // Gary itself adds {B}{B} once on the battlefield → devotion 4 as its ETB resolves
    const drained = 40 - state.players[foes[0]!]!.life
    expect(drained).toBe(4)
    expect(state.players[foes[1]!]!.life).toBe(36)
    expect(state.players[A]!.life).toBe(40 + drained * 2) // gains the TOTAL lost
  })

  it('Nykthos adds mana equal to your devotion to the chosen colour', () => {
    const { state, A } = makeDuel()
    const nykthos = putCard(state, A, 'Nykthos, Shrine to Nyx', 'battlefield')
    putCard(state, A, 'Vampire Nighthawk', 'battlefield') // {1}{B}{B}
    putCard(state, A, 'Blood Artist', 'battlefield') // {1}{B}
    toStep(state, 'main1')
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.tapMana', objId: nykthos, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(3)
    expect(state.players[A]!.manaPool.C).toBe(0) // the {2} was paid
    expect(state.log.some((l) => /adds 3 \{B\} \(devotion\)/.test(l))).toBe(true)
  })

  it("Nykthos's first ability is still a plain {C}", () => {
    const { state, A } = makeDuel()
    const nykthos = putCard(state, A, 'Nykthos, Shrine to Nyx', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: nykthos, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
  })
})

describe('CARD26 — cost reduction from a permanent', () => {
  it('Foundry Inspector makes your artifact spells cost {1} less (and only artifacts)', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Foundry Inspector', 'battlefield')
    const stone = putCard(state, A, 'Mind Stone', 'hand') // {2} → {1}
    const divination = putCard(state, A, 'Divination', 'hand') // {2}{U}, a NONartifact — unaffected
    toStep(state, 'main1')
    addMana(state, A, 'C', 1)
    addMana(state, A, 'U', 1)
    const legal = computeLegal(state, A)
    expect(legal.castableIds).toContain(stone) // redact mirrors the reduction: {2} → {1}
    expect(legal.castableIds).not.toContain(divination) // still {2}{U}: two mana is not enough
    act(state, A, { type: 'r.cast', objId: stone, targets: [] })
    expect(state.players[A]!.manaPool.C).toBe(0) // exactly {1} paid
    expect(state.players[A]!.manaPool.U).toBe(1) // the blue was untouched
    resolve(state, A)
    expect(state.objects[stone]!.zone).toBe('battlefield')
  })

  it('the Medallions reduce by colour, and two sources stack', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Jet Medallion', 'battlefield')
    const murder = putCard(state, A, 'Murder', 'hand') // {1}{B}{B} → {B}{B}
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    const theirBear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    expect(computeLegal(state, A).castableIds).toContain(murder)
    // a second Jet Medallion would take the generic to 0 and no further
    putCard(state, A, 'Jet Medallion', 'battlefield')
    act(state, A, { type: 'r.cast', objId: murder, targets: [theirBear] })
    expect(state.players[A]!.manaPool.B).toBe(0) // exactly {B}{B} paid, never below zero
    resolve(state, A)
    expect(state.objects[theirBear]!.zone).toBe('graveyard')
  })

  it('a Medallion of the wrong colour does nothing', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Ruby Medallion', 'battlefield')
    const murder = putCard(state, A, 'Murder', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    expect(computeLegal(state, A).castableIds).not.toContain(murder)
  })
})

describe('CARD26 — the land cycles', () => {
  for (const [land, a, b, subA, subB] of DUALS) {
    it(`${land}: untapped, taps for {${a}}/{${b}}, printed types ${subA}/${subB}`, () => {
      const { state, A } = makeDuel()
      const dual = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: dual })
      expect(state.objects[dual]!.tapped).toBe(false)
      expect(getDef(state.objects[dual]!.defName).subtypes).toEqual([subA, subB])
      act(state, A, { type: 'r.tapMana', objId: dual, color: b })
      expect(state.players[A]!.manaPool[b]).toBe(1)
    })
  }

  for (const [land, a, b, c] of TRI) {
    it(`${land}: enters tapped, taps for {${a}}/{${b}}/{${c}}`, () => {
      const { state, A } = makeDuel()
      const tri = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: tri })
      expect(state.objects[tri]!.tapped).toBe(true)
      state.objects[tri]!.tapped = false // untap to check the colours it can make
      expect(computeLegal(state, A).manaSourceColors[tri]).toEqual([a, b, c])
      act(state, A, { type: 'r.tapMana', objId: tri, color: c })
      expect(state.players[A]!.manaPool[c]).toBe(1)
    })
  }

  for (const [land, colour, subtype] of TRIOMES) {
    it(`${land}: enters tapped, has real land types and Cycling {3}`, () => {
      const { state, A } = makeDuel()
      const tri = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: tri })
      expect(state.objects[tri]!.tapped).toBe(true)
      const def = getDef(state.objects[tri]!.defName)
      expect(def.subtypes).toContain(subtype)
      expect(def.cyclingCost).toBe('{3}')
      state.objects[tri]!.tapped = false
      act(state, A, { type: 'r.tapMana', objId: tri, color: colour })
      expect(state.players[A]!.manaPool[colour]).toBe(1)
    })
  }

  it('a Triome can be cycled from hand for {3}', () => {
    const { state, A } = makeDuel()
    const tri = putCard(state, A, 'Ketria Triome', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'C', 3)
    const handBefore = state.zones.perPlayer[A]!.hand.length
    expect(computeLegal(state, A).cyclable.some((c) => c.objId === tri)).toBe(true)
    act(state, A, { type: 'r.cycle', objId: tri })
    resolve(state, A)
    expect(state.objects[tri]!.zone).toBe('graveyard')
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore) // -1 cycled, +1 drawn
  })

  for (const [land, colour] of ART_LANDS) {
    it(`${land}: an Artifact AND a Land that taps for {${colour}}`, () => {
      const { state, A } = makeDuel()
      const al = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: al }) // played as a land, not cast
      expect(state.objects[al]!.tapped).toBe(false)
      expect(getDef(state.objects[al]!.defName).types).toEqual(['Artifact', 'Land'])
      act(state, A, { type: 'r.tapMana', objId: al })
      expect(state.players[A]!.manaPool[colour]).toBe(1)
    })
  }

  it('Darksteel Citadel is indestructible and survives artifact removal', () => {
    const { state, A, B } = makeDuel()
    const citadel = putCard(state, A, 'Darksteel Citadel', 'battlefield')
    const blast = putCard(state, B, 'Vandalblast', 'hand')
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    addMana(state, B, 'R', 1)
    addMana(state, B, 'C', 4)
    act(state, B, { type: 'r.cast', objId: blast, targets: [], overload: true })
    until(state, (s) => !s.zones.stack.length, 'resolve')
    expect(state.objects[citadel]!.zone).toBe('battlefield')
  })
})
