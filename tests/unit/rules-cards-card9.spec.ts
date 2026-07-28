/**
 * Perpetual card coverage — batch CARD9: the new "Sacrifice this permanent" activated-ability
 * cost (Cost.sacrificeSelf) and the staples that need it — Evolving Wilds / Terramorphic Expanse
 * (fetch a basic tapped), Mind Stone and Commander's Sphere (sac for a card) — plus Bojuka Bog
 * (ETB exile target player's graveyard).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { defKey } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD9 — Evolving Wilds / Terramorphic Expanse (sac-self fetch)', () => {
  for (const land of ['Evolving Wilds', 'Terramorphic Expanse']) {
    it(`${land}: {T}, sac → fetch a basic onto the battlefield tapped`, () => {
      const { state, A } = makeDuel()
      const wilds = putCard(state, A, land, 'battlefield')
      toStep(state, 'main1')
      const handBefore = state.zones.perPlayer[A]!.hand.length
      act(state, A, { type: 'r.activate', objId: wilds, abilityIndex: 0, targets: [] })
      // the cost is paid immediately: the land is already in the graveyard while the ability waits
      expect(state.objects[wilds]!.zone).toBe('graveyard')
      expect(state.zones.stack.length).toBe(1)
      // …and the ability still resolved from the graveyard → a search prompt for its controller
      until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, 'the fetch search')
      const basic = state.pendingSearch!.matchIds[0]!
      act(state, A, { type: 'r.search', cardIds: [basic] })
      expect(state.objects[basic]!.zone).toBe('battlefield')
      expect(state.objects[basic]!.tapped).toBe(true)
      expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore) // fetched to the field, not the hand
    })
  }

  it('only matches basic lands, and a tapped fetch land can no longer be activated', () => {
    const { state, A } = makeDuel()
    const wilds = putCard(state, A, 'Evolving Wilds', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.activate', objId: wilds, abilityIndex: 0, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'the fetch search')
    const mountain = defKey('Mountain')
    expect(state.pendingSearch!.matchIds.every((id) => state.objects[id]!.defName === mountain)).toBe(true)
    act(state, A, { type: 'r.search', cardIds: [state.pendingSearch!.matchIds[0]!] })
    // it's in the graveyard now — re-activating the sacrificed land is illegal
    expect(() => act(state, A, { type: 'r.activate', objId: wilds, abilityIndex: 0, targets: [] })).toThrow(/NOT_YOURS|don't control/i)
  })
})

describe('CARD9 — Mind Stone / Commander\'s Sphere (sac for a card)', () => {
  it('Mind Stone taps for {C}, and {1},{T},sac draws a card', () => {
    const { state, A } = makeDuel()
    const stone = putCard(state, A, 'Mind Stone', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: stone })
    expect(state.players[A]!.manaPool.C).toBe(1) // ability 0: the mana ability
    // untap it so the second ability's {T} is payable (a real game would use it on a later turn)
    state.objects[stone]!.tapped = false
    const before = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.activate', objId: stone, abilityIndex: 1, targets: [] })
    expect(state.players[A]!.manaPool.C).toBe(0) // the {1} was paid from the pool
    expect(state.objects[stone]!.zone).toBe('graveyard')
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before + 1)
  })

  it("Mind Stone's sac ability is unaffordable with an empty pool (nothing is sacrificed)", () => {
    const { state, A } = makeDuel()
    const stone = putCard(state, A, 'Mind Stone', 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.activate', objId: stone, abilityIndex: 1, targets: [] })).toThrow(/Not enough mana/)
    expect(state.objects[stone]!.zone).toBe('battlefield') // cost validation happens before any mutation
  })

  it("Commander's Sphere: sac for a card needs no {T}, so it works while tapped", () => {
    const { state, A } = makeDuel()
    const sphere = putCard(state, A, "Commander's Sphere", 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: sphere, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(1)
    const before = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.activate', objId: sphere, abilityIndex: 1, targets: [] }) // tapped — still legal
    expect(state.objects[sphere]!.zone).toBe('graveyard')
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before + 1)
    expect(state.players[A]!.manaPool.G).toBe(1) // the floated mana survives the sacrifice
  })

  it('redact offers both sac-self activations to the controller (no creatures needed)', () => {
    const { state, A } = makeDuel()
    const wilds = putCard(state, A, 'Evolving Wilds', 'battlefield')
    const sphere = putCard(state, A, "Commander's Sphere", 'battlefield')
    toStep(state, 'main1')
    const acts = computeLegal(state, A).activations
    expect(acts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objId: wilds, abilityIndex: 0, sacCost: 0 }),
        expect.objectContaining({ objId: sphere, abilityIndex: 1, sacCost: 0 }),
      ]),
    )
  })
})

describe('CARD9 — Bojuka Bog (ETB exile target player\'s graveyard)', () => {
  it('enters tapped and exiles the targeted graveyard', () => {
    const { state, A, B } = makeDuel()
    const dead = [putCard(state, B, 'Grizzly Bears', 'graveyard'), putCard(state, B, 'Shock', 'graveyard')]
    const mine = putCard(state, A, 'Shock', 'graveyard')
    const bog = putCard(state, A, 'Bojuka Bog', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: bog })
    expect(state.objects[bog]!.tapped).toBe(true)
    act(state, A, { type: 'r.chooseTargets', targets: [B] }) // the ETB trigger targets a player
    resolve(state, A)
    for (const id of dead) expect(state.objects[id]!.zone).toBe('exile')
    expect(state.zones.perPlayer[B]!.graveyard).toEqual([])
    expect(state.objects[mine]!.zone).toBe('graveyard') // only the target's graveyard is exiled
  })

  it('taps for {B} once untapped', () => {
    const { state, A } = makeDuel()
    const bog = putCard(state, A, 'Bojuka Bog', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: bog })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })
})
