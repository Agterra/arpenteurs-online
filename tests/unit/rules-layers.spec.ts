/**
 * M-R1 layer-system foundation (CR 613 layer 7): +1/+1 and -1/-1 counters change
 * a creature's effective power/toughness in combat and state-based actions, and
 * cancel each other (CR 704.5q).
 */
import { describe, expect, it } from 'vitest'
import { act, attack, makeDuel, putCard, putFallback, rig, toStep, until } from './rules-helpers.ts'
import { checkSBA } from '../../server/rules/engine.ts'
import { redactRulesState } from '../../server/rules/redact.ts'
import { getDef } from '../../server/rules/cards/registry.ts'

function board() {
  const { state, A, B } = makeDuel()
  rig(state, A, { hand: [], battlefield: [] })
  rig(state, B, { hand: [], battlefield: [] })
  return { state, A, B }
}

describe('counters change power/toughness', () => {
  it('a +1/+1 counter makes a creature deal more combat damage', () => {
    const { state, A, B } = board()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2
    state.objects[bears]!.counters['+1/+1'] = 1 // → 3/3
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [bears])
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.players[B]!.life).toBe(37) // 40 − 3
  })

  it('a bigger toughness from a +1/+1 counter survives otherwise-lethal damage', () => {
    const { state, A } = board()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2
    state.objects[bears]!.counters['+1/+1'] = 1 // → 3/3
    state.objects[bears]!.damageMarked = 2 // 2 < 3 toughness
    checkSBA(state)
    expect(state.objects[bears]!.zone).toBe('battlefield')
  })

  it('-1/-1 counters reducing toughness to 0 kill the creature (SBA)', () => {
    const { state, A } = board()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2
    state.objects[bears]!.counters['-1/-1'] = 2 // → 0/0
    checkSBA(state)
    expect(state.objects[bears]!.zone).toBe('graveyard')
  })

  it('+1/+1 and -1/-1 counters annihilate as a state-based action (CR 704.5q)', () => {
    const { state, A } = board()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2
    state.objects[bears]!.counters['+1/+1'] = 3
    state.objects[bears]!.counters['-1/-1'] = 1
    checkSBA(state)
    expect(state.objects[bears]!.counters['+1/+1']).toBe(2) // one of each removed
    expect(state.objects[bears]!.counters['-1/-1']).toBeUndefined() // 0 → key deleted
    expect(state.objects[bears]!.zone).toBe('battlefield') // net 4/4
  })

  it('annihilation (704.5q) applies to ANY permanent, not just creatures', () => {
    const { state, A } = board()
    const land = putCard(state, A, 'Mountain') // a noncreature permanent
    state.objects[land]!.counters['+1/+1'] = 2
    state.objects[land]!.counters['-1/-1'] = 1
    checkSBA(state)
    expect(state.objects[land]!.counters['+1/+1']).toBe(1) // one of each removed
    expect(state.objects[land]!.counters['-1/-1']).toBeUndefined()
  })
})

describe('assisted-table integration + client view', () => {
  it('a +1/+1 counter added via the r.mCounter manual override affects combat', () => {
    const { state, A, B } = board()
    const bears = putCard(state, A, 'Grizzly Bears')
    act(state, A, { type: 'r.mCounter', objId: bears, name: '+1/+1', delta: 1 }) // player adds it by hand
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [bears])
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.players[B]!.life).toBe(37) // fought as a 3/3
  })

  it('the redacted client card reports effective P/T for creatures and null for others', () => {
    const { state, A } = board()
    const bears = putCard(state, A, 'Grizzly Bears')
    state.objects[bears]!.counters['+1/+1'] = 2
    const mtn = putCard(state, A, 'Mountain')
    const view = redactRulesState(state, A)
    expect(view.cards[bears]!.power).toBe(4)
    expect(view.cards[bears]!.toughness).toBe(4)
    expect(view.cards[mtn]!.power).toBeNull()
    expect(view.cards[mtn]!.toughness).toBeNull()
  })

  it('leaves P/T unknown (null) for a *-statted unimplemented creature rather than reporting 0', () => {
    const { state, A } = board()
    const goyf = putFallback(state, A, { name: 'Lhurgoyf X', typeLine: 'Creature — Lhurgoyf', power: '*', toughness: '1+*' })
    const view = redactRulesState(state, A)
    expect(view.cards[goyf]!.power).toBeNull()
    expect(view.cards[goyf]!.toughness).toBeNull()
    expect(view.cards[goyf]!.unimplemented).toBe(true)
  })
})

