import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGameStore } from '../../app/stores/game.ts'
import type { ClientGameState, LogEntry, PlayerState, RedactedCard } from '../../shared/types/game.ts'
import type { GameEventMsg, SyncMsg } from '../../shared/schemas/messages.ts'

function makePlayer(id: string, seat: number): PlayerState {
  return {
    id,
    seat,
    name: id.toUpperCase(),
    life: 40,
    poison: 0,
    counters: {},
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    commanderIds: [],
    commanderTax: {},
    commanderDamage: {},
    mullCount: 0,
    keptHand: false,
    hasConceded: false,
  }
}

function makeCard(id: string, owner = 'p1'): RedactedCard {
  return {
    id,
    catalogId: `cat-${id}`,
    ownerId: owner,
    controllerId: owner,
    zone: { kind: 'battlefield', player: owner },
    x: 0.5,
    y: 0.5,
    tapped: false,
    faceDown: false,
    faceIndex: 0,
    counters: {},
    attachedTo: null,
    isToken: false,
    tokenSpec: null,
    isCommander: false,
    commanderSlot: null,
    revealedTo: null,
    display: {
      name: `Card ${id}`,
      manaCost: '{1}',
      typeLine: 'Artifact',
      oracleText: null,
      power: null,
      toughness: null,
      loyalty: null,
      imageSmall: null,
      imageNormal: null,
      backImageSmall: null,
      backImageNormal: null,
      faces: null,
      canBeCommander: false,
    },
  }
}

function makeState(): ClientGameState {
  return {
    id: 'g1',
    status: 'active',
    you: 'p1',
    players: { p1: makePlayer('p1', 0), p2: makePlayer('p2', 1) },
    cards: { c1: makeCard('c1') },
    zones: {
      perPlayer: {
        p1: { battlefield: ['c1'], graveyard: [], exile: [], command: [], hand: ['h1', 'h2'], library: { count: 90 } },
        p2: { battlefield: [], graveyard: [], exile: [], command: [], hand: { count: 7 }, library: { count: 92 } },
      },
      stack: [],
    },
    turn: { order: ['p1', 'p2'], activePlayer: 'p1', step: 'main1', turnNumber: 1 },
    markers: {},
    peek: null,
    winnerSeat: null,
    seq: 10,
  }
}

function sync(seq = 10, log: LogEntry[] = []): SyncMsg {
  const state = makeState()
  state.seq = seq
  return { t: 'sync', seq, state, log }
}

function event(seq: number, patch: Partial<GameEventMsg> = {}): GameEventMsg {
  return { t: 'event', seq, ts: 1000 + seq, type: 'card.tap', actor: 'p1', ...patch }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => vi.useRealTimers())

describe('applySync', () => {
  it('replaces state and log wholesale and opens the connection', () => {
    const store = useGameStore()
    store.conn = 'resyncing'
    store.log = [{ seq: 1, ts: 1, actor: null, kind: 'system', line: 'stale' }]
    store.applySync(sync(42, [{ seq: 42, ts: 2, actor: 'p1', kind: 'chat.send', line: 'hello' }]))
    expect(store.state?.seq).toBe(42)
    expect(store.lastSeq).toBe(42)
    expect(store.conn).toBe('open')
    expect(store.log).toHaveLength(1)
    expect(store.log[0]!.line).toBe('hello')
  })
})

