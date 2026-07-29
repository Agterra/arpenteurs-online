/**
 * Perpetual card coverage — batch CARD58: GLOBAL land-type grants (Urborg, Tomb of Yawgmoth and
 * Yavimaya, Cradle of Growth make every land a Swamp / a Forest — CR 305.7, so every land gains that
 * type's intrinsic mana ability, for every player) and Garruk's Uprising, which needed a separate ETB
 * WATCHER field so one card can have both its own enters trigger and a watcher for other creatures.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { currentKeywords } from '../../server/rules/characteristics.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD58 — Urborg, Tomb of Yawgmoth', () => {
  it('lets every land tap for {B}, yours and theirs', () => {
    const { state, A, B } = makeDuel()
    const mountain = putCard(state, A, 'Mountain', 'battlefield')
    const theirForest = putCard(state, B, 'Forest', 'battlefield')
    toStep(state, 'main1')
    // before Urborg a Mountain makes only {R}
    expect(() => act(state, A, { type: 'r.tapMana', objId: mountain, color: 'B' })).toThrow(/can't make \{B\}/)
    putCard(state, A, 'Urborg, Tomb of Yawgmoth', 'battlefield')
    expect(computeLegal(state, A).manaSourceColors[mountain]).toContain('B')
    act(state, A, { type: 'r.tapMana', objId: mountain, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
    // …and the OPPONENT's land is a Swamp too (the static is global)
    act(state, A, { type: 'r.pass' })
    act(state, B, { type: 'r.tapMana', objId: theirForest, color: 'B' })
    expect(state.players[B]!.manaPool.B).toBe(1)
  })

  it('turns on swampwalk for everyone', () => {
    const { state, A, B } = makeDuel()
    const walker = putCard(state, A, 'Marsh Boa', 'battlefield') // {G} 1/1 with swampwalk
    const blocker = putCard(state, B, 'Grizzly Bears', 'battlefield')
    putCard(state, B, 'Forest', 'battlefield') // their only land: not a Swamp yet
    state.objects[walker]!.summoningSick = false
    putCard(state, A, 'Urborg, Tomb of Yawgmoth', 'battlefield')
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [walker])
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
    // their Forest is a Swamp now, so the swampwalker is unblockable
    expect(() =>
      act(state, B, { type: 'r.blockers', blocks: [{ blockerId: blocker, attackerId: walker }] }),
    ).toThrow(/can't be blocked \(swampwalk\)/)
  })

  it('Yavimaya does the same for {G}', () => {
    const { state, A } = makeDuel()
    const island = putCard(state, A, 'Island', 'battlefield')
    putCard(state, A, 'Yavimaya, Cradle of Growth', 'battlefield')
    toStep(state, 'main1')
    expect(computeLegal(state, A).manaSourceColors[island]).toContain('G')
    act(state, A, { type: 'r.tapMana', objId: island, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(1)
  })

  it('both together make every land tap for either colour', () => {
    const { state, A } = makeDuel()
    const mountain = putCard(state, A, 'Mountain', 'battlefield')
    putCard(state, A, 'Urborg, Tomb of Yawgmoth', 'battlefield')
    putCard(state, A, 'Yavimaya, Cradle of Growth', 'battlefield')
    toStep(state, 'main1')
    const colors = computeLegal(state, A).manaSourceColors[mountain] ?? []
    expect(colors).toContain('B')
    expect(colors).toContain('G')
    expect(colors).toContain('R') // its own type is still there
  })

  it('Urborg itself taps for {B} (it is a Swamp too)', () => {
    const { state, A } = makeDuel()
    const urborg = putCard(state, A, 'Urborg, Tomb of Yawgmoth', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: urborg, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })
})

describe("CARD58 — Garruk's Uprising", () => {
  const cast = (s: St, A: PlayerId) => {
    const spell = putCard(s, A, "Garruk's Uprising", 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'G', 1)
    addMana(s, A, 'C', 2)
    act(s, A, { type: 'r.cast', objId: spell, targets: [] })
    resolve(s, A)
    return spell
  }

  it('draws on entry only if you already control a big creature', () => {
    const small = makeDuel()
    putCard(small.state, small.A, 'Grizzly Bears', 'battlefield') // 2/2
    toStep(small.state, 'main1')
    const handSmall = small.state.zones.perPlayer[small.A]!.hand.length
    cast(small.state, small.A) // the helper adds the card then casts it: net 0 unless it draws
    expect(small.state.zones.perPlayer[small.A]!.hand.length).toBe(handSmall) // no draw
    const big = makeDuel()
    putCard(big.state, big.A, 'Serra Angel', 'battlefield') // 4/4
    toStep(big.state, 'main1')
    const handBig = big.state.zones.perPlayer[big.A]!.hand.length
    cast(big.state, big.A)
    expect(big.state.zones.perPlayer[big.A]!.hand.length).toBe(handBig + 1) // it drew
  })

  it('gives your creatures trample', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    cast(state, A)
    expect(currentKeywords(state, state.objects[bear]!)).toContain('trample')
    expect(currentKeywords(state, state.objects[theirs]!)).not.toContain('trample')
  })

  it('draws whenever a big creature you control enters afterwards', () => {
    const { state, A, B } = makeDuel()
    cast(state, A)
    const hand = state.zones.perPlayer[A]!.hand.length
    // a 2/2 draws nothing
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand) // the Bear came and went: no draw
    // a 4/4 draws one
    const angel = putCard(state, A, 'Serra Angel', 'hand')
    addMana(state, A, 'W', 2)
    addMana(state, A, 'C', 3)
    const before = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cast', objId: angel, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before) // −1 the Angel leaving, +1 drawn
    // …and NOT for an opponent's big creature
    const theirAngel = putCard(state, B, 'Serra Angel', 'battlefield')
    expect(state.objects[theirAngel]!.zone).toBe('battlefield')
    const after = state.zones.perPlayer[A]!.hand.length
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'settle')
    expect(state.zones.perPlayer[A]!.hand.length).toBe(after)
  })
})
