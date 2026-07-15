/**
 * Coverage batch T: turn-based triggered abilities.
 *  - `upkeep` triggers ("at the beginning of your upkeep, …") fire in the upkeep
 *    step for the active player's permanents (Phyrexian Arena, Bitterblossom).
 *  - `attacks` triggers ("whenever this creature attacks, …") — previously declared
 *    in the DSL but never fired — now go on the stack when a creature is declared
 *    as an attacker (Borderland Marauder, Vicious Conquistador, Audacious Thief).
 * All are non-targeted and use existing effect primitives; no new leak surface
 * beyond `drawCards`/`createToken`, which the fuzzer already covers.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = ReturnType<typeof makeDuel>['state']

/** Advance to the active player's NEXT upkeep resolving (turn 3 main1 in a 2p game). */
function toNextOwnUpkeepResolved(state: St, A: string) {
  until(
    state,
    (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A && !s.zones.stack.length,
    "reach A's next upkeep (resolved)",
  )
}

/** Declare a single attacker at `B`, then let its attack triggers resolve. */
function declareAttack(state: St, A: string, B: string, attackerId: string) {
  until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'A declares attackers')
  act(state, A, { type: 'r.attackers', attacks: [{ attackerId, defenderId: B }] })
  until(state, (s) => !s.zones.stack.length, 'attack triggers resolve')
}

describe('Phyrexian Arena — at the beginning of your upkeep, draw 1 and lose 1', () => {
  it('drains its controller exactly 1 life on their upkeep', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Phyrexian Arena', 'battlefield')
    const lifeBefore = state.players[A]!.life
    const handBefore = state.zones.perPlayer[A]!.hand.length
    toNextOwnUpkeepResolved(state, A)
    expect(state.players[A]!.life).toBe(lifeBefore - 1) // only life change is the Arena
    // Arena draw + the turn-3 draw both landed (hand grew even after any cleanup discard)
    expect(state.zones.perPlayer[A]!.hand.length).toBeGreaterThan(handBefore)
  })
})

describe('Bitterblossom — at the beginning of your upkeep, lose 1 and make a Faerie', () => {
  it('creates a 1/1 flying Faerie token and drains 1 life on the upkeep', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Bitterblossom', 'battlefield')
    const lifeBefore = state.players[A]!.life
    toNextOwnUpkeepResolved(state, A)
    expect(state.players[A]!.life).toBe(lifeBefore - 1)
    const faeries = state.zones.perPlayer[A]!.battlefield.filter(
      (id) => getDef(state.objects[id]!.defName).name === 'Faerie Rogue',
    )
    expect(faeries.length).toBe(1)
    const tok = state.objects[faeries[0]!]!
    expect(getDef(tok.defName).keywords).toContain('flying')
    expect(getDef(tok.defName).power).toBe(1)
  })
})

describe('Borderland Marauder — whenever this attacks, it gets +2/+0', () => {
  it('pumps itself when it is declared as an attacker', () => {
    const { state, A, B } = makeDuel()
    const marauder = putCard(state, A, 'Borderland Marauder', 'battlefield')
    declareAttack(state, A, B, marauder)
    const card = redactRulesState(state, A).cards[marauder]!
    expect(card.power).toBe(3) // 1 + 2
    expect(card.toughness).toBe(2)
  })
})

describe('Vicious Conquistador — whenever this attacks, each opponent loses 1', () => {
  it('drains the opponent via the attack trigger (before combat damage)', () => {
    const { state, A, B } = makeDuel()
    const conq = putCard(state, A, 'Vicious Conquistador', 'battlefield')
    const bLife = state.players[B]!.life
    declareAttack(state, A, B, conq)
    // asserted right after the trigger resolves — still in declare_attackers, no combat yet
    expect(state.players[B]!.life).toBe(bLife - 1)
  })
})

describe('Audacious Thief — whenever this attacks, draw 1 and lose 1', () => {
  it('draws a card and loses 1 life for its controller on attack', () => {
    const { state, A, B } = makeDuel()
    const thief = putCard(state, A, 'Audacious Thief', 'battlefield')
    const aLife = state.players[A]!.life
    const aHand = state.zones.perPlayer[A]!.hand.length
    declareAttack(state, A, B, thief)
    expect(state.players[A]!.life).toBe(aLife - 1)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(aHand + 1)
  })
})
