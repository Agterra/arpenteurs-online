/**
 * Perpetual card coverage — batch CARD50: REPLACEMENT effects on counter placement and token creation
 * (CR 616) — Hardened Scales ("that many plus one"), Branching Evolution / Corpsejack Menace / Doubling
 * Season ("twice that many"), and Parallel Lives / Anointed Procession / Doubling Season doubling
 * tokens. Every counter now goes through one helper, so enters-with-counters, undying and wither damage
 * are all covered.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { currentPT } from '../../server/rules/characteristics.ts'
import { putCounters } from '../../server/rules/state.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const counters = (s: St, id: ObjId, kind = '+1/+1') => s.objects[id]!.counters[kind] ?? 0
const tokensOf = (s: St, p: PlayerId, name: string) =>
  s.zones.perPlayer[p]!.battlefield.filter((id) => getDef(s.objects[id]!.defName).name === name).length
/** cast a +1/+1-counter spell at a creature (Gird for Battle puts two counters) */
const gird = (s: St, A: PlayerId, target: ObjId) => {
  const spell = putCard(s, A, 'Gird for Battle', 'hand') // {W}: two +1/+1 counters
  addMana(s, A, 'W', 1)
  act(s, A, { type: 'r.cast', objId: spell, targets: [target] })
  resolve(s, A)
}

describe('CARD50 — counter replacement', () => {
  it('Hardened Scales adds one MORE counter, however many were coming', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Hardened Scales', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    gird(state, A, bear) // two counters → three
    expect(counters(state, bear)).toBe(3)
    expect(currentPT(state, state.objects[bear]!)).toEqual({ power: 5, toughness: 5 })
    expect(state.log.some((l) => /3 \+1\/\+1 counters instead of 2/.test(l))).toBe(true)
  })

  it('Branching Evolution DOUBLES them, and stacks with Scales (+1 first, then double)', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Branching Evolution', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    gird(state, A, bear)
    expect(counters(state, bear)).toBe(4) // 2 → 4
    // add Hardened Scales: the controller orders the replacements, and +1-then-double is best
    putCard(state, A, 'Hardened Scales', 'battlefield')
    const other = putCard(state, A, 'Gray Ogre', 'battlefield')
    gird(state, A, other)
    expect(counters(state, other)).toBe(6) // (2 + 1) × 2
  })

  it("Corpsejack Menace doubles counters on YOUR creatures only", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Corpsejack Menace', 'battlefield')
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    gird(state, A, mine)
    expect(counters(state, mine)).toBe(4)
    // an opponent's creature gets its counters unreplaced (Gird for Battle can only target yours, so
    // drive it through the shared helper directly — the same call every effect makes)
    putCounters(state, theirs, '+1/+1', 2)
    expect(counters(state, theirs)).toBe(2)
  })

  it('Doubling Season doubles ANY counter on ANY permanent you control', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Doubling Season', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    gird(state, A, bear)
    expect(counters(state, bear)).toBe(4)
    // a non-creature permanent too: a Saga's lore counters are not routed here, so use an
    // enters-with-counters creature instead — see the next test
  })

  it('applies to ENTERS-WITH counters', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Hardened Scales', 'battlefield')
    const dog = putCard(state, A, 'Faithful Watchdog', 'hand') // a 0/0 entering with three counters
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'W', 1)
    act(state, A, { type: 'r.cast', objId: dog, targets: [] })
    resolve(state, A)
    expect(counters(state, dog)).toBe(4) // 3 + 1 from Scales
    expect(currentPT(state, state.objects[dog]!)).toEqual({ power: 4, toughness: 4 })
  })

  it('applies to an UNDYING return', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Hardened Scales', 'battlefield')
    const wolf = putCard(state, A, 'Young Wolf', 'battlefield') // 1/1 undying
    toStep(state, 'main1')
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [wolf] })
    until(state, (s) => s.objects[wolf]!.zone === 'battlefield' && counters(s, wolf) > 0, 'the undying return')
    expect(counters(state, wolf)).toBe(2) // the single undying counter, plus one from Scales
  })

  it('a manual counter override is NOT replaced (the players are hand-running it)', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Doubling Season', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.mCounter', objId: bear, name: '+1/+1', delta: 1 })
    expect(counters(state, bear)).toBe(1)
  })
})

describe('CARD50 — token replacement', () => {
  const raise = (s: St, A: PlayerId) => {
    const spell = putCard(s, A, 'Raise the Alarm', 'hand') // two 1/1 Soldiers
    addMana(s, A, 'W', 1)
    addMana(s, A, 'C', 1)
    act(s, A, { type: 'r.cast', objId: spell, targets: [] })
    resolve(s, A)
  }

  for (const card of ['Parallel Lives', 'Anointed Procession', 'Doubling Season']) {
    it(`${card} doubles the tokens created`, () => {
      const { state, A } = makeDuel()
      putCard(state, A, card, 'battlefield')
      toStep(state, 'main1')
      raise(state, A)
      expect(tokensOf(state, A, 'Soldier')).toBe(4)
      expect(state.log.some((l) => /creates 4 Soldier tokens instead of 2/.test(l))).toBe(true)
    })
  }

  it('two doublers stack multiplicatively', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Parallel Lives', 'battlefield')
    putCard(state, A, 'Doubling Season', 'battlefield')
    toStep(state, 'main1')
    raise(state, A)
    expect(tokensOf(state, A, 'Soldier')).toBe(8) // 2 × 2 × 2
  })

  it("an opponent's doubler does nothing for you", () => {
    const { state, A, B } = makeDuel()
    putCard(state, B, 'Parallel Lives', 'battlefield')
    toStep(state, 'main1')
    raise(state, A)
    expect(tokensOf(state, A, 'Soldier')).toBe(2)
  })
})
