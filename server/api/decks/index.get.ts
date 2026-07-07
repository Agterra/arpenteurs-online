export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const decks = await db.deck.findMany({
    where: { ownerId: me.id },
    orderBy: { updatedAt: 'desc' },
    include: {
      cards: {
        where: { section: 'COMMANDER' },
        include: { card: { select: { id: true, name: true, imageSmall: true } } },
      },
      _count: { select: { cards: true } },
    },
  })
  return {
    decks: decks.map((d) => ({
      id: d.id,
      name: d.name,
      updatedAt: d.updatedAt,
      commanders: d.cards.map((c) => c.card),
    })),
  }
})
