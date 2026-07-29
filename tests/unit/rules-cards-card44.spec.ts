/**
 * Perpetual card coverage — batch CARD44: as-enters "choose a creature type" (CR 614.12c) and
 * RESTRICTED mana (CR 106.6) — "spend this mana only to cast a creature spell of the chosen type"
 * (Cavern of Souls / Unclaimed Territory / Secluded Courtyard), "only to cast a legendary spell"
 * (Delighted Halfling), the "…and that spell can't be countered" rider, and a chosen-type anthem
 * (Patchwork Banner).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { currentPT } from '../../server/rules/characteristics.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const restricted = (s: St, p: PlayerId) => s.players[p]!.restrictedMana ?? []
/** play a type-choosing land and answer its as-enters choice */
const playTypeLand = (s: St, A: PlayerId, land: string, type: string) => {
  const id = putCard(s, A, land, 'hand')
  toStep(s, 'main1')
  act(s, A, { type: 'r.playLand', objId: id })
  expect(computeLegal(s, A).needsTypeChoice).toBe(true)
  expect(computeLegal(s, A).typeChoiceName).toBe(land)
  act(s, A, { type: 'r.chooseType', creatureType: type })
  expect(s.objects[id]!.chosenType).toBe(type)
  return id
}

describe('CARD44 — the as-enters creature-type choice', () => {
  it('is asked on entry, normalises the name and blocks other actions until answered', () => {
    const { state, A } = makeDuel()
    const cavern = putCard(state, A, 'Cavern of Souls', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: cavern })
    expect(state.pending?.kind).toBe('typeChoice')
    expect(() => act(state, A, { type: 'r.tapMana', objId: cavern, color: 'C' })).toThrow(/PENDING|Waiting/i)
    act(state, A, { type: 'r.chooseType', creatureType: 'gOBLIN' }) // normalised to Title Case
    expect(state.objects[cavern]!.chosenType).toBe('Goblin')
    expect(state.pending).toBeFalsy()
    act(state, A, { type: 'r.tapMana', objId: cavern, color: 'C' }) // now usable
    expect(state.players[A]!.manaPool.C).toBe(1)
  })

  it('is asked on a FETCHED land too, and two entries queue up', () => {
    const { state, A } = makeDuel()
    const first = putCard(state, A, 'Cavern of Souls', 'hand')
    const second = putCard(state, A, 'Unclaimed Territory', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: first })
    act(state, A, { type: 'r.chooseType', creatureType: 'Elf' })
    // a second one arrives via a manual move (any entry path queues the choice)
    act(state, A, { type: 'r.mMove', objId: second, zone: 'battlefield' })
    expect(state.pending?.kind).toBe('typeChoice')
    act(state, A, { type: 'r.chooseType', creatureType: 'Dragon' })
    expect(state.objects[first]!.chosenType).toBe('Elf')
    expect(state.objects[second]!.chosenType).toBe('Dragon')
  })
})

