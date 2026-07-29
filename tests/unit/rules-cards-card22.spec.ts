/**
 * Perpetual card coverage — batch CARD22: the tutors (a new 'libraryTop' search destination and a
 * card-TYPE search filter) plus Lotus Petal and Wayfarer's Bauble.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, rig, toStep, until } from './rules-helpers.ts'
import { redactRulesState } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const topDef = (s: St, p: PlayerId) => getDef(s.objects[s.zones.perPlayer[p]!.library[0]!]!.defName)

describe('CARD22 — Vampiric Tutor', () => {
  it('puts the chosen card on top, shuffles, and costs 2 life', () => {
    const { state, A } = makeDuel()
    const tutor = putCard(state, A, 'Vampiric Tutor', 'hand')
    putCard(state, A, 'Sol Ring', 'library')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    const libBefore = state.zones.perPlayer[A]!.library.length
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.cast', objId: tutor, targets: [] })
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, 'the tutor search')
    const solRing = state.pendingSearch!.matchIds.find((id) => getDef(state.objects[id]!.defName).name === 'Sol Ring')!
    expect(solRing).toBeTruthy() // 'any' filter → everything in the library matches
    act(state, A, { type: 'r.search', cardIds: [solRing] })
    expect(topDef(state, A).name).toBe('Sol Ring') // on TOP, still in the library
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore)
    expect(state.players[A]!.life).toBe(life - 2)
  })

  it('the tutored card is re-minted, so the searcher cannot track the peeked id', () => {
    const { state, A } = makeDuel()
    const tutor = putCard(state, A, 'Vampiric Tutor', 'hand')
    putCard(state, A, 'Sol Ring', 'library')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.cast', objId: tutor, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'the tutor search')
    const peeked = [...state.pendingSearch!.matchIds]
    const solRing = peeked.find((id) => getDef(state.objects[id]!.defName).name === 'Sol Ring')!
    act(state, A, { type: 'r.search', cardIds: [solRing] })
    const lib = state.zones.perPlayer[A]!.library
    for (const id of peeked) expect(lib).not.toContain(id) // every peeked id was re-minted
    // and no library id is serialised to anyone, including its owner
    const view = JSON.stringify(redactRulesState(state, A))
    for (const id of lib) expect(view.includes(id)).toBe(false)
  })

  it('does not reveal what was chosen (no name in the log)', () => {
    const { state, A } = makeDuel()
    const tutor = putCard(state, A, 'Vampiric Tutor', 'hand')
    putCard(state, A, 'Sol Ring', 'library')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    act(state, A, { type: 'r.cast', objId: tutor, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'the tutor search')
    const solRing = state.pendingSearch!.matchIds.find((id) => getDef(state.objects[id]!.defName).name === 'Sol Ring')!
    act(state, A, { type: 'r.search', cardIds: [solRing] })
    expect(state.log.some((l) => /reveals Sol Ring/.test(l))).toBe(false)
  })
})

describe('CARD22 — the type-filtered tutors', () => {
  const CASES: [string, ManaColor, string, string][] = [
    ['Enlightened Tutor', 'W', 'Sol Ring', 'Grizzly Bears'], // artifact/enchantment
    ['Mystical Tutor', 'U', 'Divination', 'Grizzly Bears'], // instant/sorcery
    ['Worldly Tutor', 'G', 'Grizzly Bears', 'Divination'], // creature
  ]
  for (const [tutorName, colour, legalCard, illegalCard] of CASES) {
    it(`${tutorName}: only matching cards are offered, and the pick is revealed`, () => {
      const { state, A } = makeDuel()
      const tutor = putCard(state, A, tutorName, 'hand')
      const wanted = putCard(state, A, legalCard, 'library')
      const other = putCard(state, A, illegalCard, 'library')
      toStep(state, 'main1')
      addMana(state, A, colour, 1)
      act(state, A, { type: 'r.cast', objId: tutor, targets: [] })
      until(state, (s) => s.pending?.kind === 'search', 'the tutor search')
      const matches = state.pendingSearch!.matchIds
      expect(matches).toContain(wanted)
      expect(matches).not.toContain(other)
      act(state, A, { type: 'r.search', cardIds: [wanted] })
      expect(topDef(state, A).name).toBe(legalCard)
      expect(state.log.some((l) => new RegExp(`reveals ${legalCard}`).test(l))).toBe(true)
    })
  }

  it('finds nothing when the library holds no matching card', () => {
    const { state, A } = makeDuel()
    // rig first (it re-deals A's cards and would delete a card minted before it), then the tutor
    rig(state, A, { hand: [], battlefield: [], libraryTop: ['Mountain', 'Mountain'], librarySize: 0 })
    const tutor = putCard(state, A, 'Enlightened Tutor', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    act(state, A, { type: 'r.cast', objId: tutor, targets: [] })
    resolve(state, A)
    expect(state.pending).toBeFalsy()
    expect(state.log.some((l) => /finds nothing/i.test(l))).toBe(true)
  })
})

describe('CARD22 — Lotus Petal and Wayfarer\'s Bauble', () => {
  it('Lotus Petal taps + sacrifices for one mana of any colour', () => {
    const { state, A } = makeDuel()
    const petal = putCard(state, A, 'Lotus Petal', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: petal, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(1)
    expect(state.zones.perPlayer[A]!.battlefield).not.toContain(petal) // sacrificed as part of the cost
  })

  it("Wayfarer's Bauble pays {2} + itself to fetch a basic tapped", () => {
    const { state, A } = makeDuel()
    const bauble = putCard(state, A, "Wayfarer's Bauble", 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.activate', objId: bauble, abilityIndex: 0, targets: [] })
    expect(state.objects[bauble]!.zone).toBe('graveyard')
    expect(state.players[A]!.manaPool.C).toBe(0)
    until(state, (s) => s.pending?.kind === 'search', 'the fetch search')
    const pick = state.pendingSearch!.matchIds[0]!
    act(state, A, { type: 'r.search', cardIds: [pick] })
    expect(state.objects[pick]!.zone).toBe('battlefield')
    expect(state.objects[pick]!.tapped).toBe(true)
  })

  it("Wayfarer's Bauble needs the {2} (nothing is sacrificed without it)", () => {
    const { state, A } = makeDuel()
    const bauble = putCard(state, A, "Wayfarer's Bauble", 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.activate', objId: bauble, abilityIndex: 0, targets: [] })).toThrow(/Not enough mana/)
    expect(state.objects[bauble]!.zone).toBe('battlefield')
  })
})
