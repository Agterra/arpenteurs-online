/**
 * Perpetual card coverage — batch CARD14: Treasure tokens — an ARTIFACT token whose mana ability
 * sacrifices itself ("{T}, Sacrifice this token: Add one mana of any color"), plus the two cards
 * that make them: An Offer You Can't Refuse (the COUNTERED player gets them) and Pitiless Plunderer.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const treasuresOf = (s: St, p: PlayerId) =>
  s.zones.perPlayer[p]!.battlefield.filter((id) => getDef(s.objects[id]!.defName).name === 'Treasure')

describe("CARD14 — An Offer You Can't Refuse", () => {
  it('counters a noncreature spell and gives ITS CONTROLLER two Treasures', () => {
    const { state, A, B } = makeDuel()
    const offer = putCard(state, A, "An Offer You Can't Refuse", 'hand')
    const shock = putCard(state, B, 'Shock', 'hand') // an INSTANT, so B can cast it on A's turn
    toStep(state, 'main1')
    const lifeBefore = state.players[A]!.life
    pass(state, A) // let B act in A's main phase
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    pass(state, B) // the caster keeps priority (CR 116.4) — hand it to A to respond
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: offer, targets: [shock] })
    resolve(state, A)
    expect(state.objects[shock]!.zone).toBe('graveyard') // countered
    expect(state.players[A]!.life).toBe(lifeBefore) // …so its 2 damage never happened
    expect(treasuresOf(state, B).length).toBe(2) // the compensation goes to B…
    expect(treasuresOf(state, A).length).toBe(0) // …not to the caster
  })

  it('cannot target a creature spell', () => {
    const { state, A, B } = makeDuel()
    const offer = putCard(state, A, "An Offer You Can't Refuse", 'hand')
    const ogre = putCard(state, B, 'Gray Ogre', 'hand')
    // a creature spell is sorcery-speed, so wait for B's own main phase
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's main phase")
    addMana(state, B, 'R', 1)
    addMana(state, B, 'C', 2)
    act(state, B, { type: 'r.cast', objId: ogre, targets: [] })
    pass(state, B)
    addMana(state, A, 'U', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: offer, targets: [ogre] })).toThrow(/BAD_TARGETS|Illegal target/i)
  })
})

describe('CARD14 — the Treasure token itself', () => {
  it('taps for any colour and sacrifices itself, leaving the battlefield', () => {
    const { state, A, B } = makeDuel()
    const offer = putCard(state, A, "An Offer You Can't Refuse", 'hand')
    const shock = putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    pass(state, B) // the caster keeps priority (CR 116.4) — hand it to A to respond
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: offer, targets: [shock] })
    resolve(state, A)
    // B now holds two Treasures — it's still A's turn, but a mana ability is any-time for its
    // controller when they have priority, so hand priority to B first
    pass(state, A)
    const [t1] = treasuresOf(state, B)
    const def = getDef(state.objects[t1!]!.defName)
    expect(def.types).toEqual(['Artifact'])
    expect(def.subtypes).toEqual(['Treasure'])
    act(state, B, { type: 'r.tapMana', objId: t1!, color: 'G' })
    expect(state.players[B]!.manaPool.G).toBe(1)
    expect(state.zones.perPlayer[B]!.battlefield).not.toContain(t1) // sacrificed as part of the cost
    expect(treasuresOf(state, B).length).toBe(1) // the other one is untouched
    expect(state.log.some((l) => /sacrifices Treasure for mana/.test(l))).toBe(true)
  })

  it('is offered as a colour-choice mana source and its mana pays for a spell', () => {
    const { state, A } = makeDuel()
    const plunderer = putCard(state, A, 'Pitiless Plunderer', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const shock1 = putCard(state, A, 'Shock', 'hand')
    const shock2 = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    // kill my own bear → the Plunderer makes a Treasure
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock1, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
    const [treasure] = treasuresOf(state, A)
    expect(treasure).toBeTruthy()
    // redact offers it as a WUBRG colour-choice source
    const legal = computeLegal(state, A)
    expect(legal.manaSourceIds).toContain(treasure)
    expect(legal.manaSourceColors[treasure!]).toEqual(['W', 'U', 'B', 'R', 'G'])
    // and its mana really pays for a spell
    act(state, A, { type: 'r.tapMana', objId: treasure!, color: 'R' })
    act(state, A, { type: 'r.cast', objId: shock2, targets: [plunderer] })
    resolve(state, A)
    expect(state.objects[plunderer]!.damageMarked).toBe(2) // 1/4 — survives, so the Shock resolved
  })
})

describe('CARD14 — Pitiless Plunderer', () => {
  it('makes a Treasure when ANOTHER creature you control dies', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Pitiless Plunderer', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const shock = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [bear] })
    resolve(state, A)
    expect(treasuresOf(state, A).length).toBe(1)
  })

  it('does NOT trigger on its own death, nor on an opponent\'s creature dying', () => {
    const { state, A, B } = makeDuel()
    const plunderer = putCard(state, A, 'Pitiless Plunderer', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const shock = putCard(state, A, 'Shock', 'hand')
    const murder = putCard(state, A, 'Murder', 'hand')
    toStep(state, 'main1')
    // an opponent's creature dies → nothing
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [theirs] })
    resolve(state, A)
    expect(state.objects[theirs]!.zone).toBe('graveyard')
    expect(treasuresOf(state, A).length).toBe(0)
    // the Plunderer itself dies → still nothing (excludeSelf)
    addMana(state, A, 'B', 2)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: murder, targets: [plunderer] })
    resolve(state, A)
    expect(state.objects[plunderer]!.zone).toBe('graveyard')
    expect(treasuresOf(state, A).length).toBe(0)
  })
})
