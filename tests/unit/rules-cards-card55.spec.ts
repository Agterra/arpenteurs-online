/**
 * Perpetual card coverage — batch CARD55: Urza's Saga — a Saga that grants ITSELF abilities chapter by
 * chapter, then fetches a cheap artifact and is sacrificed. The granted abilities are declared on the
 * card and gated on the lore counter that chapter adds (`requiresLoreAtLeast`), and its Construct token
 * has a live board-counting P/T (`dynamicPT`), which Storm-Kiln Artist shares.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { currentPT } from '../../server/rules/characteristics.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const lore = (s: St, id: ObjId) => s.objects[id]!.counters.lore ?? 0
/** play the Saga and settle its chapter I */
const playSaga = (s: St, A: PlayerId) => {
  const saga = putCard(s, A, "Urza's Saga", 'hand')
  toStep(s, 'main1')
  act(s, A, { type: 'r.playLand', objId: saga })
  resolve(s, A)
  return saga
}

describe("CARD55 — Urza's Saga", () => {
  it('is a land you play, and chapter I grants it "{T}: Add {C}"', () => {
    const { state, A } = makeDuel()
    const saga = playSaga(state, A)
    expect(state.players[A]!.landsPlayedThisTurn).toBe(1) // it IS a land
    expect(lore(state, saga)).toBe(1)
    expect(computeLegal(state, A).manaSourceIds).toContain(saga)
    act(state, A, { type: 'r.tapMana', objId: saga, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
  })

  it('has NO mana ability before chapter I', () => {
    const { state, A } = makeDuel()
    const saga = putCard(state, A, "Urza's Saga", 'battlefield')
    toStep(state, 'main1')
    state.objects[saga]!.counters = {} // model "chapter I not reached yet"
    expect(computeLegal(state, A).manaSourceIds).not.toContain(saga)
    expect(() => act(state, A, { type: 'r.tapMana', objId: saga, color: 'C' })).toThrow(/not been granted/)
  })

  it('chapter II grants the Construct maker, which is hidden until then', () => {
    const { state, A } = makeDuel()
    const saga = playSaga(state, A)
    expect(computeLegal(state, A).activations.some((a) => a.objId === saga)).toBe(false)
    expect(() => act(state, A, { type: 'r.activate', objId: saga, abilityIndex: 1, targets: [] })).toThrow(/not been granted/)
    // …the next turn brings chapter II
    until(state, (s) => s.activePlayer === A && s.turnNumber > 1 && lore(s, saga) >= 2, 'chapter II')
    resolve(state, A)
    const offered = computeLegal(state, A).activations.find((a) => a.objId === saga)
    expect(offered?.cost).toBe('{2}')
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.activate', objId: saga, abilityIndex: 1, targets: [] })
    resolve(state, A)
    const construct = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Construct')!
    expect(construct).toBeTruthy()
    // a 0/0 that counts artifacts: itself, so 1/1 right now
    expect(currentPT(state, state.objects[construct]!)).toEqual({ power: 1, toughness: 1 })
    // …and it grows with each artifact you control
    putCard(state, A, 'Sol Ring', 'battlefield')
    putCard(state, A, 'Mind Stone', 'battlefield')
    expect(currentPT(state, state.objects[construct]!)).toEqual({ power: 3, toughness: 3 })
  })

  it('chapter III fetches a cheap artifact and the Saga is sacrificed', () => {
    const { state, A } = makeDuel()
    const cheap = putCard(state, A, 'Sol Ring', 'library') // MV 1
    putCard(state, A, 'Aetherflux Reservoir', 'library') // MV 4: not a legal find
    const saga = playSaga(state, A)
    until(state, (s) => lore(s, saga) >= 3 || s.pending?.kind === 'search', 'chapter III')
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, 'the artifact search')
    const matches = state.pendingSearch!.matchIds.map((id) => nameOf(state, id))
    expect(matches).toContain('Sol Ring')
    expect(matches).not.toContain('Aetherflux Reservoir')
    act(state, A, { type: 'r.search', cardIds: [cheap] })
    expect(state.objects[cheap]!.zone).toBe('battlefield')
    // the Saga is sacrificed once the final chapter has resolved (CR 714.4)
    until(state, (s) => s.objects[saga]!.zone !== 'battlefield' || s.turnNumber > 4, 'the sacrifice')
    expect(state.objects[saga]!.zone).toBe('graveyard')
  })

  it('the Construct survives on its own once other artifacts arrive', () => {
    const { state, A } = makeDuel()
    // build the Construct directly to isolate the P/T maths
    const saga = putCard(state, A, "Urza's Saga", 'battlefield')
    toStep(state, 'main1')
    state.objects[saga]!.counters.lore = 2 // after the draw step, or a third counter would sacrifice it
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.activate', objId: saga, abilityIndex: 1, targets: [] })
    resolve(state, A)
    const construct = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Construct')!
    expect(currentPT(state, state.objects[construct]!).power).toBe(1) // it counts itself
    const ring = putCard(state, A, 'Sol Ring', 'battlefield')
    expect(currentPT(state, state.objects[construct]!).power).toBe(2)
    // removing the artifact shrinks it again (the count is live, not a snapshot)
    act(state, A, { type: 'r.mMove', objId: ring, zone: 'graveyard' })
    expect(currentPT(state, state.objects[construct]!).power).toBe(1)
  })
})

describe('CARD55 — Storm-Kiln Artist', () => {
  it('gets +1/+0 per artifact you control and makes a Treasure on your instants', () => {
    const { state, A } = makeDuel()
    const artist = putCard(state, A, 'Storm-Kiln Artist', 'battlefield')
    toStep(state, 'main1')
    expect(currentPT(state, state.objects[artist]!)).toEqual({ power: 2, toughness: 3 }) // no artifacts yet
    putCard(state, A, 'Sol Ring', 'battlefield')
    expect(currentPT(state, state.objects[artist]!)).toEqual({ power: 3, toughness: 3 })
    // magecraft: an instant makes a Treasure, which then also pumps it
    const shock = putCard(state, A, 'Shock', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [A] })
    resolve(state, A)
    const treasures = state.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(state, id) === 'Treasure')
    expect(treasures.length).toBe(1)
    expect(currentPT(state, state.objects[artist]!)).toEqual({ power: 4, toughness: 3 })
  })

  it('does not trigger on a creature spell', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Storm-Kiln Artist', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: ogre, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(state, id) === 'Treasure').length).toBe(0)
  })
})
