/**
 * Perpetual card coverage — batch CARD53: the Eldraine land cycle — "enters tapped unless you control
 * three or more other Islands/Plains/Swamps/Mountains/Forests", with an ETB that fires only when it
 * entered UNTAPPED (an intervening "if" reading the source itself). Mystic Sanctuary and Witch's
 * Cottage put a graveyard card on top of your library — public → hidden, so the id is re-minted.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal, redactRulesState } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
/** play `land` from hand with `n` other lands of `basic` already out */
const playWith = (s: St, A: PlayerId, land: string, basic: string, n: number) => {
  for (let i = 0; i < n; i++) putCard(s, A, basic, 'battlefield')
  const id = putCard(s, A, land, 'hand')
  toStep(s, 'main1')
  act(s, A, { type: 'r.playLand', objId: id })
  return id
}

const CYCLE: [string, string, ManaColor][] = [
  ['Mystic Sanctuary', 'Island', 'U'],
  ["Witch's Cottage", 'Swamp', 'B'],
  ['Dwarven Mine', 'Mountain', 'R'],
  ['Idyllic Grange', 'Plains', 'W'],
  ['Gingerbread Cabin', 'Forest', 'G'],
]

describe('CARD53 — the enters-tapped condition', () => {
  for (const [land, basic, color] of CYCLE) {
    it(`${land}: tapped with two other ${basic}s, untapped with three`, () => {
      const a = makeDuel()
      const tappedOne = playWith(a.state, a.A, land, basic, 2)
      expect(a.state.objects[tappedOne]!.tapped).toBe(true)
      const b = makeDuel()
      const untappedOne = playWith(b.state, b.A, land, basic, 3)
      expect(b.state.objects[untappedOne]!.tapped).toBe(false)
      // and it taps for its colour either way
      b.state.objects[untappedOne]!.tapped = false
      // answer any ETB decision first
      if (b.state.pending?.kind === 'trigger') act(b.state, b.A, { type: 'r.chooseTargets', targets: [] })
      until(b.state, (s) => !s.zones.stack.length && s.priorityPlayer === b.A, 'the ETB resolves')
      act(b.state, b.A, { type: 'r.tapMana', objId: untappedOne, color })
      expect(b.state.players[b.A]!.manaPool[color]).toBe(1)
    })
  }

  it('counts only lands of that TYPE, and only OTHER ones', () => {
    const { state, A } = makeDuel()
    // three lands, but of the wrong type → still enters tapped
    const wrong = playWith(state, A, 'Mystic Sanctuary', 'Mountain', 3)
    expect(state.objects[wrong]!.tapped).toBe(true)
  })
})

describe('CARD53 — Mystic Sanctuary and Witch\'s Cottage', () => {
  it('puts a targeted instant from your graveyard on top of your library, re-minted', () => {
    const { state, A, B } = makeDuel()
    const dead = putCard(state, A, 'Shock', 'graveyard')
    const libBefore = state.zones.perPlayer[A]!.library.length
    const land = playWith(state, A, 'Mystic Sanctuary', 'Island', 3)
    expect(state.objects[land]!.tapped).toBe(false)
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'the ETB trigger')
    const legal = computeLegal(state, A)
    expect(legal.triggerTargetKind).toBe('graveyardCard')
    expect(legal.triggerTargetOptional).toBe(true)
    expect(legal.triggerGraveyardIds).toContain(dead)
    act(state, A, { type: 'r.chooseTargets', targets: [dead] })
    until(state, (s) => s.zones.perPlayer[A]!.library.length > libBefore, 'the card moving')
    const top = state.zones.perPlayer[A]!.library[0]!
    expect(nameOf(state, top)).toBe('Shock')
    // invariant #3: graveyard (public) → library (hidden) re-mints, and the opponent sees no id
    expect(top).not.toBe(dead)
    expect(state.objects[dead]).toBeUndefined()
    expect(JSON.stringify(redactRulesState(state, B)).includes(top)).toBe(false)
  })

  it('only takes an instant or sorcery (the Cottage only a creature)', () => {
    const { state, A } = makeDuel()
    const creature = putCard(state, A, 'Grizzly Bears', 'graveyard')
    const instant = putCard(state, A, 'Shock', 'graveyard')
    playWith(state, A, 'Mystic Sanctuary', 'Island', 3)
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    const ids = computeLegal(state, A).triggerGraveyardIds
    expect(ids).toContain(instant)
    expect(ids).not.toContain(creature)
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [creature] })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, A, { type: 'r.chooseTargets', targets: [instant] })
  })

  it("Witch's Cottage takes a creature card", () => {
    const { state, A } = makeDuel()
    const creature = putCard(state, A, 'Grizzly Bears', 'graveyard')
    playWith(state, A, "Witch's Cottage", 'Swamp', 3)
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    expect(computeLegal(state, A).triggerGraveyardIds).toContain(creature)
    act(state, A, { type: 'r.chooseTargets', targets: [creature] })
    until(state, (s) => s.zones.perPlayer[A]!.graveyard.length === 0 || s.turnNumber > 1, 'the move')
    expect(nameOf(state, state.zones.perPlayer[A]!.library[0]!)).toBe('Grizzly Bears')
  })

  it('does NOT trigger when it entered tapped', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Shock', 'graveyard')
    playWith(state, A, 'Mystic Sanctuary', 'Island', 2) // only two other Islands → tapped
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'settle')
    expect(state.pending).toBeFalsy()
    expect(state.zones.perPlayer[A]!.graveyard.some((id) => nameOf(state, id) === 'Shock')).toBe(true)
  })
})

describe('CARD53 — the token and counter halves', () => {
  it('Dwarven Mine makes a 1/1 Dwarf when it enters untapped', () => {
    const { state, A } = makeDuel()
    playWith(state, A, 'Dwarven Mine', 'Mountain', 3)
    until(state, (s) => s.zones.perPlayer[A]!.battlefield.some((id) => nameOf(s, id) === 'Dwarf') || s.turnNumber > 1, 'the Dwarf')
    const dwarf = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Dwarf')!
    expect(getDef(state.objects[dwarf]!.defName).power).toBe(1)
  })

  it('Gingerbread Cabin makes a Food token that can be sacrificed for 3 life', () => {
    const { state, A } = makeDuel()
    playWith(state, A, 'Gingerbread Cabin', 'Forest', 3)
    until(state, (s) => s.zones.perPlayer[A]!.battlefield.some((id) => nameOf(s, id) === 'Food') || s.turnNumber > 1, 'the Food')
    const food = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Food')!
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'settle')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.mMana', color: 'C', delta: 2 })
    const ability = computeLegal(state, A).activations.find((x) => x.objId === food)!
    expect(ability.cost).toBe('{2}')
    act(state, A, { type: 'r.activate', objId: food, abilityIndex: 0, targets: [] })
    until(state, (s) => s.players[A]!.life !== life, 'the life gain')
    expect(state.players[A]!.life).toBe(life + 3)
  })

  it('Idyllic Grange puts a +1/+1 counter on a creature you control', () => {
    const { state, A, B } = makeDuel()
    const mine = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    playWith(state, A, 'Idyllic Grange', 'Plains', 3)
    until(state, (s) => s.pending?.kind === 'trigger', 'the ETB trigger')
    expect(() => act(state, A, { type: 'r.chooseTargets', targets: [theirs] })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, A, { type: 'r.chooseTargets', targets: [mine] })
    until(state, (s) => (s.objects[mine]!.counters['+1/+1'] ?? 0) > 0 || s.turnNumber > 1, 'the counter')
    expect(state.objects[mine]!.counters['+1/+1']).toBe(1)
  })
})
