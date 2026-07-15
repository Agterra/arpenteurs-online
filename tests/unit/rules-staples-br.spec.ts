/**
 * Coverage batch BR: recognizable staples built from EXISTING primitives (plus two tiny
 * mirror-effects, dealToEachPlayer / weakenAllCreatures). All leak-safe by construction
 * (damage/draw/destroy/pumps touch public zones or the caster's own hand). No new action.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'
import { currentKeywords, currentToughness } from '../../server/rules/characteristics.ts'
import { getDef } from '../../server/rules/cards/registry.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')
const onBf = (state: St, pid: string, cardName: string) =>
  state.zones.perPlayer[pid]!.battlefield.find((id) => getDef(state.objects[id]!.defName).name === cardName)!

describe("Hero's Downfall {1}{B}{B} — destroy target creature or planeswalker", () => {
  it('destroys a creature', () => {
    const { state, A, B } = makeDuel()
    const hd = putCard(state, A, "Hero's Downfall", 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 3)
    act(state, A, { type: 'r.cast', objId: hd, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
  })

  it('cannot target a land (filter is creature/planeswalker only)', () => {
    const { state, A, B } = makeDuel()
    const hd = putCard(state, A, "Hero's Downfall", 'hand')
    const land = putCard(state, B, 'Mountain', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 3)
    expect(() => act(state, A, { type: 'r.cast', objId: hd, targets: [land] })).toThrow()
  })
})

describe("Night's Whisper {1}{B} — draw two, lose 2 life", () => {
  it('draws 2 and loses 2 life', () => {
    const { state, A } = makeDuel()
    const nw = putCard(state, A, "Night's Whisper", 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    const hand0 = state.zones.perPlayer[A]!.hand.length // includes nw
    const life0 = state.players[A]!.life
    act(state, A, { type: 'r.cast', objId: nw, targets: [] })
    resolve(state, A)
    // nw left the hand (−1), drew 2 (+2) → net +1
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand0 - 1 + 2)
    expect(state.players[A]!.life).toBe(life0 - 2)
  })
})

describe('Flametongue Kavu {3}{R} 4/2 — ETB deals 4 to target creature', () => {
  it("kills a targeted 2/2 on resolution of the ETB", () => {
    const { state, A, B } = makeDuel()
    const ftk = putCard(state, A, 'Flametongue Kavu', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'R', 4)
    act(state, A, { type: 'r.cast', objId: ftk, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'FTK ETB')
    act(state, A, { type: 'r.chooseTargets', targets: [bear] })
    until(state, (s) => !s.zones.stack.length, 'ETB resolves')
    expect(state.objects[bear]!.zone).toBe('graveyard')
  })
})

describe('Acidic Slime {3}{G}{G} 2/2 deathtouch — ETB destroys artifact/enchantment/land', () => {
  it('has deathtouch and its ETB destroys a target land', () => {
    const { state, A, B } = makeDuel()
    const slime = putCard(state, A, 'Acidic Slime', 'hand')
    const land = putCard(state, B, 'Mountain', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 5)
    act(state, A, { type: 'r.cast', objId: slime, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'slime ETB')
    act(state, A, { type: 'r.chooseTargets', targets: [land] })
    until(state, (s) => !s.zones.stack.length, 'ETB resolves')
    expect(state.objects[land]!.zone).toBe('graveyard')
    expect(currentKeywords(state, state.objects[onBf(state, A, 'Acidic Slime')]!)).toContain('deathtouch')
  })
})

describe('Flame Rift {1}{R} — 4 damage to each player (symmetric)', () => {
  it('hits both players, including the caster', () => {
    const { state, A, B } = makeDuel()
    const fr = putCard(state, A, 'Flame Rift', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 2)
    const aLife = state.players[A]!.life
    const bLife = state.players[B]!.life
    act(state, A, { type: 'r.cast', objId: fr, targets: [] })
    resolve(state, A)
    expect(state.players[A]!.life).toBe(aLife - 4)
    expect(state.players[B]!.life).toBe(bLife - 4)
  })
})

describe('Languish {2}{B}{B} — all creatures get -4/-4', () => {
  it('kills small creatures but leaves a big one alive (proving -4/-4, not destroy-all)', () => {
    const { state, A, B } = makeDuel()
    const lang = putCard(state, A, 'Languish', 'hand')
    const small = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2 → dies
    const big = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2 + 3 counters = 5/5 → 1/1 survives
    act(state, B, { type: 'r.mCounter', objId: big, name: '+1/+1', delta: 3 })
    toStep(state, 'main1')
    addMana(state, A, 'B', 4)
    act(state, A, { type: 'r.cast', objId: lang, targets: [] })
    resolve(state, A)
    expect(state.objects[small]!.zone).toBe('graveyard')
    expect(state.objects[big]!.zone).toBe('battlefield')
    expect(currentToughness(state, state.objects[big]!)).toBe(1) // 5 − 4
  })
})