describe('static anthems (CR 613 layer 7c)', () => {
  it('boosts only the controller’s creatures, stacks with counters, and drops when it leaves', () => {
    const { state, A, B } = board()
    const mine = putCard(state, A, 'Grizzly Bears') // 2/2
    const theirs = putCard(state, B, 'Grizzly Bears') // 2/2
    const anthem = putCard(state, A, 'Glorious Anthem') // "creatures you control get +1/+1"
    let view = redactRulesState(state, A)
    expect([view.cards[mine]!.power, view.cards[mine]!.toughness]).toEqual([3, 3]) // buffed
    expect([view.cards[theirs]!.power, view.cards[theirs]!.toughness]).toEqual([2, 2]) // opponent unaffected

    state.objects[mine]!.counters['+1/+1'] = 1 // anthem + counter stack
    expect(redactRulesState(state, A).cards[mine]!.power).toBe(4)

    act(state, A, { type: 'r.mMove', objId: anthem, zone: 'graveyard' }) // anthem leaves
    view = redactRulesState(state, A)
    expect(view.cards[mine]!.power).toBe(3) // back to 2/2 + the lone counter
  })

  it('an anthem changes combat damage', () => {
    const { state, A, B } = board()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2 → 3/3 with the anthem
    putCard(state, A, 'Glorious Anthem')
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [bears])
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.players[B]!.life).toBe(37) // 40 − 3
  })
})

describe('pump spells (Giant Growth, until end of turn)', () => {
  it('pumps +3/+3 and wears off at end of turn', () => {
    const { state, A } = board()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2
    const forest = putCard(state, A, 'Forest')
    const gg = putCard(state, A, 'Giant Growth', 'hand')
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: forest })
    act(state, A, { type: 'r.cast', objId: gg, targets: [bears] })
    until(state, (s) => !s.zones.stack.length, 'resolve')
    expect([redactRulesState(state, A).cards[bears]!.power, redactRulesState(state, A).cards[bears]!.toughness]).toEqual([5, 5])
    until(state, (s) => s.turnNumber === 2, 'next turn')
    expect(redactRulesState(state, A).cards[bears]!.power).toBe(2) // wore off at cleanup
  })

  it('Giant Growth can save a creature in combat', () => {
    const { state, A, B } = board()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2 attacker
    const forest = putCard(state, A, 'Forest')
    const gg = putCard(state, A, 'Giant Growth', 'hand')
    const blocker = putCard(state, B, 'Grizzly Bears') // 2/2
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [bears])
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: blocker, attackerId: bears }] })
    // A holds priority in declare_blockers — pump the attacker to 5/5
    act(state, A, { type: 'r.tapMana', objId: forest })
    act(state, A, { type: 'r.cast', objId: gg, targets: [bears] })
    until(state, (s) => s.step === 'combat_damage', 'damage')
    expect(state.objects[blocker]!.zone).toBe('graveyard') // took 5
    expect(state.objects[bears]!.zone).toBe('battlefield') // took 2 vs toughness 5
  })
})

describe('continuous effects apply only on the battlefield', () => {
  it('an anthem does not boost off-battlefield creatures (command zone / graveyard)', () => {
    const { state, A } = board()
    putCard(state, A, 'Glorious Anthem')
    const cmd = state.objects[state.players[A]!.commanderId!]! // in the command zone
    const dead = putCard(state, A, 'Grizzly Bears', 'graveyard') // 2/2 in the graveyard
    const view = redactRulesState(state, A)
    expect(view.cards[cmd.id]!.power).toBe(getDef(cmd.defName).power) // NOT +1 from the anthem
    expect(view.cards[dead]!.power).toBe(2) // graveyard card reads its printed body
  })

  it('a pump ends when its creature leaves the battlefield — no stale reattach on return', () => {
    const { state, A } = board()
    const bears = putCard(state, A, 'Grizzly Bears')
    state.pumps.push({ objId: bears, power: 3, toughness: 3 })
    expect(redactRulesState(state, A).cards[bears]!.power).toBe(5) // pumped on the battlefield
    act(state, A, { type: 'r.mMove', objId: bears, zone: 'graveyard' }) // leaves
    expect(state.pumps).toHaveLength(0) // pump purged
    act(state, A, { type: 'r.mMove', objId: bears, zone: 'battlefield' }) // returns (new object)
    expect(redactRulesState(state, A).cards[bears]!.power).toBe(2) // base, not reattached
  })
})

