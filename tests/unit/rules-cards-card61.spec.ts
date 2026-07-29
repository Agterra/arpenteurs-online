/**
 * Perpetual card coverage — batch CARD61: Mystic Remora — CUMULATIVE UPKEEP (CR 702.24: an age counter
 * each upkeep, then pay the per-counter cost for every counter or sacrifice it) plus "whenever an
 * opponent casts a noncreature spell, you may draw two cards" — an ALL-OR-NOTHING draw, unlike Arcane
 * Denial's "up to two". This is the last card of the EDHREC top 100.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const age = (s: St, id: ObjId) => s.objects[id]!.counters.age ?? 0

describe('CARD61 — cumulative upkeep', () => {
  it('adds an age counter each upkeep and charges {1} per counter', () => {
    const { state, A } = makeDuel()
    const remora = putCard(state, A, 'Mystic Remora', 'battlefield')
    // first upkeep: one age counter, {1}
    until(state, (s) => s.pending?.kind === 'optionalPay' && s.pending.player === A, 'the first upkeep')
    expect(age(state, remora)).toBe(1)
    expect(computeLegal(state, A).optionalPayCost).toBe('{1}')
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.optionalPay', pay: true })
    expect(state.objects[remora]!.zone).toBe('battlefield')
    expect(state.log.some((l) => /pays \{1\} to keep Mystic Remora/.test(l))).toBe(true)
    // second upkeep: two counters, {2}
    until(state, (s) => s.pending?.kind === 'optionalPay' && s.pending.player === A, 'the second upkeep')
    expect(age(state, remora)).toBe(2)
    expect(computeLegal(state, A).optionalPayCost).toBe('{2}')
  })

  it('is sacrificed when you decline', () => {
    const { state, A } = makeDuel()
    const remora = putCard(state, A, 'Mystic Remora', 'battlefield')
    until(state, (s) => s.pending?.kind === 'optionalPay', 'the upkeep')
    act(state, A, { type: 'r.optionalPay', pay: false })
    expect(state.objects[remora]!.zone).toBe('graveyard')
    expect(state.log.some((l) => /is sacrificed \(cumulative upkeep\)/.test(l))).toBe(true)
  })

  it('is sacrificed when you cannot pay', () => {
    const { state, A } = makeDuel()
    const remora = putCard(state, A, 'Mystic Remora', 'battlefield')
    state.objects[remora]!.counters.age = 5 // an old Remora: the sixth upkeep costs {6}
    until(state, (s) => s.pending?.kind === 'optionalPay', 'the upkeep')
    expect(computeLegal(state, A).optionalPayCost).toBe('{6}')
    expect(() => act(state, A, { type: 'r.optionalPay', pay: true })).toThrow(/Not enough mana/)
    act(state, A, { type: 'r.optionalPay', pay: false })
    expect(state.objects[remora]!.zone).toBe('graveyard')
  })

  it('only its controller pays for it', () => {
    const { state, A, B } = makeDuel()
    putCard(state, B, 'Mystic Remora', 'battlefield')
    // A's upkeep passes with no decision at all; B's opens one for B
    until(state, (s) => s.pending?.kind === 'optionalPay' || (s.turnNumber === 1 && s.step === 'main1'), "A's upkeep")
    expect(state.pending).toBeFalsy()
    until(state, (s) => s.pending?.kind === 'optionalPay', "B's upkeep")
    expect(state.pending!.player).toBe(B)
  })
})

describe('CARD61 — Mystic Remora draws off opponents', () => {
  const setUp = (s: St, A: PlayerId) => {
    const remora = putCard(s, A, 'Mystic Remora', 'battlefield')
    toStep(s, 'main1')
    // clear the upkeep decision if it opened on the way
    if (s.pending?.kind === 'optionalPay') {
      act(s, A, { type: 'r.mMana', color: 'C', delta: 1 })
      act(s, A, { type: 'r.optionalPay', pay: true })
    }
    return remora
  }

  it('offers TWO cards or none when an opponent casts a noncreature spell', () => {
    const { state, A, B } = makeDuel()
    setUp(state, A)
    const shock = putCard(state, B, 'Shock', 'hand')
    pass(state, A)
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    until(state, (s) => s.pending?.kind === 'mayDraw' && s.pending.player === A, 'the Remora decision')
    const legal = computeLegal(state, A)
    expect(legal.mayDrawMax).toBe(2)
    expect(legal.mayDrawExact).toBe(true)
    expect(legal.mayDrawSourceName).toBe('Mystic Remora')
    expect(() => act(state, A, { type: 'r.mayDraw', count: 1 })).toThrow(/Draw 2 or none/)
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.mayDraw', count: 2 })
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 2)
  })

  it('ignores an opponent CREATURE spell and your own spells', () => {
    const { state, A, B } = makeDuel()
    setUp(state, A)
    // your own noncreature spell: nothing
    const shock = putCard(state, A, 'Shock', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [B] })
    expect(state.pending?.kind).not.toBe('mayDraw')
    until(state, (s) => !s.zones.stack.length, 'it resolves')
    // an opponent's CREATURE spell: nothing either
    const bear = putCard(state, B, 'Grizzly Bears', 'hand')
    until(state, (s) => s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    if (state.pending?.kind === 'optionalPay') act(state, B, { type: 'r.optionalPay', pay: false })
    addMana(state, B, 'G', 1)
    addMana(state, B, 'C', 1)
    act(state, B, { type: 'r.cast', objId: bear, targets: [] })
    expect(state.pending?.kind).not.toBe('mayDraw')
  })

  it('may decline the draw', () => {
    const { state, A, B } = makeDuel()
    setUp(state, A)
    const shock = putCard(state, B, 'Shock', 'hand')
    pass(state, A)
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    until(state, (s) => s.pending?.kind === 'mayDraw', 'the Remora decision')
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.mayDraw', count: 0 })
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand)
  })
})
