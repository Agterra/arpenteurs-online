import { z } from 'zod'

const Body = z.object({
  name: z.string().trim().min(1).max(60),
  password: z.string().min(4).max(100).optional(),
  visibility: z.enum(['PUBLIC', 'UNLISTED']).default('UNLISTED'),
})

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const { name, password, visibility } = await readValidatedBody(event, Body.parse)

  const passwordHash = password ? await hashPassword(password) : null

  // Invite-code collision is ~impossible (62^10) but the unique constraint is
  // the backstop — retry a couple of times on P2002 just in case.
  for (let attempt = 0; ; attempt++) {
    try {
      const lobby = await db.lobby.create({
        data: {
          inviteCode: generateInviteCode(),
          name,
          passwordHash,
          visibility,
          hostId: me.id,
          status: 'OPEN',
          maxSeats: 4,
          seats: { create: { userId: me.id, seatIndex: 0 } },
        },
      })
      return { lobby: await lobbyDetail(lobby) }
    } catch (err: unknown) {
      const isUniqueViolation = (err as { code?: string })?.code === 'P2002'
      if (!isUniqueViolation || attempt >= 2) throw err
    }
  }
})
