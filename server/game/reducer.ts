/**
 * Pure-ish game reducer: mutates ServerGameState in place, returns a change
 * descriptor consumed by events.ts to build per-viewer redacted events.
 * NO MTG rules here — only structural legality (card exists, actor may touch
 * it, zones stay consistent) + the hidden-info invariants from PLAN §4:
 *  - fresh instance id whenever a card enters a hidden zone; full re-key on shuffle
 *  - card.move out of a library is always rejected (peeks are the only path)
 *  - while a peek is open, the owner's other library-touching actions are rejected
 *  - conceding removes all cards the player owns; control of others' reverts
 */
import type {
  CardId,
  CardInstance,
  PlayerId,
  ServerGameState,
  Step,
  TokenSpec,
  ZoneKind,
  ZoneRef,
} from '#shared/types/game'
import { STEPS, commanderKey, zoneKey } from '#shared/types/game'
import type { ClientMsgT } from '#shared/schemas/messages'
import { flipCoin, mintCardId, rollDie, shuffleInPlace } from './rng'

export class ActionError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface ActionResult {
  /** mutated/created card ids (deleted ids surface via the visibility diff) */
  changed: CardId[]
  /** zone keys whose order/count changed */
  zones: string[]
  /** players whose PlayerState changed */
  players: PlayerId[]
  turn?: boolean
  markers?: boolean
  status?: boolean
  /** actor's peek changed (opened/updated/closed) */
  peek?: boolean
  /** public extras for the event (dice results, revealed displays…) */
  extra?: Record<string, unknown>
  /** structured data for log rendering (see events.ts) */
  log?: Record<string, unknown>
}

// ---------- zone helpers ----------

function zoneArr(state: ServerGameState, z: ZoneRef): CardId[] {
  return z.kind === 'stack' ? state.zones.stack : state.zones.perPlayer[z.player]![z.kind]
}

function pullFromZone(state: ServerGameState, card: CardInstance) {
  const arr = zoneArr(state, card.zone)
  const i = arr.indexOf(card.id)
  if (i >= 0) arr.splice(i, 1)
}

const HIDDEN_ON_ENTER: ReadonlySet<ZoneKind | 'stack'> = new Set(['hand', 'library'])

function entersHidden(to: ZoneRef, faceDown: boolean): boolean {
  if (to.kind === 'stack') return false
  if (HIDDEN_ON_ENTER.has(to.kind)) return true
  return to.kind === 'exile' && faceDown
}

/** Re-mint a card's instance id, fixing every reference. */
function remintId(state: ServerGameState, card: CardInstance): CardInstance {
  const oldId = card.id
  const newId = mintCardId()
  delete state.cards[oldId]
  card.id = newId
  card.revealedTo = null
  state.cards[newId] = card
  const arr = zoneArr(state, card.zone)
  const i = arr.indexOf(oldId)
  if (i >= 0) arr[i] = newId
  for (const other of Object.values(state.cards)) {
    if (other.attachedTo === oldId) other.attachedTo = newId
  }
  if (card.isCommander && card.commanderSlot != null) {
    const owner = state.players[card.ownerId]
    if (owner) owner.commanderIds[card.commanderSlot] = newId
  }
  for (const peek of Object.values(state.peeks)) {
    if (!peek) continue
    const pi = peek.cardIds.indexOf(oldId)
    if (pi >= 0) peek.cardIds[pi] = newId
  }
  return card
}

interface MoveOpts {
  index?: number | 'top' | 'bottom'
  faceDown?: boolean
  x?: number
  y?: number
}

/**
 * Universal mover. Returns affected zone keys. Handles: attachment cleanup,
 * token deletion, untap on zone change, fresh ids into hidden zones.
 */
