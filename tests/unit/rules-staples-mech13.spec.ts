/**
 * Coverage batch MECH13: TRANSFORM DFC (CR 712). A double-faced card has two faces; transforming
 * swaps which face is "up". Modelled by swapping the object's defName between the two registered
 * faces, so every reader (P/T, keywords, combat, redaction) sees the current face. A DFC reverts to
 * its front face when it leaves the battlefield. Card: Delver of Secrets {U} 1/1 — at your upkeep,
 * look at the top card; if instant/sorcery, transform into Insectile Aberration 3/2 flying.
 */
import { describe, expect, it } from 'vitest'
import { makeDuel, putCard, until } from './rules-helpers.ts'
import { moveTo } from '../../server/rules/state.ts'
import { currentPower, currentKeywords } from '../../server/rules/characteristics.ts'
import { defKey, getDef } from '../../server/rules/cards/registry.ts'
import type { ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const putOnTop = (s: St, p: string, id: ObjId) => {
  const lib = s.zones.perPlayer[p]!.library
  const i = lib.indexOf(id)
  if (i >= 0) lib.splice(i, 1)
  lib.unshift(id)
}
// advance to A's next upkeep resolving (its Delver look has happened); A draws only AFTER upkeep,
// so a card placed on top now is what the turn-3 upkeep sees.
const toATurn3Main = (s: St, A: PlayerId) =>
  until(s, (x) => x.turnNumber >= 3 && x.activePlayer === A && x.step === 'main1' && x.priorityPlayer === A && !x.zones.stack.length, 'A turn 3 main1')

describe('transform DFC — Delver of Secrets', () => {
  it('transforms into Insectile Aberration (3/2 flying) when the top card is an instant', () => {
    const { state, A } = makeDuel()
    const delver = putCard(state, A, 'Delver of Secrets', 'battlefield')
    putOnTop(state, A, putCard(state, A, 'Shock', 'library')) // instant on top for the upkeep look
    toATurn3Main(state, A)
    expect(state.objects[delver]!.defName).toBe(defKey('Insectile Aberration'))
    expect(currentPower(state, state.objects[delver]!)).toBe(3)
    expect(currentKeywords(state, state.objects[delver]!)).toContain('flying')

    // leaving the battlefield reverts it to the front face (CR 712.13)
    moveTo(state, delver, 'hand')
    expect(state.objects[delver]!.defName).toBe(defKey('Delver of Secrets'))
  })

  it('stays Delver (1/1) when the top card is not an instant/sorcery', () => {
    const { state, A } = makeDuel()
    const delver = putCard(state, A, 'Delver of Secrets', 'battlefield')
    putOnTop(state, A, putCard(state, A, 'Mountain', 'library')) // a land on top
    toATurn3Main(state, A)
    expect(state.objects[delver]!.defName).toBe(defKey('Delver of Secrets'))
    expect(currentPower(state, state.objects[delver]!)).toBe(1)
  })
})
