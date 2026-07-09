/**
 * Coverage batch B8: bounce (return to hand) — the first LEAK-CRITICAL effect
 * (public→hidden). Asserts the bounced card's id is re-minted and never leaks to
 * an opponent, and that a bounced commander is rerouted to the command zone
 * (never a hidden hand, whose id would leak via player.commanderId).
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, commanderObj, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

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

describe('Unsummon — bounce is leak-safe (re-mint + no opponent leak)', () => {
  it("re-mints the bounced card's id and keeps the opponent's hand count-only", () => {
    const { state, A, B } = makeDuel()
    const unsummon = putCard(state, A, 'Unsummon', 'hand')
    putCard(state, A, 'Island', 'battlefield')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    castAt(state, A, unsummon, [bear])

    // the old battlefield id is gone → it was re-minted on hand entry (invariant #3)
    expect(state.objects[bear]).toBeUndefined()
    // opponent A's redacted view must not contain ANY id now in B's hidden hand,
    // and B's hand must arrive as count-only (not an id array)
    const aView = redactRulesState(state, A)
    const json = JSON.stringify(aView)
    for (const id of state.zones.perPlayer[B]!.hand)
      expect(json.includes(id), `bounced hand id ${id} leaked to opponent`).toBe(false)
    expect(json.includes(bear), 'old battlefield id leaked').toBe(false)
    expect(Array.isArray(aView.zones.perPlayer[B]!.hand)).toBe(false)
  })
})

describe('Boomerang — bouncing a commander reroutes it to the command zone', () => {
  it('a commander goes to the command zone, never to hand', () => {
    const { state, A, B } = makeDuel()
    const boomerang = putCard(state, A, 'Boomerang', 'hand')
    putCard(state, A, 'Island', 'battlefield')
    putCard(state, A, 'Island', 'battlefield')
    // move B's commander onto the battlefield
    const cmd = commanderObj(state, B)
    state.zones.perPlayer[B]!.command = state.zones.perPlayer[B]!.command.filter((i) => i !== cmd)
    state.objects[cmd]!.zone = 'battlefield'
    state.zones.perPlayer[B]!.battlefield.push(cmd)
    castAt(state, A, boomerang, [cmd])
    expect(state.objects[cmd]!.zone).toBe('command') // id stable (public), no leak
    expect(state.zones.perPlayer[B]!.command).toContain(cmd)
    expect(state.zones.perPlayer[B]!.hand).not.toContain(cmd)
  })
})

describe("Man-o'-War — ETB bounce", () => {
  it('its ETB returns a chosen creature to hand', () => {
    const { state, A, B } = makeDuel()
    const mow = putCard(state, A, "Man-o'-War", 'hand')
    for (let i = 0; i < 3; i++) putCard(state, A, 'Island', 'battlefield')
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    tapLands(state, A)
    act(state, A, { type: 'r.cast', objId: mow, targets: [] })
    until(state, (s) => s.pending?.kind === 'trigger', 'man-o-war ETB')
    act(state, A, { type: 'r.chooseTargets', targets: [bear] })
    until(state, (s) => !s.zones.stack.length, 'ETB resolves')
    expect(state.objects[bear]).toBeUndefined() // bounced (re-minted) off the battlefield
  })
})
