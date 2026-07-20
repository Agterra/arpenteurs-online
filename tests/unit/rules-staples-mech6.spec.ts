/**
 * Coverage batch MECH6: SPLIT cards (CR 709). One card, two instant/sorcery halves each with its
 * own name / type / mana cost; the caster picks a half at cast time (mode 0 = left, 1 = right) and
 * the card goes to the graveyard on resolution. Card: Assault {R} (2 damage to any target) //
 * Battery {3}{G} (make a 3/3 Elephant).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, who: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === who, 'resolve')

describe('split cards — cast either half', () => {
  it('Assault (left, {R}) deals 2 to a player, then goes to the graveyard', () => {
    const { state, A, B } = makeDuel()
    const card = putCard(state, A, 'Assault // Battery', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: card, mode: 0, targets: [B] })
    resolve(state, A)
    expect(state.players[B]!.life).toBe(38)
    expect(state.objects[card]!.zone).toBe('graveyard')
  })

  it('Battery (right, {3}{G}) makes a 3/3 Elephant, then goes to the graveyard', () => {
    const { state, A } = makeDuel()
    const card = putCard(state, A, 'Assault // Battery', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 4)
    act(state, A, { type: 'r.cast', objId: card, mode: 1, targets: [] })
    resolve(state, A)
    const elephant = Object.values(state.objects).find(
      (o) => o.controllerId === A && o.zone === 'battlefield' && getDef(o.defName).name === 'Elephant',
    )
    expect(elephant, '3/3 Elephant from Battery').toBeTruthy()
    expect(getDef(elephant!.defName).power).toBe(3)
    expect(state.objects[card]!.zone).toBe('graveyard')
  })

  it('a split card requires choosing a half', () => {
    const { state, A, B } = makeDuel()
    const card = putCard(state, A, 'Assault // Battery', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: card, targets: [B] })).toThrow() // no mode
  })
})
