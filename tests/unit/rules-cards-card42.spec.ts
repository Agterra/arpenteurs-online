/**
 * Perpetual card coverage — batch CARD42: IMPULSE DRAW — "exile the top N cards of your library;
 * you may play those cards" — in both printed windows ("this turn" for Jeska's Will, "until the end
 * of your next turn" for Reckless Impulse / Wrenn's Resolve / Commune with Lava). Playing includes
 * LANDS (they use your land drop), and the permission expires while the card stays in exile.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
/** the cards this player may cast / play out of exile right now, per redact */
const exileOffers = (s: St, p: PlayerId) => {
  const l = computeLegal(s, p)
  return { cast: l.castExileIds, lands: l.playableExileLandIds }
}

describe('CARD42 — Reckless Impulse (until the end of your NEXT turn)', () => {
  const castImpulse = (s: St, A: PlayerId) => {
    const spell = putCard(s, A, 'Reckless Impulse', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'R', 1)
    addMana(s, A, 'C', 1)
    act(s, A, { type: 'r.cast', objId: spell, targets: [] })
    resolve(s, A)
    return spell
  }

  it('exiles the top two cards face up and lets you cast one of them', () => {
    const { state, A } = makeDuel()
    const shock = putCard(state, A, 'Shock', 'library')
    const bolt = putCard(state, A, 'Lightning Bolt', 'library')
    // put them on top: putCard appends, so rig the order explicitly
    const lib = state.zones.perPlayer[A]!.library
    lib.splice(lib.indexOf(shock), 1)
    lib.splice(lib.indexOf(bolt), 1)
    lib.unshift(shock, bolt)
    castImpulse(state, A)
    expect(state.objects[shock]!.zone).toBe('exile')
    expect(state.objects[bolt]!.zone).toBe('exile')
    expect(state.objects[shock]!.playableBy).toBe(A)
    // redact offers an exiled card only while its cost is payable (like any castable card)
    expect(exileOffers(state, A).cast).toEqual([])
    addMana(state, A, 'R', 1)
    expect(exileOffers(state, A).cast).toEqual(expect.arrayContaining([shock, bolt]))
    // cast Shock straight out of exile, at its printed cost, with a target
    act(state, A, { type: 'r.cast', objId: shock, targets: [A] })
    resolve(state, A)
    expect(state.players[A]!.life).toBe(38)
    expect(state.objects[shock]!.zone).toBe('graveyard')
  })

  it('an opponent may NOT play your exiled cards', () => {
    const { state, A, B } = makeDuel()
    const top = putCard(state, A, 'Shock', 'library')
    const lib = state.zones.perPlayer[A]!.library
    lib.splice(lib.indexOf(top), 1)
    lib.unshift(top)
    castImpulse(state, A)
    expect(state.objects[top]!.zone).toBe('exile')
    expect(exileOffers(state, B).cast).not.toContain(top)
    pass(state, A)
    addMana(state, B, 'R', 1)
    expect(() => act(state, B, { type: 'r.cast', objId: top, targets: [A] })).toThrow(/NOT_IN_HAND|hand/i)
  })

  it('the window survives the cleanup of THIS turn and closes at the end of your next one', () => {
    const { state, A } = makeDuel()
    const top = putCard(state, A, 'Shock', 'library')
    const lib = state.zones.perPlayer[A]!.library
    lib.splice(lib.indexOf(top), 1)
    lib.unshift(top)
    castImpulse(state, A)
    const turn = state.turnNumber
    // …the opponent's whole turn passes and it is still playable
    until(state, (s) => s.turnNumber > turn && s.step === 'main1' && s.activePlayer !== A, "the opponent's turn")
    expect(state.objects[top]!.playableUntil).toBe('endOfYourNextTurn')
    // …through to the end of A's own next turn, after which the permission is gone
    until(state, (s) => s.activePlayer === A && s.turnNumber > turn && s.step === 'main1', "A's next turn")
    expect(state.objects[top]!.playableBy).toBe(A)
    until(state, (s) => s.turnNumber > turn + 1 || s.activePlayer !== A, "A's turn ending")
    until(state, (s) => !s.objects[top]!.playableUntil, 'the window closing')
    expect(state.objects[top]!.zone).toBe('exile') // it just stays in exile, unplayable
    expect(computeLegal(state, A).castExileIds).not.toContain(top)
  })
})

describe('CARD42 — a LAND exiled this way is played from exile', () => {
  it('uses your land drop and enters the battlefield', () => {
    const { state, A } = makeDuel()
    const land = putCard(state, A, 'Mountain', 'library')
    const lib = state.zones.perPlayer[A]!.library
    lib.splice(lib.indexOf(land), 1)
    lib.unshift(land)
    const spell = putCard(state, A, "Wrenn's Resolve", 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: spell, targets: [] })
    resolve(state, A)
    const offers = exileOffers(state, A)
    expect(offers.lands).toContain(land)
    expect(offers.cast).not.toContain(land) // a land is played, not cast
    act(state, A, { type: 'r.playLand', objId: land })
    expect(state.objects[land]!.zone).toBe('battlefield')
    expect(state.players[A]!.landsPlayedThisTurn).toBe(1)
    // …and a second land from the same exile is refused: the drop is spent
    const other = state.zones.perPlayer[A]!.exile.find((id) => nameOf(state, id) === 'Mountain' && id !== land)
    if (other) expect(() => act(state, A, { type: 'r.playLand', objId: other })).toThrow(/LAND_LIMIT|Already played/i)
    expect(exileOffers(state, A).lands).toEqual([])
  })
})

