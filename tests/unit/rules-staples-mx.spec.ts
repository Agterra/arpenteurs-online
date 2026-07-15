/**
 * Coverage batch MX: X spells + modal ("choose one") spells.
 *  - X spells: r.cast carries `x`; the engine adds x×(#{X}) to the generic cost and
 *    resolves the effect with ctx.x (Blaze, Mind Spring, Sphinx's Revelation, Earthquake).
 *  - Modal spells: r.cast carries `mode`; targets + effect come from that mode (Abrade).
 * Mana is set up with the r.mMana manual override to avoid land/tap juggling.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor } from '../../shared/rules/types.ts'

type St = ReturnType<typeof makeDuel>['state']
const addMana = (state: St, p: string, color: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'spell resolves')

describe('Blaze — {X}{R}: deals X damage to any target', () => {
  it('deals the chosen X to a targeted player and charges X generic', () => {
    const { state, A, B } = makeDuel()
    const blaze = putCard(state, A, 'Blaze', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 4) // {3}{R} for X=3
    const bLife = state.players[B]!.life
    act(state, A, { type: 'r.cast', objId: blaze, targets: [B], x: 3 })
    resolve(state, A)
    expect(state.players[B]!.life).toBe(bLife - 3)
    expect(state.players[A]!.manaPool.R).toBe(0) // 1 (R pip) + 3 (X) spent
  })

  it('rejects casting an X spell without choosing X, and when the pool is short', () => {
    const { state, A, B } = makeDuel()
    const blaze = putCard(state, A, 'Blaze', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 2)
    expect(() => act(state, A, { type: 'r.cast', objId: blaze, targets: [B] })).toThrow() // NEEDS_X
    expect(() => act(state, A, { type: 'r.cast', objId: blaze, targets: [B], x: 9 })).toThrow() // CANT_PAY
  })
})

describe('Mind Spring — {X}{U}{U}: draw X', () => {
  it('draws exactly X cards', () => {
    const { state, A } = makeDuel()
    const ms = putCard(state, A, 'Mind Spring', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 5) // {3}{U}{U} for X=3
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cast', objId: ms, targets: [], x: 3 })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand - 1 + 3) // Mind Spring left hand, drew 3
  })
})

describe("Sphinx's Revelation — {X}{W}{U}{U}: gain X, draw X", () => {
  it('gains X life and draws X cards', () => {
    const { state, A } = makeDuel()
    const sr = putCard(state, A, "Sphinx's Revelation", 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'U', 2)
    addMana(state, A, 'C', 2) // {2}{W}{U}{U} for X=2
    const life = state.players[A]!.life
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cast', objId: sr, targets: [], x: 2 })
    resolve(state, A)
    expect(state.players[A]!.life).toBe(life + 2)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand - 1 + 2)
  })
})

describe('Earthquake — {X}{R}: X to each non-flyer and each player', () => {
  it('damages ground creatures + all players but spares flyers', () => {
    const { state, A, B } = makeDuel()
    const eq = putCard(state, A, 'Earthquake', 'hand')
    const giant = putCard(state, A, 'Hill Giant', 'battlefield') // 3/3 ground
    const drake = putCard(state, A, 'Wind Drake', 'battlefield') // 2/2 flying
    toStep(state, 'main1')
    addMana(state, A, 'R', 3) // {2}{R} for X=2
    const aLife = state.players[A]!.life
    const bLife = state.players[B]!.life
    act(state, A, { type: 'r.cast', objId: eq, targets: [], x: 2 })
    resolve(state, A)
    expect(state.objects[giant]!.damageMarked).toBe(2) // ground creature hit
    expect(state.objects[drake]!.damageMarked).toBe(0) // flyer spared
    expect(state.players[A]!.life).toBe(aLife - 2) // caster is a player too
    expect(state.players[B]!.life).toBe(bLife - 2)
  })
})

describe('Abrade — modal: 3 damage to a creature OR destroy an artifact', () => {
  it('mode 0 burns a creature; mode 1 destroys an artifact; illegal picks rejected', () => {
    const { state, A, B } = makeDuel()
    // mode 0 — 3 damage to a creature
    const a1 = putCard(state, A, 'Abrade', 'hand')
    const giant = putCard(state, B, 'Hill Giant', 'battlefield') // 3/3
    toStep(state, 'main1')
    addMana(state, A, 'R', 2)
    act(state, A, { type: 'r.cast', objId: a1, targets: [giant], mode: 0 })
    resolve(state, A)
    expect(state.objects[giant]!.zone).toBe('graveyard') // 3 damage = lethal

    // mode 1 — destroy an artifact
    const a2 = putCard(state, A, 'Abrade', 'hand')
    const art = putCard(state, B, 'Bonesplitter', 'battlefield')
    addMana(state, A, 'R', 2)
    act(state, A, { type: 'r.cast', objId: a2, targets: [art], mode: 1 })
    resolve(state, A)
    expect(state.objects[art]!.zone).toBe('graveyard')

    // illegal: mode 1 (artifact) aimed at a creature, and an out-of-range mode
    const a3 = putCard(state, A, 'Abrade', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    addMana(state, A, 'R', 2)
    expect(() => act(state, A, { type: 'r.cast', objId: a3, targets: [bear], mode: 1 })).toThrow()
    expect(() => act(state, A, { type: 'r.cast', objId: a3, targets: [bear], mode: 5 })).toThrow()
  })
})
