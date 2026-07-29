/**
 * Perpetual card coverage — batch CARD46: triggered abilities GRANTED until end of turn —
 * 'that creature gains "When this creature dies, return it to the battlefield tapped under its
 * owner's control"' (Malakir Rebirth, Feign Death, Undying Malice). The granted body lives in the
 * GRANTING card's definition and the state stores only names, so nothing serialisable holds a
 * function; the ability's source is the creature that gained it.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
/** cast a one-mana granting instant at `target` */
const grantTo = (s: St, A: PlayerId, card: string, target: ObjId) => {
  const spell = putCard(s, A, card, 'hand')
  addMana(s, A, 'B', 1)
  act(s, A, { type: 'r.cast', objId: spell, targets: [target] })
  resolve(s, A)
  return spell
}

describe('CARD46 — Malakir Rebirth', () => {
  it('returns the creature tapped when it dies, and costs you 2 life', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    grantTo(state, A, 'Malakir Rebirth', bear)
    expect(state.players[A]!.life).toBe(life - 2)
    expect(state.grantedTriggers?.length).toBe(1)
    // kill it: the granted trigger returns it tapped, with no counter
    const bolt = putCard(state, B, 'Lightning Bolt', 'hand')
    pass(state, A)
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: bolt, targets: [bear] })
    until(state, (s) => (s.objects[bear]!.zone === 'battlefield' && s.objects[bear]!.tapped) || s.turnNumber > 1, 'the rebirth')
    expect(state.objects[bear]!.zone).toBe('battlefield')
    expect(state.objects[bear]!.tapped).toBe(true)
    expect(state.objects[bear]!.counters['+1/+1']).toBeUndefined()
    expect(state.objects[bear]!.summoningSick).toBe(true)
  })

  it('returns it under its OWNER\'s control even when an opponent controls it', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    state.objects[bear]!.controllerId = A // A has stolen it
    toStep(state, 'main1')
    grantTo(state, A, 'Malakir Rebirth', bear)
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand') // a real death fires dies triggers
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [bear] })
    until(state, (s) => (s.objects[bear]!.zone === 'battlefield' && s.objects[bear]!.tapped) || s.turnNumber > 1, 'the rebirth')
    expect(state.objects[bear]!.zone).toBe('battlefield')
    expect(state.objects[bear]!.controllerId).toBe(B) // back to its owner
  })

  it('wears off at end of turn', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    grantTo(state, A, 'Malakir Rebirth', bear)
    const turn = state.turnNumber
    until(state, (s) => s.turnNumber > turn, 'the next turn')
    expect(state.grantedTriggers).toEqual([])
    until(state, (s) => s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A, "A's main phase")
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [bear] })
    until(state, (s) => s.objects[bear]!.zone === 'graveyard', 'the death')
    until(state, (s) => !s.zones.stack.length, 'nothing on the stack')
    expect(state.objects[bear]!.zone).toBe('graveyard') // stays dead
  })

  it('can be played as Malakir Mire instead (a tapped land)', () => {
    const { state, A } = makeDuel()
    const card = putCard(state, A, 'Malakir Rebirth', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: card, back: true })
    expect(nameOf(state, card)).toBe('Malakir Mire')
    expect(state.objects[card]!.tapped).toBe(true)
    state.objects[card]!.tapped = false
    act(state, A, { type: 'r.tapMana', objId: card, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })
})

describe('CARD46 — Feign Death and Undying Malice (with a +1/+1 counter)', () => {
  for (const card of ['Feign Death', 'Undying Malice']) {
    it(`${card} returns the creature tapped with a +1/+1 counter, at no life cost`, () => {
      const { state, A, B } = makeDuel()
      const ogre = putCard(state, A, 'Gray Ogre', 'battlefield') // 2/2
      toStep(state, 'main1')
      const life = state.players[A]!.life
      grantTo(state, A, card, ogre)
      expect(state.players[A]!.life).toBe(life)
      const bolt = putCard(state, B, 'Lightning Bolt', 'hand')
      pass(state, A)
      addMana(state, B, 'R', 1)
      act(state, B, { type: 'r.cast', objId: bolt, targets: [ogre] })
      until(state, (s) => (s.objects[ogre]!.zone === 'battlefield' && s.objects[ogre]!.tapped) || s.turnNumber > 1, 'the return')
      expect(state.objects[ogre]!.zone).toBe('battlefield')
      expect(state.objects[ogre]!.tapped).toBe(true)
      expect(state.objects[ogre]!.counters['+1/+1']).toBe(1)
    })
  }

  it('saves a creature from combat death too', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2
    const blocker = putCard(state, B, 'Serra Angel', 'battlefield') // 4/4
    state.objects[bear]!.summoningSick = false
    toStep(state, 'main1')
    grantTo(state, A, 'Feign Death', bear)
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [bear])
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: blocker, attackerId: bear }] })
    // it attacked, so it is already tapped — wait for the DEATH, then for the return
    until(state, (s) => s.objects[bear]!.zone === 'graveyard' || s.turnNumber > 1, 'the combat death')
    until(state, (s) => s.objects[bear]!.zone === 'battlefield' || s.turnNumber > 1, 'the return')
    expect(state.objects[bear]!.zone).toBe('battlefield')
    expect(state.objects[bear]!.counters['+1/+1']).toBe(1)
  })

  it('does nothing if the creature is exiled instead of dying', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    grantTo(state, A, 'Feign Death', bear)
    const swords = putCard(state, B, 'Swords to Plowshares', 'hand') // exile, not destroy
    pass(state, A)
    addMana(state, B, 'W', 1)
    act(state, B, { type: 'r.cast', objId: swords, targets: [bear] })
    until(state, (s) => s.objects[bear]!.zone === 'exile', 'the exile')
    expect(state.objects[bear]!.zone).toBe('exile') // no dies trigger — it never hit the graveyard
  })
})
