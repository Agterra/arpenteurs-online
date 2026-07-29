/**
 * Perpetual card coverage — batch CARD30: surveil (CR 701.42) on the shared scry decision — Consider
 * and the ten surveil lands — plus the six horizon lands.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { redactRulesState } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

const SURVEIL_LANDS: [string, ManaColor, string, string][] = [
  ['Undercity Sewers', 'B', 'Island', 'Swamp'],
  ['Underground Mortuary', 'G', 'Swamp', 'Forest'],
  ['Hedge Maze', 'U', 'Forest', 'Island'],
  ['Raucous Theater', 'R', 'Swamp', 'Mountain'],
  ['Shadowy Backstreet', 'B', 'Plains', 'Swamp'],
  ['Thundering Falls', 'R', 'Island', 'Mountain'],
  ['Commercial District', 'G', 'Mountain', 'Forest'],
  ['Meticulous Archive', 'U', 'Plains', 'Island'],
  ['Lush Portico', 'W', 'Forest', 'Plains'],
  ['Elegant Parlor', 'W', 'Mountain', 'Plains'],
]
const HORIZON: [string, ManaColor, ManaColor][] = [
  ['Horizon Canopy', 'G', 'W'],
  ['Silent Clearing', 'W', 'B'],
  ['Sunbaked Canyon', 'R', 'W'],
  ['Nurturing Peatland', 'B', 'G'],
  ['Waterlogged Grove', 'G', 'U'],
  ['Fiery Islet', 'U', 'R'],
]

describe('CARD30 — Consider (surveil 1, then draw)', () => {
  it('puts the surveilled card into the GRAVEYARD, then draws', () => {
    const { state, A } = makeDuel()
    const consider = putCard(state, A, 'Consider', 'hand')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    const gyBefore = state.zones.perPlayer[A]!.graveyard.length
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: consider, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'the surveil')
    expect(state.pendingScry!.surveil).toBe(true)
    const peeked = state.pendingScry!.cardIds[0]!
    act(state, A, { type: 'r.scry', toBottom: [peeked] }) // "toBottom" means graveyard for surveil
    expect(state.objects[peeked]!.zone).toBe('graveyard')
    // Consider itself + the surveilled card are in the graveyard, and one card was drawn
    expect(state.zones.perPlayer[A]!.graveyard.length).toBe(gyBefore + 2)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1 + 1)
  })

  it('keeping it on top leaves the library alone and still draws', () => {
    const { state, A } = makeDuel()
    const consider = putCard(state, A, 'Consider', 'hand')
    toStep(state, 'main1')
    const libBefore = state.zones.perPlayer[A]!.library.length
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: consider, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'the surveil')
    act(state, A, { type: 'r.scry', toBottom: [] })
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore - 1) // only the draw
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1 + 1)
  })

  it('the surveil peek is actor-only and re-minted afterwards', () => {
    const { state, A, B } = makeDuel()
    const consider = putCard(state, A, 'Consider', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: consider, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'the surveil')
    const peeked = state.pendingScry!.cardIds[0]!
    // the opponent never sees the peeked id
    expect(JSON.stringify(redactRulesState(state, B)).includes(peeked)).toBe(false)
    // …and the viewer's own payload flags it as a surveil
    expect(redactRulesState(state, A).scry?.surveil).toBe(true)
    act(state, A, { type: 'r.scry', toBottom: [] })
    // kept on top, but the library was re-minted, so the peeked id is gone for good
    expect(state.zones.perPlayer[A]!.library).not.toContain(peeked)
  })
})

describe('CARD30 — the ten surveil lands', () => {
  for (const [land, colour, subA, subB] of SURVEIL_LANDS) {
    it(`${land}: enters tapped, surveils 1, taps for {${colour}}`, () => {
      const { state, A } = makeDuel()
      const l = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      const gyBefore = state.zones.perPlayer[A]!.graveyard.length
      act(state, A, { type: 'r.playLand', objId: l })
      expect(state.objects[l]!.tapped).toBe(true)
      expect(getDef(state.objects[l]!.defName).subtypes).toEqual([subA, subB])
      until(state, (s) => s.pending?.kind === 'scry', 'the ETB surveil')
      expect(state.pendingScry!.surveil).toBe(true)
      act(state, A, { type: 'r.scry', toBottom: [state.pendingScry!.cardIds[0]!] })
      expect(state.zones.perPlayer[A]!.graveyard.length).toBe(gyBefore + 1)
      state.objects[l]!.tapped = false
      act(state, A, { type: 'r.tapMana', objId: l, color: colour })
      expect(state.players[A]!.manaPool[colour]).toBe(1)
    })
  }
})

describe('CARD30 — the six horizon lands', () => {
  for (const [land, a, b] of HORIZON) {
    it(`${land}: 1 life for {${a}}/{${b}}, or {1} + sacrifice to draw`, () => {
      const { state, A } = makeDuel()
      const forMana = putCard(state, A, land, 'battlefield')
      const forDraw = putCard(state, A, land, 'battlefield')
      toStep(state, 'main1')
      const life = state.players[A]!.life
      act(state, A, { type: 'r.tapMana', objId: forMana, color: b })
      expect(state.players[A]!.manaPool[b]).toBe(1)
      expect(state.players[A]!.life).toBe(life - 1)
      // the second copy sacrifices itself for a card
      const handBefore = state.zones.perPlayer[A]!.hand.length
      addMana(state, A, 'C', 1)
      act(state, A, { type: 'r.activate', objId: forDraw, abilityIndex: 1, targets: [] })
      expect(state.objects[forDraw]!.zone).toBe('graveyard')
      resolve(state, A)
      expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1)
    })
  }

  it('cannot be tapped for colour at 0 life', () => {
    const { state, A } = makeDuel()
    const canopy = putCard(state, A, 'Horizon Canopy', 'battlefield')
    toStep(state, 'main1')
    state.players[A]!.life = 0
    expect(() => act(state, A, { type: 'r.tapMana', objId: canopy, color: 'G' })).toThrow(/Not enough life/)
  })
})
