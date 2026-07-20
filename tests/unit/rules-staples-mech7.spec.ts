/**
 * Coverage batch MECH7: SUSPEND (CR 702.62). Instead of casting, pay the suspend cost to exile the
 * card with N time counters. At the beginning of your upkeep a time counter is removed; when the
 * last is removed the card is cast for free (a creature gains haste). Cards: Errant Ephemeron
 * {6}{U} 6/4 flying (Suspend 4—{1}{U}) and Search for Tomorrow {2}{G} (Suspend 2—{G}).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })

describe('suspend — exile with time counters, cast when the last is removed', () => {
  it('Errant Ephemeron is suspended, then cast with haste when its last time counter is removed', () => {
    const { state, A } = makeDuel()
    const eph = putCard(state, A, 'Errant Ephemeron', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 2) // suspend cost {1}{U}
    act(state, A, { type: 'r.suspend', objId: eph })
    expect(state.objects[eph]!.zone).toBe('exile')
    expect(state.objects[eph]!.counters.time).toBe(4)

    // fast-forward to the last time counter, then let an upkeep remove it → free cast
    state.objects[eph]!.counters.time = 1
    until(state, (s) => s.objects[eph]!.zone === 'battlefield', 'Ephemeron cast from suspend')
    expect(state.objects[eph]!.zone).toBe('battlefield')
    expect(state.objects[eph]!.summoningSick).toBe(false) // haste (CR 702.62e)
  })

  it('a non-creature suspend spell (Search for Tomorrow) exiles with its time counters', () => {
    const { state, A } = makeDuel()
    const sft = putCard(state, A, 'Search for Tomorrow', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1) // suspend cost {G}
    act(state, A, { type: 'r.suspend', objId: sft })
    expect(state.objects[sft]!.zone).toBe('exile')
    expect(state.objects[sft]!.counters.time).toBe(2)
  })
})
