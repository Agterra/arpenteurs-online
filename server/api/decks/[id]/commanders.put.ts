import { z } from 'zod'

const Body = z.object({ cardIds: z.array(z.string()).min(1).max(2) })

export default defineEventHandler(async (event) => {
  const { deck } = await requireOwnedDeck(event, getRouterParam(event, 'id')!)
  const { cardIds } = await readValidatedBody(event, Body.parse)

  await db.$transaction(async (tx) => {
    const rows = await tx.deckCard.findMany({ where: { deckId: deck.id } })
    const byCardSection = new Map(rows.map((r) => [`${r.cardId}:${r.section}`, r]))

    for (const cardId of cardIds) {
      if (!rows.some((r) => r.cardId === cardId))
        throw createError({ statusCode: 422, statusMessage: `Card ${cardId} is not in this deck` })
    }

    // demote current commanders back to MAIN (merge quantities)
    for (const r of rows.filter((r) => r.section === 'COMMANDER')) {
      const main = byCardSection.get(`${r.cardId}:MAIN`)
      if (main) {
        await tx.deckCard.update({ where: { id: main.id }, data: { quantity: main.quantity + r.quantity } })
        await tx.deckCard.delete({ where: { id: r.id } })
      } else {
        await tx.deckCard.update({ where: { id: r.id }, data: { section: 'MAIN' } })
      }
    }

    // promote the new ones: move 1 copy from MAIN to COMMANDER
    const fresh = await tx.deckCard.findMany({ where: { deckId: deck.id } })
    for (const cardId of cardIds) {
      const main = fresh.find((r) => r.cardId === cardId && r.section === 'MAIN')
      if (!main) throw createError({ statusCode: 422, statusMessage: `Card ${cardId} is not in the mainboard` })
      if (main.quantity > 1) {
        await tx.deckCard.update({ where: { id: main.id }, data: { quantity: main.quantity - 1 } })
        await tx.deckCard.create({ data: { deckId: deck.id, cardId, section: 'COMMANDER', quantity: 1 } })
      } else {
        await tx.deckCard.update({ where: { id: main.id }, data: { section: 'COMMANDER' } })
      }
    }
  })

  return { ok: true }
})
