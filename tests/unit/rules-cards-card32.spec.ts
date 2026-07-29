/**
 * Perpetual card coverage — batch CARD32: the ten filter lands — "{a/b}, {T}: Add {a}{a}, {a}{b}, or
 * {b}{b}" (one mana in, two out, three combinations) alongside their plain "{T}: Add {C}".
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const poolTotal = (s: St, p: PlayerId) => Object.values(s.players[p]!.manaPool).reduce((a, b) => a + b, 0)

const FILTERS: [string, ManaColor, ManaColor][] = [
  ['Rugged Prairie', 'R', 'W'],
  ['Cascade Bluffs', 'U', 'R'],
  ['Flooded Grove', 'G', 'U'],
  ['Fetid Heath', 'W', 'B'],
  ['Twilight Mire', 'B', 'G'],
  ['Graven Cairns', 'B', 'R'],
  ['Mystic Gate', 'W', 'U'],
  ['Sunken Ruins', 'U', 'B'],
  ['Fire-Lit Thicket', 'R', 'G'],
  ['Wooded Bastion', 'G', 'W'],
]

describe('CARD32 — the ten filter lands', () => {
  for (const [land, a, b] of FILTERS) {
    it(`${land}: {${a}} in → {${a}}{${b}} out, and the plain {C} half still works`, () => {
      const { state, A } = makeDuel()
      const filter = putCard(state, A, land, 'battlefield')
      const plain = putCard(state, A, land, 'battlefield')
      toStep(state, 'main1')
      // the plain half: one colourless, no payment
      act(state, A, { type: 'r.tapMana', objId: plain, color: 'C' })
      expect(state.players[A]!.manaPool.C).toBe(1)
      // the filter half: spend the {C}? no — it needs one of its OWN colours
      expect(() => act(state, A, { type: 'r.tapMana', objId: filter, pair: 1, payColor: 'C' })).toThrow(/Pay one/)
      addMana(state, A, a, 1)
      act(state, A, { type: 'r.tapMana', objId: filter, pair: 1, payColor: a }) // the mixed pair
      expect(state.players[A]!.manaPool[a]).toBe(1) // paid one, got one back
      expect(state.players[A]!.manaPool[b]).toBe(1)
      expect(state.objects[filter]!.tapped).toBe(true)
    })
  }

  it('all three output pairs are available', () => {
    const { state, A } = makeDuel()
    const l1 = putCard(state, A, 'Fetid Heath', 'battlefield') // W/B
    const l2 = putCard(state, A, 'Fetid Heath', 'battlefield')
    const l3 = putCard(state, A, 'Fetid Heath', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'W', 3)
    act(state, A, { type: 'r.tapMana', objId: l1, pair: 0, payColor: 'W' }) // {W}{W}
    act(state, A, { type: 'r.tapMana', objId: l2, pair: 1, payColor: 'W' }) // {W}{B}
    act(state, A, { type: 'r.tapMana', objId: l3, pair: 2, payColor: 'W' }) // {B}{B}
    // 3 white spent; gained WW + WB + BB
    expect(state.players[A]!.manaPool.W).toBe(3)
    expect(state.players[A]!.manaPool.B).toBe(3)
    expect(poolTotal(state, A)).toBe(6)
  })

  it('either colour can pay the hybrid cost', () => {
    const { state, A } = makeDuel()
    const heath = putCard(state, A, 'Fetid Heath', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.tapMana', objId: heath, pair: 0, payColor: 'B' }) // pay black, take {W}{W}
    expect(state.players[A]!.manaPool.W).toBe(2)
    expect(state.players[A]!.manaPool.B).toBe(0)
  })

  it('needs the mana in the pool, a valid pair, and an untapped land', () => {
    const { state, A } = makeDuel()
    const heath = putCard(state, A, 'Fetid Heath', 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.tapMana', objId: heath, pair: 0, payColor: 'W' })).toThrow(/No \{W\} in your pool/)
    addMana(state, A, 'W', 1)
    expect(() => act(state, A, { type: 'r.tapMana', objId: heath, pair: 7, payColor: 'W' })).toThrow(/Choose which two mana/)
    act(state, A, { type: 'r.tapMana', objId: heath, pair: 0, payColor: 'W' })
    expect(() => act(state, A, { type: 'r.tapMana', objId: heath, pair: 0, payColor: 'W' })).toThrow(/Already tapped/)
  })

  it('redact offers the filter only while its cost is payable, with its pairs', () => {
    const { state, A } = makeDuel()
    const heath = putCard(state, A, 'Fetid Heath', 'battlefield')
    toStep(state, 'main1')
    expect(computeLegal(state, A).manaFilters).toEqual([]) // empty pool → not offered
    expect(computeLegal(state, A).manaSourceIds).toContain(heath) // but the plain {C} half is
    addMana(state, A, 'B', 1)
    const filters = computeLegal(state, A).manaFilters
    expect(filters).toEqual([
      { objId: heath, payFrom: ['W', 'B'], outputs: [['W', 'W'], ['W', 'B'], ['B', 'B']] },
    ])
    // once tapped, neither half is offered
    state.objects[heath]!.tapped = true
    expect(computeLegal(state, A).manaFilters).toEqual([])
    expect(computeLegal(state, A).manaSourceIds).not.toContain(heath)
  })

  it('the filtered mana really pays for a spell', () => {
    const { state, A, B } = makeDuel()
    const heath = putCard(state, A, 'Fetid Heath', 'battlefield')
    const murder = putCard(state, A, 'Murder', 'hand') // {1}{B}{B}
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.tapMana', objId: heath, pair: 2, payColor: 'W' }) // {W} → {B}{B}
    expect(computeLegal(state, A).castableIds).toContain(murder)
    act(state, A, { type: 'r.cast', objId: murder, targets: [bear] })
    expect(poolTotal(state, A)).toBe(0) // {1}{B}{B} paid exactly
  })
})
