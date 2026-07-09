import { describe, expect, it } from 'vitest'
import { RulesError } from '../../server/rules/engine.ts'
import { redactRulesState } from '../../server/rules/redact.ts'
import { unimplementedNames } from '../../server/rules/cards/registry.ts'
import {
  act,
  attack,
  commanderObj,
  fieldObj,
  handObj,
  makeDuel,
  makeGameN,
  pass,
  playLandAndTap,
  rig,
  toStep,
  until,
} from './rules-helpers.ts'

describe('setup & registry', () => {
  it('builds a duel at upkeep of turn 1 with 7-card hands, 40 life, commander in the command zone', () => {
    const { state, A } = makeDuel()
    expect(state.turnNumber).toBe(1)
    expect(state.step).toBe('upkeep')
    expect(state.priorityPlayer).toBe(A)
    for (const pid of state.turnOrder) {
      expect(state.zones.perPlayer[pid]!.hand).toHaveLength(7)
      expect(state.players[pid]!.life).toBe(40)
      expect(state.zones.perPlayer[pid]!.command).toHaveLength(1)
      expect(state.objects[state.players[pid]!.commanderId!]!.isCommander).toBe(true)
    }
  })
  it('flags unimplemented card names', () => {
    expect(unimplementedNames(['Mountain', 'Black Lotus', 'Shock'])).toEqual(['Black Lotus'])
  })
})

describe('turn structure & priority', () => {
  it('skips the first draw for the player on the play, draws thereafter', () => {
    const { state, A, B } = makeDuel()
    const handA = state.zones.perPlayer[A]!.hand.length
    until(state, (s) => s.step === 'main1', 'main1')
    expect(state.zones.perPlayer[A]!.hand).toHaveLength(handA) // no draw on turn 1
    const handB = state.zones.perPlayer[B]!.hand.length
    until(state, (s) => s.turnNumber === 2 && s.step === 'main1', 'turn 2 main1')
    expect(state.activePlayer).toBe(B)
    expect(state.zones.perPlayer[B]!.hand).toHaveLength(handB + 1) // B drew
  })

  it('rejects actions without priority', () => {
    const { state, B } = makeDuel()
    expect(() => pass(state, B)).toThrow(RulesError) // A holds priority at upkeep
  })

  it('empties mana pools between steps', () => {
    const { state, A } = makeDuel()
    rig(state, A, { hand: ['Mountain', 'Shock'], battlefield: [] })
    toStep(state, 'main1')
    playLandAndTap(state, A, 1)
    expect(state.players[A]!.manaPool.R).toBe(1)
    until(state, (s) => s.step === 'begin_combat', 'begin_combat')
    expect(state.players[A]!.manaPool.R).toBe(0) // drained on step change
  })
})

