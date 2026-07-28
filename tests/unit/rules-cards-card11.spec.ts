/**
 * Perpetual card coverage — batch CARD11: the ten pay-1-life fetch lands (Onslaught + Zendikar
 * cycles) and the new "Pay N life" activation cost (Cost.life, CR 119.4). The fetched land enters
 * UNTAPPED — the tapped, {1}-cost fetch cycle is a different set of cards.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState

/** name → the two land subtypes it can fetch */
const FETCHES: [string, string, string][] = [
  ['Polluted Delta', 'Island', 'Swamp'],
  ['Flooded Strand', 'Plains', 'Island'],
  ['Misty Rainforest', 'Forest', 'Island'],
  ['Bloodstained Mire', 'Swamp', 'Mountain'],
  ['Windswept Heath', 'Forest', 'Plains'],
  ['Wooded Foothills', 'Mountain', 'Forest'],
  ['Verdant Catacombs', 'Swamp', 'Forest'],
  ['Scalding Tarn', 'Island', 'Mountain'],
  ['Marsh Flats', 'Plains', 'Swamp'],
  ['Arid Mesa', 'Mountain', 'Plains'],
]
/** Seed one basic of every type into A's library so every fetch has legal and illegal matches. */
const seedBasics = (s: St, p: PlayerId) => {
  for (const b of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) putCard(s, p, b, 'library')
}

describe('CARD11 — the ten fetch lands', () => {
  for (const [land, a, b] of FETCHES) {
    it(`${land}: pays {T} + 1 life + itself, and offers only ${a}/${b} lands`, () => {
      const { state, A } = makeDuel()
      seedBasics(state, A)
      const fetch = putCard(state, A, land, 'battlefield')
      toStep(state, 'main1')
      const lifeBefore = state.players[A]!.life
      act(state, A, { type: 'r.activate', objId: fetch, abilityIndex: 0, targets: [] })
      expect(state.players[A]!.life).toBe(lifeBefore - 1) // the life cost
      expect(state.objects[fetch]!.zone).toBe('graveyard') // sacrificed as a cost
      until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, 'the fetch search')
      // every offered card is a land with one of the two printed subtypes
      const offered = state.pendingSearch!.matchIds.map((id) => getDef(state.objects[id]!.defName))
      expect(offered.length).toBeGreaterThan(0)
      for (const def of offered) {
        expect(def.types).toContain('Land')
        expect(def.subtypes?.some((st) => st === a || st === b)).toBe(true)
      }
      // and the fetched land arrives UNTAPPED
      const pick = state.pendingSearch!.matchIds[0]!
      act(state, A, { type: 'r.search', cardIds: [pick] })
      expect(state.objects[pick]!.zone).toBe('battlefield')
      expect(state.objects[pick]!.tapped).toBe(false)
    })
  }

  it('a fetch with nothing to find still pays its costs and finds nothing (no prompt)', () => {
    const { state, A } = makeDuel()
    // the default deck is Mountains only, so a Plains/Island fetch matches nothing
    const strand = putCard(state, A, 'Flooded Strand', 'battlefield')
    toStep(state, 'main1')
    const lifeBefore = state.players[A]!.life
    act(state, A, { type: 'r.activate', objId: strand, abilityIndex: 0, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the ability resolves')
    expect(state.pending).toBeFalsy()
    expect(state.players[A]!.life).toBe(lifeBefore - 1)
    expect(state.objects[strand]!.zone).toBe('graveyard')
    expect(state.log.some((l) => /finds nothing/i.test(l))).toBe(true)
  })
})

describe('CARD11 — the "Pay N life" cost (CR 119.4)', () => {
  it('is payable at exactly the cost, and the 0-life SBA then ends that player\'s game', () => {
    const { state, A } = makeDuel()
    seedBasics(state, A)
    const fetch = putCard(state, A, 'Arid Mesa', 'battlefield')
    toStep(state, 'main1')
    state.players[A]!.life = 1 // paying to 0 is legal…
    act(state, A, { type: 'r.activate', objId: fetch, abilityIndex: 0, targets: [] })
    expect(state.players[A]!.life).toBe(0)
    expect(state.players[A]!.hasLost).toBe(true) // …and then you lose (CR 704.5a)
  })

  it('is rejected below the cost, mutating nothing', () => {
    const { state, A } = makeDuel()
    const fetch = putCard(state, A, 'Arid Mesa', 'battlefield')
    toStep(state, 'main1')
    state.players[A]!.life = 0 // artificial: SBA has not run yet, so the guard is what stops it
    expect(() => act(state, A, { type: 'r.activate', objId: fetch, abilityIndex: 0, targets: [] })).toThrow(/Not enough life/)
    expect(state.objects[fetch]!.zone).toBe('battlefield')
    expect(state.objects[fetch]!.tapped).toBe(false)
    expect(state.zones.stack.length).toBe(0)
  })

  it('redact surfaces the life cost and hides the activation when it is unaffordable', () => {
    const { state, A } = makeDuel()
    const fetch = putCard(state, A, 'Marsh Flats', 'battlefield')
    toStep(state, 'main1')
    expect(computeLegal(state, A).activations).toEqual(
      expect.arrayContaining([expect.objectContaining({ objId: fetch, abilityIndex: 0, lifeCost: 1, sacCost: 0 })]),
    )
    state.players[A]!.life = 0
    expect(computeLegal(state, A).activations.some((x) => x.objId === fetch)).toBe(false)
  })
})
