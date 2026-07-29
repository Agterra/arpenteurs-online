/**
 * Perpetual card coverage — batch CARD38: graveyard-card targets on ACTIVATED and CHANNEL abilities
 * (the board now renders a picker from redact's legal-card list). Cards: Buried Ruin, Takenuma.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const inHand = (s: St, p: PlayerId, name: string) =>
  s.zones.perPlayer[p]!.hand.some((id) => getDef(s.objects[id]!.defName).name === name)

describe('CARD38 — Buried Ruin (an activated ability targeting your graveyard)', () => {
  it('sacrifices itself to return an artifact card from your graveyard', () => {
    const { state, A } = makeDuel()
    const ruin = putCard(state, A, 'Buried Ruin', 'battlefield')
    const rock = putCard(state, A, 'Sol Ring', 'graveyard')
    putCard(state, A, 'Grizzly Bears', 'graveyard') // not an artifact
    toStep(state, 'main1')
    addMana(state, A, 'C', 2)
    const activation = computeLegal(state, A).activations.find((a) => a.objId === ruin && a.abilityIndex === 1)
    expect(activation?.targetKind).toBe('graveyardCard')
    expect(activation?.graveyardIds).toEqual([rock]) // only the artifact is offered
    act(state, A, { type: 'r.activate', objId: ruin, abilityIndex: 1, targets: [rock] })
    expect(state.objects[ruin]!.zone).toBe('graveyard') // sacrificed as part of the cost
    resolve(state, A)
    expect(inHand(state, A, 'Sol Ring')).toBe(true) // re-minted on the graveyard→hand move
  })

  it('is not offered with no artifact in your graveyard', () => {
    const { state, A } = makeDuel()
    const ruin = putCard(state, A, 'Buried Ruin', 'battlefield')
    putCard(state, A, 'Grizzly Bears', 'graveyard')
    toStep(state, 'main1')
    addMana(state, A, 'C', 2)
    expect(computeLegal(state, A).activations.some((a) => a.objId === ruin && a.abilityIndex === 1)).toBe(false)
  })

  it("cannot take an artifact from an OPPONENT's graveyard", () => {
    const { state, A, B } = makeDuel()
    const ruin = putCard(state, A, 'Buried Ruin', 'battlefield')
    const theirs = putCard(state, B, 'Sol Ring', 'graveyard')
    toStep(state, 'main1')
    addMana(state, A, 'C', 2)
    expect(() => act(state, A, { type: 'r.activate', objId: ruin, abilityIndex: 1, targets: [theirs] })).toThrow(
      /BAD_TARGETS|Illegal target/i,
    )
  })
})

describe('CARD38 — Takenuma (a channel ability targeting your graveyard)', () => {
  it('mills three and returns the chosen creature card to hand', () => {
    const { state, A } = makeDuel()
    const takenuma = putCard(state, A, 'Takenuma, Abandoned Mire', 'hand')
    const dead = putCard(state, A, 'Grizzly Bears', 'graveyard')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 3)
    const ch = computeLegal(state, A).channelable.find((c) => c.objId === takenuma)
    expect(ch?.targetKind).toBe('graveyardCard')
    expect(ch?.graveyardIds).toContain(dead)
    const libBefore = state.zones.perPlayer[A]!.library.length
    act(state, A, { type: 'r.channel', objId: takenuma, targets: [dead] })
    expect(state.objects[takenuma]!.zone).toBe('graveyard') // discarded as its cost
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore - 3) // milled 3
    expect(inHand(state, A, 'Grizzly Bears')).toBe(true)
  })

  it('may be channelled with nothing to return (optional target)', () => {
    const { state, A } = makeDuel()
    const takenuma = putCard(state, A, 'Takenuma, Abandoned Mire', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 3)
    const libBefore = state.zones.perPlayer[A]!.library.length
    act(state, A, { type: 'r.channel', objId: takenuma, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore - 3) // it still mills
  })

  it('will not return a noncreature, nonplaneswalker card', () => {
    const { state, A } = makeDuel()
    const takenuma = putCard(state, A, 'Takenuma, Abandoned Mire', 'hand')
    const shock = putCard(state, A, 'Shock', 'graveyard')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 3)
    expect(computeLegal(state, A).channelable.find((c) => c.objId === takenuma)!.graveyardIds ?? []).not.toContain(shock)
    expect(() => act(state, A, { type: 'r.channel', objId: takenuma, targets: [shock] })).toThrow(/BAD_TARGETS|Illegal target/i)
  })

  it('its mana ability and land drop still work normally', () => {
    const { state, A } = makeDuel()
    const takenuma = putCard(state, A, 'Takenuma, Abandoned Mire', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: takenuma })
    act(state, A, { type: 'r.tapMana', objId: takenuma })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })
})
