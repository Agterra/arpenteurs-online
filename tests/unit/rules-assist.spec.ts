import { describe, expect, it } from 'vitest'
import { buildFallbackDef, parseTypeLine } from '../../server/rules/cards/fallback.ts'
import { isImplemented, unimplementedNames } from '../../server/rules/cards/registry.ts'
import { checkSBA } from '../../server/rules/engine.ts'
import { redactRulesState } from '../../server/rules/redact.ts'
import { act, fieldObj, handObj, makeDuel, makeGameN, pass, playLandAndTap, putFallback, rig, toStep, until } from './rules-helpers.ts'
import { defKey } from '../../server/rules/cards/registry.ts'

describe('fallback definitions (assisted table)', () => {
  it('parses a legendary creature type line', () => {
    expect(parseTypeLine('Legendary Creature — Angel Horror')).toEqual({
      types: ['Creature'],
      supertypes: ['Legendary'],
      subtypes: ['Angel', 'Horror'],
    })
  })

  it('builds an unimplemented body with P/T + mana cost from the catalog', () => {
    const def = buildFallbackDef({
      name: 'Mystery Beast',
      typeLine: 'Creature — Angel',
      manaCost: '{3}{W}{W}',
      power: '4',
      toughness: '4',
      oracleText: 'Flying, vigilance',
    })
    expect(def.unimplemented).toBe(true)
    expect(def.power).toBe(4)
    expect(def.toughness).toBe(4)
    expect(def.manaCost).toBe('{3}{W}{W}')
    expect(def.abilities).toBeUndefined() // no coded abilities
  })

  it('leaves */X power-toughness unknown (undefined)', () => {
    const def = buildFallbackDef({ name: 'Tarmogoyf', typeLine: 'Creature — Lhurgoyf', power: '*', toughness: '1+*' })
    expect(def.power).toBeUndefined()
    expect(def.toughness).toBeUndefined()
  })

  it('gives a fixed mana source a one-click ability, but not a choice/any-colour one', () => {
    const rock = buildFallbackDef({ name: 'Mind Stone', typeLine: 'Artifact', oracleText: '{T}: Add {C}.' })
    expect(rock.abilities?.[0]).toMatchObject({ isMana: true, produces: ['C'] })
    const anyLand = buildFallbackDef({ name: 'Command Tower', typeLine: 'Land', oracleText: '{T}: Add one mana of any color.' })
    expect(anyLand.abilities).toBeUndefined() // player uses the manual mana override
  })

  it('registry: fallbacks do not count as implemented; unimplementedNames flags real gaps', () => {
    expect(isImplemented('Mountain')).toBe(true)
    expect(isImplemented('Mystery Beast')).toBe(false) // even after being registered as a fallback earlier
    expect(unimplementedNames(['Mountain', 'Mystery Beast'])).toEqual(['Mystery Beast'])
  })
})

