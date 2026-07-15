/**
 * Coverage batch KW4: persist (CR 702.79) + undying (CR 702.92). When a creature dies, if it had
 * no relevant counter it returns to the battlefield under its owner's control with a -1/-1 (persist)
 * or +1/+1 (undying) counter. Hooked in moveToGraveyard (the death funnel).
 */
import { describe, expect, it } from 'vitest'
import { makeDuel, putCard } from './rules-helpers.ts'
import type { RulesGameState } from '../../shared/rules/types.ts'
import { checkSBA } from '../../server/rules/engine.ts'
import { currentKeywords, currentPower } from '../../server/rules/characteristics.ts'

type St = RulesGameState
const kill = (state: St, id: string) => {
  state.objects[id]!.damageMarked = 99
  checkSBA(state)
}

describe('undying — return with a +1/+1 counter, once', () => {
  it('a dying undying creature returns as a bigger creature, but not a second time', () => {
    const { state, A } = makeDuel()
    const wolf = putCard(state, A, 'Young Wolf', 'battlefield') // 1/1 undying
    kill(state, wolf)
    expect(state.objects[wolf]!.zone).toBe('battlefield') // returned
    expect(state.objects[wolf]!.counters['+1/+1']).toBe(1)
    expect(currentPower(state, state.objects[wolf]!)).toBe(2) // 1/1 + counter
    kill(state, wolf) // now it HAS a +1/+1 counter → stays dead
    expect(state.objects[wolf]!.zone).toBe('graveyard')
  })
})

describe('persist — return with a -1/-1 counter, once', () => {
  it('a dying persist creature returns smaller, but not a second time', () => {
    const { state, A } = makeDuel()
    const goblin = putCard(state, A, 'Putrid Goblin', 'battlefield') // 2/2 persist
    kill(state, goblin)
    expect(state.objects[goblin]!.zone).toBe('battlefield') // returned
    expect(state.objects[goblin]!.counters['-1/-1']).toBe(1)
    expect(currentPower(state, state.objects[goblin]!)).toBe(1) // 2/2 − counter
    kill(state, goblin) // now it HAS a -1/-1 counter → stays dead
    expect(state.objects[goblin]!.zone).toBe('graveyard')
  })
})

describe('persist/undying respect "loses all abilities" (review fix)', () => {
  it('a creature that lost undying (layer 6) does not return', () => {
    const { state, A } = makeDuel()
    const wolf = putCard(state, A, 'Young Wolf', 'battlefield') // 1/1 undying
    state.loseAbilities.push(wolf) // e.g. Ovinize — undying is stripped
    kill(state, wolf)
    expect(state.objects[wolf]!.zone).toBe('graveyard') // no undying at death → stays dead
  })
})

describe('persist + evasion combine (Lingering Tormentor: fear + persist)', () => {
  it('has both keywords and returns via persist', () => {
    const { state, A } = makeDuel()
    const t = putCard(state, A, 'Lingering Tormentor', 'battlefield') // 2/2 fear + persist
    expect(currentKeywords(state, state.objects[t]!)).toEqual(expect.arrayContaining(['fear', 'persist']))
    kill(state, t)
    expect(state.objects[t]!.zone).toBe('battlefield')
    expect(state.objects[t]!.counters['-1/-1']).toBe(1)
  })
})
