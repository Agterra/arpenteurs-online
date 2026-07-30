/**
 * Perpetual card coverage — batch CARD67, the last two top-200 gaps:
 *  - Mosswort Bridge — HIDEAWAY 4 (CR 702.76): look at the top four, exile one FACE DOWN, bottom the
 *    rest at random; later "{G}, {T}: you may play the exiled card without paying its mana cost if
 *    creatures you control have total power 10 or greater".
 *  - Gemstone Caverns — the pre-game "if this card is in your OPENING HAND and you're not the starting
 *    player, you may begin the game with it on the battlefield with a luck counter" offer (CR 103.6),
 *    plus a mana ability gated on that counter.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, makeGameNMulligan, putCard, toStep, until } from './rules-helpers.ts'
import { applyRulesAction } from '../../server/rules/engine.ts'
import { computeLegal, redactRulesState } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
/** put Mosswort Bridge out properly (it enters tapped and its hideaway trigger must resolve) */
const playBridge = (s: St, A: PlayerId) => {
  const bridge = putCard(s, A, 'Mosswort Bridge', 'hand')
  toStep(s, 'main1')
  act(s, A, { type: 'r.playLand', objId: bridge })
  until(s, (x) => x.pending?.kind === 'hideaway' && x.pending.player === A, 'the hideaway look')
  return bridge
}
/** the face-down card this permanent hid away */
const hiddenOf = (s: St, sourceId: ObjId) =>
  Object.values(s.objects).find((o) => o.hiddenBy === sourceId && o.zone === 'exile')

