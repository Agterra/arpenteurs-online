/**
 * Coverage batch B1 (pure-data staples): mana fixing (any-colour dorks/rocks,
 * scry Temples), efficient burn/removal, and card draw. Leak-safe by construction
 * (no public→hidden moves). Also exercises the r.playLand ETB-trigger fix.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'

type St = ReturnType<typeof makeDuel>['state']

function castAt(state: St, A: string, spellId: string, targets: string[]) {
  toStep(state, 'main1')
  for (const id of [...state.zones.perPlayer[A]!.battlefield]) act(state, A, { type: 'r.tapMana', objId: id })
  act(state, A, { type: 'r.cast', objId: spellId, targets })
  until(state, (s) => !s.zones.stack.length, 'spell resolves')
}

describe('B1 mana fixing', () => {
  it('Birds of Paradise taps for any chosen colour', () => {
    const { state, A } = makeDuel()
    const birds = putCard(state, A, 'Birds of Paradise', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: birds, color: 'U' })
    expect(state.players[A]!.manaPool.U).toBe(1)
    expect(state.objects[birds]!.tapped).toBe(true)
  })

  it('a scry Temple enters tapped and fires its ETB scry trigger when played as a land', () => {
    const { state, A } = makeDuel()
    const temple = putCard(state, A, 'Temple of Enlightenment', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: temple })
    // enters tapped…
    expect(state.objects[temple]!.tapped).toBe(true)
    // …and the ETB scry ability is now on the stack (the r.playLand ETB fix)
    expect(state.zones.stack.some((s) => s.kind === 'ability' && s.trigger === 'etb')).toBe(true)
    // resolve it → the controller is now scrying
    until(state, (s) => s.pending?.kind === 'scry', 'temple scry')
    expect(state.pendingScry?.player).toBe(A)
  })
})

describe('B1 burn & removal', () => {
  it('Lightning Strike deals 3 to a player', () => {
    const { state, A, B } = makeDuel()
    const bolt = putCard(state, A, 'Lightning Strike', 'hand')
    putCard(state, A, 'Mountain', 'battlefield')
    putCard(state, A, 'Mountain', 'battlefield')
    const before = state.players[B]!.life
    castAt(state, A, bolt, [B])
    expect(state.players[B]!.life).toBe(before - 3)
  })

  it('Grasp of Darkness kills a 2/2 with -4/-4', () => {
    const { state, A, B } = makeDuel()
    const grasp = putCard(state, A, 'Grasp of Darkness', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    castAt(state, A, grasp, [bear])
    expect(state.objects[bear]!.zone).toBe('graveyard')
  })
})

describe('B1 card draw', () => {
  it('Harmonize draws three cards', () => {
    const { state, A } = makeDuel()
    const harm = putCard(state, A, 'Harmonize', 'hand')
    for (let i = 0; i < 4; i++) putCard(state, A, 'Forest', 'battlefield')
    const before = state.zones.perPlayer[A]!.hand.length
    castAt(state, A, harm, [])
    // drew 3 (the Harmonize itself left the hand → net +2 vs the pre-cast count minus the spell)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before - 1 + 3)
  })
})
