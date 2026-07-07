import { liveRoomStats } from '../../game/room'

interface DayRow {
  day: Date
  count: number
}

function series(rows: DayRow[]): { day: string; count: number }[] {
  return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), count: Number(r.count) }))
}

export default defineEventHandler(async (event) => {
  requireAdmin(event)

  const [
    userCount,
    deckCount,
    cardAgg,
    lobbiesByStatus,
    gamesByStatus,
    usersPerDay,
    lobbiesPerDay,
    gamesStartedPerDay,
    gamesFinishedPerDay,
    durationRows,
    eventsPerGameRows,
    live,
  ] = await Promise.all([
    db.user.count(),
    db.deck.count(),
    db.card.aggregate({ _count: true, _max: { importedAt: true } }),
    db.lobby.groupBy({ by: ['status'], _count: true }),
    db.game.groupBy({ by: ['status'], _count: true }),
    db.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS count
      FROM "User" WHERE "createdAt" >= now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS count
      FROM "Lobby" WHERE "createdAt" >= now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "startedAt") AS day, COUNT(*)::int AS count
      FROM "Game" WHERE "startedAt" >= now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "endedAt") AS day, COUNT(*)::int AS count
      FROM "Game"
      WHERE status = 'FINISHED'::"GameStatus" AND "endedAt" >= now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<{ count: number; avg: number | null; p50: number | null; p90: number | null }[]>`
      SELECT COUNT(*)::int AS count,
             avg(EXTRACT(EPOCH FROM ("endedAt" - "startedAt")))::float AS avg,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("endedAt" - "startedAt")))::float AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("endedAt" - "startedAt")))::float AS p90
      FROM "Game"
      WHERE status = 'FINISHED'::"GameStatus" AND "endedAt" IS NOT NULL`,
    db.$queryRaw<{ avg: number | null }[]>`
      SELECT avg(c)::float AS avg FROM (
        SELECT COUNT(e.id)::int AS c
        FROM "Game" g LEFT JOIN "GameEvent" e ON e."gameId" = g.id
        WHERE g.status = 'FINISHED'::"GameStatus"
        GROUP BY g.id
      ) sub`,
    liveRoomStats(),
  ])

  const duration = durationRows[0]
  return {
    totals: {
      users: userCount,
      decks: deckCount,
      cards: cardAgg._count,
      lobbiesByStatus: Object.fromEntries(lobbiesByStatus.map((r) => [r.status, r._count])),
      gamesByStatus: Object.fromEntries(gamesByStatus.map((r) => [r.status, r._count])),
    },
    perDay: {
      usersCreated: series(usersPerDay),
      lobbiesCreated: series(lobbiesPerDay),
      gamesStarted: series(gamesStartedPerDay),
      gamesFinished: series(gamesFinishedPerDay),
    },
    gameDuration: {
      finishedCount: Number(duration?.count ?? 0),
      avgSeconds: duration?.avg ?? null,
      p50Seconds: duration?.p50 ?? null,
      p90Seconds: duration?.p90 ?? null,
    },
    avgEventsPerFinishedGame: eventsPerGameRows[0]?.avg ?? null,
    catalog: {
      cards: cardAgg._count,
      lastImportedAt: cardAgg._max.importedAt,
    },
    live: {
      rooms: live,
      roomCount: live.length,
      connectedPeers: live.reduce((sum, r) => sum + r.connectedPlayers, 0),
    },
  }
})
