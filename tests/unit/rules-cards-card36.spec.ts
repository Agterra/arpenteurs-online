/**
 * Perpetual card coverage — batch CARD36: DELAYED triggers (CR 603.7) — Mana Drain ("at the beginning
 * of your next main phase, add {C} equal to that spell's mana value") and Pact of Negation ("at the
 * beginning of your next upkeep, pay {3}{U}{U} or you lose the game").
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })

/** B casts Hill Giant ({3}{R} → mana value 4) on their own turn; A answers with `counter`. */
const bCastsGiantThenACounters = (s: St, A: PlayerId, B: PlayerId, counter: string) => {
  const spell = putCard(s, A, counter, 'hand')
  const giant = putCard(s, B, 'Hill Giant', 'hand')
  until(s, (x) => x.turnNumber === 2 && x.activePlayer === B && x.step === 'main1' && x.priorityPlayer === B, "B's turn")
  addMana(s, B, 'R', 1)
  addMana(s, B, 'C', 3)
  act(s, B, { type: 'r.cast', objId: giant, targets: [] })
  pass(s, B)
  addMana(s, A, 'U', 2)
  act(s, A, { type: 'r.cast', objId: spell, targets: [giant] })
  until(s, (x) => !x.zones.stack.length, 'both resolve')
  return giant
}

describe('CARD36 — Mana Drain', () => {
  it('counters the spell and adds {C} equal to its mana value at your next main phase', () => {
    const { state, A, B } = makeDuel()
    const giant = bCastsGiantThenACounters(state, A, B, 'Mana Drain')
    expect(state.objects[giant]!.zone).toBe('graveyard')
    expect(state.delayedTriggers.length).toBe(1)
    expect(state.delayedTriggers[0]!.x).toBe(4) // Hill Giant's mana value ({3}{R})
    expect(state.players[A]!.manaPool.C).toBe(0) // nothing yet
    // A's own next main phase: the mana appears
    until(state, (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1', "A's main phase")
    expect(state.players[A]!.manaPool.C).toBe(4)
    expect(state.delayedTriggers.length).toBe(0) // and the trigger is spent
  })

  it('does not fire on the opponent\'s main phase', () => {
    const { state, A, B } = makeDuel()
    bCastsGiantThenACounters(state, A, B, 'Mana Drain')
    // still B's turn (the counter happened during it) — no mana for A yet
    expect(state.players[A]!.manaPool.C).toBe(0)
    expect(state.delayedTriggers.length).toBe(1)
  })
})

describe('CARD36 — Pact of Negation', () => {
  it('counters for {0}, then demands {3}{U}{U} at your next upkeep', () => {
    const { state, A, B } = makeDuel()
    const giant = bCastsGiantThenACounters(state, A, B, 'Pact of Negation')
    expect(state.objects[giant]!.zone).toBe('graveyard')
    expect(state.delayedTriggers[0]!.at).toBe('nextUpkeep')
    // A's next upkeep opens the pay-or-lose decision
    until(state, (s) => s.pending?.kind === 'optionalPay', "A's pact upkeep")
    expect(state.pending!.player).toBe(A)
    const legal = computeLegal(state, A)
    expect(legal.needsOptionalPay).toBe(true)
    expect(legal.optionalPayCost).toBe('{3}{U}{U}')
    expect(legal.optionalPaySourceName).toBe('Pact of Negation')
    addMana(state, A, 'U', 2)
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.optionalPay', pay: true })
    expect(state.players[A]!.hasLost).toBe(false)
    expect(state.players[A]!.manaPool.U).toBe(0)
  })

  it('losing the game when it goes unpaid', () => {
    const { state, A, B } = makeDuel()
    bCastsGiantThenACounters(state, A, B, 'Pact of Negation')
    until(state, (s) => s.pending?.kind === 'optionalPay', "A's pact upkeep")
    act(state, A, { type: 'r.optionalPay', pay: false })
    expect(state.players[A]!.hasLost).toBe(true)
    expect(state.status).toBe('ended')
    expect(state.winner).toBe(B)
    expect(state.log.some((l) => /unpaid pact/.test(l))).toBe(true)
  })

  it('an unaffordable claim to pay is rejected, leaving the decision open', () => {
    const { state, A, B } = makeDuel()
    bCastsGiantThenACounters(state, A, B, 'Pact of Negation')
    until(state, (s) => s.pending?.kind === 'optionalPay', "A's pact upkeep")
    expect(() => act(state, A, { type: 'r.optionalPay', pay: true })).toThrow(/Not enough mana/)
    expect(state.pending?.kind).toBe('optionalPay')
    expect(state.players[A]!.hasLost).toBe(false)
  })
})
