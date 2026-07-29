/**
 * Perpetual card coverage — batch CARD51: PROLIFERATE (CR 701.28) — "Choose any number of permanents
 * and/or players with a counter on them, then give each another counter of each kind already there."
 * The choice is a new pending; the counters it adds go through putCounters, so CARD50's replacement
 * effects apply to them. Cards: Karn's Bastion, Evolution Sage, Flux Channeler, Contagion Engine
 * (which proliferates TWICE, each with its own choice).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { putCounters } from '../../server/rules/state.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const counters = (s: St, id: ObjId, kind = '+1/+1') => s.objects[id]!.counters[kind] ?? 0

describe('CARD51 — Karn\'s Bastion', () => {
  it('gives one more counter of EACH kind already there', () => {
    const { state, A } = makeDuel()
    const bastion = putCard(state, A, "Karn's Bastion", 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCounters(state, bear, '+1/+1', 2)
    putCounters(state, bear, 'shield', 1) // a second kind, to prove "each kind"
    toStep(state, 'main1')
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.activate', objId: bastion, abilityIndex: 1, targets: [] })
    until(state, (s) => s.pending?.kind === 'proliferate', 'the proliferate choice')
    const legal = computeLegal(state, A)
    expect(legal.needsProliferate).toBe(true)
    expect(legal.proliferateIds).toContain(bear)
    act(state, A, { type: 'r.proliferate', objIds: [bear], playerIds: [] })
    expect(counters(state, bear)).toBe(3)
    expect(counters(state, bear, 'shield')).toBe(2)
  })

  it('can proliferate an OPPONENT\'s permanent, and a poisoned player', () => {
    const { state, A, B } = makeDuel()
    const bastion = putCard(state, A, "Karn's Bastion", 'battlefield')
    // a 4/4, so two -1/-1 counters don't kill it (a 2/2 would die to SBA and lose its counters)
    const theirs = putCard(state, B, 'Serra Angel', 'battlefield')
    putCounters(state, theirs, '-1/-1', 1)
    state.players[B]!.poison = 3
    toStep(state, 'main1')
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.activate', objId: bastion, abilityIndex: 1, targets: [] })
    until(state, (s) => s.pending?.kind === 'proliferate', 'the choice')
    const legal = computeLegal(state, A)
    expect(legal.proliferateIds).toContain(theirs)
    expect(legal.proliferatePlayerIds).toEqual([B])
    act(state, A, { type: 'r.proliferate', objIds: [theirs], playerIds: [B] })
    expect(counters(state, theirs, '-1/-1')).toBe(2)
    expect(state.players[B]!.poison).toBe(4)
  })

  it('refuses something with no counter, and accepts picking nothing', () => {
    const { state, A } = makeDuel()
    const bastion = putCard(state, A, "Karn's Bastion", 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const plain = putCard(state, A, 'Gray Ogre', 'battlefield')
    putCounters(state, bear, '+1/+1', 1)
    toStep(state, 'main1')
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.activate', objId: bastion, abilityIndex: 1, targets: [] })
    until(state, (s) => s.pending?.kind === 'proliferate', 'the choice')
    expect(computeLegal(state, A).proliferateIds).not.toContain(plain)
    expect(() => act(state, A, { type: 'r.proliferate', objIds: [plain], playerIds: [] })).toThrow(/no counter/)
    act(state, A, { type: 'r.proliferate', objIds: [], playerIds: [] }) // declining is legal
    expect(counters(state, bear)).toBe(1)
    expect(state.pending).toBeFalsy()
  })

  it('asks nothing when NOTHING has a counter', () => {
    const { state, A } = makeDuel()
    const bastion = putCard(state, A, "Karn's Bastion", 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.activate', objId: bastion, abilityIndex: 1, targets: [] })
    resolve(state, A)
    expect(state.pending).toBeFalsy()
    expect(state.log.some((l) => /Nothing has a counter/.test(l))).toBe(true)
  })

  it('its counters go through the replacement funnel (Hardened Scales)', () => {
    const { state, A } = makeDuel()
    const bastion = putCard(state, A, "Karn's Bastion", 'battlefield')
    putCard(state, A, 'Hardened Scales', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCounters(state, bear, '+1/+1', 1) // Scales makes this 2 already
    const before = counters(state, bear)
    toStep(state, 'main1')
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.activate', objId: bastion, abilityIndex: 1, targets: [] })
    until(state, (s) => s.pending?.kind === 'proliferate', 'the choice')
    act(state, A, { type: 'r.proliferate', objIds: [bear], playerIds: [] })
    expect(counters(state, bear)).toBe(before + 2) // proliferate's one counter, +1 from Scales
  })
})

describe('CARD51 — the triggered proliferators', () => {
  it('Evolution Sage proliferates on every land you play', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Evolution Sage', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCounters(state, bear, '+1/+1', 1)
    const land = putCard(state, A, 'Forest', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: land })
    until(state, (s) => s.pending?.kind === 'proliferate', 'the landfall proliferate')
    act(state, A, { type: 'r.proliferate', objIds: [bear], playerIds: [] })
    expect(counters(state, bear)).toBe(2)
  })

  it('Flux Channeler proliferates on your NONCREATURE spells only', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Flux Channeler', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCounters(state, bear, '+1/+1', 1)
    toStep(state, 'main1')
    // a creature spell does not trigger it
    const creature = putCard(state, A, 'Gray Ogre', 'hand')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: creature, targets: [] })
    resolve(state, A)
    expect(state.pending).toBeFalsy()
    expect(counters(state, bear)).toBe(1)
    // a noncreature spell does
    const shock = putCard(state, A, 'Shock', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [A] })
    until(state, (s) => s.pending?.kind === 'proliferate', 'the cast trigger')
    act(state, A, { type: 'r.proliferate', objIds: [bear], playerIds: [] })
    expect(counters(state, bear)).toBe(2)
  })
})

describe('CARD51 — Contagion Engine', () => {
  it('puts a -1/-1 counter on each creature a target player controls', () => {
    const { state, A, B } = makeDuel()
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs1 = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const theirs2 = putCard(state, B, 'Gray Ogre', 'battlefield')
    const engine = putCard(state, A, 'Contagion Engine', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'C', 6)
    act(state, A, { type: 'r.cast', objId: engine, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'its ETB target')
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    until(state, (s) => (s.objects[theirs1]!.counters['-1/-1'] ?? 0) > 0 || s.turnNumber > 1, 'the counters')
    expect(counters(state, theirs1, '-1/-1')).toBe(1)
    expect(counters(state, theirs2, '-1/-1')).toBe(1)
    expect(counters(state, mine, '-1/-1')).toBe(0)
  })

  it('proliferates TWICE, each with its own choice', () => {
    const { state, A } = makeDuel()
    const engine = putCard(state, A, 'Contagion Engine', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCounters(state, bear, '+1/+1', 1)
    toStep(state, 'main1')
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.activate', objId: engine, abilityIndex: 0, targets: [] })
    until(state, (s) => s.pending?.kind === 'proliferate', 'the first choice')
    act(state, A, { type: 'r.proliferate', objIds: [bear], playerIds: [] })
    expect(counters(state, bear)).toBe(2)
    // "Then do it again." — a second, independent choice
    expect(state.pending?.kind).toBe('proliferate')
    act(state, A, { type: 'r.proliferate', objIds: [bear], playerIds: [] })
    expect(counters(state, bear)).toBe(3)
    expect(state.pending).toBeFalsy()
  })
})
