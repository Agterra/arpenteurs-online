/**
 * Perpetual card coverage — batch CARD54: "you gain protection from everything" (CR 702.16e) as a
 * PLAYER-level shield, "your life total can't change" enforced at the single changeLife funnel, and
 * "all permanents you control phase out" riding the engine's existing phasing. Cards: Teferi's
 * Protection and The One Ring (whose ETB only fires "if you cast it").
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe("CARD54 — Teferi's Protection", () => {
  const cast = (s: St, A: PlayerId) => {
    const spell = putCard(s, A, "Teferi's Protection", 'hand')
    addMana(s, A, 'W', 1)
    addMana(s, A, 'C', 2)
    act(s, A, { type: 'r.cast', objId: spell, targets: [] })
    resolve(s, A)
  }

  it('locks your life total and shields you from targeting and damage', () => {
    const { state, A, B } = makeDuel()
    toStep(state, 'main1')
    cast(state, A)
    expect(state.players[A]!.protectedFromEverything).toBe(true)
    expect(state.players[A]!.lifeCantChange).toBe(true)
    const life = state.players[A]!.life
    // an opponent can't even target them
    const shock = putCard(state, B, 'Shock', 'hand')
    pass(state, A)
    addMana(state, B, 'R', 1)
    expect(() => act(state, B, { type: 'r.cast', objId: shock, targets: [A] })).toThrow(/BAD_TARGETS|Illegal target/i)
    // …and a life change from ANY source does nothing — here A's own pain land, whose colour costs
    // 1 life: the payment passes through changeLife and is refused
    const springs = putCard(state, A, 'Sulfurous Springs', 'battlefield')
    pass(state, B)
    act(state, A, { type: 'r.tapMana', objId: springs, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
    expect(state.players[A]!.life).toBe(life)
    expect(state.log.some((l) => /life total can't change/.test(l))).toBe(true)
  })

  it('phases out every permanent you control, and they come back on your next turn', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const land = putCard(state, A, 'Mountain', 'battlefield')
    toStep(state, 'main1')
    cast(state, A)
    expect(state.objects[bear]!.phasedOut).toBe(true)
    expect(state.objects[land]!.phasedOut).toBe(true)
    // a phased-out land can't be tapped for mana
    expect(() => act(state, A, { type: 'r.tapMana', objId: land, color: 'R' })).toThrow(/NOT_YOURS|don't control/i)
    until(state, (s) => s.activePlayer === A && s.turnNumber > 1 && s.step === 'main1', "A's next turn")
    expect(state.objects[bear]!.phasedOut).toBeFalsy()
    expect(state.objects[land]!.phasedOut).toBeFalsy()
  })

  it('the shield ends as your next turn begins', () => {
    const { state, A } = makeDuel()
    toStep(state, 'main1')
    cast(state, A)
    until(state, (s) => s.activePlayer === A && s.turnNumber > 1 && s.step === 'main1', "A's next turn")
    expect(state.players[A]!.protectedFromEverything).toBeFalsy()
    expect(state.players[A]!.lifeCantChange).toBeFalsy()
    expect(state.log.some((l) => /protection from everything ends/.test(l))).toBe(true)
  })

  it('prevents COMBAT damage while it holds', () => {
    const { state, A, B } = makeDuel()
    const attacker = putCard(state, B, 'Gray Ogre', 'battlefield')
    state.objects[attacker]!.summoningSick = false
    toStep(state, 'main1')
    cast(state, A)
    const life = state.players[A]!.life
    until(state, (s) => s.turnNumber === 2 && s.pending?.kind === 'attackers' && s.pending.player === B, "B's attack")
    attack(state, B, A, [attacker])
    until(state, (s) => s.step === 'end' || s.turnNumber > 2, 'past combat')
    expect(state.players[A]!.life).toBe(life)
    expect(state.log.some((l) => /protection from everything — 2 damage prevented/.test(l))).toBe(true)
  })
})

describe('CARD54 — The One Ring', () => {
  const castRing = (s: St, A: PlayerId) => {
    const ring = putCard(s, A, 'The One Ring', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'C', 4)
    act(s, A, { type: 'r.cast', objId: ring, targets: [] })
    resolve(s, A)
    return ring
  }

  it('shields you when CAST, but not when it arrives another way', () => {
    const { state, A } = makeDuel()
    castRing(state, A)
    expect(state.players[A]!.protectedFromEverything).toBe(true)
    expect(state.players[A]!.lifeCantChange).toBeFalsy() // only Teferi's locks life
    // a copy put onto the battlefield by hand did not get cast → no shield
    const other = makeDuel()
    const ring2 = putCard(other.state, other.A, 'The One Ring', 'hand')
    toStep(other.state, 'main1')
    act(other.state, other.A, { type: 'r.mMove', objId: ring2, zone: 'battlefield' })
    until(other.state, (s) => !s.zones.stack.length && s.priorityPlayer === other.A, 'settle')
    expect(other.state.players[other.A]!.protectedFromEverything).toBeFalsy()
  })

  it('draws one more card each activation, and bleeds you at your upkeep', () => {
    const { state, A } = makeDuel()
    const ring = castRing(state, A)
    let hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.activate', objId: ring, abilityIndex: 0, targets: [] })
    resolve(state, A)
    expect(state.objects[ring]!.counters['burden']).toBe(1)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 1)
    // untap it by hand to use it again this turn (it normally waits a turn)
    state.objects[ring]!.tapped = false
    hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.activate', objId: ring, abilityIndex: 0, targets: [] })
    resolve(state, A)
    expect(state.objects[ring]!.counters['burden']).toBe(2)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 2)
    // …and the upkeep costs 1 life per burden counter (the shield has ended by then)
    until(state, (s) => s.activePlayer === A && s.turnNumber > 1 && s.step === 'upkeep', "A's next upkeep")
    const life = state.players[A]!.life
    until(state, (s) => s.players[A]!.life !== life || s.step === 'main1', 'the upkeep loss')
    expect(state.players[A]!.life).toBe(life - 2)
  })

  it('is indestructible', () => {
    const { state, A, B } = makeDuel()
    const ring = castRing(state, A)
    const naturalize = putCard(state, B, 'Naturalize', 'hand')
    pass(state, A)
    addMana(state, B, 'G', 1)
    addMana(state, B, 'C', 1)
    act(state, B, { type: 'r.cast', objId: naturalize, targets: [ring] })
    until(state, (s) => !s.zones.stack.length, 'the naturalize')
    expect(state.objects[ring]!.zone).toBe('battlefield')
  })

  it('its ability is offered while untapped only', () => {
    const { state, A } = makeDuel()
    const ring = castRing(state, A)
    expect(computeLegal(state, A).activations.some((a) => a.objId === ring)).toBe(true)
    state.objects[ring]!.tapped = true
    expect(computeLegal(state, A).activations.some((a) => a.objId === ring)).toBe(false)
  })
})
