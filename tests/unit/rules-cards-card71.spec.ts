/**
 * Perpetual card coverage — batch CARD71, three top-400 cards:
 *  - Academy Manufactor — a token-creation REPLACEMENT that substitutes types (CR 616): a Clue, Food or
 *    Treasure becomes one of each.
 *  - Mirkwood Bats — two new event watchers, both "one or more" (CR 603.2b): one trigger per
 *    token-creation event and one per sacrifice event, however many objects each involved.
 *  - Force of Negation — CARD65's pitch cost narrowed to "if it's not your turn", plus a counter that
 *    EXILES the countered spell.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const countOf = (s: St, p: PlayerId, name: string) => s.zones.perPlayer[p]!.battlefield.filter((id) => nameOf(s, id) === name).length

describe('CARD71 — Academy Manufactor', () => {
  /** play a land with a Tireless Provisioner out and take the Treasure half */
  const makeTreasure = (s: St, A: PlayerId) => {
    putCard(s, A, 'Tireless Provisioner', 'battlefield')
    const land = putCard(s, A, 'Forest', 'hand')
    toStep(s, 'main1')
    act(s, A, { type: 'r.playLand', objId: land })
    until(s, (x) => x.pending?.kind === 'modes', 'the landfall choice')
    act(s, A, { type: 'r.chooseModes', modes: [1] }) // Treasure
    until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'it resolves')
  }

  it('turns one Treasure into a Clue, a Food and a Treasure', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Academy Manufactor', 'battlefield')
    makeTreasure(state, A)
    expect(countOf(state, A, 'Treasure')).toBe(1)
    expect(countOf(state, A, 'Clue')).toBe(1)
    expect(countOf(state, A, 'Food')).toBe(1)
    expect(state.log.some((l) => /also creates 1 of each other artifact type/.test(l))).toBe(true)
  })

  it('makes only the printed token without it', () => {
    const { state, A } = makeDuel()
    makeTreasure(state, A)
    expect(countOf(state, A, 'Treasure')).toBe(1)
    expect(countOf(state, A, 'Clue')).toBe(0)
    expect(countOf(state, A, 'Food')).toBe(0)
  })

  it('leaves a non-artifact token alone', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Academy Manufactor', 'battlefield')
    const alarm = putCard(state, A, 'Raise the Alarm', 'hand') // two 1/1 Soldiers
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: alarm, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the tokens arrive')
    expect(countOf(state, A, 'Soldier')).toBe(2)
    expect(countOf(state, A, 'Clue')).toBe(0)
    expect(countOf(state, A, 'Treasure')).toBe(0)
  })

  it('the Clue it makes can be cracked for a card', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Academy Manufactor', 'battlefield')
    makeTreasure(state, A)
    const clue = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Clue')!
    const hand = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.activate', objId: clue, abilityIndex: 0, targets: [] })
    until(state, (s) => s.zones.perPlayer[A]!.hand.length !== hand, 'the draw')
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 1)
    expect(state.objects[clue]).toBeUndefined() // sacrificed as a cost, and a token ceases to exist
  })
})

describe('CARD71 — Mirkwood Bats', () => {
  it('drains once per token-creation event, not per token', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Mirkwood Bats', 'battlefield')
    const alarm = putCard(state, A, 'Raise the Alarm', 'hand') // TWO Soldiers, one event
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 1)
    const life = state.players[A]!.life
    act(state, A, { type: 'r.cast', objId: alarm, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the trigger resolves')
    expect(state.players[B]!.life).toBe(39)
    expect(state.players[A]!.life).toBe(life + 1)
  })

  it('drains once per sacrifice event', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Mirkwood Bats', 'battlefield')
    const fodder = putCard(state, A, 'Gray Ogre', 'battlefield')
    // Ashnod's Altar: "Sacrifice a creature: Add {C}{C}" — a mana ability, so the sacrifice is its cost
    const altar = putCard(state, A, "Ashnod's Altar", 'battlefield')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.tapMana', objId: altar, color: 'C', sacrifices: [fodder] })
    until(state, (s) => s.players[B]!.life !== 40 || !s.zones.stack.length, 'the drain')
    until(state, (s) => !s.zones.stack.length, 'everything resolves')
    expect(state.objects[fodder]!.zone).toBe('graveyard')
    expect(state.players[B]!.life).toBe(39)
    expect(state.players[A]!.life).toBe(life + 1)
  })

  it('sees a sacrifice paid as an activated ability\'s cost', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Mirkwood Bats', 'battlefield')
    // a Food token sacrifices ITSELF for its ability
    putCard(state, A, 'Academy Manufactor', 'battlefield')
    putCard(state, A, 'Tireless Provisioner', 'battlefield')
    const land = putCard(state, A, 'Forest', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: land })
    until(state, (s) => s.pending?.kind === 'modes', 'the landfall choice')
    act(state, A, { type: 'r.chooseModes', modes: [0] }) // Food (→ Clue + Treasure too)
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the tokens and the drain')
    const afterTokens = state.players[B]!.life
    expect(afterTokens).toBe(39) // one creation event
    const food = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Food')!
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.activate', objId: food, abilityIndex: 0, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.players[B]!.life !== afterTokens, 'the sacrifice drain')
    expect(state.players[B]!.life).toBe(afterTokens - 1)
  })

  it("ignores an OPPONENT's tokens and sacrifices", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Mirkwood Bats', 'battlefield')
    until(state, (s) => s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    const alarm = putCard(state, B, 'Raise the Alarm', 'hand')
    addMana(state, B, 'W', 1)
    addMana(state, B, 'C', 1)
    const life = state.players[A]!.life
    act(state, B, { type: 'r.cast', objId: alarm, targets: [] })
    until(state, (s) => !s.zones.stack.length, 'their tokens arrive')
    expect(countOf(state, B, 'Soldier')).toBe(2)
    expect(state.players[A]!.life).toBe(life) // no drain either way
  })
})

