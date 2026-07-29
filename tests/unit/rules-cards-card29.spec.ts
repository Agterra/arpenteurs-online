/**
 * Perpetual card coverage — batch CARD29: typed cast triggers (Guttersnipe, Archmage Emeritus,
 * Aetherflux Reservoir), an intervening "if" on an upkeep trigger (Land Tax), mana-value targeting
 * (Despark) and three count-based spells.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, makeGameN, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')

describe('CARD29 — typed cast triggers', () => {
  it('Guttersnipe pings each opponent on your instant or sorcery, not on a creature spell', () => {
    const { state } = makeGameN(3)
    const A = state.activePlayer
    const foes = state.turnOrder.filter((p) => p !== A)
    putCard(state, A, 'Guttersnipe', 'battlefield')
    const shock = putCard(state, A, 'Shock', 'hand')
    const ogre = putCard(state, A, 'Gray Ogre', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'R', 1)
    act(state, A, { type: 'r.cast', objId: shock, targets: [foes[0]!] })
    resolve(state, A)
    // 2 from Guttersnipe to each opponent, plus Shock's 2 to the first
    expect(state.players[foes[0]!]!.life).toBe(36)
    expect(state.players[foes[1]!]!.life).toBe(38)
    // a creature spell does not trigger it
    addMana(state, A, 'R', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: ogre, targets: [] })
    resolve(state, A)
    expect(state.players[foes[1]!]!.life).toBe(38)
  })

  it('Archmage Emeritus draws on your instant or sorcery only', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Archmage Emeritus', 'battlefield')
    const opt = putCard(state, A, 'Opt', 'hand')
    toStep(state, 'main1')
    const before = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'U', 1)
    act(state, A, { type: 'r.cast', objId: opt, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'the scry')
    act(state, A, { type: 'r.scry', toBottom: [] })
    resolve(state, A)
    // Opt left the hand, Opt drew 1, magecraft drew 1
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before - 1 + 2)
  })

  it('Aetherflux Reservoir gains life per spell cast this turn, counting up', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Aetherflux Reservoir', 'battlefield')
    const s1 = putCard(state, A, 'Opt', 'hand')
    const s2 = putCard(state, A, 'Opt', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'U', 2)
    act(state, A, { type: 'r.cast', objId: s1, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'first scry')
    act(state, A, { type: 'r.scry', toBottom: [] })
    resolve(state, A)
    expect(state.players[A]!.life).toBe(41) // first spell this turn → +1
    act(state, A, { type: 'r.cast', objId: s2, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'second scry')
    act(state, A, { type: 'r.scry', toBottom: [] })
    resolve(state, A)
    expect(state.players[A]!.life).toBe(43) // second spell → +2
  })

  it('its ability pays 50 LIFE to deal 50 damage, and is refused below that', () => {
    const { state, A, B } = makeDuel()
    const res = putCard(state, A, 'Aetherflux Reservoir', 'battlefield')
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.activate', objId: res, abilityIndex: 0, targets: [B] })).toThrow(/Not enough life/)
    state.players[A]!.life = 60
    act(state, A, { type: 'r.activate', objId: res, abilityIndex: 0, targets: [B] })
    expect(state.players[A]!.life).toBe(10)
    // the ability resolving kills B outright, which ENDS this duel — so wait on either
    until(state, (s) => s.status === 'ended' || (!s.zones.stack.length && s.priorityPlayer === A), 'the 50 damage')
    expect(state.players[B]!.hasLost).toBe(true) // 50 damage to a 40-life player
    expect(state.winner).toBe(A)
  })
})

describe('CARD29 — Land Tax (an intervening "if")', () => {
  it('does not trigger while you are not behind on lands', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Land Tax', 'battlefield')
    putCard(state, A, 'Mountain', 'battlefield')
    // A controls 1 land, B controls none: at A's next upkeep nothing should happen
    until(state, (s) => s.turnNumber === 3 && s.activePlayer === A && s.step === 'main1', "A's next turn")
    expect(state.pending).toBeFalsy()
    expect(state.log.some((l) => /Land Tax/.test(l))).toBe(false)
  })

  it('triggers when an opponent controls more lands, and searches up to three basics', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Land Tax', 'battlefield')
    for (let i = 0; i < 3; i++) putCard(state, B, 'Mountain', 'battlefield')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    until(state, (s) => s.pending?.kind === 'search' && s.pending.player === A, "A's Land Tax search")
    const picks = state.pendingSearch!.matchIds.slice(0, 3)
    expect(state.pendingSearch!.count).toBe(3)
    act(state, A, { type: 'r.search', cardIds: picks })
    expect(state.zones.perPlayer[A]!.hand.length).toBeGreaterThan(handBefore) // drew its step card too
    expect(state.log.some((l) => /reveals/.test(l))).toBe(true)
  })
})

describe('CARD29 — the singles', () => {
  it("Nature's Claim destroys an artifact and its CONTROLLER gains 4 life", () => {
    const { state, A, B } = makeDuel()
    const claim = putCard(state, A, "Nature's Claim", 'hand')
    const rock = putCard(state, B, 'Sol Ring', 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    act(state, A, { type: 'r.cast', objId: claim, targets: [rock] })
    resolve(state, A)
    expect(state.objects[rock]!.zone).toBe('graveyard')
    expect(state.players[B]!.life).toBe(44) // the OPPONENT gains it
    expect(state.players[A]!.life).toBe(40)
  })

  it('Buried Alive puts up to three creature cards into your graveyard', () => {
    const { state, A } = makeDuel()
    const spell = putCard(state, A, 'Buried Alive', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    addMana(state, A, 'C', 2)
    act(state, A, { type: 'r.cast', objId: spell, targets: [] })
    until(state, (s) => s.pending?.kind === 'search', 'the search')
    const picks = state.pendingSearch!.matchIds.slice(0, 3)
    expect(state.pendingSearch!.count).toBe(3)
    for (const id of picks) expect(getDef(state.objects[id]!.defName).types).toContain('Creature')
    act(state, A, { type: 'r.search', cardIds: picks })
    for (const id of picks) expect(state.objects[id]!.zone).toBe('graveyard')
  })

  it('Shamanic Revelation draws per creature and gains 4 per big one', () => {
    const { state, A } = makeDuel()
    const rev = putCard(state, A, 'Shamanic Revelation', 'hand')
    putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2
    putCard(state, A, 'Hill Giant', 'battlefield') // 3/3
    putCard(state, A, 'Colossal Dreadmaw', 'battlefield') // 6/6 → ferocious
    toStep(state, 'main1')
    const before = state.zones.perPlayer[A]!.hand.length
    addMana(state, A, 'G', 2)
    addMana(state, A, 'C', 3)
    act(state, A, { type: 'r.cast', objId: rev, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before - 1 + 3) // 3 creatures → 3 cards
    expect(state.players[A]!.life).toBe(44) // one creature with power ≥ 4
  })

  it('Despark exiles only a permanent with mana value 4 or greater', () => {
    const { state, A, B } = makeDuel()
    const despark = putCard(state, A, 'Despark', 'hand')
    const cheap = putCard(state, B, 'Grizzly Bears', 'battlefield') // {1}{G} → MV 2
    const big = putCard(state, B, 'Serra Angel', 'battlefield') // {3}{W}{W} → MV 5
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'B', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: despark, targets: [cheap] })).toThrow(/BAD_TARGETS|Illegal target/i)
    act(state, A, { type: 'r.cast', objId: despark, targets: [big] })
    resolve(state, A)
    expect(state.objects[big]!.zone).toBe('exile')
  })
})
