/**
 * Perpetual card coverage — batch CARD8: the most-played utility lands (Command Tower,
 * Exotic Orchard — any-colour taplands, simplified as for Arcane Signet / Fellwar Stone) and
 * the new "You have no maximum hand size." static (Reliquary Tower, Thought Vessel).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState

/** Fill a player's hand up to `n` cards (opening hand is 7). */
const handTo = (s: St, p: PlayerId, n: number) => {
  while (s.zones.perPlayer[p]!.hand.length < n) putCard(s, p, 'Mountain', 'hand')
  return s.zones.perPlayer[p]!.hand.length
}

/** Drive to the active player's cleanup: stops either on the discard prompt or on the next turn. */
const toCleanup = (s: St) => {
  const turn = s.turnNumber
  toStep(s, 'end')
  until(s, (x) => x.pending?.kind === 'discard' || x.turnNumber > turn, 'cleanup')
}

describe('CARD8 — Command Tower / Exotic Orchard (any-colour lands)', () => {
  it('Command Tower taps for the chosen colour', () => {
    const { state, A } = makeDuel()
    const tower = putCard(state, A, 'Command Tower', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: tower, color: 'U' })
    expect(state.players[A]!.manaPool.U).toBe(1)
    expect(state.objects[tower]!.tapped).toBe(true)
  })

  it('Exotic Orchard taps for the chosen colour and enters untapped (usable the turn it lands)', () => {
    const { state, A } = makeDuel()
    const orchard = putCard(state, A, 'Exotic Orchard', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: orchard })
    expect(state.objects[orchard]!.tapped).toBe(false)
    act(state, A, { type: 'r.tapMana', objId: orchard, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })
})

describe('CARD8 — no maximum hand size (Reliquary Tower, Thought Vessel)', () => {
  it('without it, a 9-card hand is trimmed at cleanup (the CR 402.2 default still applies)', () => {
    const { state, A } = makeDuel()
    handTo(state, A, 9)
    toCleanup(state)
    expect(state.pending?.kind).toBe('discard')
    expect(state.pending?.player).toBe(A)
  })

  it('Reliquary Tower: no cleanup discard, the hand keeps all 9 cards', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Reliquary Tower', 'battlefield')
    handTo(state, A, 9)
    toCleanup(state)
    expect(state.pending).toBeFalsy() // no discard prompt — the turn just ended
    expect(state.turnNumber).toBeGreaterThan(1)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(9)
  })

  it('Thought Vessel does the same from an artifact, and only for ITS controller', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Thought Vessel', 'battlefield')
    handTo(state, A, 9)
    handTo(state, B, 9)
    toCleanup(state) // A's cleanup: exempt
    expect(state.pending).toBeFalsy()
    expect(state.zones.perPlayer[A]!.hand.length).toBe(9)
    // B's turn: B controls no such permanent, so B is still trimmed to 7
    until(state, (x) => x.pending?.kind === 'discard', "B's cleanup discard")
    expect(state.pending?.player).toBe(B)
  })

  it('it is a live check: losing the permanent before cleanup re-imposes the limit', () => {
    const { state, A } = makeDuel()
    const vessel = putCard(state, A, 'Thought Vessel', 'battlefield')
    handTo(state, A, 9)
    toStep(state, 'end')
    act(state, A, { type: 'r.mMove', objId: vessel, zone: 'graveyard' }) // sacrificed / removed in the end step
    pass(state, A)
    until(state, (x) => x.pending?.kind === 'discard' || x.turnNumber > 1, 'cleanup')
    expect(state.pending?.kind).toBe('discard')
  })
})
