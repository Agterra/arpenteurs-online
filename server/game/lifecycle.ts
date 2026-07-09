/**
 * Lobby → Game bridge. Called by POST /api/lobbies/:code/start AFTER lobby-side
 * validation (status STARTING, every seat ready with a deck + commander).
 */
import type { CardDisplay, PlayerId } from '#shared/types/game'
import { buildInitialState, type SetupDeckCard } from './setup'
import { buildRulesGame } from '../rules/setup'
import { isImplemented, registerFallback } from '../rules/cards/registry'

export async function createGameFromLobby(lobbyId: string): Promise<{ gameId: string }> {
  const lobby = await db.lobby.findUnique({
    where: { id: lobbyId },
    include: { seats: { include: { user: { select: { id: true, username: true } } } } },
  })
  if (!lobby) throw createError({ statusCode: 404, statusMessage: 'Lobby not found' })

  if (lobby.mode === 'ENFORCED') return createEnforcedGame(lobby)

  const decks = new Map<PlayerId, SetupDeckCard[]>()
  for (const seat of lobby.seats) {
    if (!seat.deckId) throw createError({ statusCode: 422, statusMessage: `Seat ${seat.seatIndex} has no deck` })
    const deckCards = await db.deckCard.findMany({
      where: { deckId: seat.deckId },
      include: { card: true },
    })
    if (!deckCards.some((dc) => dc.section === 'COMMANDER'))
      throw createError({ statusCode: 422, statusMessage: `Seat ${seat.seatIndex} has no commander` })
    decks.set(
      seat.userId,
      deckCards.map((dc) => ({
        catalogId: dc.cardId,
        quantity: dc.quantity,
        isCommander: dc.section === 'COMMANDER',
        display: {
          name: dc.card.name,
          manaCost: dc.card.manaCost,
          typeLine: dc.card.typeLine,
          oracleText: dc.card.oracleText,
          power: dc.card.power,
          toughness: dc.card.toughness,
          loyalty: dc.card.loyalty,
          imageSmall: dc.card.imageSmall,
          imageNormal: dc.card.imageNormal,
          backImageSmall: dc.card.backImageSmall,
          backImageNormal: dc.card.backImageNormal,
          faces: dc.card.faces,
          canBeCommander: dc.card.canBeCommander,
        } satisfies CardDisplay,
      })),
    )
  }

  const game = await db.game.create({
    data: {
      lobbyId,
      snapshot: {},
      snapshotSeq: 0,
      players: {
        create: lobby.seats.map((s) => ({ userId: s.userId, seatIndex: s.seatIndex, deckId: s.deckId })),
      },
    },
  })

  const state = buildInitialState(
    game.id,
    lobby.seats.map((s) => ({ id: s.userId, seat: s.seatIndex, name: s.user.username })),
    decks,
  )

  const firstPlayer = state.players[state.turn.activePlayer]!
  await db.game.update({ where: { id: game.id }, data: { snapshot: state as never, snapshotSeq: 0 } })
  await db.gameEvent.create({
    data: {
      gameId: game.id,
      seq: 0,
      actorSeat: null,
      type: 'game.started',
      publicLine: `Game started — ${firstPlayer.name} goes first. Mulligans!`,
    },
  })

  return { gameId: game.id }
}

/**
 * Enforced (rules-engine) branch: decks become quantity-expanded card-name
 * lists, the RulesGameState is built by the engine, and the snapshot is tagged
 * with `engine: 'rules'` — the room registry branches on that discriminator.
 * Card-pool validation (unimplementedNames) already happened in start.post.ts.
 */
interface LobbyWithSeats {
  id: string
  seats: {
    userId: string
    seatIndex: number
    deckId: string | null
    user: { id: string; username: string }
  }[]
}

async function createEnforcedGame(lobby: LobbyWithSeats): Promise<{ gameId: string }> {
  const decks = new Map<PlayerId, { commander: string; cards: string[] }>()
  for (const seat of lobby.seats) {
    if (!seat.deckId) throw createError({ statusCode: 422, statusMessage: `Seat ${seat.seatIndex} has no deck` })
    const deckCards = await db.deckCard.findMany({
      where: { deckId: seat.deckId },
      select: { quantity: true, section: true, card: { select: { name: true } } },
    })
    const commanderRow = deckCards.find((dc) => dc.section === 'COMMANDER')
    if (!commanderRow)
      throw createError({ statusCode: 422, statusMessage: `Seat ${seat.seatIndex} has no commander` })
    const cards: string[] = []
    for (const dc of deckCards) {
      if (dc.section === 'COMMANDER') continue
      for (let i = 0; i < dc.quantity; i++) cards.push(dc.card.name)
    }
    decks.set(seat.userId, { commander: commanderRow.card.name, cards })
  }

  // Assisted table: register catalog-derived fallback definitions for every
  // card the engine doesn't implement, so the game can start and those cards get
  // a printed body (their effects are run manually). Implemented cards win.
  const allNames = [...new Set([...decks.values()].flatMap((d) => [d.commander, ...d.cards]))]
  const unknown = allNames.filter((n) => !isImplemented(n))
  if (unknown.length) {
    const rows = await db.card.findMany({
      where: { name: { in: unknown } },
      select: { name: true, typeLine: true, manaCost: true, power: true, toughness: true, oracleText: true, colors: true },
    })
    for (const row of rows) registerFallback(row)
  }

  const game = await db.game.create({
    data: {
      lobbyId: lobby.id,
      snapshot: {},
      snapshotSeq: 0,
      players: {
        create: lobby.seats.map((s) => ({ userId: s.userId, seatIndex: s.seatIndex, deckId: s.deckId })),
      },
    },
  })

  const state = buildRulesGame(
    game.id,
    lobby.seats.map((s) => ({ id: s.userId, seat: s.seatIndex, name: s.user.username })),
    decks,
  )

  await db.game.update({
    where: { id: game.id },
    data: { snapshot: { engine: 'rules', state } as never, snapshotSeq: state.seq },
  })

  return { gameId: game.id }
}
