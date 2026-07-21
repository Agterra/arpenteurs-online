/**
 * Coverage batch MECH15: FORETELL (CR 702.143). During your turn, pay {2} to exile a card FACE
 * DOWN; on a LATER turn cast it for its foretell cost. The face-down card's identity is hidden from
 * opponents (the redactor sends no defName). Card: Augury Raven {3}{U} 2/3 flying, Foretell {2}{U}.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { redactRulesState } from '../../server/rules/redact.ts'
import { defKey, getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('foretell — exile face down, cast on a later turn; identity hidden from opponents', () => {
  it('foretells (hidden to the opponent), can\'t be cast the same turn, then cast next turn', () => {
    const { state, A, B } = makeDuel()
    const raven = putCard(state, A, 'Augury Raven', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 2) // the fixed {2} foretell cost
    act(state, A, { type: 'r.foretell', objId: raven })
    expect(state.objects[raven]!.zone).toBe('exile')
    expect(state.objects[raven]!.faceDown).toBe(true)

    // HIDDEN INFO: the opponent sees a face-down card with NO identity; the owner sees it
    const forB = redactRulesState(state, B).cards[raven]!
    expect(forB.defName).toBeNull()
    expect(forB.faceDown).toBe(true)
    expect(forB.hidden).toBe(true)
    const forA = redactRulesState(state, A).cards[raven]!
    expect(forA.defName).toBe(defKey('Augury Raven')) // owner knows their own foretold card

    // can't cast it the turn it was foretold (it's in exile, not castable yet)
    addMana(state, A, 'U', 3)
    expect(() => act(state, A, { type: 'r.cast', objId: raven, targets: [] })).toThrow()

    // a later turn: cast for the foretell cost {2}{U} → enters as a 2/3 flyer, revealed
    until(state, (x) => x.turnNumber >= 3 && x.activePlayer === A && x.step === 'main1' && x.priorityPlayer === A && !x.zones.stack.length, 'A turn 3')
    addMana(state, A, 'U', 3)
    act(state, A, { type: 'r.cast', objId: raven, targets: [] })
    resolve(state, A)
    expect(state.objects[raven]!.zone).toBe('battlefield')
    expect(state.objects[raven]!.faceDown).toBeFalsy()
    expect(getDef(state.objects[raven]!.defName).name).toBe('Augury Raven')
  })
})
