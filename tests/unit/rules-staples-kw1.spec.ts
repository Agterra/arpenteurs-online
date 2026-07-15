/**
 * Coverage batch KW1: evasion keywords (block restrictions, CR 509.1b / 702). A attacks B with
 * a creature carrying an evasion keyword; B's block is accepted or rejected accordingly. All
 * server-enforced in r.blockers via the centralized blockRestriction helper (no hidden-info
 * surface, so no fuzzer change).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, until } from './rules-helpers.ts'
import type { ObjId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
/** A attacks B with `attackerId`; drive to B's blocker declaration. Returns a block() tester. */
function blockPhase(state: St, A: string, B: string, attackerId: ObjId) {
  until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
  act(state, A, { type: 'r.attackers', attacks: [{ attackerId, defenderId: B }] })
  until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
  return (blockerId: ObjId) => act(state, B, { type: 'r.blockers', blocks: [{ blockerId, attackerId }] })
}

describe('KW1 evasion — block restrictions', () => {
  it('fear: only black/artifact creatures may block', () => {
    const { state, A, B } = makeDuel()
    const attacker = putCard(state, A, 'Prickly Boggart', 'battlefield') // {B} 1/1 fear
    const green = putCard(state, B, 'Grizzly Bears', 'battlefield') // green — illegal
    const black = putCard(state, B, 'Vampire Nighthawk', 'battlefield') // black — legal
    const block = blockPhase(state, A, B, attacker)
    expect(() => block(green)).toThrow()
    expect(() => block(black)).not.toThrow()
  })

  it('intimidate: only artifact creatures or ones sharing a colour may block', () => {
    const { state, A, B } = makeDuel()
    const attacker = putCard(state, A, "Krenko's Enforcer", 'battlefield') // {1}{R}{R} 2/2 intimidate (red)
    const green = putCard(state, B, 'Grizzly Bears', 'battlefield') // no shared colour — illegal
    const red = putCard(state, B, 'Gray Ogre', 'battlefield') // shares red — legal
    const block = blockPhase(state, A, B, attacker)
    expect(() => block(green)).toThrow()
    expect(() => block(red)).not.toThrow()
  })

  it('skulk: cannot be blocked by a creature with greater power', () => {
    const { state, A, B } = makeDuel()
    const attacker = putCard(state, A, 'Vampire Cutthroat', 'battlefield') // 1/1 skulk
    const bigger = putCard(state, B, 'Grizzly Bears', 'battlefield') // power 2 > 1 — illegal
    const equal = putCard(state, B, 'Prickly Boggart', 'battlefield') // power 1 ≤ 1 — legal
    const block = blockPhase(state, A, B, attacker)
    expect(() => block(bigger)).toThrow()
    expect(() => block(equal)).not.toThrow()
  })

  it('shadow: only shadow creatures may block a shadow attacker (and vice-versa)', () => {
    const { state, A, B } = makeDuel()
    const attacker = putCard(state, A, 'Soltari Foot Soldier', 'battlefield') // 1/1 shadow
    const normal = putCard(state, B, 'Grizzly Bears', 'battlefield') // no shadow — illegal
    const shadow = putCard(state, B, 'Soltari Foot Soldier', 'battlefield') // shadow — legal
    const block = blockPhase(state, A, B, attacker)
    expect(() => block(normal)).toThrow()
    expect(() => block(shadow)).not.toThrow()
  })

  it('islandwalk: unblockable while the defender controls an Island', () => {
    const { state, A, B } = makeDuel()
    const attacker = putCard(state, A, 'Pale Bears', 'battlefield') // islandwalk
    const blocker = putCard(state, B, 'Grizzly Bears', 'battlefield')
    putCard(state, B, 'Island', 'battlefield') // defender controls an Island → unblockable
    const block = blockPhase(state, A, B, attacker)
    expect(() => block(blocker)).toThrow()
  })

  it('swampwalk: blockable when the defender controls no Swamp', () => {
    const { state, A, B } = makeDuel()
    const attacker = putCard(state, A, 'Marsh Boa', 'battlefield') // swampwalk
    const blocker = putCard(state, B, 'Grizzly Bears', 'battlefield')
    // B controls no Swamp → swampwalk does not apply, the block is legal
    const block = blockPhase(state, A, B, attacker)
    expect(() => block(blocker)).not.toThrow()
  })
})
