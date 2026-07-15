/**
 * Coverage batch SUB3: PHASING (CR 702.26 / 502.1). A permanent with `phasing` phases out at the
 * start of its controller's untap step and phases back in the untap step after — alternating each
 * of that player's turns. A phased-out permanent stays in the battlefield zone but is treated as
 * though it doesn't exist: it can't be targeted, blocked with, hit by sweepers, tapped for mana,
 * or activated, and its static abilities are off. Phasing never counts as entering/leaving (no
 * ETB/LTB, no summoning-sickness reset). Attachments phase out and in WITH their host (indirect).
 * Card: Teferi's Honor Guard {3}{W} 2/4 phasing.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, until } from './rules-helpers.ts'
import { battlefieldCreatures } from '../../server/rules/state.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')
/** advance to player A's main1 on turn `turn` (its untap — and thus phasing — has already run). */
const toAMain1 = (state: St, A: PlayerId, turn: number) =>
  until(
    state,
    (s) => s.turnNumber >= turn && s.activePlayer === A && s.step === 'main1' && s.priorityPlayer === A && !s.zones.stack.length,
    `A main1 turn ${turn}`,
  )

describe('phasing — toggles out then back in on the controller\'s untap steps', () => {
  it('phases out at the next untap, is untargetable/unswept while out, then phases back in', () => {
    const { state, A, B } = makeDuel()
    const guard = putCard(state, A, "Teferi's Honor Guard", 'battlefield') // 2/4 phasing (phased in)
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2 control — no phasing

    // A's turn 3 untap: the guard (phasing, phased in) phases OUT
    toAMain1(state, A, 3)
    expect(state.objects[guard]!.phasedOut).toBe(true)
    expect(state.objects[bear]!.phasedOut).toBeFalsy()
    // treated as not existing: not among A's battlefield creatures
    expect(battlefieldCreatures(state, A).map((c) => c.id)).not.toContain(guard)
    expect(battlefieldCreatures(state, A).map((c) => c.id)).toContain(bear)

    // a red spell can't target the phased-out guard (illegal target)
    const shock = putCard(state, A, 'Shock', 'hand')
    addMana(state, A, 'R', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: shock, targets: [guard] })).toThrow()

    // a sweeper skips the phased-out guard but hits the (phased-in) bear
    const pyro = putCard(state, A, 'Pyroclasm', 'hand') // 2 damage to each creature
    addMana(state, A, 'R', 2)
    act(state, A, { type: 'r.cast', objId: pyro, targets: [] })
    resolve(state, A)
    expect(state.objects[guard]!.damageMarked).toBe(0) // untouched — doesn't exist
    expect(state.objects[bear]!.zone).toBe('graveyard') // 2 damage to a 2/2 → dead

    // A's turn 5 untap: the guard phases back IN, untapped, and NOT summoning sick (continuous control)
    toAMain1(state, A, 5)
    expect(state.objects[guard]!.phasedOut).toBe(false)
    expect(state.objects[guard]!.zone).toBe('battlefield')
    expect(state.objects[guard]!.tapped).toBe(false)
    expect(state.objects[guard]!.summoningSick).toBe(false)
    expect(battlefieldCreatures(state, A).map((c) => c.id)).toContain(guard)
    // sanity: B is unaffected
    expect(B).toBeTruthy()
  })
})

describe('phasing — attachments phase with their host (indirect phasing, CR 702.26e)', () => {
  it('an Equipment on a phasing creature phases out and back in with it, staying attached', () => {
    const { state, A } = makeDuel()
    const guard = putCard(state, A, "Teferi's Honor Guard", 'battlefield')
    const bone = putCard(state, A, 'Bonesplitter', 'battlefield') // Equipment +2/+0
    state.objects[bone]!.attachedTo = guard

    toAMain1(state, A, 3) // guard phases out → drags Bonesplitter out with it
    expect(state.objects[guard]!.phasedOut).toBe(true)
    expect(state.objects[bone]!.phasedOut).toBe(true)
    expect(state.objects[bone]!.phasedOutBy).toBe(guard)

    toAMain1(state, A, 5) // guard phases in → Bonesplitter phases in with it, still attached
    expect(state.objects[guard]!.phasedOut).toBe(false)
    expect(state.objects[bone]!.phasedOut).toBe(false)
    expect(state.objects[bone]!.phasedOutBy).toBeUndefined()
    expect(state.objects[bone]!.attachedTo).toBe(guard)
  })
})
