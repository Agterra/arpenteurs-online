export default defineEventHandler(async (event) => {
  const { deck } = await requireOwnedDeck(event, getRouterParam(event, 'id')!)
  await db.deck.delete({ where: { id: deck.id } })
  setResponseStatus(event, 204)
  return null
})
