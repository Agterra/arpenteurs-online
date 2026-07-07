export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const lobby = await getLobbyByCode(getRouterParam(event, 'code')!)

  if (lobby.status !== 'OPEN')
    throw createError({ statusCode: 409, statusMessage: 'Can only leave an open lobby' })

  const seat = await db.lobbySeat.findUnique({
    where: { lobbyId_userId: { lobbyId: lobby.id, userId: me.id } },
  })
  if (!seat) throw createError({ statusCode: 404, statusMessage: 'You are not seated in this lobby' })

  await db.$transaction(async (tx) => {
    await tx.lobbySeat.delete({ where: { id: seat.id } })
    const remaining = await tx.lobbySeat.findMany({
      where: { lobbyId: lobby.id },
      orderBy: { seatIndex: 'asc' },
    })
    if (remaining.length === 0) {
      await tx.lobby.update({ where: { id: lobby.id }, data: { status: 'FINISHED' } })
    } else if (lobby.hostId === me.id) {
      await tx.lobby.update({ where: { id: lobby.id }, data: { hostId: remaining[0]!.userId } })
    }
  })

  setResponseStatus(event, 204)
  return null
})
