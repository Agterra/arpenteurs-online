/**
 * Non-combat keywords: indestructible (survives lethal damage / destroy, but not
 * 0 toughness) and flash (cast at instant speed).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { checkSBA } from '../../server/rules/engine.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

describe('indestructible', () => {
  it('survives lethal combat damage but dies to 0 toughness (-1/-1)', () => {
    const { state, A } = makeDuel()
    const myr = putCard(state, A, 'Darksteel Myr') // 0/1 indestructible
    state.objects[myr]!.damageMarked = 99 // would be lethal
    checkSBA(state)
    expect(state.objects[myr]!.zone).toBe('battlefield') // indestructible ignores lethal damage
    state.objects[myr]!.counters['-1/-1'] = 1 // toughness → 0
    checkSBA(state)
    expect(state.objects[myr]!.zone).toBe('graveyard') // 0 toughness still dies (704.5f)
  })

  it('is not destroyed by a "destroy" spell', () => {
    const { state, A, B } = makeDuel()
    const myr = putCard(state, B, 'Darksteel Myr')
    const murder = putCard(state, A, 'Murder', 'hand') // {1}{B}{B} destroy target creature
    const swamps = [putCard(state, A, 'Swamp'), putCard(state, A, 'Swamp'), putCard(state, A, 'Swamp')]
    toStep(state, 'main1')
    for (const s of swamps) act(state, A, { type: 'r.tapMana', objId: s })
    act(state, A, { type: 'r.cast', objId: murder, targets: [myr] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[myr]!.zone).toBe('battlefield') // indestructible shrugs off Murder
  })

  it('survives a board wipe', () => {
    const { state, A, B } = makeDuel()
    const myr = putCard(state, B, 'Darksteel Myr')
    const bears = putCard(state, B, 'Grizzly Bears')
    const wrath = putCard(state, A, 'Wrath of God', 'hand')
    const plains = Array.from({ length: 4 }, () => putCard(state, A, 'Plains'))
    toStep(state, 'main1')
    for (const p of plains) act(state, A, { type: 'r.tapMana', objId: p })
    act(state, A, { type: 'r.cast', objId: wrath, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[bears]!.zone).toBe('graveyard')
    expect(state.objects[myr]!.zone).toBe('battlefield') // indestructible
  })
})

describe('flash', () => {
  it('lets a creature be cast at instant speed (on an opponent turn)', () => {
    const { state, A, B } = makeDuel()
    const viper = putCard(state, B, 'Ambush Viper', 'hand') // {1}{G} flash, deathtouch
    const forests = [putCard(state, B, 'Forest'), putCard(state, B, 'Forest')]
    // A's turn, A passes → B gets priority; B flashes in the Viper
    toStep(state, 'main1')
    act(state, A, { type: 'r.pass' })
    for (const f of forests) act(state, B, { type: 'r.tapMana', objId: f })
    act(state, B, { type: 'r.cast', objId: viper, targets: [] }) // flash → legal on A's turn
    until(state, (s) => !s.zones.stack.length && !!s.priorityPlayer, 'resolved')
    expect(state.objects[viper]!.zone).toBe('battlefield')
  })

  it('a non-flash creature cannot be cast on an opponent turn', () => {
    const { state, A, B } = makeDuel()
    const bears = putCard(state, B, 'Grizzly Bears', 'hand')
    const forests = [putCard(state, B, 'Forest'), putCard(state, B, 'Forest')]
    toStep(state, 'main1')
    act(state, A, { type: 'r.pass' })
    for (const f of forests) act(state, B, { type: 'r.tapMana', objId: f })
    expect(() => act(state, B, { type: 'r.cast', objId: bears, targets: [] })).toThrow(/main phase|timing/i)
  })
})

describe('hexproof', () => {
  it('an opponent cannot target it, but its controller can', () => {
    const { state, A, B } = makeDuel()
    const scout = putCard(state, B, 'Gladecover Scout') // 1/1 hexproof, B controls
    const shock = putCard(state, A, 'Shock', 'hand')
    const mtn = putCard(state, A, 'Mountain')
    const gg = putCard(state, B, 'Giant Growth', 'hand')
    const forests = [putCard(state, B, 'Forest'), putCard(state, B, 'Forest')]
    toStep(state, 'main1') // A's turn, A priority
    act(state, A, { type: 'r.tapMana', objId: mtn })
    expect(() => act(state, A, { type: 'r.cast', objId: shock, targets: [scout] })).toThrow(/Illegal target/)
    // controller CAN target its own hexproof creature (Giant Growth at instant speed)
    act(state, A, { type: 'r.pass' })
    for (const f of forests) act(state, B, { type: 'r.tapMana', objId: f })
    act(state, B, { type: 'r.cast', objId: gg, targets: [scout] })
    until(state, (s) => !s.zones.stack.length && !!s.priorityPlayer, 'resolved')
    expect(redactRulesState(state, B).cards[scout]!.power).toBe(4) // 1/1 + Giant Growth
  })
})
