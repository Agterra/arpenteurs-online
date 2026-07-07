/**
 * Initial ServerGameState builder — pure (RNG injected via rng.ts), unit-tested
 * without a DB. lifecycle.ts feeds it deck data loaded from Prisma.
 */
import { randomInt } from 'node:crypto'
import type {
  CardDisplay,
  CardInstance,
  CatalogId,
  PlayerId,
  ServerGameState,
  ZoneKind,
} from '#shared/types/game'
import { mintCardId, shuffleInPlace } from './rng'

export interface SetupPlayer {
  id: PlayerId
  seat: number
  name: string
}

export interface SetupDeckCard {
  catalogId: CatalogId
  quantity: number
  isCommander: boolean
  display: CardDisplay
}

const EMPTY_ZONES = (): Record<ZoneKind, string[]> => ({
  library: [],
  hand: [],
  battlefield: [],
  graveyard: [],
  exile: [],
  command: [],
})

export function buildInitialState(
  gameId: string,
  players: SetupPlayer[],
  decks: Map<PlayerId, SetupDeckCard[]>,
): ServerGameState {
  const ordered = [...players].sort((a, b) => a.seat - b.seat)
  const state: ServerGameState = {
    id: gameId,
    status: 'mulligans',
    players: {},
    cards: {},
    zones: { perPlayer: {}, stack: [] },
    turn: {
      order: ordered.map((p) => p.id),
      activePlayer: ordered[randomInt(ordered.length)]!.id,
      step: 'untap',
      turnNumber: 1,
    },
    markers: { monarch: null, initiative: null, daynight: null },
    peeks: {},
    winnerSeat: null,
    seq: 0,
    catalog: {},
  }

  for (const p of ordered) {
    state.players[p.id] = {
      id: p.id,
      seat: p.seat,
      name: p.name,
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
    state.zones.perPlayer[p.id] = EMPTY_ZONES()

    const zones = state.zones.perPlayer[p.id]!
    let commanderSlot = 0
    for (const dc of decks.get(p.id) ?? []) {
      state.catalog[dc.catalogId] ??= dc.display
      for (let k = 0; k < dc.quantity; k++) {
        const instance: CardInstance = {
          id: mintCardId(),
          catalogId: dc.catalogId,
          ownerId: p.id,
          controllerId: p.id,
          zone: dc.isCommander ? { kind: 'command', player: p.id } : { kind: 'library', player: p.id },
          x: 0,
          y: 0,
          tapped: false,
          faceDown: false,
          faceIndex: 0,
          counters: {},
          attachedTo: null,
          isToken: false,
          tokenSpec: null,
          isCommander: dc.isCommander,
          commanderSlot: dc.isCommander ? commanderSlot : null,
          revealedTo: null,
        }
        state.cards[instance.id] = instance
        if (dc.isCommander) {
          zones.command.push(instance.id)
          state.players[p.id]!.commanderIds[commanderSlot] = instance.id
          state.players[p.id]!.commanderTax[commanderSlot] = 0
          commanderSlot++
        } else {
          zones.library.push(instance.id)
        }
      }
    }
    shuffleInPlace(zones.library)
    // opening hand of 7 (moves are simple here: library top → hand, ids stay fresh)
    for (let k = 0; k < 7 && zones.library.length; k++) {
      const id = zones.library.shift()!
      state.cards[id]!.zone = { kind: 'hand', player: p.id }
      zones.hand.push(id)
    }
  }
  return state
}
