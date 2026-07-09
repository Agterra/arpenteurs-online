/**
 * Coverage batch B2 (pure-data staples): go-wide token spells, ETB value
 * creatures, static anthems + tribal lords. Leak-safe by construction (tokens/
 * counters/statics are battlefield-public; no public→hidden move). Dies-watch
 * aristocrats (Cruel Celebrant / Bastion) reuse the machinery already covered by
 * Doomed Traveler / Zulaport tests, so they aren't re-exercised here.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { currentPower, currentKeywords } from '../../server/rules/characteristics.ts'

type St = ReturnType<typeof makeDuel>['state']

function castAt(state: St, A: string, spellId: string, targets: string[] = []) {
  toStep(state, 'main1')
  // tap only mana sources (skip non-mana permanents like Soul Warden / Impact Tremors)
  for (const id of [...state.zones.perPlayer[A]!.battlefield]) {
    const hasMana = getDef(state.objects[id]!.defName).abilities?.some((a) => a.kind === 'activated' && a.isMana)
    if (hasMana) act(state, A, { type: 'r.tapMana', objId: id })
  }
  act(state, A, { type: 'r.cast', objId: spellId, targets })
  until(state, (s) => !s.zones.stack.length, 'spell resolves')
}

const tokensOf = (state: St, pid: string, name: string) =>
  state.zones.perPlayer[pid]!.battlefield.map((id) => state.objects[id]!).filter((o) => getDef(o.defName).name === name)

describe('B2 token spells', () => {
  it('Raise the Alarm makes two 1/1 Soldier tokens', () => {
    const { state, A } = makeDuel()
    const spell = putCard(state, A, 'Raise the Alarm', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    putCard(state, A, 'Plains', 'battlefield')
    castAt(state, A, spell)
    expect(tokensOf(state, A, 'Soldier')).toHaveLength(2)
  })
})

describe('B2 ETB value', () => {
  it('Cloudblazer draws two and gains two on entry', () => {
    const { state, A } = makeDuel()
    const cb = putCard(state, A, 'Cloudblazer', 'hand')
    for (let i = 0; i < 3; i++) putCard(state, A, 'Plains', 'battlefield')
    for (let i = 0; i < 2; i++) putCard(state, A, 'Island', 'battlefield')
    const life = state.players[A]!.life
    castAt(state, A, cb)
    expect(state.players[A]!.life).toBe(life + 2)
    // Cloudblazer resolved onto the battlefield as a 2/2 flyer
    const cloud = state.zones.perPlayer[A]!.battlefield.find((id) => getDef(state.objects[id]!.defName).name === 'Cloudblazer')!
    expect(cloud).toBeTruthy()
    expect(currentKeywords(state, state.objects[cloud]!)).toContain('flying')
  })
})

describe('B2 anthems & tribal lords', () => {
  it("Gaea's Anthem gives your creatures +1/+1", () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2
    expect(currentPower(state, state.objects[bear]!)).toBe(2)
    putCard(state, A, "Gaea's Anthem", 'battlefield')
    expect(currentPower(state, state.objects[bear]!)).toBe(3)
  })

  it('Goblin Chieftain buffs OTHER Goblins (+1/+1 and haste) but not itself', () => {
    const { state, A } = makeDuel()
    const chief = putCard(state, A, 'Goblin Chieftain', 'battlefield') // 2/2 Goblin, has haste
    const brute = putCard(state, A, 'Boggart Brute', 'battlefield') // 3/2 Goblin, menace, no haste
    // the other Goblin is pumped and gains haste
    expect(currentPower(state, state.objects[brute]!)).toBe(4)
    expect(currentKeywords(state, state.objects[brute]!)).toContain('haste')
    // the Chieftain does not pump itself (excludeSelf)
    expect(currentPower(state, state.objects[chief]!)).toBe(2)
  })
})

describe('token creation fires ETB triggers (engine fix)', () => {
  it('Soul Warden gains life for each token that enters', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Soul Warden', 'battlefield')
    const spell = putCard(state, A, 'Raise the Alarm', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    putCard(state, A, 'Plains', 'battlefield')
    const life = state.players[A]!.life
    castAt(state, A, spell) // makes two 1/1 Soldiers
    expect(state.players[A]!.life).toBe(life + 2)
  })

  it('Impact Tremors pings each opponent for every creature-token entry', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Impact Tremors', 'battlefield')
    const spell = putCard(state, A, 'Dragon Fodder', 'hand')
    putCard(state, A, 'Mountain', 'battlefield')
    putCard(state, A, 'Mountain', 'battlefield')
    const life = state.players[B]!.life
    castAt(state, A, spell) // makes two 1/1 Goblins
    expect(state.players[B]!.life).toBe(life - 2)
  })
})
