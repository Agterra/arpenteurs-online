/**
 * Perpetual card coverage — batch CARD31: metalcraft (Mox Opal), dynamic mana colours (Mox Amber,
 * Reflecting Pool), sacrifice-for-mana (Ashnod's / Phyrexian Altar, Phyrexian Tower), Bloom Tender,
 * Gamble, Grand Abolisher and Decanter of Endless Water.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const poolTotal = (s: St, p: PlayerId) => Object.values(s.players[p]!.manaPool).reduce((a, b) => a + b, 0)

describe('CARD31 — metalcraft and dynamic mana colours', () => {
  it('Mox Opal is dead below three artifacts and live at three', () => {
    const { state, A } = makeDuel()
    const opal = putCard(state, A, 'Mox Opal', 'battlefield')
    putCard(state, A, 'Sol Ring', 'battlefield') // 2 artifacts including the Mox
    toStep(state, 'main1')
    expect(computeLegal(state, A).manaSourceIds).not.toContain(opal)
    expect(() => act(state, A, { type: 'r.tapMana', objId: opal, color: 'G' })).toThrow(/Needs 3 artifacts/)
    putCard(state, A, 'Mind Stone', 'battlefield') // now 3
    expect(computeLegal(state, A).manaSourceIds).toContain(opal)
    act(state, A, { type: 'r.tapMana', objId: opal, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(1)
  })

  it('Mox Amber offers only the colours of your legendary creatures', () => {
    const { state, A } = makeDuel()
    const amber = putCard(state, A, 'Mox Amber', 'battlefield')
    toStep(state, 'main1')
    // nothing legendary yet → not even offered
    expect(computeLegal(state, A).manaSourceIds).not.toContain(amber)
    putCard(state, A, 'Azusa, Lost but Seeking', 'battlefield') // legendary GREEN creature
    const legal = computeLegal(state, A)
    expect(legal.manaSourceIds).toContain(amber)
    expect(legal.manaSourceColors[amber]).toEqual(['G'])
    expect(() => act(state, A, { type: 'r.tapMana', objId: amber, color: 'U' })).toThrow(/can't make \{U\}/i)
    act(state, A, { type: 'r.tapMana', objId: amber, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(1)
  })

  it('Reflecting Pool copies what your lands can produce', () => {
    const { state, A } = makeDuel()
    const pool = putCard(state, A, 'Reflecting Pool', 'battlefield')
    toStep(state, 'main1')
    expect(computeLegal(state, A).manaSourceIds).not.toContain(pool) // no other lands
    putCard(state, A, 'Watery Grave', 'battlefield') // U/B
    putCard(state, A, 'Mountain', 'battlefield') // R
    const legal = computeLegal(state, A)
    expect(legal.manaSourceColors[pool]).toEqual(['U', 'B', 'R'])
    act(state, A, { type: 'r.tapMana', objId: pool, color: 'B' })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })
})

describe('CARD31 — sacrifice for mana', () => {
  it("Ashnod's Altar turns a creature into {C}{C} (no tap needed)", () => {
    const { state, A } = makeDuel()
    const altar = putCard(state, A, "Ashnod's Altar", 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    expect(computeLegal(state, A).manaSourceSacCost[altar]).toBe(1)
    act(state, A, { type: 'r.tapMana', objId: altar, sacrifices: [bear] })
    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(state.players[A]!.manaPool.C).toBe(2)
    expect(state.objects[altar]!.tapped).toBe(false) // it never taps
  })

  it('rejects no creature, an opponent\'s creature, and a noncreature', () => {
    const { state, A, B } = makeDuel()
    const altar = putCard(state, A, 'Phyrexian Altar', 'battlefield')
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const rock = putCard(state, A, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.tapMana', objId: altar, color: 'B' })).toThrow(/Sacrifice exactly 1/)
    expect(() => act(state, A, { type: 'r.tapMana', objId: altar, color: 'B', sacrifices: [theirs] })).toThrow(/Not a creature you control/)
    expect(() => act(state, A, { type: 'r.tapMana', objId: altar, color: 'B', sacrifices: [rock] })).toThrow(/Not a creature you control/)
    expect(state.objects[mine]!.zone).toBe('battlefield')
    expect(poolTotal(state, A)).toBe(0)
    act(state, A, { type: 'r.tapMana', objId: altar, color: 'B', sacrifices: [mine] })
    expect(state.players[A]!.manaPool.B).toBe(1)
  })

  it('is not offered with no creature to sacrifice', () => {
    const { state, A } = makeDuel()
    const altar = putCard(state, A, "Ashnod's Altar", 'battlefield')
    toStep(state, 'main1')
    expect(computeLegal(state, A).manaSourceIds).not.toContain(altar)
    putCard(state, A, 'Grizzly Bears', 'battlefield')
    expect(computeLegal(state, A).manaSourceIds).toContain(altar)
  })

  it("Phyrexian Tower's free {C} and its sac-for-{B}{B} are separate abilities", () => {
    const { state, A } = makeDuel()
    const tower = putCard(state, A, 'Phyrexian Tower', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: tower, color: 'C' }) // the plain ability
    expect(state.players[A]!.manaPool.C).toBe(1)
    expect(state.objects[bear]!.zone).toBe('battlefield') // nothing sacrificed
    state.objects[tower]!.tapped = false
    act(state, A, { type: 'r.tapMana', objId: tower, color: 'B', sacrifices: [bear] })
    expect(state.players[A]!.manaPool.B).toBe(2)
    expect(state.objects[bear]!.zone).toBe('graveyard')
  })

  it('a dies trigger sees the mana it was paid for', () => {
    const { state, A, B } = makeDuel()
    const altar = putCard(state, A, "Ashnod's Altar", 'battlefield')
    putCard(state, A, 'Blood Artist', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: altar, sacrifices: [bear] })
    expect(state.players[A]!.manaPool.C).toBe(2)
    // Blood Artist's targeted dies trigger opens as usual
    expect(state.pending?.kind).toBe('trigger')
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    until(state, (s) => s.players[B]!.life !== 40, 'the drain')
    expect(state.players[B]!.life).toBe(39)
  })
})

describe('CARD31 — the rest', () => {
  it('Bloom Tender adds one mana per colour among your permanents', () => {
    const { state, A } = makeDuel()
    const tender = putCard(state, A, 'Bloom Tender', 'battlefield')
    state.objects[tender]!.summoningSick = false
    putCard(state, A, 'Blood Artist', 'battlefield') // black
    putCard(state, A, 'Sol Ring', 'battlefield') // colourless — no colour
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: tender })
    // green (Bloom Tender itself) + black (Blood Artist)
    expect(state.players[A]!.manaPool.G).toBe(1)
    expect(state.players[A]!.manaPool.B).toBe(1)
    expect(poolTotal(state, A)).toBe(2)
  })

  it('Gamble tutors to hand then discards at random', () => {
    const { state, A } = makeDuel()
    const gamble = putCard(state, A, 'Gamble', 'hand')
    const wanted = putCard(state, A, 'Sol Ring', 'library')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: gamble, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'the tutor')
    act(state, A, { type: 'r.search', cardIds: [wanted] })
    // +1 tutored, −1 discarded at random, −1 the spell itself
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1)
    expect(state.log.some((l) => /discards .* at random/.test(l))).toBe(true)
  })

  it('Decanter of Endless Water removes your hand limit and taps for any colour', () => {
    const { state, A } = makeDuel()
    const decanter = putCard(state, A, 'Decanter of Endless Water', 'battlefield')
    while (state.zones.perPlayer[A]!.hand.length < 9) putCard(state, A, 'Mountain', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: decanter, color: 'W' })
    expect(state.players[A]!.manaPool.W).toBe(1)
    toStep(state, 'end')
    until(state, (s) => s.pending?.kind === 'discard' || s.turnNumber > 1, 'cleanup')
    expect(state.pending).toBeFalsy() // no discard: no maximum hand size
    expect(state.zones.perPlayer[A]!.hand.length).toBeGreaterThanOrEqual(9)
  })

  it("Grand Abolisher stops opponents casting and activating during its controller's turn", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Grand Abolisher', 'battlefield')
    const shock = putCard(state, B, 'Shock', 'hand')
    const rock = putCard(state, B, 'Mind Stone', 'battlefield')
    toStep(state, 'main1')
    pass(state, A) // B holds priority during A's turn
    addMana(state, B, 'R', 1)
    addMana(state, B, 'C', 1)
    expect(() => act(state, B, { type: 'r.cast', objId: shock, targets: [A] })).toThrow(/ABOLISHED|stops you/i)
    expect(() => act(state, B, { type: 'r.activate', objId: rock, abilityIndex: 1, targets: [] })).toThrow(/ABOLISHED|stops you/i)
    // its own controller is unaffected, and a LAND's ability is not covered by the lock
    act(state, B, { type: 'r.tapMana', objId: rock }) // a mana ability, not r.activate
    expect(state.players[B]!.manaPool.C).toBeGreaterThan(0)
  })

  it("…and lifts on the opponent's own turn", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Grand Abolisher', 'battlefield')
    const shock = putCard(state, B, 'Shock', 'hand')
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: shock, targets: [A] })
    until(state, (s) => !s.zones.stack.length, 'resolve')
    expect(state.players[A]!.life).toBe(38)
  })
})
