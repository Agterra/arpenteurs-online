/**
 * Perpetual card coverage — batch CARD62: Black Market Connections — a MODAL TRIGGER ("at the beginning of
 * your first main phase, choose one or more"), i.e. CARD40's multi-mode shape on a trigger instead of a
 * cast, with its own decision (r.chooseModes). Its Shapeshifter token has CHANGELING, so this batch also
 * makes "every creature type" real across every chosen-type check.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { currentPT } from '../../server/rules/characteristics.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const countOf = (s: St, p: PlayerId, name: string) => s.zones.perPlayer[p]!.battlefield.filter((id) => nameOf(s, id) === name).length
/** put it out, then reach the NEXT turn's first main phase so its trigger fires */
const untilItTriggers = (s: St, A: PlayerId) => {
  putCard(s, A, 'Black Market Connections', 'battlefield')
  until(s, (x) => x.pending?.kind === 'modes' && x.pending.player === A, 'the modal trigger')
}

describe('CARD62 — Black Market Connections', () => {
  it('asks for one or more modes at your first main phase', () => {
    const { state, A } = makeDuel()
    untilItTriggers(state, A)
    const legal = computeLegal(state, A)
    expect(legal.needsModes).toBe(true)
    expect(legal.modeOneOrMore).toBe(true)
    expect(legal.modeSourceName).toBe('Black Market Connections')
    expect(legal.modeLabels.length).toBe(3)
    expect(legal.modeLabels[0]).toMatch(/Sell Contraband/)
    expect(() => act(state, A, { type: 'r.chooseModes', modes: [] })).toThrow(/Choose 1 to 3 modes/)
    expect(() => act(state, A, { type: 'r.chooseModes', modes: [0, 0] })).toThrow(/only once/)
    expect(() => act(state, A, { type: 'r.chooseModes', modes: [5] })).toThrow(/valid mode/)
  })

  it('mode 0 makes a Treasure for 1 life', () => {
    const { state, A } = makeDuel()
    untilItTriggers(state, A)
    const life = state.players[A]!.life
    act(state, A, { type: 'r.chooseModes', modes: [0] })
    expect(countOf(state, A, 'Treasure')).toBe(1)
    expect(state.players[A]!.life).toBe(life - 1)
  })

  it('mode 1 draws for 2 life', () => {
    const { state, A } = makeDuel()
    untilItTriggers(state, A)
    const life = state.players[A]!.life
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.chooseModes', modes: [1] })
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 1)
    expect(state.players[A]!.life).toBe(life - 2)
  })

  it('mode 2 makes a 3/2 CHANGELING for 3 life', () => {
    const { state, A } = makeDuel()
    untilItTriggers(state, A)
    const life = state.players[A]!.life
    act(state, A, { type: 'r.chooseModes', modes: [2] })
    const token = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Shapeshifter')!
    expect(currentPT(state, state.objects[token]!)).toEqual({ power: 3, toughness: 2 })
    expect(getDef(state.objects[token]!.defName).keywords).toContain('changeling')
    expect(state.players[A]!.life).toBe(life - 3)
  })

  it('all three modes at once cost 6 life', () => {
    const { state, A } = makeDuel()
    untilItTriggers(state, A)
    const life = state.players[A]!.life
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.chooseModes', modes: [2, 0, 1] }) // picked out of order
    expect(state.players[A]!.life).toBe(life - 6)
    expect(countOf(state, A, 'Treasure')).toBe(1)
    expect(countOf(state, A, 'Shapeshifter')).toBe(1)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 1)
    // …and they resolved in PRINTED order
    const order = state.log.filter((l) => /Black Market Connections —/.test(l))
    expect(order[0]).toMatch(/Sell Contraband/)
    expect(order[2]).toMatch(/Hire a Mercenary/)
  })

  it('fires again on your next turn, and not on an opponent\'s', () => {
    const { state, A } = makeDuel()
    untilItTriggers(state, A)
    act(state, A, { type: 'r.chooseModes', modes: [0] })
    const turn = state.turnNumber
    // the opponent's first main phase asks nothing
    until(state, (s) => (s.activePlayer !== A && s.step === 'main1') || s.pending?.kind === 'modes', "the opponent's main phase")
    expect(state.pending?.kind).not.toBe('modes')
    until(state, (s) => s.pending?.kind === 'modes' && s.turnNumber > turn, "A's next first main phase")
    expect(state.pending!.player).toBe(A)
  })
})

describe('CARD62 — changeling counts as every creature type', () => {
  it("satisfies a chosen-type anthem and Cavern of Souls' restricted mana", () => {
    const { state, A } = makeDuel()
    // a Patchwork Banner set to Elf pumps a Shapeshifter token, which is every creature type
    const banner = putCard(state, A, 'Patchwork Banner', 'battlefield')
    state.objects[banner]!.chosenType = 'Elf'
    untilItTriggers(state, A)
    act(state, A, { type: 'r.chooseModes', modes: [2] })
    const token = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Shapeshifter')!
    expect(currentPT(state, state.objects[token]!)).toEqual({ power: 4, toughness: 3 }) // +1/+1 from the Banner
  })
})
