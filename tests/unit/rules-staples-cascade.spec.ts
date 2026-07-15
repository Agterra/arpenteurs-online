/**
 * Coverage batch CASCADE (CR 702.85). Casting a cascade spell exiles from the top of the
 * library until a nonland with mana value < the cascade spell's; the caster MAY cast that
 * hit for free; the passed-over cards go to the bottom in a random order (re-minted, since
 * they were revealed in exile — the leak-critical part, covered in rules-leak.spec.ts).
 * Bloodbraid Elf {2}{R}{G} 3/2 haste, cascade (mana value 4 → digs for MV ≤ 3).
 */
import { describe, expect, it } from 'vitest'
import { act, makeGameN, pass, putCard, rig, until } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { currentPower } from '../../server/rules/characteristics.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')
const nameOf = (state: St, id: string) => getDef(state.objects[id]!.defName).name
const CASCADE_DECK = [
  'Bloodbraid Elf',
  ...Array(3).fill('Shock'),
  'Abrade',
  "Night's Whisper",
  ...Array(24).fill('Mountain'),
  ...Array(8).fill('Forest'),
]

function setup(libraryTop: string[], librarySize: number) {
  const { state } = makeGameN(2, CASCADE_DECK)
  const A = state.activePlayer
  const B = state.turnOrder.find((p) => p !== A)!
  rig(state, A, { hand: ['Bloodbraid Elf'], libraryTop, librarySize })
  until(state, (s) => s.step === 'main1' && s.priorityPlayer === A && !s.zones.stack.length, 'main1')
  addMana(state, A, 'R', 3)
  addMana(state, A, 'G', 1) // {2}{R}{G}
  const bbe = state.zones.perPlayer[A]!.hand.find((id) => nameOf(state, id) === 'Bloodbraid Elf')!
  act(state, A, { type: 'r.cast', objId: bbe, targets: [] })
  // stack = [Bloodbraid Elf, cascade trigger]; pass both ways so the cascade trigger resolves
  pass(state, A)
  pass(state, B)
  return { state, A, B, bbe }
}

describe('cascade — cast the free hit', () => {
  it('exiles to the first low-MV nonland and casts it for free', () => {
    const { state, A, B } = setup(['Shock'], 10) // top is Shock (MV 1 < 4) → immediate hit
    expect(state.pending?.kind).toBe('cascade')
    expect(nameOf(state, state.pendingCascade!.hitId)).toBe('Shock')
    const bLife = state.players[B]!.life
    act(state, A, { type: 'r.cascade', cast: true, targets: [B] }) // free-cast Shock at B
    resolve(state, A)
    expect(state.players[B]!.life).toBe(bLife - 2) // Shock resolved for free
    expect(state.zones.perPlayer[A]!.battlefield.some((id) => nameOf(state, id) === 'Bloodbraid Elf')).toBe(true)
  })

  it('digs past lands to reach the hit, and bottoms the passed-over cards', () => {
    const { state, A, B } = setup(['Mountain', 'Mountain', 'Shock'], 5)
    expect(state.pending?.kind).toBe('cascade')
    expect(nameOf(state, state.pendingCascade!.hitId)).toBe('Shock')
    expect(state.pendingCascade!.exiledIds).toHaveLength(3) // 2 Mountains + Shock
    const libBefore = state.zones.perPlayer[A]!.library.length
    act(state, A, { type: 'r.cascade', cast: true, targets: [B] })
    resolve(state, A)
    // the 2 passed-over Mountains went back to the bottom; nothing is stranded in exile
    expect(state.zones.perPlayer[A]!.exile.length).toBe(0)
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore + 2)
  })
})

describe('cascade — decline the free hit', () => {
  it('bottoms the hit (and any passed cards) and casts nothing free', () => {
    const { state, A, B } = setup(['Shock'], 10)
    expect(state.pending?.kind).toBe('cascade')
    const bLife = state.players[B]!.life
    act(state, A, { type: 'r.cascade', cast: false, targets: [] })
    resolve(state, A)
    expect(state.players[B]!.life).toBe(bLife) // nothing was cast
    expect(state.zones.perPlayer[A]!.exile.length).toBe(0) // the hit went to the bottom
    expect(state.zones.perPlayer[A]!.battlefield.some((id) => nameOf(state, id) === 'Bloodbraid Elf')).toBe(true)
  })
})

