export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const gameId = getRouterParam(event, 'id')!
  const membership = await db.gamePlayer.findUnique({
    where: { gameId_userId: { gameId, userId: me.id } },
    include: {
      game: {
        select: {
          status: true,
          lobbyId: true,
          players: { include: { user: { select: { id: true, username: true } } } },
        },
      },
    },
  })
  if (!membership) throw createError({ statusCode: 403, statusMessage: 'Not a player of this game' })
  return {
    game: {
      id: gameId,
      status: membership.game.status,
      lobbyId: membership.game.lobbyId,
      you: me.id,
      players: membership.game.players.map((p) => ({
        id: p.user.id,
        username: p.user.username,
        seat: p.seatIndex,
      })),
      wsPath: `/ws/game?g=${gameId}`,
    },
  }
})
