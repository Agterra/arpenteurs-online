/**
 * Perpetual card coverage — batch CARD69, three top-400 cards:
 *  - The Great Henge — a cost reduction that reads the BOARD ("costs {X} less, where X is the greatest
 *    power among creatures you control"), plus an ETB watcher that acts on the creature that entered.
 *  - Mox Diamond — an as-enters replacement with a cost in CARDS (CR 614.12): discard a land or the
 *    permanent is put into its owner's graveyard.
 *  - Scute Swarm — a landfall trigger that creates a token COPY of itself once you control six lands
 *    (so every copy has the trigger too), and a plain 1/1 Insect before that.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { currentPT } from '../../server/rules/characteristics.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const countOn = (s: St, p: PlayerId, pred: (id: ObjId) => boolean) => s.zones.perPlayer[p]!.battlefield.filter(pred).length

describe('CARD69 — The Great Henge', () => {
  it('costs {X} less for the greatest power you control', () => {
    const { state, A } = makeDuel()
    const henge = putCard(state, A, 'The Great Henge', 'hand')
    toStep(state, 'main1')
    // no creatures: the full {8}{G}{G}
    addMana(state, A, 'G', 2)
    addMana(state, A, 'C', 8)
    expect(computeLegal(state, A).castableIds).toContain(henge)
    // with a 4/4 out, four generic less — 6 mana is enough
    const { state: s2, A: a2 } = makeDuel()
    const henge2 = putCard(s2, a2, 'The Great Henge', 'hand')
    putCard(s2, a2, 'Serra Angel', 'battlefield') // 4/4
    toStep(s2, 'main1')
    addMana(s2, a2, 'G', 2)
    addMana(s2, a2, 'C', 4)
    expect(computeLegal(s2, a2).castableIds).toContain(henge2)
    act(s2, a2, { type: 'r.cast', objId: henge2, targets: [] })
    expect(Object.values(s2.players[a2]!.manaPool).reduce((x, y) => x + y, 0)).toBe(0) // exactly paid
  })

  it("only counts YOUR creatures", () => {
    const { state, A, B } = makeDuel()
    const henge = putCard(state, A, 'The Great Henge', 'hand')
    putCard(state, B, 'Serra Angel', 'battlefield') // theirs — no discount
    toStep(state, 'main1')
    addMana(state, A, 'G', 2)
    addMana(state, A, 'C', 4)
    expect(computeLegal(state, A).castableIds).not.toContain(henge)
    expect(() => act(state, A, { type: 'r.cast', objId: henge, targets: [] })).toThrow(/Not enough mana/)
  })

  it('taps for {G}{G} and 2 life', () => {
    const { state, A } = makeDuel()
    const henge = putCard(state, A, 'The Great Henge', 'battlefield')
    toStep(state, 'main1')
    const life = state.players[A]!.life
    act(state, A, { type: 'r.tapMana', objId: henge, color: 'G' })
    expect(state.players[A]!.manaPool.G).toBe(2)
    expect(state.players[A]!.life).toBe(life + 2)
  })

  it('counters and draws for each NONTOKEN creature you control that enters', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'The Great Henge', 'battlefield')
    toStep(state, 'main1')
    const hand = state.zones.perPlayer[A]!.hand.length
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the trigger resolves')
    expect(state.objects[bear]!.counters['+1/+1']).toBe(1)
    expect(currentPT(state, state.objects[bear]!)).toEqual({ power: 3, toughness: 3 })
    // putCard added the Bears to hand (+1), casting it left (−1), the trigger drew a card (+1)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 1)
  })

  it('fires even though the Henge has NO enters trigger of its own (regression)', () => {
    // fireEntersTriggers used to `continue` when a permanent had no `enters` ability, so a card whose
    // only ETB-adjacent ability is the separate `entersWatch` never fired at all. Garruk's Uprising
    // has both, which is why this went unnoticed until the Henge.
    const { state, A } = makeDuel()
    expect(getDef('the great henge').enters).toBeUndefined()
    expect(getDef('the great henge').entersWatch).toBeTruthy()
    putCard(state, A, 'The Great Henge', 'battlefield')
    toStep(state, 'main1')
    const bear = putCard(state, A, 'Grizzly Bears', 'hand')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: bear, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the watcher resolves')
    expect(state.objects[bear]!.counters['+1/+1']).toBe(1)
  })

  it('ignores a TOKEN entering, and an opponent\'s creature', () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'The Great Henge', 'battlefield')
    toStep(state, 'main1')
    // a token: Raise the Alarm makes two 1/1 Soldiers
    const alarm = putCard(state, A, 'Raise the Alarm', 'hand')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 1)
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.cast', objId: alarm, targets: [] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'the tokens arrive')
    const tokens = state.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(state, id) === 'Soldier')
    expect(tokens.length).toBe(2)
    for (const t of tokens) expect(state.objects[t]!.counters['+1/+1']).toBeUndefined()
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand - 1) // no extra draw
    // an opponent's nontoken creature does nothing either
    const theirs = putCard(state, B, 'Grizzly Bears', 'battlefield')
    expect(state.objects[theirs]!.counters['+1/+1']).toBeUndefined()
  })
})

describe("CARD69 — Herald's Horn's peek closes cleanly (regression)", () => {
  // The leak fuzzer caught this while this batch's deck change shifted the seeded stream: the top card
  // shown by "look at the top card of your library" kept its id when the player DECLINED to take it,
  // so an id that had been serialised to that player went back to being hidden from them — exactly what
  // invariant #3 forbids, and what the scry handler already avoids by re-minting the library.
  it('re-mints the top card when the reveal is declined', () => {
    const { state, A } = makeDuel()
    const horn = putCard(state, A, "Herald's Horn", 'battlefield')
    state.objects[horn]!.chosenType = 'Bear'
    // put a matching creature on top so the peek actually opens
    const top = putCard(state, A, 'Grizzly Bears', 'library')
    state.zones.perPlayer[A]!.library = [top, ...state.zones.perPlayer[A]!.library.filter((id) => id !== top)]
    until(state, (s) => s.pending?.kind === 'revealTop' && s.pending.player === A, 'the peek')
    const peeked = state.pendingRevealTop!.cardId
    expect(peeked).toBe(top)
    act(state, A, { type: 'r.revealTop', take: false })
    // the card stays on top, but under a FRESH id — the old one was published to A
    expect(state.objects[peeked]).toBeUndefined()
    expect(state.zones.perPlayer[A]!.library.length).toBeGreaterThan(0)
    expect(nameOf(state, state.zones.perPlayer[A]!.library[0]!)).toBe('Grizzly Bears')
  })

  it('still puts the card into your hand when taken', () => {
    const { state, A } = makeDuel()
    const horn = putCard(state, A, "Herald's Horn", 'battlefield')
    state.objects[horn]!.chosenType = 'Bear'
    const top = putCard(state, A, 'Grizzly Bears', 'library')
    state.zones.perPlayer[A]!.library = [top, ...state.zones.perPlayer[A]!.library.filter((id) => id !== top)]
    until(state, (s) => s.pending?.kind === 'revealTop', 'the peek')
    const hand = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.revealTop', take: true })
    expect(state.zones.perPlayer[A]!.hand.length).toBe(hand + 1)
    expect(state.zones.perPlayer[A]!.hand.some((id) => nameOf(state, id) === 'Grizzly Bears')).toBe(true)
  })
})

describe('CARD69 — Mox Diamond', () => {
  const play = (s: St, A: PlayerId) => {
    const mox = putCard(s, A, 'Mox Diamond', 'hand')
    toStep(s, 'main1')
    act(s, A, { type: 'r.cast', objId: mox, targets: [] })
    until(s, (x) => x.pending?.kind === 'handChoice' || !x.zones.stack.length, 'the discard choice')
    return mox
  }

  it('asks for a land to discard and stays when one is discarded', () => {
    const { state, A } = makeDuel()
    const land = putCard(state, A, 'Mountain', 'hand')
    const mox = play(state, A)
    const legal = computeLegal(state, A)
    expect(legal.needsHandChoice).toBe(true)
    expect(legal.handChoiceOptional).toBe(true)
    expect(legal.handChoiceIds).toContain(land)
    expect(legal.handChoiceLabel).toMatch(/discard a land .*to keep Mox Diamond/)
    act(state, A, { type: 'r.handChoice', objIds: [land] })
    expect(state.objects[land]!.zone).toBe('graveyard')
    expect(state.objects[mox]!.zone).toBe('battlefield')
    act(state, A, { type: 'r.tapMana', objId: mox, color: 'U' })
    expect(state.players[A]!.manaPool.U).toBe(1)
  })

  it('goes to the graveyard when you decline', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Mountain', 'hand')
    const mox = play(state, A)
    act(state, A, { type: 'r.handChoice', objIds: [] })
    expect(state.objects[mox]!.zone).toBe('graveyard')
    expect(state.log.some((l) => /Mox Diamond is put into its owner's graveyard/.test(l))).toBe(true)
  })

  it('refuses a nonland card as the discard', () => {
    const { state, A } = makeDuel()
    const shock = putCard(state, A, 'Shock', 'hand')
    play(state, A)
    expect(() => act(state, A, { type: 'r.handChoice', objIds: [shock] })).toThrow(/does not qualify/)
  })

  it('with no land in hand it still asks, and binning is the only answer', () => {
    const { state, A } = makeDuel()
    // clear the random opening hand of lands so "no land to discard" is deterministic
    for (const id of [...state.zones.perPlayer[A]!.hand])
      if ((getDef(state.objects[id]!.defName).types ?? []).includes('Land'))
        act(state, A, { type: 'r.mMove', objId: id, zone: 'library' })
    const mox = play(state, A)
    expect(computeLegal(state, A).handChoiceIds).toEqual([])
    act(state, A, { type: 'r.handChoice', objIds: [] })
    expect(state.objects[mox]!.zone).toBe('graveyard')
  })

  it('the choice happens on ANY entry path (a hand-run move too)', () => {
    const { state, A } = makeDuel()
    const mox = putCard(state, A, 'Mox Diamond', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.mMove', objId: mox, zone: 'battlefield' })
    expect(state.pending?.kind).toBe('handChoice')
    act(state, A, { type: 'r.handChoice', objIds: [] })
    expect(state.objects[mox]!.zone).toBe('graveyard')
  })
})

describe('CARD69 — Scute Swarm', () => {
  /** Scute Swarm out, plus `lands` lands, then play one more land */
  const rig = (s: St, A: PlayerId, lands: number) => {
    const swarm = putCard(s, A, 'Scute Swarm', 'battlefield')
    for (let i = 0; i < lands; i++) putCard(s, A, 'Forest', 'battlefield')
    const next = putCard(s, A, 'Mountain', 'hand')
    toStep(s, 'main1')
    act(s, A, { type: 'r.playLand', objId: next })
    until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'the landfall trigger resolves')
    return swarm
  }

  it('makes a 1/1 Insect below six lands', () => {
    const { state, A } = makeDuel()
    rig(state, A, 2) // 2 + the one played = 3 lands
    const insects = state.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(state, id) === 'Insect')
    expect(insects.length).toBe(1)
    expect(currentPT(state, state.objects[insects[0]!]!)).toEqual({ power: 1, toughness: 1 })
    expect(countOn(state, A, (id) => nameOf(state, id) === 'Scute Swarm')).toBe(1)
  })

  it('makes a token COPY of itself at six lands — and the copy has the trigger too', () => {
    const { state, A } = makeDuel()
    rig(state, A, 5) // 5 + 1 played = 6 lands
    const swarms = state.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(state, id) === 'Scute Swarm')
    expect(swarms.length).toBe(2) // the original plus its copy
    expect(state.log.some((l) => /creates a token copy of itself \(6 lands\)/.test(l))).toBe(true)
    // …so the NEXT land doubles them again (each Swarm triggers)
    state.players[A]!.extraLandsThisTurn = 1
    const another = putCard(state, A, 'Island', 'hand')
    act(state, A, { type: 'r.playLand', objId: another })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'both triggers resolve')
    expect(countOn(state, A, (id) => nameOf(state, id) === 'Scute Swarm')).toBe(4)
  })

  it('the copy is a token: it ceases to exist when it leaves', () => {
    const { state, A } = makeDuel()
    rig(state, A, 5)
    const copy = state.zones.perPlayer[A]!.battlefield.filter((id) => nameOf(state, id) === 'Scute Swarm')[1]!
    act(state, A, { type: 'r.mMove', objId: copy, zone: 'graveyard' })
    expect(state.objects[copy]).toBeUndefined()
  })

  it("an opponent's land triggers nothing", () => {
    const { state, A, B } = makeDuel()
    putCard(state, A, 'Scute Swarm', 'battlefield')
    for (let i = 0; i < 6; i++) putCard(state, A, 'Forest', 'battlefield')
    until(state, (s) => s.activePlayer === B && s.step === 'main1' && s.priorityPlayer === B, "B's turn")
    const theirLand = putCard(state, B, 'Forest', 'hand')
    act(state, B, { type: 'r.playLand', objId: theirLand })
    until(state, (s) => !s.zones.stack.length, 'nothing happens')
    expect(countOn(state, A, (id) => nameOf(state, id) === 'Scute Swarm')).toBe(1)
  })
})
