/**
 * Coverage batch SUB2: GRANTED protection from [colour] (CR 613 layer 6 + 702.16). A spell can
 * grant protection-from-a-colour to a creature until end of turn; the grant is honored by the
 * same protectionColorsOf path as printed protection (target / block / damage / equip) and is
 * cleared at cleanup. Gods Willing {W} — "Target creature you control gains protection from the
 * colour of your choice until end of turn. Scry 1." modelled as 5 modes (one per colour).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')
// Gods Willing modes are ['W','U','B','R','G'] → protection-from-red is mode index 3.
const PRO_RED_MODE = 3

/** Resolve a Gods Willing cast: it grants protection (immediate) then leaves Scry 1 pending. */
function castGodsWilling(state: St, A: string, gw: string, target: string, mode: number) {
  act(state, A, { type: 'r.cast', objId: gw, targets: [target], mode })
  until(state, (s) => s.pendingScry?.player === A, 'Gods Willing scry')
  act(state, A, { type: 'r.scry', toBottom: [] })
  resolve(state, A)
}

describe('granted protection — T (target)', () => {
  it('a red spell cannot target a creature granted protection-from-red; it still can target an ungranted one', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // will be granted pro-red
    const bear2 = putCard(state, A, 'Grizzly Bears', 'battlefield') // control — no grant
    const gw = putCard(state, A, 'Gods Willing', 'hand')
    const shock1 = putCard(state, A, 'Shock', 'hand') // {R} red
    const shock2 = putCard(state, A, 'Shock', 'hand') // {R} red
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'R', 2)
    castGodsWilling(state, A, gw, bear, PRO_RED_MODE)
    expect(state.protectionGrants).toContainEqual({ objId: bear, color: 'R' })
    // red source → granted creature is an illegal target; the ungranted twin is fine
    expect(() => act(state, A, { type: 'r.cast', objId: shock1, targets: [bear] })).toThrow()
    expect(() => act(state, A, { type: 'r.cast', objId: shock2, targets: [bear2] })).not.toThrow()
  })

  it("cannot grant protection to an opponent's creature (Gods Willing targets a creature you control)", () => {
    const { state, A, B } = makeDuel()
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const gw = putCard(state, A, 'Gods Willing', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: gw, targets: [theirs], mode: PRO_RED_MODE })).toThrow()
  })
})

describe('granted protection — wears off at cleanup', () => {
  it('the grant is cleared end of turn, so a red spell can target the creature again next turn', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const gw = putCard(state, A, 'Gods Willing', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    castGodsWilling(state, A, gw, bear, PRO_RED_MODE)
    expect(state.protectionGrants.length).toBe(1)
    // run a full turn cycle back to A's next main phase — A's cleanup clears the grant
    until(
      state,
      (s) => s.turnNumber >= 3 && s.step === 'main1' && s.priorityPlayer === A && !s.zones.stack.length,
      "A's next turn",
    )
    expect(state.protectionGrants.length).toBe(0)
    const shock = putCard(state, A, 'Shock', 'hand')
    addMana(state, A, 'R', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: shock, targets: [bear] })).not.toThrow()
  })
})

describe('granted protection — D (damage) via the shared protectionColorsOf path', () => {
  it('mass damage from a red source does not touch a creature granted protection-from-red', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2, will gain pro-red
    const bear2 = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2, no protection
    const gw = putCard(state, A, 'Gods Willing', 'hand')
    const pyro = putCard(state, A, 'Pyroclasm', 'hand') // {1}{R} red — 2 damage to each creature
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'R', 2)
    castGodsWilling(state, A, gw, bear, PRO_RED_MODE)
    act(state, A, { type: 'r.cast', objId: pyro, targets: [] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('battlefield') // protected from red → 0 damage
    expect(state.objects[bear]!.damageMarked).toBe(0)
    expect(state.objects[bear2]!.zone).toBe('graveyard') // 2 damage to a 2/2 → dies
  })
})
