/**
 * Perpetual card coverage — batch CARD43: "whenever … deals combat damage to a player" (CR 603.2) in
 * its three wordings — the creature itself, the creature an Equipment is attached to, and "one or
 * more creatures you control" (once per damaged player) — plus static protection granted to an
 * equipped creature and a "Sacrifice a Treasure" activation cost.
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, makeGameN, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef, registerImplementedToken } from '../../server/rules/cards/registry.ts'
import { TREASURE } from '../../server/rules/cards/effects.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
/** a Treasure token on the battlefield (tokens are registered lazily, so register the spec first) */
const mintTreasure = (s: St, p: PlayerId) => {
  const defName = registerImplementedToken(TREASURE)
  const id = putCard(s, p, 'Sol Ring', 'battlefield') // placeholder object, retyped below
  s.objects[id]!.defName = defName
  return id
}
const treasures = (s: St, p: PlayerId) =>
  s.zones.perPlayer[p]!.battlefield.filter((id) => (getDef(s.objects[id]!.defName).subtypes ?? []).includes('Treasure'))
/** attach `equip` to `creature` (the equip ability, paid) */
const equipTo = (s: St, p: PlayerId, equip: ObjId, creature: ObjId) => {
  addMana(s, p, 'C', 2)
  act(s, p, { type: 'r.equip', equipmentId: equip, creatureId: creature })
  expect(s.objects[equip]!.attachedTo).toBe(creature)
}

describe('CARD43 — Professional Face-Breaker', () => {
  it('makes ONE Treasure however many of your creatures connect', () => {
    const { state, A, B } = makeDuel()
    const breaker = putCard(state, A, 'Professional Face-Breaker', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    for (const id of [breaker, ogre]) state.objects[id]!.summoningSick = false
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [breaker, ogre])
    until(state, (s) => treasures(s, A).length > 0 || s.turnNumber > 1, 'the Treasure')
    expect(treasures(state, A).length).toBe(1) // one trigger, not one per attacker
    expect(state.players[B]!.life).toBe(35) // 3 + 2 combat damage
  })

  it('triggers once per damaged PLAYER in a multiplayer game', () => {
    const { state } = makeGameN(3)
    const A = state.activePlayer
    const [B, C] = state.turnOrder.filter((p) => p !== A)
    putCard(state, A, 'Professional Face-Breaker', 'battlefield')
    const a1 = putCard(state, A, 'Gray Ogre', 'battlefield')
    const a2 = putCard(state, A, 'Hill Giant', 'battlefield')
    for (const id of state.zones.perPlayer[A]!.battlefield) state.objects[id]!.summoningSick = false
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    act(state, A, {
      type: 'r.attackers',
      attacks: [
        { attackerId: a1, defenderId: B! },
        { attackerId: a2, defenderId: C! },
      ],
    })
    until(state, (s) => treasures(s, A).length >= 2 || s.turnNumber > 1, 'two Treasures')
    expect(treasures(state, A).length).toBe(2) // one per damaged player
  })

  it('does not trigger off an OPPONENT\'s creature hitting someone', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Professional Face-Breaker', 'battlefield')
    const theirs = putCard(state, B, 'Gray Ogre', 'battlefield')
    state.objects[theirs]!.summoningSick = false
    until(state, (s) => s.turnNumber === 2 && s.pending?.kind === 'attackers' && s.pending.player === B, "B's attack")
    attack(state, B, A, [theirs])
    until(state, (s) => s.players[A]!.life !== 40, 'their damage')
    expect(treasures(state, A).length).toBe(0)
  })

  it('sacrifices a TREASURE (not a creature) to impulse-draw the top card', () => {
    const { state, A } = makeDuel()
    const breaker = putCard(state, A, 'Professional Face-Breaker', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    // with no Treasure the ability is not even offered
    expect(computeLegal(state, A).activations.some((a) => a.objId === breaker)).toBe(false)
    const treasure = mintTreasure(state, A)
    const offer = computeLegal(state, A).activations.find((a) => a.objId === breaker)
    expect(offer).toBeTruthy()
    expect(offer!.sacCost).toBe(1)
    expect(offer!.sacFilter).toBe('treasure')
    // a creature is refused; the Treasure is accepted
    expect(() =>
      act(state, A, { type: 'r.activate', objId: breaker, abilityIndex: 0, targets: [], sacrifices: [bear] }),
    ).toThrow(/Not a Treasure/)
    act(state, A, { type: 'r.activate', objId: breaker, abilityIndex: 0, targets: [], sacrifices: [treasure] })
    // a token that leaves the battlefield ceases to exist (CR 111.7), so it is simply gone
    expect(state.zones.perPlayer[A]!.battlefield).not.toContain(treasure)
    expect(treasures(state, A).length).toBe(0)
    until(state, (s) => s.zones.perPlayer[A]!.exile.some((id) => s.objects[id]!.playableBy === A), 'the impulse exile')
    const exiled = state.zones.perPlayer[A]!.exile.filter((id) => state.objects[id]!.playableBy === A)
    expect(exiled.length).toBe(1)
    expect(state.objects[exiled[0]!]!.playableUntil).toBe('endOfTurn')
  })
})

