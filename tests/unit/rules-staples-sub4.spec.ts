/**
 * Coverage batch SUB4: BANDING (CR 702.22) — a faithful, documented SUBSET. Banding is
 * notoriously complex; the tractable, decisive piece expressible in this combat model is the
 * DEFENSIVE damage-assignment control (702.22h): when an attacker is blocked by a creature with
 * banding, the DEFENDING player assigns that attacker's combat damage. The deterministic optimal
 * defence is to funnel ALL of it onto the banding creature — sparing the rest of the block and
 * negating trample (excess is assigned to the band member, not trampled through).
 *
 * OUT OF SCOPE (documented): attacking-as-a-band grouping and OFFENSIVE banding (702.22i, the
 * attacker assigning the blockers' damage) — both need multi-creature bands / an interactive
 * damage-assignment order this auto-assigning model doesn't have. Card: Benalish Hero {W} 1/1 banding.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, until } from './rules-helpers.ts'
import type { ObjId, PlayerId, RulesGameState } from '../../shared/rules/types.ts'

type St = RulesGameState

/** A (active) attacks B with `attacker`; B blocks with `blockers` (in order); run through to post-
 *  combat main (combat_damage + SBA have happened by then). */
function combat(state: St, A: PlayerId, B: PlayerId, attacker: ObjId, blockers: ObjId[]) {
  until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'attackers')
  act(state, A, { type: 'r.attackers', attacks: [{ attackerId: attacker, defenderId: B }] })
  until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'blockers')
  act(state, B, { type: 'r.blockers', blocks: blockers.map((blockerId) => ({ blockerId, attackerId: attacker })) })
  until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat main')
}

describe('banding — defensive damage-assignment funnels the attacker onto the band, sparing co-blockers', () => {
  it('a banding blocker absorbs all the attacker damage; the other blocker takes none', () => {
    const { state, A, B } = makeDuel()
    const giant = putCard(state, A, 'Hill Giant', 'battlefield') // 3/3 attacker
    const hero = putCard(state, B, 'Benalish Hero', 'battlefield') // 1/1 banding
    const bears = putCard(state, B, 'Grizzly Bears', 'battlefield') // 2/2 — must be spared

    combat(state, A, B, giant, [hero, bears])

    // all 3 damage went to the banding Hero (it dies); the Bears took nothing and survives.
    // (Without banding the default assignment would kill lethal-first then spill onto the Bears.)
    expect(state.objects[hero]!.zone).toBe('graveyard')
    expect(state.objects[bears]!.zone).toBe('battlefield')
    expect(state.objects[bears]!.damageMarked).toBe(0)
  })
})

describe('banding — negates trample (all excess is assigned to the band member, not trampled)', () => {
  it('a lone banding blocker stops a trampler from reaching the defending player', () => {
    const { state, A, B } = makeDuel()
    const dino = putCard(state, A, 'Colossal Dreadmaw', 'battlefield') // 6/6 trample
    const hero = putCard(state, B, 'Benalish Hero', 'battlefield') // 1/1 banding

    const lifeBefore = state.players[B]!.life
    combat(state, A, B, dino, [hero])

    expect(state.objects[hero]!.zone).toBe('graveyard') // absorbed all 6
    expect(state.players[B]!.life).toBe(lifeBefore) // trample negated — no damage reached B
  })
})
