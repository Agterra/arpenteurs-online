/**
 * Client cast UI foundation: `computeLegal` surfaces the alternative / other-zone casts so the
 * board can render extra cast buttons — flashback & retrace (graveyard), evoke / bestow / suspend /
 * adventure (hand), cast-from-exile (adventured), and a buyback toggle. This tests the server
 * computation (the DuelBoard renders straight from these lists).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name

describe('legal actions — alternative casts for the client', () => {
  it('surfaces flashback, retrace, evoke, bestow, suspend, adventure, cast-from-exile and buyback', () => {
    const { state, A, B } = makeDuel()
    const bolt = putCard(state, A, 'Firebolt', 'graveyard') // flashback {4}{R}
    const raven = putCard(state, A, "Raven's Crime", 'graveyard') // retrace (needs a land in hand)
    const woe = putCard(state, A, 'Woe Strider', 'graveyard') // escape {3}{B}, exile 4 others
    ;[0, 1, 2, 3].forEach(() => putCard(state, A, 'Mountain', 'graveyard')) // escape fodder
    putCard(state, A, 'Mountain', 'hand') // the land for retrace
    const mull = putCard(state, A, 'Mulldrifter', 'hand') // evoke {2}{U}
    const roll = putCard(state, A, 'Nyxborn Rollicker', 'hand') // bestow {1}{G}
    const eph = putCard(state, A, 'Errant Ephemeron', 'hand') // suspend {1}{U}
    const rider = putCard(state, A, 'Murderous Rider', 'hand') // adventure Swift End {1}{B}{B}
    const cap = putCard(state, A, 'Capsize', 'hand') // buyback {3}
    const exiled = putCard(state, A, 'Murderous Rider', 'exile') // creature castable from exile
    state.objects[exiled]!.adventured = true
    putCard(state, B, 'Grizzly Bears', 'battlefield') // a creature target (adventure/bestow)

    toStep(state, 'main1')
    for (const c of ['W', 'U', 'B', 'R', 'G', 'C'] as ManaColor[]) addMana(state, A, 'C' === c ? 'C' : c, 4)

    const legal = computeLegal(state, A)
    expect(legal.flashbackable.map((f) => f.objId)).toContain(bolt)
    expect(legal.retraceable.map((f) => f.objId)).toContain(raven)
    expect(legal.escapable.map((f) => f.objId)).toContain(woe)
    expect(legal.escapable.find((f) => f.objId === woe)?.exileCount).toBe(4)
    expect(legal.evokable.map((f) => f.objId)).toContain(mull)
    expect(legal.bestowable.map((f) => f.objId)).toContain(roll)
    expect(legal.suspendable.map((f) => f.objId)).toContain(eph)
    expect(legal.adventurable.map((f) => f.objId)).toContain(rider)
    expect(legal.adventurable.find((f) => f.objId === rider)?.name).toBe('Swift End')
    expect(legal.castExileIds).toContain(exiled)
    expect(legal.buybackable.map((f) => f.objId)).toContain(cap)
    // sanity: costs are the alt costs, not the base
    expect(legal.flashbackable.find((f) => f.objId === bolt)?.cost).toBe('{4}{R}')
    expect(nameOf(state, mull)).toBe('Mulldrifter')
  })

  it('does not offer retrace when there is no land in hand to discard', () => {
    const { state, A } = makeDuel()
    const raven = putCard(state, A, "Raven's Crime", 'graveyard')
    toStep(state, 'main1')
    state.zones.perPlayer[A]!.hand = [] // empty the opening hand → no land to discard for retrace
    addMana(state, A, 'B', 4)
    const legal = computeLegal(state, A)
    expect(legal.retraceable.map((f) => f.objId)).not.toContain(raven)
  })
})
