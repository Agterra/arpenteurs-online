import { z } from 'zod'
import { Prisma } from '../../generated/prisma/client'

const Query = z.object({
  q: z.string().max(100).optional(),
  layout: z.string().max(30).optional(),
  legality: z.enum(['LEGAL', 'BANNED', 'RESTRICTED', 'NOT_LEGAL']).optional(),
  page: z.coerce.number().int().min(1).default(1),
})
const PAGE_SIZE = 50

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const { q, layout, legality, page } = await getValidatedQuery(event, Query.parse)
  const nq = q ? norm(q) : ''
  const offset = (page - 1) * PAGE_SIZE

  // Same prefix + trigram approach as /api/cards/search, composed with filters.
  const conds: Prisma.Sql[] = []
  if (nq.length >= 2) conds.push(Prisma.sql`("nameNorm" LIKE ${nq + '%'} OR "nameNorm" % ${nq})`)
  else if (nq.length === 1) conds.push(Prisma.sql`"nameNorm" LIKE ${nq + '%'}`)
  if (layout) conds.push(Prisma.sql`"layout" = ${layout}`)
  if (legality) conds.push(Prisma.sql`"commanderLegality" = ${legality}::"CommanderLegality"`)
  const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty

  const order =
    nq.length >= 2
      ? Prisma.sql`ORDER BY ("nameNorm" LIKE ${nq + '%'}) DESC,
          CASE WHEN "nameNorm" LIKE ${nq + '%'} THEN "edhrecRank" END ASC NULLS LAST,
          similarity("nameNorm", ${nq}) DESC`
      : Prisma.sql`ORDER BY "name" ASC`

  const [countRows, cards] = await Promise.all([
    db.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS total FROM "Card" ${where}`),
    db.$queryRaw<
      {
        id: string
        name: string
        layout: string
        manaCost: string | null
        typeLine: string
        commanderLegality: string
        canBeCommander: boolean
        edhrecRank: number | null
        imageSmall: string | null
        importedAt: Date
      }[]
    >(Prisma.sql`
      SELECT id, name, layout, "manaCost", "typeLine", "commanderLegality"::text AS "commanderLegality",
             "canBeCommander", "edhrecRank", "imageSmall", "importedAt"
      FROM "Card" ${where} ${order}
      LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
  ])

  return {
    page,
    pageSize: PAGE_SIZE,
    total: Number(countRows[0]?.total ?? 0),
    cards,
  }
})
