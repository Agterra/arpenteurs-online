/**
 * Coverage batch GY: graveyard recursion (Raise Dead {B}, Regrowth {1}{G}). A card
 * moves graveyard (public) → hand (hidden), so invariant #3 applies: the returned
 * card gets a FRESH id and the old graveyard id is destroyed — otherwise an opponent
 * who saw the card in the graveyard could keep tracking it in the caster's hand.
 * Target legality (Raise Dead is creature-only; only your own graveyard) is checked too.
 */
import { describe, expect, it } from 'vitest'
import { act, commanderObj, makeDuel, putCard, toStep, until } from './rules-helpers.ts'
import type { ManaColor, RulesGameState } from '../../shared/rules/types.ts'
import { defKey } from '../../server/rules/cards/registry.ts'
import { redactRulesState } from '../../server/rules/redact.ts'
import { checkSBA } from '../../server/rules/engine.ts'

type St = RulesGameState
const addMana = (state: St, p: string, c: ManaColor, n: number) => act(state, p, { type: 'r.mMana', color: c, delta: n })
const resolve = (state: St, A: string) => until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'resolves')
const inZone = (state: St, p: string, zone: 'hand' | 'graveyard', name: string) =>
  state.zones.perPlayer[p]![zone].filter((id) => state.objects[id]?.defName === defKey(name))

describe('Raise Dead {B} — return a creature card from your graveyard to hand', () => {
  it('re-mints the returned card (old graveyard id destroyed, fresh id in hand)', () => {
    const { state, A, B } = makeDuel()
    const gyId = putCard(state, A, 'Grizzly Bears', 'graveyard')
    const rd = putCard(state, A, 'Raise Dead', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    // the opening hand may already hold a Grizzly Bears (the deck has copies) — track
    // what was there before so we assert only on the newly-returned instance
    const handBefore = new Set(inZone(state, A, 'hand', 'Grizzly Bears'))
    act(state, A, { type: 'r.cast', objId: rd, targets: [gyId] })
    resolve(state, A)

    // the old graveyard instance is gone (re-mint destroys it)
    expect(state.objects[gyId]).toBeUndefined()
    expect(inZone(state, A, 'graveyard', 'Grizzly Bears')).toHaveLength(0)
    // exactly one fresh Grizzly Bears entered the caster's hand, with a NEW id
    const returned = inZone(state, A, 'hand', 'Grizzly Bears').filter((id) => !handBefore.has(id))
    expect(returned).toHaveLength(1)
    expect(returned[0]).not.toBe(gyId)

    // leak: the opponent's view carries neither the old nor the new (hand-hidden) id
    const bJson = JSON.stringify(redactRulesState(state, B))
    expect(bJson.includes(gyId)).toBe(false)
    expect(bJson.includes(returned[0]!)).toBe(false)
  })

  it('rejects a non-creature card in the graveyard (creature-only target)', () => {
    const { state, A } = makeDuel()
    const land = putCard(state, A, 'Mountain', 'graveyard')
    const rd = putCard(state, A, 'Raise Dead', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: rd, targets: [land] })).toThrow()
  })

  it("rejects a creature card in an OPPONENT's graveyard (your graveyard only)", () => {
    const { state, A, B } = makeDuel()
    const oppCreature = putCard(state, B, 'Grizzly Bears', 'graveyard')
    const rd = putCard(state, A, 'Raise Dead', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'B', 1)
    expect(() => act(state, A, { type: 'r.cast', objId: rd, targets: [oppCreature] })).toThrow()
  })
})

// Adversarial-review finding #1 (fixed): returnFromGraveyard must reroute a commander
// to the command zone — a commander in a hidden hand keeps its stable id (exempt from
// re-mint) which is broadcast as player.commanderId → an opponent could then place that
// id in the caster's hidden hand (invariant #3). Mirrors returnToHand/exileTarget/r.mMove.
describe('graveyard recursion — a commander is never returned to a hidden hand (review #1)', () => {
  it('reroutes a commander from the graveyard to the command zone, not the hand', () => {
    const { state, A } = makeDuel()
    const cmdId = commanderObj(state, A)
    const rg = putCard(state, A, 'Regrowth', 'hand')
    toStep(state, 'main1')
    // reachable via the assisted-table override: r.mMove allows a commander into the
    // (public) graveyard (it only reroutes commanders bound for hand/library)
    act(state, A, { type: 'r.mMove', objId: cmdId, zone: 'graveyard' })
    expect(state.objects[cmdId]!.zone).toBe('graveyard')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'R', 1) // {1} generic
    act(state, A, { type: 'r.cast', objId: rg, targets: [cmdId] })
    resolve(state, A)
    // the commander went to the command zone (public), NOT the hidden hand
    expect(state.objects[cmdId]!.zone).toBe('command')
    expect(state.zones.perPlayer[A]!.hand.includes(cmdId)).toBe(false)
    expect(state.zones.perPlayer[A]!.command.includes(cmdId)).toBe(true)
  })
})

// Adversarial-review finding #2 (fixed): a token that leaves the battlefield must cease
// to exist (CR 704.5d). Before the fix, a dead token lingered in the graveyard forever
// and graveyard recursion could return it to hand, then re-cast it for FREE (a token has
// no mana cost) — unbounded free creatures. The fix is the real SBA, which also stops
// tokens accumulating in the graveyard from any death.
describe('tokens cease to exist when they leave the battlefield (CR 704.5d, review #2)', () => {
  it('removes a dead token from the graveyard so it cannot be recurred', () => {
    const { state, A } = makeDuel()
    const rta = putCard(state, A, 'Raise the Alarm', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'W', 1)
    addMana(state, A, 'R', 1) // {1}{W}
    act(state, A, { type: 'r.cast', objId: rta, targets: [] })
    resolve(state, A)
    const tokenId = state.zones.perPlayer[A]!.battlefield.find((id) => state.objects[id]!.defName.startsWith('itok:'))
    expect(tokenId, 'a Soldier token entered the battlefield').toBeTruthy()
    // the token takes lethal damage and dies → state-based actions
    state.objects[tokenId!]!.damageMarked = 99
    checkSBA(state)
    // CR 704.5d: it ceased to exist — not in the graveyard, not anywhere
    expect(state.objects[tokenId!]).toBeUndefined()
    expect(state.zones.perPlayer[A]!.graveyard.includes(tokenId!)).toBe(false)
  })
})

describe('Regrowth {1}{G} — return ANY card from your graveyard to hand', () => {
  it('returns a non-creature card (a land), re-minted, no leak', () => {
    const { state, A, B } = makeDuel()
    const gyLand = putCard(state, A, 'Mountain', 'graveyard')
    const rg = putCard(state, A, 'Regrowth', 'hand')
    toStep(state, 'main1')
    addMana(state, A, 'G', 1)
    addMana(state, A, 'R', 1) // {1} generic
    act(state, A, { type: 'r.cast', objId: rg, targets: [gyLand] })
    resolve(state, A)

    expect(state.objects[gyLand]).toBeUndefined()
    const returned = inZone(state, A, 'hand', 'Mountain')
    expect(returned.length).toBeGreaterThanOrEqual(1)
    expect(returned.includes(gyLand)).toBe(false)

    const bJson = JSON.stringify(redactRulesState(state, B))
    expect(bJson.includes(gyLand)).toBe(false)
  })
})