describe("CARD42 — Jeska's Will (both modes with a commander)", () => {
  const rigCommander = (s: St, p: PlayerId) => {
    const cmd = putCard(s, p, 'Loran of the Third Path', 'battlefield')
    s.players[p]!.commanderId = cmd
    s.objects[cmd]!.isCommander = true
    return cmd
  }
  const cast = (s: St, A: PlayerId, modes: number[], targets: (ObjId | PlayerId)[] = []) => {
    const will = putCard(s, A, "Jeska's Will", 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'R', 1)
    addMana(s, A, 'C', 2)
    act(s, A, { type: 'r.cast', objId: will, targets, modes })
    resolve(s, A)
    return will
  }

  it("mode 0 adds {R} per card in the target opponent's hand", () => {
    const { state, A, B } = makeDuel()
    const hand = state.zones.perPlayer[B]!.hand.length
    expect(hand).toBeGreaterThan(0)
    cast(state, A, [0], [B])
    expect(state.players[A]!.manaPool.R).toBe(hand)
  })

  it('mode 1 exiles three cards playable THIS turn only', () => {
    const { state, A } = makeDuel()
    cast(state, A, [1])
    const exiled = state.zones.perPlayer[A]!.exile.filter((id) => state.objects[id]!.playableBy === A)
    expect(exiled.length).toBe(3)
    expect(state.objects[exiled[0]!]!.playableUntil).toBe('endOfTurn')
    const turn = state.turnNumber
    until(state, (s) => s.turnNumber > turn, 'the next turn')
    expect(state.objects[exiled[0]!]!.playableUntil).toBeUndefined() // the window closed at cleanup
    expect(state.objects[exiled[0]!]!.zone).toBe('exile')
  })

  it('with a commander, BOTH modes happen (mana first, then the exile)', () => {
    const { state, A, B } = makeDuel()
    rigCommander(state, A)
    const theirHand = state.zones.perPlayer[B]!.hand.length
    cast(state, A, [0, 1], [B])
    expect(state.players[A]!.manaPool.R).toBe(theirHand)
    expect(state.zones.perPlayer[A]!.exile.filter((id) => state.objects[id]!.playableBy === A).length).toBe(3)
  })

  it('without a commander, both modes are refused', () => {
    const { state, A, B } = makeDuel()
    const will = putCard(state, A, "Jeska's Will", 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    expect(() => act(state, A, { type: 'r.cast', objId: will, targets: [B], modes: [0, 1] })).toThrow(/Choose exactly 1 mode/)
  })
})

describe('CARD42 — Commune with Lava (X cards, at instant speed)', () => {
  it('exiles X cards and can be cast on an opponent\'s turn', () => {
    const { state, A, B } = makeDuel()
    const spell = putCard(state, A, 'Commune with Lava', 'hand')
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    pass(state, B)
    addMana(state, A, 'R', 2)
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.cast', objId: spell, targets: [], x: 3 })
    until(state, (s) => !s.zones.stack.length, 'resolve')
    const exiled = state.zones.perPlayer[A]!.exile.filter((id) => state.objects[id]!.playableBy === A)
    expect(exiled.length).toBe(3)
    expect(state.objects[exiled[0]!]!.playableUntil).toBe('endOfYourNextTurn')
  })

  it('X = 0 exiles nothing and simply resolves', () => {
    const { state, A } = makeDuel()
    const spell = putCard(state, A, 'Commune with Lava', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 2)
    act(state, A, { type: 'r.cast', objId: spell, targets: [], x: 0 })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.exile.filter((id) => state.objects[id]!.playableBy === A).length).toBe(0)
    expect(state.objects[spell]!.zone).toBe('graveyard')
  })

  it('an exiled INSTANT stays castable outside your main phase, a sorcery does not', () => {
    const { state, A, B } = makeDuel()
    const instant = putCard(state, A, 'Shock', 'library')
    const sorcery = putCard(state, A, 'Gamble', 'library')
    const lib = state.zones.perPlayer[A]!.library
    for (const id of [instant, sorcery]) lib.splice(lib.indexOf(id), 1)
    lib.unshift(instant, sorcery)
    const spell = putCard(state, A, 'Reckless Impulse', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: spell, targets: [] })
    resolve(state, A)
    // in your main phase both are offered (once their costs are payable)
    addMana(state, A, 'R', 2)
    expect(exileOffers(state, A).cast).toEqual(expect.arrayContaining([instant, sorcery]))
    // on the opponent's turn only the instant is
    until(state, (s) => s.activePlayer === B && s.step === 'main1', "B's turn")
    pass(state, B)
    addMana(state, A, 'R', 2)
    const offers = exileOffers(state, A).cast
    expect(offers).toContain(instant)
    expect(offers).not.toContain(sorcery)
    expect(() => act(state, A, { type: 'r.cast', objId: sorcery, targets: [] })).toThrow(/TIMING|main phase/i)
    act(state, A, { type: 'r.cast', objId: instant, targets: [B] })
    until(state, (s) => s.players[B]!.life !== 40, 'the Shock')
    expect(state.players[B]!.life).toBe(38)
  })
})
