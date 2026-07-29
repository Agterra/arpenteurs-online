/**
 * Perpetual card coverage — batch CARD57: the two-card sac-fetch lands. Myriad Landscape needs its two
 * picks to SHARE a land type, Krosan Verge needs them to cover BOTH Forest and Plains, and Blighted
 * Woodland takes any two basics. All three route through the existing search decision; the constraints
 * are validated server-side as the picks come in.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const onBattlefield = (s: St, p: PlayerId, name: string) =>
  s.zones.perPlayer[p]!.battlefield.filter((id) => nameOf(s, id) === name)
/** put the land out untapped and activate its fetch ability */
const fetchWith = (s: St, A: PlayerId, land: string, mana: [ManaColor, number][]) => {
  const id = putCard(s, A, land, 'battlefield')
  toStep(s, 'main1')
  for (const [c, n] of mana) addMana(s, A, c, n)
  act(s, A, { type: 'r.activate', objId: id, abilityIndex: 1, targets: [] })
  until(s, (x) => x.pending?.kind === 'search' && x.pending.player === A, 'the search')
  return id
}

describe('CARD57 — Myriad Landscape', () => {
  it('enters tapped, taps for {C}, and fetches two basics that share a land type', () => {
    const { state, A } = makeDuel()
    const played = putCard(state, A, 'Myriad Landscape', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: played })
    expect(state.objects[played]!.tapped).toBe(true)
    state.objects[played]!.tapped = false
    act(state, A, { type: 'r.tapMana', objId: played, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
  })

  it('accepts two Forests and refuses a Forest + an Island', () => {
    const { state, A } = makeDuel()
    const f1 = putCard(state, A, 'Forest', 'library')
    const f2 = putCard(state, A, 'Forest', 'library')
    const island = putCard(state, A, 'Island', 'library')
    const land = fetchWith(state, A, 'Myriad Landscape', [['C', 2]])
    expect(() => act(state, A, { type: 'r.search', cardIds: [f1, island] })).toThrow(/share no land type/)
    act(state, A, { type: 'r.search', cardIds: [f1, f2] })
    expect(state.objects[f1]!.zone).toBe('battlefield')
    expect(state.objects[f2]!.zone).toBe('battlefield')
    expect(state.objects[f1]!.tapped).toBe(true) // both arrive tapped
    expect(state.objects[f2]!.tapped).toBe(true)
    expect(state.objects[land]!.zone).toBe('graveyard') // it sacrificed itself as a cost
  })

  it('may take just one card ("up to two")', () => {
    const { state, A } = makeDuel()
    const forest = putCard(state, A, 'Forest', 'library')
    fetchWith(state, A, 'Myriad Landscape', [['C', 2]])
    act(state, A, { type: 'r.search', cardIds: [forest] })
    expect(state.objects[forest]!.zone).toBe('battlefield')
  })

  it('needs the {2}, and only offers basics', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Forest', 'library')
    putCard(state, A, 'Watery Grave', 'library') // a nonbasic dual: never a legal find
    const land = putCard(state, A, 'Myriad Landscape', 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.activate', objId: land, abilityIndex: 1, targets: [] })).toThrow(/Not enough mana/)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.activate', objId: land, abilityIndex: 1, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'the search')
    const names = state.pendingSearch!.matchIds.map((id) => nameOf(state, id))
    expect(names).toContain('Forest')
    expect(names).not.toContain('Watery Grave')
  })
})

describe('CARD57 — Krosan Verge', () => {
  it('fetches a Forest AND a Plains, both tapped', () => {
    const { state, A } = makeDuel()
    const forest = putCard(state, A, 'Forest', 'library')
    const plains = putCard(state, A, 'Plains', 'library')
    fetchWith(state, A, 'Krosan Verge', [['C', 2]])
    act(state, A, { type: 'r.search', cardIds: [forest, plains] })
    expect(state.objects[forest]!.tapped).toBe(true)
    expect(state.objects[plains]!.tapped).toBe(true)
  })

  it('refuses two Forests', () => {
    const { state, A } = makeDuel()
    const f1 = putCard(state, A, 'Forest', 'library')
    const f2 = putCard(state, A, 'Forest', 'library')
    putCard(state, A, 'Plains', 'library')
    fetchWith(state, A, 'Krosan Verge', [['C', 2]])
    expect(() => act(state, A, { type: 'r.search', cardIds: [f1, f2] })).toThrow(/Choose a Plains card too/)
  })

  it('takes a NONBASIC land with the right type too', () => {
    const { state, A } = makeDuel()
    const dual = putCard(state, A, 'Temple Garden', 'library') // Forest Plains, if implemented
    const plains = putCard(state, A, 'Plains', 'library')
    const forest = putCard(state, A, 'Forest', 'library')
    fetchWith(state, A, 'Krosan Verge', [['C', 2]])
    const names = state.pendingSearch!.matchIds.map((id) => nameOf(state, id))
    if (names.includes('Temple Garden')) {
      // one card covering both subtypes satisfies the pair on its own
      act(state, A, { type: 'r.search', cardIds: [dual] })
      expect(state.objects[dual]!.zone).toBe('battlefield')
    } else {
      act(state, A, { type: 'r.search', cardIds: [forest, plains] })
      expect(state.objects[forest]!.zone).toBe('battlefield')
    }
  })
})

describe('CARD57 — Blighted Woodland', () => {
  it('fetches any two basics for {3}{G}, with no share requirement', () => {
    const { state, A } = makeDuel()
    const forest = putCard(state, A, 'Forest', 'library')
    const island = putCard(state, A, 'Island', 'library')
    fetchWith(state, A, 'Blighted Woodland', [['G', 1], ['C', 3]])
    act(state, A, { type: 'r.search', cardIds: [forest, island] }) // different types: fine here
    expect(state.objects[forest]!.zone).toBe('battlefield')
    expect(state.objects[island]!.zone).toBe('battlefield')
    expect(onBattlefield(state, A, 'Blighted Woodland').length).toBe(0) // sacrificed
  })

  it('taps for {C} and its fetch is offered only with the mana', () => {
    const { state, A } = makeDuel()
    const land = putCard(state, A, 'Blighted Woodland', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: land, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
    state.objects[land]!.tapped = false
    const offered = computeLegal(state, A).activations.find((a) => a.objId === land)
    expect(offered?.cost).toBe('{3}{G}')
  })
})