describe('set base P/T (7b) + lose all abilities (layer 6)', () => {
  it('Ovinize turns a Shivan Dragon into a 0/1 with no flying, then wears off', () => {
    const { state, A, B } = makeDuel()
    const dragon = putCard(state, A, 'Shivan Dragon') // 5/5 flying, firebreathing
    const ov = putCard(state, B, 'Ovinize', 'hand')
    const islands = [putCard(state, B, 'Island'), putCard(state, B, 'Island')]
    // A passes priority so B (instant speed) can Ovinize the dragon
    toStep(state, 'main1')
    act(state, A, { type: 'r.pass' })
    for (const i of islands) act(state, B, { type: 'r.tapMana', objId: i })
    act(state, B, { type: 'r.cast', objId: ov, targets: [dragon] })
    until(state, (s) => !s.zones.stack.length && !!s.priorityPlayer, 'resolved')
    let view = redactRulesState(state, A)
    expect([view.cards[dragon]!.power, view.cards[dragon]!.toughness]).toEqual([0, 1]) // set 0/1
    expect(view.cards[dragon]!.keywords).not.toContain('flying') // lost abilities
    until(state, (s) => s.turnNumber === 2, 'next turn')
    view = redactRulesState(state, A)
    expect([view.cards[dragon]!.power, view.cards[dragon]!.toughness]).toEqual([5, 5]) // wore off
    expect(view.cards[dragon]!.keywords).toContain('flying')
  })

  it('a set base (7b) is overridden then counters (7d) still add on top', () => {
    const { state, A } = makeDuel()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2
    state.objects[bears]!.counters['+1/+1'] = 1 // 3/3
    state.setPT.push({ objId: bears, power: 0, toughness: 1 }) // base becomes 0/1
    const view = redactRulesState(state, A)
    expect([view.cards[bears]!.power, view.cards[bears]!.toughness]).toEqual([1, 2]) // 0/1 + counter
  })
})

describe('static keyword grants (CR 613 layer 6)', () => {
  it('Fervor grants haste to your creatures (so a fresh creature can attack), only yours, and only while it is out', () => {
    const { state, A, B } = board()
    const ogre = putCard(state, A, 'Gray Ogre') // no printed haste
    const fervor = putCard(state, A, 'Fervor') // "Creatures you control have haste."
    const oppOgre = putCard(state, B, 'Gray Ogre')
    state.objects[ogre]!.summoningSick = true
    state.objects[oppOgre]!.summoningSick = true

    // client sees the granted keyword and lists the fresh creature as a legal attacker
    const view = redactRulesState(state, A)
    expect(view.cards[ogre]!.keywords).toContain('haste')
    expect(view.cards[oppOgre]!.keywords).not.toContain('haste') // opponent unaffected

    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [ogre]) // summoning-sick, but Fervor grants haste → legal
    expect(state.objects[ogre]!.attackingDefender).toBe(B)

    // when Fervor leaves, the grant is gone
    act(state, A, { type: 'r.mMove', objId: fervor, zone: 'graveyard' })
    expect(redactRulesState(state, A).cards[ogre]!.keywords).not.toContain('haste')
  })
})

describe('manual moves reconcile state-based actions', () => {
  it('removing an anthem via r.mMove immediately kills a now-lethally-damaged creature', () => {
    const { state, A } = board()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2
    const anthem = putCard(state, A, 'Glorious Anthem') // → bears is 3/3
    state.objects[bears]!.damageMarked = 2 // survives at 3/3 (2 < 3)
    checkSBA(state)
    expect(state.objects[bears]!.zone).toBe('battlefield')
    act(state, A, { type: 'r.mMove', objId: anthem, zone: 'graveyard' }) // bears drops to 2/2 with 2 damage
    expect(state.objects[bears]!.zone).toBe('graveyard') // dies immediately via SBA
  })

  it('a -1/-1 counter added by r.mCounter that reduces toughness to 0 kills immediately', () => {
    const { state, A } = board()
    const bears = putCard(state, A, 'Grizzly Bears') // 2/2
    act(state, A, { type: 'r.mCounter', objId: bears, name: '-1/-1', delta: 2 }) // → 0/0
    expect(state.objects[bears]!.zone).toBe('graveyard') // dies immediately via SBA
  })
})
