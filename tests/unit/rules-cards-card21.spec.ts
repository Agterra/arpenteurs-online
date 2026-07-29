/**
 * Perpetual card coverage — batch CARD21: the ten Talismans (the pain-land shape on an artifact),
 * the five battle lands ("enters tapped unless you control two or more BASIC lands"),
 * Sakura-Tribe Elder (a sac-self fetch on a creature) and the "free if you control a commander"
 * spells (Fierce Guardianship, Deadly Rollick).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

const TALISMANS: [string, ManaColor, ManaColor][] = [
  ['Talisman of Dominance', 'U', 'B'],
  ['Talisman of Creativity', 'U', 'R'],
  ['Talisman of Indulgence', 'B', 'R'],
  ['Talisman of Hierarchy', 'W', 'B'],
  ['Talisman of Progress', 'W', 'U'],
  ['Talisman of Conviction', 'R', 'W'],
  ['Talisman of Curiosity', 'G', 'U'],
  ['Talisman of Resilience', 'B', 'G'],
  ['Talisman of Impulse', 'R', 'G'],
  ['Talisman of Unity', 'G', 'W'],
]

const BATTLE: [string, ManaColor, string][] = [
  ['Cinder Glade', 'R', 'Mountain'],
  ['Sunken Hollow', 'U', 'Island'],
  ['Smoldering Marsh', 'B', 'Swamp'],
  ['Canopy Vista', 'G', 'Forest'],
  ['Prairie Stream', 'W', 'Plains'],
]

describe('CARD21 — the ten Talismans', () => {
  for (const [name, a, b] of TALISMANS) {
    it(`${name}: {C} is free, {${a}}/{${b}} costs 1 life`, () => {
      const { state, A } = makeDuel()
      const free = putCard(state, A, name, 'battlefield')
      const painful = putCard(state, A, name, 'battlefield')
      toStep(state, 'main1')
      const life = state.players[A]!.life
      act(state, A, { type: 'r.tapMana', objId: free, color: 'C' })
      expect(state.players[A]!.manaPool.C).toBe(1)
      expect(state.players[A]!.life).toBe(life)
      act(state, A, { type: 'r.tapMana', objId: painful, color: b })
      expect(state.players[A]!.manaPool[b]).toBe(1)
      expect(state.players[A]!.life).toBe(life - 1)
    })
  }

  it('a Talisman cannot make a colour outside its pair', () => {
    const { state, A } = makeDuel()
    const t = putCard(state, A, 'Talisman of Dominance', 'battlefield') // U/B
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.tapMana', objId: t, color: 'G' })).toThrow(/can't make \{G\}/i)
  })
})

describe('CARD21 — the five battle lands', () => {
  for (const [land, colour, basic] of BATTLE) {
    it(`${land}: tapped below two basics, untapped at two`, () => {
      const { state, A } = makeDuel()
      putCard(state, A, 'Mountain', 'battlefield') // only ONE basic
      const first = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: first })
      expect(state.objects[first]!.tapped).toBe(true)
      // a second basic makes the next copy enter untapped
      putCard(state, A, basic, 'battlefield')
      const second = putCard(state, A, land, 'hand')
      until(state, (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A, "A's next turn")
      act(state, A, { type: 'r.playLand', objId: second })
      expect(state.objects[second]!.tapped).toBe(false)
      act(state, A, { type: 'r.tapMana', objId: second, color: colour })
      expect(state.players[A]!.manaPool[colour]).toBe(1)
    })
  }

  it('NONbasic lands do not count toward the two', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Watery Grave', 'battlefield') // a nonbasic Island Swamp
    putCard(state, A, 'Sulfur Falls', 'battlefield') // a nonbasic with no basic types at all
    const glade = putCard(state, A, 'Cinder Glade', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: glade })
    expect(state.objects[glade]!.tapped).toBe(true)
  })
})

describe('CARD21 — Sakura-Tribe Elder', () => {
  it('sacrifices itself (no {T}) to fetch a basic land tapped, even while summoning sick', () => {
    const { state, A } = makeDuel()
    const elder = putCard(state, A, 'Sakura-Tribe Elder', 'battlefield')
    state.objects[elder]!.summoningSick = true
    toStep(state, 'main1')
    act(state, A, { type: 'r.activate', objId: elder, abilityIndex: 0, targets: [] })
    expect(state.objects[elder]!.zone).toBe('graveyard') // sacrificed as the cost
    until(state, (s) => s.pending?.kind === 'search', 'the fetch search')
    const pick = state.pendingSearch!.matchIds[0]!
    act(state, A, { type: 'r.search', cardIds: [pick] })
    expect(state.objects[pick]!.zone).toBe('battlefield')
    expect(state.objects[pick]!.tapped).toBe(true)
  })
})

describe('CARD21 — free casts with a commander', () => {
  /** put A's commander onto the battlefield (the condition is a commander you CONTROL) */
  const commanderOut = (s: St, A: PlayerId) => {
    const cmd = s.players[A]!.commanderId!
    s.zones.perPlayer[A]!.command = []
    s.objects[cmd]!.zone = 'battlefield'
    s.zones.perPlayer[A]!.battlefield.push(cmd)
    return cmd
  }

  it('Fierce Guardianship counters for free while you control a commander', () => {
    const { state, A, B } = makeDuel()
    commanderOut(state, A)
    const fg = putCard(state, A, 'Fierce Guardianship', 'hand')
    const shock = putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    pass(state, B)
    expect(computeLegal(state, A).freeCastable).toContain(fg)
    act(state, A, { type: 'r.cast', objId: fg, targets: [shock], free: true }) // no mana floated at all
    resolve(state, A)
    expect(state.objects[shock]!.zone).toBe('graveyard')
    expect(state.players[A]!.life).toBe(40)
  })

  it('without a commander on the battlefield the free cast is refused and not offered', () => {
    const { state, A, B } = makeDuel()
    const fg = putCard(state, A, 'Fierce Guardianship', 'hand')
    const shock = putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    pass(state, B)
    expect(computeLegal(state, A).freeCastable).toEqual([])
    expect(() => act(state, A, { type: 'r.cast', objId: fg, targets: [shock], free: true })).toThrow(/NO_COMMANDER|control no commander/i)
  })

  it('it can still be cast the normal way by paying {2}{U}', () => {
    const { state, A, B } = makeDuel()
    const fg = putCard(state, A, 'Fierce Guardianship', 'hand')
    const shock = putCard(state, B, 'Shock', 'hand')
    toStep(state, 'main1')
    pass(state, A)
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    pass(state, B)
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: fg, targets: [shock] })
    resolve(state, A)
    expect(state.objects[shock]!.zone).toBe('graveyard')
  })

  it('Deadly Rollick exiles a creature for free', () => {
    const { state, A, B } = makeDuel()
    commanderOut(state, A)
    const rollick = putCard(state, A, 'Deadly Rollick', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.cast', objId: rollick, targets: [bear], free: true })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('exile')
  })

  it('a card with no free cast rejects the flag', () => {
    const { state, A } = makeDuel()
    commanderOut(state, A)
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.cast', objId: bolt, targets: [A], free: true })).toThrow(/NO_FREE_CAST|no free cast/i)
  })
})
