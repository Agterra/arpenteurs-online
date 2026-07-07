import { z } from 'zod'

const Body = z.object({ name: z.string().trim().min(1).max(80) })

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const { name } = await readValidatedBody(event, Body.parse)
  const deck = await db.deck.create({ data: { ownerId: me.id, name } })
  return { deck: { id: deck.id, name: deck.name } }
})
