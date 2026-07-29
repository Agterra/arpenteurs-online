/**
 * Perpetual card coverage — batch CARD40: MULTI-mode spells (CR 700.2) — "Choose two" (Austere
 * Command), "Choose one or more" (Farewell) and "Choose one; both if you control a commander"
 * (Akroma's Will). The chosen modes always resolve in PRINTED order, whatever order they came in.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
/** float the mana for a {4}{W}{W} sweeper */
const payBig = (s: St, A: PlayerId) => {
  addMana(s, A, 'W', 2)
  addMana(s, A, 'C', 4)
}

describe('CARD40 — Austere Command ("choose two")', () => {
  const board = (s: St, A: PlayerId, B: PlayerId) => ({
    rock: putCard(s, A, 'Sol Ring', 'battlefield'), // artifact, MV 1
    ench: putCard(s, B, 'Glorious Anthem', 'battlefield'), // enchantment
    small: putCard(s, A, 'Grizzly Bears', 'battlefield'), // creature MV 2
    big: putCard(s, B, 'Serra Angel', 'battlefield'), // creature MV 5
  })

  it('destroys exactly the two chosen categories', () => {
    const { state, A, B } = makeDuel()
    const ids = board(state, A, B)
    const cmd = putCard(state, A, 'Austere Command', 'hand')
    toStep(state, 'main1')
    payBig(state, A)
    act(state, A, { type: 'r.cast', objId: cmd, targets: [], modes: [0, 3] }) // artifacts + big creatures
    resolve(state, A)
    expect(state.objects[ids.rock]!.zone).toBe('graveyard')
    expect(state.objects[ids.big]!.zone).toBe('graveyard')
    expect(state.objects[ids.ench]!.zone).toBe('battlefield')
    expect(state.objects[ids.small]!.zone).toBe('battlefield')
  })

  it('splits creatures by mana value (3 or less / 4 or greater)', () => {
    const { state, A, B } = makeDuel()
    const ids = board(state, A, B)
    const cmd = putCard(state, A, 'Austere Command', 'hand')
    toStep(state, 'main1')
    payBig(state, A)
    act(state, A, { type: 'r.cast', objId: cmd, targets: [], modes: [1, 2] }) // enchantments + cheap creatures
    resolve(state, A)
    expect(state.objects[ids.small]!.zone).toBe('graveyard')
    expect(state.objects[ids.ench]!.zone).toBe('graveyard')
    expect(state.objects[ids.big]!.zone).toBe('battlefield')
    expect(state.objects[ids.rock]!.zone).toBe('battlefield') // an artifact, not a creature
  })

  it('demands exactly two DISTINCT modes', () => {
    const { state, A } = makeDuel()
    const cmd = putCard(state, A, 'Austere Command', 'hand')
    toStep(state, 'main1')
    payBig(state, A)
    for (const modes of [undefined, [0], [0, 1, 2]]) {
      expect(() => act(state, A, { type: 'r.cast', objId: cmd, targets: [], modes })).toThrow(/Choose exactly 2 modes/)
    }
    expect(() => act(state, A, { type: 'r.cast', objId: cmd, targets: [], modes: [1, 1] })).toThrow(/only once/)
    expect(() => act(state, A, { type: 'r.cast', objId: cmd, targets: [], modes: [0, 9] })).toThrow(/valid mode/)
    expect(state.objects[cmd]!.zone).toBe('hand') // nothing was spent on a rejected cast
  })

  it('spares indestructible permanents but still resolves', () => {
    const { state, A, B } = makeDuel()
    const citadel = putCard(state, B, 'Darksteel Citadel', 'battlefield') // indestructible artifact
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')
    const cmd = putCard(state, A, 'Austere Command', 'hand')
    toStep(state, 'main1')
    payBig(state, A)
    act(state, A, { type: 'r.cast', objId: cmd, targets: [], modes: [0, 1] })
    resolve(state, A)
    expect(state.objects[citadel]!.zone).toBe('battlefield')
    expect(state.objects[rock]!.zone).toBe('graveyard')
    expect(state.objects[cmd]!.zone).toBe('graveyard')
  })
})

