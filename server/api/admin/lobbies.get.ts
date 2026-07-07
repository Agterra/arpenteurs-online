import { z } from 'zod'

const Query = z.object({ page: z.coerce.number().int().min(1).default(1) })
const PAGE_SIZE = 25

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const { page } = await getValidatedQuery(event, Query.parse)

  const [total, lobbies] = await Promise.all([
    db.lobby.count(),
    db.lobby.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        seats: {
          orderBy: { seatIndex: 'asc' },
          select: { seatIndex: true, userId: true, isReady: true, user: { select: { username: true } } },
        },
        _count: { select: { games: true } },
      },
    }),
  ])

  return {
    page,
    pageSize: PAGE_SIZE,
    total,
    lobbies: lobbies.map((l) => ({
      id: l.id,
      inviteCode: l.inviteCode,
      name: l.name,
      status: l.status,
      visibility: l.visibility,
      hasPassword: !!l.passwordHash,
      hostName: l.seats.find((s) => s.userId === l.hostId)?.user.username ?? null,
      seatCount: l.seats.length,
      maxSeats: l.maxSeats,
      seats: l.seats.map((s) => ({ seatIndex: s.seatIndex, username: s.user.username, isReady: s.isReady })),
      gameCount: l._count.games,
      createdAt: l.createdAt,
    })),
  }
})
