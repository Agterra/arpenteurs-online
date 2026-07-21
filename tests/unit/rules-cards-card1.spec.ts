/**
 * Perpetual card coverage — batch CARD1: popular Commander staples reusing existing primitives.
 * Dark Ritual, Cancel, Night's Whisper, Swiftfoot Boots, Lightning Greaves.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { currentKeywords } from '../../server/rules/characteristics.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD1 — staple cards', () => {
  it('Dark Ritual adds {B}{B}{B}', () => {
    const { state, A } = makeDuel()
    const dr = putCard(state, A, 'Dark Ritual', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1) // pay {B}
    act(state, A, { type: 'r.cast', objId: dr, targets: [] })
    resolve(state, A)
    expect(state.players[A]!.manaPool.B).toBe(3) // net +2, three black in pool
  })

  it('Cancel counters a spell on the stack', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    const cancel = putCard(state, A, 'Cancel', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    addMana(state, A, 'U', 3)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] }) // Bears on the stack
    act(state, A, { type: 'r.cast', objId: cancel, targets: [bear] }) // counter it
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard') // countered — never entered play
  })

  it('Swiftfoot Boots grants hexproof + haste; Lightning Greaves shroud + haste', () => {
    const { state, A } = makeDuel()
    const boots = putCard(state, A, 'Swiftfoot Boots', 'battlefield')
    const greaves = putCard(state, A, 'Lightning Greaves', 'battlefield')
    const bearA = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const bearB = putCard(state, A, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'C', 1) // equip {1} for the boots
    act(state, A, { type: 'r.equip', equipmentId: boots, creatureId: bearA })
    act(state, A, { type: 'r.equip', equipmentId: greaves, creatureId: bearB }) // equip {0}
    expect(currentKeywords(state, state.objects[bearA]!)).toEqual(expect.arrayContaining(['hexproof', 'haste']))
    expect(currentKeywords(state, state.objects[bearB]!)).toEqual(expect.arrayContaining(['shroud', 'haste']))
  })
})