describe('CARD67 — Mosswort Bridge (hideaway 4)', () => {
  it('enters tapped, looks at four, exiles one face down and bottoms the rest', () => {
    const { state, A } = makeDuel()
    const libBefore = state.zones.perPlayer[A]!.library.length
    const bridge = playBridge(state, A)
    expect(state.objects[bridge]!.tapped).toBe(true)
    const legal = computeLegal(state, A)
    expect(legal.needsHideaway).toBe(true)
    expect(legal.hideawayIds.length).toBe(4)
    expect(legal.hideawaySourceName).toBe('Mosswort Bridge')
    const pick = legal.hideawayIds[1]!
    const pickName = nameOf(state, pick)
    act(state, A, { type: 'r.hideaway', objId: pick })
    // the pick is exiled FACE DOWN and bound to the Bridge; the other three went to the bottom
    const hidden = hiddenOf(state, bridge)!
    expect(hidden.id).toBe(pick)
    expect(hidden.faceDown).toBe(true)
    expect(nameOf(state, hidden.id)).toBe(pickName)
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore - 1)
    expect(state.pending).toBeFalsy()
  })

  it('the look is published to its own player ONLY', () => {
    const { state, A, B } = makeDuel()
    playBridge(state, A)
    const mine = redactRulesState(state, A)
    const theirs = redactRulesState(state, B)
    expect(mine.hideaway!.cardIds.length).toBe(4)
    for (const id of mine.hideaway!.cardIds) expect(mine.cards[id]).toBeTruthy()
    expect(theirs.hideaway).toBeNull()
    expect(computeLegal(state, B).needsHideaway).toBe(false)
    for (const id of mine.hideaway!.cardIds) expect(theirs.cards[id]).toBeUndefined()
  })

  it('the hidden card stays anonymous to the opponent once exiled', () => {
    const { state, A, B } = makeDuel()
    const bridge = playBridge(state, A)
    const pick = computeLegal(state, A).hideawayIds[0]!
    act(state, A, { type: 'r.hideaway', objId: pick })
    const theirs = redactRulesState(state, B)
    const mine = redactRulesState(state, A)
    expect(theirs.cards[pick]?.faceDown).toBe(true)
    expect(theirs.cards[pick]?.defName ?? '').toBe('') // no identity
    expect(mine.cards[pick]?.defName).toBe(state.objects[pick]!.defName) // its owner looked at it
    expect(state.objects[bridge]!.zone).toBe('battlefield')
  })

  it('refuses a card you are not looking at', () => {
    const { state, A } = makeDuel()
    playBridge(state, A)
    const notInLook = state.zones.perPlayer[A]!.library[8]!
    expect(() => act(state, A, { type: 'r.hideaway', objId: notInLook })).toThrow(/not one of the cards/i)
  })

  it('its second ability does nothing below total power 10, and plays the card at 10', () => {
    const { state, A } = makeDuel()
    const bridge = playBridge(state, A)
    act(state, A, { type: 'r.hideaway', objId: computeLegal(state, A).hideawayIds[0]! })
    const hidden = hiddenOf(state, bridge)!
    state.objects[bridge]!.tapped = false
    // 3 power on board: not enough
    putCard(state, A, 'Hill Giant', 'battlefield') // 3/3
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.activate', objId: bridge, abilityIndex: 1, targets: [] })
    until(state, (s) => !s.zones.stack.length, 'the ability resolves')
    expect(state.log.some((l) => /total power is only 3/.test(l))).toBe(true)
    expect(state.pending).toBeFalsy()
    expect(hiddenOf(state, bridge)).toBeTruthy() // still hidden away
    // …now 12 power
    state.objects[bridge]!.tapped = false
    putCard(state, A, 'Hill Giant', 'battlefield')
    putCard(state, A, 'Hill Giant', 'battlefield')
    putCard(state, A, 'Hill Giant', 'battlefield')
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.activate', objId: bridge, abilityIndex: 1, targets: [] })
    until(state, (s) => s.pending?.kind === 'freePlay', 'the free-play offer')
    const legal = computeLegal(state, A)
    expect(legal.needsFreePlay).toBe(true)
    expect(legal.freePlayCardId).toBe(hidden.id)
    expect(legal.freePlaySourceName).toBe('Mosswort Bridge')
  })

  it('plays a hidden LAND onto the battlefield, using the land drop', () => {
    const { state, A } = makeDuel()
    const bridge = playBridge(state, A)
    // steer the pick to a Mountain so the hidden card is definitely a land
    const mountain = computeLegal(state, A).hideawayIds.find((id) => nameOf(state, id) === 'Mountain')!
    act(state, A, { type: 'r.hideaway', objId: mountain })
    state.objects[bridge]!.tapped = false
    for (let i = 0; i < 4; i++) putCard(state, A, 'Hill Giant', 'battlefield') // 12 power
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.activate', objId: bridge, abilityIndex: 1, targets: [] })
    until(state, (s) => s.pending?.kind === 'freePlay', 'the offer')
    expect(computeLegal(state, A).freePlayIsLand).toBe(true)
    // the Bridge itself already used this turn's land drop, so the play is refused…
    expect(() => act(state, A, { type: 'r.freePlay', play: true })).toThrow(/already played a land/)
    // …until a land drop is free again
    state.players[A]!.extraLandsThisTurn = 1
    act(state, A, { type: 'r.freePlay', play: true })
    expect(state.objects[mountain]!.zone).toBe('battlefield')
    expect(state.objects[mountain]!.faceDown).toBeFalsy()
    expect(state.objects[mountain]!.hiddenBy).toBeUndefined()
  })

  it('declining leaves the card hidden away for a later try', () => {
    const { state, A } = makeDuel()
    const bridge = playBridge(state, A)
    act(state, A, { type: 'r.hideaway', objId: computeLegal(state, A).hideawayIds[0]! })
    state.objects[bridge]!.tapped = false
    for (let i = 0; i < 4; i++) putCard(state, A, 'Hill Giant', 'battlefield')
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.activate', objId: bridge, abilityIndex: 1, targets: [] })
    until(state, (s) => s.pending?.kind === 'freePlay', 'the offer')
    act(state, A, { type: 'r.freePlay', play: false })
    expect(state.pending).toBeFalsy()
    expect(hiddenOf(state, bridge)).toBeTruthy()
    expect(state.log.some((l) => /declines to play/.test(l))).toBe(true)
  })

  it('taps for {G} as a plain land', () => {
    const { state, A } = makeDuel()
    const bridge = playBridge(state, A)
    act(state, A, { type: 'r.hideaway', objId: computeLegal(state, A).hideawayIds[0]! })
    state.objects[bridge]!.tapped = false
    act(state, A, { type: 'r.tapMana', objId: bridge, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(1)
  })
})

describe('CARD67 — Gemstone Caverns (opening hand)', () => {
  /** build a 2-player game paused in mulligans, with the Caverns in a chosen player's hand */
  const rig = (holder: 'starting' | 'other') => {
    const { state } = makeGameNMulligan(2)
    const starting = state.turnOrder[0]!
    const other = state.turnOrder[1]!
    const who = holder === 'starting' ? starting : other
    const caverns = putCard(state, who, 'Gemstone Caverns', 'hand')
    return { state, starting, other, who, caverns }
  }
  const bothKeep = (state: St) => {
    for (const pid of state.turnOrder) applyRulesAction(state, pid, { type: 'r.keep', toBottom: [] })
  }

  it('offers the pre-game play to the player who is NOT going first', () => {
    const { state, other, caverns } = rig('other')
    bothKeep(state)
    expect(state.status).toBe('mulligans') // the game has not begun yet
    expect(state.pending).toEqual({ kind: 'openingPlay', player: other })
    const legal = computeLegal(state, other)
    expect(legal.needsOpeningPlay).toBe(true)
    expect(legal.openingPlayObjId).toBe(caverns)
    expect(legal.openingPlaySourceName).toBe('Gemstone Caverns')
    expect(legal.openingPlayExileIds.length).toBe(7) // any other card in the opening hand
    expect(legal.openingPlayExileIds).not.toContain(caverns)
  })

  it('accepting puts it out with a luck counter and exiles a card from hand', () => {
    const { state, other, caverns } = rig('other')
    bothKeep(state)
    const hand = [...state.zones.perPlayer[other]!.hand]
    const toExile = computeLegal(state, other).openingPlayExileIds[0]!
    act(state, other, { type: 'r.openingPlay', play: true, exileIds: [toExile] })
    expect(state.objects[caverns]!.zone).toBe('battlefield')
    expect(state.objects[caverns]!.counters.luck).toBe(1)
    expect(state.objects[caverns]!.tapped).toBe(false)
    expect(state.objects[toExile]!.zone).toBe('exile')
    expect(state.zones.perPlayer[other]!.hand.length).toBe(hand.length - 2)
    // …and the game then begins
    expect(state.status).toBe('active')
    expect(state.turnNumber).toBe(1)
  })

  it('is never offered to the starting player', () => {
    const { state, starting } = rig('starting')
    bothKeep(state)
    expect(state.status).toBe('active') // no offer at all
    expect(state.pending?.kind).not.toBe('openingPlay')
    expect(computeLegal(state, starting).needsOpeningPlay).toBe(false)
  })

  it('declining keeps it in hand and starts the game', () => {
    const { state, other, caverns } = rig('other')
    bothKeep(state)
    act(state, other, { type: 'r.openingPlay', play: false })
    expect(state.objects[caverns]!.zone).toBe('hand')
    expect(state.status).toBe('active')
    expect(state.log.some((l) => /keeps Gemstone Caverns in hand/.test(l))).toBe(true)
  })

  it('refuses the wrong exile count, and the Caverns itself', () => {
    const { state, other, caverns } = rig('other')
    bothKeep(state)
    expect(() => act(state, other, { type: 'r.openingPlay', play: true, exileIds: [] })).toThrow(/exactly 1 card/)
    expect(() => act(state, other, { type: 'r.openingPlay', play: true, exileIds: [caverns] })).toThrow(/another card in your hand/)
    const two = computeLegal(state, other).openingPlayExileIds.slice(0, 2)
    expect(() => act(state, other, { type: 'r.openingPlay', play: true, exileIds: two })).toThrow(/exactly 1 card/)
  })

  it('taps for {C} always, and for any colour only with its luck counter', () => {
    const { state, A } = makeDuel()
    const caverns = putCard(state, A, 'Gemstone Caverns', 'battlefield') // put out mid-game: no counter
    toStep(state, 'main1')
    expect(computeLegal(state, A).manaSourceIds).toContain(caverns)
    expect(computeLegal(state, A).manaSourceColors[caverns]).toEqual([]) // one fixed output → no picker
    expect(() => act(state, A, { type: 'r.tapMana', objId: caverns, color: 'U' })).toThrow(/luck counter/)
    act(state, A, { type: 'r.tapMana', objId: caverns, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
    // with a luck counter every colour is on offer
    state.objects[caverns]!.tapped = false
    state.objects[caverns]!.counters.luck = 1
    expect(computeLegal(state, A).manaSourceColors[caverns]).toEqual(expect.arrayContaining(['C', 'W', 'U', 'B', 'R', 'G']))
    act(state, A, { type: 'r.tapMana', objId: caverns, color: 'U' })
    expect(state.players[A]!.manaPool.U).toBe(1)
  })
})
