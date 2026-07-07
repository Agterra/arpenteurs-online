import { z } from 'zod'
import { parseDecklist } from '#shared/utils/decklistParse'

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  text: z.string().min(1).max(100_000),
  commit: z.boolean().default(false),
  skipUnresolved: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const { name, text, commit, skipUnresolved } = await readValidatedBody(event, Body.parse)

  const parsed = parseDecklist(text)
  const result = await resolveDecklist(parsed, dbCatalogLookup())

  let deckId: string | null = null
  if (commit && (result.unresolved.length === 0 || skipUnresolved)) {
    const deck = await db.deck.create({
      data: {
        ownerId: me.id,
        name,
        rawText: text,
        cards: {
          create: result.resolved.map((r) => ({
            cardId: r.cardId,
            section: r.section,
            quantity: r.qty,
          })),
        },
      },
    })
    deckId = deck.id
  }

  return {
    deckId,
    resolved: result.resolved,
    unresolved: result.unresolved,
    skipped: parsed.skipped,
    warnings: result.warnings,
    commander: result.commander,
  }
})