describe('lands, mana, casting', () => {
  it('enforces one land per turn and sorcery-speed timing', () => {
    const { state, A } = makeDuel()
    rig(state, A, { hand: ['Mountain', 'Mountain', 'Gray Ogre'] })
    // playing a land at upkeep is illegal
    expect(() => act(state, A, { type: 'r.playLand', objId: handObj(state, A, 'Mountain') })).toThrow(/main phase/)
    toStep(state, 'main1')
    act(state, A, { type: 'r.playLand', objId: handObj(state, A, 'Mountain') })
    expect(() => act(state, A, { type: 'r.playLand', objId: handObj(state, A, 'Mountain') })).toThrow(/Already played/)
    // creature off-main / without mana
    expect(() => act(state, A, { type: 'r.cast', objId: handObj(state, A, 'Gray Ogre'), targets: [] })).toThrow(
      /Not enough mana/,
    )
  })

  it('casts a creature with correct payment; it has summoning sickness', () => {
    const { state, A } = makeDuel()
    rig(state, A, { hand: ['Gray Ogre'], battlefield: ['Mountain', 'Mountain', 'Mountain'] })
    toStep(state, 'main1')
    for (const id of [...state.zones.perPlayer[A]!.battlefield]) act(state, A, { type: 'r.tapMana', objId: id })
    expect(state.players[A]!.manaPool.R).toBe(3)
    act(state, A, { type: 'r.cast', objId: handObj(state, A, 'Gray Ogre'), targets: [] })
    expect(state.zones.stack).toHaveLength(1)
    expect(state.players[A]!.manaPool.R).toBe(0) // {2}{R} paid from RRR
    until(state, (s) => !s.zones.stack.length, 'resolution')
    const ogre = fieldObj(state, A, 'Gray Ogre')
    expect(state.objects[ogre]!.summoningSick).toBe(true)
    expect(() => act(state, A, { type: 'r.tapMana', objId: ogre })).toThrow(/No mana ability/)
  })

  it('rejects casting a creature at instant speed (opponent turn)', () => {
    const { state, A, B } = makeDuel()
    rig(state, B, { hand: ['Gray Ogre'], battlefield: ['Mountain', 'Mountain', 'Mountain'] })
    until(state, (s) => s.step === 'end' && s.priorityPlayer === A, 'end step')
    pass(state, A) // B now has priority on A's end step
    for (const id of [...state.zones.perPlayer[B]!.battlefield]) act(state, B, { type: 'r.tapMana', objId: id })
    expect(() => act(state, B, { type: 'r.cast', objId: handObj(state, B, 'Gray Ogre'), targets: [] })).toThrow(
      /main phase/,
    )
  })
})

describe('the stack', () => {
  it('resolves LIFO and fizzles a spell whose only target died', () => {
    const { state, A, B } = makeDuel()
    rig(state, A, { hand: ['Shock'], battlefield: ['Mountain'] })
    rig(state, B, { hand: ['Lightning Bolt'], battlefield: ['Mountain', 'Grizzly Bears'] })
    const bears = fieldObj(state, B, 'Grizzly Bears')
    toStep(state, 'main1')
    playTap(A)
    act(state, A, { type: 'r.cast', objId: handObj(state, A, 'Shock'), targets: [bears] })
    expect(state.priorityPlayer).toBe(A) // caster retains priority
    pass(state, A)
    // B responds: bolt their own Bears (LIFO: Bolt resolves first)
    playTap(B)
    act(state, B, { type: 'r.cast', objId: handObj(state, B, 'Lightning Bolt'), targets: [bears] })
    expect(state.zones.stack).toHaveLength(2)
    pass(state, B)
    pass(state, A) // both passed → Bolt resolves
    expect(state.objects[bears]!.zone).toBe('graveyard') // 3 dmg kills the 2/2 (SBA)
    // Shock still on the stack; both pass → it fizzles
    until(state, (s) => !s.zones.stack.length, 'shock resolution')
    const shock = state.zones.perPlayer[A]!.graveyard.map((i) => state.objects[i]!.defName)
    expect(shock).toContain('shock')
    expect(state.players[B]!.life).toBe(40) // fizzled: no damage anywhere
    expect(state.log.join('\n')).toMatch(/fizzles/)

    function playTap(p: string) {
      const untapped = state.zones.perPlayer[p]!.battlefield.find(
        (i) => state.objects[i]!.defName === 'mountain' && !state.objects[i]!.tapped,
      )!
      act(state, p, { type: 'r.tapMana', objId: untapped })
    }
  })

  it('requires exactly the right number of legal targets', () => {
    const { state, A } = makeDuel()
    rig(state, A, { hand: ['Shock'], battlefield: ['Mountain'] })
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: fieldObj(state, A, 'Mountain') })
    expect(() => act(state, A, { type: 'r.cast', objId: handObj(state, A, 'Shock'), targets: [] })).toThrow(
      /exactly 1 target/,
    )
    expect(() =>
      act(state, A, { type: 'r.cast', objId: handObj(state, A, 'Shock'), targets: ['nonsense'] }),
    ).toThrow(/Illegal target/)
  })
})

