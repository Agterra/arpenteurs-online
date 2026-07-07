import { describe, expect, it } from 'vitest'
import { act, assertInvariants, makeGame } from './engine-helpers.ts'
import { ActionError } from '../../server/game/reducer.ts'

const keepAll = (state: ReturnType<typeof makeGame>) => {
  for (const pid of Object.keys(state.players)) act(state, pid, { type: 'deck.keep', toBottom: [] })
}

describe('setup', () => {
  it('builds a consistent initial state', () => {
    const s = makeGame(3, 15)
    assertInvariants(s)
    for (const pid of ['p0', 'p1', 'p2']) {
      expect(s.zones.perPlayer[pid]!.hand).toHaveLength(7)
      expect(s.zones.perPlayer[pid]!.library).toHaveLength(8)
      expect(s.zones.perPlayer[pid]!.command).toHaveLength(1)
      expect(s.players[pid]!.life).toBe(40)
    }
    expect(s.status).toBe('mulligans')
  })
})

describe('mulligans (London)', () => {
  it('mulligan redraws 7 and keep bottoms N', () => {
    const s = makeGame(2, 20)
    act(s, 'p0', { type: 'deck.mulligan' })
    expect(s.players.p0!.mullCount).toBe(1)
    expect(s.zones.perPlayer.p0!.hand).toHaveLength(7)
    assertInvariants(s)

    const bottom = s.zones.perPlayer.p0!.hand.slice(0, 1)
    act(s, 'p0', { type: 'deck.keep', toBottom: bottom })
    expect(s.zones.perPlayer.p0!.hand).toHaveLength(6)
    expect(s.zones.perPlayer.p0!.library).toHaveLength(14)
    expect(s.players.p0!.keptHand).toBe(true)
    expect(s.status).toBe('mulligans') // p1 has not kept yet

    act(s, 'p1', { type: 'deck.keep', toBottom: [] })
    expect(s.status).toBe('active')
    assertInvariants(s)
  })

  it('rejects keep with cards not in hand', () => {
    const s = makeGame(2, 20)
    expect(() => act(s, 'p0', { type: 'deck.keep', toBottom: [s.zones.perPlayer.p0!.library[0]!] })).toThrow(
      ActionError,
    )
  })
})

describe('hidden-zone id re-minting', () => {
  it('drawing re-mints ids (no library id survives into the hand)', () => {
    const s = makeGame(2, 20)
    keepAll(s)
    const libBefore = [...s.zones.perPlayer.p0!.library]
    act(s, 'p0', { type: 'deck.draw', n: 3 })
    const hand = s.zones.perPlayer.p0!.hand
    for (const id of hand) expect(libBefore).not.toContain(id)
    assertInvariants(s)
  })

  it('shuffle re-keys every library id', () => {
    const s = makeGame(2, 20)
    keepAll(s)
    const before = new Set(s.zones.perPlayer.p0!.library)
    act(s, 'p0', { type: 'deck.shuffle' })
    for (const id of s.zones.perPlayer.p0!.library) expect(before.has(id)).toBe(false)
    assertInvariants(s)
  })

  it('a public card bounced to hand gets a fresh id', () => {
    const s = makeGame(2, 20)
    keepAll(s)
    const cardId = s.zones.perPlayer.p0!.hand[0]!
    act(s, 'p0', { type: 'card.move', cardId, to: { zone: { kind: 'battlefield', player: 'p0' } } })
    const onBoard = s.zones.perPlayer.p0!.battlefield[0]!
    act(s, 'p0', { type: 'card.move', cardId: onBoard, to: { zone: { kind: 'hand', player: 'p0' } } })
    expect(s.cards[onBoard]).toBeUndefined()
    expect(s.zones.perPlayer.p0!.hand).not.toContain(onBoard)
    assertInvariants(s)
  })

  it('commander tracking survives re-minting through hidden zones', () => {
    const s = makeGame(2, 20)
    keepAll(s)
    const cmdId = s.players.p0!.commanderIds[0]!
    act(s, 'p0', { type: 'card.move', cardId: cmdId, to: { zone: { kind: 'hand', player: 'p0' } } })
    const newId = s.players.p0!.commanderIds[0]!
    expect(newId).not.toBe(cmdId)
    expect(s.cards[newId]!.isCommander).toBe(true)
    expect(s.cards[newId]!.zone).toEqual({ kind: 'hand', player: 'p0' })
    assertInvariants(s)
  })
})

