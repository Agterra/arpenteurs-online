/**
 * Perpetual card coverage — batch CARD59: Arcane Denial — a counterspell whose compensation lands "at
 * the beginning of the NEXT TURN's upkeep", whoever's turn that is. Two new pieces: a delayed trigger
 * that fires at the first such upkeep rather than waiting for its own player's next turn
 * (`anyPlayersTurn`) and scheduled FOR THE COUNTERED SPELL'S CONTROLLER (`forTargets`), plus a
 * "you may draw up to N" decision (r.mayDraw).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
/** A casts a Shock, B counters it with Arcane Denial */
const denyAShock = (s: St, A: PlayerId, B: PlayerId) => {
  const shock = putCard(s, A, 'Shock', 'hand')
  const denial = putCard(s, B, 'Arcane Denial', 'hand')
  toStep(s, 'main1')
  addMana(s, A, 'R', 1)
  act(s, A, { type: 'r.cast', objId: shock, targets: [B] })
  pass(s, A)
  addMana(s, B, 'U', 1)
  addMana(s, B, 'C', 1)
  act(s, B, { type: 'r.cast', objId: denial, targets: [shock] })
  until(s, (x) => !x.zones.stack.length, 'both resolve')
  return { shock, denial }
}

describe('CARD59 — Arcane Denial', () => {
  it('counters the spell and schedules a draw for each player', () => {
    const { state, A, B } = makeDuel()
    const { shock } = denyAShock(state, A, B)
    expect(state.objects[shock]!.zone).toBe('graveyard')
    expect(state.players[B]!.life).toBe(40) // the Shock never resolved
    const scheduled = (state.delayedTriggers ?? []).map((d) => `${d.key}:${d.player === A ? 'A' : 'B'}`)
    expect(scheduled).toContain('victimDraws:A') // the countered spell's controller
    expect(scheduled).toContain('casterDraws:B')
    expect((state.delayedTriggers ?? []).every((d) => d.anyPlayersTurn)).toBe(true)
  })

  it('the victim may draw up to two at the very next upkeep', () => {
    const { state, A, B } = makeDuel()
    denyAShock(state, A, B)
    const turn = state.turnNumber
    // the NEXT turn is B's, and A's compensation still fires then (that is the anyPlayersTurn part)
    until(state, (s) => s.pending?.kind === 'mayDraw' || s.turnNumber > turn + 1, 'the may-draw decision')
    expect(state.pending?.kind).toBe('mayDraw')
    expect(state.pending!.player).toBe(A)
    expect(state.turnNumber).toBe(turn + 1)
    expect(state.activePlayer).toBe(B) // …on B's turn
    const legal = computeLegal(state, A)
    expect(legal.needsMayDraw).toBe(true)
    expect(legal.mayDrawMax).toBe(2)
    expect(legal.mayDrawSourceName).toBe('Arcane Denial')
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.mayDraw', count: 2 })
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 2)
  })

  it('the victim may draw fewer, or none at all', () => {
    const { state, A, B } = makeDuel()
    denyAShock(state, A, B)
    until(state, (s) => s.pending?.kind === 'mayDraw', 'the may-draw decision')
    const hand = state.zones.perPlayer[A]!.hand.length
    expect(() => act(state, A, { type: 'r.mayDraw', count: 3 })).toThrow(/Draw at most 2/)
    act(state, A, { type: 'r.mayDraw', count: 0 })
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand)
    expect(state.log.some((l) => /declines to draw \(Arcane Denial\)/.test(l))).toBe(true)
  })

  it("the caster's own draw happens with no decision", () => {
    const { state, A, B } = makeDuel()
    denyAShock(state, A, B)
    const before = state.zones.perPlayer[B]!.hand.length
    until(state, (s) => s.pending?.kind === 'mayDraw', 'the victim decision')
    act(state, A, { type: 'r.mayDraw', count: 0 })
    until(state, (s) => s.zones.perPlayer[B]!.hand.length !== before || s.turnNumber > 3, "B's draw")
    // B drew from Arcane Denial (and, being the active player, also for the turn)
    expect(state.zones.perPlayer[B]!.hand.length).toBeGreaterThan(before)
    expect(state.log.some((l) => /Arcane Denial/.test(l))).toBe(true)
  })

  it('both delayed triggers are gone afterwards', () => {
    const { state, A, B } = makeDuel()
    denyAShock(state, A, B)
    until(state, (s) => s.pending?.kind === 'mayDraw', 'the victim decision')
    act(state, A, { type: 'r.mayDraw', count: 1 })
    until(state, (s) => (s.delayedTriggers ?? []).length === 0 || s.turnNumber > 4, 'both fired')
    expect(state.delayedTriggers ?? []).toEqual([])
  })
})
