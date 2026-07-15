/**
 * Coverage batch WARD: ward (CR 702.21). When a spell/ability an OPPONENT controls targets
 * a permanent with ward, a ward trigger goes on the stack; on resolution its controller must
 * pay the ward cost or the spell/ability is countered. Implemented as a `pending: 'ward'`
 * decision + `r.ward {pay}`. Warded creature: Tomakul Honor Guard {1}{G} 3/1 Ward {2}.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'
import { currentPower } from '../../server/rules/characteristics.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')

/** Cast Shock at B's warded creature and pass to the point the ward trigger resolves. */
function castShockAtWard(state: St, A: string, B: string, extraMana: number) {
  const warded = putCard(state, B, 'Tomakul Honor Guard', 'battlefield') // 3/1 Ward {2}
  const shock = putCard(state, A, 'Shock', 'hand')
  toStep(state, 'main1')
  addMana(state, A, 'R', 1 + extraMana)
  act(state, A, { type: 'r.cast', objId: shock, targets: [warded] })
  pass(state, A)
  pass(state, B)
  return { warded, shock }
}

describe('ward — pay or the spell is countered', () => {
  it('paid: the ward cost is spent and the spell resolves', () => {
    const { state, A, B } = makeDuel()
    const { warded } = castShockAtWard(state, A, B, 2) // 2 extra for the {2} ward
    expect(state.pending?.kind).toBe('ward')
    expect(state.pending?.player).toBe(A)
    act(state, A, { type: 'r.ward', pay: true })
    resolve(state, A)
    expect(state.players[A]!.manaPool.R).toBe(0) // {R} Shock + {2} ward all spent
    expect(state.objects[warded]!.zone).toBe('graveyard') // Shock resolved → 3/1 dies
  })

  it('declined: the spell is countered and the creature survives', () => {
    const { state, A, B } = makeDuel()
    const { warded, shock } = castShockAtWard(state, A, B, 2)
    expect(state.pending?.kind).toBe('ward')
    act(state, A, { type: 'r.ward', pay: false })
    resolve(state, A)
    expect(state.objects[warded]!.zone).toBe('battlefield') // Shock countered
    expect(state.objects[shock]!.zone).toBe('graveyard') // countered spell → its owner's graveyard
  })

  it("can't afford the ward (pay requested but no mana) → the spell is countered", () => {
    const { state, A, B } = makeDuel()
    const { warded, shock } = castShockAtWard(state, A, B, 0) // only {R} for Shock, nothing for ward
    expect(state.pending?.kind).toBe('ward')
    act(state, A, { type: 'r.ward', pay: true }) // requested pay, but pool can't cover {2}
    resolve(state, A)
    expect(state.objects[warded]!.zone).toBe('battlefield')
    expect(state.objects[shock]!.zone).toBe('graveyard')
  })
})

describe('ward — only triggers for an opponent', () => {
  it('does not trigger when you target your OWN warded creature', () => {
    const { state, A } = makeDuel()
    const mine = putCard(state, A, 'Tomakul Honor Guard', 'battlefield')
    const gg = putCard(state, A, 'Giant Growth', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.cast', objId: gg, targets: [mine] })
    // no ward pending — resolve() would throw if a ward trigger had stalled the loop
    resolve(state, A)
    expect(currentPower(state, state.objects[mine]!)).toBe(6) // 3 + Giant Growth's +3
  })
})

// Review finding (fixed): ward must also fire against a targeted TRIGGERED ability an
// opponent controls (CR 702.21a: "spell OR ability"). queueWardTriggers was wired only to
// r.cast/r.activate; a targeted trigger reaches the stack via r.chooseTargets, which was
// skipping ward — so an ETB removal (Ravenous Chupacabra / Flametongue Kavu) silently
// bypassed ward. Now r.chooseTargets (and r.loyalty) queue ward too.
describe('ward triggers on a targeted TRIGGERED ability (review fix)', () => {
  /** A casts Ravenous Chupacabra; its ETB targets B's warded creature; advance to the ward decision. */
  function chupacabraAtWardedCreature(state: St, A: string, B: string) {
    const warded = putCard(state, B, 'Tomakul Honor Guard', 'battlefield') // 3/1 Ward {2}
    const chup = putCard(state, A, 'Ravenous Chupacabra', 'hand') // {2}{B}{B}, ETB destroy an opponent's creature
    toStep(state, 'main1')
    addMana(state, A, 'B', 6) // {2}{B}{B} Chupacabra (4) + {2} ward (2)
    act(state, A, { type: 'r.cast', objId: chup, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'Chupacabra ETB target choice')
    act(state, A, { type: 'r.chooseTargets', targets: [warded] })
    pass(state, A) // pass priority → the ward trigger (now on top) resolves
    pass(state, B)
    return warded
  }

  it("fires ward when an opponent's ETB removal targets the warded creature", () => {
    const { state, A, B } = makeDuel()
    const warded = chupacabraAtWardedCreature(state, A, B)
    expect(state.pending?.kind).toBe('ward')
    expect(state.pending?.player).toBe(A)
    // decline → the ETB ability is countered, the warded creature survives
    act(state, A, { type: 'r.ward', pay: false })
    resolve(state, A)
    expect(state.objects[warded]!.zone).toBe('battlefield')
  })

  it('paying the ward lets the ETB ability resolve (creature destroyed)', () => {
    const { state, A, B } = makeDuel()
    const warded = chupacabraAtWardedCreature(state, A, B)
    expect(state.pending?.kind).toBe('ward')
    act(state, A, { type: 'r.ward', pay: true })
    resolve(state, A)
    expect(state.objects[warded]!.zone).toBe('graveyard')
  })
})

describe('ward — redaction prompt is actor-only', () => {
  it('the payer sees the ward prompt; the opponent does not', () => {
    const { state, A, B } = makeDuel()
    castShockAtWard(state, A, B, 2)
    expect(state.pending?.kind).toBe('ward')
    const aView = redactRulesState(state, A)
    expect(aView.legal.needsWard).toBe(true)
    expect(aView.legal.wardCost).toBe('{2}')
    expect(aView.legal.wardAffordable).toBe(true)
    expect(redactRulesState(state, B).legal.needsWard).toBe(false)
  })
})
