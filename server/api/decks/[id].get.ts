export default defineEventHandler(async (event) => {
  const { deck } = await requireOwnedDeck(event, getRouterParam(event, 'id')!)
  const cards = await db.deckCard.findMany({
    where: { deckId: deck.id },
    include: {
      card: {
        select: {
          id: true,
          name: true,
          manaCost: true,
          manaValue: true,
          typeLine: true,
          colorIdentity: true,
          imageSmall: true,
          imageNormal: true,
          canBeCommander: true,
          commanderLegality: true,
        },
      },
    },
    orderBy: [{ section: 'asc' }, { card: { name: 'asc' } }],
  })
  return {
    deck: {
      id: deck.id,
      name: deck.name,
      rawText: deck.rawText,
      cards: cards.map((c) => ({ qty: c.quantity, section: c.section, card: c.card })),
    },
  }
})
