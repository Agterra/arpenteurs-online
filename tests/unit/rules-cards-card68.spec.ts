/**
 * Perpetual card coverage — batch CARD68, three top-400 cards, each a mechanic the engine lacked:
 *  - Wild Growth — a triggered MANA ability on an Aura ("whenever enchanted land is tapped for mana,
 *    its controller adds {G}"), which per CR 605.1b never uses the stack.
 *  - Everflowing Chalice — MULTIKICKER (CR 702.33b): the kicker paid any number of times, one charge
 *    counter per payment, and a mana ability whose output is that counter count.
 *  - Rhythm of the Wild — a static that makes your creature spells uncounterable, plus RIOT
 *    (CR 702.137) granted to them: a +1/+1 counter or haste as each one enters.
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

describe('CARD68 — Wild Growth', () => {
  /** enchant a Mountain of A's with Wild Growth */
  const rig = (s: St, A: PlayerId) => {
    const land = putCard(s, A, 'Mountain', 'battlefield')
    const aura = putCard(s, A, 'Wild Growth', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'G', 1)
    act(s, A, { type: 'r.cast', objId: aura, targets: [land] })
    until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'it resolves')
    return { land, aura }
  }

  it('adds {G} on top of the land\'s own mana when that land is tapped', () => {
    const { state, A } = makeDuel()
    const { land, aura } = rig(state, A)
    expect(state.objects[aura]!.attachedTo).toBe(land)
    act(state, A, { type: 'r.tapMana', objId: land, color: 'R' })
    expect(state.players[A]!.manaPool.R).toBe(1) // the Mountain's own mana
    expect(state.players[A]!.manaPool.G).toBe(1) // …plus Wild Growth's
    expect(state.log.some((l) => /Wild Growth adds 1 \{G\}/.test(l))).toBe(true)
  })

  it('needs no stack: the mana is there before anyone gets priority again', () => {
    const { state, A } = makeDuel()
    const { land } = rig(state, A)
    act(state, A, { type: 'r.tapMana', objId: land, color: 'R' })
    expect(state.zones.stack.length).toBe(0) // CR 605.1b — a triggered mana ability never uses the stack
    expect(state.players[A]!.manaPool.G).toBe(1)
  })

  it('only enchants a LAND, and stops when it leaves', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const aura = putCard(state, A, 'Wild Growth', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: aura, targets: [bear] })).toThrow(/BAD_TARGETS|Illegal target/i)
    // …on a land it works, and destroying the Aura stops the extra mana
    const { land, aura: live } = rig(state, A)
    act(state, A, { type: 'r.mMove', objId: live, zone: 'graveyard' })
    state.objects[land]!.tapped = false
    const before = state.players[A]!.manaPool.G // the failed cast above left its {G} floating
    act(state, A, { type: 'r.tapMana', objId: land, color: 'R' })
    expect(state.players[A]!.manaPool.G).toBe(before)
  })

  it("the mana goes to the LAND's controller, not the Aura's", () => {
    const { state, A, B } = makeDuel()
    const theirLand = putCard(state, B, 'Mountain', 'battlefield')
    const aura = putCard(state, A, 'Wild Growth', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.cast', objId: aura, targets: [theirLand] })
    until(state, (s) => !s.zones.stack.length, 'it resolves')
    pass(state, A)
    act(state, B, { type: 'r.tapMana', objId: theirLand, color: 'R' })
    expect(state.players[B]!.manaPool.G).toBe(1) // B's land → B's pool
    expect(state.players[A]!.manaPool.G).toBe(0)
  })
})

