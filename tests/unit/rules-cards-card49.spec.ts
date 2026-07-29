/**
 * Perpetual card coverage — batch CARD49: "This permanent doesn't untap during your untap step" —
 * Mana Vault (an upkeep "you may pay {4}: if you do, untap it", the mirror of the unless-pay clause,
 * plus a DRAW-STEP trigger that only bites while it is still tapped) and the two Monoliths, which
 * untap with an activated ability instead.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const poolTotal = (s: St, p: PlayerId) => Object.values(s.players[p]!.manaPool).reduce((a, b) => a + b, 0)

describe('CARD49 — Mana Vault', () => {
  it('taps for three colourless and stays tapped through your untap step', () => {
    const { state, A } = makeDuel()
    const vault = putCard(state, A, 'Mana Vault', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: vault })
    expect(state.players[A]!.manaPool.C).toBe(3)
    // …to your next turn: the untap step leaves it tapped, and the upkeep asks for {4}
    const turn = state.turnNumber
    until(state, (s) => s.turnNumber > turn && s.activePlayer === A && s.step === 'upkeep', "A's next upkeep")
    expect(state.objects[vault]!.tapped).toBe(true)
  })

  it('untaps when you pay {4} at your upkeep, and then takes no damage', () => {
    const { state, A } = makeDuel()
    const vault = putCard(state, A, 'Mana Vault', 'battlefield')
    state.objects[vault]!.tapped = true
    until(state, (s) => s.pending?.kind === 'optionalPay' && s.pending.player === A, 'the upkeep payment')
    const legal = computeLegal(state, A)
    expect(legal.needsOptionalPay).toBe(true)
    expect(legal.optionalPayCost).toBe('{4}')
    // pay it: the Vault untaps, so the draw-step trigger finds it untapped and does nothing
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.optionalPay', pay: true })
    expect(state.objects[vault]!.tapped).toBe(false)
    const life = state.players[A]!.life
    until(state, (s) => s.step === 'main1', 'past the draw step')
    expect(state.players[A]!.life).toBe(life)
  })

  it('deals 1 damage at your DRAW step when you decline', () => {
    const { state, A } = makeDuel()
    const vault = putCard(state, A, 'Mana Vault', 'battlefield')
    state.objects[vault]!.tapped = true
    until(state, (s) => s.pending?.kind === 'optionalPay' && s.pending.player === A, 'the upkeep payment')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.optionalPay', pay: false })
    expect(state.objects[vault]!.tapped).toBe(true)
    until(state, (s) => s.step === 'main1' || s.players[A]!.life !== life, 'the draw step')
    expect(state.players[A]!.life).toBe(life - 1)
    expect(state.log.some((l) => /Mana Vault deals 1 damage/.test(l))).toBe(true)
  })

  it('an UNTAPPED Vault asks nothing and deals nothing', () => {
    const { state, A } = makeDuel()
    const vault = putCard(state, A, 'Mana Vault', 'battlefield')
    expect(state.objects[vault]!.tapped).toBe(false)
    const life = state.players[A]!.life
    // the upkeep trigger still fires (it is not conditional), so answer it if it opens
    until(state, (s) => s.step === 'main1' || s.pending?.kind === 'optionalPay', 'the upkeep')
    if (state.pending?.kind === 'optionalPay') act(state, A, { type: 'r.optionalPay', pay: false })
    until(state, (s) => s.step === 'main1', 'past the draw step')
    expect(state.players[A]!.life).toBe(life) // untapped → no damage
  })

  it('refuses the payment without the mana', () => {
    const { state, A } = makeDuel()
    const vault = putCard(state, A, 'Mana Vault', 'battlefield')
    state.objects[vault]!.tapped = true
    until(state, (s) => s.pending?.kind === 'optionalPay' && s.pending.player === A, 'the upkeep payment')
    expect(() => act(state, A, { type: 'r.optionalPay', pay: true })).toThrow(/Not enough mana/)
    expect(state.objects[vault]!.tapped).toBe(true)
  })
})

describe('CARD49 — Grim Monolith and Basalt Monolith', () => {
  for (const [card, cost] of [['Grim Monolith', '{4}'], ['Basalt Monolith', '{3}']] as const) {
    it(`${card}: taps for {C}{C}{C}, stays tapped, and untaps for ${cost}`, () => {
      const { state, A } = makeDuel()
      const rock = putCard(state, A, card, 'battlefield')
      toStep(state, 'main1')
      act(state, A, { type: 'r.tapMana', objId: rock })
      expect(state.players[A]!.manaPool.C).toBe(3)
      // its untap ability is offered with its own cost, and no {T}
      const ability = computeLegal(state, A).activations.find((a) => a.objId === rock)!
      expect(ability.cost).toBe(cost)
      expect(ability.taps).toBeUndefined()
      const need = Number(cost.slice(1, -1))
      // Grim Monolith's untap costs {4} but it only makes 3, so top up when needed
      const topUp = Math.max(0, need - 3)
      if (topUp) addMana(state, A, 'C', topUp)
      act(state, A, { type: 'r.activate', objId: rock, abilityIndex: 1, targets: [] })
      until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the untap resolves')
      expect(state.objects[rock]!.tapped).toBe(false)
      expect(poolTotal(state, A)).toBe(3 + topUp - need)
    })
  }

  it('a Monolith is still tapped after your untap step', () => {
    const { state, A } = makeDuel()
    const rock = putCard(state, A, 'Basalt Monolith', 'battlefield')
    state.objects[rock]!.tapped = true
    const turn = state.turnNumber
    until(state, (s) => s.turnNumber > turn && s.activePlayer === A && s.step === 'main1', "A's next main phase")
    expect(state.objects[rock]!.tapped).toBe(true)
    // …and an ordinary artifact DOES untap
    const ring = putCard(state, A, 'Sol Ring', 'battlefield')
    state.objects[ring]!.tapped = true
    const turn2 = state.turnNumber
    until(state, (s) => s.turnNumber > turn2 && s.activePlayer === A && s.step === 'main1', 'the turn after')
    expect(state.objects[ring]!.tapped).toBe(false)
    expect(state.objects[rock]!.tapped).toBe(true)
  })
})
