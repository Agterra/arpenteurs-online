import { describe, expect, it, beforeAll } from 'vitest'
import { act, makeDuel, putCard, until } from './rules-helpers.ts'
import type { ObjId, RulesGameState } from '../../shared/rules/types.ts'
import { checkSBA } from '../../server/rules/engine.ts'
import { registerSet } from '../../server/rules/cards/registry.ts'

type St = RulesGameState

beforeAll(() => {
  registerSet([
    { name: 'Probe LifeInfect', types: ['Creature'], subtypes: ['Elf'], manaCost: '{G}', colors: ['G'], power: 3, toughness: 3, keywords: ['lifelink', 'infect'] },
    { name: 'Probe DeathInfect', types: ['Creature'], subtypes: ['Elf'], manaCost: '{G}', colors: ['G'], power: 1, toughness: 1, keywords: ['deathtouch', 'infect'] },
    { name: 'Probe TrampInfect', types: ['Creature'], subtypes: ['Elf'], manaCost: '{G}', colors: ['G'], power: 5, toughness: 5, keywords: ['trample', 'infect'] },
    { name: 'Probe FSInfect', types: ['Creature'], subtypes: ['Elf'], manaCost: '{G}', colors: ['G'], power: 2, toughness: 2, keywords: ['first strike', 'infect'] },
  ] as any)
})

function attack1(state: St, A: string, B: string, attackerId: ObjId) {
  until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
  act(state, A, { type: 'r.attackers', attacks: [{ attackerId, defenderId: B }] })
}

function ready(state: St, id: ObjId) {
  const o = state.objects[id]!
  o.summoningSick = false
  o.tapped = false
}

describe('probe: commander with infect', () => {
  it('deals poison only — no life loss, no commander damage', () => {
    const { state, A, B } = makeDuel()
    const cmd = putCard(state, A, 'Glistener Elf', 'battlefield')
    state.objects[cmd]!.isCommander = true
    ready(state, cmd)
    const life0 = state.players[B]!.life
    attack1(state, A, B, cmd)
    until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat')
    expect(state.players[B]!.poison).toBe(1)
    expect(state.players[B]!.life).toBe(life0)
    expect(Object.values(state.players[B]!.commanderDamage).some((d) => d > 0)).toBe(false)
  })
})

describe('probe: lifelink + infect to a player', () => {
  it('controller gains life; victim gets poison (not life)', () => {
    const { state, A, B } = makeDuel()
    const c = putCard(state, A, 'Probe LifeInfect', 'battlefield')
    ready(state, c)
    const lifeA0 = state.players[A]!.life
    const lifeB0 = state.players[B]!.life
    attack1(state, A, B, c)
    until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat')
    expect(state.players[B]!.poison).toBe(3)
    expect(state.players[B]!.life).toBe(lifeB0)
    expect(state.players[A]!.life).toBe(lifeA0 + 3) // lifelink still gains
  })
})

describe('probe: deathtouch + infect to a creature', () => {
  it('blocker gets a -1/-1 counter AND dies (deathtouch)', () => {
    const { state, A, B } = makeDuel()
    const c = putCard(state, A, 'Probe DeathInfect', 'battlefield') // 1/1 dt+infect
    ready(state, c)
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2
    attack1(state, A, B, c)
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bear, attackerId: c }] })
    until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat')
    expect(state.objects[bear]!.zone).toBe('graveyard') // deathtouch kills it
  })
})

describe('probe: infect -1/-1 annihilates +1/+1 via SBA', () => {
  it('a +1/+1 creature taking 1 infect nets zero counters and survives', () => {
    const { state, A, B } = makeDuel()
    const c = putCard(state, A, 'Glistener Elf', 'battlefield') // 1/1 infect
    ready(state, c)
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2
    state.objects[bear]!.counters['+1/+1'] = 1 // now 3/3
    attack1(state, A, B, c)
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bear, attackerId: c }] })
    until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat')
    expect(state.objects[bear]!.zone).toBe('battlefield')
    expect(state.objects[bear]!.counters['+1/+1'] ?? 0).toBe(0)
    expect(state.objects[bear]!.counters['-1/-1'] ?? 0).toBe(0)
  })
})

describe('probe: trample + infect', () => {
  it('assigns lethal counters to blocker, tramples the rest as poison', () => {
    const { state, A, B } = makeDuel()
    const c = putCard(state, A, 'Probe TrampInfect', 'battlefield') // 5/5 trample+infect
    ready(state, c)
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2
    const life0 = state.players[B]!.life
    attack1(state, A, B, c)
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bear, attackerId: c }] })
    until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat')
    expect(state.objects[bear]!.zone).toBe('graveyard') // 2 -1/-1 => 0 toughness
    expect(state.players[B]!.poison).toBe(3) // 5 - 2 lethal trampled
    expect(state.players[B]!.life).toBe(life0)
  })
})

describe('probe: first strike + infect', () => {
  it('poisons via first-strike sub-step', () => {
    const { state, A, B } = makeDuel()
    const c = putCard(state, A, 'Probe FSInfect', 'battlefield')
    ready(state, c)
    attack1(state, A, B, c)
    until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat')
    expect(state.players[B]!.poison).toBe(2)
  })
})

describe('probe: non-infect regression control', () => {
  it('a vanilla attacker still deals life damage, not poison', () => {
    const { state, A, B } = makeDuel()
    const c = putCard(state, A, 'Grizzly Bears', 'battlefield')
    ready(state, c)
    const life0 = state.players[B]!.life
    attack1(state, A, B, c)
    until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat')
    expect(state.players[B]!.life).toBe(life0 - 2)
    expect(state.players[B]!.poison).toBe(0)
  })
})
