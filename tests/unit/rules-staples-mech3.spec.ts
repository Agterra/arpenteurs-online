/**
 * Coverage batch MECH3: FLASHBACK (CR 702.34). You may cast an instant/sorcery from your graveyard
 * for its flashback cost; as it leaves the stack it is EXILED instead of returning to the graveyard
 * (so it can't be flashed back again). Card: Firebolt {R} — 2 damage to any target, flashback {4}{R}.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, who: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === who, 'resolve')

describe('flashback — cast from the graveyard, then exile', () => {
  it('Firebolt is cast from hand → graveyard, then flashed back for {4}{R} → exile', () => {
    const { state, A, B } = makeDuel()
    const bolt = putCard(state, A, 'Firebolt', 'hand')
    toStep(state, 'main1')

    // normal cast from hand: 2 damage to B, then to the graveyard
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [B] })
    resolve(state, A)
    expect(state.players[B]!.life).toBe(38)
    expect(state.objects[bolt]!.zone).toBe('graveyard')

    // flashback from the graveyard for {4}{R}: 2 more damage, then EXILED
    addMana(state, A, 'R', 5)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [B] })
    resolve(state, A)
    expect(state.players[B]!.life).toBe(36)
    expect(state.objects[bolt]!.zone).toBe('exile')

    // it's in exile now — it cannot be flashed back again (not in the graveyard)
    addMana(state, A, 'R', 5)
    expect(() => act(state, A, { type: 'r.cast', objId: bolt, targets: [B] })).toThrow()
  })
})
