/**
 * Perpetual card coverage — batch CARD65: a PITCH alternative cost (Force of Will — "pay 1 life and exile a
 * blue card from your hand rather than pay this spell's mana cost", CR 118.9) and a target kind spanning a
 * SPELL on the stack and a nonland permanent (Sink into Stupor, whose back face is a land).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name

describe('CARD65 — Force of Will', () => {
  /** A casts a Shock at B; B holds a Force of Will and a blue card to pitch */
  const setUp = (s: St, A: PlayerId, B: PlayerId) => {
    const fow = putCard(s, B, 'Force of Will', 'hand')
    const blue = putCard(s, B, 'Counterspell', 'hand') // a blue card to exile
    const shock = putCard(s, A, 'Shock', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'R', 1)
    act(s, A, { type: 'r.cast', objId: shock, targets: [B] })
    pass(s, A)
    return { fow, blue, shock }
  }

  it('counters a spell for 1 life and an exiled blue card, paying no mana', () => {
    const { state, A, B } = makeDuel()
    const { fow, blue, shock } = setUp(state, A, B)
    const offer = computeLegal(state, B).pitchCastable.find((p) => p.objId === fow)
    expect(offer).toBeTruthy()
    expect(offer!.life).toBe(1)
    expect(offer!.color).toBe('U')
    expect(offer!.candidateIds).toContain(blue)
    const life = state.players[B]!.life
    act(state, B, { type: 'r.cast', objId: fow, targets: [shock], pitch: true, exiles: [blue] })
    expect(state.players[B]!.life).toBe(life - 1)
    expect(state.objects[blue]!.zone).toBe('exile')
    until(state, (s) => !s.zones.stack.length, 'both resolve')
    expect(state.objects[shock]!.zone).toBe('graveyard') // countered
    expect(state.players[B]!.life).toBe(life - 1) // the Shock never resolved
  })

  it('refuses a non-blue pitch, the wrong count, and itself', () => {
    const { state, A, B } = makeDuel()
    const { fow, shock } = setUp(state, A, B)
    const red = putCard(state, B, 'Lightning Bolt', 'hand')
    expect(() => act(state, B, { type: 'r.cast', objId: fow, targets: [shock], pitch: true, exiles: [red] })).toThrow(/Exile a U card/)
    expect(() => act(state, B, { type: 'r.cast', objId: fow, targets: [shock], pitch: true, exiles: [] })).toThrow(/exactly one card/)
    expect(() => act(state, B, { type: 'r.cast', objId: fow, targets: [shock], pitch: true, exiles: [fow] })).toThrow(/not in your hand/)
  })

  it('is not offered with no blue card to exile, and can still be cast for mana', () => {
    const { state, A, B } = makeDuel()
    const fow = putCard(state, B, 'Force of Will', 'hand')
    // the shared test deck holds Divination ({2}{U}), so a random opening hand can contain a blue card
    // and make the pitch legal — strip the hand to the Force of Will so "no blue card" is deterministic
    for (const id of [...state.zones.perPlayer[B]!.hand]) if (id !== fow) act(state, B, { type: 'r.mMove', objId: id, zone: 'library' })
    const shock = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [B] })
    pass(state, A)
    expect(computeLegal(state, B).pitchCastable).toEqual([])
    addMana(state, B, 'U', 2)
    addMana(state, B, 'C', 3)
    act(state, B, { type: 'r.cast', objId: fow, targets: [shock] })
    until(state, (s) => !s.zones.stack.length, 'both resolve')
    expect(state.objects[shock]!.zone).toBe('graveyard')
  })

  it('is not offered at 0 life', () => {
    const { state, A, B } = makeDuel()
    const { fow } = setUp(state, A, B)
    state.players[B]!.life = 0
    expect(computeLegal(state, B).pitchCastable.some((p) => p.objId === fow)).toBe(false)
  })
})

describe('CARD65 — Sink into Stupor', () => {
  const cast = (s: St, p: PlayerId, target: ObjId) => {
    const sink = putCard(s, p, 'Sink into Stupor', 'hand')
    addMana(s, p, 'U', 2)
    addMana(s, p, 'C', 1)
    act(s, p, { type: 'r.cast', objId: sink, targets: [target] })
    return sink
  }

  it('returns a SPELL on the stack to its owner\'s hand, re-minted', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    pass(state, A)
    cast(state, B, bear)
    until(state, (s) => !s.zones.stack.length, 'it resolves')
    // the Bear went from the stack to A's hand — public → hidden, so its id was re-minted
    expect(state.objects[bear]).toBeUndefined()
    expect(state.zones.perPlayer[A]!.hand.some((id) => nameOf(state, id) === 'Grizzly Bears')).toBe(true)
  })

  it("returns an opponent's nonland permanent, but not a land or your own", () => {
    const { state, A, B } = makeDuel()
    const theirs = putCard(state, A, 'Sol Ring', 'battlefield')
    const theirLand = putCard(state, A, 'Mountain', 'battlefield')
    const mine = putCard(state, B, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    pass(state, A)
    const sink = putCard(state, B, 'Sink into Stupor', 'hand')
    addMana(state, B, 'U', 2)
    addMana(state, B, 'C', 1)
    expect(() => act(state, B, { type: 'r.cast', objId: sink, targets: [theirLand] })).toThrow(/BAD_TARGETS|Illegal target/i)
    expect(() => act(state, B, { type: 'r.cast', objId: sink, targets: [mine] })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, B, { type: 'r.cast', objId: sink, targets: [theirs] })
    until(state, (s) => !s.zones.stack.length, 'it resolves')
    expect(state.objects[theirs]).toBeUndefined() // bounced and re-minted into A's hand
    expect(state.zones.perPlayer[A]!.hand.some((id) => nameOf(state, id) === 'Sol Ring')).toBe(true)
  })

  it('can be played as Soporific Springs instead (pay 3 life or enter tapped)', () => {
    const { state, A } = makeDuel()
    const card = putCard(state, A, 'Sink into Stupor', 'hand')
    toStep(state, 'main1')
    expect(computeLegal(state, A).playableBackLandIds).toContain(card)
    act(state, A, { type: 'r.playLand', objId: card, back: true })
    expect(nameOf(state, card)).toBe('Soporific Springs')
    expect(state.pending?.kind).toBe('entersChoice')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.entersChoice', pay: true })
    expect(state.players[A]!.life).toBe(life - 3)
    expect(state.objects[card]!.tapped).toBe(false)
    act(state, A, { type: 'r.tapMana', objId: card, color: 'U' })
    expect(state.players[A]!.manaPool.U).toBe(1)
  })
})
