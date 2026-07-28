/**
 * Perpetual card coverage — batch CARD18: Toxic Deluge (X paid in LIFE as an additional cost) and
 * Smothering Tithe (a DRAW trigger reusing the CARD16 "unless that player pays" decision).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const treasuresOf = (s: St, p: PlayerId) =>
  s.zones.perPlayer[p]!.battlefield.filter((id) => getDef(s.objects[id]!.defName).name === 'Treasure')

describe('CARD18 — Toxic Deluge', () => {
  const cast = (s: St, A: PlayerId, x: number) => {
    const deluge = s.zones.perPlayer[A]!.hand.find((id) => s.objects[id]!.defName.includes('toxic')) ?? putCard(s, A, 'Toxic Deluge', 'hand')
    addMana(s, A, 'B', 1)
    addMana(s, A, 'C', 2)
    act(s, A, { type: 'r.cast', objId: deluge, targets: [], x })
    return deluge
  }

  it('pays X life and gives every creature -X/-X (killing the small ones)', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Toxic Deluge', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2 → dies at X=2
    const giant = putCard(state, B, 'Hill Giant', 'battlefield') // 3/3 → survives at X=2
    toStep(state, 'main1')
    const life = state.players[A]!.life
    cast(state, A, 2)
    resolve(state, A)
    expect(state.players[A]!.life).toBe(life - 2) // the additional cost is LIFE, not mana
    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(state.objects[giant]!.zone).toBe('battlefield')
  })

  it('X = 0 is legal and costs nothing', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Toxic Deluge', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    cast(state, A, 0)
    resolve(state, A)
    expect(state.players[A]!.life).toBe(life)
    expect(state.objects[bear]!.zone).toBe('battlefield')
  })

  it('X above your life total is rejected, mutating nothing', () => {
    const { state, A } = makeDuel()
    const deluge = putCard(state, A, 'Toxic Deluge', 'hand')
    toStep(state, 'main1')
    state.players[A]!.life = 3
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 2)
    expect(() => act(state, A, { type: 'r.cast', objId: deluge, targets: [], x: 4 })).toThrow(/Not enough life/)
    expect(state.objects[deluge]!.zone).toBe('hand')
    expect(state.players[A]!.life).toBe(3)
    expect(state.players[A]!.manaPool.B).toBe(1) // mana untouched too
  })

  it('X is required (the server refuses a cast without it)', () => {
    const { state, A } = makeDuel()
    const deluge = putCard(state, A, 'Toxic Deluge', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 2)
    expect(() => act(state, A, { type: 'r.cast', objId: deluge, targets: [] })).toThrow(/NEEDS_X|Choose how much life/i)
  })

  it('X does NOT inflate the mana cost ({2}{B} is enough for any X)', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Toxic Deluge', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    cast(state, A, 6) // exactly {2}{B} floated, X = 6
    resolve(state, A)
    expect(state.players[A]!.life).toBe(34)
    expect(state.objects[bear]!.zone).toBe('graveyard')
  })
})

describe('CARD18 — Smothering Tithe', () => {
  it("an opponent's draw opens the tax on them; declining makes YOU a Treasure", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Smothering Tithe', 'battlefield')
    toStep(state, 'main1')
    // B draws by hand (an assisted-table draw is still a draw)
    act(state, B, { type: 'r.mDraw', n: 1 })
    until(state, (s) => s.pending?.kind === 'optionalPay', 'the tithe decision')
    expect(state.pending?.player).toBe(B)
    expect(computeLegal(state, B).optionalPayCost).toBe('{2}')
    act(state, B, { type: 'r.optionalPay', pay: false })
    expect(treasuresOf(state, A).length).toBe(1)
    expect(treasuresOf(state, B).length).toBe(0)
  })

  it('paying {2} stops the Treasure', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Smothering Tithe', 'battlefield')
    toStep(state, 'main1')
    act(state, B, { type: 'r.mDraw', n: 1 })
    until(state, (s) => s.pending?.kind === 'optionalPay', 'the tithe decision')
    addMana(state, B, 'C', 2) // float it now: passing priority to resolve the trigger empties pools
    act(state, B, { type: 'r.optionalPay', pay: true })
    expect(state.players[B]!.manaPool.C).toBe(0)
    expect(treasuresOf(state, A).length).toBe(0)
  })

  it('fires once per card drawn', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Smothering Tithe', 'battlefield')
    toStep(state, 'main1')
    act(state, B, { type: 'r.mDraw', n: 3 })
    for (let i = 0; i < 3; i++) {
      until(state, (s) => s.pending?.kind === 'optionalPay', `tithe decision ${i + 1}`)
      act(state, B, { type: 'r.optionalPay', pay: false })
    }
    expect(treasuresOf(state, A).length).toBe(3)
  })

  it("does not trigger on its controller's own draws", () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Smothering Tithe', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.mDraw', n: 2 })
    until(state, (s) => !s.zones.stack.length || s.pending?.kind === 'optionalPay', 'the stack settles')
    expect(state.pending).toBeFalsy()
    expect(treasuresOf(state, A).length).toBe(0)
  })

  it("fires on the opponent's DRAW STEP too", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Smothering Tithe', 'battlefield')
    // walk into B's turn: their draw step draws a card → the tithe triggers
    until(state, (s) => s.pending?.kind === 'optionalPay', "B's draw-step tithe")
    expect(state.pending?.player).toBe(B)
    act(state, B, { type: 'r.optionalPay', pay: false })
    expect(treasuresOf(state, A).length).toBe(1)
  })

  it('the pre-game opening hands do NOT trigger it', () => {
    const { state, A } = makeDuel()
    // makeDuel deals 7 cards each and auto-keeps; a battlefield Tithe placed afterwards is the
    // realistic case, but the guard is that no draw during setup queued a trigger
    expect(state.zones.stack.length).toBe(0)
    expect(state.pending).toBeFalsy()
    putCard(state, A, 'Smothering Tithe', 'battlefield')
    expect(state.zones.stack.length).toBe(0)
  })
})