describe('CARD43 — Sword of the Animist (an attacks trigger on the EQUIPMENT)', () => {
  it('fetches a basic land tapped when the equipped creature attacks', () => {
    const { state, A, B } = makeDuel()
    const sword = putCard(state, A, 'Sword of the Animist', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    state.objects[ogre]!.summoningSick = false
    toStep(state, 'main1')
    equipTo(state, A, sword, ogre)
    // the equipment's +1/+1 applies
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [ogre])
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, 'the fetch')
    const basic = state.pendingSearch!.matchIds[0]!
    act(state, A, { type: 'r.search', cardIds: [basic] })
    expect(state.objects[basic]!.zone).toBe('battlefield')
    expect(state.objects[basic]!.tapped).toBe(true)
    until(state, (s) => s.players[B]!.life !== 40, 'combat damage')
    expect(state.players[B]!.life).toBe(37) // 2/2 + 1/+1
  })

  it('does nothing when it is not attached to the attacker', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Sword of the Animist', 'battlefield') // unattached
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    state.objects[ogre]!.summoningSick = false
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [ogre])
    until(state, (s) => s.players[B]!.life !== 40, 'combat damage')
    expect(state.pending?.kind).not.toBe('search')
    expect(state.players[B]!.life).toBe(38)
  })
})

describe('CARD43 — Sword of Feast and Famine', () => {
  it('makes the damaged player discard and untaps ALL your lands', () => {
    const { state, A, B } = makeDuel()
    const sword = putCard(state, A, 'Sword of Feast and Famine', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    state.objects[ogre]!.summoningSick = false
    const lands = [1, 2, 3].map(() => putCard(state, A, 'Mountain', 'battlefield'))
    const theirLand = putCard(state, B, 'Mountain', 'battlefield')
    for (const l of [...lands, theirLand]) state.objects[l]!.tapped = true
    toStep(state, 'main1')
    equipTo(state, A, sword, ogre)
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [ogre])
    until(state, (s) => s.pending?.kind === 'discard' && s.pending.player === B, 'their discard')
    expect(state.players[B]!.life).toBe(36) // 2/2 + 2/+2
    const theirHand = state.zones.perPlayer[B]!.hand
    act(state, B, { type: 'r.discard', objIds: [theirHand[0]!] })
    expect(lands.every((l) => !state.objects[l]!.tapped)).toBe(true)
    expect(state.objects[theirLand]!.tapped).toBe(true) // not their lands
  })

  it('grants the equipped creature protection from black and green', () => {
    const { state, A, B } = makeDuel()
    const sword = putCard(state, A, 'Sword of Feast and Famine', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    state.objects[ogre]!.summoningSick = false
    toStep(state, 'main1')
    equipTo(state, A, sword, ogre)
    // a BLACK removal spell can no longer target it…
    const murder = putCard(state, B, 'Murder', 'hand')
    act(state, A, { type: 'r.pass' })
    addMana(state, B, 'B', 2)
    addMana(state, B, 'C', 1)
    expect(() => act(state, B, { type: 'r.cast', objId: murder, targets: [ogre] })).toThrow(/BAD_TARGETS|Illegal target/i)
    // …while a RED one still can
    const bolt = putCard(state, B, 'Lightning Bolt', 'hand')
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: bolt, targets: [ogre] })
    until(state, (s) => !s.zones.stack.length, 'the bolt')
    expect(state.objects[ogre]!.damageMarked).toBe(3)
  })
})

describe('CARD43 — Sword of Fire and Ice (a TARGETED combat-damage trigger)', () => {
  it('deals 2 damage to a chosen target and draws a card', () => {
    const { state, A, B } = makeDuel()
    const sword = putCard(state, A, 'Sword of Fire and Ice', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    const victim = putCard(state, B, 'Grizzly Bears', 'battlefield')
    state.objects[ogre]!.summoningSick = false
    toStep(state, 'main1')
    equipTo(state, A, sword, ogre)
    const handBefore = state.zones.perPlayer[A]!.hand.length
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [ogre])
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'the trigger target')
    expect(computeLegal(state, A).triggerTargetKind).toBe('anyTarget')
    act(state, A, { type: 'r.chooseTargets', targets: [victim] })
    until(state, (s) => s.objects[victim]!.zone === 'graveyard' || s.turnNumber > 1, 'the damage')
    expect(state.objects[victim]!.zone).toBe('graveyard') // 2 damage kills a 2/2
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1)
    expect(state.players[B]!.life).toBe(36) // 2/2 + 2/+2 in combat
  })

  it('protects its bearer from red and blue', () => {
    const { state, A, B } = makeDuel()
    const sword = putCard(state, A, 'Sword of Fire and Ice', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    state.objects[ogre]!.summoningSick = false
    toStep(state, 'main1')
    equipTo(state, A, sword, ogre)
    const bolt = putCard(state, B, 'Lightning Bolt', 'hand')
    act(state, A, { type: 'r.pass' })
    addMana(state, B, 'R', 1)
    expect(() => act(state, B, { type: 'r.cast', objId: bolt, targets: [ogre] })).toThrow(/BAD_TARGETS|Illegal target/i)
  })
})
