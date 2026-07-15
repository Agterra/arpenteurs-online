/**
 * Coverage batch PW: planeswalkers (loyalty core).
 *  - enter with starting loyalty; loyalty abilities are sorcery-speed, once per turn,
 *    pay their +N/−N cost immediately (a −ability needs enough loyalty); the effect
 *    then resolves off the stack; a 0-loyalty planeswalker dies (SBA 704.5i); the
 *    once-per-turn lock resets on the controller's next untap.
 *  - Planeswalker attackability + emblems are deliberately DEFERRED (documented).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor } from '../../shared/rules/types.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { checkSBA } from '../../server/rules/engine.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = ReturnType<typeof makeDuel>['state']
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')
/** put a planeswalker straight onto the battlefield with its starting loyalty. */
function putPW(state: St, p: string, name: string, loyalty: number) {
  const id = putCard(state, p, name, 'battlefield')
  state.objects[id]!.loyalty = loyalty
  return id
}

describe('Nissa, Voice of Zendikar — loyalty core', () => {
  it('enters with loyalty 3, +1 makes a Plant and raises loyalty, and is once-per-turn', () => {
    const { state, A } = makeDuel()
    const nissa = putCard(state, A, 'Nissa, Voice of Zendikar', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 3) // {1}{G}{G}
    act(state, A, { type: 'r.cast', objId: nissa, targets: [] })
    resolve(state, A)
    expect(state.objects[nissa]!.loyalty).toBe(3) // enters with starting loyalty

    act(state, A, { type: 'r.loyalty', objId: nissa, abilityIndex: 0, targets: [] }) // [+1]
    expect(state.objects[nissa]!.loyalty).toBe(4) // cost paid immediately
    resolve(state, A)
    const plants = state.zones.perPlayer[A]!.battlefield.filter((id) => getDef(state.objects[id]!.defName).name === 'Plant')
    expect(plants.length).toBe(1)

    // a second loyalty ability the same turn is illegal (CR 606.3)
    expect(() => act(state, A, { type: 'r.loyalty', objId: nissa, abilityIndex: 1, targets: [] })).toThrow()
  })

  it('[−2] lowers loyalty and puts a +1/+1 counter on each of your creatures', () => {
    const { state, A } = makeDuel()
    const nissa = putPW(state, A, 'Nissa, Voice of Zendikar', 3)
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.loyalty', objId: nissa, abilityIndex: 1, targets: [] }) // [−2]
    expect(state.objects[nissa]!.loyalty).toBe(1)
    resolve(state, A)
    expect(state.objects[bear]!.counters['+1/+1']).toBe(1)
  })

  it('rejects a −ability the planeswalker cannot afford', () => {
    const { state, A } = makeDuel()
    const nissa = putPW(state, A, 'Nissa, Voice of Zendikar', 3)
    toStep(state, 'main1')
    // [−7] with only 3 loyalty → illegal
    expect(() => act(state, A, { type: 'r.loyalty', objId: nissa, abilityIndex: 2, targets: [] })).toThrow()
  })

  it('is put into the graveyard at 0 loyalty (SBA), and rejects loyalty at instant speed', () => {
    const { state, A } = makeDuel()
    const nissa = putPW(state, A, 'Nissa, Voice of Zendikar', 3)
    // loyalty ability outside a main phase (still at upkeep) is illegal
    expect(() => act(state, A, { type: 'r.loyalty', objId: nissa, abilityIndex: 0, targets: [] })).toThrow()
    // drop to 0 → dies as a state-based action
    state.objects[nissa]!.loyalty = 0
    checkSBA(state)
    expect(state.objects[nissa]!.zone).toBe('graveyard')
  })

  it('re-enables a loyalty ability on the controller\'s next turn', () => {
    const { state, A } = makeDuel()
    const nissa = putCard(state, A, 'Nissa, Voice of Zendikar', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 3)
    act(state, A, { type: 'r.cast', objId: nissa, targets: [] })
    resolve(state, A)
    act(state, A, { type: 'r.loyalty', objId: nissa, abilityIndex: 0, targets: [] }) // +1 → 4
    resolve(state, A)
    // advance to A's next turn (turn 3 in a 2-player game); untap resets the once-per-turn lock
    until(state, (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A && !s.zones.stack.length, 'A turn 3 main1')
    act(state, A, { type: 'r.loyalty', objId: nissa, abilityIndex: 0, targets: [] }) // +1 again → 5
    expect(state.objects[nissa]!.loyalty).toBe(5)
  })
})

// --- regression tests for the adversarial-review findings ---

describe('planeswalker loyalty is initialized on ANY battlefield entry (not just cast)', () => {
  it('a planeswalker moved onto the battlefield (non-cast) enters with its starting loyalty, not SBA-killed', () => {
    const { state, A } = makeDuel()
    const nissa = putCard(state, A, 'Nissa, Voice of Zendikar', 'hand')
    // assisted-table hand-run "put onto the battlefield" via the manual override
    act(state, A, { type: 'r.mMove', objId: nissa, zone: 'battlefield' })
    expect(state.objects[nissa]!.zone).toBe('battlefield') // NOT instantly destroyed
    expect(state.objects[nissa]!.loyalty).toBe(3) // starting loyalty was initialized
  })
})

describe('static keyword grants only reach creatures (not lands / other permanents)', () => {
  it("Ajani's vigilance grant applies to your creatures but not your lands", () => {
    const { state, A } = makeDuel()
    putPW(state, A, 'Ajani, the Greathearted', 5)
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const forest = putCard(state, A, 'Forest', 'battlefield')
    expect(redactRulesState(state, A).cards[bear]!.keywords).toContain('vigilance')
    expect(redactRulesState(state, A).cards[forest]!.keywords).not.toContain('vigilance')
  })
})

describe('Ajani, the Greathearted — static grant + gain-life loyalty ability', () => {
  it('grants your creatures vigilance and [+1] gains 3 life', () => {
    const { state, A } = makeDuel()
    const ajani = putPW(state, A, 'Ajani, the Greathearted', 5)
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    expect(redactRulesState(state, A).cards[bear]!.keywords).toContain('vigilance')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.loyalty', objId: ajani, abilityIndex: 0, targets: [] }) // [+1] gain 3
    expect(state.objects[ajani]!.loyalty).toBe(6)
    resolve(state, A)
    expect(state.players[A]!.life).toBe(life + 3)
  })
})