export function moveCard(
  state: ServerGameState,
  card: CardInstance,
  to: ZoneRef,
  opts: MoveOpts = {},
): { zones: string[]; changed: CardId[]; deleted: boolean } {
  const fromKey = zoneKey(card.zone)
  const changed: CardId[] = []
  const wasOnBoard = card.zone.kind === 'battlefield' || card.zone.kind === 'stack'

  // attachments: leaving the battlefield auto-unattaches both directions
  if (card.zone.kind === 'battlefield' && to.kind !== 'battlefield') {
    for (const other of Object.values(state.cards)) {
      if (other.attachedTo === card.id) {
        other.attachedTo = null
        changed.push(other.id)
      }
    }
  }
  if (to.kind !== 'battlefield') card.attachedTo = null

  pullFromZone(state, card)

  // tokens cease to exist when leaving battlefield/stack
  const stillOnBoard = to.kind === 'battlefield' || to.kind === 'stack'
  if (card.isToken && wasOnBoard && !stillOnBoard) {
    delete state.cards[card.id]
    return { zones: [fromKey], changed, deleted: true }
  }

  const faceDown = opts.faceDown ?? (to.kind === 'library' || to.kind === 'hand' ? false : card.faceDown)
  card.zone = to
  card.tapped = to.kind === 'battlefield' ? card.tapped : false
  card.faceDown = to.kind === 'battlefield' || to.kind === 'exile' || to.kind === 'stack' ? faceDown : false
  if (to.kind !== 'battlefield') {
    card.x = 0
    card.y = 0
  } else {
    if (opts.x != null) card.x = opts.x
    if (opts.y != null) card.y = opts.y
  }
  if (to.kind === 'library' || to.kind === 'hand') card.counters = {}

  if (entersHidden(to, card.faceDown)) remintId(state, card)

  const arr = zoneArr(state, to)
  const index =
    opts.index === 'top' ? 0 : opts.index === 'bottom' ? arr.length : (opts.index ?? arr.length)
  arr.splice(Math.min(index, arr.length), 0, card.id)
  changed.push(card.id)
  return { zones: [fromKey, zoneKey(to)], changed, deleted: false }
}

// ---------- guards ----------

function requireCard(state: ServerGameState, id: CardId): CardInstance {
  const card = state.cards[id]
  if (!card) throw new ActionError('NO_CARD', 'Card not found')
  return card
}

function requirePlayer(state: ServerGameState, id: PlayerId) {
  const p = state.players[id]
  if (!p) throw new ActionError('NO_PLAYER', 'Player not found')
  return p
}

function assertNoPeek(state: ServerGameState, actor: PlayerId) {
  if (state.peeks[actor]) throw new ActionError('PEEK_OPEN', 'Resolve or cancel your peek first')
}

function assertActive(state: ServerGameState) {
  if (state.status === 'ended') throw new ActionError('GAME_ENDED', 'Game is over')
}

/** May the actor manipulate this card? Controller on board; owner elsewhere; never from a library. */
function assertCardControl(state: ServerGameState, actor: PlayerId, card: CardInstance) {
  if (card.zone.kind === 'library') throw new ActionError('USE_PEEK', 'Library cards move via scry/look/search')
  const controllerZones: ZoneKind[] = ['battlefield']
  const owner = card.zone.kind === 'stack' || controllerZones.includes(card.zone.kind as ZoneKind)
    ? card.controllerId
    : card.zone.player
  if (owner !== actor) throw new ActionError('NOT_CONTROLLER', "You don't control this card")
}

// ---------- turn helpers ----------

function nextActivePlayer(state: ServerGameState): PlayerId {
  const order = state.turn.order
  const alive = order.filter((p) => !state.players[p]!.hasConceded)
  if (!alive.length) return state.turn.activePlayer
  let i = order.indexOf(state.turn.activePlayer)
  for (let step = 0; step < order.length; step++) {
    i = (i + 1) % order.length
    if (!state.players[order[i]!]!.hasConceded) return order[i]!
  }
  return state.turn.activePlayer
}

function passTurn(state: ServerGameState) {
  state.turn.activePlayer = nextActivePlayer(state)
  state.turn.step = 'untap'
  state.turn.turnNumber++
}

