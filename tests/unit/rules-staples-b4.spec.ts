/**
 * Coverage batch B4: sacrifice & edicts.
 *  - Edicts (Diabolic Edict, Fleshbag Marauder): a spell/ability makes players
 *    sacrifice a creature of THEIR OWN choice (pending 'sacrifice' + r.sacrifice);
 *    "each player" runs a queue in APNAP order.
 *  - Sac outlets (Viscera Seer, Bloodthrone Vampire): an activated ability whose
 *    cost is "Sacrifice a creature", paid at activation time (r.activate.sacrifices);
 *    the sacrificed creature's dies triggers resolve above the ability.
 * All these zone moves are battlefield → graveyard (public → public), so no
 * hidden-information re-mint is involved — a focused leak check confirms it.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, makeGameN, putCard, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = ReturnType<typeof makeDuel>['state']
function tapAllMana(state: St, p: string) {
  for (const id of [...state.zones.perPlayer[p]!.battlefield]) {
    const hasMana = getDef(state.objects[id]!.defName).abilities?.some((a) => a.kind === 'activated' && a.isMana)
    if (hasMana && !state.objects[id]!.tapped) act(state, p, { type: 'r.tapMana', objId: id })
  }
}
const nameOf = (state: St, id: string) => getDef(state.objects[id]!.defName).name

describe('Diabolic Edict — target player sacrifices a creature (their choice)', () => {
  it('opens a sacrifice prompt on the target, who picks which creature to lose', () => {
    const { state, A, B } = makeDuel()
    const edict = putCard(state, A, 'Diabolic Edict', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const bBear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const bOgre = putCard(state, B, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    tapAllMana(state, A)
    act(state, A, { type: 'r.cast', objId: edict, targets: [B] })
    until(state, (s) => s.pending?.kind === 'sacrifice', 'edict opens')

    // the TARGET (B) chooses, from B's own creatures, exactly one
    expect(state.pending!.player).toBe(B)
    expect(state.pendingSacrifice!.count).toBe(1)
    expect([...state.pendingSacrifice!.candidateIds].sort()).toEqual([bBear, bOgre].sort())
    // B's client sees the forced sacrifice; A's client does not
    const bLegal = redactRulesState(state, B).legal
    expect(bLegal.needsSacrifice).toBe(true)
    expect(bLegal.sacrificeableIds.sort()).toEqual([bBear, bOgre].sort())
    expect(redactRulesState(state, A).legal.needsSacrifice).toBe(false)

    act(state, B, { type: 'r.sacrifice', objIds: [bOgre] })
    expect(state.objects[bOgre]!.zone).toBe('graveyard')
    expect(state.objects[bBear]!.zone).toBe('battlefield') // B kept the one it chose to keep
    expect(state.pending).toBeNull()
    expect(state.objects[edict]!.zone).toBe('graveyard') // the instant resolved

    // leak check: A's view carries no library id of B and B's hand stays count-only
    const aJson = JSON.stringify(redactRulesState(state, A))
    for (const id of state.zones.perPlayer[B]!.library) expect(aJson.includes(id)).toBe(false)
    expect(Array.isArray(redactRulesState(state, A).zones.perPlayer[B]!.hand)).toBe(false)
  })

  it('is a no-op when the target controls no creatures (spell still resolves)', () => {
    const { state, A, B } = makeDuel()
    const edict = putCard(state, A, 'Diabolic Edict', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    toStep(state, 'main1')
    tapAllMana(state, A)
    act(state, A, { type: 'r.cast', objId: edict, targets: [B] })
    until(state, (s) => s.priorityPlayer === A && !s.zones.stack.length, 'edict resolves with nothing to sacrifice')
    expect(state.pending).toBeNull()
    expect(state.objects[edict]!.zone).toBe('graveyard')
  })

  it('rejects an illegal sacrifice (wrong count / not your creature)', () => {
    const { state, A, B } = makeDuel()
    const edict = putCard(state, A, 'Diabolic Edict', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const aBear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCard(state, B, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    tapAllMana(state, A)
    act(state, A, { type: 'r.cast', objId: edict, targets: [B] })
    until(state, (s) => s.pending?.kind === 'sacrifice', 'edict opens')
    // B may not sacrifice A's creature, nor sacrifice zero
    expect(() => act(state, B, { type: 'r.sacrifice', objIds: [aBear] })).toThrow()
    expect(() => act(state, B, { type: 'r.sacrifice', objIds: [] })).toThrow()
  })
})

describe('Fleshbag Marauder — each player sacrifices a creature (APNAP queue)', () => {
  it('prompts the active player first, then the opponent, each sacrificing one', () => {
    const { state, A, B } = makeDuel()
    const fleshbag = putCard(state, A, 'Fleshbag Marauder', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const aBear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const bOgre = putCard(state, B, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    tapAllMana(state, A)
    act(state, A, { type: 'r.cast', objId: fleshbag, targets: [] })
    until(state, (s) => s.pending?.kind === 'sacrifice', 'ETB each-player sacrifice opens')

    // active player A goes first (APNAP); A may sacrifice Grizzly or Fleshbag itself
    expect(state.pending!.player).toBe(A)
    expect([...state.pendingSacrifice!.candidateIds].sort()).toEqual([aBear, fleshbag].sort())
    act(state, A, { type: 'r.sacrifice', objIds: [aBear] })

    // then B is prompted for its own creature
    expect(state.pending!.player).toBe(B)
    expect(state.pendingSacrifice!.candidateIds).toEqual([bOgre])
    act(state, B, { type: 'r.sacrifice', objIds: [bOgre] })

    expect(state.pending).toBeNull()
    expect(state.objects[aBear]!.zone).toBe('graveyard')
    expect(state.objects[bOgre]!.zone).toBe('graveyard')
    expect(state.objects[fleshbag]!.zone).toBe('battlefield') // A chose to keep Fleshbag
  })

  it('skips players who control no creature (only the controller sacrifices)', () => {
    const { state, A, B } = makeDuel()
    const fleshbag = putCard(state, A, 'Fleshbag Marauder', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    // A controls only Fleshbag once it enters; B controls nothing
    toStep(state, 'main1')
    tapAllMana(state, A)
    act(state, A, { type: 'r.cast', objId: fleshbag, targets: [] })
    until(state, (s) => s.pending?.kind === 'sacrifice', 'A must sacrifice Fleshbag (its only creature)')
    expect(state.pending!.player).toBe(A)
    expect(state.pendingSacrifice!.candidateIds).toEqual([fleshbag])
    act(state, A, { type: 'r.sacrifice', objIds: [fleshbag] })
    expect(state.pending).toBeNull()
    expect(state.objects[fleshbag]!.zone).toBe('graveyard')
  })
})

describe('Viscera Seer — sacrifice a creature: Scry 1 (sac cost + dies trigger)', () => {
  it('sacrifices the chosen creature, its dies trigger resolves, then the scry opens', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Viscera Seer', 'battlefield')
    const seer = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Viscera Seer')!
    const solemn = putCard(state, A, 'Solemn Simulacrum', 'battlefield')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length

    // "Sacrifice a creature: Scry 1." — pay the cost with Solemn Simulacrum
    act(state, A, { type: 'r.activate', objId: seer, abilityIndex: 0, targets: [], sacrifices: [solemn] })
    expect(state.objects[solemn]!.zone).toBe('graveyard') // cost paid immediately
    // stack now holds the Scry ability + Solemn's "when this dies, draw" (on top)
    until(state, (s) => s.pending?.kind === 'scry', 'scry opens after the dies trigger resolves')

    // Solemn's dies trigger drew a card BEFORE the scry ability resolved
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore + 1)
    expect(state.pendingScry!.player).toBe(A)
    act(state, A, { type: 'r.scry', toBottom: [] })
    expect(state.pending).toBeNull()
  })
})

// --- regression tests for the two adversarial-review findings (red→green) ---

describe('edict queue survives a queued player conceding (repairControlFlow)', () => {
  it('still prompts the remaining queued player after one concedes mid-queue', () => {
    const { state } = makeGameN(3)
    const [A, B, C] = state.turnOrder as [string, string, string]
    const fleshbag = putCard(state, A, 'Fleshbag Marauder', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const aGrizzly = putCard(state, A, 'Grizzly Bears', 'battlefield')
    putCard(state, B, 'Gray Ogre', 'battlefield')
    const cGiant = putCard(state, C, 'Hill Giant', 'battlefield')
    toStep(state, 'main1')
    tapAllMana(state, A)
    act(state, A, { type: 'r.cast', objId: fleshbag, targets: [] })
    until(state, (s) => s.pending?.kind === 'sacrifice', 'each-player sacrifice queue opens')

    expect(state.pending!.player).toBe(A) // APNAP: active player first
    act(state, A, { type: 'r.sacrifice', objIds: [aGrizzly] })
    expect(state.pending!.player).toBe(B) // then B

    // B concedes while still owing its sacrifice — the queue must NOT be abandoned
    act(state, B, { type: 'r.concede' })
    expect(state.players[B]!.hasLost).toBe(true)
    expect(state.pending?.kind).toBe('sacrifice')
    expect(state.pending!.player).toBe(C) // C is still prompted
    expect(state.pendingSacrifice!.player).toBe(C) // no dangling pending/pendingSacrifice mismatch

    act(state, C, { type: 'r.sacrifice', objIds: [cGiant] })
    expect(state.pending).toBeNull()
    expect(state.objects[cGiant]!.zone).toBe('graveyard')
  })
})

describe('forced sacrifice self-heals if the chooser moves their creatures away', () => {
  it('does not wedge when the candidate creatures are re-minted out of the battlefield', () => {
    const { state, A, B } = makeDuel()
    const edict = putCard(state, A, 'Diabolic Edict', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    putCard(state, A, 'Swamp', 'battlefield')
    const bBear = putCard(state, B, 'Grizzly Bears', 'battlefield')
    const bOgre = putCard(state, B, 'Gray Ogre', 'battlefield')
    toStep(state, 'main1')
    tapAllMana(state, A)
    act(state, A, { type: 'r.cast', objId: edict, targets: [B] })
    until(state, (s) => s.pending?.kind === 'sacrifice', 'edict opens')

    // B manually bounces BOTH candidates to hand (public→hidden → id re-mint), so the
    // snapshot candidate ids no longer resolve to live creatures
    act(state, B, { type: 'r.mMove', objId: bBear, zone: 'hand' })
    act(state, B, { type: 'r.mMove', objId: bOgre, zone: 'hand' })

    // the prompt reflects the live board (0 creatures) instead of the stale snapshot
    const bLegal = redactRulesState(state, B).legal
    expect(bLegal.needsSacrifice).toBe(true)
    expect(bLegal.sacrificeCount).toBe(0)
    expect(bLegal.sacrificeableIds).toEqual([])

    // sacrificing nothing resolves the edict rather than wedging the game
    act(state, B, { type: 'r.sacrifice', objIds: [] })
    expect(state.pending).toBeNull()
    expect(state.priorityPlayer).toBe(A)
  })
})

describe('Bloodthrone Vampire — sacrifice a creature: +2/+2', () => {
  it('grows when it eats a creature', () => {
    const { state, A } = makeDuel()
    putCard(state, A, 'Bloodthrone Vampire', 'battlefield')
    const vamp = state.zones.perPlayer[A]!.battlefield.find((id) => nameOf(state, id) === 'Bloodthrone Vampire')!
    const fodder = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    act(state, A, { type: 'r.activate', objId: vamp, abilityIndex: 0, targets: [], sacrifices: [fodder] })
    expect(state.objects[fodder]!.zone).toBe('graveyard')
    until(state, (s) => s.priorityPlayer === A && !s.zones.stack.length, 'pump resolves')
    const card = redactRulesState(state, A).cards[vamp]!
    expect(card.power).toBe(3) // 1/1 + 2/2
    expect(card.toughness).toBe(3)
  })
})
