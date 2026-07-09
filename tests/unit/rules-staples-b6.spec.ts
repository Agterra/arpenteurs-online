/**
 * Coverage batch B6: +1/+1 counter placement. Leak-safe (counters serialize on
 * public battlefield cards; layer 7d + SBA 704.5q already handle them). Also
 * exercises the controller:'you' target filter and the Cathars' Crusade token
 * payoff (relies on the token-ETB-trigger fix).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { currentPower } from '../../server/rules/characteristics.ts'

type St = ReturnType<typeof makeDuel>['state']
function tapLands(state: St, A: string) {
  for (const id of [...state.zones.perPlayer[A]!.battlefield]) {
    const hasMana = getDef(state.objects[id]!.defName).abilities?.some((a) => a.kind === 'activated' && a.isMana)
    if (hasMana) act(state, A, { type: 'r.tapMana', objId: id })
  }
}
function castAt(state: St, A: string, spellId: string, targets: string[]) {
  toStep(state, 'main1')
  tapLands(state, A)
  act(state, A, { type: 'r.cast', objId: spellId, targets })
  until(state, (s) => !s.zones.stack.length, 'spell resolves')
}
const pow = (state: St, id: string) => currentPower(state, state.objects[id]!)

describe('Gird for Battle — two +1/+1 counters on a creature you control', () => {
  it('buffs your own creature by +2/+2', () => {
    const { state, A } = makeDuel()
    const gird = putCard(state, A, 'Gird for Battle', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2
    castAt(state, A, gird, [bear])
    expect(state.objects[bear]!.counters['+1/+1']).toBe(2)
    expect(pow(state, bear)).toBe(4)
  })

  it("cannot target an opponent's creature (controller:'you' filter)", () => {
    const { state, A, B } = makeDuel()
    const gird = putCard(state, A, 'Gird for Battle', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    const oppBear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    tapLands(state, A)
    expect(() => act(state, A, { type: 'r.cast', objId: gird, targets: [oppBear] })).toThrow()
  })
})

describe("Cathars' Crusade — counter on each of your creatures whenever one enters", () => {
  it('pumps the whole team (including tokens) as creatures enter', () => {
    const { state, A } = makeDuel()
    putCard(state, A, "Cathars' Crusade", 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2 already out
    const spell = putCard(state, A, 'Raise the Alarm', 'hand') // makes two 1/1 Soldiers
    putCard(state, A, 'Plains', 'battlefield')
    putCard(state, A, 'Plains', 'battlefield')
    castAt(state, A, spell, [])
    // two Soldiers entered → Crusade fired twice → +2/+2 on every creature you control
    expect(state.objects[bear]!.counters['+1/+1']).toBe(2)
    expect(pow(state, bear)).toBe(4)
    const soldiers = state.zones.perPlayer[A]!.battlefield
      .map((id) => state.objects[id]!)
      .filter((o) => getDef(o.defName).name === 'Soldier')
    expect(soldiers).toHaveLength(2)
    // each soldier: entered, then got counters from the OTHER's entry (order-dependent, ≥1 each)
    for (const s of soldiers) expect((s.counters['+1/+1'] ?? 0)).toBeGreaterThanOrEqual(1)
  })
})
