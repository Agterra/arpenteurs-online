import { z } from 'zod'

const Body = z.object({ userId: z.string().min(1) })

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const lobby = await getLobbyByCode(getRouterParam(event, 'code')!)
  const { userId } = await readValidatedBody(event, Body.parse)

  if (lobby.hostId !== me.id)
    throw createError({ statusCode: 403, statusMessage: 'Only the host can kick' })
  if (userId === me.id)
    throw createError({ statusCode: 422, statusMessage: 'Use leave instead of kicking yourself' })
  if (lobby.status === 'IN_GAME')
    throw createError({ statusCode: 409, statusMessage: 'in-game kick lands with the game engine' })
  if (lobby.status !== 'OPEN')
    throw createError({ statusCode: 409, statusMessage: 'Lobby is not open' })

  const seat = await db.lobbySeat.findUnique({
    where: { lobbyId_userId: { lobbyId: lobby.id, userId } },
  })
  if (!seat) throw createError({ statusCode: 404, statusMessage: 'That user is not seated here' })

  await db.lobbySeat.delete({ where: { id: seat.id } })

  setResponseStatus(event, 204)
  return null
})