describe('unimplemented cards in play', () => {
  it('never auto-dies to lethal damage (SBA skips it); an implemented creature still dies', () => {
    const { state, A } = makeDuel()
    const serra = putFallback(state, A, { name: 'Mystery Beast', typeLine: 'Creature — Angel', power: '4', toughness: '4' })
    rig(state, A, { battlefield: ['Grizzly Bears'] }) // rig keeps the fallback (only re-deals starter-owned cards)? see note
    // rig re-deals owned non-commander cards; re-add the fallback since rig cleared it
    const serra2 = putFallback(state, A, { name: 'Mystery Beast', typeLine: 'Creature — Angel', power: '4', toughness: '4' })
    state.objects[serra2]!.damageMarked = 99
    const bears = fieldObj(state, A, 'Grizzly Bears')
    state.objects[bears]!.damageMarked = 99
    checkSBA(state)
    expect(state.objects[serra2]!.zone).toBe('battlefield') // unimplemented survives lethal
    expect(state.objects[bears]!.zone).toBe('graveyard') // implemented 2/2 dies (moves to graveyard)
    void serra
  })

  it('an unimplemented spell resolves with no effect and goes to the graveyard', () => {
    const { state, A, B } = makeDuel()
    rig(state, A, { battlefield: ['Mountain', 'Mountain', 'Mountain'] }) // RRR pays {2}{R}
    // NOTE: this must name a card the engine does NOT implement — the point is the assisted-table
    // fallback path. It used to be Chaos Warp, which batch CARD20 implemented (the implemented def
    // then demanded its target and this test failed loudly, which is the guard working).
    const unimplemented = putFallback(
      state,
      A,
      { name: 'Insurrection', typeLine: 'Sorcery', manaCost: '{2}{R}', oracleText: 'Untap all creatures and gain control of them…' },
      'hand',
    )
    toStep(state, 'main1')
    for (const id of [...state.zones.perPlayer[A]!.battlefield]) act(state, A, { type: 'r.tapMana', objId: id })
    const lifeB = state.players[B]!.life
    act(state, A, { type: 'r.cast', objId: unimplemented, targets: [] }) // no targets for a fallback
    until(state, (s) => !s.zones.stack.length, 'resolution')
    expect(state.zones.perPlayer[A]!.graveyard).toContain(unimplemented) // resolved to graveyard
    expect(state.players[B]!.life).toBe(lifeB) // did nothing automatically
  })

  it('a nonbasic mana source with a fixed ability taps for the right mana', () => {
    const { state, A } = makeDuel()
    const stone = putFallback(state, A, { name: 'Mind Stone', typeLine: 'Artifact', oracleText: '{T}: Add {C}.' })
    toStep(state, 'main1')
    act(state, A, { type: 'r.tapMana', objId: stone })
    expect(state.players[A]!.manaPool.C).toBe(1)
    expect(state.objects[stone]!.tapped).toBe(true)
  })
})

describe('manual overrides', () => {
  it('mLife / mMana adjust your own totals', () => {
    const { state, A } = makeDuel()
    act(state, A, { type: 'r.mLife', delta: -5 })
    expect(state.players[A]!.life).toBe(35)
    act(state, A, { type: 'r.mMana', color: 'G', delta: 3 })
    expect(state.players[A]!.manaPool.G).toBe(3)
    act(state, A, { type: 'r.mMana', color: 'G', delta: -10 })
    expect(state.players[A]!.manaPool.G).toBe(0) // clamped
  })

  it('mDraw pulls from the top of your own library', () => {
    const { state, A } = makeDuel()
    const before = state.zones.perPlayer[A]!.hand.length
    const lib0 = state.zones.perPlayer[A]!.library.length
    act(state, A, { type: 'r.mDraw', n: 2 })
    expect(state.zones.perPlayer[A]!.hand.length).toBe(before + 2)
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 - 2)
  })

  it('mMove relocates your visible cards but refuses library-by-hand and others’ cards', () => {
    const { state, A, B } = makeDuel()
    const serra = putFallback(state, A, { name: 'Mystery Beast', typeLine: 'Creature — Angel', power: '4', toughness: '4' })
    act(state, A, { type: 'r.mMove', objId: serra, zone: 'graveyard' })
    expect(state.zones.perPlayer[A]!.graveyard).toContain(serra)
    // can't hand-move from the library (order is secret)
    const libId = state.zones.perPlayer[A]!.library[0]!
    expect(() => act(state, A, { type: 'r.mMove', objId: libId, zone: 'hand' })).toThrow(/Draw/)
    // can't move an opponent's card
    const bSerra = putFallback(state, B, { name: 'Mystery Beast', typeLine: 'Creature — Angel', power: '4', toughness: '4' })
    expect(() => act(state, A, { type: 'r.mMove', objId: bSerra, zone: 'graveyard' })).toThrow(/Not your/)
  })

  it('mToken creates a battlefield token; mTap/mCounter edit your permanents', () => {
    const { state, A } = makeDuel()
    act(state, A, { type: 'r.mToken', name: 'Soldier', power: 1, toughness: 1, typeLine: 'Token Creature — Soldier' })
    const bf = state.zones.perPlayer[A]!.battlefield
    expect(bf.length).toBe(1)
    const tok = bf[0]!
    act(state, A, { type: 'r.mTap', objId: tok, tapped: true })
    expect(state.objects[tok]!.tapped).toBe(true)
    act(state, A, { type: 'r.mCounter', objId: tok, name: '+1/+1', delta: 2 })
    expect(state.objects[tok]!.counters['+1/+1']).toBe(2)
  })

  it('mLife to 0 loses via SBA', () => {
    const { state, A, B } = makeDuel()
    act(state, B, { type: 'r.mLife', delta: -40 })
    until(state, (s) => s.status === 'ended', 'loss')
    expect(state.winner).toBe(A)
  })
})

