/**
 * Batch card-display lookup for the enforced-mode client. RulesClientCard
 * carries only `defName` (= Card.nameNorm); the client fetches images/costs
 * here and caches them. Display data only — never rules or hidden info.
 */
import { z } from 'zod'
import { parseTokenDefName } from '#shared/utils/tokenDefName'

const Body = z.object({
  names: z.array(z.string().min(1).max(200)).max(400),
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  // Up to a 400-name IN() query per call — throttle per client (SEC finding #2).
  // Bursty at game start (client hydrates its card cache), so the window is
  // generous; it only caps abusive volume. Per-IP + topology-independent global
  // backstop (per-IP first protects the global bucket from a single source).
  if (
    !checkRateLimit(`cards-display:${getClientIp(event)}`, 120, 60_000) ||
    !checkRateLimit('cards-display:global', 600, 60_000)
  ) {
    throw createError({ statusCode: 429, statusMessage: 'Slow down' })
  }
  const { names } = await readValidatedBody(event, Body.parse)

  const rows = await db.card.findMany({
    where: { nameNorm: { in: names } },
    select: {
      nameNorm: true,
      name: true,
      manaCost: true,
      typeLine: true,
      oracleText: true,
      imageSmall: true,
      imageNormal: true,
      power: true,
      toughness: true,
    },
  })

  const cards: Record<
    string,
    {
      name: string
      manaCost: string | null
      typeLine: string
      oracleText: string | null
      imageSmall: string | null
      imageNormal: string | null
      power: string | null
      toughness: string | null
    }
  > = {}
  for (const c of rows)
    cards[c.nameNorm] = {
      name: c.name,
      manaCost: c.manaCost,
      typeLine: c.typeLine,
      oracleText: c.oracleText,
      imageSmall: c.imageSmall,
      imageNormal: c.imageNormal,
      power: c.power,
      toughness: c.toughness,
    }

  // Tokens (itok:/tok: defNames) aren't in the Card catalog — resolve a proper
  // name + P/T from the defName and attach representative art from TokenImage.
  const tokens = names.map((n) => ({ defName: n, parsed: parseTokenDefName(n) })).filter((t) => t.parsed)
  if (tokens.length) {
    const norms = [...new Set(tokens.map((t) => t.parsed!.nameNorm))]
    const art = await db.tokenImage.findMany({ where: { nameNorm: { in: norms } } })
    const byNorm = new Map(art.map((a) => [a.nameNorm, a]))
    for (const { defName, parsed } of tokens) {
      const p = parsed!
      const a = byNorm.get(p.nameNorm)
      cards[defName] = {
        name: p.name,
        manaCost: null,
        typeLine: a?.typeLine ?? `Token Creature — ${p.name}`,
        oracleText: null,
        imageSmall: a?.imageSmall ?? null,
        imageNormal: a?.imageNormal ?? null,
        power: p.power,
        toughness: p.toughness,
      }
    }
  }

  return { cards }
})
