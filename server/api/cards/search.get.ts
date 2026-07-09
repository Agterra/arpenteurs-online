import { z } from 'zod'

const Query = z.object({
  q: z.string().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export default defineEventHandler(async (event) => {
  // Each call runs a full-table trigram similarity scan — require a session and
  // throttle per trusted client IP so it can't be used for request-amplified
  // DoS against the single-node Postgres (SEC finding #2).
  await requireUser(event)
  // Per-IP first (protects the global bucket from a single noisy source), then a
  // topology-independent global backstop so the scan can't be amplified even if
  // the trusted-IP assumption is ever violated.
  if (
    !checkRateLimit(`cards-search:${getClientIp(event)}`, 120, 60_000) ||
    !checkRateLimit('cards-search:global', 600, 60_000)
  ) {
    throw createError({ statusCode: 429, statusMessage: 'Slow down' })
  }
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