/**
 * Turn-step conveniences (the only bits of automation in an otherwise manual
 * table): untap the active player's permanents when their untap step begins,
 * and draw a card when their draw step begins. Fire ONLY on natural turn
 * progression (turn.next / turn.pass), never on a manual turn.setStep jump, so
 * a player poking around the phase bar never triggers a surprise draw.
 */
function autoUntapActive(state: ServerGameState): CardId[] {
  const active = state.turn.activePlayer
  const changed: CardId[] = []
  for (const card of Object.values(state.cards)) {
    if (card.zone.kind === 'battlefield' && card.controllerId === active && card.tapped) {
      card.tapped = false
      changed.push(card.id)
    }
  }
  return changed
}

function autoDrawActive(state: ServerGameState): { changed: CardId[]; drew: boolean } {
  const active = state.turn.activePlayer
  // The starting player skips their first draw (turnNumber 1 is the opening turn).
  if (state.turn.turnNumber === 1) return { changed: [], drew: false }
  if (state.peeks[active]) return { changed: [], drew: false } // don't mutate a library mid-peek
  const lib = state.zones.perPlayer[active]!.library
  if (!lib.length) return { changed: [], drew: false } // empty library: manual table, just skip
  const res = moveCard(state, requireCard(state, lib[0]!), { kind: 'hand', player: active }, { index: 'bottom' })
  return { changed: res.changed, drew: true }
}

// ---------- per-action handlers ----------

type Handler<T extends ClientMsgT = ClientMsgT> = (
  state: ServerGameState,
  actor: PlayerId,
  msg: T,
) => ActionResult

