/**
 * Perpetual card coverage — batch CARD64: Command Beacon (commander from the command zone to your hand)
 * and Tireless Provisioner, whose LANDFALL trigger is modal ("create a Food token or a Treasure token") —
 * CARD62's modal-trigger machinery generalised from the first-main trigger to any trigger kind.
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
const countOf = (s: St, p: PlayerId, name: string) => s.zones.perPlayer[p]!.battlefield.filter((id) => nameOf(s, id) === name).length

describe('CARD64 — Command Beacon', () => {
  const rig = (s: St, A: PlayerId) => {
    const beacon = putCard(s, A, 'Command Beacon', 'battlefield')
    const cmd = putCard(s, A, 'Loran of the Third Path', 'command')
    s.players[A]!.commanderId = cmd
    s.objects[cmd]!.isCommander = true
    toStep(s, 'main1')
    return { beacon, cmd }
  }

  it('taps for {C}, and its second ability fetches your commander to hand', () => {
    const { state, A } = makeDuel()
    const { beacon, cmd } = rig(state, A)
    act(state, A, { type: 'r.tapMana', objId: beacon, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
    state.objects[beacon]!.tapped = false
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.activate', objId: beacon, abilityIndex: 1, targets: [] })
    expect(state.objects[beacon]!.zone).toBe('graveyard') // sacrificed as a cost
    resolve(state, A)
    // the command zone is PUBLIC and the hand is HIDDEN, so the id IS re-minted (invariant #3) and the
    // commander bookkeeping follows it — the leak fuzzer caught the first version keeping the old id
    expect(state.objects[cmd]).toBeUndefined()
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 1)
    const newId = state.zones.perPlayer[A]!.hand.find((id) => nameOf(state, id) === 'Loran of the Third Path')!
    expect(newId).toBeTruthy()
    expect(state.objects[newId]!.zone).toBe('hand')
    expect(state.players[A]!.commanderId).toBe(newId)
  })

  it('does nothing when the commander is not in the command zone', () => {
    const { state, A } = makeDuel()
    const { beacon, cmd } = rig(state, A)
    act(state, A, { type: 'r.mMove', objId: cmd, zone: 'battlefield' }) // it is out on the field
    act(state, A, { type: 'r.activate', objId: beacon, abilityIndex: 1, targets: [] })
    resolve(state, A)
    expect(state.objects[cmd]!.zone).toBe('battlefield')
    expect(state.log.some((l) => /commander is not in the command zone/.test(l))).toBe(true)
  })

  it('its ability is offered while untapped', () => {
    const { state, A } = makeDuel()
    const { beacon } = rig(state, A)
    expect(computeLegal(state, A).activations.some((a) => a.objId === beacon)).toBe(true)
    state.objects[beacon]!.tapped = true
    expect(computeLegal(state, A).activations.some((a) => a.objId === beacon)).toBe(false)
  })
})

describe('CARD64 — Tireless Provisioner', () => {
  const playLandWith = (s: St, A: PlayerId) => {
    putCard(s, A, 'Tireless Provisioner', 'battlefield')
    const land = putCard(s, A, 'Forest', 'hand')
    toStep(s, 'main1')
    act(s, A, { type: 'r.playLand', objId: land })
    until(s, (x) => x.pending?.kind === 'modes' && x.pending.player === A, 'the landfall mode choice')
  }

  it('offers Food or Treasure on each land you play — exactly one', () => {
    const { state, A } = makeDuel()
    playLandWith(state, A)
    const legal = computeLegal(state, A)
    expect(legal.needsModes).toBe(true)
    expect(legal.modeOneOrMore).toBe(false)
    expect(legal.modeCount).toBe(1)
    expect(legal.modeSourceName).toBe('Tireless Provisioner')
    expect(legal.modeLabels).toEqual(['Create a Food token', 'Create a Treasure token'])
    expect(() => act(state, A, { type: 'r.chooseModes', modes: [] })).toThrow(/Choose exactly 1/)
    expect(() => act(state, A, { type: 'r.chooseModes', modes: [0, 1] })).toThrow(/Choose exactly 1/)
    act(state, A, { type: 'r.chooseModes', modes: [1] })
    expect(countOf(state, A, 'Treasure')).toBe(1)
    expect(countOf(state, A, 'Food')).toBe(0)
  })

  it('the Food half makes a Food token', () => {
    const { state, A } = makeDuel()
    playLandWith(state, A)
    act(state, A, { type: 'r.chooseModes', modes: [0] })
    expect(countOf(state, A, 'Food')).toBe(1)
  })

  it('triggers again for a second land, and not for an opponent\'s', () => {
    const { state, A, B } = makeDuel()
    playLandWith(state, A)
    act(state, A, { type: 'r.chooseModes', modes: [0] })
    // a second land drop this turn (a manual r.mMove is deliberately trigger-free, so play it properly)
    state.players[A]!.extraLandsThisTurn = 1
    const another = putCard(state, A, 'Mountain', 'hand')
    act(state, A, { type: 'r.playLand', objId: another })
    until(state, (s) => s.pending?.kind === 'modes', 'the second landfall')
    act(state, A, { type: 'r.chooseModes', modes: [1] })
    expect(countOf(state, A, 'Food')).toBe(1)
    expect(countOf(state, A, 'Treasure')).toBe(1)
    // an OPPONENT's land does nothing
    until(state, (s) => s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    const theirs = putCard(state, B, 'Forest', 'hand')
    act(state, B, { type: 'r.playLand', objId: theirs })
    expect(state.pending?.kind).not.toBe('modes')
  })

  it('the Food token can be sacrificed for 3 life', () => {
    const { state, A } = makeDuel()
    playLandWith(state, A)
    act(state, A, { type: 'r.chooseModes', modes: [0] })
    const food = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Food')!
    resolve(state, A)
    const life = state.players[A]!.life
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.activate', objId: food, abilityIndex: 0, targets: [] })
    until(state, (s) => s.players[A]!.life !== life, 'the life gain')
    expect(state.players[A]!.life).toBe(life + 3)
  })
})
