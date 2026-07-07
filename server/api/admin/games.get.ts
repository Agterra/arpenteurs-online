import { z } from 'zod'
import { liveRoomStats } from '../../game/room'

const Query = z.object({ page: z.coerce.number().int().min(1).default(1) })
const PAGE_SIZE = 25

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const { page } = await getValidatedQuery(event, Query.parse)

  const [total, games, live] = await Promise.all([
    db.game.count(),
    // Explicit select — the snapshot Json must never leave the server (hidden info).
    db.game.findMany({
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        status: true,
        snapshotSeq: true,
        startedAt: true,
        endedAt: true,
        winnerSeat: true,
        lobby: { select: { name: true, inviteCode: true } },
        players: {
          orderBy: { seatIndex: 'asc' },
          select: { seatIndex: true, user: { select: { username: true } } },
        },
        _count: { select: { events: true } },
      },
    }),
    liveRoomStats(),
  ])

  const liveByGame = new Map(live.map((r) => [r.gameId, r]))

  return {
    page,
    pageSize: PAGE_SIZE,
    total,
    games: games.map((g) => {
      const liveInfo = liveByGame.get(g.id)
      return {
        id: g.id,
        lobbyName: g.lobby.name,
        inviteCode: g.lobby.inviteCode,
        status: g.status,
        players: g.players.map((p) => ({ seatIndex: p.seatIndex, username: p.user.username })),
        startedAt: g.startedAt,
        endedAt: g.endedAt,
        durationSeconds: g.endedAt ? Math.round((g.endedAt.getTime() - g.startedAt.getTime()) / 1000) : null,
        snapshotSeq: g.snapshotSeq,
        eventCount: g._count.events,
        winnerSeat: g.winnerSeat,
        live: liveInfo
          ? {
              connectedPlayers: liveInfo.connectedPlayers,
              turnNumber: liveInfo.turnNumber,
              step: liveInfo.step,
              status: liveInfo.status,
              seq: liveInfo.seq,
            }
          : null,
      }
    }),
  }
})
