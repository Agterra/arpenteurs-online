import { z } from 'zod'

const Body = z.object({ name: z.string().trim().min(1).max(80) })

export default defineEventHandler(async (event) => {
  const { deck } = await requireOwnedDeck(event, getRouterParam(event, 'id')!)
  const { name } = await readValidatedBody(event, Body.parse)
  const updated = await db.deck.update({ where: { id: deck.id }, data: { name } })
  return { deck: { id: updated.id, name: updated.name } }
})