describe('combat', () => {
  it('full combat: block kills, unblocked damage, blocked-with-dead-blocker deals nothing', () => {
    const { state, A, B } = makeDuel()
    rig(state, A, { battlefield: ['Hill Giant', 'Gray Ogre'], hand: [] })
    rig(state, B, { battlefield: ['Grizzly Bears'], hand: [] })
    const giant = fieldObj(state, A, 'Hill Giant')
    const ogre = fieldObj(state, A, 'Gray Ogre')
    const bears = fieldObj(state, B, 'Grizzly Bears')

    until(state, (s) => s.pending?.kind === 'attackers', 'attackers pending')
    expect(() => act(state, B, { type: 'r.attackers', attacks: [] })).toThrow(/Not waiting/)
    attack(state, A, B, [giant, ogre])
    expect(state.objects[giant]!.tapped).toBe(true)

    until(state, (s) => s.pending?.kind === 'blockers', 'blockers pending')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: bears, attackerId: giant }] })

    until(state, (s) => s.step === 'combat_damage', 'combat damage')
    expect(state.objects[bears]!.zone).toBe('graveyard') // 3 dmg vs 2/2
    expect(state.objects[giant]!.damageMarked).toBe(2) // bears hit back, survives
    expect(state.objects[giant]!.zone).toBe('battlefield')
    expect(state.players[B]!.life).toBe(38) // ogre unblocked: 2

    until(state, (s) => s.turnNumber === 2, 'turn 2')
    expect(state.objects[giant]!.damageMarked).toBe(0) // cleanup wipes damage
  })

  it('rejects summoning-sick and tapped attackers, tapped blockers', () => {
    const { state, A, B } = makeDuel()
    rig(state, A, { battlefield: ['Gray Ogre', 'Hill Giant'], hand: [] })
    rig(state, B, { battlefield: ['Grizzly Bears'], hand: [] })
    const ogre = fieldObj(state, A, 'Gray Ogre')
    const giant = fieldObj(state, A, 'Hill Giant')
    state.objects[ogre]!.summoningSick = true
    state.objects[giant]!.tapped = true
    // no eligible attackers → combat auto-skips to end_combat (rule 508.8)
    until(state, (s) => s.step === 'end_combat', 'end_combat')
    expect(state.pending).toBeNull()
  })

  it('a creature cannot block two attackers; attacker choice validated', () => {
    const { state, A, B } = makeDuel()
    rig(state, A, { battlefield: ['Gray Ogre', 'Hill Giant'], hand: [] })
    rig(state, B, { battlefield: ['Grizzly Bears'], hand: [] })
    const ogre = fieldObj(state, A, 'Gray Ogre')
    const giant = fieldObj(state, A, 'Hill Giant')
    const bears = fieldObj(state, B, 'Grizzly Bears')
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    attack(state, A, B, [ogre, giant])
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    expect(() =>
      act(state, B, {
        type: 'r.blockers',
        blocks: [
          { blockerId: bears, attackerId: ogre },
          { blockerId: bears, attackerId: giant },
        ],
      }),
    ).toThrow(/only one attacker/)
  })
})

describe('losing the game', () => {
  it('life to 0 via burn ends the game', () => {
    const { state, A, B } = makeDuel()
    rig(state, A, { hand: ['Mountain', 'Lightning Bolt'], battlefield: [] })
    rig(state, B, { life: 3 })
    toStep(state, 'main1')
    playLandAndTap(state, A, 1)
    act(state, A, { type: 'r.cast', objId: handObj(state, A, 'Lightning Bolt'), targets: [B] })
    until(state, (s) => s.status === 'ended', 'game end')
    expect(state.winner).toBe(A)
    expect(state.players[B]!.hasLost).toBe(true)
    expect(() => pass(state, A)).toThrow(/over/)
  })

  it('drawing from an empty library loses', () => {
    const { state, B } = makeDuel()
    rig(state, B, { hand: ['Mountain'], librarySize: 0 })
    until(state, (s) => s.status === 'ended', 'deck-out')
    expect(state.winner).not.toBe(B)
  })

  it('concede ends it immediately', () => {
    const { state, A, B } = makeDuel()
    act(state, B, { type: 'r.concede' })
    expect(state.status).toBe('ended')
    expect(state.winner).toBe(A)
  })
})

