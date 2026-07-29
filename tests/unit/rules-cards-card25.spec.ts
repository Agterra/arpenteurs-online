/**
 * Perpetual card coverage — batch CARD25: cantrips (Opt, Preordain), an extra land drop (Explore),
 * an own-cast trigger (Beast Whisperer), "can't be countered" (Dovin's Veto), a sacrifice-a-LAND
 * additional cost (Crop Rotation, Harrow) and Ornithopter of Paradise.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD25 — Opt and Preordain', () => {
  it('Opt scries 1 then draws', () => {
    const { state, A } = makeDuel()
    const opt = putCard(state, A, 'Opt', 'hand')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: opt, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'the scry')
    expect(state.pendingScry!.cardIds.length).toBe(1)
    act(state, A, { type: 'r.scry', toBottom: [] }) // keep it on top
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1 + 1) // spell out, 1 drawn
  })

  it('the draw waits for the scry: the peeked card is never taken mid-peek', () => {
    // REGRESSION (found by the CI leak fuzzer): `sequence(scry(1), drawCards(1))` drew the very card
    // being scried, so r.scry re-inserted an id that was already in the hand and the following
    // library re-mint stranded it — a dangling hand id.
    const { state, A } = makeDuel()
    const opt = putCard(state, A, 'Opt', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: opt, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'the scry')
    const peeked = state.pendingScry!.cardIds[0]!
    const handBefore = state.zones.perPlayer[A]!.hand.length
    expect(state.zones.perPlayer[A]!.hand).not.toContain(peeked) // nothing drawn yet
    act(state, A, { type: 'r.scry', toBottom: [peeked] }) // bottom it, THEN draw
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1)
    // every id in every zone still resolves to a live object
    for (const zone of Object.values(state.zones.perPlayer[A]!))
      for (const id of zone as string[]) expect(state.objects[id]).toBeTruthy()
  })

  it('Preordain scries 2 then draws', () => {
    const { state, A } = makeDuel()
    const pre = putCard(state, A, 'Preordain', 'hand')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: pre, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'the scry')
    expect(state.pendingScry!.cardIds.length).toBe(2)
    act(state, A, { type: 'r.scry', toBottom: [state.pendingScry!.cardIds[0]!] }) // bottom one
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore)
  })
})

describe('CARD25 — Explore (an additional land drop)', () => {
  it('lets you play a second land this turn', () => {
    const { state, A } = makeDuel()
    const explore = putCard(state, A, 'Explore', 'hand')
    const first = putCard(state, A, 'Mountain', 'hand')
    const second = putCard(state, A, 'Mountain', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: first })
    expect(() => act(state, A, { type: 'r.playLand', objId: second })).toThrow(/LAND_LIMIT|Already played/i)
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: explore, targets: [] })
    resolve(state, A)
    expect(computeLegal(state, A).playableLandIds).toContain(second)
    act(state, A, { type: 'r.playLand', objId: second })
    expect(state.objects[second]!.zone).toBe('battlefield')
  })

  it('the extra drop expires at end of turn', () => {
    const { state, A } = makeDuel()
    const explore = putCard(state, A, 'Explore', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: explore, targets: [] })
    resolve(state, A)
    expect(state.players[A]!.extraLandsThisTurn).toBe(1)
    until(state, (s) => s.turnNumber === 3 && s.activePlayer === A, "A's next turn")
    expect(state.players[A]!.extraLandsThisTurn).toBe(0)
  })
})

describe('CARD25 — Beast Whisperer (whenever YOU cast a creature spell)', () => {
  it('draws on your own creature spell', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Beast Whisperer', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'hand')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: ogre, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1 + 1) // ogre out, 1 drawn
  })

  it('does not draw on your NONcreature spell, nor on an opponent\'s creature spell', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Beast Whisperer', 'battlefield')
    const shock = putCard(state, A, 'Shock', 'hand')
    const theirOgre = putCard(state, B, 'Gray Ogre', 'hand')
    toStep(state, 'main1')
    let handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [B] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1) // no draw
    // B's own creature spell on their turn
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, B, 'R', 1)
    addMana(state, B, 'C', 2)
    act(state, B, { type: 'r.cast', objId: theirOgre, targets: [] })
    until(state, (s) => !s.zones.stack.length, 'resolve')
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore)
  })
})

describe("CARD25 — Dovin's Veto (can't be countered)", () => {
  it('counters a noncreature spell, and cannot itself be countered', () => {
    const { state, A, B } = makeDuel()
    const veto = putCard(state, A, "Dovin's Veto", 'hand')
    const shock = putCard(state, B, 'Shock', 'hand')
    const counter = putCard(state, B, 'Counterspell', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    pass(state, B)
    addMana(state, A, 'W', 1)
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: veto, targets: [shock] })
    // B tries to counter the Veto
    pass(state, A)
    addMana(state, B, 'U', 2)
    act(state, B, { type: 'r.cast', objId: counter, targets: [veto] })
    until(state, (s) => !s.zones.stack.length, 'everything resolves')
    expect(state.objects[veto]!.zone).toBe('graveyard') // it resolved (not countered)
    expect(state.objects[shock]!.zone).toBe('graveyard') // and it did counter the Shock
    expect(state.players[A]!.life).toBe(40)
    expect(state.log.some((l) => /can't be countered/.test(l))).toBe(true)
  })
})

describe('CARD25 — Crop Rotation and Harrow (sacrifice a LAND)', () => {
  it('Crop Rotation sacrifices a land and fetches ANY land untapped', () => {
    const { state, A } = makeDuel()
    const rot = putCard(state, A, 'Crop Rotation', 'hand')
    const land = putCard(state, A, 'Mountain', 'battlefield')
    const target = putCard(state, A, 'Bojuka Bog', 'library') // a NONbasic land is a legal find
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.cast', objId: rot, targets: [], sacrifices: [land] })
    expect(state.objects[land]!.zone).toBe('graveyard')
    until(state, (s) => s.pending?.kind === 'search', 'the land search')
    expect(state.pendingSearch!.matchIds).toContain(target)
    act(state, A, { type: 'r.search', cardIds: [target] })
    expect(state.objects[target]!.zone).toBe('battlefield')
    // Bojuka Bog enters tapped by its own text and asks for its ETB target
    expect(state.objects[target]!.tapped).toBe(true)
  })

  it('Crop Rotation rejects a creature as the sacrifice and is uncastable with no land', () => {
    const { state, A } = makeDuel()
    const rot = putCard(state, A, 'Crop Rotation', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    expect(computeLegal(state, A).castableIds).not.toContain(rot) // no land to sacrifice
    expect(() => act(state, A, { type: 'r.cast', objId: rot, targets: [], sacrifices: [bear] })).toThrow(/Not a legal permanent/)
  })

  it('Harrow fetches up to two basics untapped', () => {
    const { state, A } = makeDuel()
    const harrow = putCard(state, A, 'Harrow', 'hand')
    const land = putCard(state, A, 'Mountain', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: harrow, targets: [], sacrifices: [land] })
    until(state, (s) => s.pending?.kind === 'search', 'the land search')
    const picks = state.pendingSearch!.matchIds.slice(0, 2)
    expect(state.pendingSearch!.count).toBe(2)
    act(state, A, { type: 'r.search', cardIds: picks })
    for (const id of picks) {
      expect(state.objects[id]!.zone).toBe('battlefield')
      expect(state.objects[id]!.tapped).toBe(false)
    }
  })
})

describe('CARD25 — Ornithopter of Paradise', () => {
  it('is a 0/2 flier that taps for any colour', () => {
    const { state, A } = makeDuel()
    const bird = putCard(state, A, 'Ornithopter of Paradise', 'battlefield')
    state.objects[bird]!.summoningSick = false
    toStep(state, 'main1')
    const def = getDef(state.objects[bird]!.defName)
    expect(def.types).toEqual(['Artifact', 'Creature'])
    expect(def.keywords).toContain('flying')
    act(state, A, { type: 'r.tapMana', objId: bird, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })

  it('cannot tap for mana while summoning sick', () => {
    const { state, A } = makeDuel()
    const bird = putCard(state, A, 'Ornithopter of Paradise', 'battlefield')
    state.objects[bird]!.summoningSick = true
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.tapMana', objId: bird, color: 'B' })).toThrow(/SUMMONING_SICK|can't tap for mana yet/i)
  })
})
