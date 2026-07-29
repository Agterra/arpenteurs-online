/**
 * Perpetual card coverage — batch CARD56: the chosen-type ARTIFACTS (Herald's Horn's type-gated cost
 * reduction and its "look at the top card, you may reveal it" upkeep; Vanquisher's Banner's chosen-type
 * anthem and cast trigger) plus Path of Ancestry, whose mana carries a RIDER — "when that mana is spent
 * to cast a creature spell that shares a creature type with your commander, scry 1".
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal, redactRulesState } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { permanentCostReduction } from '../../server/rules/engine.ts'
import { currentPT } from '../../server/rules/characteristics.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
/** put a type-choosing artifact onto the battlefield and answer its choice */
const withType = (s: St, A: PlayerId, card: string, type: string) => {
  const id = putCard(s, A, card, 'hand')
  toStep(s, 'main1')
  act(s, A, { type: 'r.mMove', objId: id, zone: 'battlefield' })
  until(s, (x) => x.pending?.kind === 'typeChoice', 'the type choice')
  act(s, A, { type: 'r.chooseType', creatureType: type })
  return id
}
/** rig the top of A's library to `id` */
const putOnTop = (s: St, A: PlayerId, id: ObjId) => {
  const lib = s.zones.perPlayer[A]!.library
  const at = lib.indexOf(id)
  if (at >= 0) lib.splice(at, 1)
  lib.unshift(id)
}

describe("CARD56 — Herald's Horn", () => {
  it('makes creature spells of the chosen type cost {1} less', () => {
    const { state, A } = makeDuel()
    withType(state, A, "Herald's Horn", 'Bear')
    const bear = putCard(state, A, 'Grizzly Bears', 'hand') // {1}{G} Bear
    const ogre = putCard(state, A, 'Gray Ogre', 'hand') // {3}{R} Ogre — no discount
    addMana(state, A, 'G', 1)
    expect(computeLegal(state, A).castableIds).toContain(bear) // {G} alone is enough now
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('battlefield')
    // the Ogre gets no discount at all (asserted on the reduction itself: the pool is not the point)
    expect(permanentCostReduction(state, A, getDef(state.objects[ogre]!.defName))).toBe(0)
    expect(permanentCostReduction(state, A, getDef(state.objects[bear]!.defName))).toBe(1)
  })

  it('offers the top card at your upkeep when it matches, actor-only', () => {
    const { state, A, B } = makeDuel()
    const horn = withType(state, A, "Herald's Horn", 'Bear')
    const bear = putCard(state, A, 'Grizzly Bears', 'library')
    putOnTop(state, A, bear)
    const handBefore = state.zones.perPlayer[A]!.hand.length
    until(state, (s) => s.pending?.kind === 'revealTop' && s.pending.player === A, "the upkeep look")
    const legal = computeLegal(state, A)
    expect(legal.needsRevealTop).toBe(true)
    expect(legal.revealTopCardId).toBe(bear)
    expect(legal.revealTopSourceName).toBe("Herald's Horn")
    // the peek is actor-only: the opponent never sees that id
    expect(JSON.stringify(redactRulesState(state, B)).includes(bear)).toBe(false)
    act(state, A, { type: 'r.revealTop', take: true })
    // the drawn-for-turn card comes on top of it, so compare by name
    expect(state.zones.perPlayer[A]!.hand.some((id) => nameOf(state, id) === 'Grizzly Bears')).toBe(true)
    expect(state.zones.perPlayer[A]!.hand.length).toBeGreaterThan(handBefore)
    expect(state.objects[horn]!.zone).toBe('battlefield')
  })

  it('may be left on top', () => {
    const { state, A } = makeDuel()
    withType(state, A, "Herald's Horn", 'Bear')
    const bear = putCard(state, A, 'Grizzly Bears', 'library')
    putOnTop(state, A, bear)
    until(state, (s) => s.pending?.kind === 'revealTop', 'the upkeep look')
    act(state, A, { type: 'r.revealTop', take: false })
    expect(state.objects[bear]!.zone).toBe('library')
    expect(state.log.some((l) => /leaves the card on top/.test(l))).toBe(true)
  })

  it('asks nothing when the top card is the wrong type', () => {
    const { state, A } = makeDuel()
    withType(state, A, "Herald's Horn", 'Elf')
    const bear = putCard(state, A, 'Grizzly Bears', 'library') // a Bear, not an Elf
    putOnTop(state, A, bear)
    until(state, (s) => (s.activePlayer === A && s.turnNumber > 1 && s.step === 'draw') || s.pending?.kind === 'revealTop', "A's own upkeep")
    expect(state.pending?.kind).not.toBe('revealTop')
    expect(state.log.some((l) => /looks at the top card of their library/.test(l))).toBe(true)
  })
})

