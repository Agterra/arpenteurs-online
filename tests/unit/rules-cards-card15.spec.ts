/**
 * Perpetual card coverage — batch CARD15: overload (CR 702.96) — an ALTERNATIVE cost whose body
 * replaces "target" with "each". Cards: Cyclonic Rift, Vandalblast, Damn.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD15 — Cyclonic Rift', () => {
  it('cast normally: bounces ONE nonland permanent you do not control', () => {
    const { state, A, B } = makeDuel()
    const rift = putCard(state, A, 'Cyclonic Rift', 'hand')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const alsoTheirs = putCard(state, B, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: rift, targets: [theirs] })
    resolve(state, A)
    expect(state.objects[theirs]).toBeUndefined() // returned to hand with a FRESH id (invariant #3)
    expect(state.objects[alsoTheirs]!.zone).toBe('battlefield')
    expect(state.zones.perPlayer[B]!.hand.length).toBe(8) // opening 7 + the bounced bear
  })

  it('overloaded: bounces EVERY nonland permanent you do not control, keeping yours and all lands', () => {
    const { state, A, B } = makeDuel()
    const rift = putCard(state, A, 'Cyclonic Rift', 'hand')
    const theirCreature = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const theirRock = putCard(state, B, 'Sol Ring', 'battlefield')
    const theirLand = putCard(state, B, 'Mountain', 'battlefield')
    const mine = putCard(state, A, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 6)
    act(state, A, { type: 'r.cast', objId: rift, targets: [], overload: true })
    resolve(state, A)
    expect(state.objects[theirCreature]).toBeUndefined() // both of B's nonlands went to hand…
    expect(state.objects[theirRock]).toBeUndefined()
    expect(state.objects[theirLand]!.zone).toBe('battlefield') // …the land stays…
    expect(state.objects[mine]!.zone).toBe('battlefield') // …and so does my own creature
    expect(state.zones.perPlayer[B]!.hand.length).toBe(9)
  })

  it('the overload cost is the one paid (the printed {1}{U} is not enough)', () => {
    const { state, A, B } = makeDuel()
    const rift = putCard(state, A, 'Cyclonic Rift', 'hand')
    putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 1) // enough for the printed cost only
    expect(() => act(state, A, { type: 'r.cast', objId: rift, targets: [], overload: true })).toThrow(/Not enough mana/)
    expect(state.objects[rift]!.zone).toBe('hand')
  })

  it('an overloaded cast takes no targets', () => {
    const { state, A, B } = makeDuel()
    const rift = putCard(state, A, 'Cyclonic Rift', 'hand')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 6)
    expect(() => act(state, A, { type: 'r.cast', objId: rift, targets: [theirs], overload: true })).toThrow(/BAD_TARGETS|exactly 0/i)
  })

  it('redact offers the overload only when its own cost is affordable', () => {
    const { state, A } = makeDuel()
    const rift = putCard(state, A, 'Cyclonic Rift', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 1)
    expect(computeLegal(state, A).overloadable.some((o) => o.objId === rift)).toBe(false)
    addMana(state, A, 'C', 5)
    expect(computeLegal(state, A).overloadable).toEqual([{ objId: rift, cost: '{6}{U}' }])
  })

  it('is an instant, so it can be overloaded on an opponent\'s turn', () => {
    const { state, A, B } = makeDuel()
    const rift = putCard(state, A, 'Cyclonic Rift', 'hand')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    pass(state, B)
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 6)
    act(state, A, { type: 'r.cast', objId: rift, targets: [], overload: true })
    until(state, (s) => !s.zones.stack.length, 'resolve')
    expect(state.objects[theirs]).toBeUndefined()
  })
})

describe('CARD15 — Vandalblast and Damn', () => {
  it('Vandalblast normally destroys one artifact you do not control', () => {
    const { state, A, B } = makeDuel()
    const blast = putCard(state, A, 'Vandalblast', 'hand')
    const theirRock = putCard(state, B, 'Sol Ring', 'battlefield')
    const myRock = putCard(state, A, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: blast, targets: [theirRock] })
    resolve(state, A)
    expect(state.objects[theirRock]!.zone).toBe('graveyard')
    expect(state.objects[myRock]!.zone).toBe('battlefield')
  })

  it('overloaded Vandalblast destroys every artifact you do not control — and none of yours', () => {
    const { state, A, B } = makeDuel()
    const blast = putCard(state, A, 'Vandalblast', 'hand')
    const theirs = [putCard(state, B, 'Sol Ring', 'battlefield'), putCard(state, B, 'Mind Stone', 'battlefield')]
    const mine = putCard(state, A, 'Sol Ring', 'battlefield')
    const theirCreature = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.cast', objId: blast, targets: [], overload: true })
    resolve(state, A)
    for (const id of theirs) expect(state.objects[id]!.zone).toBe('graveyard')
    expect(state.objects[mine]!.zone).toBe('battlefield')
    expect(state.objects[theirCreature]!.zone).toBe('battlefield') // creatures are untouched
  })

  it('Vandalblast is a sorcery: no overload on an opponent\'s turn, and redact hides it', () => {
    const { state, A, B } = makeDuel()
    const blast = putCard(state, A, 'Vandalblast', 'hand')
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    pass(state, B)
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 4)
    expect(computeLegal(state, A).overloadable).toEqual([])
    expect(() => act(state, A, { type: 'r.cast', objId: blast, targets: [], overload: true })).toThrow(/TIMING|main phase/i)
  })

  it('Damn overloaded is a board wipe (its overload cost is a different colour)', () => {
    const { state, A, B } = makeDuel()
    const damn = putCard(state, A, 'Damn', 'hand')
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'W', 2)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: damn, targets: [], overload: true }) // {2}{W}{W}, not {B}{B}
    resolve(state, A)
    expect(state.objects[mine]!.zone).toBe('graveyard')
    expect(state.objects[theirs]!.zone).toBe('graveyard')
  })

  it('Damn cast normally still destroys a single target creature', () => {
    const { state, A, B } = makeDuel()
    const damn = putCard(state, A, 'Damn', 'hand')
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    act(state, A, { type: 'r.cast', objId: damn, targets: [theirs] })
    resolve(state, A)
    expect(state.objects[theirs]!.zone).toBe('graveyard')
    expect(state.objects[mine]!.zone).toBe('battlefield')
  })

  it('a card with no overload rejects the flag', () => {
    const { state, A } = makeDuel()
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: bolt, targets: [], overload: true })).toThrow(/NO_OVERLOAD|no overload/i)
  })
})
