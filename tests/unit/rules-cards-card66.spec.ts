/**
 * Perpetual card coverage — batch CARD66: Three Tree City (mana equal to the number of creatures you
 * control of the type it chose as it entered) and Roaming Throne (a triggered ability of another creature
 * you control of the chosen type triggers an ADDITIONAL time).
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { currentKeywords, currentPT } from '../../server/rules/characteristics.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const restricted = (s: St, p: PlayerId) => s.players[p]!.restrictedMana ?? []
/** put a type-choosing permanent out and answer its choice */
const withType = (s: St, A: PlayerId, card: string, type: string) => {
  const id = putCard(s, A, card, 'hand')
  toStep(s, 'main1')
  act(s, A, { type: card === 'Three Tree City' ? 'r.playLand' : 'r.mMove', objId: id, ...(card === 'Three Tree City' ? {} : { zone: 'battlefield' }) } as never)
  until(s, (x) => x.pending?.kind === 'typeChoice', 'the type choice')
  act(s, A, { type: 'r.chooseType', creatureType: type })
  return id
}

describe('CARD66 — Three Tree City', () => {
  it('taps for {C}, and its second ability scales with your creatures of the chosen type', () => {
    const { state, A } = makeDuel()
    const city = withType(state, A, 'Three Tree City', 'Bear')
    // the plain half
    act(state, A, { type: 'r.tapMana', objId: city, color: 'C' })
    expect(state.players[A]!.manaPool.C).toBe(1)
    state.objects[city]!.tapped = false
    // no Bears yet: {2} in, nothing out (the {C} from the first tap is still floating)
    const before = state.players[A]!.manaPool.C
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.tapMana', objId: city, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(0)
    expect(state.players[A]!.manaPool.C).toBe(before) // the {2} it cost was spent
    // …with three Bears it makes three
    state.objects[city]!.tapped = false
    putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCard(state, A, 'Gray Ogre', 'battlefield') // an Ogre does not count
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.tapMana', objId: city, color: 'G' })
    // that mana is RESTRICTED to creature spells (the printed card says so; the local catalog text is
    // missing the clause), so it lands in its own bucket rather than the open pool
    expect(state.players[A]!.manaPool.G).toBe(0)
    expect(restricted(state, A)).toEqual([{ color: 'G', amount: 3, creatureSpellsOnly: true }])
    // …and it really pays for a creature but not for a burn spell
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    const shock = putCard(state, A, 'Shock', 'hand')
    expect(computeLegal(state, A).castableIds).toContain(bear)
    expect(computeLegal(state, A).castableIds).not.toContain(shock)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    // the {G} pip came out of the bucket (3 → 2); the generic {1} was covered by the floating {C}
    expect(restricted(state, A)[0]!.amount).toBe(2)
  })

  it('counts an OPPONENT\'s creatures not at all, and a changeling always', () => {
    const { state, A, B } = makeDuel()
    const city = withType(state, A, 'Three Tree City', 'Elf')
    putCard(state, B, 'Grizzly Bears', 'battlefield') // theirs: never counted
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.tapMana', objId: city, color: 'U' })
    expect(restricted(state, A)).toEqual([]) // no Elves: no mana at all
    // a changeling is every creature type (CR 702.73), so it counts as an Elf
    state.objects[city]!.tapped = false
    const shifter = putCard(state, A, 'Black Market Connections', 'battlefield')
    expect(nameOf(state, shifter)).toBe('Black Market Connections') // (fixture sanity)
    until(state, (s) => s.pending?.kind === 'modes' || s.turnNumber > 2, 'its first-main trigger')
    if (state.pending?.kind === 'modes') act(state, A, { type: 'r.chooseModes', modes: [2] })
    const token = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Shapeshifter')
    if (token) {
      state.objects[city]!.tapped = false
      addMana(state, A, 'C', 2)
      act(state, A, { type: 'r.tapMana', objId: city, color: 'U' })
      expect(restricted(state, A).some((b) => b.color === 'U' && b.amount === 1)).toBe(true)
    }
  })

  it('offers the colour choice only once its {2} is payable', () => {
    const { state, A } = makeDuel()
    const city = withType(state, A, 'Three Tree City', 'Bear')
    // with an empty pool only the fixed {C} half is usable, so redact offers no colour PICKER at all
    // (a single fixed-output ability needs none) — and the {2} ability is refused
    expect(computeLegal(state, A).manaSourceIds).toContain(city)
    expect(computeLegal(state, A).manaSourceColors[city]).toEqual([])
    expect(() => act(state, A, { type: 'r.tapMana', objId: city, color: 'G' })).toThrow(/Not enough mana/)
    // float the {2}: now both halves are live, so the picker lists every colour
    addMana(state, A, 'C', 2)
    expect(computeLegal(state, A).manaSourceColors[city]).toEqual(expect.arrayContaining(['C', 'W', 'U', 'B', 'R', 'G']))
  })
})
describe('CARD66 — Roaming Throne', () => {
  /** the Throne, set to a type, plus a creature of that type with a dies trigger */
  const rig = (s: St, A: PlayerId, type: string) => {
    const throne = putCard(s, A, 'Roaming Throne', 'hand')
    toStep(s, 'main1')
    act(s, A, { type: 'r.mMove', objId: throne, zone: 'battlefield' })
    until(s, (x) => x.pending?.kind === 'typeChoice', 'the type choice')
    act(s, A, { type: 'r.chooseType', creatureType: type })
    return throne
  }

  it('doubles a NON-targeted dies trigger (two Spirits instead of one)', () => {
    const { state, A } = makeDuel()
    rig(state, A, 'Human') // Doomed Traveler is a Human Soldier whose death makes a 1/1 Spirit
    const traveler = putCard(state, A, 'Doomed Traveler', 'battlefield')
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [traveler] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'both tokens')
    const spirits = state.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(state, id) === 'Spirit').length
    expect(spirits).toBe(2) // the dies trigger happened twice
    expect(state.log.some((l) => /triggers an additional time/.test(l))).toBe(true)
  })

  it('doubles a TARGETED dies trigger, asking for the second set of targets', () => {
    const { state, A, B } = makeDuel()
    rig(state, A, 'Vampire') // Blood Artist is a Vampire
    const artist = putCard(state, A, 'Blood Artist', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    // kill the Bear: Blood Artist's drain triggers, doubled by the Throne
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [bear] })
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'the first drain')
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    // the extra instance now asks for ITS targets
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === A, 'the doubled drain')
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    until(state, (s) => s.players[B]!.life <= 38, 'both drains')
    expect(state.players[B]!.life).toBe(38) // 1 + 1
    expect(state.log.some((l) => /triggers an additional time/.test(l))).toBe(true)
    expect(state.objects[artist]!.zone).toBe('battlefield')
  })

  it('does not double a creature of ANOTHER type, nor its own triggers', () => {
    const { state, A, B } = makeDuel()
    rig(state, A, 'Elf') // Blood Artist is a Vampire, not an Elf
    putCard(state, A, 'Blood Artist', 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [bear] })
    until(state, (s) => s.pending?.kind === 'trigger', 'the drain')
    act(state, A, { type: 'r.chooseTargets', targets: [B] })
    until(state, (s) => s.players[B]!.life !== 40, 'the drain resolves')
    expect(state.players[B]!.life).toBe(39) // once only
    expect(state.pending?.kind).not.toBe('trigger')
  })

  it("does not double an OPPONENT's creature's triggers", () => {
    const { state, A, B } = makeDuel()
    rig(state, A, 'Vampire')
    putCard(state, B, 'Blood Artist', 'battlefield') // theirs
    const bear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const bolt = putCard(state, A, 'Lightning Bolt', 'hand')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: bolt, targets: [bear] })
    until(state, (s) => s.pending?.kind === 'trigger' && s.pending.player === B, "their drain")
    act(state, B, { type: 'r.chooseTargets', targets: [A] })
    until(state, (s) => s.players[A]!.life !== 40, 'the drain resolves')
    expect(state.players[A]!.life).toBe(39)
    expect(state.pending?.kind).not.toBe('trigger')
  })

  it('being the chosen type makes a LORD see it (regression: printed subtypes only)', () => {
    const { state, A } = makeDuel()
    const throne = rig(state, A, 'Goblin')
    // Goblin Chieftain pumps "other Goblins you control" — the Throne IS a Goblin, though not on paper
    putCard(state, A, 'Goblin Chieftain', 'battlefield')
    expect(currentPT(state, state.objects[throne]!)).toEqual({ power: 5, toughness: 5 }) // 4/4 +1/+1
    expect(currentKeywords(state, state.objects[throne]!)).toContain('haste')
    // …and set to another type it is untouched
    state.objects[throne]!.chosenType = 'Elf'
    expect(currentPT(state, state.objects[throne]!)).toEqual({ power: 4, toughness: 4 })
  })

  it('is itself the chosen type, and has ward {2}', () => {
    const { state, A } = makeDuel()
    const throne = rig(state, A, 'Elf')
    expect(state.objects[throne]!.chosenType).toBe('Elf')
    expect(getDef(state.objects[throne]!.defName).ward).toBe('{2}')
    // its own type counts for Three Tree City's mana ability, which asks the same question
    const city = putCard(state, A, 'Three Tree City', 'battlefield')
    state.objects[city]!.chosenType = 'Elf'
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.tapMana', objId: city, color: 'G' })
    expect(restricted(state, A)).toEqual([{ color: 'G', amount: 1, creatureSpellsOnly: true }]) // the Throne is an Elf
  })
})