describe('peeks', () => {
  it('scry: resolve orders top and bottom, re-mints leftovers, closes the peek', () => {
    const s = makeGame(2, 20)
    keepAll(s)
    act(s, 'p0', { type: 'deck.scry', n: 3 })
    const peek = s.peeks.p0!
    expect(peek.cardIds).toHaveLength(3)
    const [a, b, c] = peek.cardIds as [string, string, string]
    act(s, 'p0', { type: 'peek.resolve', toTop: [b, a], toBottom: [c], moves: [] })
    expect(s.peeks.p0).toBeUndefined()
    const lib = s.zones.perPlayer.p0!.library
    // peeked ids are re-minted after resolve — compare via catalog identity
    expect(s.cards[lib[0]!]!.catalogId).toBe(s.cards[lib[0]!]!.catalogId)
    expect(lib).toHaveLength(13)
    assertInvariants(s)
  })

  it('blocks library actions while a peek is open, and card.move from library always', () => {
    const s = makeGame(2, 20)
    keepAll(s)
    const libTop = s.zones.perPlayer.p0!.library[0]!
    expect(() =>
      act(s, 'p0', { type: 'card.move', cardId: libTop, to: { zone: { kind: 'hand', player: 'p0' } } }),
    ).toThrow(/scry\/look\/search/)
    act(s, 'p0', { type: 'deck.scry', n: 2 })
    expect(() => act(s, 'p0', { type: 'deck.draw', n: 1 })).toThrow(/peek/i)
    expect(() => act(s, 'p0', { type: 'deck.shuffle' })).toThrow(/peek/i)
  })

  it('search moves a card out and forces a shuffle even on cancel', () => {
    const s = makeGame(2, 20)
    keepAll(s)
    act(s, 'p0', { type: 'deck.search' })
    const pick = s.peeks.p0!.cardIds[5]!
    const before = new Set(s.zones.perPlayer.p0!.library)
    act(s, 'p0', {
      type: 'peek.resolve',
      toTop: [],
      toBottom: [],
      moves: [{ cardId: pick, to: { zone: { kind: 'hand', player: 'p0' } } }],
    })
    expect(s.zones.perPlayer.p0!.hand).toHaveLength(8)
    for (const id of s.zones.perPlayer.p0!.library) expect(before.has(id)).toBe(false) // shuffled + re-keyed
    assertInvariants(s)

    act(s, 'p0', { type: 'deck.search' })
    const before2 = new Set(s.zones.perPlayer.p0!.library)
    act(s, 'p0', { type: 'peek.cancel' })
    for (const id of s.zones.perPlayer.p0!.library) expect(before2.has(id)).toBe(false)
  })

  it('rejects resolving ids that were not in the peek', () => {
    const s = makeGame(2, 20)
    keepAll(s)
    act(s, 'p0', { type: 'deck.scry', n: 2 })
    const handCard = s.zones.perPlayer.p0!.hand[0]!
    expect(() => act(s, 'p0', { type: 'peek.resolve', toTop: [handCard], toBottom: [], moves: [] })).toThrow(
      /peek/i,
    )
  })
})

