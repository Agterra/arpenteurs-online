/**
 * Perpetual card coverage — batch CARD19: the ten check lands ("enters tapped UNLESS you control
 * an Island or a Mountain"), Temple of the False God (a mana ability with an activation condition)
 * and Swan Song (a counter with a positive spell-type filter, giving its victim a Bird).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

/** name → [colour a, colour b, basic type x, basic type y] */
const CHECKS: [string, ManaColor, ManaColor, string, string][] = [
  ['Sulfur Falls', 'U', 'R', 'Island', 'Mountain'],
  ['Clifftop Retreat', 'R', 'W', 'Mountain', 'Plains'],
  ['Dragonskull Summit', 'B', 'R', 'Swamp', 'Mountain'],
  ['Isolated Chapel', 'W', 'B', 'Plains', 'Swamp'],
  ['Glacial Fortress', 'W', 'U', 'Plains', 'Island'],
  ['Hinterland Harbor', 'G', 'U', 'Forest', 'Island'],
  ['Drowned Catacomb', 'U', 'B', 'Island', 'Swamp'],
  ['Woodland Cemetery', 'B', 'G', 'Swamp', 'Forest'],
  ['Rootbound Crag', 'R', 'G', 'Mountain', 'Forest'],
  ['Sunpetal Grove', 'G', 'W', 'Forest', 'Plains'],
]

describe('CARD19 — the ten check lands', () => {
  for (const [land, a, b, x, y] of CHECKS) {
    it(`${land}: tapped with no ${x}/${y}, untapped once you control one`, () => {
      const { state, A } = makeDuel()
      const alone = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: alone })
      expect(state.objects[alone]!.tapped).toBe(true) // nothing to check → enters tapped
      // now control the right basic and play a second copy on the next turn
      putCard(state, A, y, 'battlefield')
      const second = putCard(state, A, land, 'hand')
      until(state, (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A, "A's next turn")
      act(state, A, { type: 'r.playLand', objId: second })
      expect(state.objects[second]!.tapped).toBe(false)
      act(state, A, { type: 'r.tapMana', objId: second, color: a })
      expect(state.players[A]!.manaPool[a]).toBe(1)
    })
  }

  it('a NONbasic land with the right type also satisfies the check (a shockland)', () => {
    const { state, A } = makeDuel()
    const shock = putCard(state, A, 'Watery Grave', 'battlefield') // Land — Island Swamp
    state.objects[shock]!.tapped = false
    const falls = putCard(state, A, 'Sulfur Falls', 'hand') // needs an Island or a Mountain
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: falls })
    expect(state.objects[falls]!.tapped).toBe(false)
  })

  it('the wrong land types do not satisfy it', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Forest', 'battlefield')
    putCard(state, A, 'Plains', 'battlefield')
    const falls = putCard(state, A, 'Sulfur Falls', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: falls })
    expect(state.objects[falls]!.tapped).toBe(true)
  })

  it("an opponent's Island does not help you", () => {
    const { state, A, B } = makeDuel()
    putCard(state, B, 'Island', 'battlefield')
    const falls = putCard(state, A, 'Sulfur Falls', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: falls })
    expect(state.objects[falls]!.tapped).toBe(true)
  })

  it('the check also applies when it arrives by another path (a manual move)', () => {
    const { state, A } = makeDuel()
    const falls = putCard(state, A, 'Sulfur Falls', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.mMove', objId: falls, zone: 'battlefield' })
    expect(state.objects[falls]!.tapped).toBe(true)
  })
})

describe('CARD19 — Temple of the False God', () => {
  const temple = (s: St, A: PlayerId, otherLands: number) => {
    for (let i = 0; i < otherLands; i++) putCard(s, A, 'Mountain', 'battlefield')
    const t = putCard(s, A, 'Temple of the False God', 'battlefield')
    toStep(s, 'main1')
    return t
  }

  it('is dead below five lands — neither offered nor accepted', () => {
    const { state, A } = makeDuel()
    const t = temple(state, A, 3) // 3 + the Temple = 4 lands
    expect(computeLegal(state, A).manaSourceIds).not.toContain(t)
    expect(() => act(state, A, { type: 'r.tapMana', objId: t })).toThrow(/Needs 5 lands/)
    expect(state.objects[t]!.tapped).toBe(false)
  })

  it('adds {C}{C} at five or more lands (counting itself)', () => {
    const { state, A } = makeDuel()
    const t = temple(state, A, 4) // 4 + the Temple = 5
    expect(computeLegal(state, A).manaSourceIds).toContain(t)
    act(state, A, { type: 'r.tapMana', objId: t })
    expect(state.players[A]!.manaPool.C).toBe(2)
  })
})

describe('CARD19 — Swan Song', () => {
  it('counters an instant and gives ITS controller a 2/2 flying Bird', () => {
    const { state, A, B } = makeDuel()
    const song = putCard(state, A, 'Swan Song', 'hand')
    const shock = putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    pass(state, B)
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: song, targets: [shock] })
    resolve(state, A)
    expect(state.objects[shock]!.zone).toBe('graveyard')
    expect(state.players[A]!.life).toBe(40) // the Shock never resolved
    const birds = state.zones.perPlayer[B]!.battlefield.filter((id) => getDef(state.objects[id]!.defName).name === 'Bird')
    expect(birds.length).toBe(1)
    const bird = state.objects[birds[0]!]!
    expect(getDef(bird.defName).power).toBe(2)
    expect(getDef(bird.defName).keywords).toContain('flying')
    expect(state.zones.perPlayer[A]!.battlefield.some((id) => getDef(state.objects[id]!.defName).name === 'Bird')).toBe(false)
  })

  it('cannot target a creature spell (the positive type filter)', () => {
    const { state, A, B } = makeDuel()
    const song = putCard(state, A, 'Swan Song', 'hand')
    const ogre = putCard(state, B, 'Gray Ogre', 'hand')
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    addMana(state, B, 'R', 1)
    addMana(state, B, 'C', 2)
    act(state, B, { type: 'r.cast', objId: ogre, targets: [] })
    pass(state, B)
    addMana(state, A, 'U', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: song, targets: [ogre] })).toThrow(/BAD_TARGETS|Illegal target/i)
  })

  it('can counter a sorcery', () => {
    const { state, A, B } = makeDuel()
    const song = putCard(state, A, 'Swan Song', 'hand')
    const divination = putCard(state, B, 'Divination', 'hand')
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    const handBefore = state.zones.perPlayer[B]!.hand.length
    addMana(state, B, 'U', 1)
    addMana(state, B, 'C', 2)
    act(state, B, { type: 'r.cast', objId: divination, targets: [] })
    pass(state, B)
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: song, targets: [divination] })
    until(state, (s) => !s.zones.stack.length, 'resolve')
    expect(state.objects[divination]!.zone).toBe('graveyard')
    expect(state.zones.perPlayer[B]!.hand.length).toBe(handBefore - 1) // no cards drawn
  })
})
