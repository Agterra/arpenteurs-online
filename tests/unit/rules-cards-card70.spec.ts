/**
 * Perpetual card coverage — batch CARD70, three top-400 cards:
 *  - Panharmonicon — the second trigger DOUBLER, reusing CARD66's machinery but keyed on the entering
 *    object's card types ("if an artifact or creature entering causes a triggered ability of a
 *    permanent you control to trigger…").
 *  - Orcish Bowmasters — flash, a draw watcher with the "except the first card in each of their draw
 *    steps" nuance, a targeted trigger, and AMASS (CR 701.44).
 *  - Mithril Coat — flash Equipment that attaches itself to a target legendary creature as it enters.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { currentKeywords, currentPT } from '../../server/rules/characteristics.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const armyOf = (s: St, p: PlayerId) =>
  s.zones.perPlayer[p]!.battlefield.find((id) => (getDef(s.objects[id]!.defName).subtypes ?? []).includes('Army'))

describe('CARD70 — Panharmonicon', () => {
  it('doubles an ETB trigger caused by a CREATURE entering', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Panharmonicon', 'battlefield')
    putCard(state, A, 'Soul Warden', 'battlefield') // "whenever another creature enters, you gain 1 life"
    toStep(state, 'main1')
    const life = state.players[A]!.life
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'both triggers resolve')
    expect(state.players[A]!.life).toBe(life + 2) // 1 + 1
    expect(state.log.some((l) => /triggers an additional time/.test(l))).toBe(true)
  })

  it('leaves a LAND entering alone (landfall is not an entry of an artifact or creature)', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Panharmonicon', 'battlefield')
    putCard(state, A, 'Tireless Provisioner', 'battlefield') // landfall: Food or Treasure
    const land = putCard(state, A, 'Forest', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: land })
    until(state, (s) => s.pending?.kind === 'modes', 'the landfall choice')
    act(state, A, { type: 'r.chooseModes', modes: [1] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'it resolves')
    const treasures = state.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(state, id) === 'Treasure').length
    expect(treasures).toBe(1) // NOT doubled
    expect(state.pending?.kind).not.toBe('modes')
  })

  it("does not double an OPPONENT's permanent's trigger", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Panharmonicon', 'battlefield')
    putCard(state, B, 'Soul Warden', 'battlefield') // theirs
    toStep(state, 'main1')
    const life = state.players[B]!.life
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'their trigger resolves')
    expect(state.players[B]!.life).toBe(life + 1) // once
  })

  it('stacks with a second Panharmonicon (three instances)', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Panharmonicon', 'battlefield')
    putCard(state, A, 'Panharmonicon', 'battlefield')
    putCard(state, A, 'Soul Warden', 'battlefield')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'all three resolve')
    expect(state.players[A]!.life).toBe(life + 3)
  })
})

describe('CARD70 — Orcish Bowmasters', () => {
  it('has flash, pings on entry and amasses an Orc Army', () => {
    const { state, A, B } = makeDuel()
    const bow = putCard(state, A, 'Orcish Bowmasters', 'hand')
    toStep(state, 'main1')
    pass(state, A) // …cast it on the opponent's turn to prove flash
    until(state, (s) => s.activePlayer === B && s.priorityPlayer === A, "A holds priority on B's turn")
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 1)
    expect(computeLegal(state, A).castableIds).toContain(bow)
    act(state, A, { type: 'r.cast', objId: bow, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'its ETB target')
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    until(state, (s) => s.players[B]!.life !== 40, 'the ping')
    expect(state.players[B]!.life).toBe(39)
    const army = armyOf(state, A)!
    expect(army).toBeTruthy()
    expect(currentPT(state, state.objects[army]!)).toEqual({ power: 1, toughness: 1 }) // 0/0 + one counter
  })

  it("fires on an opponent's EXTRA draw but not their draw-step draw", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Orcish Bowmasters', 'battlefield')
    // B's own draw-step draw is free
    until(state, (s) => s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's main phase")
    expect(state.pending?.kind).not.toBe('trigger')
    expect(armyOf(state, A)).toBeUndefined()
    // …an extra draw (Divination) fires it twice — once per card drawn
    const div = putCard(state, B, 'Divination', 'hand')
    addMana(state, B, 'U', 1)
    addMana(state, B, 'C', 2)
    act(state, B, { type: 'r.cast', objId: div, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'the first ping')
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'the second ping')
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    until(state, (s) => !s.zones.stack.length, 'everything resolves')
    expect(state.players[B]!.life).toBe(38) // 1 + 1
    const army = armyOf(state, A)!
    expect(currentPT(state, state.objects[army]!)).toEqual({ power: 2, toughness: 2 }) // amassed twice
  })

  it('ignores YOUR own draws', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Orcish Bowmasters', 'battlefield')
    toStep(state, 'main1')
    const div = putCard(state, A, 'Divination', 'hand')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: div, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the draws happen')
    expect(state.pending?.kind).not.toBe('trigger')
    expect(armyOf(state, A)).toBeUndefined()
  })

  it('amasses onto the SAME Army each time', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Orcish Bowmasters', 'battlefield')
    until(state, (s) => s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's main phase")
    const div = putCard(state, B, 'Divination', 'hand')
    addMana(state, B, 'U', 1)
    addMana(state, B, 'C', 2)
    act(state, B, { type: 'r.cast', objId: div, targets: [] })
    for (let i = 0; i < 2; i++) {
      until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, `ping ${i + 1}`)
      act(state, A, { type: 'r.chooseTargets', targets: [B] })
    }
    until(state, (s) => !s.zones.stack.length, 'everything resolves')
    const army = armyOf(state, A)!
    expect(state.objects[army]!.counters['+1/+1']).toBe(2) // one Army, amassed twice
    expect(state.zones.perPlayer[A]!.battlefield.filter((id) => (getDef(state.objects[id]!.defName).subtypes ?? []).includes('Army')).length).toBe(1)
  })
})

describe('CARD70 — Mithril Coat', () => {
  const cast = (s: St, A: PlayerId, target: ObjId) => {
    const coat = putCard(s, A, 'Mithril Coat', 'hand')
    addMana(s, A, 'C', 3)
    act(s, A, { type: 'r.cast', objId: coat, targets: [] })
    until(s, (x) => x.pending?.kind === 'trigger' && x.pending.player === A, 'its ETB target')
    act(s, A, { type: 'r.chooseTargets', targets: [target] })
    until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'it attaches')
    return coat
  }

  it('attaches itself to your legendary creature and grants indestructible', () => {
    const { state, A } = makeDuel()
    const legend = putCard(state, A, 'Isamaru, Hound of Konda', 'battlefield') // legendary 2/2
    toStep(state, 'main1')
    const coat = cast(state, A, legend)
    expect(state.objects[coat]!.attachedTo).toBe(legend)
    expect(currentPT(state, state.objects[legend]!)).toEqual({ power: 2, toughness: 3 }) // +0/+1
    expect(currentKeywords(state, state.objects[legend]!)).toContain('indestructible')
    // …so a Bolt no longer kills it
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [legend] })
    until(state, (s) => !s.zones.stack.length, 'the Bolt resolves')
    expect(state.objects[legend]!.zone).toBe('battlefield')
  })

  it('only targets a LEGENDARY creature you control', () => {
    const { state, A, B } = makeDuel()
    const plain = putCard(state, A, 'Grizzly Bears', 'battlefield') // not legendary
    const theirLegend = putCard(state, B, 'Isamaru, Hound of Konda', 'battlefield')
    const mine = putCard(state, A, 'Isamaru, Hound of Konda', 'battlefield')
    toStep(state, 'main1')
    const coat = putCard(state, A, 'Mithril Coat', 'hand')
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.cast', objId: coat, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'its ETB target')
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [plain] })).toThrow(/BAD_TARGETS|Illegal target/i)
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [theirLegend] })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, A, { type: 'r.chooseTargets', targets: [mine] })
    until(state, (s) => !s.zones.stack.length, 'it attaches')
    expect(state.objects[coat]!.attachedTo).toBe(mine)
  })

  it('has flash', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Isamaru, Hound of Konda', 'battlefield')
    const coat = putCard(state, A, 'Mithril Coat', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    until(state, (s) => s.activePlayer === B && s.priorityPlayer === A, "A has priority on B's turn")
    addMana(state, A, 'C', 3)
    expect(computeLegal(state, A).castableIds).toContain(coat)
  })

  it('can still be moved with its equip ability', () => {
    const { state, A } = makeDuel()
    const first = putCard(state, A, 'Isamaru, Hound of Konda', 'battlefield')
    const second = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    const coat = cast(state, A, first)
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.equip', equipmentId: coat, creatureId: second })
    expect(state.objects[coat]!.attachedTo).toBe(second) // equip may move it to ANY creature you control
    expect(currentKeywords(state, state.objects[second]!)).toContain('indestructible')
  })
})