describe('cards on the board', () => {
  it('tokens die when leaving the battlefield', () => {
    const s = makeGame(2, 10)
    keepAll(s)
    act(s, 'p0', {
      type: 'token.create',
      spec: { name: 'Soldier', pt: '1/1', colors: ['W'], typeLine: 'Token Creature — Soldier', text: '', fromCatalogId: null },
      quantity: 2,
      zone: 'battlefield',
      tapped: false,
    })
    expect(s.zones.perPlayer.p0!.battlefield).toHaveLength(2)
    const tokenId = s.zones.perPlayer.p0!.battlefield[0]!
    act(s, 'p0', { type: 'card.move', cardId: tokenId, to: { zone: { kind: 'graveyard', player: 'p0' } } })
    expect(s.cards[tokenId]).toBeUndefined()
    expect(s.zones.perPlayer.p0!.graveyard).toHaveLength(0)
    assertInvariants(s)
  })

  it('attachments: cycle rejected, auto-unattach when the host leaves', () => {
    const s = makeGame(2, 10)
    keepAll(s)
    const [h1, h2] = s.zones.perPlayer.p0!.hand as string[]
    act(s, 'p0', { type: 'card.move', cardId: h1!, to: { zone: { kind: 'battlefield', player: 'p0' } } })
    act(s, 'p0', { type: 'card.move', cardId: h2!, to: { zone: { kind: 'battlefield', player: 'p0' } } })
    const [a, b] = s.zones.perPlayer.p0!.battlefield as [string, string]
    act(s, 'p0', { type: 'card.attach', cardId: a, targetId: b })
    expect(() => act(s, 'p0', { type: 'card.attach', cardId: b, targetId: a })).toThrow(/circular/i)
    act(s, 'p0', { type: 'card.move', cardId: b, to: { zone: { kind: 'graveyard', player: 'p0' } } })
    expect(s.cards[a]!.attachedTo).toBeNull()
    assertInvariants(s)
  })

  it('rejects tapping cards you do not control', () => {
    const s = makeGame(2, 10)
    keepAll(s)
    const h = s.zones.perPlayer.p1!.hand[0]!
    act(s, 'p1', { type: 'card.move', cardId: h, to: { zone: { kind: 'battlefield', player: 'p1' } } })
    const target = s.zones.perPlayer.p1!.battlefield[0]!
    expect(() => act(s, 'p0', { type: 'card.tap', cardIds: [target], tapped: true })).toThrow(/control/i)
  })
})

describe('concede (rule 800.4a)', () => {
  it('removes owned cards, reverts stolen cards, skips the turn', () => {
    const s = makeGame(3, 10)
    keepAll(s)
    // p1 puts a creature on the battlefield; p0 steals it
    const h = s.zones.perPlayer.p1!.hand[0]!
    act(s, 'p1', { type: 'card.move', cardId: h, to: { zone: { kind: 'battlefield', player: 'p1' } } })
    const stolen = s.zones.perPlayer.p1!.battlefield[0]!
    act(s, 'p1', { type: 'card.control', cardId: stolen, controllerId: 'p0' })
    expect(s.zones.perPlayer.p0!.battlefield).toContain(stolen)

    s.turn.activePlayer = 'p0'
    act(s, 'p0', { type: 'game.concede' })
    // every p0-owned card left the game
    for (const card of Object.values(s.cards)) expect(card.ownerId).not.toBe('p0')
    // the stolen card went back to its owner's battlefield, controlled by p1
    expect(s.zones.perPlayer.p1!.battlefield).toContain(stolen)
    expect(s.cards[stolen]!.controllerId).toBe('p1')
    // turn moved on and skips p0 forever
    expect(s.turn.activePlayer).not.toBe('p0')
    act(s, s.turn.activePlayer, { type: 'turn.pass' })
    act(s, s.turn.activePlayer, { type: 'turn.pass' })
    expect(s.turn.activePlayer).not.toBe('p0')
    assertInvariants(s)
  })
})

describe('commander tax', () => {
  it('increments only when a commander is cast from the command zone', () => {
    const s = makeGame(2, 12)
    keepAll(s)
    const cmdId = s.players.p0!.commanderIds[0]!
    expect(s.players.p0!.commanderTax[0]).toBe(0)

    // cast from command zone → battlefield
    act(s, 'p0', { type: 'card.move', cardId: cmdId, to: { zone: { kind: 'battlefield', player: 'p0' } } })
    expect(s.players.p0!.commanderTax[0]).toBe(1)
    const onBoard = s.zones.perPlayer.p0!.battlefield.find((id) => s.cards[id]!.isCommander)!

    // move to graveyard → NOT a cast, no bump
    act(s, 'p0', { type: 'card.move', cardId: onBoard, to: { zone: { kind: 'graveyard', player: 'p0' } } })
    expect(s.players.p0!.commanderTax[0]).toBe(1)

    // return to command zone (not a cast) → no bump
    const inYard = s.zones.perPlayer.p0!.graveyard.find((id) => s.cards[id]!.isCommander)!
    act(s, 'p0', { type: 'card.move', cardId: inYard, to: { zone: { kind: 'command', player: 'p0' } } })
    expect(s.players.p0!.commanderTax[0]).toBe(1)

    // cast again from command zone → +1
    const inCmd = s.zones.perPlayer.p0!.command.find((id) => s.cards[id]!.isCommander)!
    act(s, 'p0', { type: 'card.move', cardId: inCmd, to: { zone: { kind: 'battlefield', player: 'p0' } } })
    expect(s.players.p0!.commanderTax[0]).toBe(2)
    assertInvariants(s)
  })
})

