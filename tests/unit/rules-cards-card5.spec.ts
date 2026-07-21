/**
 * Perpetual card coverage — batch CARD5: Cultivate, Kodama's Reach.
 * Both are the same "search for up to two basic lands, one onto the battlefield tapped and the
 * other into your hand" ramp spell — exercising the new split-destination library search.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { defIsLand } from '../../server/rules/cards/dsl.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const handLands = (s: St, p: PlayerId) => s.zones.perPlayer[p]!.hand.filter((id) => defIsLand(getDef(s.objects[id]!.defName))).length

describe.each(['Cultivate', "Kodama's Reach"])('CARD5 — %s (split-destination ramp)', (cardName) => {
  it('puts one basic land onto the battlefield tapped and the other into hand, then shuffles', () => {
    const { state, A } = makeDuel()
    // guarantee ≥2 basics in A's library to search from (default deck is basics-heavy anyway)
    putCard(state, A, 'Forest', 'library')
    putCard(state, A, 'Forest', 'library')
    putCard(state, A, 'Forest', 'library')
    const spell = putCard(state, A, cardName, 'hand')
    const handLandsBefore = handLands(state, A)
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: spell, targets: [] })
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, "A's land search")
    const matches = state.pendingSearch!.matchIds
    expect(matches.length).toBeGreaterThanOrEqual(3) // basic lands are legal matches
    // pick two basics
    act(state, A, { type: 'r.search', cardIds: [matches[0]!, matches[1]!] })
    resolve(state, A)

    // exactly one basic land arrived tapped on the (previously empty) battlefield under A's control
    const onField = Object.values(state.objects).filter(
      (o) => o.controllerId === A && o.zone === 'battlefield' && defIsLand(getDef(o.defName)),
    )
    expect(onField.length).toBe(1)
    expect(onField[0]!.tapped).toBe(true)

    // and one basic land landed in hand: net +1 land (spell left the hand, one fetched land entered)
    expect(handLands(state, A)).toBe(handLandsBefore + 1)

    // library re-minted after the search: the UNPICKED forest's original id no longer survives
    // (the battlefield pick keeps its public id; the hand pick and the leftovers are re-minted)
    expect(state.zones.perPlayer[A]!.library.includes(matches[2]!)).toBe(false)
    expect(state.objects[matches[2]!]).toBeUndefined()
  })
})
