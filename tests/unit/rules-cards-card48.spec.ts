/**
 * Perpetual card coverage — batch CARD48: permanents with SEVERAL activated abilities, now that the
 * client's menu lists them all. Idol of Oblivion ("{T}: Draw a card. Activate only if you created a
 * token this turn." plus an {8}-and-sacrifice token maker) and Sensei's Divining Top, whose second
 * ability puts ITSELF on top of its owner's library — a public → hidden move, so the id is re-minted.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import { computeLegal, redactRulesState } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import type { ManaColor, ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState
const addMana = (s: St, p: string, c: ManaColor, n: number) => act(s, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (s: St, A: PlayerId) => until(s, (x) => !x.zones.stack.length && x.priorityPlayer === A, 'resolve')
const nameOf = (s: St, id: ObjId) => getDef(s.objects[id]!.defName).name
const abilitiesOf = (s: St, p: PlayerId, id: ObjId) => computeLegal(s, p).activations.filter((a) => a.objId === id)

describe('CARD48 — Idol of Oblivion', () => {
  it('offers its draw ability only after you created a token this turn', () => {
    const { state, A } = makeDuel()
    const idol = putCard(state, A, 'Idol of Oblivion', 'battlefield')
    toStep(state, 'main1')
    // no token yet: only the {8} ability is offered, and the draw is refused
    expect(abilitiesOf(state, A, idol).map((a) => a.abilityIndex)).toEqual([1])
    expect(() => act(state, A, { type: 'r.activate', objId: idol, abilityIndex: 0, targets: [] })).toThrow(/not created a token/)
    // make a token (any token counts — Raise the Alarm makes two Soldiers)
    const alarm = putCard(state, A, 'Raise the Alarm', 'hand')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: alarm, targets: [] })
    resolve(state, A)
    expect(state.players[A]!.createdTokenThisTurn).toBe(true)
    const offered = abilitiesOf(state, A, idol)
    expect(offered.map((a) => a.abilityIndex).sort()).toEqual([0, 1])
    const handBefore = state.zones.perPlayer[A]!.hand.length
    act(state, A, { type: 'r.activate', objId: idol, abilityIndex: 0, targets: [] })
    resolve(state, A)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1)
    expect(state.objects[idol]!.tapped).toBe(true)
  })

  it('forgets the token at your next untap step', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Idol of Oblivion', 'battlefield')
    toStep(state, 'main1')
    const spell = putCard(state, A, 'Raise the Alarm', 'hand')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.cast', objId: spell, targets: [] })
    resolve(state, A)
    expect(state.players[A]!.createdTokenThisTurn).toBe(true)
    until(state, (s) => s.activePlayer === A && s.turnNumber > 1 && s.step === 'main1', "A's next turn")
    expect(state.players[A]!.createdTokenThisTurn).toBe(false)
  })

  it('its second ability sacrifices it for a 10/10', () => {
    const { state, A } = makeDuel()
    const idol = putCard(state, A, 'Idol of Oblivion', 'battlefield')
    toStep(state, 'main1')
    const second = abilitiesOf(state, A, idol).find((a) => a.abilityIndex === 1)!
    expect(second.cost).toBe('{8}')
    expect(second.taps).toBe(true)
    expect(second.sacSelf).toBe(true)
    addMana(state, A, 'C', 8)
    act(state, A, { type: 'r.activate', objId: idol, abilityIndex: 1, targets: [] })
    resolve(state, A)
    expect(state.objects[idol]!.zone).toBe('graveyard')
    const token = state.zones.perPlayer[A]!.battlefield
      .map((id) => state.objects[id]!)
      .find((o) => getDef(o.defName).power === 10)
    expect(token).toBeTruthy()
    expect(getDef(token!.defName).toughness).toBe(10)
  })
})

describe("CARD48 — Sensei's Divining Top", () => {
  it('its {1} ability looks at the top three and reorders them', () => {
    const { state, A } = makeDuel()
    const top = putCard(state, A, "Sensei's Divining Top", 'battlefield')
    toStep(state, 'main1')
    addMana(state, A, 'C', 1)
    act(state, A, { type: 'r.activate', objId: top, abilityIndex: 0, targets: [] })
    until(state, (s) => s.pending?.kind === 'scry', 'the look')
    expect(state.pendingScry!.reorder).toBe(true)
    expect(state.pendingScry!.cardIds.length).toBe(3)
    const [a, b, c] = state.pendingScry!.cardIds as [ObjId, ObjId, ObjId]
    const names = [nameOf(state, a), nameOf(state, b), nameOf(state, c)]
    act(state, A, { type: 'r.scry', toBottom: [], order: [c, b, a] })
    // the library keeps three cards on top, in the chosen order (re-minted, so compare by name)
    const lib = state.zones.perPlayer[A]!.library
    expect([nameOf(state, lib[0]!), nameOf(state, lib[1]!), nameOf(state, lib[2]!)]).toEqual([names[2], names[1], names[0]])
    expect(state.objects[top]!.zone).toBe('battlefield') // this ability does not move it
  })

  it('its {T} ability draws and puts ITSELF on top of the library, re-minted', () => {
    const { state, A, B } = makeDuel()
    const top = putCard(state, A, "Sensei's Divining Top", 'battlefield')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    const libBefore = state.zones.perPlayer[A]!.library.length
    act(state, A, { type: 'r.activate', objId: top, abilityIndex: 1, targets: [] })
    resolve(state, A)
    // +1 drawn, and the Top itself is now the top card of the library
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1)
    expect(state.zones.perPlayer[A]!.library.length).toBe(libBefore) // −1 drawn, +1 the Top
    const newTop = state.zones.perPlayer[A]!.library[0]!
    expect(nameOf(state, newTop)).toBe("Sensei's Divining Top")
    // invariant #3: the battlefield id is gone, so an opponent can't follow it into the library
    expect(newTop).not.toBe(top)
    expect(state.objects[top]).toBeUndefined()
    expect(JSON.stringify(redactRulesState(state, B)).includes(newTop)).toBe(false)
  })

  it('offers BOTH abilities at once, with distinct costs', () => {
    const { state, A } = makeDuel()
    const top = putCard(state, A, "Sensei's Divining Top", 'battlefield')
    toStep(state, 'main1')
    const offered = abilitiesOf(state, A, top)
    expect(offered.length).toBe(2)
    expect(offered.find((a) => a.abilityIndex === 0)!.cost).toBe('{1}')
    expect(offered.find((a) => a.abilityIndex === 0)!.taps).toBeUndefined()
    expect(offered.find((a) => a.abilityIndex === 1)!.cost).toBe('')
    expect(offered.find((a) => a.abilityIndex === 1)!.taps).toBe(true)
  })

  it('a tapped Top offers only the ability that does not need {T}', () => {
    const { state, A } = makeDuel()
    const top = putCard(state, A, "Sensei's Divining Top", 'battlefield')
    state.objects[top]!.tapped = true
    toStep(state, 'main1')
    expect(abilitiesOf(state, A, top).map((a) => a.abilityIndex)).toEqual([0])
  })
})