const H: { [K in ClientMsgT['type']]?: Handler<Extract<ClientMsgT, { type: K }>> } = {
  'game.concede': (state, actor) => {
    const p = requirePlayer(state, actor)
    if (p.hasConceded) throw new ActionError('ALREADY', 'Already conceded')
    p.hasConceded = true
    const zones = new Set<string>()
    const changed: CardId[] = []
    // rule 800.4a: cards the player OWNS leave the game…
    for (const card of Object.values(state.cards)) {
      if (card.ownerId === actor) {
        zones.add(zoneKey(card.zone))
        pullFromZone(state, card)
        delete state.cards[card.id]
      }
    }
    // …and control of others' cards they controlled reverts to the owners
    for (const card of Object.values(state.cards)) {
      if (card.controllerId === actor && card.ownerId !== actor) {
        if (card.zone.kind === 'battlefield') {
          const res = moveCard(state, card, { kind: 'battlefield', player: card.ownerId })
          res.zones.forEach((z) => zones.add(z))
        }
        card.controllerId = card.ownerId
        changed.push(card.id)
      }
    }
    delete state.peeks[actor]
    p.commanderIds = [] // their commanders left the game with the rest
    let turn = false
    if (state.turn.activePlayer === actor) {
      passTurn(state)
      turn = true
    }
    return { changed, zones: [...zones], players: [actor], turn, peek: true, log: {} }
  },

  'game.finish': (state, actor, msg) => {
    assertActive(state)
    state.status = 'ended'
    state.winnerSeat = msg.winnerSeat ?? null
    const winner = Object.values(state.players).find((p) => p.seat === msg.winnerSeat)
    return { changed: [], zones: [], players: [], status: true, log: { winner: winner?.name ?? null } }
  },

  'turn.next': (state) => {
    assertActive(state)
    const i = STEPS.indexOf(state.turn.step)
    let changed: CardId[] = []
    const zones: string[] = []
    let drew = false
    if (i === STEPS.length - 1) {
      passTurn(state) // wrap → new active player's untap step
      changed = autoUntapActive(state)
    } else {
      state.turn.step = STEPS[i + 1]!
      if (state.turn.step === 'draw') {
        const r = autoDrawActive(state)
        changed = r.changed
        drew = r.drew
        if (drew) zones.push(`${state.turn.activePlayer}:library`, `${state.turn.activePlayer}:hand`)
      }
    }
    return { changed, zones, players: [], turn: true, log: { drew } }
  },

  'turn.setStep': (state, _actor, msg) => {
    assertActive(state)
    state.turn.step = msg.step as Step
    return { changed: [], zones: [], players: [], turn: true, log: {} }
  },

  'turn.pass': (state) => {
    assertActive(state)
    passTurn(state)
    const changed = autoUntapActive(state) // new active player untaps
    return { changed, zones: [], players: [], turn: true, log: {} }
  },

  'player.life': (state, actor, msg) => {
    const p = requirePlayer(state, actor)
    p.life += msg.delta
    return { changed: [], zones: [], players: [actor], log: { delta: msg.delta, life: p.life } }
  },

  'player.poison': (state, actor, msg) => {
    const p = requirePlayer(state, actor)
    p.poison = Math.max(0, p.poison + msg.delta)
    return { changed: [], zones: [], players: [actor], log: { delta: msg.delta, poison: p.poison } }
  },

  'player.counter': (state, actor, msg) => {
    const p = requirePlayer(state, actor)
    p.counters[msg.name] = (p.counters[msg.name] ?? 0) + msg.delta
    if (p.counters[msg.name] === 0) delete p.counters[msg.name]
    return { changed: [], zones: [], players: [actor], log: { name: msg.name, delta: msg.delta } }
  },

  'player.commanderDamage': (state, actor, msg) => {
    const p = requirePlayer(state, actor)
    const next = Math.max(0, (p.commanderDamage[msg.commanderKey] ?? 0) + msg.delta)
    p.commanderDamage[msg.commanderKey] = next
    return { changed: [], zones: [], players: [actor], log: { commanderKey: msg.commanderKey, total: next } }
  },

  'player.commanderTax': (state, actor, msg) => {
    const p = requirePlayer(state, actor)
    p.commanderTax[msg.slot] = Math.max(0, (p.commanderTax[msg.slot] ?? 0) + msg.delta)
    return { changed: [], zones: [], players: [actor], log: { slot: msg.slot, total: p.commanderTax[msg.slot] } }
  },

  'player.marker': (state, _actor, msg) => {
    state.markers[msg.marker] = msg.value
    return { changed: [], zones: [], players: [], markers: true, log: { marker: msg.marker, value: msg.value } }
  },

  'mana.change': (state, actor, msg) => {
    const p = requirePlayer(state, actor)
    p.manaPool[msg.color] = Math.max(0, p.manaPool[msg.color] + msg.delta)
    return { changed: [], zones: [], players: [actor], log: null as never }
  },

  'mana.clear': (state, actor) => {
    const p = requirePlayer(state, actor)
    p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
    return { changed: [], zones: [], players: [actor], log: null as never }
  },

  'deck.draw': (state, actor, msg) => {
    assertNoPeek(state, actor)
    const lib = state.zones.perPlayer[actor]!.library
    const n = Math.min(msg.n, lib.length)
    if (!n) throw new ActionError('EMPTY_LIBRARY', 'Library is empty')
    const changed: CardId[] = []
    for (let k = 0; k < n; k++) {
      const card = requireCard(state, lib[0]!)
      const res = moveCard(state, card, { kind: 'hand', player: actor }, { index: 'bottom' })
      changed.push(...res.changed)
    }
    return {
      changed,
      zones: [`${actor}:library`, `${actor}:hand`],
      players: [],
      log: { n },
    }
  },

  'deck.shuffle': (state, actor) => {
    assertNoPeek(state, actor)
    shuffleLibrary(state, actor)
    return { changed: [], zones: [`${actor}:library`], players: [], log: {} }
  },

  'deck.mulligan': (state, actor) => {
    if (state.status !== 'mulligans') throw new ActionError('NOT_MULLIGANS', 'Mulligans are over')
    const p = requirePlayer(state, actor)
    if (p.keptHand) throw new ActionError('ALREADY', 'You already kept your hand')
    assertNoPeek(state, actor)
    const hand = [...state.zones.perPlayer[actor]!.hand]
    for (const id of hand) moveCard(state, requireCard(state, id), { kind: 'library', player: actor }, { index: 'bottom' })
    shuffleLibrary(state, actor)
    const lib = state.zones.perPlayer[actor]!.library
    const n = Math.min(7, lib.length)
    for (let k = 0; k < n; k++)
      moveCard(state, requireCard(state, lib[0]!), { kind: 'hand', player: actor }, { index: 'bottom' })
    p.mullCount++
    return {
      changed: [...state.zones.perPlayer[actor]!.hand],
      zones: [`${actor}:library`, `${actor}:hand`],
      players: [actor],
      log: { mull: p.mullCount },
    }
  },

  'deck.keep': (state, actor, msg) => {
    if (state.status !== 'mulligans') throw new ActionError('NOT_MULLIGANS', 'Mulligans are over')
    const p = requirePlayer(state, actor)
    if (p.keptHand) throw new ActionError('ALREADY', 'You already kept your hand')
    const hand = state.zones.perPlayer[actor]!.hand
    if (new Set(msg.toBottom).size !== msg.toBottom.length)
      throw new ActionError('BAD_PEEK', 'Duplicate cards')
    for (const id of msg.toBottom)
      if (!hand.includes(id)) throw new ActionError('NOT_IN_HAND', 'Card not in your hand')
    const bottomed = msg.toBottom.length
    for (const id of msg.toBottom)
      moveCard(state, requireCard(state, id), { kind: 'library', player: actor }, { index: 'bottom' })
    p.keptHand = true
    let status = false
    if (Object.values(state.players).every((pl) => pl.keptHand || pl.hasConceded)) {
      state.status = 'active'
      status = true
    }
    return {
      changed: [],
      zones: [`${actor}:library`, `${actor}:hand`],
      players: [actor],
      status,
      log: { kept: state.zones.perPlayer[actor]!.hand.length, bottomed, mull: p.mullCount },
    }
  },

  'deck.scry': (state, actor, msg) => openPeek(state, actor, 'scry', msg.n),
  'deck.look': (state, actor, msg) => openPeek(state, actor, 'look', msg.n),
  'deck.search': (state, actor) => openPeek(state, actor, 'search', Infinity),

  'peek.resolve': (state, actor, msg) => {
    const peek = state.peeks[actor]
    if (!peek) throw new ActionError('NO_PEEK', 'No open peek')
    const mentioned = [...msg.toTop, ...msg.toBottom, ...msg.moves.map((m) => m.cardId)]
    if (new Set(mentioned).size !== mentioned.length) throw new ActionError('BAD_PEEK', 'Duplicate cards')
    for (const id of mentioned)
      if (!peek.cardIds.includes(id)) throw new ActionError('BAD_PEEK', 'Card was not in the peek')

    const zones = new Set<string>([`${actor}:library`])
    const changed: CardId[] = []
    const lib = state.zones.perPlayer[actor]!.library

    // 1) explicit moves out of the library
    let movedOut = 0
    for (const mv of msg.moves) {
      const card = requireCard(state, mv.cardId)
      if (card.zone.kind !== 'library') throw new ActionError('BAD_PEEK', 'Card left the library already')
      const res = moveCard(state, card, mv.to.zone, { index: mv.to.index, faceDown: mv.faceDown })
      res.zones.forEach((z) => zones.add(z))
      changed.push(...res.changed)
      movedOut++
    }
    // 2) remaining peeked cards: toTop order, unmentioned keep order behind them, toBottom at the end
    const remaining = peek.cardIds.filter((id) => state.cards[id]?.zone.kind === 'library')
    const unmentioned = remaining.filter((id) => !msg.toTop.includes(id) && !msg.toBottom.includes(id))
    for (const id of remaining) {
      const i = lib.indexOf(id)
      if (i >= 0) lib.splice(i, 1)
    }
    lib.unshift(...msg.toTop.filter((id) => remaining.includes(id)), ...unmentioned)
    lib.push(...msg.toBottom.filter((id) => remaining.includes(id)))

    const mode = peek.mode
    delete state.peeks[actor]
    if (mode === 'search') shuffleLibrary(state, actor)
    else for (const id of remaining) remintId(state, requireCard(state, id)) // peeked ids never reusable

    return {
      changed,
      zones: [...zones],
      players: [],
      peek: true,
      log: {
        mode,
        toTop: msg.toTop.length + (mode === 'scry' ? 0 : 0),
        toBottom: msg.toBottom.length,
        moved: movedOut,
        shuffled: mode === 'search',
      },
    }
  },

  'peek.cancel': (state, actor) => {
    const peek = state.peeks[actor]
    if (!peek) throw new ActionError('NO_PEEK', 'No open peek')
    const mode = peek.mode
    const ids = peek.cardIds.filter((id) => state.cards[id]?.zone.kind === 'library')
    delete state.peeks[actor]
    if (mode === 'search') shuffleLibrary(state, actor) // you saw the order — shuffle is forced
    else for (const id of ids) remintId(state, requireCard(state, id))
    return { changed: [], zones: [`${actor}:library`], players: [], peek: true, log: { mode, shuffled: mode === 'search' } }
  },

  'deck.revealTop': (state, actor, msg) => {
    assertNoPeek(state, actor)
    const lib = state.zones.perPlayer[actor]!.library
    const n = Math.min(msg.n, lib.length)
    if (!n) throw new ActionError('EMPTY_LIBRARY', 'Library is empty')
    // contents are broadcast as display data — ids stay unserialized (library rule)
    const revealed = lib.slice(0, n).map((id) => {
      const c = requireCard(state, id)
      return c.catalogId ? (state.catalog[c.catalogId] ?? null) : null
    })
    return {
      changed: [],
      zones: [],
      players: [],
      extra: { revealed },
      log: { n, names: revealed.map((d) => d?.name ?? '(unknown)') },
    }
  },

  'hand.reveal': (state, actor, msg) => {
    const hand = state.zones.perPlayer[actor]!.hand
    const displays = hand.map((id) => {
      const c = requireCard(state, id)
      return c.catalogId ? (state.catalog[c.catalogId] ?? null) : null
    })
    const to = msg.to === 'all' ? null : msg.to
    return {
      changed: [],
      zones: [],
      players: [],
      extra: { revealedHand: displays, to },
      log: { names: displays.map((d) => d?.name ?? '(unknown)'), to },
    }
  },

  'card.move': (state, actor, msg) => {
    assertActive(state)
    const card = requireCard(state, msg.cardId)
    assertCardControl(state, actor, card)
    if (msg.to.zone.kind === 'library' && state.peeks[actor])
      throw new ActionError('PEEK_OPEN', 'Resolve your peek first')
    const from = card.zone
    const fromVisibleName =
      card.catalogId && !card.faceDown ? state.catalog[card.catalogId]?.name : undefined
    // Convenience: casting a commander FROM the command zone bumps its tax (+2
    // per prior cast). We track the counter here; cost is never enforced.
    const isCommanderCast =
      card.isCommander &&
      card.commanderSlot != null &&
      from.kind === 'command' &&
      (msg.to.zone.kind === 'battlefield' || msg.to.zone.kind === 'stack')
    const ownerId = card.ownerId
    const res = moveCard(state, card, msg.to.zone, {
      index: msg.to.index,
      faceDown: msg.faceDown,
      x: msg.x,
      y: msg.y,
    })
    let commanderTax: number | undefined
    if (isCommanderCast) {
      const owner = state.players[ownerId]!
      const slot = card.commanderSlot!
      owner.commanderTax[slot] = (owner.commanderTax[slot] ?? 0) + 1
      commanderTax = owner.commanderTax[slot]
    }
    return {
      changed: res.changed,
      zones: res.zones,
      players: isCommanderCast ? [ownerId] : [],
      log: {
        from: from.kind,
        to: msg.to.zone.kind,
        toPlayer: 'player' in msg.to.zone ? msg.to.zone.player : null,
        index: msg.to.index ?? null,
        name: fromVisibleName ?? null, // events name a card iff identity was/became public (per-viewer in events.ts)
        cardId: res.deleted ? null : card.id,
        deleted: res.deleted,
        commanderTax,
      },
    }
  },

  'card.tap': (state, actor, msg) => {
    const changed: CardId[] = []
    for (const id of msg.cardIds) {
      const card = requireCard(state, id)
      if (card.zone.kind !== 'battlefield') throw new ActionError('NOT_BATTLEFIELD', 'Not on the battlefield')
      if (card.controllerId !== actor) throw new ActionError('NOT_CONTROLLER', "You don't control this card")
      card.tapped = msg.tapped
      changed.push(id)
    }
    return { changed, zones: [], players: [], log: { n: changed.length, tapped: msg.tapped } }
  },

  'board.untapAll': (state, actor) => {
    const changed: CardId[] = []
    for (const card of Object.values(state.cards)) {
      if (card.zone.kind === 'battlefield' && card.controllerId === actor && card.tapped) {
        card.tapped = false
        changed.push(card.id)
      }
    }
    return { changed, zones: [], players: [], log: { n: changed.length } }
  },

  'card.face': (state, actor, msg) => {
    const card = requireCard(state, msg.cardId)
    assertCardControl(state, actor, card)
    if (msg.faceDown != null) {
      if (msg.faceDown && !card.faceDown) card.revealedTo = null // face-down = a new hidden object
      card.faceDown = msg.faceDown
    }
    if (msg.faceIndex != null) card.faceIndex = msg.faceIndex
    const name = !card.faceDown && card.catalogId ? state.catalog[card.catalogId]?.name : null
    return {
      changed: [card.id],
      zones: [],
      players: [],
      log: { faceDown: card.faceDown, faceIndex: card.faceIndex, name },
    }
  },

  'card.counter': (state, actor, msg) => {
    const card = requireCard(state, msg.cardId)
    assertCardControl(state, actor, card)
    card.counters[msg.name] = (card.counters[msg.name] ?? 0) + msg.delta
    if (card.counters[msg.name]! <= 0) delete card.counters[msg.name]
    const name = !card.faceDown && card.catalogId ? state.catalog[card.catalogId]?.name : null
    return {
      changed: [card.id],
      zones: [],
      players: [],
      log: { counter: msg.name, delta: msg.delta, total: card.counters[msg.name] ?? 0, name },
    }
  },

  'card.attach': (state, actor, msg) => {
    const card = requireCard(state, msg.cardId)
    assertCardControl(state, actor, card)
    if (msg.targetId) {
      const target = requireCard(state, msg.targetId)
      if (target.zone.kind !== 'battlefield' || card.zone.kind !== 'battlefield')
        throw new ActionError('NOT_BATTLEFIELD', 'Attachments live on the battlefield')
      // cycle check
      let cursor: CardInstance | undefined = target
      while (cursor) {
        if (cursor.id === card.id) throw new ActionError('ATTACH_CYCLE', 'Circular attachment')
        cursor = cursor.attachedTo ? state.cards[cursor.attachedTo] : undefined
      }
      card.attachedTo = msg.targetId
    } else {
      card.attachedTo = null
    }
    return { changed: [card.id], zones: [], players: [], log: { attached: !!msg.targetId } }
  },

  'card.control': (state, actor, msg) => {
    const card = requireCard(state, msg.cardId)
    assertCardControl(state, actor, card)
    requirePlayer(state, msg.controllerId)
    const zones: string[] = []
    if (card.zone.kind === 'battlefield' && card.zone.player !== msg.controllerId) {
      const res = moveCard(state, card, { kind: 'battlefield', player: msg.controllerId })
      zones.push(...res.zones)
    }
    card.controllerId = msg.controllerId
    const name = !card.faceDown && card.catalogId ? state.catalog[card.catalogId]?.name : null
    return { changed: [card.id], zones, players: [], log: { toPlayer: msg.controllerId, name } }
  },

  'card.reveal': (state, actor, msg) => {
    const card = requireCard(state, msg.cardId)
    assertCardControl(state, actor, card)
    const to = msg.to === 'all' ? Object.keys(state.players) : msg.to
    card.revealedTo = [...new Set([...(card.revealedTo ?? []), ...to])]
    const name = card.catalogId ? (state.catalog[card.catalogId]?.name ?? null) : null
    return { changed: [card.id], zones: [], players: [], log: { to: msg.to === 'all' ? null : msg.to, name } }
  },

  'token.create': (state, actor, msg) => {
    assertActive(state)
    if (msg.spec.fromCatalogId && !state.catalog[msg.spec.fromCatalogId])
      throw new ActionError('BAD_TOKEN', 'Unknown source card for copy token')
    const zone: ZoneRef = msg.zone === 'stack' ? { kind: 'stack' } : { kind: 'battlefield', player: actor }
    const changed: CardId[] = []
    for (let k = 0; k < msg.quantity; k++) {
      const id = mintCardId()
      state.cards[id] = {
        id,
        catalogId: null,
        ownerId: actor,
        controllerId: actor,
        zone,
        x: 0.4 + (k % 5) * 0.04,
        y: 0.6,
        tapped: msg.tapped,
        faceDown: false,
        faceIndex: 0,
        counters: {},
        attachedTo: null,
        isToken: true,
        tokenSpec: msg.spec as TokenSpec,
        isCommander: false,
        commanderSlot: null,
        revealedTo: null,
      }
      zoneArr(state, zone).push(id)
      changed.push(id)
    }
    return {
      changed,
      zones: [zoneKey(zone)],
      players: [],
      log: { n: msg.quantity, name: msg.spec.name, pt: msg.spec.pt, zone: msg.zone },
    }
  },

  'chat.send': (_state, _actor, msg) => ({
    changed: [],
    zones: [],
    players: [],
    log: { text: msg.text },
  }),

  'game.roll': (_state, _actor, msg) => {
    const results = Array.from({ length: msg.count }, () => rollDie(msg.sides))
    return { changed: [], zones: [], players: [], extra: { sides: msg.sides, results }, log: { sides: msg.sides, results } }
  },

  'game.coin': (_state, _actor, msg) => {
    const results = Array.from({ length: msg.count }, () => flipCoin())
    return { changed: [], zones: [], players: [], extra: { results }, log: { results } }
  },
}

