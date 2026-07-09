import type { Lobby } from '../generated/prisma/client'

export async function getLobbyByCode(code: string): Promise<Lobby> {
  const lobby = await db.lobby.findUnique({ where: { inviteCode: code } })
  if (!lobby) throw createError({ statusCode: 404, statusMessage: 'Lobby not found' })
  return lobby
}

/** Latest ACTIVE game of a lobby (null when none). */
export async function getActiveLobbyGame(lobbyId: string) {
  return db.game.findFirst({
    where: { lobbyId, status: 'ACTIVE' },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  })
}

/** Member = has a LobbySeat, or is a GamePlayer of the lobby's ACTIVE game. */
export async function isLobbyMember(lobbyId: string, userId: string): Promise<boolean> {
  const seat = await db.lobbySeat.findUnique({
    where: { lobbyId_userId: { lobbyId, userId } },
    select: { id: true },
  })
  if (seat) return true
  const gamePlayer = await db.gamePlayer.findFirst({
    where: { userId, game: { lobbyId, status: 'ACTIVE' } },
    select: { gameId: true },
  })
  return !!gamePlayer
}

/** Full member-facing lobby detail. NEVER includes passwordHash. */
export async function lobbyDetail(lobby: Lobby) {
  const [seats, activeGame] = await Promise.all([
    db.lobbySeat.findMany({
      where: { lobbyId: lobby.id },
      orderBy: { seatIndex: 'asc' },
      include: { user: { select: { username: true } } },
    }),
    getActiveLobbyGame(lobby.id),
  ])

  // LobbySeat.deckId has no Prisma relation — hydrate deck names + commanders separately.
  const deckIds = [...new Set(seats.map((s) => s.deckId).filter((id): id is string => !!id))]
  const decks = deckIds.length
    ? await db.deck.findMany({
        where: { id: { in: deckIds } },
        select: {
          id: true,
          name: true,
          cards: {
            where: { section: 'COMMANDER' },
            select: { card: { select: { name: true } } },
          },
        },
      })
    : []
  const deckById = new Map(decks.map((d) => [d.id, d]))

  return {
    id: lobby.id,
    inviteCode: lobby.inviteCode,
    name: lobby.name,
    hasPassword: !!lobby.passwordHash,
    visibility: lobby.visibility,
    mode: lobby.mode,
    status: lobby.status,
    hostId: lobby.hostId,
    maxSeats: lobby.maxSeats,
    activeGameId: activeGame?.id ?? null,
    seats: seats.map((s) => {
      const deck = s.deckId ? deckById.get(s.deckId) : undefined
      return {
        seatIndex: s.seatIndex,
        userId: s.userId,
        username: s.user.username,
        deckId: s.deckId,
        deckName: deck?.name ?? null,
        commanders: deck?.cards.map((c) => c.card.name) ?? [],
        isReady: s.isReady,
      }
    }),
  }
}