describe('CARD71 — Force of Negation', () => {
  /** A casts a Divination; B holds a Force of Negation and a blue card to pitch */
  const setUp = (s: St, A: PlayerId, B: PlayerId) => {
    const force = putCard(s, B, 'Force of Negation', 'hand')
    const blue = putCard(s, B, 'Counterspell', 'hand')
    const div = putCard(s, A, 'Divination', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'U', 1)
    addMana(s, A, 'C', 2)
    act(s, A, { type: 'r.cast', objId: div, targets: [] })
    pass(s, A)
    return { force, blue, div }
  }

  it('pitches for free on an opponent\'s turn and EXILES the countered spell', () => {
    const { state, A, B } = makeDuel()
    const { force, blue, div } = setUp(state, A, B)
    const offer = computeLegal(state, B).pitchCastable.find((p) => p.objId === force)
    expect(offer).toBeTruthy()
    expect(offer!.life).toBe(0) // no life, unlike Force of Will
    const life = state.players[B]!.life
    act(state, B, { type: 'r.cast', objId: force, targets: [div], pitch: true, exiles: [blue] })
    expect(state.players[B]!.life).toBe(life)
    expect(state.objects[blue]!.zone).toBe('exile')
    until(state, (s) => !s.zones.stack.length, 'both resolve')
    expect(state.objects[div]!.zone).toBe('exile') // exiled, NOT in the graveyard
    expect(state.log.some((l) => /counters Divination and exiles it/.test(l))).toBe(true)
  })

  it('is not offered on YOUR own turn, and the pitch is refused there', () => {
    const { state, A } = makeDuel()
    const force = putCard(state, A, 'Force of Negation', 'hand')
    const blue = putCard(state, A, 'Counterspell', 'hand')
    const div = putCard(state, A, 'Divination', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: div, targets: [] })
    expect(computeLegal(state, A).pitchCastable.some((p) => p.objId === force)).toBe(false)
    expect(() => act(state, A, { type: 'r.cast', objId: force, targets: [div], pitch: true, exiles: [blue] })).toThrow(
      /only available on an opponent's turn/,
    )
  })

  it('counters only a NONCREATURE spell', () => {
    const { state, A, B } = makeDuel()
    const force = putCard(state, B, 'Force of Negation', 'hand')
    const blue = putCard(state, B, 'Counterspell', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    pass(state, A)
    expect(() => act(state, B, { type: 'r.cast', objId: force, targets: [bear], pitch: true, exiles: [blue] })).toThrow(
      /BAD_TARGETS|Illegal target/i,
    )
  })

  it('can also be cast for its mana cost, still exiling', () => {
    const { state, A, B } = makeDuel()
    const { force, div } = setUp(state, A, B)
    addMana(state, B, 'U', 2)
    addMana(state, B, 'C', 1)
    act(state, B, { type: 'r.cast', objId: force, targets: [div] })
    until(state, (s) => !s.zones.stack.length, 'both resolve')
    expect(state.objects[div]!.zone).toBe('exile')
  })
})

describe('CARD71 — review regressions', () => {
  it('Doubling Season applies ONCE to a Manufactor substitution: 1 Treasure → 2 of each', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Academy Manufactor', 'battlefield')
    putCard(state, A, 'Doubling Season', 'battlefield')
    putCard(state, A, 'Tireless Provisioner', 'battlefield')
    const land = putCard(state, A, 'Forest', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: land })
    until(state, (x) => x.pending?.kind === 'modes', 'the landfall choice')
    act(state, A, { type: 'r.chooseModes', modes: [1] }) // Treasure
    until(state, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'it resolves')
    expect(countOf(state, A, 'Treasure')).toBe(2)
    expect(countOf(state, A, 'Clue')).toBe(2)
    expect(countOf(state, A, 'Food')).toBe(2)
  })

  it('Mirkwood Bats sees its OWN sacrifice (leaves-the-battlefield look-back, CR 603.10a)', () => {
    const { state, A, B } = makeDuel()
    const bats = putCard(state, A, 'Mirkwood Bats', 'battlefield')
    const altar = putCard(state, A, "Ashnod's Altar", 'battlefield')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.tapMana', objId: altar, color: 'C', sacrifices: [bats] })
    until(state, (s) => !s.zones.stack.length, 'everything resolves')
    expect(state.objects[bats]!.zone).toBe('graveyard')
    expect(state.players[B]!.life).toBe(39)
    expect(state.players[A]!.life).toBe(life + 1)
  })

  it('Mirkwood Bats sees a Helm of the Host token copy', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Mirkwood Bats', 'battlefield')
    const helm = putCard(state, A, 'Helm of the Host', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'C', 5)
    act(state, A, { type: 'r.equip', equipmentId: helm, creatureId: ogre })
    until(
      state,
      (s) => s.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(s, id) === 'Gray Ogre').length === 2 && !s.zones.stack.length,
      'the copy and the drain',
    )
    expect(state.players[B]!.life).toBe(39)
  })
})
