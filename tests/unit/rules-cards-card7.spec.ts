/**
 * Perpetual card coverage — batch CARD7: Blasphemous Act — dynamic generic cost reduction
 * ("{1} less per creature on the battlefield") + damage-to-each-creature.
 * (Eternal Witness was deferred: a graveyardCard trigger target has no client selection path yet —
 * the rules-client-contract guard — so it needs the client-side trigger targeting added first.)
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const bears = (s: St, p: PlayerId, n: number) => Array.from({ length: n }, () => putCard(s, p, 'Grizzly Bears', 'battlefield'))

describe('CARD7 — Blasphemous Act (cost reduction)', () => {
  it('costs {1} less per creature: 3 creatures → payable with only {5}{R}, then deals 13 to each', () => {
    const { state, A, B } = makeDuel()
    const creatures = [...bears(state, A, 1), ...bears(state, B, 2)] // 3 creatures on the battlefield
    const ba = putCard(state, A, 'Blasphemous Act', 'hand')
    toStep(state, 'main1')
    // only 5 generic + R: the full {8}{R} would be unpayable, so a successful cast proves the −3
    addMana(state, A, 'C', 5)
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: ba, targets: [] })
    resolve(state, A)
    for (const c of creatures) expect(state.objects[c]!.zone).toBe('graveyard') // 13 damage → all dead
  })

  it('reduction is floored at 0: 9 creatures → payable with just {R}', () => {
    const { state, A, B } = makeDuel()
    const creatures = [...bears(state, A, 5), ...bears(state, B, 4)] // 9 > 8 generic
    const ba = putCard(state, A, 'Blasphemous Act', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1) // just {R}; base {8}{R} would be unpayable
    act(state, A, { type: 'r.cast', objId: ba, targets: [] })
    resolve(state, A)
    for (const c of creatures) expect(state.objects[c]!.zone).toBe('graveyard')
  })

  it('redact castability mirrors the reduction', () => {
    const { state, A, B } = makeDuel()
    const ba = putCard(state, A, 'Blasphemous Act', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1) // only {R} in the pool
    expect(computeLegal(state, A).castableIds).not.toContain(ba) // no creatures → full {8}{R} unaffordable
    bears(state, B, 8) // 8 creatures → generic floored to 0 → {R} now suffices
    expect(computeLegal(state, A).castableIds).toContain(ba)
  })
})
