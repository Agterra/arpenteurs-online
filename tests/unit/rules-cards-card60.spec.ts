/**
 * Perpetual card coverage — batch CARD60: Deflecting Swat — "you may choose new targets for target spell
 * or ability". Two new pieces: a target kind spanning SPELLS AND ABILITIES on the stack
 * (`spellOrAbility`, and only ones that actually have targets) and a re-aim decision (r.retarget) whose
 * new targets must still be legal FOR THE RE-AIMED ITEM'S controller (CR 115.7b).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, pass, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const giveCommander = (s: St, p: PlayerId) => {
  const cmd = putCard(s, p, 'Loran of the Third Path', 'battlefield')
  s.players[p]!.commanderId = cmd
  s.objects[cmd]!.isCommander = true
}

describe('CARD60 — Deflecting Swat', () => {
  /** A bolts B; B answers with Deflecting Swat (free, thanks to their commander) */
  const boltThenSwat = (s: St, A: PlayerId, B: PlayerId) => {
    giveCommander(s, B)
    const bolt = putCard(s, A, 'Lightning Bolt', 'hand')
    const swat = putCard(s, B, 'Deflecting Swat', 'hand')
    toStep(s, 'main1')
    addMana(s, A, 'R', 1)
    act(s, A, { type: 'r.cast', objId: bolt, targets: [B] })
    pass(s, A)
    expect(computeLegal(s, B).freeCastable).toContain(swat)
    act(s, B, { type: 'r.cast', objId: swat, targets: [bolt], free: true })
    until(s, (x) => x.pending?.kind === 'retarget' || !x.zones.stack.length, 'the re-aim decision')
    return { bolt, swat }
  }

  it('re-aims a Bolt back at its caster', () => {
    const { state, A, B } = makeDuel()
    const { bolt } = boltThenSwat(state, A, B)
    expect(state.pending?.kind).toBe('retarget')
    expect(state.pending!.player).toBe(B)
    const legal = computeLegal(state, B)
    expect(legal.needsRetarget).toBe(true)
    expect(legal.retargetItemId).toBe(bolt)
    expect(legal.retargetKind).toBe('anyTarget')
    expect(legal.retargetSourceName).toBe('Lightning Bolt')
    act(state, B, { type: 'r.retarget', targets: [A] })
    until(state, (s) => !s.zones.stack.length, 'the Bolt resolves')
    expect(state.players[A]!.life).toBe(37) // it hit its own caster
    expect(state.players[B]!.life).toBe(40)
  })

  it('may keep the current targets', () => {
    const { state, A, B } = makeDuel()
    boltThenSwat(state, A, B)
    act(state, B, { type: 'r.retarget', targets: [] })
    until(state, (s) => !s.zones.stack.length, 'the Bolt resolves')
    expect(state.players[B]!.life).toBe(37) // unchanged aim
    expect(state.log.some((l) => /leaves Lightning Bolt's targets unchanged/.test(l))).toBe(true)
  })

  it('refuses an ILLEGAL new target', () => {
    const { state, A, B } = makeDuel()
    // a 4/4, so it survives the 3 damage — a dead creature loses its damage marks with the object
    const survivor = putCard(state, B, 'Serra Angel', 'battlefield')
    const { bolt } = boltThenSwat(state, A, B)
    // a card in a graveyard is not an any-target
    const dead = putCard(state, B, 'Shock', 'graveyard')
    expect(() => act(state, B, { type: 'r.retarget', targets: [dead] })).toThrow(/Illegal new target/)
    expect(() => act(state, B, { type: 'r.retarget', targets: [A, B] })).toThrow(/exactly 1 target/)
    act(state, B, { type: 'r.retarget', targets: [survivor] })
    until(state, (s) => !s.zones.stack.length, 'the Bolt resolves')
    expect(state.objects[survivor]!.damageMarked).toBe(3)
  })

  it('can re-aim a triggered ABILITY, not just a spell', () => {
    const { state, A, B } = makeDuel()
    giveCommander(state, B)
    // Blood Artist's dies trigger targets a player; A drains B, B swats it back
    putCard(state, A, 'Blood Artist', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const swat = putCard(state, B, 'Deflecting Swat', 'hand')
    toStep(state, 'main1')
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [bear] })
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, "Blood Artist's trigger")
    act(state, A, { type: 'r.chooseTargets', targets: [B] }) // A aims the drain at B
    // the ability is on the stack with a target: B swats it
    const ability = state.zones.stack.find((x) => x.kind === 'ability')!
    pass(state, A)
    act(state, B, { type: 'r.cast', objId: swat, targets: [ability.id], free: true })
    until(state, (s) => s.pending?.kind === 'retarget', 'the re-aim')
    expect(computeLegal(state, B).retargetSourceName).toBe('Blood Artist')
    act(state, B, { type: 'r.retarget', targets: [A] })
    until(state, (s) => !s.zones.stack.length, 'everything resolves')
    // Blood Artist is A's, so the re-aimed drain hits A and gains A: net zero for them, and B is spared
    expect(state.players[B]!.life).toBe(40)
    expect(state.players[A]!.life).toBe(40)
    expect(state.log.some((l) => /chooses new targets for Blood Artist/.test(l))).toBe(true)
  })

  it('cannot target a spell with NO targets', () => {
    const { state, A, B } = makeDuel()
    giveCommander(state, B)
    const alarm = putCard(state, A, 'Raise the Alarm', 'hand') // no targets
    const swat = putCard(state, B, 'Deflecting Swat', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: alarm, targets: [] })
    pass(state, A)
    expect(() => act(state, B, { type: 'r.cast', objId: swat, targets: [alarm], free: true })).toThrow(
      /BAD_TARGETS|Illegal target/i,
    )
  })
})