describe('applyEvent', () => {
  it('upserts cards and deletes removed ids', () => {
    const store = useGameStore()
    store.applySync(sync())
    const c2 = makeCard('c2', 'p2')
    store.applyEvent(event(11, { cards: [c2], removed: ['c1'] }))
    expect(store.state!.cards.c2?.display?.name).toBe('Card c2')
    expect(store.state!.cards.c1).toBeUndefined()
    expect(store.lastSeq).toBe(11)
    expect(store.state!.seq).toBe(11)
  })

  it('applies zone patches: own hand ids, opponent hand count, library count, stack', () => {
    const store = useGameStore()
    store.applySync(sync())
    store.applyEvent(
      event(11, {
        zones: [
          { key: 'p1:hand', ids: ['h1', 'h2', 'h3'] },
          { key: 'p2:hand', count: 6 },
          { key: 'p1:library', count: 89 },
          { key: 'p1:battlefield', ids: ['c1', 'c9'] },
          { key: 'stack', ids: ['s1'] },
        ],
      }),
    )
    const z = store.state!.zones
    expect(z.perPlayer.p1!.hand).toEqual(['h1', 'h2', 'h3'])
    expect(z.perPlayer.p2!.hand).toEqual({ count: 6 })
    expect(z.perPlayer.p1!.library).toEqual({ count: 89 })
    expect(z.perPlayer.p1!.battlefield).toEqual(['c1', 'c9'])
    expect(z.stack).toEqual(['s1'])
  })

  it('merges partial player patches by id without clobbering other fields', () => {
    const store = useGameStore()
    store.applySync(sync())
    store.applyEvent(event(11, { players: [{ id: 'p2', life: 34, poison: 2 }] }))
    expect(store.state!.players.p2!.life).toBe(34)
    expect(store.state!.players.p2!.poison).toBe(2)
    expect(store.state!.players.p2!.name).toBe('P2') // untouched
    expect(store.state!.players.p1!.life).toBe(40)
  })

  it('assigns turn / markers / status / winnerSeat', () => {
    const store = useGameStore()
    store.applySync(sync())
    store.applyEvent(
      event(11, {
        turn: { order: ['p1', 'p2'], activePlayer: 'p2', step: 'upkeep', turnNumber: 2 },
        markers: { monarch: 'p2' },
        status: 'ended',
        winnerSeat: 1,
      }),
    )
    expect(store.state!.turn.activePlayer).toBe('p2')
    expect(store.state!.markers.monarch).toBe('p2')
    expect(store.state!.status).toBe('ended')
    expect(store.state!.winnerSeat).toBe(1)
  })

  it('sets and clears the peek overlay (null clears, absent leaves untouched)', () => {
    const store = useGameStore()
    store.applySync(sync())
    const peek = { mode: 'scry' as const, n: 2, cardIds: ['t1', 't2'], cards: [makeCard('t1'), makeCard('t2')] }
    store.applyEvent(event(11, { peek }))
    expect(store.state!.peek?.mode).toBe('scry')
    store.applyEvent(event(12, {})) // no peek field → untouched
    expect(store.state!.peek?.n).toBe(2)
    store.applyEvent(event(13, { peek: null }))
    expect(store.state!.peek).toBeNull()
  })

  it('appends log lines when present and caps at 500', () => {
    const store = useGameStore()
    store.applySync(sync())
    store.applyEvent(event(11, { log: 'P1 drew 1 card.', type: 'deck.draw' }))
    expect(store.log.at(-1)).toEqual({ seq: 11, ts: 1011, actor: 'p1', kind: 'deck.draw', line: 'P1 drew 1 card.' })
    store.applyEvent(event(12, {})) // no log → nothing appended
    expect(store.log).toHaveLength(1)
    for (let i = 0; i < 600; i++) store.applyEvent(event(13 + i, { log: `line ${i}` }))
    expect(store.log).toHaveLength(500)
    expect(store.log.at(-1)!.line).toBe('line 599')
    expect(store.log[0]!.line).toBe('line 100')
  })

  it('stores event extras for toasts', () => {
    const store = useGameStore()
    store.applySync(sync())
    store.applyEvent(event(11, { type: 'game.roll', extra: { sides: 20, results: [17] } }))
    expect(store.lastExtra).toMatchObject({ seq: 11, type: 'game.roll', extra: { results: [17] } })
  })

  it('detects seq gaps: flags resyncing, sends one throttled resync, ignores events until sync', () => {
    const store = useGameStore()
    const sender = vi.fn()
    store.bindResyncSender(sender)
    store.applySync(sync(10))
    store.applyEvent(event(15, { players: [{ id: 'p1', life: 1 }] })) // gap: expected 11
    expect(store.conn).toBe('resyncing')
    expect(sender).toHaveBeenCalledTimes(1)
    expect(store.state!.players.p1!.life).toBe(40) // gap event NOT applied

    // further events are ignored and do not spam resync within 5 s
    store.applyEvent(event(16, { players: [{ id: 'p1', life: 2 }] }))
    expect(store.state!.players.p1!.life).toBe(40)
    expect(sender).toHaveBeenCalledTimes(1)

    // after the throttle window, a still-broken stream re-requests
    vi.setSystemTime(1_000_000 + 5001)
    store.applyEvent(event(17, {}))
    expect(sender).toHaveBeenCalledTimes(2)

    // sync recovers everything
    store.applySync(sync(20))
    expect(store.conn).toBe('open')
    store.applyEvent(event(21, { players: [{ id: 'p1', life: 39 }] }))
    expect(store.state!.players.p1!.life).toBe(39)
  })

  it('treats duplicate/older seq as a gap too', () => {
    const store = useGameStore()
    const sender = vi.fn()
    store.bindResyncSender(sender)
    store.applySync(sync(10))
    store.applyEvent(event(10, {}))
    expect(store.conn).toBe('resyncing')
    expect(sender).toHaveBeenCalledTimes(1)
  })
})

