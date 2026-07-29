/**
 * Perpetual card coverage — batch CARD63: Victimize — "choose TWO target creature cards in your
 * graveyard. Sacrifice a creature. IF YOU DO, return the chosen cards to the battlefield tapped." Two
 * pieces: a two-card graveyard target (the client picker now collects several) and a sacrifice DECISION
 * carrying a follow-up, so the return only happens once the sacrifice actually took place.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const cast = (s: St, A: PlayerId, targets: ObjId[]) => {
  const spell = putCard(s, A, 'Victimize', 'hand')
  toStep(s, 'main1')
  addMana(s, A, 'B', 1)
  addMana(s, A, 'C', 2)
  act(s, A, { type: 'r.cast', objId: spell, targets })
  return spell
}

describe('CARD63 — Victimize', () => {
  it('sacrifices one creature and returns BOTH chosen cards tapped', () => {
    const { state, A } = makeDuel()
    const dead1 = putCard(state, A, 'Serra Angel', 'graveyard')
    const dead2 = putCard(state, A, 'Grizzly Bears', 'graveyard')
    const fodder = putCard(state, A, 'Gray Ogre', 'battlefield')
    cast(state, A, [dead1, dead2])
    until(state, (s) => s.pending?.kind === 'sacrifice' && s.pending.player === A, 'the sacrifice')
    expect(state.pendingSacrifice!.count).toBe(1)
    act(state, A, { type: 'r.sacrifice', objIds: [fodder] })
    expect(state.objects[fodder]!.zone).toBe('graveyard')
    for (const id of [dead1, dead2]) {
      expect(state.objects[id]!.zone).toBe('battlefield')
      expect(state.objects[id]!.tapped).toBe(true)
      expect(state.objects[id]!.summoningSick).toBe(true)
      expect(state.objects[id]!.controllerId).toBe(A)
    }
  })

  it('does nothing at all with no creature to sacrifice', () => {
    const { state, A } = makeDuel()
    const dead1 = putCard(state, A, 'Serra Angel', 'graveyard')
    const dead2 = putCard(state, A, 'Grizzly Bears', 'graveyard')
    cast(state, A, [dead1, dead2])
    resolve(state, A)
    expect(state.pending).toBeFalsy()
    expect(state.objects[dead1]!.zone).toBe('graveyard')
    expect(state.objects[dead2]!.zone).toBe('graveyard')
    expect(state.log.some((l) => /controls no creature to sacrifice/.test(l))).toBe(true)
  })

  it('needs exactly two creature cards in YOUR graveyard', () => {
    const { state, A, B } = makeDuel()
    const mine = putCard(state, A, 'Serra Angel', 'graveyard')
    const theirs = putCard(state, B, 'Grizzly Bears', 'graveyard')
    const notCreature = putCard(state, A, 'Shock', 'graveyard')
    const spell = putCard(state, A, 'Victimize', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 2)
    expect(() => act(state, A, { type: 'r.cast', objId: spell, targets: [mine] })).toThrow(/exactly 2 targets/)
    expect(() => act(state, A, { type: 'r.cast', objId: spell, targets: [mine, theirs] })).toThrow(/BAD_TARGETS|Illegal target/i)
    expect(() => act(state, A, { type: 'r.cast', objId: spell, targets: [mine, notCreature] })).toThrow(/BAD_TARGETS|Illegal target/i)
  })

  it('the sacrificed creature can be one of your own big ones, and its dies trigger fires', () => {
    const { state, A, B } = makeDuel()
    const dead1 = putCard(state, A, 'Serra Angel', 'graveyard')
    const dead2 = putCard(state, A, 'Grizzly Bears', 'graveyard')
    putCard(state, A, 'Blood Artist', 'battlefield') // a targeted dies trigger
    const fodder = putCard(state, A, 'Gray Ogre', 'battlefield')
    cast(state, A, [dead1, dead2])
    until(state, (s) => s.pending?.kind === 'sacrifice', 'the sacrifice')
    act(state, A, { type: 'r.sacrifice', objIds: [fodder] })
    // Blood Artist saw the death and wants a target
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, "Blood Artist's trigger")
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    until(state, (s) => s.players[B]!.life !== 40, 'the drain')
    expect(state.players[B]!.life).toBe(39)
    // …and the reanimation still happened
    expect(state.objects[dead1]!.zone).toBe('battlefield')
  })

  it('a card that left the graveyard meanwhile is simply skipped', () => {
    const { state, A } = makeDuel()
    const dead1 = putCard(state, A, 'Serra Angel', 'graveyard')
    const dead2 = putCard(state, A, 'Grizzly Bears', 'graveyard')
    const fodder = putCard(state, A, 'Gray Ogre', 'battlefield')
    cast(state, A, [dead1, dead2])
    until(state, (s) => s.pending?.kind === 'sacrifice', 'the sacrifice')
    // exile one of them by hand before answering (a manual override, as a player would)
    act(state, A, { type: 'r.mMove', objId: dead2, zone: 'exile' })
    act(state, A, { type: 'r.sacrifice', objIds: [fodder] })
    expect(state.objects[dead1]!.zone).toBe('battlefield')
    expect(nameOf(state, dead2)).toBe('Grizzly Bears')
    expect(state.objects[dead2]!.zone).toBe('exile')
  })

  it('redact offers the legal graveyard cards for the pick', () => {
    const { state, A } = makeDuel()
    const dead1 = putCard(state, A, 'Serra Angel', 'graveyard')
    putCard(state, A, 'Shock', 'graveyard')
    putCard(state, A, 'Gray Ogre', 'battlefield')
    const spell = putCard(state, A, 'Victimize', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 2)
    // only ONE creature card is in the graveyard, so the spell is not castable yet
    expect(computeLegal(state, A).castableIds).not.toContain(spell)
    putCard(state, A, 'Grizzly Bears', 'graveyard')
    expect(computeLegal(state, A).castableIds).toContain(spell)
    expect(state.objects[dead1]!.zone).toBe('graveyard')
  })
})
