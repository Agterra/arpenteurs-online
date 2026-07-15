/**
 * Coverage batch KW5: exalted (CR 702.90), flanking (CR 702.25), battle cry (CR 702.91) — combat
 * triggered pumps applied at declaration in r.attackers / r.blockers.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, until } from './rules-helpers.ts'
import type { ObjId, RulesGameState } from '../../shared/rules/types.ts'
import { currentPower, currentToughness } from '../../server/rules/characteristics.ts'

type St = RulesGameState
const power = (state: St, id: ObjId) => currentPower(state, state.objects[id]!)
function declareAttack(state: St, A: string, attacks: { attackerId: ObjId; defenderId: string }[]) {
  until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
  act(state, A, { type: 'r.attackers', attacks })
}

describe('exalted — a creature attacking ALONE gets +1/+1 per exalted source', () => {
  it('pumps a lone attacker but not when attacking with others', () => {
    const { state, A, B } = makeDuel()
    const knight = putCard(state, A, 'Knight of Glory', 'battlefield') // 2/1 exalted
    declareAttack(state, A, [{ attackerId: knight, defenderId: B }])
    expect(power(state, knight)).toBe(3) // 2 + exalted
  })
  it('does not trigger when attacking with a second creature', () => {
    const { state, A, B } = makeDuel()
    const knight = putCard(state, A, 'Knight of Glory', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    declareAttack(state, A, [{ attackerId: knight, defenderId: B }, { attackerId: bear, defenderId: B }])
    expect(power(state, knight)).toBe(2) // attacked with company → no exalted
  })
  it('stacks with multiple exalted sources', () => {
    const { state, A, B } = makeDuel()
    const k1 = putCard(state, A, 'Knight of Glory', 'battlefield')
    putCard(state, A, 'Knight of Glory', 'battlefield') // a second exalted source
    declareAttack(state, A, [{ attackerId: k1, defenderId: B }])
    expect(power(state, k1)).toBe(4) // 2 + two exalted
  })
})

describe('battle cry — each OTHER attacker gets +1/+0', () => {
  it('pumps the other attackers, not the crier itself', () => {
    const { state, A, B } = makeDuel()
    const paladin = putCard(state, A, 'Accorder Paladin', 'battlefield') // 3/1 battle cry
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2
    declareAttack(state, A, [{ attackerId: paladin, defenderId: B }, { attackerId: bear, defenderId: B }])
    expect(power(state, bear)).toBe(3) // +1/+0
    expect(power(state, paladin)).toBe(3) // crier unchanged
  })
})

describe('flanking — a non-flanking blocker gets -1/-1', () => {
  it('shrinks a blocker (kills a 1-toughness one)', () => {
    const { state, A, B } = makeDuel()
    const cavalry = putCard(state, A, 'Benalish Cavalry', 'battlefield') // 2/2 flanking
    const chump = putCard(state, B, 'Prickly Boggart', 'battlefield') // 1/1, no flanking
    declareAttack(state, A, [{ attackerId: cavalry, defenderId: B }])
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: chump, attackerId: cavalry }] })
    expect(state.objects[chump]!.zone).toBe('graveyard') // -1/-1 → 0/0 → dies before combat
  })
  it('a flanking blocker is unaffected', () => {
    const { state, A, B } = makeDuel()
    const cavalry = putCard(state, A, 'Benalish Cavalry', 'battlefield') // flanking
    const otherCav = putCard(state, B, 'Benalish Cavalry', 'battlefield') // 2/2 flanking blocker
    declareAttack(state, A, [{ attackerId: cavalry, defenderId: B }])
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: otherCav, attackerId: cavalry }] })
    expect(state.objects[otherCav]!.zone).toBe('battlefield')
    expect(currentToughness(state, state.objects[otherCav]!)).toBe(2) // no flanking penalty
  })
})
