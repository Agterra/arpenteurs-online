import { z } from 'zod'

const Body = z.object({ password: z.string().max(100).optional() })

async function takeLowestFreeSeat(lobbyId: string, userId: string, maxSeats: number) {
  await db.$transaction(async (tx) => {
    const seats = await tx.lobbySeat.findMany({ where: { lobbyId }, select: { seatIndex: true } })
    if (seats.length >= maxSeats)
      throw createError({ statusCode: 409, statusMessage: 'lobby_full', data: { error: 'lobby_full' } })
    const taken = new Set(seats.map((s) => s.seatIndex))
    let seatIndex = 0
    while (taken.has(seatIndex)) seatIndex++
    if (seatIndex >= maxSeats)
      throw createError({ statusCode: 409, statusMessage: 'lobby_full', data: { error: 'lobby_full' } })
    await tx.lobbySeat.create({ data: { lobbyId, userId, seatIndex } })
  })
}

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const code = getRouterParam(event, 'code')!

  if (!checkRateLimit(`join:${me.id}:${code}`, 5, 60_000))
    throw createError({ statusCode: 429, statusMessage: 'Too many join attempts — wait a minute' })

  const lobby = await getLobbyByCode(code)
  const body = await readValidatedBody(event, Body.parse)

  if (lobby.status !== 'OPEN') {
    const activeGame = await getActiveLobbyGame(lobby.id)
    if (activeGame) {
      const gamePlayer = await db.gamePlayer.findUnique({
        where: { gameId_userId: { gameId: activeGame.id, userId: me.id } },
      })
      if (gamePlayer) return { rejoin: true, gameId: activeGame.id }
    }
    throw createError({ statusCode: 409, statusMessage: 'Lobby is not open' })
  }

  // Already seated → idempotent success (no password re-check for members).
  const existing = await db.lobbySeat.findUnique({
    where: { lobbyId_userId: { lobbyId: lobby.id, userId: me.id } },
  })
  if (existing) return { ok: true, seatIndex: existing.seatIndex }

  if (lobby.passwordHash) {
    if (!body.password || !(await verifyPassword(body.password, lobby.passwordHash)))
      throw createError({ statusCode: 403, statusMessage: 'Wrong password' })
  }

  try {
    await takeLowestFreeSeat(lobby.id, me.id, lobby.maxSeats)
  } catch (err: unknown) {
    // @@unique([lobbyId,seatIndex]) / [lobbyId,userId] race backstop → retry once.
    if ((err as { code?: string })?.code !== 'P2002') throw err
    const raced = await db.lobbySeat.findUnique({
      where: { lobbyId_userId: { lobbyId: lobby.id, userId: me.id } },
    })
    if (raced) return { ok: true, seatIndex: raced.seatIndex }
    await takeLowestFreeSeat(lobby.id, me.id, lobby.maxSeats)
  }

  const seat = await db.lobbySeat.findUnique({
    where: { lobbyId_userId: { lobbyId: lobby.id, userId: me.id } },
  })
  return { ok: true, seatIndex: seat!.seatIndex }
})
