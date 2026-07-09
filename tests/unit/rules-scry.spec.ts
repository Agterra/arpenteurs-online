/**
 * Scry (CR 701.18): the scrying player peeks at the top N of their library and
 * bottoms any of them. Hidden-info: ONLY the scrying player sees those cards.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

describe('scry (Crystal Ball)', () => {
  it('lets the controller look at the top 2 and bottom one; the peek is hidden from opponents', () => {
    const { state, A, B } = makeDuel()
    const ball = putCard(state, A, 'Crystal Ball') // {1},{T}: Scry 2
    const mtn = putCard(state, A, 'Mountain')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: mtn })
    act(state, A, { type: 'r.activate', objId: ball, abilityIndex: 0, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry' && s.pending.player === A, 'scry pending')

    // A sees the top two; B sees nothing about them
    const top = state.pendingScry!.cardIds
    expect(top.length).toBe(2)
    const va = redactRulesState(state, A)
    expect(va.scry?.cardIds.length).toBe(2)
    for (const id of top) expect(va.cards[id], 'A can see the scried card').toBeTruthy()
    const vb = redactRulesState(state, B)
    expect(vb.scry).toBeNull()
    const jsonB = JSON.stringify(vb)
    for (const id of top) expect(jsonB.includes(id), 'scried id must not leak to B').toBe(false)

    // bottom the first, keep the second → the kept card is on top, the bottomed one last
    const keptDef = state.objects[top[1]!]!.defName
    const bottomedDef = state.objects[top[0]!]!.defName
    act(state, A, { type: 'r.scry', toBottom: [top[0]!] })
    expect(state.pendingScry).toBeNull()
    const lib = state.zones.perPlayer[A]!.library
    expect(state.objects[lib[0]!]!.defName).toBe(keptDef) // kept on top
    expect(state.objects[lib[lib.length - 1]!]!.defName).toBe(bottomedDef) // bottomed at the bottom
  })

  it('rejects bottoming a card that was not among the scried cards', () => {
    const { state, A } = makeDuel()
    const ball = putCard(state, A, 'Crystal Ball')
    const mtn = putCard(state, A, 'Mountain')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: mtn })
    act(state, A, { type: 'r.activate', objId: ball, abilityIndex: 0, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'scry')
    const handCard = state.zones.perPlayer[A]!.hand[0]!
    expect(() => act(state, A, { type: 'r.scry', toBottom: [handCard] })).toThrow(/scried/)
  })
})