describe('assisted-table hidden information', () => {
  it('an unimplemented card in hand is still hidden from opponents; on battlefield it is public', () => {
    const { state, A, B } = makeDuel()
    const inHand = putFallback(state, A, { name: 'Mystery Beast', typeLine: 'Creature — Angel', power: '4', toughness: '4' }, 'hand')
    const onField = putFallback(state, A, { name: 'Grizzly Bears fake', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
    const view = redactRulesState(state, B)
    const json = JSON.stringify(view)
    expect(json.includes(inHand)).toBe(false) // opponent's hand id never serialized
    expect(view.cards[onField]?.unimplemented).toBe(true) // public battlefield card visible + flagged
  })

  it('re-mints a card id when a public card is moved by hand into a hidden zone (invariant #3)', () => {
    const { state, A, B } = makeDuel()
    const bearId = putFallback(state, A, { name: 'Public Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' })
    expect(redactRulesState(state, B).cards[bearId]).toBeTruthy() // B sees it on the battlefield
    act(state, A, { type: 'r.mMove', objId: bearId, zone: 'hand' })
    expect(state.objects[bearId]).toBeUndefined() // old (public) id retired
    const newId = state.zones.perPlayer[A]!.hand.find((id) => state.objects[id]?.defName === defKey('Public Bear'))
    expect(newId).toBeTruthy()
    expect(newId).not.toBe(bearId) // re-minted
    const jsonB = JSON.stringify(redactRulesState(state, B))
    expect(jsonB.includes(bearId)).toBe(false) // B can't track the old id
    expect(jsonB.includes(newId!)).toBe(false) // and the new hand id is hidden from B
  })
})

describe('assisted-table control-flow safety', () => {
  it('a player who loses via a manual override while holding priority does not wedge a 3-player game', () => {
    const { state, players } = makeGameN(3)
    const [A, B] = players
    toStep(state, 'main1') // A has priority, empty stack
    pass(state, A) // priority passes to B (APNAP, not everyone has passed)
    expect(state.priorityPlayer).toBe(B)
    act(state, B, { type: 'r.mLife', delta: -40 }) // B kills themselves mid-priority-round
    expect(state.players[B]!.hasLost).toBe(true)
    expect(state.status).toBe('active') // A and C remain
    expect(state.pending).toBeNull()
    expect(state.priorityPlayer).toBeTruthy()
    expect(state.players[state.priorityPlayer!]!.hasLost).toBe(false) // handed to a live player
    // and the game keeps progressing rather than stalling on the departed player
    const step0 = state.step
    until(state, (s) => s.step !== step0 || s.turnNumber > 1, 'progress past the stuck point')
  })

  it('the active player self-eliminating during their declare-attackers step is not a wedge', () => {
    const { state } = makeGameN(3)
    const A = state.activePlayer
    rig(state, A, { battlefield: ['Grizzly Bears'] }) // an eligible attacker → attackers pending fires
    // step to A's declare-attackers pending WITHOUT auto-answering it (until() would)
    for (let i = 0; i < 300 && state.pending?.kind !== 'attackers'; i++) {
      if (state.priorityPlayer) pass(state, state.priorityPlayer)
      else break
    }
    expect(state.pending).toEqual({ kind: 'attackers', player: A })
    act(state, A, { type: 'r.mLife', delta: -40 }) // active player leaves while owing attackers
    expect(state.players[A]!.hasLost).toBe(true)
    expect(state.status).toBe('active') // two players remain
    expect(state.pending).toBeNull() // attackers decision dissolved, not left dangling
  })
})