describe('applyEphemeral', () => {
  it('card.position patches x/y', () => {
    const store = useGameStore()
    store.applySync(sync())
    store.applyEphemeral({ t: 'ephemeral', type: 'card.position', actor: 'p1', payload: { cardId: 'c1', x: 0.1, y: 0.9 } })
    expect(store.state!.cards.c1!.x).toBe(0.1)
    expect(store.state!.cards.c1!.y).toBe(0.9)
    // unknown card → no crash
    store.applyEphemeral({ t: 'ephemeral', type: 'card.position', actor: 'p1', payload: { cardId: 'nope', x: 0, y: 0 } })
  })

  it('card.arrow adds, dedupes and removes; arrows.clear empties', () => {
    const store = useGameStore()
    store.applySync(sync())
    const arrow = { fromCardId: 'c1', toCardId: 'c2', toPlayerId: null, on: true }
    store.applyEphemeral({ t: 'ephemeral', type: 'card.arrow', actor: 'p1', payload: arrow })
    store.applyEphemeral({ t: 'ephemeral', type: 'card.arrow', actor: 'p1', payload: arrow }) // duplicate
    expect(store.arrows).toHaveLength(1)
    expect(store.arrows[0]).toEqual({ fromCardId: 'c1', toCardId: 'c2', toPlayerId: null, actor: 'p1' })

    store.applyEphemeral({ t: 'ephemeral', type: 'card.arrow', actor: 'p2', payload: { fromCardId: 'c1', toPlayerId: 'p1', on: true } })
    expect(store.arrows).toHaveLength(2)
    expect(store.arrows[1]).toMatchObject({ toCardId: null, toPlayerId: 'p1', actor: 'p2' })

    store.applyEphemeral({ t: 'ephemeral', type: 'card.arrow', actor: 'p1', payload: { ...arrow, on: false } })
    expect(store.arrows).toHaveLength(1)

    store.applyEphemeral({ t: 'ephemeral', type: 'arrows.clear', actor: 'p1', payload: {} })
    expect(store.arrows).toEqual([])
  })
})

describe('presence & reset', () => {
  it('tracks presence and resets cleanly', () => {
    const store = useGameStore()
    store.applySync(sync())
    store.setPresence(['p1', 'p2'])
    expect(store.connectedPlayers).toEqual(['p1', 'p2'])
    store.reset()
    expect(store.state).toBeNull()
    expect(store.conn).toBe('connecting')
    expect(store.log).toEqual([])
  })
})
