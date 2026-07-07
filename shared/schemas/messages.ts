/**
 * Wire protocol. Every client→server message is validated by ClientMsg —
 * with hard bounds on every field (flood/OOM defense, see PLAN §4).
 * Server→client events are typed in TS (GameEvent / SyncMsg below).
 */
import { z } from 'zod'
import type {
  CardId,
  ClientGameState,
  LogEntry,
  ManaColor,
  Peek,
  PlayerId,
  PlayerState,
  RedactedCard,
  Step,
  TurnState,
} from '../types/game'

const CardIdZ = z.string().min(1).max(64)
const PlayerIdZ = z.string().min(1).max(64)
const SmallInt = z.number().int().min(-999).max(999)
const Qty = z.number().int().min(1).max(500)

export const StepZ = z.enum([
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
])

export const ManaColorZ = z.enum(['W', 'U', 'B', 'R', 'G', 'C'])

export const ZoneRefZ = z.union([
  z.object({
    kind: z.enum(['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command']),
    player: PlayerIdZ,
  }),
  z.object({ kind: z.literal('stack') }),
])

export const MoveTargetZ = z.object({
  zone: ZoneRefZ,
  index: z.union([z.number().int().min(0).max(500), z.literal('top'), z.literal('bottom')]).optional(),
})

export const TokenSpecZ = z.object({
  name: z.string().min(1).max(100),
  pt: z.string().max(16).nullable(),
  colors: z.array(ManaColorZ).max(6),
  typeLine: z.string().max(120),
  text: z.string().max(500),
  fromCatalogId: z.string().max(64).nullable(),
})

