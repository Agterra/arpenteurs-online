/**
 * Perpetual card coverage — batch CARD23: the Battlebond lands ("unless you have two or more
 * OPPONENTS"), the slow lands ("unless you control two or more OTHER lands"), Prismatic Vista,
 * Cabal Coffers (count-based mana), Blood Artist (a this-or-another dies drain) and Stroke of
 * Midnight.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, makeGameN, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

const BOND: [string, ManaColor][] = [
  ['Morphic Pool', 'U'],
  ['Rejuvenating Springs', 'G'],
  ['Training Center', 'R'],
  ['Luxury Suite', 'B'],
  ['Sea of Clouds', 'W'],
  ['Vault of Champions', 'B'],
  ['Spectator Seating', 'R'],
  ['Undergrowth Stadium', 'G'],
  ['Spire Garden', 'R'],
  ['Bountiful Promenade', 'W'],
]
const SLOW: [string, ManaColor][] = [
  ['Dreamroot Cascade', 'U'],
  ['Stormcarved Coast', 'R'],
  ['Rockfall Vale', 'G'],
  ['Shipwreck Marsh', 'B'],
  ['Deserted Beach', 'W'],
  ['Haunted Ridge', 'R'],
  ['Sundown Pass', 'W'],
  ['Shattered Sanctum', 'B'],
  ['Overgrown Farmland', 'G'],
  ['Deathcap Glade', 'G'],
]

describe('CARD23 — the ten Battlebond lands', () => {
  for (const [land, colour] of BOND) {
    it(`${land}: tapped in a duel, untapped with two opponents`, () => {
      const duel = makeDuel()
      const inDuel = putCard(duel.state, duel.A, land, 'hand')
      toStep(duel.state, 'main1')
      act(duel.state, duel.A, { type: 'r.playLand', objId: inDuel })
      expect(duel.state.objects[inDuel]!.tapped).toBe(true) // one opponent only
      // a three-player game gives the same land two opponents
      const { state, players } = makeGameN(3)
      const A = state.activePlayer
      const multi = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: multi })
      expect(players.length).toBe(3)
      expect(state.objects[multi]!.tapped).toBe(false)
      act(state, A, { type: 'r.tapMana', objId: multi, color: colour })
      expect(state.players[A]!.manaPool[colour]).toBe(1)
    })
  }

  it('a dead opponent no longer counts', () => {
    const { state } = makeGameN(3)
    const A = state.activePlayer
    const foes = state.turnOrder.filter((p) => p !== A)
    state.players[foes[0]!]!.hasLost = true // down to one live opponent
    const land = putCard(state, A, 'Morphic Pool', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: land })
    expect(state.objects[land]!.tapped).toBe(true)
  })
})

describe('CARD23 — the ten slow lands', () => {
  for (const [land, colour] of SLOW) {
    it(`${land}: tapped with one other land, untapped with two`, () => {
      const { state, A } = makeDuel()
      putCard(state, A, 'Mountain', 'battlefield')
      const first = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: first })
      expect(state.objects[first]!.tapped).toBe(true) // only ONE other land
      const second = putCard(state, A, land, 'hand')
      until(state, (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A, "A's next turn")
      act(state, A, { type: 'r.playLand', objId: second }) // now the Mountain + the first copy
      expect(state.objects[second]!.tapped).toBe(false)
      act(state, A, { type: 'r.tapMana', objId: second, color: colour })
      expect(state.players[A]!.manaPool[colour]).toBe(1)
    })
  }

  it('counts ANY other lands, basic or not (unlike the battle lands)', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Sulfur Falls', 'battlefield') // two nonbasics
    putCard(state, A, 'Watery Grave', 'battlefield')
    const cascade = putCard(state, A, 'Dreamroot Cascade', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: cascade })
    expect(state.objects[cascade]!.tapped).toBe(false)
  })
})

describe('CARD23 — Prismatic Vista and Cabal Coffers', () => {
  it('Prismatic Vista pays {T} + 1 life + itself and fetches a basic UNTAPPED', () => {
    const { state, A } = makeDuel()
    const vista = putCard(state, A, 'Prismatic Vista', 'battlefield')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.activate', objId: vista, abilityIndex: 0, targets: [] })
    expect(state.players[A]!.life).toBe(life - 1)
    expect(state.objects[vista]!.zone).toBe('graveyard')
    until(state, (s) => s.pending?.kind === 'search', 'the fetch search')
    const pick = state.pendingSearch!.matchIds[0]!
    act(state, A, { type: 'r.search', cardIds: [pick] })
    expect(state.objects[pick]!.zone).toBe('battlefield')
    expect(state.objects[pick]!.tapped).toBe(false)
  })

  it('Cabal Coffers adds one {B} per Swamp you control', () => {
    const { state, A, B } = makeDuel()
    const coffers = putCard(state, A, 'Cabal Coffers', 'battlefield')
    for (let i = 0; i < 3; i++) putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Watery Grave', 'battlefield') // a nonbasic WITH the Swamp type — counts
    putCard(state, B, 'Swamp', 'battlefield') // an opponent's Swamp — does not
    toStep(state, 'main1')
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.tapMana', objId: coffers })
    expect(state.players[A]!.manaPool.B).toBe(4)
    expect(state.players[A]!.manaPool.C).toBe(0) // the {2} was paid
  })

  it('Cabal Coffers adds nothing with no Swamps, and still needs the {2}', () => {
    const { state, A } = makeDuel()
    const coffers = putCard(state, A, 'Cabal Coffers', 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.tapMana', objId: coffers })).toThrow(/Not enough mana/)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.tapMana', objId: coffers })
    expect(state.players[A]!.manaPool.B).toBe(0)
  })
})

describe('CARD23 — Blood Artist and Stroke of Midnight', () => {
  it('Blood Artist drains when ANOTHER creature dies', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Blood Artist', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const shock = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [bear] })
    // the dies trigger targets a player — the harness answers with a legal opponent
    until(state, (s) => s.players[B]!.life !== 40 || (!s.zones.stack.length && s.priorityPlayer === A), 'the drain')
    expect(state.players[B]!.life).toBe(39)
    expect(state.players[A]!.life).toBe(41)
  })

  it('Blood Artist drains on ITS OWN death too (this or another)', () => {
    const { state, A, B } = makeDuel()
    const artist = putCard(state, A, 'Blood Artist', 'battlefield')
    const shock = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [artist] }) // 0/1 → dies
    until(state, (s) => s.players[B]!.life !== 40 || (!s.zones.stack.length && s.priorityPlayer === A), 'the drain')
    expect(state.objects[artist]!.zone).toBe('graveyard')
    expect(state.players[B]!.life).toBe(39)
    expect(state.players[A]!.life).toBe(41)
  })

  it('Stroke of Midnight destroys a nonland permanent and gives its controller a 1/1 Human', () => {
    const { state, A, B } = makeDuel()
    const stroke = putCard(state, A, 'Stroke of Midnight', 'hand')
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: stroke, targets: [rock] })
    resolve(state, A)
    expect(state.objects[rock]!.zone).toBe('graveyard')
    const humans = state.zones.perPlayer[B]!.battlefield.filter((id) => getDef(state.objects[id]!.defName).name === 'Human')
    expect(humans.length).toBe(1)
  })

  it('Stroke of Midnight cannot target a land', () => {
    const { state, A, B } = makeDuel()
    const stroke = putCard(state, A, 'Stroke of Midnight', 'hand')
    const land = putCard(state, B, 'Mountain', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 2)
    expect(() => act(state, A, { type: 'r.cast', objId: stroke, targets: [land] })).toThrow(/BAD_TARGETS|Illegal target/i)
  })
})