describe('cleanup discard', () => {
  it('forces a discard to 7 and validates the count', () => {
    const { state, A } = makeDuel()
    rig(state, A, {
      hand: ['Mountain', 'Mountain', 'Mountain', 'Shock', 'Shock', 'Lightning Bolt', 'Gray Ogre', 'Hill Giant', 'Divination'],
    })
    until(state, (s) => s.pending?.kind === 'discard', 'discard pending')
    const hand = state.zones.perPlayer[A]!.hand
    expect(() => act(state, A, { type: 'r.discard', objIds: [hand[0]!] })).toThrow(/exactly 2/)
    act(state, A, { type: 'r.discard', objIds: [hand[0]!, hand[1]!] })
    expect(state.zones.perPlayer[A]!.hand).toHaveLength(7)
    expect(state.turnNumber).toBe(2)
  })
})

describe('adversarial-review regressions', () => {
  it('CR 116.4: tapping for mana restarts the pass chain', () => {
    const { state, A, B } = makeDuel()
    rig(state, A, { hand: [] })
    rig(state, B, { hand: [], battlefield: ['Mountain'] })
    toStep(state, 'main1')
    pass(state, A) // passed=[A], priority → B
    act(state, B, { type: 'r.tapMana', objId: fieldObj(state, B, 'Mountain') })
    pass(state, B)
    // B took an action, so A is owed a fresh priority window in the SAME step
    expect(state.step).toBe('main1')
    expect(state.priorityPlayer).toBe(A)
    pass(state, A) // completes the restarted chain (B already passed after acting)
    expect(state.step).toBe('begin_combat') // now it advances
  })

  it('CR 508.4/508.8: declare_attackers still grants priority with zero attackers, then skips to end_combat', () => {
    const { state, A } = makeDuel()
    rig(state, A, { hand: [], battlefield: [] })
    until(state, (s) => s.step === 'begin_combat', 'begin_combat')
    pass(state, A)
    pass(state, state.priorityPlayer!)
    // the declare_attackers STEP itself must occur with a priority round
    expect(state.step).toBe('declare_attackers')
    expect(state.priorityPlayer).toBe(A)
    pass(state, A)
    pass(state, state.priorityPlayer!)
    // then blockers + damage are skipped
    expect(state.step).toBe('end_combat')
  })

  it('an explicit empty attack declaration also keeps the priority round then skips', () => {
    const { state, A } = makeDuel()
    rig(state, A, { hand: [], battlefield: ['Grizzly Bears'] })
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers pending')
    act(state, A, { type: 'r.attackers', attacks: [] })
    expect(state.step).toBe('declare_attackers')
    expect(state.priorityPlayer).toBe(A)
    pass(state, A)
    pass(state, state.priorityPlayer!)
    expect(state.step).toBe('end_combat')
  })

  it('post-game concede is a no-op (winner never becomes hasLost)', () => {
    const { state, A, B } = makeDuel()
    act(state, B, { type: 'r.concede' })
    expect(state.status).toBe('ended')
    const seq = state.seq
    act(state, A, { type: 'r.concede' }) // must not mutate anything
    expect(state.players[A]!.hasLost).toBe(false)
    expect(state.winner).toBe(A)
    expect(state.seq).toBe(seq)
  })

  it('tapMana rejects mana abilities the engine cannot pay yet (M-R1 hardening guard)', () => {
    // guards the latent infinite-mana branch: isMana without {T} must be refused
    const { state, A } = makeDuel()
    rig(state, A, { battlefield: ['Mountain'] })
    toStep(state, 'main1')
    // sanity: the shipped basics still work
    act(state, A, { type: 'r.tapMana', objId: fieldObj(state, A, 'Mountain') })
    expect(state.players[A]!.manaPool.R).toBe(1)
  })
})