describe('cascade — no hit (library exhausted without a low-MV nonland)', () => {
  it('bottoms everything exiled and opens no cast decision', () => {
    const { state, A } = setup(['Mountain', 'Mountain'], 0) // only two lands in the library
    // resolveCascade found no hit → no cascade pending; Bloodbraid Elf just resolves
    expect(state.pending?.kind).not.toBe('cascade')
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.exile.length).toBe(0)
    expect(state.zones.perPlayer[A]!.battlefield.some((id) => nameOf(state, id) === 'Bloodbraid Elf')).toBe(true)
  })
})

// Review fix: the client must be told accurately what it can free-cast, so it never offers a
// "Cast free" button that the server would reject (finding #1: a MODAL hit reported no target
// → target-less button → BAD_TARGETS). computeLegal now reports cascadeCanFreeCast + a single
// client-deliverable cascadeTargetKind (null for modal / multi / spell / graveyardCard).
// Review fix (KW3): a cascade FREE-CAST is still "casting a spell" (CR 702.85e), so a free-cast
// noncreature spell must trigger the caster's prowess — freeCastFromExile was skipping the hook.
describe('cascade — a free-cast noncreature spell triggers prowess (review fix)', () => {
  it('free-casting Shock via cascade pumps the caster\'s prowess creature', () => {
    const { state } = makeGameN(2, CASCADE_DECK)
    const A = state.activePlayer
    const B = state.turnOrder.find((p) => p !== A)!
    rig(state, A, { hand: ['Bloodbraid Elf'], libraryTop: ['Shock'], librarySize: 8 })
    const swift = putCard(state, A, 'Monastery Swiftspear', 'battlefield') // 1/2 prowess
    until(state, (s) => s.step === 'main1' && s.priorityPlayer === A && !s.zones.stack.length, 'main1')
    addMana(state, A, 'R', 3)
    addMana(state, A, 'G', 1)
    const bbe = state.zones.perPlayer[A]!.hand.find((id) => nameOf(state, id) === 'Bloodbraid Elf')!
    act(state, A, { type: 'r.cast', objId: bbe, targets: [] })
    expect(currentPower(state, state.objects[swift]!)).toBe(1) // Bloodbraid is a creature spell → no prowess
    pass(state, A)
    pass(state, B) // cascade trigger resolves → hit = Shock
    expect(state.pending?.kind).toBe('cascade')
    act(state, A, { type: 'r.cascade', cast: true, targets: [B] }) // free-cast Shock (noncreature)
    expect(currentPower(state, state.objects[swift]!)).toBe(2) // prowess fired on the free cast
  })
})

describe('cascade — client-castability signals (review fix)', () => {
  it('a single-target hit (Shock) reports its target kind, not a free-cast button', () => {
    const { state, A } = setup(['Shock'], 8)
    const l = computeLegal(state, A)
    expect(l.needsCascade).toBe(true)
    expect(l.cascadeTargetKind).toBe('anyTarget')
    expect(l.cascadeCanFreeCast).toBe(false)
  })
  it('a no-target hit (Night\'s Whisper) reports cascadeCanFreeCast', () => {
    const { state, A } = setup(["Night's Whisper"], 8)
    const l = computeLegal(state, A)
    expect(l.cascadeCanFreeCast).toBe(true)
    expect(l.cascadeTargetKind).toBe(null)
  })
  it('a MODAL hit (Abrade) offers neither a free-cast button nor a clickable kind (decline-only)', () => {
    const { state, A } = setup(['Abrade'], 8)
    const l = computeLegal(state, A)
    expect(l.needsCascade).toBe(true)
    expect(l.cascadeCanFreeCast).toBe(false) // ← would have been a broken "Cast free" button before
    expect(l.cascadeTargetKind).toBe(null)
  })
})
