import { z } from 'zod'

const Body = z.object({
  deckId: z.string().min(1).nullable().optional(),
  isReady: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const lobby = await getLobbyByCode(getRouterParam(event, 'code')!)
  const body = await readValidatedBody(event, Body.parse)

  if (lobby.status !== 'OPEN')
    throw createError({ statusCode: 409, statusMessage: 'Lobby is not open' })

  const seat = await db.lobbySeat.findUnique({
    where: { lobbyId_userId: { lobbyId: lobby.id, userId: me.id } },
  })
  if (!seat) throw createError({ statusCode: 404, statusMessage: 'You are not seated in this lobby' })

  const deckProvided = body.deckId !== undefined
  const nextDeckId = deckProvided ? body.deckId : seat.deckId

  if (deckProvided && body.deckId) {
    const deck = await db.deck.findUnique({ where: { id: body.deckId }, select: { ownerId: true } })
    if (!deck) throw createError({ statusCode: 404, statusMessage: 'Deck not found' })
    if (deck.ownerId !== me.id) throw createError({ statusCode: 403, statusMessage: 'Not your deck' })
  }

  // Any deck change forces isReady=false unless isReady:true is explicitly
  // passed in the same call (and passes the commander check below).
  const deckChanged = deckProvided && body.deckId !== seat.deckId
  let nextReady = body.isReady ?? (deckChanged ? false : seat.isReady)

  if (body.isReady === true) {
    if (!nextDeckId) throw createError({ statusCode: 422, statusMessage: 'Pick a deck first' })
    // Commander is a Commander-format requirement — enforced duels (1v1) skip it.
    if (lobby.mode !== 'ENFORCED') {
      const commanderCount = await db.deckCard.count({
        where: { deckId: nextDeckId, section: 'COMMANDER' },
      })
      if (commanderCount < 1)
        throw createError({ statusCode: 422, statusMessage: 'Deck needs a commander' })
    }
    nextReady = true
  }

  const updated = await db.lobbySeat.update({
    where: { id: seat.id },
    data: { deckId: nextDeckId, isReady: nextReady },
  })

  return { seat: { seatIndex: updated.seatIndex, deckId: updated.deckId, isReady: updated.isReady } }
})
