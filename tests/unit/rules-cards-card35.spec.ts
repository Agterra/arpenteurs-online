/**
 * Perpetual card coverage — batch CARD35: Chromatic Lantern (a mana ability GRANTED to your lands)
 * and Ponder (look at the top three, put them back in a chosen order or shuffle, then draw).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal, redactRulesState } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })

describe('CARD35 — Chromatic Lantern', () => {
  it('lets any land you control tap for any colour', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Chromatic Lantern', 'battlefield')
    const mountain = putCard(state, A, 'Mountain', 'battlefield')
    toStep(state, 'main1')
    expect(computeLegal(state, A).manaSourceColors[mountain]).toEqual(['R', 'W', 'U', 'B', 'G'])
    act(state, A, { type: 'r.tapMana', objId: mountain, color: 'U' })
    expect(state.players[A]!.manaPool.U).toBe(1)
    expect(state.objects[mountain]!.tapped).toBe(true)
    expect(state.log.some((l) => /\(granted\)/.test(l))).toBe(true)
  })

  it('its own ability still taps for any colour, and a land keeps its own colours', () => {
    const { state, A } = makeDuel()
    const lantern = putCard(state, A, 'Chromatic Lantern', 'battlefield')
    const mountain = putCard(state, A, 'Mountain', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: lantern, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
    act(state, A, { type: 'r.tapMana', objId: mountain, color: 'R' }) // its printed colour
    expect(state.players[A]!.manaPool.R).toBe(1)
  })

  it('grants nothing to an OPPONENT\'s lands, nor to your artifacts', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Chromatic Lantern', 'battlefield')
    const theirLand = putCard(state, B, 'Mountain', 'battlefield')
    const myRock = putCard(state, A, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    // A's own artifact gains nothing (the grant is to LANDS)
    expect(computeLegal(state, A).manaSourceColors[myRock]).toEqual([])
    expect(() => act(state, A, { type: 'r.tapMana', objId: myRock, color: 'U' })).toThrow(/can't make \{U\}/i)
    // and B's land is unaffected on B's own turn (checked where B holds priority)
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    expect(computeLegal(state, B).manaSourceColors[theirLand]).toEqual([])
    expect(() => act(state, B, { type: 'r.tapMana', objId: theirLand, color: 'U' })).toThrow(/can't make \{U\}/i)
  })

  it('a tapped land still cannot be tapped again', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Chromatic Lantern', 'battlefield')
    const mountain = putCard(state, A, 'Mountain', 'battlefield')
    state.objects[mountain]!.tapped = true
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.tapMana', objId: mountain, color: 'G' })).toThrow(/Already tapped/)
  })
})

describe('CARD35 — Ponder', () => {
  const cast = (s: St, A: PlayerId) => {
    const ponder = putCard(s, A, 'Ponder', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'U', 1)
    act(s, A, { type: 'r.cast', objId: ponder, targets: [] })
    until(s, (x) => x.pending?.kind === 'scry', 'the look')
    return ponder
  }

  it('puts the three cards back in the chosen order, then draws the new top card', () => {
    const { state, A } = makeDuel()
    cast(state, A)
    expect(state.pendingScry!.reorder).toBe(true)
    expect(state.pendingScry!.cardIds.length).toBe(3)
    expect(redactRulesState(state, A).scry?.reorder).toBe(true)
    const [c1, c2, c3] = state.pendingScry!.cardIds as [string, string, string]
    const names = [c1, c2, c3].map((id) => getDef(state.objects[id]!.defName).name)
    const handBefore = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.scry', toBottom: [], order: [c3, c2, c1] }) // reversed
    // the drawn card is the one put on top (ids are re-minted, so compare by name)
    const hand = state.zones.perPlayer[A]!.hand
    expect(hand.length).toBe(handBefore + 1)
    expect(getDef(state.objects[hand[hand.length - 1]!]!.defName).name).toBe(names[2])
    // and the next card down is the second in the chosen order
    const lib = state.zones.perPlayer[A]!.library
    expect(getDef(state.objects[lib[0]!]!.defName).name).toBe(names[1])
  })

  it('can shuffle instead, and still draws', () => {
    const { state, A } = makeDuel()
    cast(state, A)
    const libBefore = state.zones.perPlayer[A]!.library.length
    const handBefore = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.scry', toBottom: [], shuffle: true })
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore - 1) // only the draw
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1)
    expect(state.log.some((l) => /shuffles their library/.test(l))).toBe(true)
    expect(state.pending).toBeFalsy()
  })

  it('demands a complete order when not shuffling', () => {
    const { state, A } = makeDuel()
    cast(state, A)
    const [c1] = state.pendingScry!.cardIds as [string]
    expect(() => act(state, A, { type: 'r.scry', toBottom: [], order: [c1] })).toThrow(/Order all 3 cards/)
    expect(state.pending?.kind).toBe('scry') // still open
  })

  it('the looked-at cards are actor-only and re-minted afterwards', () => {
    const { state, A, B } = makeDuel()
    cast(state, A)
    const peeked = [...state.pendingScry!.cardIds]
    const seenByB = JSON.stringify(redactRulesState(state, B))
    for (const id of peeked) expect(seenByB.includes(id)).toBe(false)
    act(state, A, { type: 'r.scry', toBottom: [], shuffle: true })
    for (const id of peeked) expect(state.zones.perPlayer[A]!.library).not.toContain(id)
  })
})