function shuffleLibrary(state: ServerGameState, player: PlayerId) {
  const lib = state.zones.perPlayer[player]!.library
  // every id is re-minted: nobody can correlate pre-shuffle knowledge with post-shuffle ids
  for (const id of [...lib]) remintId(state, requireCard(state, id))
  shuffleInPlace(lib)
}

function openPeek(
  state: ServerGameState,
  actor: PlayerId,
  mode: 'scry' | 'look' | 'search',
  n: number,
): ActionResult {
  assertNoPeek(state, actor)
  const lib = state.zones.perPlayer[actor]!.library
  const count = Math.min(n, lib.length)
  if (!count) throw new ActionError('EMPTY_LIBRARY', 'Library is empty')
  state.peeks[actor] = { mode, n: count, cardIds: lib.slice(0, count) }
  return { changed: [], zones: [], players: [], peek: true, log: { mode, n: count } }
}

// ---------- entry point ----------

export function applyAction(
  state: ServerGameState,
  actor: PlayerId,
  msg: ClientMsgT,
): ActionResult {
  const handler = H[msg.type] as Handler | undefined
  if (!handler) throw new ActionError('BAD_ACTION', `Unhandled action ${msg.type}`)
  if (!state.players[actor]) throw new ActionError('NOT_SEATED', 'You are not in this game')
  if (state.players[actor]!.hasConceded && msg.type !== 'chat.send')
    throw new ActionError('CONCEDED', 'You have conceded')
  return handler(state, actor, msg)
}
