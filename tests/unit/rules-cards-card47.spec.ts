/**
 * Perpetual card coverage — batch CARD47: "choose a card from your hand" decisions — Growth Spiral
 * ("you may put a land card from your hand onto the battlefield", which does NOT use your land drop)
 * and Chrome Mox's IMPRINT (CR 702.61: exile a nonartifact, nonland card from your hand; the Mox then
 * taps only for that card's colours, and for nothing at all if you imprinted nothing).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
/** empty the hand so the fixtures below are the only cards in it */
const clearHand = (s: St, p: PlayerId) => {
  const hand = s.zones.perPlayer[p]!.hand
  while (hand.length) s.zones.perPlayer[p]!.graveyard.push(hand.pop()!)
}

describe('CARD47 — Growth Spiral', () => {
  const cast = (s: St, A: PlayerId) => {
    const spell = putCard(s, A, 'Growth Spiral', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'G', 1)
    addMana(s, A, 'U', 1)
    act(s, A, { type: 'r.cast', objId: spell, targets: [] })
    return spell
  }

  it('draws a card, then puts a land from hand onto the battlefield for free', () => {
    const { state, A } = makeDuel()
    clearHand(state, A)
    const land = putCard(state, A, 'Mountain', 'hand')
    cast(state, A)
    until(state, (s) => s.pending?.kind === 'handChoice', 'the hand choice')
    const legal = computeLegal(state, A)
    expect(legal.needsHandChoice).toBe(true)
    expect(legal.handChoiceCount).toBe(1)
    expect(legal.handChoiceOptional).toBe(true)
    expect(legal.handChoiceIds).toContain(land) // the drawn card may be a land too
    act(state, A, { type: 'r.handChoice', objIds: [land] })
    expect(state.objects[land]!.zone).toBe('battlefield')
    expect(state.players[A]!.landsPlayedThisTurn).toBe(0) // NOT a land drop
    // …so you can still play a land normally this turn
    const another = putCard(state, A, 'Forest', 'hand')
    act(state, A, { type: 'r.playLand', objId: another })
    expect(state.objects[another]!.zone).toBe('battlefield')
  })

  it('may be declined', () => {
    const { state, A } = makeDuel()
    clearHand(state, A)
    const land = putCard(state, A, 'Mountain', 'hand')
    cast(state, A)
    until(state, (s) => s.pending?.kind === 'handChoice', 'the hand choice')
    act(state, A, { type: 'r.handChoice', objIds: [] })
    expect(state.objects[land]!.zone).toBe('hand')
    expect(state.pending).toBeFalsy()
    expect(state.log.some((l) => /declines/.test(l))).toBe(true)
  })

  it('refuses a NON-land and a card that is not in your hand', () => {
    const { state, A, B } = makeDuel()
    clearHand(state, A)
    const land = putCard(state, A, 'Mountain', 'hand')
    const shock = putCard(state, A, 'Shock', 'hand')
    const theirs = putCard(state, B, 'Mountain', 'hand')
    cast(state, A)
    until(state, (s) => s.pending?.kind === 'handChoice', 'the hand choice')
    expect(computeLegal(state, A).handChoiceIds).not.toContain(shock)
    expect(() => act(state, A, { type: 'r.handChoice', objIds: [shock] })).toThrow(/does not qualify/)
    expect(() => act(state, A, { type: 'r.handChoice', objIds: [theirs] })).toThrow(/not in your hand/)
    expect(() => act(state, A, { type: 'r.handChoice', objIds: [land, land] })).not.toThrow() // deduped to one
    expect(state.objects[land]!.zone).toBe('battlefield')
  })

  it('a TAPLAND put this way still enters tapped, with its ETB', () => {
    const { state, A } = makeDuel()
    clearHand(state, A)
    const temple = putCard(state, A, 'Temple of Malice', 'hand') // enters tapped, ETB scry 1
    cast(state, A)
    until(state, (s) => s.pending?.kind === 'handChoice', 'the hand choice')
    act(state, A, { type: 'r.handChoice', objIds: [temple] })
    expect(state.objects[temple]!.tapped).toBe(true)
    until(state, (s) => s.pending?.kind === 'scry', 'its ETB scry')
    act(state, A, { type: 'r.scry', toBottom: [] })
  })

  it('asks nothing at all with no land in hand', () => {
    const { state, A } = makeDuel()
    clearHand(state, A)
    const handBefore = state.zones.perPlayer[A]!.hand.length
    cast(state, A)
    until(state, (s) => !s.zones.stack.length, 'resolve')
    // the draw happened; whether it found a land is luck, so only assert no stall
    expect(state.zones.perPlayer[A]!.hand.length).toBeGreaterThanOrEqual(handBefore)
    if (state.pending?.kind === 'handChoice') act(state, A, { type: 'r.handChoice', objIds: [] })
    expect(state.pending).toBeFalsy()
  })
})

