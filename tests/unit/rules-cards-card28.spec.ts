/**
 * Perpetual card coverage — batch CARD28: the ten Karoo ("bounce") lands, landfall (Rampaging
 * Baloths), a granted "can't be blocked" (Whispersilk Cloak), a graveyard search destination
 * (Entomb), count-based mana from a spell (Mana Geyser) and three more singles.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

const KAROO: [string, ManaColor, ManaColor][] = [
  ['Simic Growth Chamber', 'G', 'U'],
  ['Golgari Rot Farm', 'B', 'G'],
  ['Dimir Aqueduct', 'U', 'B'],
  ['Orzhov Basilica', 'W', 'B'],
  ['Izzet Boilerworks', 'U', 'R'],
  ['Gruul Turf', 'R', 'G'],
  ['Azorius Chancery', 'W', 'U'],
  ['Boros Garrison', 'R', 'W'],
  ['Rakdos Carnarium', 'B', 'R'],
  ['Selesnya Sanctuary', 'G', 'W'],
]

describe('CARD28 — the ten Karoo lands', () => {
  for (const [land, a, b] of KAROO) {
    it(`${land}: enters tapped, bounces one of your lands, taps for {${a}}{${b}}`, () => {
      const { state, A } = makeDuel()
      const other = putCard(state, A, 'Mountain', 'battlefield')
      const karoo = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: karoo })
      expect(state.objects[karoo]!.tapped).toBe(true)
      // its ETB targets a land YOU control — return the Mountain
      expect(state.pending?.kind).toBe('trigger')
      act(state, A, { type: 'r.chooseTargets', targets: [other] })
      resolve(state, A)
      expect(state.objects[other]).toBeUndefined() // bounced to hand with a fresh id (invariant #3)
      // and it makes TWO mana at once
      state.objects[karoo]!.tapped = false
      act(state, A, { type: 'r.tapMana', objId: karoo })
      expect(state.players[A]!.manaPool[a]).toBe(1)
      expect(state.players[A]!.manaPool[b]).toBe(1)
    })
  }

  it('can bounce ITSELF when it is your only land', () => {
    const { state, A } = makeDuel()
    const karoo = putCard(state, A, 'Dimir Aqueduct', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: karoo })
    expect(state.pending?.kind).toBe('trigger')
    act(state, A, { type: 'r.chooseTargets', targets: [karoo] })
    resolve(state, A)
    expect(state.objects[karoo]).toBeUndefined() // it returned itself to hand
  })

  it("cannot bounce an opponent's land", () => {
    const { state, A, B } = makeDuel()
    const theirs = putCard(state, B, 'Mountain', 'battlefield')
    const mine = putCard(state, A, 'Mountain', 'battlefield')
    const karoo = putCard(state, A, 'Gruul Turf', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: karoo })
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [theirs] })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, A, { type: 'r.chooseTargets', targets: [mine] })
    resolve(state, A)
    expect(state.objects[theirs]!.zone).toBe('battlefield')
  })
})

describe('CARD28 — landfall (Rampaging Baloths)', () => {
  it('makes a 4/4 Beast whenever a land you control enters', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Rampaging Baloths', 'battlefield')
    const land = putCard(state, A, 'Mountain', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: land })
    resolve(state, A)
    const beasts = state.zones.perPlayer[A]!.battlefield.filter((id) => getDef(state.objects[id]!.defName).name === 'Beast')
    expect(beasts.length).toBe(1)
    expect(getDef(state.objects[beasts[0]!]!.defName).power).toBe(4)
  })

  it("does not trigger on an opponent's land", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Rampaging Baloths', 'battlefield')
    const theirLand = putCard(state, B, 'Mountain', 'hand')
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    act(state, B, { type: 'r.playLand', objId: theirLand })
    until(state, (s) => !s.zones.stack.length, 'settle')
    expect(state.zones.perPlayer[A]!.battlefield.some((id) => getDef(state.objects[id]!.defName).name === 'Beast')).toBe(false)
  })

  it('also fires for a land that arrives by a fetch', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Rampaging Baloths', 'battlefield')
    const wilds = putCard(state, A, 'Evolving Wilds', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.activate', objId: wilds, abilityIndex: 0, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'the fetch')
    act(state, A, { type: 'r.search', cardIds: [state.pendingSearch!.matchIds[0]!] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.battlefield.some((id) => getDef(state.objects[id]!.defName).name === 'Beast')).toBe(true)
  })
})

describe('CARD28 — the singles', () => {
  it('Azusa allows two additional lands each turn', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Azusa, Lost but Seeking', 'battlefield')
    const lands = [1, 2, 3, 4].map(() => putCard(state, A, 'Mountain', 'hand'))
    toStep(state, 'main1')
    for (const l of lands.slice(0, 3)) act(state, A, { type: 'r.playLand', objId: l })
    expect(() => act(state, A, { type: 'r.playLand', objId: lands[3]! })).toThrow(/LAND_LIMIT|Already played/i)
  })

  it('Seething Song adds five red mana', () => {
    const { state, A } = makeDuel()
    const song = putCard(state, A, 'Seething Song', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: song, targets: [] })
    resolve(state, A)
    expect(state.players[A]!.manaPool.R).toBe(5)
  })

  it("Mana Geyser adds {R} per TAPPED opposing land", () => {
    const { state, A, B } = makeDuel()
    const geyser = putCard(state, A, 'Mana Geyser', 'hand')
    const theirs = [1, 2, 3].map(() => putCard(state, B, 'Mountain', 'battlefield'))
    state.objects[theirs[0]!]!.tapped = true
    state.objects[theirs[1]!]!.tapped = true // two tapped, one untapped
    putCard(state, A, 'Mountain', 'battlefield') // my own tapped land must not count
    state.zones.perPlayer[A]!.battlefield.forEach((id) => {
      if (getDef(state.objects[id]!.defName).name === 'Mountain') state.objects[id]!.tapped = true
    })
    toStep(state, 'main1')
    addMana(state, A, 'R', 2)
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.cast', objId: geyser, targets: [] })
    resolve(state, A)
    expect(state.players[A]!.manaPool.R).toBe(2)
  })

  it('Entomb puts the chosen card into your GRAVEYARD', () => {
    const { state, A } = makeDuel()
    const entomb = putCard(state, A, 'Entomb', 'hand')
    const wanted = putCard(state, A, 'Grizzly Bears', 'library')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.cast', objId: entomb, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'the search')
    act(state, A, { type: 'r.search', cardIds: [wanted] })
    expect(state.objects[wanted]!.zone).toBe('graveyard') // public zone → the id is kept
    expect(state.zones.perPlayer[A]!.graveyard).toContain(wanted)
  })

  it('Baleful Strix draws on arrival and is a 1/1 flying deathtoucher', () => {
    const { state, A } = makeDuel()
    const strix = putCard(state, A, 'Baleful Strix', 'hand')
    toStep(state, 'main1')
    const before = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'U', 1)
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.cast', objId: strix, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before - 1 + 1)
    const def = getDef(state.objects[strix]!.defName)
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'deathtouch']))
  })

  it("Whispersilk Cloak's equipped creature can't be blocked", () => {
    const { state, A, B } = makeDuel()
    const cloak = putCard(state, A, 'Whispersilk Cloak', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    const blocker = putCard(state, B, 'Grizzly Bears', 'battlefield')
    state.objects[ogre]!.summoningSick = false
    toStep(state, 'main1')
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.equip', equipmentId: cloak, creatureId: ogre })
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [ogre])
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
    expect(() => act(state, B, { type: 'r.blockers', blocks: [{ blockerId: blocker, attackerId: ogre }] })).toThrow(
      /can't be blocked/i,
    )
  })
})