describe('CARD40 — Farewell ("choose one or more")', () => {
  it('exiles every chosen category, graveyards included', () => {
    const { state, A, B } = makeDuel()
    const rock = putCard(state, A, 'Sol Ring', 'battlefield')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const ench = putCard(state, A, 'Glorious Anthem', 'battlefield')
    const deadMine = putCard(state, A, 'Shock', 'graveyard')
    const deadTheirs = putCard(state, B, 'Shock', 'graveyard')
    const farewell = putCard(state, A, 'Farewell', 'hand')
    toStep(state, 'main1')
    payBig(state, A)
    act(state, A, { type: 'r.cast', objId: farewell, targets: [], modes: [0, 1, 3] }) // artifacts, creatures, graveyards
    resolve(state, A)
    expect(state.objects[rock]!.zone).toBe('exile')
    expect(state.objects[bear]!.zone).toBe('exile')
    expect(state.objects[deadMine]!.zone).toBe('exile')
    expect(state.objects[deadTheirs]!.zone).toBe('exile')
    expect(state.objects[ench]!.zone).toBe('battlefield') // that mode was not chosen
    // Farewell itself went to the graveyard AFTER the sweep (it was on the stack during it)
    expect(state.objects[farewell]!.zone).toBe('graveyard')
  })

  it('accepts a single mode and refuses none at all', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const farewell = putCard(state, A, 'Farewell', 'hand')
    toStep(state, 'main1')
    payBig(state, A)
    expect(() => act(state, A, { type: 'r.cast', objId: farewell, targets: [], modes: [] })).toThrow(/Choose 1 to 4 modes/)
    act(state, A, { type: 'r.cast', objId: farewell, targets: [], modes: [1] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('exile')
  })

  it('exile ignores indestructible', () => {
    const { state, A, B } = makeDuel()
    const citadel = putCard(state, B, 'Darksteel Citadel', 'battlefield')
    const farewell = putCard(state, A, 'Farewell', 'hand')
    toStep(state, 'main1')
    payBig(state, A)
    act(state, A, { type: 'r.cast', objId: farewell, targets: [], modes: [0] })
    resolve(state, A)
    expect(state.objects[citadel]!.zone).toBe('exile')
  })
})

describe("CARD40 — Akroma's Will (\"both if you control a commander\")", () => {
  const rigCommander = (s: St, p: PlayerId) => {
    const cmd = putCard(s, p, 'Loran of the Third Path', 'battlefield')
    s.players[p]!.commanderId = cmd
    s.objects[cmd]!.isCommander = true
    return cmd
  }
  const castWill = (s: St, A: PlayerId, modes: number[]) => {
    const will = putCard(s, A, "Akroma's Will", 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'W', 1)
    addMana(s, A, 'C', 3)
    act(s, A, { type: 'r.cast', objId: will, targets: [], modes })
    resolve(s, A)
    return will
  }

  it('grants flying, vigilance and double strike to your creatures only', () => {
    const { state, A, B } = makeDuel()
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const myLand = putCard(state, A, 'Mountain', 'battlefield')
    castWill(state, A, [0])
    const kw = (id: ObjId) => (state.keywordGrants ?? []).filter((g) => g.objId === id).map((g) => g.keyword)
    expect(kw(mine).sort()).toEqual(['double strike', 'flying', 'vigilance'])
    expect(kw(theirs)).toEqual([])
    expect(kw(myLand)).toEqual([]) // creatures only — a land is untouched
  })

  it('the second mode makes your creatures survive a wipe (indestructible + protection)', () => {
    const { state, A, B } = makeDuel()
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    castWill(state, A, [1])
    expect(state.protectionGrants.filter((g) => g.objId === mine).map((g) => g.color).sort()).toEqual(['B', 'G', 'R', 'U', 'W'])
    const wrath = putCard(state, A, 'Wrath of God', 'hand')
    addMana(state, A, 'W', 2)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: wrath, targets: [] })
    resolve(state, A)
    expect(state.objects[mine]!.zone).toBe('battlefield')
    expect(state.objects[theirs]!.zone).toBe('graveyard')
  })

  it('refuses BOTH modes without a commander, and allows them with one', () => {
    const { state, A } = makeDuel()
    const will = putCard(state, A, "Akroma's Will", 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 3)
    expect(() => act(state, A, { type: 'r.cast', objId: will, targets: [], modes: [0, 1] })).toThrow(/Choose exactly 1 mode/)
    rigCommander(state, A)
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    act(state, A, { type: 'r.cast', objId: will, targets: [], modes: [0, 1] })
    resolve(state, A)
    const kw = (state.keywordGrants ?? []).filter((g) => g.objId === bear).map((g) => g.keyword)
    expect(kw.sort()).toEqual(['double strike', 'flying', 'indestructible', 'lifelink', 'vigilance'])
    expect(state.protectionGrants.some((g) => g.objId === bear)).toBe(true)
  })

  it('resolves its modes in PRINTED order however they were picked', () => {
    const { state, A } = makeDuel()
    rigCommander(state, A)
    putCard(state, A, 'Grizzly Bears', 'battlefield')
    castWill(state, A, [1, 0]) // picked second-then-first
    const order = state.log.filter((l) => /Akroma's Will —/.test(l))
    expect(order.length).toBe(2)
    expect(order[0]).toMatch(/Flying, vigilance and double strike/)
    expect(order[1]).toMatch(/Lifelink, protection from all colors/)
  })

  it('double strike from the first mode really doubles combat damage', () => {
    const { state, A, B } = makeDuel()
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield') // 2/2
    state.objects[ogre]!.summoningSick = false
    castWill(state, A, [0])
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [ogre])
    until(state, (s) => s.players[B]!.life !== 40, 'combat damage')
    expect(state.players[B]!.life).toBe(36) // 2 first-strike + 2 regular
  })
})
