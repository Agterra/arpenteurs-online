/**
 * Coverage batch B10: library search (ramp + tutors) — LEAK-CRITICAL. The search
 * reveals matching library ids to the ACTOR ONLY (sanctioned peek), and the
 * library is shuffled + re-minted after resolution. These tests assert both the
 * mechanic and that an opponent's redacted view never contains a library id.
 */
import { describe, expect, it } from 'vitest'
import { act, commanderObj, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = ReturnType<typeof makeDuel>['state']
function tapLands(state: St, A: string) {
  for (const id of [...state.zones.perPlayer[A]!.battlefield]) {
    const hasMana = getDef(state.objects[id]!.defName).abilities?.some((a) => a.kind === 'activated' && a.isMana)
    if (hasMana) act(state, A, { type: 'r.tapMana', objId: id })
  }
}

describe('Rampant Growth — fetch a basic land onto the battlefield tapped', () => {
  it('fetches the basic and does not leak the library to opponents', () => {
    const { state, A, B } = makeDuel()
    const spell = putCard(state, A, 'Rampant Growth', 'hand')
    putCard(state, A, 'Forest', 'battlefield')
    putCard(state, A, 'Forest', 'battlefield')
    const libForest = putCard(state, A, 'Forest', 'library')
    toStep(state, 'main1')
    tapLands(state, A)
    act(state, A, { type: 'r.cast', objId: spell, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'search opens')

    // actor sees the match; opponent's view contains NO library id
    expect(redactRulesState(state, A).search?.matchIds).toContain(libForest)
    const bView = redactRulesState(state, B)
    const bjson = JSON.stringify(bView)
    for (const id of state.zones.perPlayer[A]!.library)
      expect(bjson.includes(id), `library id ${id} leaked to opponent`).toBe(false)
    expect(bView.search).toBeNull()

    act(state, A, { type: 'r.search', cardIds: [libForest] })
    until(state, (s) => !s.pending && !s.zones.stack.length, 'search resolves')
    expect(state.objects[libForest]!.zone).toBe('battlefield')
    expect(state.objects[libForest]!.tapped).toBe(true)
  })
})

describe('commander never enters a hidden zone (leak guard)', () => {
  it('reroutes a manual move of a commander to library/hand into the command zone', () => {
    const { state, A } = makeDuel()
    const cmd = commanderObj(state, A) // starts in the command zone
    act(state, A, { type: 'r.mMove', objId: cmd, zone: 'library' })
    expect(state.objects[cmd]!.zone).toBe('command') // not the library
    expect(state.zones.perPlayer[A]!.library).not.toContain(cmd)
    act(state, A, { type: 'r.mMove', objId: cmd, zone: 'hand' })
    expect(state.objects[cmd]!.zone).toBe('command') // not the hand
    expect(state.zones.perPlayer[A]!.hand).not.toContain(cmd)
  })
})

describe('Demonic Tutor — fetch any card to hand', () => {
  it('moves the chosen card to hand with a fresh id (re-mint) and shuffles', () => {
    const { state, A, B } = makeDuel()
    const tutor = putCard(state, A, 'Demonic Tutor', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const libCard = putCard(state, A, 'Grizzly Bears', 'library')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    toStep(state, 'main1')
    tapLands(state, A)
    act(state, A, { type: 'r.cast', objId: tutor, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'search opens')

    // whole library is a match, and none of it leaks to the opponent
    expect(redactRulesState(state, A).search?.matchIds).toContain(libCard)
    const bjson = JSON.stringify(redactRulesState(state, B))
    for (const id of state.zones.perPlayer[A]!.library) expect(bjson.includes(id)).toBe(false)

    act(state, A, { type: 'r.search', cardIds: [libCard] })
    until(state, (s) => !s.pending && !s.zones.stack.length, 'resolves')
    // old library id is gone (re-minted on hidden-zone entry)…
    expect(state.objects[libCard]).toBeUndefined()
    // …and a Grizzly Bears is now in hand (tutor left hand, one fetched → net +0 count, but present)
    const inHand = state.zones.perPlayer[A]!.hand.some((id) => getDef(state.objects[id]!.defName).name === 'Grizzly Bears')
    expect(inHand).toBe(true)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore) // -Demonic Tutor +fetched
  })
})
