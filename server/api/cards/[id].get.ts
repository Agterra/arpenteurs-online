export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const card = await db.card.findUnique({ where: { id } })
  if (!card) throw createError({ statusCode: 404, statusMessage: 'Card not found' })
  return { card }
})
