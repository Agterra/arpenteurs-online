/**
 * Coverage batch KW2: protection from [colour] (CR 702.16, the "DEBT" rule). A permanent with
 * protection from a colour can't be Damaged, Enchanted/Equipped, Blocked, or Targeted by
 * anything of that colour. White Knight (pro-black), Black Knight (pro-white), Paladin en-Vec
 * (pro-black+red), all first strike 2/2.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, ObjId, RulesGameState } from '../../shared/rules/types.ts'
import { getDef } from '../../server/rules/cards/registry.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')
const nameOf = (state: St, id: ObjId) => getDef(state.objects[id]!.defName).name
function blockPhase(state: St, A: string, B: string, attackerId: ObjId) {
  until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
  act(state, A, { type: 'r.attackers', attacks: [{ attackerId, defenderId: B }] })
  until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
  return (blockerId: ObjId) => act(state, B, { type: 'r.blockers', blocks: [{ blockerId, attackerId }] })
}

describe('protection — T (target)', () => {
  it('a black spell/aura cannot target a pro-black creature; a non-black source can', () => {
    const { state, A, B } = makeDuel()
    const wk = putCard(state, B, 'White Knight', 'battlefield') // protection from black
    const murder = putCard(state, A, 'Murder', 'hand') // {1}{B}{B} black
    const shock = putCard(state, A, 'Shock', 'hand') // {R} red
    const aura = putCard(state, A, 'Unholy Strength', 'hand') // {B} black Aura
    toStep(state, 'main1')
    addMana(state, A, 'B', 4)
    addMana(state, A, 'R', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: murder, targets: [wk] })).toThrow() // black → illegal
    expect(() => act(state, A, { type: 'r.cast', objId: aura, targets: [wk] })).toThrow() // black aura → illegal (E)
    expect(() => act(state, A, { type: 'r.cast', objId: shock, targets: [wk] })).not.toThrow() // red → legal
  })
})

describe('protection — B (block)', () => {
  it('a pro-white creature cannot be blocked by a white creature', () => {
    const { state, A, B } = makeDuel()
    const bk = putCard(state, A, 'Black Knight', 'battlefield') // protection from white
    const white = putCard(state, B, 'White Knight', 'battlefield') // white — illegal blocker
    const green = putCard(state, B, 'Grizzly Bears', 'battlefield') // green — legal blocker
    const block = blockPhase(state, A, B, bk)
    expect(() => block(white)).toThrow()
    expect(() => block(green)).not.toThrow()
  })
})

describe('protection — D (damage)', () => {
  it('mass damage from a red source does not touch a pro-red creature', () => {
    const { state, A, B } = makeDuel()
    const paladin = putCard(state, B, 'Paladin en-Vec', 'battlefield') // pro-black AND red, 2/2
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2, no protection
    const pyro = putCard(state, A, 'Pyroclasm', 'hand') // {1}{R} red — 2 damage to each creature
    toStep(state, 'main1')
    addMana(state, A, 'R', 2)
    act(state, A, { type: 'r.cast', objId: pyro, targets: [] })
    resolve(state, A)
    expect(state.objects[paladin]!.zone).toBe('battlefield') // protected from red → 0 damage
    expect(state.objects[paladin]!.damageMarked).toBe(0)
    expect(state.objects[bear]!.zone).toBe('graveyard') // 2 damage to a 2/2 → dies
  })
})

describe('protection — D also covers fight damage (review fix)', () => {
  it('a pro-red creature takes no fight damage from a red creature', () => {
    const { state, A, B } = makeDuel()
    const ogre = putCard(state, A, 'Hill Giant', 'battlefield') // red 3/3
    const paladin = putCard(state, B, 'Paladin en-Vec', 'battlefield') // pro-red 2/2
    const prey = putCard(state, A, 'Prey Upon', 'hand') // {G} — your creature fights an opponent's
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.cast', objId: prey, targets: [ogre, paladin] })
    resolve(state, A)
    expect(state.objects[paladin]!.zone).toBe('battlefield') // protected from red → 0 fight damage
    expect(state.objects[paladin]!.damageMarked).toBe(0)
    expect(state.objects[ogre]!.damageMarked).toBe(2) // Paladin (white) dealt its 2 — not prevented
  })
})

describe('protection — combat damage prevention', () => {
  it('a pro-red blocker takes no combat damage from a red attacker', () => {
    const { state, A, B } = makeDuel()
    const ogre = putCard(state, A, 'Hill Giant', 'battlefield') // red 3/3, no first strike
    const paladin = putCard(state, B, 'Paladin en-Vec', 'battlefield') // pro-red 2/2 first strike
    // Hill Giant attacks; Paladin blocks (protection doesn't stop a pro-creature from blocking)
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'attackers')
    act(state, A, { type: 'r.attackers', attacks: [{ attackerId: ogre, defenderId: B }] })
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: paladin, attackerId: ogre }] })
    resolve(state, B)
    // Paladin first-strikes Hill Giant (2 dmg, survives 3 toughness); Hill Giant's red damage to
    // Paladin is prevented → Paladin unscathed
    expect(state.objects[paladin]!.zone).toBe('battlefield')
    expect(state.objects[paladin]!.damageMarked).toBe(0)
  })
})
