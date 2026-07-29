/**
 * Perpetual card coverage — batch CARD39: top-200 singles that needed no new decision seam.
 * Assassin's Trophy (destroy anything, they fetch a BASIC), Flawless Maneuver (free with a
 * commander, creatures only), Windfall (mass hand dump with no prompt), Ash Barrens (basic
 * landcycling on the channel plumbing) and War Room (a life cost sized by your commander).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, makeGameN, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const nameOf = (s: St, id: string) => getDef(s.objects[id]!.defName).name

describe("CARD39 — Assassin's Trophy", () => {
  const cast = (s: St, A: PlayerId, target: string) => {
    const trophy = putCard(s, A, "Assassin's Trophy", 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'B', 1)
    addMana(s, A, 'G', 1)
    act(s, A, { type: 'r.cast', objId: trophy, targets: [target] })
    return trophy
  }

  it("destroys ANY permanent an opponent controls, then opens THEIR basic-land search", () => {
    const { state, A, B } = makeDuel()
    const theirLand = putCard(state, B, 'Mountain', 'battlefield') // a land is a legal target
    const basic = putCard(state, B, 'Forest', 'library')
    putCard(state, B, 'Watery Grave', 'library') // a nonbasic dual is NOT a legal find
    cast(state, A, theirLand)
    until(state, (s) => s.pending?.kind === 'search', 'their search')
    expect(state.objects[theirLand]!.zone).toBe('graveyard')
    expect(state.pending!.player).toBe(B) // the search belongs to the destroyed permanent's controller
    expect(state.pendingSearch!.matchIds).toContain(basic)
    expect(state.pendingSearch!.matchIds.map((id) => nameOf(state, id))).not.toContain('Watery Grave')
    act(state, B, { type: 'r.search', cardIds: [basic] })
    // the fetched basic arrives UNTAPPED (the card says nothing about tapped)
    const fetched = state.zones.perPlayer[B]!.battlefield.filter((id) => nameOf(state, id) === 'Forest')
    expect(fetched.length).toBe(1)
    expect(state.objects[fetched[0]!]!.tapped).toBe(false)
  })

  it('they may decline the search, and it is skipped with no basic in their library', () => {
    const { state, A, B } = makeDuel()
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')
    cast(state, A, rock)
    until(state, (s) => s.pending?.kind === 'search', 'their search')
    const bfBefore = state.zones.perPlayer[B]!.battlefield.length
    act(state, B, { type: 'r.search', cardIds: [] }) // decline
    expect(state.zones.perPlayer[B]!.battlefield.length).toBe(bfBefore)
    expect(state.objects[rock]!.zone).toBe('graveyard')
  })

  it('refuses a permanent YOU control and respects indestructible', () => {
    const { state, A, B } = makeDuel()
    const mine = putCard(state, A, 'Sol Ring', 'battlefield')
    const trophy = putCard(state, A, "Assassin's Trophy", 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'G', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: trophy, targets: [mine] })).toThrow(/BAD_TARGETS|Illegal target/i)
    const theirs = putCard(state, B, 'Darksteel Citadel', 'battlefield') // indestructible land
    act(state, A, { type: 'r.cast', objId: trophy, targets: [theirs] })
    resolve(state, A)
    expect(state.objects[theirs]!.zone).toBe('battlefield')
    expect(state.log.some((l) => /is indestructible/.test(l))).toBe(true)
  })
})

describe('CARD39 — Flawless Maneuver', () => {
  const rigCommander = (s: St, p: PlayerId) => {
    const cmd = putCard(s, p, 'Loran of the Third Path', 'battlefield')
    s.players[p]!.commanderId = cmd
    s.objects[cmd]!.isCommander = true // what "you control a commander" actually reads
    return cmd
  }

  it('is free while you control a commander, and saves only your CREATURES', () => {
    const { state, A, B } = makeDuel()
    rigCommander(state, A)
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const myRock = putCard(state, A, 'Sol Ring', 'battlefield')
    const theirBear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const maneuver = putCard(state, A, 'Flawless Maneuver', 'hand')
    toStep(state, 'main1')
    expect(computeLegal(state, A).freeCastable).toContain(maneuver)
    act(state, A, { type: 'r.cast', objId: maneuver, targets: [], free: true })
    resolve(state, A)
    // a board wipe now spares your creatures but not your artifact, nor their creature
    const wrath = putCard(state, A, 'Wrath of God', 'hand')
    addMana(state, A, 'W', 2)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: wrath, targets: [] })
    resolve(state, A)
    expect(state.objects[bear]!.zone).toBe('battlefield')
    expect(state.objects[theirBear]!.zone).toBe('graveyard')
    // the artifact was never a target of the wipe, but it also never gained indestructible
    expect(state.log.some((l) => /creatures gain indestructible/.test(l))).toBe(true)
    expect(state.objects[myRock]!.zone).toBe('battlefield')
  })

  it('costs {2}{W} without a commander, and the free cast is refused', () => {
    const { state, A } = makeDuel()
    const maneuver = putCard(state, A, 'Flawless Maneuver', 'hand')
    toStep(state, 'main1')
    expect(computeLegal(state, A).freeCastable).not.toContain(maneuver)
    expect(() => act(state, A, { type: 'r.cast', objId: maneuver, targets: [], free: true })).toThrow(/commander/i)
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: maneuver, targets: [] })
    resolve(state, A)
    expect(state.objects[maneuver]!.zone).toBe('graveyard')
  })
})

describe('CARD39 — Windfall', () => {
  it('every player pitches their hand and draws the GREATEST number discarded', () => {
    const { state } = makeGameN(3)
    const A = state.activePlayer
    const [B, C] = state.turnOrder.filter((p) => p !== A)
    // trim every hand to a known size, then give A the biggest one
    for (const p of state.turnOrder) {
      const hand = state.zones.perPlayer[p]!.hand
      while (hand.length) state.zones.perPlayer[p]!.graveyard.push(hand.pop()!)
    }
    const windfall = putCard(state, A, 'Windfall', 'hand')
    for (let i = 0; i < 3; i++) putCard(state, A, 'Mountain', 'hand') // 3 + Windfall itself
    putCard(state, B!, 'Mountain', 'hand')
    // C keeps an empty hand
    toStep(state, 'main1') // A's draw step adds one more card to their hand
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: windfall, targets: [] })
    // greatest = A's hand once Windfall has left it for the stack
    const greatest = Math.max(...state.turnOrder.map((p) => state.zones.perPlayer[p]!.hand.length))
    expect(greatest).toBeGreaterThan(1) // A holds the biggest hand; C holds none
    expect(state.zones.perPlayer[C!]!.hand.length).toBe(0)
    resolve(state, A)
    for (const p of state.turnOrder) expect(state.zones.perPlayer[p]!.hand.length).toBe(greatest)
    expect(state.log.some((l) => new RegExp(`Each player draws ${greatest} cards`).test(l))).toBe(true)
    expect(state.log.some((l) => new RegExp(`discards their hand \\(${greatest} cards\\)`).test(l))).toBe(true)
  })

  it('needs no discard prompt, and an all-empty table just draws nothing', () => {
    const { state, A, B } = makeDuel()
    for (const p of [A, B]) {
      const hand = state.zones.perPlayer[p]!.hand
      while (hand.length) state.zones.perPlayer[p]!.graveyard.push(hand.pop()!)
    }
    const windfall = putCard(state, A, 'Windfall', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: windfall, targets: [] })
    resolve(state, A)
    expect(state.pending).toBeFalsy() // no discard decision — the whole hand goes
    expect(state.zones.perPlayer[A]!.hand.length).toBe(0)
    expect(state.zones.perPlayer[B]!.hand.length).toBe(0)
  })
})

describe('CARD39 — Ash Barrens (basic landcycling)', () => {
  it('taps for {C} on the battlefield, and landcycles for {1} from hand', () => {
    const { state, A } = makeDuel()
    const played = putCard(state, A, 'Ash Barrens', 'battlefield')
    const inHand = putCard(state, A, 'Ash Barrens', 'hand')
    const basic = putCard(state, A, 'Island', 'library')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: played, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
    // the landcycling offer rides the channel plumbing, but the button reads "Landcycle"
    const offer = computeLegal(state, A).channelable.find((c) => c.objId === inHand)
    expect(offer).toEqual({ objId: inHand, cost: '{1}', targetKind: null, label: 'Landcycle' })
    act(state, A, { type: 'r.channel', objId: inHand, targets: [] })
    expect(state.objects[inHand]!.zone).toBe('graveyard') // discarded as a cost
    until(state, (s) => s.pending?.kind === 'search', 'the search')
    expect(state.pendingSearch!.matchIds).toContain(basic)
    act(state, A, { type: 'r.search', cardIds: [basic] })
    expect(state.zones.perPlayer[A]!.hand.some((id) => nameOf(state, id) === 'Island')).toBe(true)
    expect(state.log.some((l) => /Island/.test(l))).toBe(true) // revealed, per the card
  })

  it('is not offered without the {1}, and finds only BASIC lands', () => {
    const { state, A } = makeDuel()
    const inHand = putCard(state, A, 'Ash Barrens', 'hand')
    toStep(state, 'main1')
    expect(computeLegal(state, A).channelable.some((c) => c.objId === inHand)).toBe(false)
    addMana(state, A, 'C', 1)
    expect(computeLegal(state, A).channelable.some((c) => c.objId === inHand)).toBe(true)
    // rig a library with no basic at all
    const lib = state.zones.perPlayer[A]!.library
    while (lib.length) state.objects[lib.pop()!]!.zone = 'exile'
    putCard(state, A, 'Watery Grave', 'library')
    act(state, A, { type: 'r.channel', objId: inHand, targets: [] })
    resolve(state, A) // the ability uses the stack, so it has to resolve first
    expect(state.pending).toBeFalsy()
    expect(state.log.some((l) => /finds nothing/.test(l))).toBe(true)
  })
})

describe('CARD39 — War Room', () => {
  const rig = (s: St, p: PlayerId, commander: string | null) => {
    const room = putCard(s, p, 'War Room', 'battlefield')
    if (commander) s.players[p]!.commanderId = putCard(s, p, commander, 'battlefield')
    toStep(s, 'main1')
    return room
  }

  it('charges one life per COLOUR of your commander', () => {
    const { state, A } = makeDuel()
    // the harness only needs an OBJECT as the commander — its colours are all the cost reads
    const room = rig(state, A, 'Cruel Celebrant') // W/B → 2 colours
    const cmdColors = new Set(getDef(state.objects[state.players[A]!.commanderId!]!.defName).colors ?? []).size
    expect(cmdColors).toBeGreaterThan(1)
    expect(computeLegal(state, A).activations.find((a) => a.objId === room)?.lifeCost).toBe(cmdColors)
    const life = state.players[A]!.life
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.activate', objId: room, abilityIndex: 1, targets: [] })
    expect(state.players[A]!.life).toBe(life - cmdColors)
    expect(state.objects[room]!.tapped).toBe(true)
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1)
  })

  it('is FREE of life with a colourless commander, and still taps for {C}', () => {
    const { state, A } = makeDuel()
    const room = rig(state, A, 'Solemn Simulacrum') // colourless
    expect(computeLegal(state, A).activations.find((a) => a.objId === room)?.lifeCost).toBe(0)
    const life = state.players[A]!.life
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.activate', objId: room, abilityIndex: 1, targets: [] })
    expect(state.players[A]!.life).toBe(life)
    resolve(state, A)
    const other = putCard(state, A, 'War Room', 'battlefield')
    act(state, A, { type: 'r.tapMana', objId: other, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
  })

  it('refuses the draw at too little life, and without the {3}', () => {
    const { state, A } = makeDuel()
    const room = rig(state, A, 'Cruel Celebrant')
    const cost = new Set(getDef(state.objects[state.players[A]!.commanderId!]!.defName).colors ?? []).size
    expect(() => act(state, A, { type: 'r.activate', objId: room, abilityIndex: 1, targets: [] })).toThrow(/Not enough mana/)
    addMana(state, A, 'C', 3)
    state.players[A]!.life = cost - 1
    expect(() => act(state, A, { type: 'r.activate', objId: room, abilityIndex: 1, targets: [] })).toThrow(/Not enough life/)
    expect(computeLegal(state, A).activations.some((a) => a.objId === room)).toBe(false) // hidden too
    expect(state.objects[room]!.tapped).toBe(false)
  })
})
