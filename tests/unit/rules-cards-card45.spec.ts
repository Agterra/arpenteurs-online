/**
 * Perpetual card coverage — batch CARD45: MODAL double-faced cards (CR 712.4) — a spell/creature
 * front face with a LAND back face you may play instead of casting it. The choice is made as the card
 * leaves your hand; the land enters through the normal path (so "enters tapped" and the pay-3-life
 * as-enters choice both still apply), and it reverts to its front face when it leaves the battlefield.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const nameOf = (s: St, id: string) => getDef(s.objects[id]!.defName).name

describe('CARD45 — playing the LAND back face', () => {
  it('Fell the Profane can be played as Fell Mire, paying 3 life to enter untapped', () => {
    const { state, A } = makeDuel()
    const card = putCard(state, A, 'Fell the Profane', 'hand')
    toStep(state, 'main1')
    expect(computeLegal(state, A).playableBackLandIds).toContain(card)
    act(state, A, { type: 'r.playLand', objId: card, back: true })
    // it is now the land face, and its as-enters choice is waiting
    expect(nameOf(state, card)).toBe('Fell Mire')
    expect(state.pending?.kind).toBe('entersChoice')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.entersChoice', pay: true })
    expect(state.players[A]!.life).toBe(life - 3)
    expect(state.objects[card]!.tapped).toBe(false)
    expect(state.players[A]!.landsPlayedThisTurn).toBe(1)
    act(state, A, { type: 'r.tapMana', objId: card, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })

  it('…or declines and enters tapped', () => {
    const { state, A } = makeDuel()
    const card = putCard(state, A, 'Witch Enchanter', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: card, back: true })
    expect(nameOf(state, card)).toBe('Witch-Blessed Meadow')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.entersChoice', pay: false })
    expect(state.players[A]!.life).toBe(life)
    expect(state.objects[card]!.tapped).toBe(true)
  })

  it("Bala Ged Sanctuary always enters tapped, and the land drop is spent", () => {
    const { state, A } = makeDuel()
    const card = putCard(state, A, 'Bala Ged Recovery', 'hand')
    const plain = putCard(state, A, 'Forest', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: card, back: true })
    expect(nameOf(state, card)).toBe('Bala Ged Sanctuary')
    expect(state.objects[card]!.tapped).toBe(true)
    expect(state.pending).toBeFalsy() // no choice on this one
    // one land per turn: the second is refused and no longer offered
    expect(() => act(state, A, { type: 'r.playLand', objId: plain })).toThrow(/LAND_LIMIT|Already played/i)
    expect(computeLegal(state, A).playableBackLandIds).toEqual([])
  })

  it('is refused outside your main phase and for a card with no back face', () => {
    const { state, A } = makeDuel()
    const card = putCard(state, A, 'Fell the Profane', 'hand')
    const shock = putCard(state, A, 'Shock', 'hand')
    expect(computeLegal(state, A).playableBackLandIds).toEqual([]) // upkeep: not a main phase
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.playLand', objId: shock, back: true })).toThrow(/no land back face/i)
    act(state, A, { type: 'r.playLand', objId: card, back: true })
    expect(state.objects[card]!.zone).toBe('battlefield')
  })

  it('reverts to its FRONT face when it leaves the battlefield', () => {
    const { state, A, B } = makeDuel()
    const card = putCard(state, A, 'Bala Ged Recovery', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: card, back: true })
    expect(nameOf(state, card)).toBe('Bala Ged Sanctuary')
    // destroy the land: the card in the graveyard is the FRONT face again (CR 712.13)
    const warp = putCard(state, B, 'Beast Within', 'hand') // destroy target permanent
    act(state, A, { type: 'r.pass' })
    addMana(state, B, 'G', 1)
    addMana(state, B, 'C', 2)
    act(state, B, { type: 'r.cast', objId: warp, targets: [card] })
    until(state, (s) => s.objects[card]!.zone === 'graveyard', 'the destruction')
    expect(nameOf(state, card)).toBe('Bala Ged Recovery')
  })
})

describe('CARD45 — the FRONT faces still work as printed', () => {
  it('Fell the Profane destroys a creature or planeswalker, but not an artifact', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')
    const card = putCard(state, A, 'Fell the Profane', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    addMana(state, A, 'C', 2)
    expect(() => act(state, A, { type: 'r.cast', objId: card, targets: [rock] })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, A, { type: 'r.cast', objId: card, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(state.objects[card]!.zone).toBe('graveyard')
  })

  it('Bala Ged Recovery returns any card from your graveyard', () => {
    const { state, A } = makeDuel()
    const dead = putCard(state, A, 'Sol Ring', 'graveyard') // "any card", not just a creature
    const card = putCard(state, A, 'Bala Ged Recovery', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: card, targets: [dead] })
    resolve(state, A)
    // graveyard → hand is public → hidden, so the id is re-minted: check by name
    expect(state.zones.perPlayer[A]!.hand.some((id) => nameOf(state, id) === 'Sol Ring')).toBe(true)
    expect(state.zones.perPlayer[A]!.graveyard).not.toContain(dead)
  })

  it("Witch Enchanter's ETB may destroy an opponent's artifact or enchantment", () => {
    const { state, A, B } = makeDuel()
    const theirs = putCard(state, B, 'Sol Ring', 'battlefield')
    const mine = putCard(state, A, 'Sol Ring', 'battlefield')
    const card = putCard(state, A, 'Witch Enchanter', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.cast', objId: card, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [mine] })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, A, { type: 'r.chooseTargets', targets: [theirs] })
    resolve(state, A)
    expect(state.objects[theirs]!.zone).toBe('graveyard')
    expect(state.objects[card]!.zone).toBe('battlefield') // a 3/3 creature, not a land
  })
})