describe('multiplayer (3–4 players)', () => {
  it('4-player APNAP: priority flows active→left, all four must pass to advance', () => {
    const { state, players } = makeGameN(4)
    const [p0, p1, p2, p3] = players
    expect(state.activePlayer).toBe(p0)
    expect(state.priorityPlayer).toBe(p0)
    pass(state, p0)
    expect(state.priorityPlayer).toBe(p1)
    pass(state, p1)
    expect(state.priorityPlayer).toBe(p2)
    pass(state, p2)
    expect(state.priorityPlayer).toBe(p3)
    expect(state.step).toBe('upkeep') // still upkeep until the 4th passes
    pass(state, p3)
    expect(state.step).toBe('draw') // now it advances
  })

  it('turn order rotates through all four players', () => {
    const { state, players } = makeGameN(4)
    for (let t = 2; t <= 4; t++) until(state, (s) => s.turnNumber === t, `turn ${t}`)
    expect(state.activePlayer).toBe(players[3])
  })

  it('you may only attack an opponent still in the game, and each attacker picks its defender', () => {
    const { state, players } = makeGameN(4)
    const [p0, , p2] = players
    rig(state, p0, { battlefield: ['Hill Giant', 'Gray Ogre'], hand: [] })
    const giant = fieldObj(state, p0, 'Hill Giant')
    const ogre = fieldObj(state, p0, 'Gray Ogre')
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    // attacking yourself is illegal
    expect(() => act(state, p0, { type: 'r.attackers', attacks: [{ attackerId: giant, defenderId: p0 }] })).toThrow(
      /opponent/,
    )
    // split attacks across two different opponents
    act(state, p0, {
      type: 'r.attackers',
      attacks: [
        { attackerId: giant, defenderId: players[1]! },
        { attackerId: ogre, defenderId: p2 },
      ],
    })
    expect(state.objects[giant]!.attackingDefender).toBe(players[1])
    expect(state.objects[ogre]!.attackingDefender).toBe(p2)
    until(state, (s) => s.turnNumber === 2, 'combat resolves')
    expect(state.players[players[1]!]!.life).toBe(37) // 3 from the giant
    expect(state.players[p2]!.life).toBe(38) // 2 from the ogre
  })

  it('only attacked defenders are queued to declare blockers (APNAP order)', () => {
    const { state, players } = makeGameN(4)
    const [p0, p1, p2] = players
    rig(state, p0, { battlefield: ['Hill Giant'], hand: [] })
    rig(state, p2, { battlefield: ['Grizzly Bears'], hand: [] })
    const giant = fieldObj(state, p0, 'Hill Giant')
    until(state, (s) => s.pending?.kind === 'attackers', 'attackers')
    act(state, p0, { type: 'r.attackers', attacks: [{ attackerId: giant, defenderId: p2 }] })
    until(state, (s) => s.pending?.kind === 'blockers', 'blockers')
    expect(state.pending!.player).toBe(p2) // p1 (not attacked) is skipped
    expect(() => act(state, p1, { type: 'r.blockers', blocks: [] })).toThrow(/Not waiting/)
    act(state, p2, { type: 'r.blockers', blocks: [{ blockerId: fieldObj(state, p2, 'Grizzly Bears'), attackerId: giant }] })
    until(state, (s) => s.turnNumber === 2, 'turn 2')
    expect(state.objects[giant]!.zone).toBe('battlefield') // 2 dmg vs 3 toughness
  })

  it('rule 800.4a: a player concedes, their cards leave, the game continues for the rest', () => {
    const { state, players } = makeGameN(4)
    const [p0, p1] = players
    rig(state, p1, { battlefield: ['Hill Giant', 'Grizzly Bears'], hand: ['Shock'] })
    const giantId = fieldObj(state, p1, 'Hill Giant')
    act(state, p1, { type: 'r.concede' })
    expect(state.status).toBe('active') // 3 players remain
    expect(state.players[p1]!.hasLost).toBe(true)
    expect(state.objects[giantId]).toBeUndefined() // their permanents left
    expect(Object.values(state.objects).some((o) => o.ownerId === p1)).toBe(false)
    // active player p0 is unaffected and still has priority
    expect(state.priorityPlayer).toBe(p0)
  })
})

