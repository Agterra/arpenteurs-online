/**
 * M-R2 activated abilities (CR 602): pay the cost (tap ± mana), choose targets,
 * the ability goes on the stack and resolves like a spell.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'

describe('activated abilities', () => {
  it('Prodigal Sorcerer taps to deal 1 damage to a chosen target', () => {
    const { state, A, B } = makeDuel()
    const tim = putCard(state, A, 'Prodigal Sorcerer') // {T}: 1 dmg to any target
    state.objects[tim]!.summoningSick = false // been in play a turn
    const victim = putCard(state, B, 'Grizzly Bears') // 2/2
    toStep(state, 'main1')
    act(state, A, { type: 'r.activate', objId: tim, abilityIndex: 0, targets: [victim] })
    expect(state.objects[tim]!.tapped).toBe(true) // tapped as a cost
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[victim]!.damageMarked).toBe(1)
  })

  it('a summoning-sick creature cannot use its tap ability', () => {
    const { state, A, B } = makeDuel()
    const tim = putCard(state, A, 'Prodigal Sorcerer')
    state.objects[tim]!.summoningSick = true
    const victim = putCard(state, B, 'Grizzly Bears')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.activate', objId: tim, abilityIndex: 0, targets: [victim] })).toThrow(/tap ability/i)
  })

  it('Jayemdae Tome pays {4} + taps to draw a card', () => {
    const { state, A } = makeDuel()
    const tome = putCard(state, A, 'Jayemdae Tome')
    const lands = Array.from({ length: 4 }, () => putCard(state, A, 'Mountain'))
    toStep(state, 'main1')
    const lib0 = state.zones.perPlayer[A]!.library.length
    for (const l of lands) act(state, A, { type: 'r.tapMana', objId: l })
    act(state, A, { type: 'r.activate', objId: tome, abilityIndex: 0, targets: [] })
    expect(state.objects[tome]!.tapped).toBe(true)
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 - 1) // drew one
  })

  it('rejects activating without enough mana', () => {
    const { state, A } = makeDuel()
    const tome = putCard(state, A, 'Jayemdae Tome') // needs {4}
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.activate', objId: tome, abilityIndex: 0, targets: [] })).toThrow(/Not enough mana/)
    expect(state.objects[tome]!.tapped).toBe(false) // cost not paid → not tapped
  })
})