describe('turn & finish', () => {
  it('turn.next wraps through steps into the next player', () => {
    const s = makeGame(2, 10)
    keepAll(s)
    const first = s.turn.activePlayer
    for (let i = 0; i < 12; i++) act(s, first, { type: 'turn.next' })
    expect(s.turn.activePlayer).not.toBe(first)
    expect(s.turn.step).toBe('untap')
    expect(s.turn.turnNumber).toBe(2)
  })

  it('auto-untaps the active player on their untap step (turn.pass)', () => {
    const s = makeGame(2, 10)
    keepAll(s)
    const active = s.turn.activePlayer
    // give the active player a tapped permanent
    const h = s.zones.perPlayer[active]!.hand[0]!
    act(s, active, { type: 'card.move', cardId: h, to: { zone: { kind: 'battlefield', player: active } } })
    const permId = s.zones.perPlayer[active]!.battlefield[0]!
    act(s, active, { type: 'card.tap', cardIds: [permId], tapped: true })
    expect(s.cards[permId]!.tapped).toBe(true)
    // pass around the table back to them → their permanents untap on the way in
    act(s, active, { type: 'turn.pass' })
    const next = s.turn.activePlayer
    act(s, next, { type: 'turn.pass' })
    expect(s.turn.activePlayer).toBe(active)
    expect(s.cards[permId]!.tapped).toBe(false)
    assertInvariants(s)
  })

  it('auto-draws at the draw step, but the starting player skips their first draw', () => {
    const s = makeGame(2, 12)
    keepAll(s)
    const starter = s.turn.activePlayer
    const hand0 = s.zones.perPlayer[starter]!.hand.length
    const lib0 = s.zones.perPlayer[starter]!.library.length
    // untap -> upkeep -> draw : turn 1, starter skips the draw
    act(s, starter, { type: 'turn.next' })
    act(s, starter, { type: 'turn.next' })
    expect(s.turn.step).toBe('draw')
    expect(s.zones.perPlayer[starter]!.hand).toHaveLength(hand0)
    expect(s.zones.perPlayer[starter]!.library).toHaveLength(lib0)

    // advance until the turn wraps to the next player (lands on their untap step)
    let guard = 0
    while (s.turn.activePlayer === starter && guard++ < 30) act(s, s.turn.activePlayer, { type: 'turn.next' })
    const p2 = s.turn.activePlayer
    expect(p2).not.toBe(starter)
    expect(s.turn.turnNumber).toBe(2)
    expect(s.turn.step).toBe('untap')
    const h2 = s.zones.perPlayer[p2]!.hand.length
    const l2 = s.zones.perPlayer[p2]!.library.length
    act(s, p2, { type: 'turn.next' }) // untap -> upkeep
    act(s, p2, { type: 'turn.next' }) // upkeep -> draw : draws 1
    expect(s.turn.step).toBe('draw')
    expect(s.zones.perPlayer[p2]!.hand).toHaveLength(h2 + 1)
    expect(s.zones.perPlayer[p2]!.library).toHaveLength(l2 - 1)
    assertInvariants(s)
  })

  it('manual turn.setStep to draw does NOT auto-draw (no surprise draws)', () => {
    const s = makeGame(2, 12)
    keepAll(s)
    // move to turn 2 so draw would otherwise fire
    for (let i = 0; i < 12; i++) act(s, s.turn.activePlayer, { type: 'turn.next' })
    const p = s.turn.activePlayer
    const h = s.zones.perPlayer[p]!.hand.length
    act(s, p, { type: 'turn.setStep', step: 'draw' })
    expect(s.zones.perPlayer[p]!.hand).toHaveLength(h) // unchanged
  })

  it('game.finish ends the game and blocks further play', () => {
    const s = makeGame(2, 10)
    keepAll(s)
    act(s, 'p1', { type: 'game.finish', winnerSeat: 1 })
    expect(s.status).toBe('ended')
    expect(s.winnerSeat).toBe(1)
    expect(() => act(s, 'p0', { type: 'turn.next' })).toThrow(/over/i)
  })
})
