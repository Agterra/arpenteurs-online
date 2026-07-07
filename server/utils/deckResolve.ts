import type { ParsedDecklist, ParsedEntry } from '#shared/utils/decklistParse'
import { norm } from '#shared/utils/norm'

export interface CatalogCard {
  id: string
  name: string
  canBeCommander: boolean
  commanderLegality: 'LEGAL' | 'BANNED' | 'RESTRICTED' | 'NOT_LEGAL'
  colorIdentity: string[]
  supertypes: string[]
  hasAltDeckLimit: boolean
  imageSmall: string | null
}

export interface Suggestion {
  cardId: string
  name: string
  score: number
}

/** Injectable for unit tests; production impl is dbCatalogLookup below. */
export interface CatalogLookup {
  byNorm(norms: string[]): Promise<Map<string, CatalogCard>>
  byAlias(aliases: string[]): Promise<Map<string, CatalogCard>>
  suggest(q: string): Promise<Suggestion[]>
}

export interface ResolvedLine {
  line: number
  qty: number
  cardId: string
  name: string
  section: 'COMMANDER' | 'MAIN'
}

export interface UnresolvedLine {
  line: number
  raw: string
  qty: number
  query: string
  reason: 'not_found'
  suggestions: Suggestion[]
}

export interface DeckWarning {
  code:
    | 'CARD_COUNT'
    | 'DUPLICATE_NONBASIC'
    | 'BANNED_IN_COMMANDER'
    | 'NOT_LEGAL_IN_COMMANDER'
    | 'NOT_A_COMMANDER'
    | 'TOO_MANY_COMMANDERS'
    | 'COLOR_IDENTITY'
  name?: string
  count?: number
}

export interface ResolveResult {
  resolved: ResolvedLine[]
  unresolved: UnresolvedLine[]
  warnings: DeckWarning[]
  commander: { designated: string[]; guess: string[]; required: boolean }
}

/** All lookup keys an entry can resolve through, in priority order. */
function candidatesFor(rawName: string): string[] {
  const out: string[] = [norm(rawName)]
  if (rawName.includes('/')) {
    const canonical = norm(rawName.replace(/\s*\/{1,2}\s*/g, ' // '))
    if (!out.includes(canonical)) out.push(canonical)
    const front = norm(rawName.split('/')[0]!)
    if (front && !out.includes(front)) out.push(front)
  }
  return out
}