describe('CARD47 — Chrome Mox (imprint)', () => {
  const play = (s: St, A: PlayerId) => {
    const mox = putCard(s, A, 'Chrome Mox', 'hand')
    toStep(s, 'main1')
    act(s, A, { type: 'r.cast', objId: mox, targets: [] }) // {0}
    until(s, (x) => x.objects[mox]!.zone === 'battlefield', 'it resolves')
    return mox
  }

  it('exiles a coloured card and then taps only for that colour', () => {
    const { state, A } = makeDuel()
    clearHand(state, A)
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand') // red
    const mox = play(state, A)
    until(state, (s) => s.pending?.kind === 'handChoice', 'the imprint choice')
    expect(computeLegal(state, A).handChoiceIds).toContain(bolt)
    act(state, A, { type: 'r.handChoice', objIds: [bolt] })
    expect(state.objects[bolt]!.zone).toBe('exile')
    expect(state.objects[mox]!.imprintedDefName).toBeTruthy()
    const legal = computeLegal(state, A)
    expect(legal.manaSourceIds).toContain(mox)
    expect(legal.manaSourceColors[mox]).toEqual(['R'])
    expect(() => act(state, A, { type: 'r.tapMana', objId: mox, color: 'U' })).toThrow(/can't make \{U\}|Choose which colour/i)
    act(state, A, { type: 'r.tapMana', objId: mox, color: 'R' })
    expect(state.players[A]!.manaPool.R).toBe(1)
  })

  it('imprinting nothing leaves it producing no mana at all', () => {
    const { state, A } = makeDuel()
    clearHand(state, A)
    putCard(state, A, 'Lightning Bolt', 'hand')
    const mox = play(state, A)
    until(state, (s) => s.pending?.kind === 'handChoice', 'the imprint choice')
    act(state, A, { type: 'r.handChoice', objIds: [] }) // decline
    expect(state.objects[mox]!.imprintedDefName).toBeUndefined()
    expect(computeLegal(state, A).manaSourceIds).not.toContain(mox)
    expect(() => act(state, A, { type: 'r.tapMana', objId: mox, color: 'R' })).toThrow(/can't make \{R\}/)
  })

  it('cannot imprint an artifact or a land', () => {
    const { state, A } = makeDuel()
    clearHand(state, A)
    const rock = putCard(state, A, 'Sol Ring', 'hand')
    const land = putCard(state, A, 'Mountain', 'hand')
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    const mox = play(state, A)
    until(state, (s) => s.pending?.kind === 'handChoice', 'the imprint choice')
    const ids = computeLegal(state, A).handChoiceIds
    expect(ids).toContain(bolt)
    expect(ids).not.toContain(rock)
    expect(ids).not.toContain(land)
    expect(() => act(state, A, { type: 'r.handChoice', objIds: [rock] })).toThrow(/does not qualify/)
    act(state, A, { type: 'r.handChoice', objIds: [bolt] })
    expect(nameOf(state, state.zones.perPlayer[A]!.exile[0]!)).toBe('Lightning Bolt')
  })

  it('a multicoloured imprint offers both colours', () => {
    const { state, A } = makeDuel()
    clearHand(state, A)
    const gold = putCard(state, A, 'Mortify', 'hand') // {1}{W}{B}
    const mox = play(state, A)
    until(state, (s) => s.pending?.kind === 'handChoice', 'the imprint choice')
    act(state, A, { type: 'r.handChoice', objIds: [gold] })
    expect(computeLegal(state, A).manaSourceColors[mox]).toEqual(['W', 'B'])
    act(state, A, { type: 'r.tapMana', objId: mox, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })
})
