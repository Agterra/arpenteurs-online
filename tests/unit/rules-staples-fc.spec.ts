/**
 * Coverage batch FC: fight (power-based, two targets) + enters-with-counters.
 *  - fight(): [your creature, an opponent's creature] each deal power to the other
 *    (Pounce, Prey Upon); target filters enforce the you/opponent split; deathtouch
 *    honored.
 *  - entersWithCounters: a creature enters with N +1/+1 counters (Faithful Watchdog,
 *    a 0/0 → 3/3), applied by moveTo on any battlefield entry, before SBA.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor } from '../../shared/rules/types.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = ReturnType<typeof makeDuel>['state']
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')

describe('Pounce / Prey Upon — fight', () => {
  it('each creature deals its power to the other', () => {
    const { state, A, B } = makeDuel()
    const pounce = putCard(state, A, 'Pounce', 'hand')
    const mine = putCard(state, A, 'Hill Giant', 'battlefield') // 3/3
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    act(state, A, { type: 'r.cast', objId: pounce, targets: [mine, theirs] })
    resolve(state, A)
    expect(state.objects[theirs]!.zone).toBe('graveyard') // took 3 (lethal)
    expect(state.objects[mine]!.zone).toBe('battlefield') // took 2, survives
    expect(state.objects[mine]!.damageMarked).toBe(2)
  })

  it('mutual lethal kills both', () => {
    const { state, A, B } = makeDuel()
    const prey = putCard(state, A, 'Prey Upon', 'hand')
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2
    const theirs = putCard(state, B, 'Gray Ogre', 'battlefield') // 2/2
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.cast', objId: prey, targets: [mine, theirs] })
    resolve(state, A)
    expect(state.objects[mine]!.zone).toBe('graveyard')
    expect(state.objects[theirs]!.zone).toBe('graveyard')
  })

  it('deathtouch makes a fighter lethal regardless of size', () => {
    const { state, A, B } = makeDuel()
    const pounce = putCard(state, A, 'Pounce', 'hand')
    const hawk = putCard(state, A, 'Vampire Nighthawk', 'battlefield') // 2/3 deathtouch
    const giant = putCard(state, B, 'Hill Giant', 'battlefield') // 3/3
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    act(state, A, { type: 'r.cast', objId: pounce, targets: [hawk, giant] })
    resolve(state, A)
    expect(state.objects[giant]!.zone).toBe('graveyard') // 2 deathtouch damage = lethal
  })

  // regression (adversarial review): fight must use current (layer-6) keywords, not printed
  it('does not apply deathtouch from a fighter that has lost its abilities', () => {
    const { state, A, B } = makeDuel()
    const pounce = putCard(state, A, 'Pounce', 'hand')
    const hawk = putCard(state, A, 'Vampire Nighthawk', 'battlefield') // printed 2/3 deathtouch
    const giant = putCard(state, B, 'Hill Giant', 'battlefield') // 3/3
    state.loseAbilities.push(hawk) // Nighthawk has lost all abilities → no deathtouch
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    act(state, A, { type: 'r.cast', objId: pounce, targets: [hawk, giant] })
    resolve(state, A)
    expect(state.objects[giant]!.zone).toBe('battlefield') // 2 non-deathtouch damage, survives
  })

  // regression: fight damage triggers lifelink (printed AND granted)
  it('gains life for a lifelink fighter', () => {
    const { state, A, B } = makeDuel()
    const pounce = putCard(state, A, 'Pounce', 'hand')
    const hawk = putCard(state, A, 'Vampire Nighthawk', 'battlefield') // 2/3 lifelink
    const giant = putCard(state, B, 'Hill Giant', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    const life = state.players[A]!.life
    act(state, A, { type: 'r.cast', objId: pounce, targets: [hawk, giant] })
    resolve(state, A)
    expect(state.players[A]!.life).toBe(life + 2) // lifelink for the 2 damage dealt
  })

  it('gains life for GRANTED lifelink (equipment) — proving current, not printed, keywords', () => {
    const { state, A, B } = makeDuel()
    const pounce = putCard(state, A, 'Pounce', 'hand')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2
    const wh = putCard(state, A, 'Loxodon Warhammer', 'battlefield') // +3/+0, grants lifelink
    state.objects[wh]!.attachedTo = bear // 5/2 with lifelink
    const giant = putCard(state, B, 'Hill Giant', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    const life = state.players[A]!.life
    act(state, A, { type: 'r.cast', objId: pounce, targets: [bear, giant] })
    resolve(state, A)
    expect(state.players[A]!.life).toBe(life + 5) // 5 power → 5 life via granted lifelink
  })

  it('enforces the you/opponent target split', () => {
    const { state, A, B } = makeDuel()
    const pounce = putCard(state, A, 'Pounce', 'hand')
    const a1 = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const a2 = putCard(state, A, 'Gray Ogre', 'battlefield')
    const b1 = putCard(state, B, 'Hill Giant', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    // second target must be an opponent's creature; first must be yours
    expect(() => act(state, A, { type: 'r.cast', objId: pounce, targets: [a1, a2] })).toThrow()
    expect(() => act(state, A, { type: 'r.cast', objId: pounce, targets: [b1, a1] })).toThrow()
  })
})

describe('Faithful Watchdog — enters with three +1/+1 counters', () => {
  it('a 0/0 enters as a 3/3 and survives', () => {
    const { state, A } = makeDuel()
    const wd = putCard(state, A, 'Faithful Watchdog', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'W', 1)
    act(state, A, { type: 'r.cast', objId: wd, targets: [] })
    resolve(state, A)
    expect(state.objects[wd]!.zone).toBe('battlefield') // not SBA-killed as a 0/0
    expect(state.objects[wd]!.counters['+1/+1']).toBe(3)
    const c = redactRulesState(state, A).cards[wd]!
    expect(c.power).toBe(3)
    expect(c.toughness).toBe(3)
  })
})
