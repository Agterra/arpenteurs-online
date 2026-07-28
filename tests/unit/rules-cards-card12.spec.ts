/**
 * Perpetual card coverage — batch CARD12: the ten shocklands (Ravnica cycle) and the new as-enters
 * CHOICE (CR 614.12) — "As this land enters, you may pay 2 life. If you don't, it enters tapped."
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState

/** name → [colour a, colour b, subtype a, subtype b] */
const SHOCKS: [string, ManaColor, ManaColor, string, string][] = [
  ['Watery Grave', 'U', 'B', 'Island', 'Swamp'],
  ['Godless Shrine', 'W', 'B', 'Plains', 'Swamp'],
  ['Breeding Pool', 'G', 'U', 'Forest', 'Island'],
  ['Hallowed Fountain', 'W', 'U', 'Plains', 'Island'],
  ['Steam Vents', 'U', 'R', 'Island', 'Mountain'],
  ['Stomping Ground', 'R', 'G', 'Mountain', 'Forest'],
  ['Blood Crypt', 'B', 'R', 'Swamp', 'Mountain'],
  ['Overgrown Tomb', 'B', 'G', 'Swamp', 'Forest'],
  ['Sacred Foundry', 'R', 'W', 'Mountain', 'Plains'],
  ['Temple Garden', 'G', 'W', 'Forest', 'Plains'],
]

describe('CARD12 — the ten shocklands', () => {
  for (const [land, a, b, subA, subB] of SHOCKS) {
    it(`${land}: paying 2 life keeps it untapped and it taps for {${a}} or {${b}}`, () => {
      const { state, A } = makeDuel()
      const shock = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      const lifeBefore = state.players[A]!.life
      act(state, A, { type: 'r.playLand', objId: shock })
      // the choice is open and blocks every other action until answered
      expect(state.pending?.kind).toBe('entersChoice')
      expect(() => act(state, A, { type: 'r.tapMana', objId: shock })).toThrow(/PENDING|Waiting for/i)
      act(state, A, { type: 'r.entersChoice', pay: true })
      expect(state.players[A]!.life).toBe(lifeBefore - 2)
      expect(state.objects[shock]!.tapped).toBe(false)
      expect(state.pending).toBeFalsy()
      // printed dual land types (so a fetch land can find it) and a two-colour mana ability
      expect(getDef(state.objects[shock]!.defName).subtypes).toEqual([subA, subB])
      act(state, A, { type: 'r.tapMana', objId: shock, color: b })
      expect(state.players[A]!.manaPool[b]).toBe(1)
    })
  }

  it('declining makes it enter tapped, at no life cost', () => {
    const { state, A } = makeDuel()
    const shock = putCard(state, A, 'Blood Crypt', 'hand')
    toStep(state, 'main1')
    const lifeBefore = state.players[A]!.life
    act(state, A, { type: 'r.playLand', objId: shock })
    act(state, A, { type: 'r.entersChoice', pay: false })
    expect(state.players[A]!.life).toBe(lifeBefore)
    expect(state.objects[shock]!.tapped).toBe(true)
    expect(state.log.some((l) => /Blood Crypt enters tapped/.test(l))).toBe(true)
  })

  it('redact prompts only the controller, with the life amount and the card name', () => {
    const { state, A, B } = makeDuel()
    const shock = putCard(state, A, 'Steam Vents', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: shock })
    const mine = computeLegal(state, A)
    expect(mine.needsEntersChoice).toBe(true)
    expect(mine.entersChoiceLife).toBe(2)
    expect(mine.entersChoiceName).toBe('Steam Vents')
    expect(mine.entersChoiceAffordable).toBe(true)
    expect(computeLegal(state, B).needsEntersChoice).toBe(false) // the opponent is told nothing to do
  })

  it('cannot pay below the life cost: paying is downgraded to entering tapped (CR 119.4)', () => {
    const { state, A } = makeDuel()
    const shock = putCard(state, A, 'Temple Garden', 'hand')
    toStep(state, 'main1')
    state.players[A]!.life = 1
    act(state, A, { type: 'r.playLand', objId: shock })
    expect(computeLegal(state, A).entersChoiceAffordable).toBe(false)
    act(state, A, { type: 'r.entersChoice', pay: true }) // the server refuses to take you to −1
    expect(state.players[A]!.life).toBe(1)
    expect(state.objects[shock]!.tapped).toBe(true)
  })

  it('paying to exactly 0 life is legal and loses the game (CR 704.5a)', () => {
    const { state, A } = makeDuel()
    const shock = putCard(state, A, 'Watery Grave', 'hand')
    toStep(state, 'main1')
    state.players[A]!.life = 2
    act(state, A, { type: 'r.playLand', objId: shock })
    act(state, A, { type: 'r.entersChoice', pay: true })
    expect(state.players[A]!.life).toBe(0)
    expect(state.players[A]!.hasLost).toBe(true)
  })

  it('answering out of turn / with no choice open is rejected', () => {
    const { state, A, B } = makeDuel()
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.entersChoice', pay: true })).toThrow(/NOT_PENDING|Not waiting/i)
    const shock = putCard(state, A, 'Godless Shrine', 'hand')
    act(state, A, { type: 'r.playLand', objId: shock })
    expect(() => act(state, B, { type: 'r.entersChoice', pay: false })).toThrow(/NOT_PENDING|Not waiting/i)
  })
})

