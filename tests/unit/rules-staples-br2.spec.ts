/**
 * Coverage batch BR2: more removal staples via existing primitives. "Can't be regenerated"
 * is vacuous (regeneration isn't modeled — same as the existing Wrath of God). All leak-safe
 * (battlefield→graveyard + tokens are public).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, putFallback, toStep, until } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'
import { getDef } from '../../server/rules/cards/registry.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')

describe('Terminate {B}{R} — destroy target creature', () => {
  it('destroys the targeted creature', () => {
    const { state, A, B } = makeDuel()
    const t = putCard(state, A, 'Terminate', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: t, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
  })
})

describe('Go for the Throat {1}{B} — destroy target nonartifact creature', () => {
  it('destroys a normal creature but cannot target an artifact creature', () => {
    const { state, A, B } = makeDuel()
    const g1 = putCard(state, A, 'Go for the Throat', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const artCreature = putFallback(state, B, { name: 'Clockwork Beast', typeLine: 'Artifact Creature — Construct', power: '2', toughness: '2' }, 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    // artifact creature is not a legal target
    expect(() => act(state, A, { type: 'r.cast', objId: g1, targets: [artCreature] })).toThrow()
    // a normal creature is
    act(state, A, { type: 'r.cast', objId: g1, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(state.objects[artCreature]!.zone).toBe('battlefield')
  })
})

describe('Pongify {U} — destroy target creature, its controller makes a 3/3', () => {
  it("destroys the creature and gives ITS controller a 3/3 Ape", () => {
    const { state, A, B } = makeDuel()
    const p = putCard(state, A, 'Pongify', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: p, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
    // B (the destroyed creature's controller) now has a 3/3 Ape token on the battlefield
    const ape = state.zones.perPlayer[B]!.battlefield.find((id) => getDef(state.objects[id]!.defName).name === 'Ape')
    expect(ape, 'B controls a new Ape token').toBeTruthy()
    expect(state.objects[ape!]!.controllerId).toBe(B)
  })
})

describe('Rapid Hybridization {U} — 3/3 Frog Lizard for the controller', () => {
  it('destroys the creature and makes a Frog Lizard token for its controller', () => {
    const { state, A, B } = makeDuel()
    const rh = putCard(state, A, 'Rapid Hybridization', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: rh, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(state.zones.perPlayer[B]!.battlefield.some((id) => getDef(state.objects[id]!.defName).name === 'Frog Lizard')).toBe(true)
  })
})

describe('Damnation {2}{B}{B} — destroy all creatures', () => {
  it('destroys every (implemented) creature on the battlefield', () => {
    const { state, A, B } = makeDuel()
    const dmn = putCard(state, A, 'Damnation', 'hand')
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Hill Giant', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 4)
    act(state, A, { type: 'r.cast', objId: dmn, targets: [] })
    resolve(state, A)
    expect(state.objects[mine]!.zone).toBe('graveyard')
    expect(state.objects[theirs]!.zone).toBe('graveyard')
  })
})
