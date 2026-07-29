/**
 * Perpetual card coverage — batch CARD24: additional costs chosen as a spell is cast — "sacrifice a
 * creature" (Village Rites), "sacrifice an artifact or creature" (Deadly Dispute) and "discard a
 * card" (Thrill of Possibility, Big Score, Unexpected Windfall).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const treasuresOf = (s: St, p: PlayerId) =>
  s.zones.perPlayer[p]!.battlefield.filter((id) => getDef(s.objects[id]!.defName).name === 'Treasure')

describe('CARD24 — Village Rites (sacrifice a creature)', () => {
  it('sacrifices the chosen creature and draws two', () => {
    const { state, A } = makeDuel()
    const rites = putCard(state, A, 'Village Rites', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.cast', objId: rites, targets: [], sacrifices: [bear] })
    expect(state.objects[bear]!.zone).toBe('graveyard') // paid as the spell went on the stack
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1 + 2) // the spell left, 2 drawn
  })

  it('rejects no sacrifice, the wrong count, an opponent\'s creature and a noncreature', () => {
    const { state, A, B } = makeDuel()
    const rites = putCard(state, A, 'Village Rites', 'hand')
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const rock = putCard(state, A, 'Sol Ring', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: rites, targets: [] })).toThrow(/Sacrifice exactly 1/)
    expect(() => act(state, A, { type: 'r.cast', objId: rites, targets: [], sacrifices: [mine, rock] })).toThrow(/Sacrifice exactly 1/)
    expect(() => act(state, A, { type: 'r.cast', objId: rites, targets: [], sacrifices: [theirs] })).toThrow(/Not a legal permanent/)
    expect(() => act(state, A, { type: 'r.cast', objId: rites, targets: [], sacrifices: [rock] })).toThrow(/Not a legal permanent/)
    // nothing was paid by any of those attempts
    expect(state.objects[mine]!.zone).toBe('battlefield')
    expect(state.objects[rock]!.zone).toBe('battlefield')
    expect(state.players[A]!.manaPool.B).toBe(1)
  })

  it('is not castable with no creature to sacrifice', () => {
    const { state, A } = makeDuel()
    const rites = putCard(state, A, 'Village Rites', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    expect(computeLegal(state, A).castableIds).not.toContain(rites)
    putCard(state, A, 'Grizzly Bears', 'battlefield')
    const legal = computeLegal(state, A)
    expect(legal.castableIds).toContain(rites)
    expect(legal.castExtraCost).toEqual(
      expect.arrayContaining([expect.objectContaining({ objId: rites, sacrifice: 1, sacFilter: 'creature', discard: 0 })]),
    )
  })

  it("the sacrifice's dies trigger resolves ABOVE the spell", () => {
    const { state, A, B } = makeDuel()
    const rites = putCard(state, A, 'Village Rites', 'hand')
    putCard(state, A, 'Blood Artist', 'battlefield') // watches any creature dying
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.cast', objId: rites, targets: [], sacrifices: [bear] })
    // the sacrifice happened with Village Rites already on the stack, so Blood Artist's TARGETED
    // dies trigger interrupts for its target choice while the spell waits underneath
    expect(state.pending?.kind).toBe('trigger')
    expect(state.zones.stack[0]!.id).toBe(rites)
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    // the trigger is now ABOVE Village Rites: it drains before the spell resolves
    expect(state.zones.stack.length).toBe(2)
    expect(state.zones.stack[1]!.trigger).toBe('dies')
    until(state, (s) => s.players[B]!.life !== 40, 'the drain')
    expect(state.players[B]!.life).toBe(39)
    expect(state.zones.stack.some((it) => it.id === rites)).toBe(true) // Rites still waiting
    resolve(state, A)
  })
})

describe('CARD24 — Deadly Dispute (sacrifice an artifact OR creature)', () => {
  it('accepts an artifact and gives two cards plus a Treasure', () => {
    const { state, A } = makeDuel()
    const dispute = putCard(state, A, 'Deadly Dispute', 'hand')
    const rock = putCard(state, A, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: dispute, targets: [], sacrifices: [rock] })
    expect(state.objects[rock]!.zone).toBe('graveyard')
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1 + 2)
    expect(treasuresOf(state, A).length).toBe(1)
  })

  it('accepts a creature too', () => {
    const { state, A } = makeDuel()
    const dispute = putCard(state, A, 'Deadly Dispute', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: dispute, targets: [], sacrifices: [bear] })
    expect(state.objects[bear]!.zone).toBe('graveyard')
    resolve(state, A)
    expect(treasuresOf(state, A).length).toBe(1)
  })

  it('rejects a land', () => {
    const { state, A } = makeDuel()
    const dispute = putCard(state, A, 'Deadly Dispute', 'hand')
    const land = putCard(state, A, 'Mountain', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: dispute, targets: [], sacrifices: [land] })).toThrow(/Not a legal permanent/)
  })
})

describe('CARD24 — the discard-a-card spells', () => {
  const CASES: [string, ManaColor, number, number][] = [
    ['Thrill of Possibility', 'R', 1, 0], // {1}{R} → 1 generic, no Treasures
    ['Big Score', 'R', 3, 2],
    ['Unexpected Windfall', 'R', 2, 2],
  ]
  for (const [name, colour, generic, treasures] of CASES) {
    it(`${name}: discards the chosen card, draws two${treasures ? ` and makes ${treasures} Treasures` : ''}`, () => {
      const { state, A } = makeDuel()
      const spell = putCard(state, A, name, 'hand')
      toStep(state, 'main1')
      addMana(state, A, colour, name === 'Unexpected Windfall' ? 2 : 1)
      addMana(state, A, 'C', generic)
      const hand = state.zones.perPlayer[A]!.hand
      const toDiscard = hand.find((id) => id !== spell)!
      const handBefore = hand.length
      act(state, A, { type: 'r.cast', objId: spell, targets: [], discards: [toDiscard] })
      expect(state.objects[toDiscard]!.zone).toBe('graveyard') // paid before the spell resolves
      resolve(state, A)
      expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 2 + 2) // spell + discard out, 2 in
      expect(treasuresOf(state, A).length).toBe(treasures)
    })
  }

  it('cannot discard the spell itself, or a card in another hand', () => {
    const { state, A, B } = makeDuel()
    const thrill = putCard(state, A, 'Thrill of Possibility', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: thrill, targets: [], discards: [thrill] })).toThrow(/casting/)
    const theirs = state.zones.perPlayer[B]!.hand[0]!
    expect(() => act(state, A, { type: 'r.cast', objId: thrill, targets: [], discards: [theirs] })).toThrow(/Not a card in your hand/)
    expect(() => act(state, A, { type: 'r.cast', objId: thrill, targets: [] })).toThrow(/Discard exactly 1/)
    expect(state.objects[thrill]!.zone).toBe('hand')
  })

  it('is not castable with an empty hand besides itself', () => {
    const { state, A } = makeDuel()
    const thrill = putCard(state, A, 'Thrill of Possibility', 'hand')
    // empty A's hand except the spell
    const hand = state.zones.perPlayer[A]!.hand
    state.zones.perPlayer[A]!.hand = [thrill]
    for (const id of hand) if (id !== thrill) state.objects[id]!.zone = 'exile'
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 1)
    expect(computeLegal(state, A).castableIds).not.toContain(thrill)
  })
})
