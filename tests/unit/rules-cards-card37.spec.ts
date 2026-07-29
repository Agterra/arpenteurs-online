/**
 * Perpetual card coverage — batch CARD37: CHANNEL — an activated ability used from the HAND, paying
 * mana and discarding the card, with a cost reduced by your legendary creatures. Cards: Boseiju,
 * Otawara, Eiganjo, Sokenzan.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD37 — channel basics (Otawara)', () => {
  it('pays the cost, discards the card, and bounces the target', () => {
    const { state, A, B } = makeDuel()
    const otawara = putCard(state, A, 'Otawara, Soaring City', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 3)
    expect(computeLegal(state, A).channelable).toEqual([
      { objId: otawara, cost: '{3}{U}', targetKind: 'permanent' },
    ])
    act(state, A, { type: 'r.channel', objId: otawara, targets: [bear] })
    expect(state.objects[otawara]!.zone).toBe('graveyard') // discarded as part of the cost
    expect(state.zones.stack.length).toBe(1) // the ability waits on the stack
    resolve(state, A)
    expect(state.objects[bear]).toBeUndefined() // bounced with a fresh id
  })

  it('costs {1} less per legendary creature you control', () => {
    const { state, A, B } = makeDuel()
    const otawara = putCard(state, A, 'Otawara, Soaring City', 'hand')
    putCard(state, A, 'Azusa, Lost but Seeking', 'battlefield') // legendary
    putCard(state, A, 'Isamaru, Hound of Konda', 'battlefield') // legendary
    putCard(state, A, 'Grizzly Bears', 'battlefield') // not legendary
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 1)
    expect(computeLegal(state, A).channelable[0]!.cost).toBe('{1}{U}') // {3}{U} − 2 legends
    act(state, A, { type: 'r.channel', objId: otawara, targets: [rock] })
    expect(state.players[A]!.manaPool.U).toBe(0)
    expect(state.players[A]!.manaPool.C).toBe(0)
    resolve(state, A)
    expect(state.objects[rock]).toBeUndefined()
  })

  it('is refused without the mana, and the card stays in hand', () => {
    const { state, A, B } = makeDuel()
    const otawara = putCard(state, A, 'Otawara, Soaring City', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    expect(computeLegal(state, A).channelable).toEqual([])
    expect(() => act(state, A, { type: 'r.channel', objId: otawara, targets: [bear] })).toThrow(/Not enough mana/)
    expect(state.objects[otawara]!.zone).toBe('hand')
  })

  it('the land can still be PLAYED normally instead', () => {
    const { state, A } = makeDuel()
    const otawara = putCard(state, A, 'Otawara, Soaring City', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: otawara })
    expect(state.objects[otawara]!.zone).toBe('battlefield')
    act(state, A, { type: 'r.tapMana', objId: otawara })
    expect(state.players[A]!.manaPool.U).toBe(1)
  })
})

describe('CARD37 — Boseiju, Eiganjo, Sokenzan', () => {
  it("Boseiju destroys a nonbasic land an opponent controls and lets THEM fetch a basic", () => {
    const { state, A, B } = makeDuel()
    const boseiju = putCard(state, A, 'Boseiju, Who Endures', 'hand')
    const theirLand = putCard(state, B, 'Watery Grave', 'battlefield') // nonbasic
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.channel', objId: boseiju, targets: [theirLand] })
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === B, "B's land search")
    expect(state.objects[theirLand]!.zone).toBe('graveyard')
    act(state, B, { type: 'r.search', cardIds: [] }) // they may decline
    expect(state.pending).toBeFalsy()
  })

  it('Boseiju cannot target a BASIC land, nor your own permanents', () => {
    const { state, A, B } = makeDuel()
    const boseiju = putCard(state, A, 'Boseiju, Who Endures', 'hand')
    const basic = putCard(state, B, 'Mountain', 'battlefield')
    const mine = putCard(state, A, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    expect(() => act(state, A, { type: 'r.channel', objId: boseiju, targets: [basic] })).toThrow(/BAD_TARGETS|Illegal target/i)
    expect(() => act(state, A, { type: 'r.channel', objId: boseiju, targets: [mine] })).toThrow(/BAD_TARGETS|Illegal target/i)
    expect(state.objects[boseiju]!.zone).toBe('hand')
  })

  it('Eiganjo only hits an ATTACKING or blocking creature', () => {
    const { state, A, B } = makeDuel()
    const eiganjo = putCard(state, B, 'Eiganjo, Seat of the Empire', 'hand')
    const attacker = putCard(state, A, 'Hill Giant', 'battlefield') // 3/3
    const idle = putCard(state, A, 'Grizzly Bears', 'battlefield')
    state.objects[attacker]!.summoningSick = false
    toStep(state, 'main1')
    // before combat nothing is attacking → no legal target, so it is not even offered
    addMana(state, B, 'W', 1)
    addMana(state, B, 'C', 2)
    expect(computeLegal(state, B).channelable).toEqual([])
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [attacker])
    until(state, (s) => s.priorityPlayer === B, "B's priority")
    // step changes empty mana pools (CR 500.4), so float it again now that combat is on
    addMana(state, B, 'W', 1)
    addMana(state, B, 'C', 2)
    expect(() => act(state, B, { type: 'r.channel', objId: eiganjo, targets: [idle] })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, B, { type: 'r.channel', objId: eiganjo, targets: [attacker] })
    until(state, (s) => s.objects[attacker]!.zone === 'graveyard' || !s.zones.stack.length, '4 damage')
    expect(state.objects[attacker]!.zone).toBe('graveyard') // 4 damage kills a 3/3
  })

  it('Sokenzan makes two hasty Spirits and needs no target', () => {
    const { state, A } = makeDuel()
    const sokenzan = putCard(state, A, 'Sokenzan, Crucible of Defiance', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 3)
    expect(computeLegal(state, A).channelable[0]!.targetKind).toBeNull()
    act(state, A, { type: 'r.channel', objId: sokenzan, targets: [] })
    resolve(state, A)
    const spirits = state.zones.perPlayer[A]!.battlefield.filter((id) => getDef(state.objects[id]!.defName).name === 'Spirit')
    expect(spirits.length).toBe(2)
    expect(getDef(state.objects[spirits[0]!]!.defName).keywords).toContain('haste')
  })
})
