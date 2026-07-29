/**
 * Perpetual card coverage — batch CARD27: the ten "Snarl" reveal lands, Exploration (a STATIC extra
 * land drop), Morbid Opportunist (a once-per-turn dies trigger), Exsanguinate (an X drain),
 * Aetherize (mass bounce of attackers) and four more singles.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, makeGameN, putCard, rig, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

const REVEAL: [string, ManaColor, string][] = [
  ['Choked Estuary', 'B', 'Island'],
  ['Foreboding Ruins', 'R', 'Swamp'],
  ['Frostboil Snarl', 'R', 'Island'],
  ['Fortified Village', 'W', 'Forest'],
  ['Port Town', 'U', 'Plains'],
  ['Furycalm Snarl', 'W', 'Mountain'],
  ['Game Trail', 'G', 'Mountain'],
  ['Shineshadow Snarl', 'B', 'Plains'],
  ['Necroblossom Snarl', 'G', 'Swamp'],
  ['Vineglimmer Snarl', 'U', 'Forest'],
]

describe('CARD27 — the ten reveal ("Snarl") lands', () => {
  for (const [land, colour, basic] of REVEAL) {
    it(`${land}: tapped with nothing to reveal, untapped holding a ${basic}`, () => {
      const { state, A } = makeDuel()
      // the default deck is Mountain-heavy, so clear the hand first: the point is "nothing to reveal"
      rig(state, A, { hand: [], battlefield: [], librarySize: 20 })
      const bare = putCard(state, A, land, 'hand')
      toStep(state, 'main1')
      act(state, A, { type: 'r.playLand', objId: bare })
      expect(state.objects[bare]!.tapped).toBe(true) // the default deck holds no matching land
      // now hold the right basic and play a second copy next turn
      putCard(state, A, basic, 'hand')
      const shown = putCard(state, A, land, 'hand')
      until(state, (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A, "A's next turn")
      act(state, A, { type: 'r.playLand', objId: shown })
      expect(state.objects[shown]!.tapped).toBe(false)
      expect(state.log.some((l) => new RegExp(`reveals ${basic}`).test(l))).toBe(true)
      act(state, A, { type: 'r.tapMana', objId: shown, color: colour })
      expect(state.players[A]!.manaPool[colour]).toBe(1)
    })
  }

  it('a NONbasic land with the right type also satisfies the reveal', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Watery Grave', 'hand') // Island Swamp in hand
    const estuary = putCard(state, A, 'Choked Estuary', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: estuary })
    expect(state.objects[estuary]!.tapped).toBe(false)
  })

  it('a nonland card of the right colour does NOT satisfy it', () => {
    const { state, A } = makeDuel()
    rig(state, A, { hand: [], battlefield: [], librarySize: 20 }) // no Mountains in hand either
    putCard(state, A, 'Murder', 'hand') // a black card, but not a Swamp
    const ruins = putCard(state, A, 'Foreboding Ruins', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: ruins })
    expect(state.objects[ruins]!.tapped).toBe(true)
  })
})

describe('CARD27 — Exploration (a static extra land drop)', () => {
  it('allows a second land every turn, not just once', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Exploration', 'battlefield')
    const l1 = putCard(state, A, 'Mountain', 'hand')
    const l2 = putCard(state, A, 'Mountain', 'hand')
    const l3 = putCard(state, A, 'Mountain', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: l1 })
    act(state, A, { type: 'r.playLand', objId: l2 }) // the extra drop
    expect(() => act(state, A, { type: 'r.playLand', objId: l3 })).toThrow(/LAND_LIMIT|Already played/i)
    // next turn the allowance is back
    const l4 = putCard(state, A, 'Mountain', 'hand')
    until(state, (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A, "A's next turn")
    act(state, A, { type: 'r.playLand', objId: l3 })
    act(state, A, { type: 'r.playLand', objId: l4 })
    expect(state.objects[l4]!.zone).toBe('battlefield')
  })

  it('stacks with Explore, and redact reflects the allowance', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Exploration', 'battlefield')
    const explore = putCard(state, A, 'Explore', 'hand')
    const lands = [1, 2, 3].map(() => putCard(state, A, 'Mountain', 'hand'))
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: explore, targets: [] })
    resolve(state, A)
    for (const l of lands) {
      expect(computeLegal(state, A).playableLandIds).toContain(l)
      act(state, A, { type: 'r.playLand', objId: l })
    }
    expect(computeLegal(state, A).playableLandIds).toEqual([]) // 1 + 1 static + 1 one-shot = 3
  })
})

describe('CARD27 — Morbid Opportunist (once each turn)', () => {
  it('draws for the first other creature that dies, then not again this turn', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Morbid Opportunist', 'battlefield')
    const bear1 = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const bear2 = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const shock1 = putCard(state, A, 'Shock', 'hand')
    const shock2 = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 2)
    let before = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cast', objId: shock1, targets: [bear1] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before - 1 + 1) // shock out, 1 drawn
    before = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cast', objId: shock2, targets: [bear2] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before - 1) // no second draw this turn
  })

  it('resets next turn', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Morbid Opportunist', 'battlefield')
    const bear1 = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const bear2 = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const shock1 = putCard(state, A, 'Shock', 'hand')
    const shock2 = putCard(state, A, 'Shock', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock1, targets: [bear1] })
    resolve(state, A)
    until(state, (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A, "A's next turn")
    const before = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock2, targets: [bear2] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before - 1 + 1) // draws again
  })
})

describe('CARD27 — the singles', () => {
  it('Infernal Grasp destroys a creature and costs 2 life', () => {
    const { state, A, B } = makeDuel()
    const grasp = putCard(state, A, 'Infernal Grasp', 'hand')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: grasp, targets: [bear] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(state.players[A]!.life).toBe(38)
  })

  it('Withering Torment hits an enchantment too', () => {
    const { state, A, B } = makeDuel()
    const torment = putCard(state, A, 'Withering Torment', 'hand')
    const ench = putCard(state, B, 'Glorious Anthem', 'battlefield') // a plain enchantment
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: torment, targets: [ench] })
    resolve(state, A)
    expect(state.objects[ench]!.zone).toBe('graveyard')
    expect(state.players[A]!.life).toBe(38)
  })

  it('Exsanguinate drains each opponent for X and gains the total', () => {
    const { state } = makeGameN(3)
    const A = state.activePlayer
    const foes = state.turnOrder.filter((p) => p !== A)
    const exs = putCard(state, A, 'Exsanguinate', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 2)
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.cast', objId: exs, targets: [], x: 3 })
    resolve(state, A)
    for (const f of foes) expect(state.players[f]!.life).toBe(37)
    expect(state.players[A]!.life).toBe(46) // 40 + 3 + 3
  })

  it('Basilisk Collar grants deathtouch and lifelink', () => {
    const { state, A } = makeDuel()
    const collar = putCard(state, A, 'Basilisk Collar', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.equip', equipmentId: collar, creatureId: bear })
    const legal = computeLegal(state, A)
    expect(legal).toBeTruthy()
    expect(state.objects[collar]!.attachedTo).toBe(bear)
  })

  it('Skyshroud Claim fetches two Forests untapped', () => {
    const { state, A } = makeDuel()
    const claim = putCard(state, A, 'Skyshroud Claim', 'hand')
    putCard(state, A, 'Forest', 'library')
    putCard(state, A, 'Forest', 'library')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.cast', objId: claim, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'the search')
    const picks = state.pendingSearch!.matchIds.slice(0, 2)
    expect(state.pendingSearch!.count).toBe(2)
    act(state, A, { type: 'r.search', cardIds: picks })
    for (const id of picks) {
      expect(state.objects[id]!.zone).toBe('battlefield')
      expect(state.objects[id]!.tapped).toBe(false)
    }
  })

  it('Diabolic Intent sacrifices a creature and tutors to HAND', () => {
    const { state, A } = makeDuel()
    const intent = putCard(state, A, 'Diabolic Intent', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const wanted = putCard(state, A, 'Sol Ring', 'library')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: intent, targets: [], sacrifices: [bear] })
    expect(state.objects[bear]!.zone).toBe('graveyard')
    until(state, (s) => s.pending?.kind === 'search', 'the tutor')
    act(state, A, { type: 'r.search', cardIds: [wanted] })
    // library → hand is public→hidden for the peeked id, so it is re-minted: find it by name
    expect(
      state.zones.perPlayer[A]!.hand.some((id) => getDef(state.objects[id]!.defName).name === 'Sol Ring'),
    ).toBe(true)
  })

  it('Aetherize returns every attacking creature to hand', () => {
    const { state, A, B } = makeDuel()
    const aether = putCard(state, B, 'Aetherize', 'hand')
    const a1 = putCard(state, A, 'Gray Ogre', 'battlefield')
    const a2 = putCard(state, A, 'Hill Giant', 'battlefield')
    const home = putCard(state, B, 'Grizzly Bears', 'battlefield')
    for (const id of [a1, a2]) state.objects[id]!.summoningSick = false
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [a1, a2])
    until(state, (s) => s.priorityPlayer === B, "B's priority in combat")
    addMana(state, B, 'U', 1)
    addMana(state, B, 'C', 3)
    act(state, B, { type: 'r.cast', objId: aether, targets: [] })
    until(state, (s) => !s.zones.stack.length, 'resolve')
    expect(state.objects[a1]).toBeUndefined() // returned to hand with fresh ids
    expect(state.objects[a2]).toBeUndefined()
    expect(state.objects[home]!.zone).toBe('battlefield') // a non-attacker stays
  })
})
