/**
 * Game state model — shared between the server engine and the client store.
 * ServerGameState is NEVER serialized to a client; clients only ever see
 * ClientGameState / RedactedCard produced by server/game/visibility.ts.
 */

export type PlayerId = string // = User.id
export type CardId = string // per-instance id, re-minted when a card enters a hidden zone
export type CatalogId = string // Card.id in the catalog (null for custom tokens)

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C'
export type ManaPool = Record<ManaColor, number>

export const STEPS = [
  'untap',
  'upkeep',
  'draw',
  'main1',
  'combat_begin',
  'attackers',
  'blockers',
  'damage',
  'combat_end',
  'main2',
  'end',
  'cleanup',
] as const
export type Step = (typeof STEPS)[number]

export interface TurnState {
  order: PlayerId[] // fixed at game start
  activePlayer: PlayerId
  step: Step
  turnNumber: number
}

/** Key for commander-scoped tracking that survives instance re-minting: `${ownerId}#${slot}` */
export type CommanderKey = string

export interface PlayerState {
  id: PlayerId
  seat: number // 0..3
  name: string
  life: number
  poison: number
  counters: Record<string, number> // energy, experience, rad…
  manaPool: ManaPool
  // Current instance ids, slot-indexed (1–2). Serialized per-viewer: a slot is
  // null when the commander sits in a zone that viewer cannot see into.
  commanderIds: (CardId | null)[]
  commanderTax: Record<number, number> // slot → extra {2}s already paid
  commanderDamage: Record<CommanderKey, number> // damage TAKEN from that commander
  mullCount: number
  keptHand: boolean
  hasConceded: boolean
}

export type ZoneKind = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'
export type ZoneRef = { kind: ZoneKind; player: PlayerId } | { kind: 'stack' }
/** Serialized key for a zone: `${playerId}:${kind}` or `stack` */
export type ZoneKey = string

export interface TokenSpec {
  name: string
  pt: string | null // '1/1', '*/*', null for non-creatures
  colors: ManaColor[]
  typeLine: string
  text: string
  fromCatalogId: CatalogId | null // copy-tokens render the real card
}

export interface CardInstance {
  id: CardId
  catalogId: CatalogId | null // null only for custom tokens
  ownerId: PlayerId
  controllerId: PlayerId
  zone: ZoneRef
  x: number // battlefield free position, 0..1 (ignored elsewhere)
  y: number
  tapped: boolean
  faceDown: boolean
  faceIndex: number // 0 front, 1 back (transform/MDFC)
  counters: Record<string, number>
  attachedTo: CardId | null
  isToken: boolean
  tokenSpec: TokenSpec | null
  isCommander: boolean
  commanderSlot: number | null
  revealedTo: PlayerId[] | null // extra visibility on a hidden card
}

/** Catalog display data embedded on visible cards (server-only map; leaks decklists if sent whole). */
export interface CardDisplay {
  name: string
  manaCost: string | null
  typeLine: string
  oracleText: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
  imageSmall: string | null
  imageNormal: string | null
  backImageSmall: string | null
  backImageNormal: string | null
  faces: unknown | null
  canBeCommander: boolean
}

export interface Peek {
  mode: 'scry' | 'look' | 'search'
  n: number
  cardIds: CardId[] // top-down order at open time
}

export type GamePhase = 'mulligans' | 'active' | 'ended'

/** Server-only, authoritative. */
export interface ServerGameState {
  id: string
  status: GamePhase
  players: Record<PlayerId, PlayerState>
  cards: Record<CardId, CardInstance>
  zones: {
    perPlayer: Record<PlayerId, Record<ZoneKind, CardId[]>> // ordered; index 0 = TOP of library
    stack: CardId[] // last = top
  }
  turn: TurnState
  markers: Record<string, PlayerId | string | null> // monarch, initiative, daynight, custom
  peeks: Partial<Record<PlayerId, Peek>>
  winnerSeat: number | null
  seq: number
  /** catalogId → display data for every card in the game (server-only). */
  catalog: Record<CatalogId, CardDisplay>
}

// ---------- client-side (redacted) ----------

export type RedactedCard =
  | (CardInstance & { display: CardDisplay | null; hidden?: false })
  | {
      id: CardId
      hidden: true
      catalogId: null
      tokenSpec: null
      display: null
      ownerId: PlayerId
      controllerId: PlayerId
      zone: ZoneRef
      x: number
      y: number
      tapped: boolean
      faceDown: boolean
      faceIndex: 0
      counters: Record<string, number>
      attachedTo: CardId | null
      isToken: boolean
      isCommander: boolean
      commanderSlot: number | null
      revealedTo: null
    }

export interface ClientZones {
  perPlayer: Record<
    PlayerId,
    {
      battlefield: CardId[]
      graveyard: CardId[]
      exile: CardId[]
      command: CardId[]
      hand: CardId[] | { count: number } // ids for YOUR hand only
      library: { count: number } // order NEVER serialized, to anyone
    }
  >
  stack: CardId[]
}

export interface LogEntry {
  seq: number
  ts: number
  actor: PlayerId | null
  kind: string // event type ('chat' included)
  line: string // pre-redacted for THIS viewer
}

export interface ClientGameState {
  id: string
  status: GamePhase
  you: PlayerId
  players: Record<PlayerId, PlayerState>
  cards: Record<CardId, RedactedCard> // only instances this viewer may know exist
  zones: ClientZones
  turn: TurnState
  markers: Record<string, PlayerId | string | null>
  peek: (Peek & { cards: RedactedCard[] }) | null // YOUR active peek
  winnerSeat: number | null
  seq: number
}

export const zoneKey = (z: ZoneRef): ZoneKey => (z.kind === 'stack' ? 'stack' : `${z.player}:${z.kind}`)
export const commanderKey = (ownerId: PlayerId, slot: number): CommanderKey => `${ownerId}#${slot}`
