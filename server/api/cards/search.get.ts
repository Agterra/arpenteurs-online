import { z } from 'zod'

const Query = z.object({
  q: z.string().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export default defineEventHandler(async (event) => {
  const { q, limit } = await getValidatedQuery(event, Query.parse)
  const nq = norm(q)

  // Prefix matches first (autocomplete feel), then trigram similarity (typo tolerance).
  const results = await db.$queryRaw`
    SELECT id, name, "manaCost", "typeLine", "imageSmall", "canBeCommander",
           ("nameNorm" LIKE ${nq + '%'}) AS "isPrefix",
           similarity("nameNorm", ${nq}) AS sim
    FROM "Card"
    WHERE "nameNorm" LIKE ${nq + '%'} OR "nameNorm" % ${nq}
    ORDER BY "isPrefix" DESC,
             CASE WHEN "nameNorm" LIKE ${nq + '%'} THEN "edhrecRank" END ASC NULLS LAST,
             sim DESC
    LIMIT ${limit}
  `
  return { results }
})
