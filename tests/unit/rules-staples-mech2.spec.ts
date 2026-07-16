/**
 * Coverage batch MECH2: ADVENTURE (CR 715). An adventurer card may be cast as its instant/sorcery
 * "adventure"; when that resolves the card is EXILED (not put in the graveyard) and its owner may
 * afterwards cast the creature from exile. Card: Murderous Rider {1}{B}{B} 2/3 lifelink // Swift
 * End {1}{B}{B} instant — destroy target creature, you lose 2 life.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { defIsCreature } from '../../server/rules/cards/dsl.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, who: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === who, 'resolve')

describe('adventure — cast the adventure, it exiles the card, then cast the creature from exile', () => {
  it('Swift End destroys a creature + you lose 2 life; Murderous Rider is then cast from exile', () => {
    const { state, A, B } = makeDuel()
    const rider = putCard(state, A, 'Murderous Rider', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield') // Swift End's victim
    toStep(state, 'main1')

    // cast the ADVENTURE half (Swift End) at B's bear
    addMana(state, A, 'B', 3) // {1}{B}{B}
    act(state, A, { type: 'r.cast', objId: rider, adventure: true, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard') // destroyed
    expect(state.players[A]!.life).toBe(38) // lost 2
    // the card is exiled "on an adventure", castable as the creature later (CR 715.3d)
    expect(state.objects[rider]!.zone).toBe('exile')
    expect(state.objects[rider]!.adventured).toBe(true)

    // now cast the CREATURE side from exile
    addMana(state, A, 'B', 3) // {1}{B}{B} again
    act(state, A, { type: 'r.cast', objId: rider, targets: [] })
    resolve(state, A)
    expect(state.objects[rider]!.zone).toBe('battlefield')
    expect(defIsCreature(getDef(state.objects[rider]!.defName))).toBe(true)
    expect(state.objects[rider]!.adventured).toBeFalsy()
  })

  it('the creature side cannot be cast from the hand as an adventure without an adventure flag mismatch, and vice-versa', () => {
    const { state, A, B } = makeDuel()
    const rider = putCard(state, A, 'Murderous Rider', 'hand')
    putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 3)
    // casting the adventure REQUIRES a legal target (Swift End targets a creature); with none chosen it errors
    expect(() => act(state, A, { type: 'r.cast', objId: rider, adventure: true, targets: [] })).toThrow()
  })
})