export const ClientMsg = z.discriminatedUnion('type', [
  // session
  z.object({ type: z.literal('resync') }),
  z.object({ type: z.literal('game.concede') }),
  z.object({ type: z.literal('game.finish'), winnerSeat: z.number().int().min(0).max(3).nullable() }),
  // turn
  z.object({ type: z.literal('turn.next') }),
  z.object({ type: z.literal('turn.setStep'), step: StepZ }),
  z.object({ type: z.literal('turn.pass') }),
  // player counters
  z.object({ type: z.literal('player.life'), delta: SmallInt }),
  z.object({ type: z.literal('player.poison'), delta: SmallInt }),
  z.object({ type: z.literal('player.counter'), name: z.string().min(1).max(40), delta: SmallInt }),
  z.object({ type: z.literal('player.commanderDamage'), commanderKey: z.string().max(80), delta: SmallInt }),
  z.object({ type: z.literal('player.commanderTax'), slot: z.number().int().min(0).max(1), delta: SmallInt }),
  z.object({
    type: z.literal('player.marker'),
    marker: z.string().min(1).max(30),
    value: z.union([PlayerIdZ, z.string().max(40)]).nullable(),
  }),
  // mana
  z.object({ type: z.literal('mana.change'), color: ManaColorZ, delta: SmallInt }),
  z.object({ type: z.literal('mana.clear') }),
  // deck
  z.object({ type: z.literal('deck.draw'), n: Qty }),
  z.object({ type: z.literal('deck.shuffle') }),
  z.object({ type: z.literal('deck.mulligan') }),
  z.object({ type: z.literal('deck.keep'), toBottom: z.array(CardIdZ).max(7) }),
  z.object({ type: z.literal('deck.scry'), n: Qty }),
  z.object({ type: z.literal('deck.look'), n: Qty }),
  z.object({ type: z.literal('deck.search') }),
  z.object({ type: z.literal('deck.revealTop'), n: Qty }),
  z.object({ type: z.literal('hand.reveal'), to: z.union([z.literal('all'), z.array(PlayerIdZ).min(1).max(3)]) }),
  z.object({
    type: z.literal('peek.resolve'),
    toTop: z.array(CardIdZ).max(500),
    toBottom: z.array(CardIdZ).max(500),
    moves: z.array(z.object({ cardId: CardIdZ, to: MoveTargetZ, faceDown: z.boolean().optional() })).max(50),
  }),
  z.object({ type: z.literal('peek.cancel') }),
  // cards
  z.object({
    type: z.literal('card.move'),
    cardId: CardIdZ,
    to: MoveTargetZ,
    faceDown: z.boolean().optional(),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
  }),
  z.object({ type: z.literal('card.tap'), cardIds: z.array(CardIdZ).min(1).max(100), tapped: z.boolean() }),
  z.object({ type: z.literal('board.untapAll') }),
  z.object({
    type: z.literal('card.face'),
    cardId: CardIdZ,
    faceDown: z.boolean().optional(),
    faceIndex: z.number().int().min(0).max(1).optional(),
  }),
  z.object({ type: z.literal('card.counter'), cardId: CardIdZ, name: z.string().min(1).max(40), delta: SmallInt }),
  z.object({ type: z.literal('card.attach'), cardId: CardIdZ, targetId: CardIdZ.nullable() }),
  z.object({ type: z.literal('card.control'), cardId: CardIdZ, controllerId: PlayerIdZ }),
  z.object({ type: z.literal('card.reveal'), cardId: CardIdZ, to: z.union([z.literal('all'), z.array(PlayerIdZ).min(1).max(3)]) }),
  z.object({
    type: z.literal('token.create'),
    spec: TokenSpecZ,
    quantity: z.number().int().min(1).max(20),
    zone: z.enum(['battlefield', 'stack']).default('battlefield'),
    tapped: z.boolean().default(false),
  }),
  // table talk
  z.object({ type: z.literal('chat.send'), text: z.string().min(1).max(500) }),
  z.object({ type: z.literal('game.roll'), sides: z.number().int().min(2).max(1000), count: z.number().int().min(1).max(20).default(1) }),
  z.object({ type: z.literal('game.coin'), count: z.number().int().min(1).max(20).default(1) }),
  // ephemeral (no seq, not persisted)
  z.object({ type: z.literal('card.position'), cardId: CardIdZ, x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  z.object({
    type: z.literal('card.arrow'),
    fromCardId: CardIdZ,
    toCardId: CardIdZ.optional(),
    toPlayerId: PlayerIdZ.optional(),
    on: z.boolean(),
  }),
])
export type ClientMsgT = z.infer<typeof ClientMsg>
export type ActionType = ClientMsgT['type']

export const EPHEMERAL_TYPES: ReadonlySet<string> = new Set(['card.position', 'card.arrow', 'resync'])

// ---------- server → client ----------

export interface ZonePatch {
  key: string // ZoneKey ('<playerId>:<kind>' | 'stack')
  ids?: CardId[] // full ordered list (public zones / your hand)
  count?: number // hidden zones (opponent hands, all libraries)
}

export interface GameEventMsg {
  t: 'event'
  seq: number
  ts: number
  type: ActionType | 'game.started' | 'player.presence' | 'system'
  actor: PlayerId | null
  log?: string // pre-redacted for THIS viewer
  cards?: RedactedCard[] // upserts (visible to this viewer)
  removed?: CardId[] // ids no longer visible to this viewer
  zones?: ZonePatch[]
  players?: (Partial<PlayerState> & { id: PlayerId })[]
  turn?: TurnState
  markers?: Record<string, PlayerId | string | null>
  status?: 'mulligans' | 'active' | 'ended'
  winnerSeat?: number | null
  peek?: (Peek & { cards: RedactedCard[] }) | null // actor only
  /** public extras for UI (dice results, revealed card names, coin flips…) */
  extra?: Record<string, unknown>
}

export interface SyncMsg {
  t: 'sync'
  seq: number
  state: ClientGameState
  log: LogEntry[]
}

export interface ErrorMsg {
  t: 'error'
  code: string
  message: string
}

export interface EphemeralMsg {
  t: 'ephemeral'
  type: 'card.position' | 'card.arrow' | 'arrows.clear'
  actor: PlayerId
  payload: Record<string, unknown>
}

export interface PresenceMsg {
  t: 'presence'
  connected: PlayerId[]
}

export type ServerMsg = GameEventMsg | SyncMsg | ErrorMsg | EphemeralMsg | PresenceMsg
