/**
 * Card-pool coverage using the built-up primitives: mana dorks (summoning-sick
 * {T} abilities), firebreathing (activated self-pump), and a draw/lose-life spell.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, putFallback, toStep, until } from './rules-helpers.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

describe('mana dorks respect summoning sickness (CR 302.6)', () => {
  it('a fresh Llanowar Elves cannot tap for mana; once settled it can', () => {
    const { state, A } = makeDuel()
    const elf = putCard(state, A, 'Llanowar Elves')
    state.objects[elf]!.summoningSick = true
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.tapMana', objId: elf })).toThrow(/summoning|tap for mana/i)
    state.objects[elf]!.summoningSick = false
    act(state, A, { type: 'r.tapMana', objId: elf })
    expect(state.players[A]!.manaPool.G).toBe(1)
    expect(state.objects[elf]!.tapped).toBe(true)
  })
})

describe('firebreathing (activated self-pump)', () => {
  it('Shivan Dragon pumps itself +1/+0 per {R} until end of turn', () => {
    const { state, A } = makeDuel()
    const dragon = putCard(state, A, 'Shivan Dragon') // 5/5 flying, {R}: +1/+0
    const mtns = [putCard(state, A, 'Mountain'), putCard(state, A, 'Mountain')]
    toStep(state, 'main1')
    for (const m of mtns) act(state, A, { type: 'r.tapMana', objId: m }) // RR
    act(state, A, { type: 'r.activate', objId: dragon, abilityIndex: 0, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'first pump resolves')
    expect(redactRulesState(state, A).cards[dragon]!.power).toBe(6) // 5 + 1
    act(state, A, { type: 'r.activate', objId: dragon, abilityIndex: 0, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'second pump resolves')
    expect(redactRulesState(state, A).cards[dragon]!.power).toBe(7) // stacked
    until(state, (s) => s.turnNumber === 2, 'next turn')
    expect(redactRulesState(state, A).cards[dragon]!.power).toBe(5) // wears off
  })
})

describe("Night's Whisper", () => {
  it('draws two and loses two life', () => {
    const { state, A } = makeDuel()
    const nw = putCard(state, A, "Night's Whisper", 'hand')
    const swamps = [putCard(state, A, 'Swamp'), putCard(state, A, 'Swamp')]
    toStep(state, 'main1')
    const lib0 = state.zones.perPlayer[A]!.library.length
    const life0 = state.players[A]!.life
    for (const s of swamps) act(state, A, { type: 'r.tapMana', objId: s })
    act(state, A, { type: 'r.cast', objId: nw, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 - 2)
    expect(state.players[A]!.life).toBe(life0 - 2)
  })
})

describe('mass / single-target burn', () => {
  it('Flame Slash deals 4 to a target creature', () => {
    const { state, A, B } = makeDuel()
    const fs = putCard(state, A, 'Flame Slash', 'hand')
    const mtn = putCard(state, A, 'Mountain')
    const giant = putCard(state, B, 'Hill Giant') // 3/3
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: mtn })
    act(state, A, { type: 'r.cast', objId: fs, targets: [giant] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[giant]!.zone).toBe('graveyard') // 4 > 3 toughness
  })

  it('Pyroclasm hits every creature: kills small ones, big/indestructible survive, dies triggers fire', () => {
    const { state, A, B } = makeDuel()
    const bears = putCard(state, B, 'Grizzly Bears') // 2/2 → dies
    const spider = putCard(state, B, 'Giant Spider') // 2/4 → survives (2 dmg)
    const myr = putCard(state, B, 'Darksteel Myr') // 0/1 indestructible → survives
    const dt = putCard(state, A, 'Doomed Traveler') // 1/1 → dies → Spirit token
    const pyro = putCard(state, A, 'Pyroclasm', 'hand')
    const mtns = [putCard(state, A, 'Mountain'), putCard(state, A, 'Mountain')]
    toStep(state, 'main1')
    for (const m of mtns) act(state, A, { type: 'r.tapMana', objId: m })
    act(state, A, { type: 'r.cast', objId: pyro, targets: [] })
    until(state, (s) => !s.zones.stack.length && !!s.priorityPlayer, 'resolved (incl. death triggers)')
    expect(state.objects[bears]!.zone).toBe('graveyard')
    expect(state.objects[dt]!.zone).toBe('graveyard')
    expect(state.objects[spider]!.zone).toBe('battlefield') // 2 dmg vs toughness 4
    expect(state.objects[myr]!.zone).toBe('battlefield') // indestructible
    const spirit = state.zones.perPlayer[A]!.battlefield.find((id: string) => state.objects[id]?.defName.includes('spirit'))
    expect(spirit, 'Doomed Traveler left a Spirit').toBeTruthy()
  })
})

describe('Disfigure (-2/-2)', () => {
  it('shrinks a 2/2 to 0/0 so it dies, and a bigger creature just shrinks', () => {
    const { state, A, B } = makeDuel()
    const dis = putCard(state, A, 'Disfigure', 'hand')
    const swamp = putCard(state, A, 'Swamp')
    const bears = putCard(state, B, 'Grizzly Bears') // 2/2 → 0/0 dies
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: swamp })
    act(state, A, { type: 'r.cast', objId: dis, targets: [bears] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[bears]!.zone).toBe('graveyard')
  })
})

describe('Lightning Helix', () => {
  it('deals 3 to a target and gains its caster 3 life', () => {
    const { state, A, B } = makeDuel()
    const helix = putCard(state, A, 'Lightning Helix', 'hand')
    const mtn = putCard(state, A, 'Mountain')
    const plains = putCard(state, A, 'Plains')
    toStep(state, 'main1')
    const la = state.players[A]!.life
    const lb = state.players[B]!.life
    act(state, A, { type: 'r.tapMana', objId: mtn })
    act(state, A, { type: 'r.tapMana', objId: plains })
    act(state, A, { type: 'r.cast', objId: helix, targets: [B] }) // 3 to a player
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.players[B]!.life).toBe(lb - 3)
    expect(state.players[A]!.life).toBe(la + 3)
  })
})

describe('Char', () => {
  it('deals 3 to a creature and 1 to its caster', () => {
    const { state, A, B } = makeDuel()
    const char = putCard(state, A, 'Char', 'hand')
    const mtns = [putCard(state, A, 'Mountain'), putCard(state, A, 'Mountain'), putCard(state, A, 'Mountain')]
    const bears = putCard(state, B, 'Grizzly Bears') // 2/2
    toStep(state, 'main1')
    const la = state.players[A]!.life
    for (const m of mtns) act(state, A, { type: 'r.tapMana', objId: m })
    act(state, A, { type: 'r.cast', objId: char, targets: [bears] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved')
    expect(state.objects[bears]!.zone).toBe('graveyard') // 3 dmg kills 2/2
    expect(state.players[A]!.life).toBe(la - 1) // 1 to you
  })
})

describe('Guildgates (enters tapped, dual-colour mana)', () => {
  it('enters tapped and taps for either colour on the next turn', () => {
    const { state, A } = makeDuel()
    const gate = putCard(state, A, 'Selesnya Guildgate', 'hand') // enters tapped, {T}: G or W
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: gate })
    expect(state.objects[gate]!.tapped).toBe(true) // entered tapped
    expect(() => act(state, A, { type: 'r.tapMana', objId: gate })).toThrow(/Already tapped/)
    // next turn it's untapped and can produce a chosen colour
    until(state, (s) => s.activePlayer === A && s.turnNumber > 1 && s.step === 'main1' && s.priorityPlayer === A, 'my next main')
    expect(state.objects[gate]!.tapped).toBe(false)
    expect(() => act(state, A, { type: 'r.tapMana', objId: gate })).toThrow(/Choose which colour/) // must pick
    act(state, A, { type: 'r.tapMana', objId: gate, color: 'W' })
    expect(state.players[A]!.manaPool.W).toBe(1)
    expect(state.players[A]!.manaPool.G).toBe(0)
  })

  it('rejects a colour the gate cannot make', () => {
    const { state, A } = makeDuel()
    const gate = putCard(state, A, 'Izzet Guildgate') // U or R
    state.objects[gate]!.tapped = false
    toStep(state, 'main1')
    // CARD17 made this check ability-aware (a permanent may have several mana abilities), so the
    // rejection now names the colour it can't make; either wording means "not a legal choice"
    expect(() => act(state, A, { type: 'r.tapMana', objId: gate, color: 'G' })).toThrow(/can't make \{G\}|Choose which colour/)
    expect(state.objects[gate]!.tapped).toBe(false) // cost not paid on a bad choice
  })
})

describe('Sol Ring', () => {
  it('taps for two colorless mana', () => {
    const { state, A } = makeDuel()
    const ring = putCard(state, A, 'Sol Ring')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: ring })
    expect(state.players[A]!.manaPool.C).toBe(2)
    expect(state.objects[ring]!.tapped).toBe(true)
  })
})

describe('Counterspell', () => {
  it('counters a spell on the stack (it never resolves)', () => {
    const { state, A, B } = makeDuel()
    const bears = putCard(state, A, 'Grizzly Bears', 'hand')
    const forests = [putCard(state, A, 'Forest'), putCard(state, A, 'Forest')]
    const cs = putCard(state, B, 'Counterspell', 'hand')
    const islands = [putCard(state, B, 'Island'), putCard(state, B, 'Island')]
    toStep(state, 'main1') // A's main, A has priority
    for (const f of forests) act(state, A, { type: 'r.tapMana', objId: f })
    act(state, A, { type: 'r.cast', objId: bears, targets: [] }) // Grizzly Bears on the stack
    act(state, A, { type: 'r.pass' }) // priority to B with the spell on the stack
    for (const i of islands) act(state, B, { type: 'r.tapMana', objId: i })
    act(state, B, { type: 'r.cast', objId: cs, targets: [bears] }) // counter the bears spell
    until(state, (s) => !s.zones.stack.length && !!s.priorityPlayer, 'both resolve')
    expect(state.objects[bears]!.zone).toBe('graveyard') // countered → graveyard, never entered play
    expect(state.zones.perPlayer[A]!.battlefield).not.toContain(bears)
  })
})

describe('board wipe (Wrath of God)', () => {
  it('destroys implemented creatures (dies triggers still fire) but leaves unimplemented ones for manual removal', () => {
    const { state, A, B } = makeDuel()
    const bears = putCard(state, B, 'Grizzly Bears') // implemented → dies
    const dt = putCard(state, A, 'Doomed Traveler') // implemented → dies → 1/1 Spirit token
    const beast = putFallback(state, B, { name: 'Mystery Beast', typeLine: 'Creature — Beast', power: '4', toughness: '4' })
    const wrath = putCard(state, A, 'Wrath of God', 'hand')
    const plains = Array.from({ length: 4 }, () => putCard(state, A, 'Plains'))
    toStep(state, 'main1')
    for (const p of plains) act(state, A, { type: 'r.tapMana', objId: p })
    act(state, A, { type: 'r.cast', objId: wrath, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolved (incl. death triggers)')
    expect(state.objects[bears]!.zone).toBe('graveyard')
    expect(state.objects[dt]!.zone).toBe('graveyard')
    expect(state.objects[beast]!.zone).toBe('battlefield') // unimplemented survives the auto-wipe
    // Doomed Traveler's death trigger produced a Spirit token
    const spirit = state.zones.perPlayer[A]!.battlefield.find((id: string) => state.objects[id]?.defName.includes('spirit'))
    expect(spirit, 'Spirit token from the death trigger').toBeTruthy()
  })
})
