/**
 * Coverage batch B7: exile removal. Leak-safe (battlefield→exile is public→public,
 * no id re-mint). Swords reads the exiled creature's power for the life rider;
 * a commander that would be exiled goes to its command zone instead.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, commanderObj, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'

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

describe('Swords to Plowshares — exile a creature, its controller gains life = power', () => {
  it("exiles the creature and gives its controller life equal to the creature's power", () => {
    const { state, A, B } = makeDuel()
    const swords = putCard(state, A, 'Swords to Plowshares', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2
    const bLife = state.players[B]!.life
    castAt(state, A, swords, [bear])
    expect(state.objects[bear]!.zone).toBe('exile')
    expect(state.players[B]!.life).toBe(bLife + 2) // B controls the bear → B gains 2
  })

  it('sends an exiled commander to the command zone instead', () => {
    const { state, A, B } = makeDuel()
    const swords = putCard(state, A, 'Swords to Plowshares', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    // move B's commander from the command zone onto the battlefield
    const cmd = commanderObj(state, B)
    state.zones.perPlayer[B]!.command = state.zones.perPlayer[B]!.command.filter((i) => i !== cmd)
    state.objects[cmd]!.zone = 'battlefield'
    state.zones.perPlayer[B]!.battlefield.push(cmd)
    castAt(state, A, swords, [cmd])
    expect(state.objects[cmd]!.zone).toBe('command')
    expect(state.zones.perPlayer[B]!.command).toContain(cmd)
  })
})

describe('Utter End — exile target nonland permanent', () => {
  it('exiles an artifact', () => {
    const { state, A, B } = makeDuel()
    const ue = putCard(state, A, 'Utter End', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    putCard(state, A, 'Plains', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')
    castAt(state, A, ue, [rock])
    expect(state.objects[rock]!.zone).toBe('exile')
  })

  it('cannot target a land (nonland filter)', () => {
    const { state, A, B } = makeDuel()
    const ue = putCard(state, A, 'Utter End', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    putCard(state, A, 'Plains', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const land = putCard(state, B, 'Mountain', 'battlefield')
    toStep(state, 'main1')
    tapLands(state, A)
    expect(() => act(state, A, { type: 'r.cast', objId: ue, targets: [land] })).toThrow()
  })
})