describe('CARD68 — Everflowing Chalice (multikicker)', () => {
  const castKicked = (s: St, A: PlayerId, times: number) => {
    const chalice = putCard(s, A, 'Everflowing Chalice', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'C', 2 * times)
    act(s, A, { type: 'r.cast', objId: chalice, targets: [], kicked: times > 0, kickerCount: times })
    until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'it resolves')
    return chalice
  }

  it('enters with one charge counter per kick and taps for that much', () => {
    const { state, A } = makeDuel()
    const chalice = castKicked(state, A, 3)
    expect(state.objects[chalice]!.counters.charge).toBe(3)
    act(state, A, { type: 'r.tapMana', objId: chalice, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(3)
  })

  it('unkicked it costs {0}, enters bare and makes nothing', () => {
    const { state, A } = makeDuel()
    const chalice = castKicked(state, A, 0)
    expect(state.objects[chalice]!.counters.charge).toBeUndefined()
    act(state, A, { type: 'r.tapMana', objId: chalice, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(0)
  })

  it('charges {2} per kick and refuses more kicks than you can pay for', () => {
    const { state, A } = makeDuel()
    const chalice = putCard(state, A, 'Everflowing Chalice', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'C', 3) // enough for one kick, not two
    expect(() => act(state, A, { type: 'r.cast', objId: chalice, targets: [], kicked: true, kickerCount: 2 })).toThrow(/Not enough mana/)
    act(state, A, { type: 'r.cast', objId: chalice, targets: [], kicked: true, kickerCount: 1 })
    expect(state.players[A]!.manaPool.C).toBe(1) // 3 − 2
    until(state, (s) => !s.zones.stack.length, 'it resolves')
    expect(state.objects[chalice]!.counters.charge).toBe(1)
  })

  it('redact flags it as a MULTIkicker so the client offers a count', () => {
    const { state, A } = makeDuel()
    const chalice = putCard(state, A, 'Everflowing Chalice', 'hand')
    toStep(state, 'main1')
    const offer = computeLegal(state, A).kickable.find((k) => k.objId === chalice)
    expect(offer).toEqual({ objId: chalice, cost: '{2}', multi: true })
  })

  it('a single-kicker spell still refuses a count above one', () => {
    const { state, A, B } = makeDuel()
    const burst = putCard(state, A, 'Burst Lightning', 'hand') // kicker {4}, not multi
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 20)
    expect(() => act(state, A, { type: 'r.cast', objId: burst, targets: [B], kicked: true, kickerCount: 2 })).toThrow(/only be paid once/)
    expect(computeLegal(state, A).kickable.find((k) => k.objId === burst)?.multi).toBeUndefined()
  })
})

describe('CARD68 — Rhythm of the Wild', () => {
  const rig = (s: St, A: PlayerId) => {
    putCard(s, A, 'Rhythm of the Wild', 'battlefield')
    toStep(s, 'main1')
  }
  /** cast a Grizzly Bears and stop at the riot choice */
  const castBear = (s: St, A: PlayerId) => {
    const bear = putCard(s, A, 'Grizzly Bears', 'hand')
    addMana(s, A, 'G', 1)
    addMana(s, A, 'C', 1)
    act(s, A, { type: 'r.cast', objId: bear, targets: [] })
    until(s, (x) => x.pending?.kind === 'riot' && x.pending.player === A, 'the riot choice')
    return bear
  }

  it('asks for riot as each of your creature spells enters', () => {
    const { state, A } = makeDuel()
    rig(state, A)
    const bear = castBear(state, A)
    const legal = computeLegal(state, A)
    expect(legal.needsRiot).toBe(true)
    expect(legal.riotObjId).toBe(bear)
    expect(legal.riotSourceName).toBe('Grizzly Bears')
    act(state, A, { type: 'r.riot', haste: false })
    expect(state.objects[bear]!.counters['+1/+1']).toBe(1)
    expect(currentPT(state, state.objects[bear]!)).toEqual({ power: 3, toughness: 3 })
    expect(state.objects[bear]!.summoningSick).toBe(true) // it chose the counter, not haste
  })

  it('the haste half lets it attack the turn it arrives', () => {
    const { state, A } = makeDuel()
    rig(state, A)
    const bear = castBear(state, A)
    act(state, A, { type: 'r.riot', haste: true })
    expect(state.objects[bear]!.summoningSick).toBe(false)
    expect(state.objects[bear]!.counters['+1/+1']).toBeUndefined()
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    expect(computeLegal(state, A).declarableAttackerIds).toContain(bear)
  })

  it('makes your creature spells uncounterable, but not your other spells', () => {
    const { state, A, B } = makeDuel()
    rig(state, A)
    // a creature spell: Counterspell does nothing to it
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    const counter = putCard(state, B, 'Counterspell', 'hand')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    pass(state, A)
    addMana(state, B, 'U', 2)
    act(state, B, { type: 'r.cast', objId: counter, targets: [bear] })
    until(state, (s) => s.pending?.kind === 'riot' || !s.zones.stack.length, 'the Bears resolve anyway')
    expect(state.log.some((l) => /Grizzly Bears can't be countered/.test(l))).toBe(true)
    expect(state.objects[bear]!.zone).toBe('battlefield')
    act(state, A, { type: 'r.riot', haste: true })
    // …a NONcreature spell of A's is still counterable
    const shock = putCard(state, A, 'Shock', 'hand')
    const counter2 = putCard(state, B, 'Counterspell', 'hand')
    until(state, (s) => s.activePlayer === A && s.step === 'main2' && s.priorityPlayer === A, "A's second main")
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [B] })
    pass(state, A)
    addMana(state, B, 'U', 2)
    act(state, B, { type: 'r.cast', objId: counter2, targets: [shock] })
    until(state, (s) => !s.zones.stack.length, 'the Shock is countered')
    expect(state.objects[shock]!.zone).toBe('graveyard')
    expect(state.players[B]!.life).toBe(40)
  })

  it('gives riot to nothing an OPPONENT casts, and to no token', () => {
    const { state, A, B } = makeDuel()
    rig(state, A)
    // an opponent's creature spell asks nothing
    until(state, (s) => s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    const theirBear = putCard(state, B, 'Grizzly Bears', 'hand')
    addMana(state, B, 'G', 1)
    addMana(state, B, 'C', 1)
    act(state, B, { type: 'r.cast', objId: theirBear, targets: [] })
    until(state, (s) => !s.zones.stack.length, 'it resolves')
    expect(state.pending?.kind).not.toBe('riot')
    expect(state.objects[theirBear]!.counters['+1/+1']).toBeUndefined()
  })

  it('a creature that never was a spell (reanimated by hand) gets no riot', () => {
    const { state, A } = makeDuel()
    rig(state, A)
    const dead = putCard(state, A, 'Serra Angel', 'graveyard')
    act(state, A, { type: 'r.mMove', objId: dead, zone: 'battlefield' })
    expect(state.pending?.kind).not.toBe('riot')
    expect(nameOf(state, dead)).toBe('Serra Angel')
    expect(state.objects[dead]!.counters['+1/+1']).toBeUndefined()
  })

  it('riot is asked once per creature when two enter together', () => {
    const { state, A } = makeDuel()
    rig(state, A)
    const first = castBear(state, A)
    act(state, A, { type: 'r.riot', haste: true })
    const second = castBear(state, A)
    expect(second).not.toBe(first)
    act(state, A, { type: 'r.riot', haste: false })
    expect(currentKeywords(state, state.objects[first]!)).not.toContain('haste') // riot grants no keyword, it just clears the sickness
    expect(state.objects[first]!.summoningSick).toBe(false)
    expect(state.objects[second]!.counters['+1/+1']).toBe(1)
  })
})
