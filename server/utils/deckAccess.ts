import type { H3Event } from 'h3'

export async function requireOwnedDeck(event: H3Event, deckId: string) {
  const me = await requireUser(event)
  const deck = await db.deck.findUnique({ where: { id: deckId } })
  if (!deck) throw createError({ statusCode: 404, statusMessage: 'Deck not found' })
  if (deck.ownerId !== me.id) throw createError({ statusCode: 403, statusMessage: 'Not your deck' })
  return { me, deck }
}
