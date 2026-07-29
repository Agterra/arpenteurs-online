/**
 * Perpetual card coverage — batch CARD52: two new trigger timings — "when this permanent LEAVES THE
 * BATTLEFIELD" (CR 603.6d, any exit, not just dying) and "at the beginning of combat on your turn"
 * (CR 506.1) — plus token COPIES that keep the original's whole definition. Cards: Animate Dead
 * (an Aura cast on a creature card in a graveyard), The Ozolith, Helm of the Host.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { putCounters } from '../../server/rules/state.ts'
import { currentPT } from '../../server/rules/characteristics.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const counters = (s: St, id: ObjId, kind = '+1/+1') => s.objects[id]!.counters[kind] ?? 0

describe('CARD52 — Animate Dead', () => {
  const animate = (s: St, A: PlayerId, cardInGy: ObjId) => {
    const aura = putCard(s, A, 'Animate Dead', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'B', 1)
    addMana(s, A, 'C', 1)
    act(s, A, { type: 'r.cast', objId: aura, targets: [cardInGy] })
    resolve(s, A)
    return aura
  }

  it('returns the creature under YOUR control, attached, at -1/-0', () => {
    const { state, A, B } = makeDuel()
    const dead = putCard(state, B, 'Serra Angel', 'graveyard') // 4/4, owned by the opponent
    const aura = animate(state, A, dead)
    expect(state.objects[dead]!.zone).toBe('battlefield')
    expect(state.objects[dead]!.controllerId).toBe(A) // stolen from their graveyard
    expect(state.objects[dead]!.ownerId).toBe(B)
    expect(state.objects[aura]!.attachedTo).toBe(dead)
    expect(currentPT(state, state.objects[dead]!)).toEqual({ power: 3, toughness: 4 }) // -1/-0
    expect(state.objects[dead]!.summoningSick).toBe(true)
  })

  it("sacrifices the creature when the AURA leaves the battlefield", () => {
    const { state, A, B } = makeDuel()
    const dead = putCard(state, A, 'Serra Angel', 'graveyard')
    const aura = animate(state, A, dead)
    // destroy the Aura: its leaves-the-battlefield trigger sacrifices the creature
    const naturalize = putCard(state, B, 'Naturalize', 'hand')
    pass(state, A)
    addMana(state, B, 'G', 1)
    addMana(state, B, 'C', 1)
    act(state, B, { type: 'r.cast', objId: naturalize, targets: [aura] })
    until(state, (s) => s.objects[dead]!.zone === 'graveyard' || s.turnNumber > 1, 'the sacrifice')
    expect(state.objects[aura]!.zone).toBe('graveyard')
    expect(state.objects[dead]!.zone).toBe('graveyard')
    expect(state.log.some((l) => /is sacrificed \(Animate Dead left the battlefield\)/.test(l))).toBe(true)
  })

  it('only a CREATURE card in a graveyard is a legal target', () => {
    const { state, A } = makeDuel()
    const notCreature = putCard(state, A, 'Shock', 'graveyard')
    const aura = putCard(state, A, 'Animate Dead', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: aura, targets: [notCreature] })).toThrow(/BAD_TARGETS|Illegal target/i)
  })

  it('the reanimated creature can attack the turn after', () => {
    const { state, A, B } = makeDuel()
    const dead = putCard(state, A, 'Serra Angel', 'graveyard')
    animate(state, A, dead)
    until(state, (s) => s.activePlayer === A && s.turnNumber > 1 && s.pending?.kind === 'attackers', "A's next attack")
    attack(state, A, B, [dead])
    until(state, (s) => s.players[B]!.life !== 40, 'combat damage')
    expect(state.players[B]!.life).toBe(37) // 4/4 at -1/-0
  })
})

describe('CARD52 — The Ozolith', () => {
  it('collects the counters of a creature you control that leaves', () => {
    const { state, A } = makeDuel()
    const ozolith = putCard(state, A, 'The Ozolith', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCounters(state, bear, '+1/+1', 3)
    toStep(state, 'main1')
    // exile it (an exit that is NOT a death, so the dies trigger would not do)
    const swords = putCard(state, A, 'Swords to Plowshares', 'hand')
    addMana(state, A, 'W', 1)
    act(state, A, { type: 'r.cast', objId: swords, targets: [bear] })
    until(state, (s) => counters(s, ozolith) > 0 || s.turnNumber > 1, 'the counters moving')
    expect(state.objects[bear]!.zone).toBe('exile')
    expect(counters(state, ozolith)).toBe(3)
  })

  it("ignores an OPPONENT's creature leaving", () => {
    const { state, A, B } = makeDuel()
    const ozolith = putCard(state, A, 'The Ozolith', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    putCounters(state, theirs, '+1/+1', 2)
    toStep(state, 'main1')
    // a 2/2 with two +1/+1 counters is a 4/4, so destroy it rather than trying to burn it down
    const murder = putCard(state, A, 'Murder', 'hand')
    addMana(state, A, 'B', 2)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: murder, targets: [theirs] })
    until(state, (s) => s.objects[theirs]!.zone === 'graveyard', 'the death')
    resolve(state, A)
    expect(counters(state, ozolith)).toBe(0)
  })

  it('moves all its counters onto a creature at the beginning of combat', () => {
    const { state, A, B } = makeDuel()
    const ozolith = putCard(state, A, 'The Ozolith', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCounters(state, ozolith, '+1/+1', 2)
    state.objects[bear]!.summoningSick = false
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'the combat trigger')
    act(state, A, { type: 'r.chooseTargets', targets: [bear] })
    until(state, (s) => counters(s, bear) > 0 || s.turnNumber > 1, 'the counters moving')
    expect(counters(state, bear)).toBe(2)
    expect(counters(state, ozolith)).toBe(0)
    expect(currentPT(state, state.objects[bear]!)).toEqual({ power: 4, toughness: 4 })
  })

  it('asks nothing at combat while it has no counters', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'The Ozolith', 'battlefield')
    putCard(state, A, 'Grizzly Bears', 'battlefield')
    until(state, (s) => s.step === 'declare_attackers' || s.pending?.kind === 'trigger' || s.turnNumber > 1, 'combat')
    expect(state.pending?.kind).not.toBe('trigger')
  })

  it('the move may be DECLINED (the target is optional)', () => {
    const { state, A } = makeDuel()
    const ozolith = putCard(state, A, 'The Ozolith', 'battlefield')
    putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCounters(state, ozolith, '+1/+1', 2)
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'the combat trigger')
    act(state, A, { type: 'r.chooseTargets', targets: [] })
    until(state, (s) => !s.zones.stack.length, 'it resolves')
    expect(counters(state, ozolith)).toBe(2) // still there
  })
})

describe('CARD52 — Helm of the Host', () => {
  it('creates a hasty token copy of the equipped creature each combat', () => {
    const { state, A, B } = makeDuel()
    const helm = putCard(state, A, 'Helm of the Host', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield') // 2/2
    state.objects[ogre]!.summoningSick = false
    toStep(state, 'main1')
    addMana(state, A, 'C', 5)
    act(state, A, { type: 'r.equip', equipmentId: helm, creatureId: ogre })
    until(state, (s) => s.zones.perPlayer[A]!.battlefield.length > 3 || s.turnNumber > 1, 'the token copy')
    const copies = state.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(state, id) === 'Gray Ogre' && id !== ogre)
    expect(copies.length).toBe(1)
    const copy = copies[0]!
    expect(currentPT(state, state.objects[copy]!)).toEqual({ power: 2, toughness: 2 })
    expect(getDef(state.objects[copy]!.defName).keywords).toContain('haste')
    expect(state.objects[copy]!.summoningSick).toBe(false)
    // …and it can attack immediately
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [copy])
    until(state, (s) => s.players[B]!.life !== 40, 'combat damage')
    expect(state.players[B]!.life).toBe(38)
  })

  it('the copy is NOT legendary, and copies the original\'s abilities', () => {
    const { state, A } = makeDuel()
    const helm = putCard(state, A, 'Helm of the Host', 'battlefield')
    const legend = putCard(state, A, 'Azusa, Lost but Seeking', 'battlefield') // legendary, extra land drops
    state.objects[legend]!.summoningSick = false
    toStep(state, 'main1')
    addMana(state, A, 'C', 5)
    act(state, A, { type: 'r.equip', equipmentId: helm, creatureId: legend })
    until(
      state,
      (s) => s.zones.perPlayer[A]!.battlefield.some((id) => id !== legend && nameOf(s, id) === 'Azusa, Lost but Seeking') || s.turnNumber > 1,
      'the token copy',
    )
    const copy = state.zones.perPlayer[A]!.battlefield.find((id) => id !== legend && nameOf(state, id) === 'Azusa, Lost but Seeking')!
    const def = getDef(state.objects[copy]!.defName)
    expect(def.supertypes ?? []).not.toContain('Legendary')
    expect(def.extraLandDrops).toBe(getDef(state.objects[legend]!.defName).extraLandDrops) // its ability came along
  })

  it('does nothing while it is unattached', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Helm of the Host', 'battlefield')
    const before = state.zones.perPlayer[A]!.battlefield.length
    until(state, (s) => s.step === 'declare_attackers' || s.turnNumber > 1, 'combat')
    expect(state.zones.perPlayer[A]!.battlefield.length).toBe(before)
  })
})
