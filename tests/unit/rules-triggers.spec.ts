/**
 * M-R2 triggered abilities — non-targeted enters-the-battlefield (ETB): the
 * trigger goes on the stack when the permanent enters and resolves like a spell.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { checkSBA } from '../../server/rules/engine.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

// the effective keywords the owner's client sees for one card
function redactKeywords(state: Parameters<typeof redactRulesState>[0], viewer: string, id: string): string[] {
  return redactRulesState(state, viewer).cards[id]?.keywords ?? []
}

describe('enters-the-battlefield triggers', () => {
  it('Elvish Visionary draws a card when it enters (trigger uses the stack)', () => {
    const { state, A } = makeDuel()
    const vis = putCard(state, A, 'Elvish Visionary', 'hand') // {1}{G}, ETB: draw a card
    const f1 = putCard(state, A, 'Forest')
    const f2 = putCard(state, A, 'Forest')
    toStep(state, 'main1')
    const lib0 = state.zones.perPlayer[A]!.library.length
    const hand0 = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.tapMana', objId: f1 })
    act(state, A, { type: 'r.tapMana', objId: f2 })
    act(state, A, { type: 'r.cast', objId: vis, targets: [] })
    // creature resolves onto the battlefield, then its ETB goes on the stack…
    until(state, (s) => s.zones.stack.some((it) => it.kind === 'ability'), 'ETB on the stack')
    // …and resolving it draws a card
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'stack empty')
    expect(state.objects[vis]!.zone).toBe('battlefield')
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 - 1) // drew one
    // net hand: -1 (cast the Visionary) +1 (drew) = hand0
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand0)
  })

  it('Wall of Omens enters with defender AND draws a card', () => {
    const { state, A } = makeDuel()
    const wall = putCard(state, A, 'Wall of Omens', 'hand') // {1}{W}, defender, ETB: draw
    const p1 = putCard(state, A, 'Plains')
    const p2 = putCard(state, A, 'Plains')
    toStep(state, 'main1')
    const lib0 = state.zones.perPlayer[A]!.library.length
    act(state, A, { type: 'r.tapMana', objId: p1 })
    act(state, A, { type: 'r.tapMana', objId: p2 })
    act(state, A, { type: 'r.cast', objId: wall, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[wall]!.zone).toBe('battlefield')
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 - 1)
  })

  it('Angel of Mercy enters with flying and gains 3 life (keyword + trigger)', () => {
    const { state, A } = makeDuel()
    const angel = putCard(state, A, 'Angel of Mercy', 'hand') // {4}{W}, flying, ETB gain 3
    const lands = Array.from({ length: 5 }, () => putCard(state, A, 'Plains'))
    toStep(state, 'main1')
    const life0 = state.players[A]!.life
    for (const l of lands) act(state, A, { type: 'r.tapMana', objId: l })
    act(state, A, { type: 'r.cast', objId: angel, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[angel]!.zone).toBe('battlefield')
    expect(state.players[A]!.life).toBe(life0 + 3) // ETB lifegain
    expect(redactKeywords(state, A, angel)).toContain('flying')
  })
})

describe('targeted enters-the-battlefield triggers', () => {
  it('Flametongue Kavu deals 4 to the chosen target creature (pending target → stack → resolve)', () => {
    const { state, A, B } = makeDuel()
    const ftk = putCard(state, A, 'Flametongue Kavu', 'hand') // {3}{R}, ETB: 4 dmg to target creature
    const mtns = Array.from({ length: 4 }, () => putCard(state, A, 'Mountain'))
    const victim = putCard(state, B, 'Grizzly Bears') // 2/2 on the opponent's board
    toStep(state, 'main1')
    for (const m of mtns) act(state, A, { type: 'r.tapMana', objId: m })
    act(state, A, { type: 'r.cast', objId: ftk, targets: [] })
    // FTK resolves in, its ETB triggers and waits for A to choose a target
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'trigger target')
    act(state, A, { type: 'r.chooseTargets', targets: [victim] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[victim]!.zone).toBe('graveyard') // 4 dmg kills the 2/2
    expect(state.objects[ftk]!.zone).toBe('battlefield') // FTK survives
  })

  it('rejects an illegal target choice and a choice when none is pending', () => {
    const { state, A, B } = makeDuel()
    const ftk = putCard(state, A, 'Flametongue Kavu', 'hand')
    const mtns = Array.from({ length: 4 }, () => putCard(state, A, 'Mountain'))
    putCard(state, B, 'Grizzly Bears')
    toStep(state, 'main1')
    // not pending yet
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [] })).toThrow(/Not waiting/)
    for (const m of mtns) act(state, A, { type: 'r.tapMana', objId: m })
    act(state, A, { type: 'r.cast', objId: ftk, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'trigger target')
    // a land is not a legal 'creature' target
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [mtns[0]!] })).toThrow(/target/i)
  })
})

describe('watch-others triggers', () => {
  it('Soul Warden gains life when another creature enters (not for itself)', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Soul Warden') // watches other creatures entering → gain 1
    const bears = putCard(state, A, 'Grizzly Bears', 'hand')
    const forests = [putCard(state, A, 'Forest'), putCard(state, A, 'Forest')]
    toStep(state, 'main1')
    const life0 = state.players[A]!.life
    for (const f of forests) act(state, A, { type: 'r.tapMana', objId: f })
    act(state, A, { type: 'r.cast', objId: bears, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[bears]!.zone).toBe('battlefield')
    expect(state.players[A]!.life).toBe(life0 + 1) // Soul Warden saw the Bears enter
  })
})

describe('death (dies) triggers + tokens', () => {
  it('Doomed Traveler leaves a 1/1 flying Spirit token when it dies', () => {
    const { state, A } = makeDuel()
    const dt = putCard(state, A, 'Doomed Traveler') // 1/1, dies → 1/1 flying Spirit
    state.objects[dt]!.damageMarked = 5 // lethal
    checkSBA(state) // it dies → dies trigger goes on the stack
    expect(state.objects[dt]!.zone).toBe('graveyard')
    until(state, (s) => s.zones.stack.length === 0 && !!s.priorityPlayer, 'trigger resolves')
    const spiritId = state.zones.perPlayer[A]!.battlefield.find((id: string) => {
      const o = state.objects[id]
      return !!o && o.defName.startsWith('itok:') && o.defName.includes('spirit')
    })
    expect(spiritId, 'a Spirit token exists on the battlefield').toBeTruthy()
    // it's a real, mortal token: 1/1 flying
    const view = redactRulesState(state, A)
    expect(view.cards[spiritId!]!.power).toBe(1)
    expect(view.cards[spiritId!]!.keywords).toContain('flying')
    expect(view.cards[spiritId!]!.unimplemented).toBe(false)
  })

  it('Zulaport Cutthroat drains when one of your creatures dies', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Zulaport Cutthroat') // watch: your creatures dying → each opp -1, you +1
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2 you control
    const la = state.players[A]!.life
    const lb = state.players[B]!.life
    state.objects[bears]!.damageMarked = 5
    checkSBA(state) // bears dies → Zulaport triggers
    until(state, (s) => s.zones.stack.length === 0 && !!s.priorityPlayer, 'drain resolves')
    expect(state.players[B]!.life).toBe(lb - 1)
    expect(state.players[A]!.life).toBe(la + 1)
  })

  it('Zulaport drains for its own death too (watch includes self)', () => {
    const { state, A, B } = makeDuel()
    const zula = putCard(state, A, 'Zulaport Cutthroat')
    const lb = state.players[B]!.life
    state.objects[zula]!.damageMarked = 5
    checkSBA(state)
    until(state, (s) => s.zones.stack.length === 0 && !!s.priorityPlayer, 'drain resolves')
    expect(state.players[B]!.life).toBe(lb - 1)
  })

  it('a dies trigger does NOT fire when the card is discarded (hand → graveyard is not a death)', () => {
    const { state, A } = makeDuel()
    const dt = putCard(state, A, 'Doomed Traveler', 'hand')
    act(state, A, { type: 'r.mMove', objId: dt, zone: 'graveyard' }) // from hand, not the battlefield
    expect(state.zones.stack.length).toBe(0) // no trigger
    expect(state.zones.perPlayer[A]!.battlefield.length).toBe(0) // no Spirit token
  })
})
