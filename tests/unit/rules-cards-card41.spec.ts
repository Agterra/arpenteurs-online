/**
 * Perpetual card coverage — batch CARD41: "any target" finally includes PLANESWALKERS (CR 115.4) —
 * damage to one removes loyalty (CR 120.3c) — which every implemented burn spell inherits, plus
 * Boros Charm ("target player or planeswalker" = an any-target whose permanent side excludes
 * creatures) and Return of the Wildspeaker (non-Human power / mass pump).
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
/** a planeswalker on the battlefield with its printed starting loyalty */
const putPw = (s: St, p: PlayerId) => {
  const pw = putCard(s, p, 'Nissa, Voice of Zendikar', 'battlefield')
  s.objects[pw]!.loyalty = 3
  return pw
}

describe('CARD41 — burn spells can hit a planeswalker', () => {
  it('Shock removes 2 loyalty', () => {
    const { state, A, B } = makeDuel()
    const pw = putPw(state, B)
    const shock = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [pw] })
    resolve(state, A)
    expect(state.objects[pw]!.loyalty).toBe(1)
    expect(state.objects[pw]!.zone).toBe('battlefield')
    expect(state.log.some((l) => /loses 2 loyalty/.test(l))).toBe(true)
  })

  it('enough damage kills it by state-based action', () => {
    const { state, A, B } = makeDuel()
    const pw = putPw(state, B)
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [pw] })
    resolve(state, A)
    expect(state.objects[pw]!.zone).toBe('graveyard') // 3 damage → 0 loyalty → CR 704.5i
  })

  it('an X spell scales, and your OWN planeswalker is a legal target', () => {
    const { state, A } = makeDuel()
    const mine = putPw(state, A)
    const blaze = putCard(state, A, 'Blaze', 'hand') // {X}{R}: X damage to any target
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: blaze, targets: [mine], x: 2 })
    resolve(state, A)
    expect(state.objects[mine]!.loyalty).toBe(1)
  })

  it('a hexproof-granting effect still protects it from an opponent', () => {
    const { state, A, B } = makeDuel()
    const pw = putPw(state, B)
    const heroic = putCard(state, B, 'Heroic Intervention', 'hand') // your permanents gain hexproof
    toStep(state, 'main1')
    pass(state, A) // B holds priority during A's turn and answers at instant speed
    addMana(state, B, 'G', 1)
    addMana(state, B, 'C', 1)
    act(state, B, { type: 'r.cast', objId: heroic, targets: [] })
    resolve(state, A)
    const shock = putCard(state, A, 'Shock', 'hand')
    addMana(state, A, 'R', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: shock, targets: [pw] })).toThrow(/BAD_TARGETS|Illegal target/i)
    expect(state.objects[pw]!.loyalty).toBe(3)
  })
})

describe('CARD41 — Boros Charm', () => {
  const castCharm = (s: St, A: PlayerId, mode: number, targets: (ObjId | PlayerId)[] = []) => {
    const charm = putCard(s, A, 'Boros Charm', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'R', 1)
    addMana(s, A, 'W', 1)
    act(s, A, { type: 'r.cast', objId: charm, targets, mode })
    return charm
  }

  it('mode 0 burns a player for 4', () => {
    const { state, A, B } = makeDuel()
    castCharm(state, A, 0, [B])
    resolve(state, A)
    expect(state.players[B]!.life).toBe(36)
  })

  it('mode 0 burns a planeswalker but REFUSES a creature', () => {
    const { state, A, B } = makeDuel()
    const pw = putPw(state, B)
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const charm = putCard(state, A, 'Boros Charm', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'W', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: charm, targets: [bear], mode: 0 })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, A, { type: 'r.cast', objId: charm, targets: [pw], mode: 0 })
    resolve(state, A)
    expect(state.objects[pw]!.zone).toBe('graveyard') // 4 damage vs 3 loyalty
    expect(state.objects[bear]!.zone).toBe('battlefield')
  })

  it('mode 1 makes ALL your permanents indestructible (lands included)', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const land = putCard(state, A, 'Mountain', 'battlefield')
    const theirBear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    castCharm(state, A, 1)
    resolve(state, A)
    const kw = (id: ObjId) => (state.keywordGrants ?? []).filter((g) => g.objId === id).map((g) => g.keyword)
    expect(kw(bear)).toEqual(['indestructible'])
    expect(kw(land)).toEqual(['indestructible'])
    expect(kw(theirBear)).toEqual([])
  })

  it('mode 2 gives one creature double strike — and doubles its combat damage', () => {
    const { state, A, B } = makeDuel()
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield') // 2/2
    state.objects[ogre]!.summoningSick = false
    castCharm(state, A, 2, [ogre])
    resolve(state, A)
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [ogre])
    until(state, (s) => s.players[B]!.life !== 40, 'combat damage')
    expect(state.players[B]!.life).toBe(36)
  })

  it('is castable with nothing on the board (a player is always a legal mode-0 target)', () => {
    const { state, A } = makeDuel()
    const charm = putCard(state, A, 'Boros Charm', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    addMana(state, A, 'W', 1)
    expect(computeLegal(state, A).castableIds).toContain(charm)
  })
})

describe('CARD41 — Return of the Wildspeaker', () => {
  const cast = (s: St, A: PlayerId, mode: number) => {
    const spell = putCard(s, A, 'Return of the Wildspeaker', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'G', 1)
    addMana(s, A, 'C', 4)
    act(s, A, { type: 'r.cast', objId: spell, targets: [], mode })
    resolve(s, A)
    return spell
  }

  it('draws cards equal to the greatest power among your NON-HUMAN creatures', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Grizzly Bears', 'battlefield') // Bear 2/2
    putCard(state, A, 'Serra Angel', 'battlefield') // Angel 4/4 — the greatest
    putCard(state, A, 'Loran of the Third Path', 'battlefield') // HUMAN — excluded
    putCard(state, B, 'Rampaging Baloths', 'battlefield') // theirs — excluded
    toStep(state, 'main1')
    const before = state.zones.perPlayer[A]!.hand.length
    cast(state, A, 0)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before + 4) // the spell is added then cast: net +4 drawn
    expect(state.log.some((l) => /draws 4 cards \(greatest power among their non-Human creatures\)/.test(l))).toBe(true)
  })

  it('counts a PUMPED creature at its current power', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    state.pumps.push({ objId: bear, power: 3, toughness: 3 }) // 5/5 right now
    toStep(state, 'main1')
    const before = state.zones.perPlayer[A]!.hand.length
    cast(state, A, 0)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before + 5)
  })

  it('draws nothing with only Humans (and does not crash)', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Loran of the Third Path', 'battlefield')
    toStep(state, 'main1')
    const before = state.zones.perPlayer[A]!.hand.length
    cast(state, A, 0)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before) // nothing drawn; the spell came and went
  })

  it('mode 1 pumps your non-Human creatures only', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const human = putCard(state, A, 'Loran of the Third Path', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    cast(state, A, 1)
    const pumpOf = (id: ObjId) => state.pumps.filter((p) => p.objId === id).reduce((n, p) => n + p.power, 0)
    expect(pumpOf(bear)).toBe(3)
    expect(pumpOf(human)).toBe(0)
    expect(pumpOf(theirs)).toBe(0)
    expect(state.log.some((l) => /1 creature .* get \+3\/\+3/.test(l))).toBe(true)
  })
})
