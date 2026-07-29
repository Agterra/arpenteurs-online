/**
 * Perpetual card coverage — batch CARD20: Chaos Warp (a permanent shuffled into its owner's library
 * — the leak-critical public→hidden move — then the top card revealed and possibly put onto the
 * battlefield) and Brainstorm (draw three, then an ORDERED put-back of two onto your library).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, rig, toStep, until } from './rules-helpers.ts'
import { computeLegal, redactRulesState } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'
import { mulberry32 } from './engine-helpers.ts'
import { __setDeterministicRng } from '../../server/game/rng.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD20 — Chaos Warp', () => {
  it("shuffles the target away and puts a revealed PERMANENT onto the battlefield", () => {
    const { state, A, B } = makeDuel()
    const warp = putCard(state, A, 'Chaos Warp', 'hand')
    // rig B's library to LANDS only, so whatever the shuffle puts on top (a Mountain, or the
    // shuffled bear itself) is a permanent card and therefore enters the battlefield
    rig(state, B, { battlefield: [], hand: [], libraryTop: ['Mountain', 'Mountain', 'Mountain'], librarySize: 0 })
    const victim = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    const libBefore = state.zones.perPlayer[B]!.library.length
    const fieldBefore = state.zones.perPlayer[B]!.battlefield.length
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: warp, targets: [victim] })
    resolve(state, A)
    expect(state.objects[victim]).toBeUndefined() // shuffled in with a FRESH id (invariant #3)
    // net: the bear left the battlefield and a revealed permanent replaced it (count unchanged),
    // and the library gained the bear then lost the revealed card (also unchanged)
    expect(state.zones.perPlayer[B]!.battlefield.length).toBe(fieldBefore)
    expect(state.zones.perPlayer[B]!.library.length).toBe(libBefore)
    const entered = getDef(state.objects[state.zones.perPlayer[B]!.battlefield[0]!]!.defName)
    expect(entered.types.some((t) => t === 'Land' || t === 'Creature')).toBe(true)
    expect(state.log.some((l) => /is shuffled into/.test(l))).toBe(true)
    expect(state.log.some((l) => /reveals/.test(l))).toBe(true)
  })

  it('a revealed NONpermanent stays on top, and the whole library is re-minted', () => {
    // the shuffled permanent lands back in the SAME library, so it can be the revealed card by
    // chance — seed the shuffle so this test always exercises the nonpermanent branch
    try {
      // seed 1: the shuffle leaves an instant on top (the bear could otherwise be revealed and
      // re-enter, which the previous test already covers)
      __setDeterministicRng(mulberry32(1))
      const { state, A, B } = makeDuel()
      const warp = putCard(state, A, 'Chaos Warp', 'hand')
      // instants only, THEN mint the victim (rig re-deals B's cards and would delete it first)
      rig(state, B, { battlefield: [], hand: [], libraryTop: ['Shock', 'Shock', 'Lightning Bolt'], librarySize: 0 })
      const victim = putCard(state, B, 'Grizzly Bears', 'battlefield')
      const beforeIds = new Set(state.zones.perPlayer[B]!.library)
      toStep(state, 'main1')
      addMana(state, A, 'R', 1)
      addMana(state, A, 'C', 2)
      act(state, A, { type: 'r.cast', objId: warp, targets: [victim] })
      resolve(state, A)
      const lib = state.zones.perPlayer[B]!.library
      const revealed = getDef(state.objects[lib[0]!]!.defName)
      expect(revealed.types.some((t) => t === 'Instant' || t === 'Sorcery')).toBe(true) // the seed picked a nonpermanent
      expect(state.zones.perPlayer[B]!.battlefield).toEqual([]) // so nothing entered
      expect(lib.length).toBe(4) // the bear joined the library
      for (const id of lib) expect(beforeIds.has(id)).toBe(false) // every id re-minted post-shuffle
    } finally {
      __setDeterministicRng(null)
    }
  })

  it('the shuffled card never leaks: no library id reaches the opponent', () => {
    const { state, A, B } = makeDuel()
    const victim = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const warp = putCard(state, A, 'Chaos Warp', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: warp, targets: [victim] })
    resolve(state, A)
    const seenByA = JSON.stringify(redactRulesState(state, A))
    for (const id of state.zones.perPlayer[B]!.library) expect(seenByA.includes(id)).toBe(false)
    expect(seenByA.includes(victim)).toBe(false) // the old battlefield id is gone for good
  })

  it("a commander is sent to the command zone instead of a hidden library", () => {
    const { state, A, B } = makeDuel()
    const cmd = state.players[B]!.commanderId!
    state.objects[cmd]!.zone = 'battlefield'
    state.zones.perPlayer[B]!.command = []
    state.zones.perPlayer[B]!.battlefield.push(cmd)
    const warp = putCard(state, A, 'Chaos Warp', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: warp, targets: [cmd] })
    resolve(state, A)
    expect(state.objects[cmd]!.zone).toBe('command')
  })
})

describe('CARD20 — Brainstorm', () => {
  const cast = (s: St, A: PlayerId) => {
    const bs = putCard(s, A, 'Brainstorm', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'U', 1)
    act(s, A, { type: 'r.cast', objId: bs, targets: [] })
    until(s, (x) => x.pending?.kind === 'putBack', 'the put-back prompt')
    return bs
  }

  it('draws three, then asks for two cards back — net +1 in hand, library −1', () => {
    const { state, A } = makeDuel()
    const handBefore = state.zones.perPlayer[A]!.hand.length
    const libBefore = state.zones.perPlayer[A]!.library.length
    cast(state, A)
    // handBefore is measured before Brainstorm is minted into hand: +1 card, +3 drawn, −1 cast
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 3)
    expect(computeLegal(state, A).needsPutBack).toBe(true)
    expect(computeLegal(state, A).putBackCount).toBe(2)
    const [first, second] = state.zones.perPlayer[A]!.hand
    act(state, A, { type: 'r.putBack', objIds: [first!, second!] })
    expect(state.pending).toBeFalsy()
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1) // net +1 (3 drawn − 2 back), spell gone
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore - 3 + 2)
  })

  it('the FIRST card chosen ends up on top of the library', () => {
    const { state, A } = makeDuel()
    cast(state, A)
    const hand = state.zones.perPlayer[A]!.hand
    // pick two cards with DIFFERENT names so the order is observable (the ids are re-minted as they
    // enter the library, so identity has to be checked by definition, not by id)
    const first = hand[0]!
    const second = hand.find((id) => state.objects[id]!.defName !== state.objects[first]!.defName)!
    expect(second).toBeTruthy()
    const [firstName, secondName] = [state.objects[first]!.defName, state.objects[second]!.defName]
    act(state, A, { type: 'r.putBack', objIds: [first, second] })
    const lib = state.zones.perPlayer[A]!.library
    expect(state.objects[lib[0]!]!.defName).toBe(firstName)
    expect(state.objects[lib[1]!]!.defName).toBe(secondName)
    expect(lib.includes(first)).toBe(false) // re-minted: the hand id does not persist
  })

  it('rejects the wrong count, a card not in your hand, and the wrong player', () => {
    const { state, A, B } = makeDuel()
    cast(state, A)
    const hand = state.zones.perPlayer[A]!.hand
    expect(() => act(state, A, { type: 'r.putBack', objIds: [hand[0]!] })).toThrow(/exactly 2/)
    const theirs = state.zones.perPlayer[B]!.hand[0]!
    expect(() => act(state, A, { type: 'r.putBack', objIds: [hand[0]!, theirs] })).toThrow(/Not a card in your hand/)
    expect(() => act(state, B, { type: 'r.putBack', objIds: [theirs] })).toThrow(/NOT_PENDING|Not waiting/i)
    expect(state.pending?.kind).toBe('putBack') // still open after every rejection
  })

  it('blocks other actions until answered', () => {
    const { state, A } = makeDuel()
    cast(state, A)
    expect(() => act(state, A, { type: 'r.pass' })).toThrow(/PENDING|Waiting for/i)
  })

  it('puts back only what you have when the hand is short', () => {
    const { state, A } = makeDuel()
    // a single card in hand: draw 3 → 4, put back 2 is still fine; force the short case by
    // emptying the library first so the draws fizzle the player out is NOT wanted — instead check
    // the effect's own clamp with an empty hand after the draws
    rig(state, A, { hand: [], battlefield: [], libraryTop: ['Mountain'], librarySize: 1 })
    const bs = putCard(state, A, 'Brainstorm', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: bs, targets: [] })
    // the library had 1 card: the first draw takes it, the next two lose the game (empty library)
    until(state, (s) => s.pending?.kind === 'putBack' || s.status === 'ended', 'put-back or loss')
    if (state.pending?.kind === 'putBack') {
      expect(state.pendingPutBack!.count).toBeLessThanOrEqual(state.zones.perPlayer[A]!.hand.length)
    } else {
      expect(state.players[A]!.hasLost).toBe(true) // drawing from an empty library
    }
  })
})
