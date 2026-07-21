/**
 * Perpetual card coverage — batch CARD6: land tutors (Farseek, Nature's Lore, Three Visits) and
 * any-colour mana rocks (Arcane Signet, Fellwar Stone).
 * Land tutors exercise the new subtype-based library search filter ({ landSubtypes }).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { defIsLand } from '../../server/rules/cards/dsl.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const landsOf = (s: St, p: PlayerId) =>
  Object.values(s.objects).filter((o) => o.controllerId === p && o.zone === 'battlefield' && defIsLand(getDef(o.defName)))

describe('CARD6 — land tutors', () => {
  it('Farseek fetches a Plains/Island/Swamp/Mountain onto the battlefield tapped', () => {
    const { state, A } = makeDuel()
    const mtn = putCard(state, A, 'Mountain', 'library') // Mountain-typed, matches Farseek
    const fs = putCard(state, A, 'Farseek', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: fs, targets: [] })
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, "A's land search")
    expect(state.pendingSearch!.matchIds).toContain(mtn)
    act(state, A, { type: 'r.search', cardIds: [mtn] })
    resolve(state, A)
    const onField = landsOf(state, A)
    expect(onField.length).toBe(1)
    expect(getDef(onField[0]!.defName).name).toBe('Mountain')
    expect(onField[0]!.tapped).toBe(true)
  })

  it('a Forest will not satisfy Farseek (subtype filter excludes it)', () => {
    const { state, A } = makeDuel()
    const forest = putCard(state, A, 'Forest', 'library')
    const fs = putCard(state, A, 'Farseek', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: fs, targets: [] })
    // if there are no Plains/Island/Swamp/Mountain lands the spell simply finds nothing (no pause);
    // the added Forest must NOT be among any matches
    if (state.pending?.kind === 'search') expect(state.pendingSearch!.matchIds).not.toContain(forest)
  })
})

describe.each(["Nature's Lore", 'Three Visits'])('CARD6 — %s (Forest tutor, untapped)', (cardName) => {
  it('fetches a Forest onto the battlefield untapped', () => {
    const { state, A } = makeDuel()
    const forest = putCard(state, A, 'Forest', 'library')
    const spell = putCard(state, A, cardName, 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: spell, targets: [] })
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, "A's land search")
    expect(state.pendingSearch!.matchIds).toContain(forest)
    act(state, A, { type: 'r.search', cardIds: [forest] })
    resolve(state, A)
    const onField = landsOf(state, A)
    expect(onField.length).toBe(1)
    expect(getDef(onField[0]!.defName).name).toBe('Forest')
    expect(onField[0]!.tapped).toBe(false) // untapped, unlike Cultivate/Farseek
  })
})

describe.each(['Arcane Signet', 'Fellwar Stone'])('CARD6 — %s (any-colour rock)', (rockName) => {
  it('taps for one mana of a chosen colour', () => {
    const { state, A } = makeDuel()
    const rock = putCard(state, A, rockName, 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: rock, color: 'U' })
    expect(state.objects[rock]!.tapped).toBe(true)
    expect(state.players[A]!.manaPool.U).toBe(1)
  })
})