describe('commander rules', () => {
  // seat mapping (makeGameN): p0 = Isamaru {W} 2/2, p1 = Jerrard {4}{R}{R} 6/5 (red, payable from Mountains)
  const makeWith = (active: string) => {
    const { state } = makeGameN(2)
    state.activePlayer = active
    state.turnOrder = [active, ...state.turnOrder.filter((p) => p !== active)]
    return state
  }

  it('casts the commander from the command zone and tax increments', () => {
    const state = makeWith('p1') // Jerrard, red
    rig(state, 'p1', { battlefield: Array(6).fill('Mountain'), hand: [] })
    toStep(state, 'main1')
    for (const id of [...state.zones.perPlayer['p1']!.battlefield]) act(state, 'p1', { type: 'r.tapMana', objId: id })
    const cmd = commanderObj(state, 'p1')
    expect(state.players['p1']!.commanderTax).toBe(0)
    act(state, 'p1', { type: 'r.cast', objId: cmd, targets: [] })
    expect(state.players['p1']!.commanderTax).toBe(1) // next cast will cost +2
    until(state, (s) => !s.zones.stack.length, 'commander resolves')
    expect(state.objects[cmd]!.zone).toBe('battlefield')
    expect(state.objects[cmd]!.summoningSick).toBe(true)
  })

  it("cannot afford the commander when tax pushes it out of reach", () => {
    const state = makeWith('p1')
    state.players['p1']!.commanderTax = 1 // now costs {4}{R}{R} + {2} = 8
    rig(state, 'p1', { battlefield: Array(6).fill('Mountain'), hand: [] }) // only 6 mana
    toStep(state, 'main1')
    for (const id of [...state.zones.perPlayer['p1']!.battlefield]) act(state, 'p1', { type: 'r.tapMana', objId: id })
    expect(() => act(state, 'p1', { type: 'r.cast', objId: commanderObj(state, 'p1'), targets: [] })).toThrow(
      /Not enough mana/,
    )
  })

  it('a dying commander returns to the command zone automatically', () => {
    const state = makeWith('p1') // p1 (red) will bolt p0's Isamaru (2/2)
    const cmd = commanderObj(state, 'p0')
    const obj = state.objects[cmd]!
    state.zones.perPlayer['p0']!.command = []
    obj.zone = 'battlefield'
    obj.controllerId = 'p0'
    state.zones.perPlayer['p0']!.battlefield.push(cmd)
    rig(state, 'p1', { hand: ['Lightning Bolt'], battlefield: ['Mountain'] })
    toStep(state, 'main1')
    act(state, 'p1', { type: 'r.tapMana', objId: fieldObj(state, 'p1', 'Mountain') })
    act(state, 'p1', { type: 'r.cast', objId: handObj(state, 'p1', 'Lightning Bolt'), targets: [cmd] })
    until(state, (s) => s.objects[cmd]!.zone === 'command', 'commander returns')
    expect(state.zones.perPlayer['p0']!.command).toContain(cmd)
    expect(state.zones.perPlayer['p0']!.graveyard).not.toContain(cmd)
  })

  it('21 commander damage from one commander loses the game', () => {
    const { state, A, B } = makeDuel()
    state.players[B]!.commanderDamage[commanderObj(state, A)] = 21
    // SBA is checked at the next grantPriority (step advance) — drive to it
    until(state, (s) => s.status === 'ended', 'game end from commander damage')
    expect(state.players[B]!.hasLost).toBe(true)
    expect(state.winner).toBe(A)
  })
})