export async function resolveDecklist(
  parsed: ParsedDecklist,
  lookup: CatalogLookup,
): Promise<ResolveResult> {
  const active = parsed.entries.filter((e) => e.section !== 'IGNORED')
  const allCandidates = [...new Set(active.flatMap((e) => candidatesFor(e.name)))]
  const [normMap, aliasMap] = await Promise.all([
    lookup.byNorm(allCandidates),
    lookup.byAlias(allCandidates),
  ])

  const resolvedRaw: (ResolvedLine & { card: CatalogCard })[] = []
  const unresolved: UnresolvedLine[] = []

  for (const entry of active) {
    let card: CatalogCard | undefined
    for (const cand of candidatesFor(entry.name)) {
      card = normMap.get(cand) ?? aliasMap.get(cand)
      if (card) break
    }
    if (card) {
      resolvedRaw.push({
        line: entry.line,
        qty: entry.qty,
        cardId: card.id,
        name: card.name,
        section: entry.section === 'COMMANDER' ? 'COMMANDER' : 'MAIN',
        card,
      })
    } else {
      const query = norm(entry.name)
      unresolved.push({
        line: entry.line,
        raw: entry.name,
        qty: entry.qty,
        query,
        reason: 'not_found',
        suggestions: await lookup.suggest(query),
      })
    }
  }

  // merge duplicate (cardId, section) lines, summing quantities
  const merged = new Map<string, ResolvedLine & { card: CatalogCard }>()
  for (const r of resolvedRaw) {
    const key = `${r.cardId}:${r.section}`
    const prev = merged.get(key)
    if (prev) prev.qty += r.qty
    else merged.set(key, { ...r })
  }
  const resolved = [...merged.values()]

  // ---- warnings (never blocking — house rules & proxies are allowed) ----
  const warnings: DeckWarning[] = []
  const total = resolved.reduce((n, r) => n + r.qty, 0)
  if (total !== 100) warnings.push({ code: 'CARD_COUNT', count: total })

  const qtyByCard = new Map<string, { card: CatalogCard; qty: number }>()
  for (const r of resolved) {
    const prev = qtyByCard.get(r.cardId)
    if (prev) prev.qty += r.qty
    else qtyByCard.set(r.cardId, { card: r.card, qty: r.qty })
  }
  for (const { card, qty } of qtyByCard.values()) {
    if (qty > 1 && !card.supertypes.includes('Basic') && !card.hasAltDeckLimit)
      warnings.push({ code: 'DUPLICATE_NONBASIC', name: card.name, count: qty })
    if (card.commanderLegality === 'BANNED')
      warnings.push({ code: 'BANNED_IN_COMMANDER', name: card.name })
    else if (card.commanderLegality !== 'LEGAL')
      warnings.push({ code: 'NOT_LEGAL_IN_COMMANDER', name: card.name })
  }

  // ---- commander designation ----
  const designatedLines = resolved.filter((r) => r.section === 'COMMANDER')
  const designated = designatedLines.map((r) => r.cardId)
  if (designated.length > 2) warnings.push({ code: 'TOO_MANY_COMMANDERS', count: designated.length })
  for (const r of designatedLines) {
    if (!r.card.canBeCommander) warnings.push({ code: 'NOT_A_COMMANDER', name: r.name })
  }

  let guess: string[] = []
  if (!designated.length && parsed.firstBlockIfHeaderless.length) {
    const guessCards = parsed.firstBlockIfHeaderless
      .map((e: ParsedEntry) => {
        for (const cand of candidatesFor(e.name)) {
          const c = normMap.get(cand) ?? aliasMap.get(cand)
          if (c) return c
        }
        return undefined
      })
      .filter((c): c is CatalogCard => !!c)
    if (guessCards.length === parsed.firstBlockIfHeaderless.length && guessCards.every((c) => c.canBeCommander))
      guess = guessCards.map((c) => c.id)
  }

  // color identity check only when commanders are known
  if (designated.length >= 1 && designated.length <= 2) {
    const ci = new Set(designatedLines.flatMap((r) => r.card.colorIdentity))
    for (const { card } of qtyByCard.values()) {
      if (designated.includes(card.id)) continue
      if (card.colorIdentity.some((c) => !ci.has(c)))
        warnings.push({ code: 'COLOR_IDENTITY', name: card.name })
    }
  }

  return {
    resolved: resolved.map(({ card: _card, ...r }) => r),
    unresolved,
    warnings,
    commander: { designated, guess, required: designated.length === 0 },
  }
}

// ---------- production lookup backed by Postgres ----------

const CARD_SELECT =
  'id, name, "canBeCommander", "commanderLegality"::text AS "commanderLegality", "colorIdentity", supertypes, "hasAltDeckLimit", "imageSmall"'

export function dbCatalogLookup(): CatalogLookup {
  return {
    async byNorm(norms) {
      if (!norms.length) return new Map()
      const rows = await db.$queryRawUnsafe<(CatalogCard & { nameNorm: string })[]>(
        `SELECT ${CARD_SELECT}, "nameNorm" FROM "Card" WHERE "nameNorm" = ANY($1)`,
        norms,
      )
      return new Map(rows.map((r) => [r.nameNorm, r]))
    },
    async byAlias(aliases) {
      if (!aliases.length) return new Map()
      const rows = await db.$queryRawUnsafe<(CatalogCard & { alias: string })[]>(
        `SELECT ${CARD_SELECT}, a.alias FROM "CardAlias" a JOIN "Card" c ON c.id = a."cardId" WHERE a.alias = ANY($1)`,
        aliases,
      )
      return new Map(rows.map((r) => [r.alias, r]))
    },
    async suggest(q) {
      const rows = await db.$queryRaw<{ cardId: string; name: string; score: number }[]>`
        SELECT id AS "cardId", name, similarity("nameNorm", ${q})::float AS score
        FROM "Card" WHERE "nameNorm" % ${q}
        ORDER BY score DESC LIMIT 5`
      return rows.filter((r) => r.score >= 0.35)
    },
  }
}
