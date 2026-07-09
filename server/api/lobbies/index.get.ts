// Public lobby list: PUBLIC + OPEN only. UNLISTED lobbies (and their invite
// codes) must never appear here — the invite link is their only discovery path.
export default defineEventHandler(async (event) => {
  await requireUser(event)

  const lobbies = await db.lobby.findMany({
    where: { visibility: 'PUBLIC', status: 'OPEN' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      seats: { select: { userId: true, user: { select: { username: true } } } },
    },
  })

  return {
    lobbies: lobbies.map((l) => ({
      inviteCode: l.inviteCode,
      name: l.name,
      hasPassword: !!l.passwordHash,
      mode: l.mode,
      seatCount: l.seats.length,
      maxSeats: l.maxSeats,
      hostName: l.seats.find((s) => s.userId === l.hostId)?.user.username ?? null,
      createdAt: l.createdAt,
    })),
  }
})
