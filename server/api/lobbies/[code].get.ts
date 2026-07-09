export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const lobby = await getLobbyByCode(getRouterParam(event, 'code')!)

  if (await isLobbyMember(lobby.id, me.id)) {
    return { member: true as const, ...(await lobbyDetail(lobby)) }
  }

  // Non-member preview: no invite code echo, no seats, never passwordHash.
  const seatCount = await db.lobbySeat.count({ where: { lobbyId: lobby.id } })
  return {
    member: false as const,
    name: lobby.name,
    hasPassword: !!lobby.passwordHash,
    mode: lobby.mode,
    status: lobby.status,
    seatCount,
    maxSeats: lobby.maxSeats,
  }
})
