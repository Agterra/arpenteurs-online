/**
 * Coverage batch MECH10: BESTOW (CR 702.103). A bestow creature may be cast normally as a creature,
 * or for its bestow cost as an Aura enchanting a creature (granting the host its `grantsToHost`
 * bonus). While attached it is NOT a creature; if the enchanted creature leaves, it stops being an
 * Aura and becomes a creature (staying on the battlefield). Card: Nyxborn Rollicker {G} 1/1,
 * Bestow {1}{G}, enchanted creature gets +1/+1.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { battlefieldCreatures, isCreatureOnBattlefield } from '../../server/rules/state.ts'
import { currentPower } from '../../server/rules/characteristics.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const ids = (s: St, A: PlayerId) => battlefieldCreatures(s, A).map((c) => c.id)

describe('bestow — cast as an Aura, then become a creature when the host leaves', () => {
  it('bestowing pumps the host and is not itself a creature; on the host dying it becomes a 1/1', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2 host
    const roll = putCard(state, A, 'Nyxborn Rollicker', 'hand')
    toStep(state, 'main1')

    // cast as bestow (Aura) on the bear
    addMana(state, A, 'G', 2) // {1}{G}
    act(state, A, { type: 'r.cast', objId: roll, bestow: true, targets: [bear] })
    resolve(state, A)
    expect(state.objects[roll]!.bestowed).toBe(true)
    expect(state.objects[roll]!.attachedTo).toBe(bear)
    expect(currentPower(state, state.objects[bear]!)).toBe(3) // 2 + 1 from bestow
    expect(isCreatureOnBattlefield(state, roll)).toBe(false) // it's an Aura now
    expect(ids(state, A)).toContain(bear)

    // kill the host — needs 3 damage since bestow made it a 3/3 (Shock's 2 wouldn't be lethal)
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(state.objects[roll]!.bestowed).toBeFalsy()
    expect(state.objects[roll]!.attachedTo).toBeFalsy()
    expect(state.objects[roll]!.zone).toBe('battlefield')
    expect(isCreatureOnBattlefield(state, roll)).toBe(true) // now a 1/1 creature
  })

  it('cast normally, it is just a 1/1 creature (not bestowed)', () => {
    const { state, A } = makeDuel()
    const roll = putCard(state, A, 'Nyxborn Rollicker', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1) // {G}
    act(state, A, { type: 'r.cast', objId: roll, targets: [] })
    resolve(state, A)
    expect(state.objects[roll]!.zone).toBe('battlefield')
    expect(state.objects[roll]!.bestowed).toBeFalsy()
    expect(currentPower(state, state.objects[roll]!)).toBe(1)
    expect(ids(state, A)).toContain(roll)
  })
})
