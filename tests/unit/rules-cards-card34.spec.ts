/**
 * Perpetual card coverage — batch CARD34: OPTIONAL targets ("you may…", "up to one…") including
 * graveyard-card triggers, now that the board can pick from a graveyard. Cards: Eternal Witness,
 * Reclamation Sage, Sun Titan, Loran of the Third Path.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD34 — Eternal Witness (an optional graveyard-card trigger)', () => {
  const castWitness = (s: St, A: PlayerId) => {
    const w = putCard(s, A, 'Eternal Witness', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'G', 2)
    addMana(s, A, 'C', 1)
    act(s, A, { type: 'r.cast', objId: w, targets: [] })
    return w
  }

  it('returns the chosen card from your graveyard to your hand', () => {
    const { state, A } = makeDuel()
    const dead = putCard(state, A, 'Grizzly Bears', 'graveyard')
    castWitness(state, A)
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    const legal = computeLegal(state, A)
    expect(legal.triggerTargetKind).toBe('graveyardCard')
    expect(legal.triggerTargetOptional).toBe(true)
    expect(legal.triggerGraveyardIds).toContain(dead) // the board's picker gets the legal cards
    act(state, A, { type: 'r.chooseTargets', targets: [dead] })
    resolve(state, A)
    // graveyard → hand is public → hidden, so the card is re-minted: check by name
    expect(state.zones.perPlayer[A]!.hand.some((id) => getDef(state.objects[id]!.defName).name === 'Grizzly Bears')).toBe(true)
    expect(state.zones.perPlayer[A]!.graveyard).not.toContain(dead)
  })

  it('can be DECLINED, leaving the graveyard untouched', () => {
    const { state, A } = makeDuel()
    const dead = putCard(state, A, 'Grizzly Bears', 'graveyard')
    castWitness(state, A)
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    act(state, A, { type: 'r.chooseTargets', targets: [] }) // decline
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.graveyard).toContain(dead)
    expect(state.log.some((l) => /is declined/.test(l))).toBe(true)
  })

  it('still enters with an EMPTY graveyard (the trigger just does nothing)', () => {
    const { state, A } = makeDuel()
    const witness = castWitness(state, A)
    // no pending target choice at all: nothing legal, but the trigger is optional
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolve')
    expect(state.objects[witness]!.zone).toBe('battlefield')
    expect(state.pending).toBeFalsy()
  })

  it("cannot take a card from an OPPONENT's graveyard", () => {
    const { state, A, B } = makeDuel()
    const theirs = putCard(state, B, 'Grizzly Bears', 'graveyard')
    const mine = putCard(state, A, 'Shock', 'graveyard')
    castWitness(state, A)
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    expect(computeLegal(state, A).triggerGraveyardIds).toEqual([mine])
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [theirs] })).toThrow(/BAD_TARGETS|Illegal target/i)
  })
})

describe('CARD34 — Reclamation Sage and Loran (optional battlefield targets)', () => {
  it('Reclamation Sage may destroy an artifact, or decline', () => {
    const { state, A, B } = makeDuel()
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')
    const sage = putCard(state, A, 'Reclamation Sage', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: sage, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    expect(computeLegal(state, A).triggerTargetOptional).toBe(true)
    act(state, A, { type: 'r.chooseTargets', targets: [] }) // decline
    resolve(state, A)
    expect(state.objects[rock]!.zone).toBe('battlefield')
  })

  it('…and destroys it when chosen', () => {
    const { state, A, B } = makeDuel()
    const ench = putCard(state, B, 'Glorious Anthem', 'battlefield')
    const sage = putCard(state, A, 'Reclamation Sage', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: sage, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    act(state, A, { type: 'r.chooseTargets', targets: [ench] })
    resolve(state, A)
    expect(state.objects[ench]!.zone).toBe('graveyard')
  })

  it("Loran's tap ability draws for you AND a target opponent", () => {
    const { state, A, B } = makeDuel()
    const loran = putCard(state, A, 'Loran of the Third Path', 'battlefield')
    state.objects[loran]!.summoningSick = false
    toStep(state, 'main1')
    const mineBefore = state.zones.perPlayer[A]!.hand.length
    const theirsBefore = state.zones.perPlayer[B]!.hand.length
    act(state, A, { type: 'r.activate', objId: loran, abilityIndex: 0, targets: [B] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(mineBefore + 1)
    expect(state.zones.perPlayer[B]!.hand.length).toBe(theirsBefore + 1)
  })
})

describe('CARD34 — Sun Titan (optional reanimation, on entering AND attacking)', () => {
  it('returns a mana-value-3-or-less permanent from your graveyard to the battlefield', () => {
    const { state, A } = makeDuel()
    const cheap = putCard(state, A, 'Grizzly Bears', 'graveyard') // MV 2
    const titan = putCard(state, A, 'Sun Titan', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 2)
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.cast', objId: titan, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    act(state, A, { type: 'r.chooseTargets', targets: [cheap] })
    resolve(state, A)
    expect(state.objects[cheap]!.zone).toBe('battlefield')
    expect(state.objects[cheap]!.controllerId).toBe(A)
    expect(state.objects[cheap]!.summoningSick).toBe(true)
  })

  it('will not take something with mana value 4 or more', () => {
    const { state, A } = makeDuel()
    const big = putCard(state, A, 'Serra Angel', 'graveyard') // MV 5
    const titan = putCard(state, A, 'Sun Titan', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 2)
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.cast', objId: titan, targets: [] })
    // nothing legal → the optional trigger resolves targetless, no pending at all
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolve')
    expect(state.pending).toBeFalsy()
    expect(state.objects[big]!.zone).toBe('graveyard')
  })

  it('triggers again when it ATTACKS', () => {
    const { state, A, B } = makeDuel()
    const titan = putCard(state, A, 'Sun Titan', 'battlefield')
    const cheap = putCard(state, A, 'Mind Stone', 'graveyard') // MV 2 artifact
    state.objects[titan]!.summoningSick = false
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [titan])
    until(state, (s) => s.pending?.kind === 'trigger', 'the attacks trigger')
    expect(computeLegal(state, A).triggerGraveyardIds).toContain(cheap)
    act(state, A, { type: 'r.chooseTargets', targets: [cheap] })
    until(state, (s) => s.objects[cheap]!.zone === 'battlefield', 'the reanimation')
    expect(state.objects[cheap]!.zone).toBe('battlefield')
  })
})
