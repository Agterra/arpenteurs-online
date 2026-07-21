/**
 * Perpetual card coverage — batch CARD3: Path to Exile, Negate.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { defIsLand } from '../../server/rules/cards/dsl.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD3 — staple cards', () => {
  it('Path to Exile exiles a creature; its controller may fetch a basic land tapped', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const path = putCard(state, A, 'Path to Exile', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    act(state, A, { type: 'r.cast', objId: path, targets: [bear] })
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === B, "B's land search")
    expect(state.objects[bear]!.zone).toBe('exile')
    act(state, B, { type: 'r.search', cardIds: [state.pendingSearch!.matchIds[0]!] })
    const land = Object.values(state.objects).find((o) => o.controllerId === B && o.zone === 'battlefield' && defIsLand(getDef(o.defName)))
    expect(land, 'fetched basic land').toBeTruthy()
    expect(land!.tapped).toBe(true)
  })

  it('Negate counters a noncreature spell but cannot target a creature spell', () => {
    const { state, A, B } = makeDuel()
    const shock = putCard(state, A, 'Shock', 'hand')
    const bears = putCard(state, A, 'Grizzly Bears', 'hand')
    const negate = putCard(state, A, 'Negate', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    addMana(state, A, 'R', 1)
    addMana(state, A, 'U', 4)
    // a creature spell on the stack: Negate can't target it
    act(state, A, { type: 'r.cast', objId: bears, targets: [] })
    expect(() => act(state, A, { type: 'r.cast', objId: negate, targets: [bears] })).toThrow()
    resolve(state, A) // let Bears resolve
    // a noncreature spell (Shock): Negate counters it
    act(state, A, { type: 'r.cast', objId: shock, targets: [B] })
    act(state, A, { type: 'r.cast', objId: negate, targets: [shock] })
    resolve(state, A)
    expect(state.objects[shock]!.zone).toBe('graveyard') // countered
    expect(state.players[B]!.life).toBe(40) // Shock never resolved
  })
})