describe('CARD12 — the choice survives entry paths other than playing the land', () => {
  it('a shockland FETCHED mid-search still owes its choice (the search pending is not clobbered)', () => {
    const { state, A } = makeDuel()
    const shock = putCard(state, A, 'Verdant Catacombs', 'battlefield') // fetches Swamp or Forest
    const target = putCard(state, A, 'Overgrown Tomb', 'library') // Swamp Forest — a legal find
    toStep(state, 'main1')
    act(state, A, { type: 'r.activate', objId: shock, abilityIndex: 0, targets: [] })
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, 'the fetch search')
    expect(state.pendingSearch!.matchIds).toContain(target)
    act(state, A, { type: 'r.search', cardIds: [target] })
    // the fetched shockland asks its question instead of sneaking in untapped
    expect(state.pending?.kind).toBe('entersChoice')
    act(state, A, { type: 'r.entersChoice', pay: false })
    expect(state.objects[target]!.tapped).toBe(true)
    expect(state.priorityPlayer).toBe(A)
  })

  it('a manual r.mMove onto the battlefield also opens the choice', () => {
    const { state, A } = makeDuel()
    const shock = putCard(state, A, 'Sacred Foundry', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.mMove', objId: shock, zone: 'battlefield' })
    expect(state.pending?.kind).toBe('entersChoice')
    act(state, A, { type: 'r.entersChoice', pay: true })
    expect(state.objects[shock]!.tapped).toBe(false)
  })

  it('two shocklands entering together each get their own choice', () => {
    const { state, A } = makeDuel()
    const one = putCard(state, A, 'Hallowed Fountain', 'hand')
    const two = putCard(state, A, 'Breeding Pool', 'hand')
    toStep(state, 'main1')
    const lifeBefore = state.players[A]!.life
    act(state, A, { type: 'r.mMove', objId: one, zone: 'battlefield' })
    act(state, A, { type: 'r.mMove', objId: two, zone: 'battlefield' }) // queued behind the first
    expect(state.pendingEntersChoice!.objId).toBe(one)
    act(state, A, { type: 'r.entersChoice', pay: true })
    expect(state.pending?.kind).toBe('entersChoice') // the second one's turn
    expect(state.pendingEntersChoice!.objId).toBe(two)
    act(state, A, { type: 'r.entersChoice', pay: false })
    expect(state.players[A]!.life).toBe(lifeBefore - 2)
    expect(state.objects[one]!.tapped).toBe(false)
    expect(state.objects[two]!.tapped).toBe(true)
    expect(state.pending).toBeFalsy()
  })

  it('a conceding chooser does not wedge the game (the land is treated as declining)', () => {
    const { state, A, B } = makeDuel()
    const shock = putCard(state, A, 'Stomping Ground', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: shock })
    expect(state.pending?.kind).toBe('entersChoice')
    act(state, A, { type: 'r.concede' })
    expect(state.pending).toBeFalsy()
    expect(state.status).toBe('ended') // 1v1: the other player wins
    expect(state.winner).toBe(B)
  })
})