describe("CARD56 — Vanquisher's Banner", () => {
  it('pumps the chosen type and draws on each such creature spell', () => {
    const { state, A } = makeDuel()
    withType(state, A, "Vanquisher's Banner", 'Bear')
    const onBoard = putCard(state, A, 'Grizzly Bears', 'battlefield')
    expect(currentPT(state, state.objects[onBoard]!)).toEqual({ power: 3, toughness: 3 })
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    expect(currentPT(state, state.objects[ogre]!)).toEqual({ power: 2, toughness: 2 }) // wrong type
    // casting a Bear draws a card
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    resolve(state, A)
    // −1 the Bear leaving the hand, +1 drawn
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand)
    expect(state.zones.perPlayer[A]!.battlefield).toContain(bear)
  })

  it('does not draw on a creature spell of another type', () => {
    const { state, A } = makeDuel()
    withType(state, A, "Vanquisher's Banner", 'Elf')
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand - 1) // only the Bear left
  })
})

describe('CARD56 — Path of Ancestry', () => {
  const rig = (s: St, A: PlayerId, commander: string) => {
    const path = putCard(s, A, 'Path of Ancestry', 'hand')
    const cmd = putCard(s, A, commander, 'battlefield')
    s.players[A]!.commanderId = cmd
    s.objects[cmd]!.isCommander = true
    toStep(s, 'main1')
    act(s, A, { type: 'r.playLand', objId: path })
    expect(s.objects[path]!.tapped).toBe(true) // it always enters tapped
    s.objects[path]!.tapped = false
    return path
  }

  it('scries when its mana pays for a creature sharing a type with your commander', () => {
    const { state, A } = makeDuel()
    // Loran of the Third Path is a Human Artificer; cast another Human off the Path's mana
    const path = rig(state, A, 'Loran of the Third Path')
    const human = putCard(state, A, 'Loran of the Third Path', 'hand') // {2}{W} Human
    act(state, A, { type: 'r.tapMana', objId: path, color: 'W' })
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: human, targets: [] })
    expect(state.pending?.kind).toBe('scry')
    expect(state.pendingScry!.cardIds.length).toBe(1)
    act(state, A, { type: 'r.scry', toBottom: [] })
    resolve(state, A)
    expect(state.objects[human]!.zone).toBe('battlefield')
  })

  it('does NOT scry for a creature of another type, nor for a noncreature spell', () => {
    const { state, A } = makeDuel()
    const path = rig(state, A, 'Loran of the Third Path') // Human
    const bear = putCard(state, A, 'Grizzly Bears', 'hand') // a Bear
    act(state, A, { type: 'r.tapMana', objId: path, color: 'G' })
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    expect(state.pending?.kind).not.toBe('scry')
    resolve(state, A)
    // a noncreature spell off the same mana: still no scry
    state.objects[path]!.tapped = false
    const shock = putCard(state, A, 'Shock', 'hand')
    act(state, A, { type: 'r.tapMana', objId: path, color: 'R' })
    act(state, A, { type: 'r.cast', objId: shock, targets: [A] })
    expect(state.pending?.kind).not.toBe('scry')
  })

  it('its mana is NOT restricted — it can pay for anything', () => {
    const { state, A } = makeDuel()
    const path = rig(state, A, 'Loran of the Third Path')
    act(state, A, { type: 'r.tapMana', objId: path, color: 'B' })
    // the bucket exists but pays for a black spell of any kind
    const murder = putCard(state, A, 'Murder', 'hand') // {1}{B}{B}
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 1)
    expect(computeLegal(state, A).castableIds).toContain(murder)
    act(state, A, { type: 'r.cast', objId: murder, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
  })
})
