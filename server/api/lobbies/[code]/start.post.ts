import { createGameFromLobby } from '../../../game/lifecycle'

type StartErrorCode = 'NO_DECK' | 'NO_COMMANDER' | 'NOT_READY'

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const lobby = await getLobbyByCode(getRouterParam(event, 'code')!)

  if (lobby.hostId !== me.id)
    throw createError({ statusCode: 403, statusMessage: 'Only the host can start the game' })
  if (lobby.status !== 'OPEN')
    throw createError({ statusCode: 409, statusMessage: 'Lobby is not open' })

  const seats = await db.lobbySeat.findMany({
    where: { lobbyId: lobby.id },
    orderBy: { seatIndex: 'asc' },
  })
  if (seats.length < 1)
    throw createError({ statusCode: 422, statusMessage: 'Nobody is seated' })

  const deckIds = [...new Set(seats.map((s) => s.deckId).filter((id): id is string => !!id))]
  const commanderCounts = deckIds.length
    ? await db.deckCard.groupBy({
        by: ['deckId'],
        where: { deckId: { in: deckIds }, section: 'COMMANDER' },
        _count: { _all: true },
      })
    : []
  const commandersByDeck = new Map(commanderCounts.map((c) => [c.deckId, c._count._all]))

  const errors: { seat: number; code: StartErrorCode }[] = []
  for (const seat of seats) {
    if (!seat.deckId) errors.push({ seat: seat.seatIndex, code: 'NO_DECK' })
    else if (!(commandersByDeck.get(seat.deckId)! > 0)) errors.push({ seat: seat.seatIndex, code: 'NO_COMMANDER' })
    if (!seat.isReady) errors.push({ seat: seat.seatIndex, code: 'NOT_READY' })
  }
  if (errors.length)
    throw createError({ statusCode: 422, statusMessage: 'Lobby is not ready to start', data: { errors } })

  // Optimistic concurrency guard: only one start wins the OPEN → STARTING flip.
  const flipped = await db.lobby.updateMany({
    where: { id: lobby.id, status: 'OPEN' },
    data: { status: 'STARTING' },
  })
  if (flipped.count === 0)
    throw createError({ statusCode: 409, statusMessage: 'Start already in progress' })

  try {
    const { gameId } = await createGameFromLobby(lobby.id)
    await db.lobby.update({ where: { id: lobby.id }, data: { status: 'IN_GAME' } })
    return { gameId }
  } catch (err) {
    // Roll back so the lobby is joinable/startable again.
    await db.lobby.updateMany({
      where: { id: lobby.id, status: 'STARTING' },
      data: { status: 'OPEN' },
    })
    throw err
  }
})
