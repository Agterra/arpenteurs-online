/**
 * Lobby → Game bridge. Called by POST /api/lobbies/:code/start AFTER lobby-side
 * validation (status STARTING, every seat ready with a deck + commander).
 */
import type { CardDisplay, PlayerId } from '#shared/types/game'
import { buildInitialState, type SetupDeckCard } from './setup'

export async function createGameFromLobby(lobbyId: string): Promise<{ gameId: string }> {
  const lobby = await db.lobby.findUnique({
    where: { id: lobbyId },
    include: { seats: { include: { user: { select: { id: true, username: true } } } } },
  })
  if (!lobby) throw createError({ statusCode: 404, statusMessage: 'Lobby not found' })

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
