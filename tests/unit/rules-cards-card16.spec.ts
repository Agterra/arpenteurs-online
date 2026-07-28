/**
 * Perpetual card coverage — batch CARD16: CAST triggers (CR 603.2, "whenever an opponent casts a
 * spell") with the "…unless that player pays {N}" decision. Cards: Rhystic Study, Esper Sentinel.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const handOf = (s: St, p: PlayerId) => s.zones.perPlayer[p]!.hand.length

/** pass priority until the tax decision opens (a cast trigger resolves off the stack, CR 603.2) */
const waitTax = (s: St) => until(s, (x) => x.pending?.kind === 'optionalPay', 'the tax decision')
/** let the stack drain, stopping early if a tax decision opens */
const settle = (s: St) => until(s, (x) => !x.zones.stack.length || x.pending?.kind === 'optionalPay', 'the stack settles')

/** B casts Shock at A during A's turn (an instant, so timing is always legal). */
const bShocks = (s: St, A: PlayerId, B: PlayerId) => {
  const shock = s.zones.perPlayer[B]!.hand.find((id) => s.objects[id]!.defName.includes('shock')) ?? putCard(s, B, 'Shock', 'hand')
  addMana(s, B, 'R', 1)
  act(s, B, { type: 'r.cast', objId: shock, targets: [A] })
  return shock
}

describe('CARD16 — Rhystic Study', () => {
  it("the opponent's cast opens the tax on THEM, and paying stops the draw", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Rhystic Study', 'battlefield')
    putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    const drawnBefore = handOf(state, A)
    addMana(state, B, 'C', 1) // the {1} for the tax
    bShocks(state, A, B)
    waitTax(state)
    expect(state.pending?.kind).toBe('optionalPay')
    expect(state.pending?.player).toBe(B) // the CASTER decides, not Rhystic's controller
    act(state, B, { type: 'r.optionalPay', pay: true })
    expect(state.players[B]!.manaPool.C).toBe(0)
    expect(handOf(state, A)).toBe(drawnBefore) // paid → no card for A
    expect(state.log.some((l) => /does nothing/.test(l))).toBe(true)
  })

  it('declining lets Rhystic Study draw a card for its controller', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Rhystic Study', 'battlefield')
    putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    const drawnBefore = handOf(state, A)
    bShocks(state, A, B)
    waitTax(state)
    act(state, B, { type: 'r.optionalPay', pay: false })
    expect(handOf(state, A)).toBe(drawnBefore + 1)
  })

  it('the trigger resolves BEFORE the taxed spell (it is put on the stack above it)', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Rhystic Study', 'battlefield')
    putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    const shock = bShocks(state, A, B)
    waitTax(state)
    // the decision is open while Shock is still on the stack, undealt
    expect(state.zones.stack.some((it) => it.id === shock)).toBe(true)
    expect(state.players[A]!.life).toBe(40)
    act(state, B, { type: 'r.optionalPay', pay: false })
    until(state, (s) => !s.zones.stack.length, 'Shock resolves')
    expect(state.players[A]!.life).toBe(38)
  })

  it('does not trigger on its OWN controller casting a spell', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Rhystic Study', 'battlefield')
    const shock = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [A] })
    settle(state)
    expect(state.pending).toBeFalsy()
  })

  it('redact prompts only the payer, with the cost, source name and affordability', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Rhystic Study', 'battlefield')
    putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    bShocks(state, A, B)
    waitTax(state)
    const forB = computeLegal(state, B)
    expect(forB.needsOptionalPay).toBe(true)
    expect(forB.optionalPayCost).toBe('{1}')
    expect(forB.optionalPaySourceName).toBe('Rhystic Study')
    expect(forB.optionalPayAffordable).toBe(false) // B floated nothing
    expect(computeLegal(state, A).needsOptionalPay).toBe(false)
  })

  it('claiming to pay without the mana is rejected (the decision stays open)', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Rhystic Study', 'battlefield')
    putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    bShocks(state, A, B)
    waitTax(state)
    expect(() => act(state, B, { type: 'r.optionalPay', pay: true })).toThrow(/Not enough mana/)
    expect(state.pending?.kind).toBe('optionalPay')
    act(state, B, { type: 'r.optionalPay', pay: false }) // still answerable
    expect(state.pending).toBeFalsy()
  })

  it('a conceding payer does not wedge the game', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Rhystic Study', 'battlefield')
    putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    bShocks(state, A, B)
    waitTax(state)
    act(state, B, { type: 'r.concede' })
    expect(state.pending).toBeFalsy()
    expect(state.status).toBe('ended')
  })
})

describe('CARD16 — Esper Sentinel', () => {
  it('taxes only the FIRST noncreature spell each turn, at {X} = its power', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Esper Sentinel', 'battlefield') // 1/1 → tax {1}
    putCard(state, B, 'Shock', 'hand')
    putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    const drawnBefore = handOf(state, A)
    bShocks(state, A, B)
    waitTax(state)
    expect(state.pending?.kind).toBe('optionalPay')
    expect(computeLegal(state, B).optionalPayCost).toBe('{1}') // X = power 1
    act(state, B, { type: 'r.optionalPay', pay: false })
    expect(handOf(state, A)).toBe(drawnBefore + 1)
    until(state, (s) => !s.zones.stack.length, 'first Shock resolves')
    // the SECOND noncreature spell this turn is untaxed
    pass(state, A)
    bShocks(state, A, B)
    settle(state)
    expect(state.pending).toBeFalsy()
  })

  it('does not trigger on a creature spell', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Esper Sentinel', 'battlefield')
    const ogre = putCard(state, B, 'Gray Ogre', 'hand')
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    addMana(state, B, 'R', 1)
    addMana(state, B, 'C', 2)
    act(state, B, { type: 'r.cast', objId: ogre, targets: [] })
    settle(state)
    expect(state.pending).toBeFalsy()
  })

  it('the tax follows its CURRENT power (an anthem raises it)', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Esper Sentinel', 'battlefield')
    putCard(state, A, 'Glorious Anthem', 'battlefield') // creatures you control get +1/+1
    putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    bShocks(state, A, B)
    waitTax(state)
    expect(computeLegal(state, B).optionalPayCost).toBe('{2}') // 1/1 + anthem → X = 2
    act(state, B, { type: 'r.optionalPay', pay: false })
  })

  it('the counter is per turn: the next turn taxes again', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Esper Sentinel', 'battlefield')
    putCard(state, B, 'Shock', 'hand')
    putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    bShocks(state, A, B)
    waitTax(state)
    act(state, B, { type: 'r.optionalPay', pay: false })
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    const drawnBefore = handOf(state, A)
    bShocks(state, A, B)
    waitTax(state)
    expect(state.pending?.kind).toBe('optionalPay')
    act(state, B, { type: 'r.optionalPay', pay: false })
    expect(handOf(state, A)).toBe(drawnBefore + 1)
  })
})