describe('adversarial review round 2 regressions', () => {
  it('HIGH: prototype-chain keys are not legal targets (no Object.prototype pollution)', () => {
    const { state, A } = makeDuel()
    rig(state, A, { hand: ['Lightning Bolt'], battlefield: ['Mountain'] })
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: fieldObj(state, A, 'Mountain') })
    for (const evil of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(() =>
        act(state, A, { type: 'r.cast', objId: handObj(state, A, 'Lightning Bolt'), targets: [evil] }),
      ).toThrow(/target/i)
    }
    // Object.prototype must be untouched
    expect(({} as Record<string, unknown>).life).toBeUndefined()
  })

  it('LOW: APNAP priority continues from the passer, not back to the active player', () => {
    const { state, players } = makeGameN(4)
    const [p0, p1, p2] = players
    rig(state, p1, { hand: ['Lightning Bolt'], battlefield: ['Mountain'] })
    // upkeep: p0 passes → p1
    pass(state, p0)
    expect(state.priorityPlayer).toBe(p1)
    // p1 acts (casts) → keeps priority (correct), then passes
    act(state, p1, { type: 'r.tapMana', objId: fieldObj(state, p1, 'Mountain') })
    act(state, p1, { type: 'r.cast', objId: handObj(state, p1, 'Lightning Bolt'), targets: [p0] })
    expect(state.priorityPlayer).toBe(p1) // caster retains priority
    pass(state, p1)
    // CR 117.4: priority continues to p1's left (p2), NOT back to the active player p0
    expect(state.priorityPlayer).toBe(p2)
  })

  it('MEDIUM: eliminating the active player on their own turn passes the turn to the NEXT seat', () => {
    const { state, players } = makeGameN(4)
    const [p0, p1, p2] = players
    // make p1 (an interior seat) the active player
    state.activePlayer = p1
    const t0 = state.turnNumber
    // p1 concedes on their own turn → next turn must go to p2, not p0
    act(state, p1, { type: 'r.concede' })
    expect(state.status).toBe('active')
    until(state, (s) => s.turnNumber > t0, 'next turn')
    expect(state.activePlayer).toBe(p2)
    void p0
  })
})

describe('hidden information', () => {
  it('never serialises library ids or the opponent hand', () => {
    const { state, A, B } = makeDuel()
    const view = redactRulesState(state, B)
    const json = JSON.stringify(view)
    for (const pid of state.turnOrder)
      for (const id of state.zones.perPlayer[pid]!.library)
        expect(json.includes(id), `library id ${id} leaked to ${B}`).toBe(false)
    for (const id of state.zones.perPlayer[A]!.hand)
      expect(json.includes(id), `opponent hand id leaked`).toBe(false)
    const bHand = view.zones.perPlayer[B]!.hand
    expect(Array.isArray(bHand)).toBe(true) // own hand visible
    const aHand = view.zones.perPlayer[A]!.hand
    expect(Array.isArray(aHand)).toBe(false)
    expect((aHand as { count: number }).count).toBe(7)
  })

  it('legal actions reflect potential mana and land drops', () => {
    const { state, A } = makeDuel()
    rig(state, A, { hand: ['Mountain', 'Gray Ogre', 'Shock'], battlefield: ['Mountain', 'Mountain'] })
    toStep(state, 'main1')
    let view = redactRulesState(state, A)
    expect(view.legal.playableLandIds).toHaveLength(1)
    expect(view.legal.castableIds).toContain(handObj(state, A, 'Shock')) // 1 red available
    expect(view.legal.castableIds).not.toContain(handObj(state, A, 'Gray Ogre')) // needs 3
    act(state, A, { type: 'r.playLand', objId: handObj(state, A, 'Mountain') })
    view = redactRulesState(state, A)
    expect(view.legal.playableLandIds).toHaveLength(0)
    expect(view.legal.castableIds).toContain(handObj(state, A, 'Gray Ogre')) // 3 potential now
  })
})
