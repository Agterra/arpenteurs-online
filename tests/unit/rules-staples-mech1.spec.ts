/**
 * Coverage batch MECH1: SAGAS (CR 714). An Enchantment — Saga enters with one lore counter
 * (→ chapter I), gains another after each of the controller's draw steps (→ the next chapter),
 * and is sacrificed once its final chapter ability has left the stack. Card: Birth of Meletis
 * {1}{W} — (I) make a 0/4 Wall with defender, (II) gain 2 life, (III) tutor a basic land to hand.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, who: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === who, 'resolve')
const toAMain1 = (s: St, A: PlayerId, turn: number) =>
  until(s, (x) => x.turnNumber >= turn && x.activePlayer === A && x.step === 'main1' && x.priorityPlayer === A && !x.zones.stack.length, `A main1 t${turn}`)
const findByName = (s: St, controller: PlayerId, name: string) =>
  Object.values(s.objects).find((o) => o.controllerId === controller && o.zone === 'battlefield' && getDef(o.defName).name === name)

describe('sagas — chapters fire on lore-counter increments; the saga self-sacrifices after the last', () => {
  it('Birth of Meletis: I makes a Wall, II gains 2 life, III tutors, then it is sacrificed', () => {
    const { state, A } = makeDuel()
    const saga = putCard(state, A, 'Birth of Meletis', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 2) // {1}{W}
    act(state, A, { type: 'r.cast', objId: saga, targets: [] })
    resolve(state, A)

    // enters with one lore counter → chapter I resolved → a 0/4 Wall token exists
    expect(state.objects[saga]!.zone).toBe('battlefield')
    expect(state.objects[saga]!.counters.lore).toBe(1)
    const wall = findByName(state, A, 'Wall')
    expect(wall, 'Wall token from chapter I').toBeTruthy()
    expect(getDef(wall!.defName).toughness).toBe(4)

    // A's next turn: after the draw step, lore → 2 → chapter II gains 2 life
    const lifeBefore = state.players[A]!.life
    toAMain1(state, A, 3)
    expect(state.objects[saga]!.counters.lore).toBe(2)
    expect(state.players[A]!.life).toBe(lifeBefore + 2)
    expect(state.objects[saga]!.zone).toBe('battlefield') // not yet the final chapter

    // A's turn after: lore → 3 (final) → chapter III opens a library search. Reaching the third
    // chapter's resolution both opens the tutor AND satisfies the final-chapter sacrifice SBA
    // (CR 714.4) — the Saga is already in the graveyard (counters cleared on leaving play).
    until(state, (s) => s.pendingSearch?.player === A, 'chapter III search')
    expect(state.objects[saga]!.zone).toBe('graveyard')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.search', cardIds: [state.pendingSearch!.matchIds[0]!] }) // finish the tutor
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1) // basic land went to hand
  })
})
