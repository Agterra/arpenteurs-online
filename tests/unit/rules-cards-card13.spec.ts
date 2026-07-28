/**
 * Perpetual card coverage — batch CARD13: Skullclamp (the new "whenever EQUIPPED creature dies"
 * watch scope, plus its famous +1/-1 that kills a 1-toughness creature outright) and Fabled Passage
 * (a fetch whose land enters tapped, then untaps if you control four or more lands).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD13 — Skullclamp', () => {
  it('+1/-1 kills a 1-toughness creature as it is equipped, and draws two cards', () => {
    const { state, A } = makeDuel()
    const clamp = putCard(state, A, 'Skullclamp', 'battlefield')
    const elf = putCard(state, A, 'Llanowar Elves', 'battlefield') // 1/1 → 2/0
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.equip', equipmentId: clamp, creatureId: elf })
    expect(state.objects[elf]!.zone).toBe('graveyard') // 0 toughness → SBA
    resolve(state, A) // the dies trigger is on the stack
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 2)
    expect(state.objects[clamp]!.attachedTo).toBeFalsy() // unattached, ready to re-equip
  })

  it('the trigger fires only for ITS host, not for any other creature dying', () => {
    const { state, A } = makeDuel()
    const clamp = putCard(state, A, 'Skullclamp', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2 → 3/1, survives equipping
    const other = putCard(state, A, 'Gray Ogre', 'battlefield') // 2/2
    const shock1 = putCard(state, A, 'Shock', 'hand')
    const shock2 = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.equip', equipmentId: clamp, creatureId: bear })
    expect(state.objects[bear]!.zone).toBe('battlefield')
    // an unrelated creature dies (2 damage on a 2/2): no draw
    addMana(state, A, 'R', 2)
    act(state, A, { type: 'r.cast', objId: shock1, targets: [other] })
    resolve(state, A)
    expect(state.objects[other]!.zone).toBe('graveyard')
    const handAfterOther = state.zones.perPlayer[A]!.hand.length
    // now the EQUIPPED creature dies (2 damage on the clamped 3/1): two cards
    act(state, A, { type: 'r.cast', objId: shock2, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handAfterOther - 1 + 2) // Shock left the hand, then drew 2
  })

  it('an unequipped Skullclamp draws nothing when a creature dies', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Skullclamp', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.mMove', objId: bear, zone: 'graveyard' })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore)
  })

  it("the controller of the CLAMP draws, even when it equips… only your own creatures (sanity)", () => {
    const { state, A, B } = makeDuel()
    const clamp = putCard(state, A, 'Skullclamp', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'C', 1)
    expect(() => act(state, A, { type: 'r.equip', equipmentId: clamp, creatureId: theirs })).toThrow(/BAD_EQUIP|creature you control/i)
  })
})

describe('CARD13 — Fabled Passage', () => {
  const fetchWith = (s: St, A: PlayerId, otherLands: number) => {
    for (let i = 0; i < otherLands; i++) putCard(s, A, 'Mountain', 'battlefield')
    const passage = putCard(s, A, 'Fabled Passage', 'battlefield')
    putCard(s, A, 'Forest', 'library')
    toStep(s, 'main1')
    act(s, A, { type: 'r.activate', objId: passage, abilityIndex: 0, targets: [] })
    until(s, (x) => x.pending?.kind === 'search' && x.pending.player === A, 'the fetch search')
    const pick = s.pendingSearch!.matchIds[0]!
    act(s, A, { type: 'r.search', cardIds: [pick] })
    return pick
  }

  it('with fewer than four lands the fetched basic stays tapped', () => {
    const { state, A } = makeDuel()
    // 2 other lands + the fetched one = 3 (the Passage sacrificed itself, so it does not count)
    const fetched = fetchWith(state, A, 2)
    expect(state.objects[fetched]!.zone).toBe('battlefield')
    expect(state.objects[fetched]!.tapped).toBe(true)
  })

  it('at four or more lands (counting the fetched one) it untaps', () => {
    const { state, A } = makeDuel()
    const fetched = fetchWith(state, A, 3) // 3 + the fetched one = 4
    expect(state.objects[fetched]!.tapped).toBe(false)
    expect(state.log.some((l) => /is untapped \(4 lands\)/.test(l))).toBe(true)
    // and it is usable right away (whichever basic was fetched)
    act(state, A, { type: 'r.tapMana', objId: fetched })
    expect(Object.values(state.players[A]!.manaPool).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('pays {T} + sacrifices itself, and finds only basics', () => {
    const { state, A } = makeDuel()
    const passage = putCard(state, A, 'Fabled Passage', 'battlefield')
    putCard(state, A, 'Bojuka Bog', 'library') // a NONbasic Swamp — not a legal find
    toStep(state, 'main1')
    act(state, A, { type: 'r.activate', objId: passage, abilityIndex: 0, targets: [] })
    expect(state.objects[passage]!.zone).toBe('graveyard')
    until(state, (s) => s.pending?.kind === 'search', 'the fetch search')
    const bog = state.zones.perPlayer[A]!.library.find((id) => state.objects[id]!.defName.includes('bojuka'))
    expect(state.pendingSearch!.matchIds).not.toContain(bog)
  })
})
