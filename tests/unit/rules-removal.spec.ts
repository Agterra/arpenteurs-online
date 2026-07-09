/**
 * "Target any permanent" removal (capability batch 1): destroy that can hit
 * lands, artifacts and creatures — not just creatures. Leak-safe: every touched
 * zone (battlefield → graveyard, token creation) is public.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'

type St = ReturnType<typeof makeDuel>['state']

/** Cast a targeted spell (already in A's hand), paying with all of A's lands, then resolve it. */
function castAt(state: St, A: string, handCardId: string, target: string) {
  toStep(state, 'main1')
  for (const id of [...state.zones.perPlayer[A]!.battlefield]) act(state, A, { type: 'r.tapMana', objId: id })
  act(state, A, { type: 'r.cast', objId: handCardId, targets: [target] })
  until(state, (s) => !s.zones.stack.length, 'spell resolves')
}

const tokensOf = (state: St, pid: string, name: string) =>
  state.zones.perPlayer[pid]!.battlefield.map((id) => state.objects[id]!).filter((o) => getDef(o.defName).name === name)

describe('Beast Within — destroy target permanent, its controller gets a 3/3 Beast', () => {
  it('destroys a noncreature permanent (a land) and gives its controller a Beast', () => {
    const { state, A, B } = makeDuel()
    const spell = putCard(state, A, 'Beast Within', 'hand')
    for (let i = 0; i < 3; i++) putCard(state, A, 'Forest', 'battlefield')
    const mountain = putCard(state, B, 'Mountain', 'battlefield')

    castAt(state, A, spell, mountain)

    expect(state.objects[mountain]!.zone).toBe('graveyard')
    const beasts = tokensOf(state, B, 'Beast')
    expect(beasts).toHaveLength(1)
    expect(getDef(beasts[0]!.defName).power).toBe(3)
    expect(getDef(beasts[0]!.defName).toughness).toBe(3)
  })

  it('can also target a creature (any permanent includes creatures)', () => {
    const { state, A, B } = makeDuel()
    const spell = putCard(state, A, 'Beast Within', 'hand')
    for (let i = 0; i < 3; i++) putCard(state, A, 'Forest', 'battlefield')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')

    castAt(state, A, spell, bear)

    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(tokensOf(state, B, 'Beast')).toHaveLength(1)
  })
})

describe('Vindicate — destroy target permanent (no rider)', () => {
  it('destroys an opponent artifact and creates no token', () => {
    const { state, A, B } = makeDuel()
    const spell = putCard(state, A, 'Vindicate', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')

    castAt(state, A, spell, rock)

    expect(state.objects[rock]!.zone).toBe('graveyard')
    expect(state.zones.perPlayer[B]!.battlefield).toHaveLength(0)
  })
})
