/**
 * Perpetual card coverage — batch CARD10: until-end-of-turn KEYWORD grants that reach any
 * permanent type (Heroic Intervention → hexproof + indestructible) and until-end-of-turn
 * "can't be blocked" (Rogue's Passage).
 */
import { describe, expect, it } from 'vitest'
import { act, attack, fieldObj, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { currentKeywords } from '../../server/rules/characteristics.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

/** Cast Heroic Intervention from A's hand (free mana rigged in). */
const intervene = (s: St, A: PlayerId) => {
  const card = putCard(s, A, 'Heroic Intervention', 'hand')
  addMana(s, A, 'G', 1)
  addMana(s, A, 'C', 1)
  act(s, A, { type: 'r.cast', objId: card, targets: [] })
  resolve(s, A)
}

describe('CARD10 — Heroic Intervention (hexproof + indestructible until EOT)', () => {
  it('grants both keywords to EVERY permanent type you control, not just creatures', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const land = putCard(state, A, 'Mountain', 'battlefield')
    const rock = putCard(state, A, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    intervene(state, A)
    for (const id of [bear, land, rock]) {
      const kws = currentKeywords(state, state.objects[id]!)
      expect(kws).toContain('hexproof')
      expect(kws).toContain('indestructible')
    }
  })

  it('hexproof stops an opponent targeting your creature, and indestructible survives removal', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const bolt = putCard(state, B, 'Lightning Bolt', 'hand')
    const murder = putCard(state, B, 'Murder', 'hand')
    toStep(state, 'main1')
    intervene(state, A)
    // B responds in A's main phase: both removal spells are now illegal (hexproof)
    pass(state, A) // hand priority to B
    addMana(state, B, 'R', 1)
    addMana(state, B, 'B', 1)
    addMana(state, B, 'C', 2)
    expect(() => act(state, B, { type: 'r.cast', objId: bolt, targets: [bear] })).toThrow(/BAD_TARGETS|Illegal target/i)
    expect(() => act(state, B, { type: 'r.cast', objId: murder, targets: [bear] })).toThrow(/BAD_TARGETS|Illegal target/i)
    expect(state.objects[bear]!.zone).toBe('battlefield')
  })

  it('indestructible survives a board wipe that destroys everything else', () => {
    const { state, A, B } = makeDuel()
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const wipe = putCard(state, A, 'Day of Judgment', 'hand')
    toStep(state, 'main1')
    intervene(state, A)
    addMana(state, A, 'W', 2)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: wipe, targets: [] })
    resolve(state, A)
    expect(state.objects[mine]!.zone).toBe('battlefield') // granted indestructible now respected by destroy effects
    expect(state.objects[theirs]!.zone).toBe('graveyard')
  })

  it('wears off at cleanup: the same creature is targetable next turn', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const bolt = putCard(state, B, 'Lightning Bolt', 'hand')
    toStep(state, 'main1')
    intervene(state, A)
    until(state, (s) => s.turnNumber === 2 && s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's main phase")
    expect(currentKeywords(state, state.objects[bear]!)).not.toContain('hexproof')
    addMana(state, B, 'R', 1)
    act(state, B, { type: 'r.cast', objId: bolt, targets: [bear] })
    resolve(state, B)
    expect(state.objects[bear]!.zone).toBe('graveyard')
  })
})

describe("CARD10 — Rogue's Passage ({4}, {T}: target creature can't be blocked)", () => {
  it('taps for {C} with ability 0', () => {
    const { state, A } = makeDuel()
    const passage = putCard(state, A, "Rogue's Passage", 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: passage })
    expect(state.players[A]!.manaPool.C).toBe(1)
  })

  it('the pumped attacker cannot be blocked, so its damage hits the defending player', () => {
    const { state, A, B } = makeDuel()
    const passage = putCard(state, A, "Rogue's Passage", 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield') // 2/2
    const blocker = putCard(state, B, 'Grizzly Bears', 'battlefield')
    state.objects[ogre]!.summoningSick = false
    toStep(state, 'main1')
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.activate', objId: passage, abilityIndex: 1, targets: [ogre] })
    resolve(state, A)
    expect(state.unblockable).toContain(ogre)
    const lifeBefore = state.players[B]!.life
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [ogre])
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
    expect(() => act(state, B, { type: 'r.blockers', blocks: [{ blockerId: blocker, attackerId: ogre }] })).toThrow(
      /can't be blocked/i,
    )
    act(state, B, { type: 'r.blockers', blocks: [] })
    until(state, (s) => s.players[B]!.life !== lifeBefore || s.step === 'end', 'combat damage')
    expect(state.players[B]!.life).toBe(lifeBefore - 2)
  })

  it("wears off: next turn the same creature can be blocked", () => {
    const { state, A, B } = makeDuel()
    const passage = putCard(state, A, "Rogue's Passage", 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    state.objects[ogre]!.summoningSick = false
    toStep(state, 'main1')
    addMana(state, A, 'C', 4)
    act(state, A, { type: 'r.activate', objId: passage, abilityIndex: 1, targets: [ogre] })
    resolve(state, A)
    until(state, (s) => s.turnNumber === 2, "B's turn")
    expect(state.unblockable).toEqual([])
  })

  it('requires the {4} (unaffordable → nothing happens)', () => {
    const { state, A } = makeDuel()
    const passage = putCard(state, A, "Rogue's Passage", 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.activate', objId: passage, abilityIndex: 1, targets: [ogre] })).toThrow(/Not enough mana/)
    expect(state.objects[passage]!.tapped).toBe(false)
    expect(state.unblockable ?? []).toEqual([])
  })
})

describe('CARD10 — granted indestructible also survives lethal combat damage', () => {
  it('an indestructible blocker takes lethal damage and lives', () => {
    const { state, A, B } = makeDuel()
    const attacker = putCard(state, A, 'Hill Giant', 'battlefield') // 3/3
    const defender = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2 — 3 damage is lethal
    state.objects[attacker]!.summoningSick = false
    state.objects[defender]!.summoningSick = false
    toStep(state, 'main1')
    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'declare attackers')
    attack(state, A, B, [attacker])
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'declare blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: defender, attackerId: attacker }] })
    // B saves the blocker with Heroic Intervention before damage (blocks are locked in, so the
    // 3/3 still assigns its 3 damage to the 2/2 — it just doesn't die)
    until(state, (s) => s.priorityPlayer === B, "B's priority after blocks")
    const card = putCard(state, B, 'Heroic Intervention', 'hand')
    addMana(state, B, 'G', 1)
    addMana(state, B, 'C', 1)
    act(state, B, { type: 'r.cast', objId: card, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.step === 'declare_blockers', 'intervention resolves')
    until(state, (s) => s.step === 'end', 'end step')
    // damage WAS exchanged this combat (the attacker carries the blocker's 2), and the blocker
    // survived 3 lethal damage thanks to the granted indestructible
    expect(state.objects[attacker]!.damageMarked).toBe(2)
    expect(state.objects[defender]!.damageMarked).toBe(3)
    expect(state.objects[defender]!.zone).toBe('battlefield')
    expect(fieldObj(state, B, 'Grizzly Bears')).toBe(defender)
  })
})
