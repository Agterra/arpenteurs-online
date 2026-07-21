/**
 * Coverage batch MECH16: MORPH (CR 702.37). Cast a card face down as a 2/2 creature for {3}; turn
 * it face up any time for its morph cost. Face down it's a 2/2 with no name/abilities (hidden from
 * opponents); face up it's the real creature. Card: Battering Craghorn {3}{R}{R} 3/1 first strike,
 * Morph {2}{R}{R}.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { redactRulesState } from '../../server/rules/redact.ts'
import { currentPT, currentKeywords } from '../../server/rules/characteristics.ts'
import { defKey } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('morph — cast face down as a 2/2, turn up for the morph cost', () => {
  it('enters as a hidden 2/2, then turns face up into a 3/1 first striker', () => {
    const { state, A, B } = makeDuel()
    const cra = putCard(state, A, 'Battering Craghorn', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 3) // the fixed {3} to cast face down
    act(state, A, { type: 'r.cast', objId: cra, faceDown: true, targets: [] })
    resolve(state, A)

    // face down: a 2/2 with no keywords
    expect(state.objects[cra]!.zone).toBe('battlefield')
    expect(state.objects[cra]!.faceDown).toBe(true)
    expect(currentPT(state, state.objects[cra]!)).toEqual({ power: 2, toughness: 2 })
    expect(currentKeywords(state, state.objects[cra]!)).not.toContain('first strike')

    // HIDDEN INFO: the opponent sees a nameless 2/2; the owner knows what it is
    const forB = redactRulesState(state, B).cards[cra]!
    expect(forB.defName).toBeNull()
    expect(forB.faceDown).toBe(true)
    expect(forB.power).toBe(2)
    expect(redactRulesState(state, A).cards[cra]!.defName).toBe(defKey('Battering Craghorn'))

    // turn face up for the morph cost → real 3/1 first striker, now revealed to everyone
    addMana(state, A, 'R', 4) // {2}{R}{R}
    act(state, A, { type: 'r.morph', objId: cra })
    expect(state.objects[cra]!.faceDown).toBe(false)
    expect(currentPT(state, state.objects[cra]!)).toEqual({ power: 3, toughness: 1 })
    expect(currentKeywords(state, state.objects[cra]!)).toContain('first strike')
    expect(redactRulesState(state, B).cards[cra]!.defName).toBe(defKey('Battering Craghorn'))
  })
})
