/**
 * Perpetual card coverage — batch CARD33: attack taxes (Propaganda, Ghostly Prison, Windborn Muse)
 * charged as attackers are declared, and Frantic Search (draw 2, discard 2, then untap three lands).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, makeGameN, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const poolTotal = (s: St, p: PlayerId) => Object.values(s.players[p]!.manaPool).reduce((a, b) => a + b, 0)

describe('CARD33 — attack taxes', () => {
  for (const card of ['Propaganda', 'Ghostly Prison', 'Windborn Muse']) {
    it(`${card}: attacking costs {2} per attacker, and is refused unpaid`, () => {
      const { state, A, B } = makeDuel()
      putCard(state, B, card, 'battlefield')
      const a1 = putCard(state, A, 'Gray Ogre', 'battlefield')
      const a2 = putCard(state, A, 'Hill Giant', 'battlefield')
      for (const id of [a1, a2]) state.objects[id]!.summoningSick = false
      toStep(state, 'main1')
      until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
      expect(computeLegal(state, A).attackTaxPerCreature[B]).toBe(2)
      // no mana floated → the declaration is illegal and nothing is marked
      expect(() =>
        act(state, A, { type: 'r.attackers', attacks: [{ attackerId: a1, defenderId: B }] }),
      ).toThrow(/Attacking costs \{2\}/)
      expect(state.objects[a1]!.attackingDefender).toBeFalsy()
      // one attacker for {2}
      addMana(state, A, 'C', 2)
      act(state, A, { type: 'r.attackers', attacks: [{ attackerId: a1, defenderId: B }] })
      expect(poolTotal(state, A)).toBe(0)
      expect(state.objects[a1]!.attackingDefender).toBe(B)
      expect(state.objects[a2]!.attackingDefender).toBeFalsy()
    })
  }

  it('two attackers cost {4}, and a partial pool is refused', () => {
    const { state, A, B } = makeDuel()
    putCard(state, B, 'Propaganda', 'battlefield')
    const a1 = putCard(state, A, 'Gray Ogre', 'battlefield')
    const a2 = putCard(state, A, 'Hill Giant', 'battlefield')
    for (const id of [a1, a2]) state.objects[id]!.summoningSick = false
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers', 'declare attackers')
    addMana(state, A, 'C', 3)
    const attacks = [
      { attackerId: a1, defenderId: B },
      { attackerId: a2, defenderId: B },
    ]
    expect(() => act(state, A, { type: 'r.attackers', attacks })).toThrow(/Attacking costs \{4\}/)
    expect(poolTotal(state, A)).toBe(3) // nothing was spent
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.attackers', attacks })
    expect(poolTotal(state, A)).toBe(0)
  })

  it('two taxing permanents stack to {4} for one attacker', () => {
    const { state, A, B } = makeDuel()
    putCard(state, B, 'Propaganda', 'battlefield')
    putCard(state, B, 'Ghostly Prison', 'battlefield')
    const a1 = putCard(state, A, 'Gray Ogre', 'battlefield')
    state.objects[a1]!.summoningSick = false
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers', 'declare attackers')
    expect(computeLegal(state, A).attackTaxPerCreature[B]).toBe(4)
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.attackers', attacks: [{ attackerId: a1, defenderId: B }] })
    expect(poolTotal(state, A)).toBe(0)
  })

  it('attacking a DIFFERENT player is free', () => {
    const { state } = makeGameN(3)
    const A = state.activePlayer
    const [taxer, other] = state.turnOrder.filter((p) => p !== A)
    putCard(state, taxer!, 'Ghostly Prison', 'battlefield')
    const a1 = putCard(state, A, 'Gray Ogre', 'battlefield')
    state.objects[a1]!.summoningSick = false
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    const legal = computeLegal(state, A)
    expect(legal.attackTaxPerCreature[taxer!]).toBe(2)
    expect(legal.attackTaxPerCreature[other!]).toBeUndefined()
    act(state, A, { type: 'r.attackers', attacks: [{ attackerId: a1, defenderId: other! }] })
    expect(state.objects[a1]!.attackingDefender).toBe(other)
  })

  it('declaring no attackers is always free', () => {
    const { state, A, B } = makeDuel()
    putCard(state, B, 'Propaganda', 'battlefield')
    putCard(state, A, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers', 'declare attackers')
    act(state, A, { type: 'r.attackers', attacks: [] })
    expect(state.pending?.kind).not.toBe('attackers')
  })
})

describe('CARD33 — Frantic Search', () => {
  it('draws two, discards two, then untaps up to three of your lands', () => {
    const { state, A } = makeDuel()
    const search = putCard(state, A, 'Frantic Search', 'hand')
    const lands = [1, 2, 3, 4].map(() => putCard(state, A, 'Mountain', 'battlefield'))
    for (const l of lands) state.objects[l]!.tapped = true
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: search, targets: [] })
    until(state, (s) => s.pending?.kind === 'discard' && s.pending.player === A, 'the discard')
    expect(state.pendingDiscard!.count).toBe(2)
    const hand = state.zones.perPlayer[A]!.hand
    act(state, A, { type: 'r.discard', objIds: [hand[0]!, hand[1]!] })
    // net: −1 spell, +2 drawn, −2 discarded
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1)
    // exactly three of the four tapped lands are untapped again
    expect(lands.filter((l) => !state.objects[l]!.tapped).length).toBe(3)
    expect(state.log.some((l) => /untaps 3 lands/.test(l))).toBe(true)
  })

  it('untaps only lands, and only as many as are tapped', () => {
    const { state, A } = makeDuel()
    const search = putCard(state, A, 'Frantic Search', 'hand')
    const land = putCard(state, A, 'Mountain', 'battlefield')
    const rock = putCard(state, A, 'Sol Ring', 'battlefield')
    state.objects[land]!.tapped = true
    state.objects[rock]!.tapped = true
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: search, targets: [] })
    until(state, (s) => s.pending?.kind === 'discard', 'the discard')
    const hand = state.zones.perPlayer[A]!.hand
    act(state, A, { type: 'r.discard', objIds: [hand[0]!, hand[1]!] })
    expect(state.objects[land]!.tapped).toBe(false)
    expect(state.objects[rock]!.tapped).toBe(true) // an artifact is not a land
  })

  it("does not untap an opponent's lands", () => {
    const { state, A, B } = makeDuel()
    const search = putCard(state, A, 'Frantic Search', 'hand')
    const theirs = putCard(state, B, 'Mountain', 'battlefield')
    state.objects[theirs]!.tapped = true
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: search, targets: [] })
    until(state, (s) => s.pending?.kind === 'discard', 'the discard')
    const hand = state.zones.perPlayer[A]!.hand
    act(state, A, { type: 'r.discard', objIds: [hand[0]!, hand[1]!] })
    expect(state.objects[theirs]!.tapped).toBe(true)
  })
})
