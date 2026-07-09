/**
 * M-R1 evergreen combat keywords: flying/reach, vigilance, haste, defender,
 * menace, deathtouch, lifelink, trample, first strike, double strike.
 * Uses real French-vanilla starter cards placed via putCard().
 */
import { describe, expect, it } from 'vitest'
import { act, attack, fieldObj, handObj, makeDuel, putCard, rig, until } from './rules-helpers.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

/** Clear both boards, then let the caller place exactly the creatures a test needs. */
function board() {
  const { state, A, B } = makeDuel()
  rig(state, A, { hand: [], battlefield: [] })
  rig(state, B, { hand: [], battlefield: [] })
  return { state, A, B }
}

describe('evasion: flying / reach', () => {
  it('a flyer can only be blocked by flying or reach', () => {
    const { state, A, B } = board()
    const drake = putCard(state, A, 'Wind Drake') // 2/2 flying
    const bears = putCard(state, B, 'Grizzly Bears') // 2/2 ground
    const spider = putCard(state, B, 'Giant Spider') // 2/4 reach
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [drake])
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    expect(() => act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bears, attackerId: drake }] })).toThrow(/flyer/)
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: spider, attackerId: drake }] }) // reach blocks
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.players[B]!.life).toBe(40) // blocked — nothing gets through
    expect(state.objects[drake]!.zone).toBe('graveyard') // 2/2 takes 2 from the spider
    expect(state.objects[spider]!.damageMarked).toBe(2)
  })
})

describe('vigilance / haste / defender', () => {
  it('vigilance keeps the attacker untapped', () => {
    const { state, A, B } = board()
    const angel = putCard(state, A, 'Serra Angel') // flying, vigilance
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [angel])
    expect(state.objects[angel]!.tapped).toBe(false)
    expect(state.objects[angel]!.attackingDefender).toBe(B)
  })

  it('haste lets a summoning-sick creature attack; a non-haste one cannot', () => {
    const { state, A, B } = board()
    const goblin = putCard(state, A, 'Raging Goblin') // haste
    const ogre = putCard(state, A, 'Gray Ogre') // no haste
    state.objects[goblin]!.summoningSick = true
    state.objects[ogre]!.summoningSick = true
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers') // haste creature makes combat happen
    expect(() => attack(state, A, B, [ogre])).toThrow(/summoning sickness/)
    attack(state, A, B, [goblin])
    expect(state.objects[goblin]!.attackingDefender).toBe(B)
  })

  it('a creature with defender cannot be declared as an attacker', () => {
    const { state, A, B } = board()
    const wall = putCard(state, A, 'Wall of Wood') // 0/3 defender
    putCard(state, A, 'Gray Ogre') // a valid attacker so the step fires
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    expect(() => attack(state, A, B, [wall])).toThrow(/defender/)
  })

  it('a lone defender means no eligible attackers — combat auto-skips', () => {
    const { state, A } = board()
    putCard(state, A, 'Wall of Wood')
    until(state, (s) => s.step === 'end_combat', 'end_combat')
    expect(state.pending).toBeNull()
  })
})

describe('menace', () => {
  it('needs two or more blockers', () => {
    const { state, A, B } = board()
    const brute = putCard(state, A, 'Boggart Brute') // 3/2 menace
    const bears = putCard(state, B, 'Grizzly Bears')
    const ogre = putCard(state, B, 'Gray Ogre')
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [brute])
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    expect(() => act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bears, attackerId: brute }] })).toThrow(/menace/)
    act(state, B, {
      type: 'r.blockers',
      blocks: [
        { blockerId: bears, attackerId: brute },
        { blockerId: ogre, attackerId: brute },
      ],
    })
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.players[B]!.life).toBe(40) // fully blocked
  })
})

describe('deathtouch + lifelink', () => {
  it('deathtouch kills any blocker it damages; lifelink gains its controller life', () => {
    const { state, A, B } = board()
    const hawk = putCard(state, A, 'Vampire Nighthawk') // 2/3 flying, deathtouch, lifelink
    const spider = putCard(state, B, 'Giant Spider') // 2/4 reach (can block the flyer)
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [hawk])
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: spider, attackerId: hawk }] })
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.objects[spider]!.zone).toBe('graveyard') // 2 deathtouch damage vs 4 toughness → dies
    expect(state.objects[hawk]!.zone).toBe('battlefield') // 2 damage vs 3 toughness → survives
    expect(state.players[A]!.life).toBe(42) // lifelink: +2 for the damage dealt
  })
})

describe('trample', () => {
  it('assigns lethal to the blocker and spills the rest to the defending player', () => {
    const { state, A, B } = board()
    const dread = putCard(state, A, 'Colossal Dreadmaw') // 6/6 trample
    const bears = putCard(state, B, 'Grizzly Bears') // 2/2
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [dread])
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bears, attackerId: dread }] })
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.objects[bears]!.zone).toBe('graveyard') // 2 lethal
    expect(state.players[B]!.life).toBe(36) // 6 − 2 lethal = 4 trampled over
  })

  it('a blocked trampler whose blocker is removed before damage tramples its FULL power', () => {
    // regression: the trample spill must not be suppressed when no blocker survives
    const { state, A, B } = makeDuel()
    rig(state, A, { hand: ['Lightning Bolt'], battlefield: ['Mountain'] })
    rig(state, B, { hand: [], battlefield: [] })
    const dread = putCard(state, A, 'Colossal Dreadmaw') // 6/6 trample
    const bears = putCard(state, B, 'Grizzly Bears') // 2/2 chump
    const bolt = handObj(state, A, 'Lightning Bolt')
    const mtn = fieldObj(state, A, 'Mountain')
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [dread])
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bears, attackerId: dread }] })
    // A holds priority in declare_blockers — bolt the blocker away
    act(state, A, { type: 'r.tapMana', objId: mtn })
    act(state, A, { type: 'r.cast', objId: bolt, targets: [bears] })
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.objects[bears]!.zone).toBe('graveyard') // bolted
    expect(state.players[B]!.life).toBe(34) // still "blocked" but no blocker → full 6 tramples over
  })
})

describe('first strike / double strike', () => {
  it('first strike kills a same-size blocker before it can hit back', () => {
    const { state, A, B } = board()
    const knight = putCard(state, A, 'Youthful Knight') // 2/2 first strike
    const bears = putCard(state, B, 'Grizzly Bears') // 2/2
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [knight])
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bears, attackerId: knight }] })
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.objects[bears]!.zone).toBe('graveyard') // dies in the first-strike step
    expect(state.objects[knight]!.zone).toBe('battlefield') // bears never dealt back
    expect(state.objects[knight]!.damageMarked).toBe(0)
  })

  it('double strike deals in both the first-strike and the regular step', () => {
    const { state, A, B } = board()
    const ace = putCard(state, A, 'Fencing Ace') // 1/1 double strike
    const spider = putCard(state, B, 'Giant Spider') // 2/4
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [ace])
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: spider, attackerId: ace }] })
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.objects[spider]!.damageMarked).toBe(2) // 1 + 1 across both steps
    expect(state.objects[ace]!.zone).toBe('graveyard') // spider hits back for 2 in the regular step
  })
})

describe('client display', () => {
  it('redacted client cards expose their keywords', () => {
    const { state, A } = board()
    const hawk = putCard(state, A, 'Vampire Nighthawk')
    const view = redactRulesState(state, A)
    expect([...view.cards[hawk]!.keywords].sort()).toEqual(['deathtouch', 'flying', 'lifelink'])
  })
})