describe('CARD44 — restricted mana: "only a creature spell of the chosen type"', () => {
  it('pays for a matching creature and nothing else', () => {
    const { state, A } = makeDuel()
    const land = playTypeLand(state, A, 'Unclaimed Territory', 'Bear')
    const bear = putCard(state, A, 'Grizzly Bears', 'hand') // Creature — Bear, {1}{G}
    const shock = putCard(state, A, 'Shock', 'hand') // an instant: never payable with this mana
    act(state, A, { type: 'r.tapMana', objId: land, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(0) // NOT in the open pool
    expect(restricted(state, A)).toEqual([{ color: 'G', amount: 1, creatureType: 'Bear' }])
    // the Shock is not castable off it, the Bear is (once its {1} is covered)
    addMana(state, A, 'C', 1)
    const legal = computeLegal(state, A)
    expect(legal.castableIds).toContain(bear)
    expect(legal.castableIds).not.toContain(shock)
    expect(() => act(state, A, { type: 'r.cast', objId: shock, targets: [A] })).toThrow(/Not enough mana/)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    expect(restricted(state, A)).toEqual([]) // the restricted mana was spent first
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('battlefield')
  })

  it('refuses a creature of the WRONG type', () => {
    const { state, A } = makeDuel()
    const land = playTypeLand(state, A, 'Unclaimed Territory', 'Goblin')
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    act(state, A, { type: 'r.tapMana', objId: land, color: 'G' })
    addMana(state, A, 'C', 1)
    expect(computeLegal(state, A).castableIds).not.toContain(bear)
    expect(() => act(state, A, { type: 'r.cast', objId: bear, targets: [] })).toThrow(/Not enough mana/)
  })

  it('empties with the pool at the next step', () => {
    const { state, A } = makeDuel()
    const land = playTypeLand(state, A, 'Cavern of Souls', 'Bear')
    act(state, A, { type: 'r.tapMana', objId: land, color: 'G' })
    expect(restricted(state, A).length).toBe(1)
    toStep(state, 'main2')
    expect(restricted(state, A)).toEqual([])
  })

  it("Cavern of Souls makes the creature it paid for UNCOUNTERABLE", () => {
    const { state, A, B } = makeDuel()
    const land = playTypeLand(state, A, 'Cavern of Souls', 'Bear')
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    const counter = putCard(state, B, 'Counterspell', 'hand')
    act(state, A, { type: 'r.tapMana', objId: land, color: 'G' })
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    pass(state, A)
    addMana(state, B, 'U', 2)
    act(state, B, { type: 'r.cast', objId: counter, targets: [bear] })
    until(state, (s) => !s.zones.stack.length, 'both resolve')
    expect(state.objects[bear]!.zone).toBe('battlefield') // the counter did nothing
    expect(state.log.some((l) => /can't be countered/.test(l))).toBe(true)
  })

  it('Unclaimed Territory does NOT grant uncounterable', () => {
    const { state, A, B } = makeDuel()
    const land = playTypeLand(state, A, 'Unclaimed Territory', 'Bear')
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    const counter = putCard(state, B, 'Counterspell', 'hand')
    act(state, A, { type: 'r.tapMana', objId: land, color: 'G' })
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    pass(state, A)
    addMana(state, B, 'U', 2)
    act(state, B, { type: 'r.cast', objId: counter, targets: [bear] })
    until(state, (s) => !s.zones.stack.length, 'both resolve')
    expect(state.objects[bear]!.zone).toBe('graveyard')
  })

  it("Secluded Courtyard's mana also activates an ability of a creature of that type", () => {
    const { state, A } = makeDuel()
    const land = playTypeLand(state, A, 'Secluded Courtyard', 'Human')
    act(state, A, { type: 'r.tapMana', objId: land, color: 'W' })
    // the bucket carries the "…or activate an ability of a creature source of the chosen type" clause
    expect(restricted(state, A)[0]!.typeAbilities).toBe(true)
    const other = putCard(state, A, 'Loran of the Third Path', 'hand') // {2}{W} Human
    addMana(state, A, 'C', 2)
    expect(computeLegal(state, A).castableIds).toContain(other)
    act(state, A, { type: 'r.cast', objId: other, targets: [] })
    expect(restricted(state, A)).toEqual([])
  })
})

describe('CARD44 — Delighted Halfling (legendary-only mana)', () => {
  const rig = (s: St, A: PlayerId) => {
    const halfling = putCard(s, A, 'Delighted Halfling', 'battlefield')
    s.objects[halfling]!.summoningSick = false
    toStep(s, 'main1')
    return halfling
  }

  it('pays for a LEGENDARY spell only', () => {
    const { state, A } = makeDuel()
    const halfling = rig(state, A)
    const legend = putCard(state, A, 'Azusa, Lost but Seeking', 'hand') // Legendary Creature, {2}{G}
    const bear = putCard(state, A, 'Grizzly Bears', 'hand') // not legendary
    act(state, A, { type: 'r.tapMana', objId: halfling, color: 'G' })
    expect(restricted(state, A)).toEqual([{ color: 'G', amount: 1, legendary: true, uncounterable: true }])
    addMana(state, A, 'C', 2)
    const legal = computeLegal(state, A)
    expect(legal.castableIds).toContain(legend)
    expect(legal.castableIds).not.toContain(bear) // {1}{G}: only {C} is open
    act(state, A, { type: 'r.cast', objId: legend, targets: [] })
    resolve(state, A)
    expect(state.objects[legend]!.zone).toBe('battlefield')
  })

  it('makes that legendary spell uncounterable', () => {
    const { state, A, B } = makeDuel()
    const halfling = rig(state, A)
    const legend = putCard(state, A, 'Azusa, Lost but Seeking', 'hand')
    const counter = putCard(state, B, 'Counterspell', 'hand')
    act(state, A, { type: 'r.tapMana', objId: halfling, color: 'G' })
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: legend, targets: [] })
    pass(state, A)
    addMana(state, B, 'U', 2)
    act(state, B, { type: 'r.cast', objId: counter, targets: [legend] })
    until(state, (s) => !s.zones.stack.length, 'both resolve')
    expect(state.objects[legend]!.zone).toBe('battlefield')
  })

  it('its plain {C} half is unrestricted', () => {
    const { state, A } = makeDuel()
    const halfling = rig(state, A)
    act(state, A, { type: 'r.tapMana', objId: halfling, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
    expect(restricted(state, A)).toEqual([])
  })
})

describe('CARD44 — Patchwork Banner (an anthem for the chosen type)', () => {
  it('pumps only your creatures of the chosen type', () => {
    const { state, A, B } = makeDuel()
    const banner = putCard(state, A, 'Patchwork Banner', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // Bear
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield') // Ogre
    const theirBear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.cast', objId: banner, targets: [] })
    until(state, (s) => s.pending?.kind === 'typeChoice', 'the type choice')
    act(state, A, { type: 'r.chooseType', creatureType: 'Bear' })
    expect(currentPT(state, state.objects[bear]!)).toEqual({ power: 3, toughness: 3 })
    expect(currentPT(state, state.objects[ogre]!)).toEqual({ power: 2, toughness: 2 })
    expect(currentPT(state, state.objects[theirBear]!)).toEqual({ power: 2, toughness: 2 })
  })

  it('its mana is NOT restricted', () => {
    const { state, A } = makeDuel()
    const banner = putCard(state, A, 'Patchwork Banner', 'battlefield')
    state.objects[banner]!.chosenType = 'Elf'
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: banner, color: 'U' })
    expect(state.players[A]!.manaPool.U).toBe(1)
    expect(restricted(state, A)).toEqual([])
  })
})
