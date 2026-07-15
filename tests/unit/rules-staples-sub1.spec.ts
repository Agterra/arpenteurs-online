/**
 * Coverage batch SUB1: infect (CR 702.90) + the poison subsystem. Infect deals damage to players
 * as poison counters (not life) and to creatures as -1/-1 counters (not marked damage); a player
 * with 10+ poison loses. Wither shares the creature-branch (damage as -1/-1 counters), exercised
 * by the infect-to-creature test.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, until } from './rules-helpers.ts'
import type { ObjId, RulesGameState } from '../../shared/rules/types.ts'
import { checkSBA } from '../../server/rules/engine.ts'

type St = RulesGameState
function attack(state: St, A: string, B: string, attackerId: ObjId) {
  until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
  act(state, A, { type: 'r.attackers', attacks: [{ attackerId, defenderId: B }] })
}

describe('infect — damage to players is poison, not life', () => {
  it('an unblocked infect creature gives poison counters (life unchanged)', () => {
    const { state, A, B } = makeDuel()
    const elf = putCard(state, A, 'Glistener Elf', 'battlefield') // 1/1 infect
    const life0 = state.players[B]!.life
    attack(state, A, B, elf)
    until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat')
    expect(state.players[B]!.poison).toBe(1)
    expect(state.players[B]!.life).toBe(life0) // no life loss
  })
})

describe('infect/wither — damage to creatures is -1/-1 counters', () => {
  it('an infect attacker marks -1/-1 counters on its blocker instead of damage', () => {
    const { state, A, B } = makeDuel()
    const elf = putCard(state, A, 'Glistener Elf', 'battlefield') // 1/1 infect
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2
    attack(state, A, B, elf)
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bear, attackerId: elf }] })
    until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat')
    expect(state.objects[bear]!.zone).toBe('battlefield')
    expect(state.objects[bear]!.counters['-1/-1']).toBe(1) // infect → -1/-1 counter, not marked damage
  })
})

describe('poison — a player with 10+ poison loses', () => {
  it('loses the game as a state-based action', () => {
    const { state, B } = makeDuel()
    state.players[B]!.poison = 10
    checkSBA(state)
    expect(state.players[B]!.hasLost).toBe(true)
  })
})
