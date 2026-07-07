/**
 * Card catalog import: MTGJSON AtomicCards (source of truth) joined with
 * Scryfall oracle_cards bulk data (images) on scryfallOracleId ⇔ oracle_id.
 *
 * Run: pnpm cards:import  (idempotent — safe to re-run weekly / after set releases)
 * Flags: --include-acorn   also import cards with no commander legality (as NOT_LEGAL)
 *        --fresh           ignore the 24h download cache
 *
 * Uses `pg` directly (not Prisma) for bulk jsonb_to_recordset upserts.
 */
import { createGunzip, gunzipSync } from 'node:zlib'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import {
  skipReason,
  mapCard,
  buildAliases,
  extractImages,
  preferKey,
  type AtomicFace,
  type ScryfallImages,
  type CardRow,
  type SkipReason,
} from './lib/cards.ts'

const ATOMIC_URL = 'https://mtgjson.com/api/v5/AtomicCards.json.gz'
const BULK_INDEX_URL = 'https://api.scryfall.com/bulk-data/oracle_cards'
const USER_AGENT = process.env.NUXT_SCRYFALL_USER_AGENT ?? 'arpenteurs/0.1'
const CACHE_DIR = '.cache'
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CHUNK = 1000

const includeAcorn = process.argv.includes('--include-acorn')
const fresh = process.argv.includes('--fresh')

function log(msg: string) {
  console.log(`[import] ${msg}`)
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res
}

/** Download to .cache (reused for 24h unless --fresh) and return the local path. */
async function download(url: string, filename: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const path = `${CACHE_DIR}/${filename}`
  if (!fresh && existsSync(path) && Date.now() - statSync(path).mtimeMs < CACHE_MAX_AGE_MS) {
    log(`using cached ${path}`)
    return path
  }
  log(`downloading ${url} …`)
  const res = await fetchOk(url)
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  log(`saved ${path} (${(statSync(path).size / 1e6).toFixed(1)} MB)`)
  return path
}

async function loadScryfallImageMap(): Promise<Map<string, ScryfallImages>> {
  const index = (await (await fetchOk(BULK_INDEX_URL)).json()) as {
    download_uri?: string
    jsonl_download_uri?: string
  }
  const uri = index.jsonl_download_uri ?? index.download_uri
  if (!uri) throw new Error('oracle_cards bulk entry has no download uri')
  const isJsonl = !!index.jsonl_download_uri
  const path = await download(uri, isJsonl ? 'oracle-cards.jsonl.gz' : 'oracle-cards.json')

  const map = new Map<string, ScryfallImages>()
  if (isJsonl) {
    const rl = createInterface({
      input: Readable.from(readFileSync(path)).pipe(createGunzip()),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      const sf = JSON.parse(line)
      if (sf.oracle_id) map.set(sf.oracle_id, extractImages(sf))
    }
  } else {
    for (const sf of JSON.parse(readFileSync(path, 'utf8'))) {
      if (sf.oracle_id) map.set(sf.oracle_id, extractImages(sf))
    }
  }
  log(`scryfall image map: ${map.size} oracle ids`)
  return map
}

async function loadAtomic(): Promise<Record<string, AtomicFace[]>> {
  const path = await download(ATOMIC_URL, 'AtomicCards.json.gz')
  log('parsing AtomicCards …')
  const json = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
  log(`AtomicCards build ${json.meta?.version ?? '?'} — ${Object.keys(json.data).length} names`)
  return json.data
}

async function main() {
  const t0 = performance.now()
  const [imageMap, atomic] = await Promise.all([loadScryfallImageMap(), loadAtomic()])

  // ---- filter, dedupe by oracle id, map ----
  const skips: Record<SkipReason, number> = {
    layout: 0,
    alchemy: 0,
    reversible_duplicate: 0,
    no_commander_legality: 0,
    no_oracle_id: 0,
  }
  const byOracle = new Map<string, { key: string; faces: AtomicFace[] }>()
  for (const [name, faces] of Object.entries(atomic)) {
    const reason = skipReason(name, faces, { includeAcorn })
    if (reason) {
      skips[reason]++
      continue
    }
    const oid = faces[0]!.identifiers!.scryfallOracleId!
    const existing = byOracle.get(oid)
    if (existing) {
      const kept = preferKey(existing.key, name)
      if (kept !== existing.key) byOracle.set(oid, { key: name, faces })
    } else {
      byOracle.set(oid, { key: name, faces })
    }
  }

  const joinMisses: string[] = []
  const rows: Omit<CardRow, 'id'>[] = []
  for (const { key, faces } of byOracle.values()) {
    const oid = faces[0]!.identifiers!.scryfallOracleId!
    const images = imageMap.get(oid) ?? null
    if (!images) joinMisses.push(key)
    rows.push(mapCard(key, faces, images))
  }

  // nameNorm must be unique — detect collisions before writing (first wins)
  const seenNorm = new Map<string, string>()
  const deduped = rows.filter((r) => {
    const prev = seenNorm.get(r.nameNorm)
    if (prev) {
      log(`⚠ nameNorm collision: "${r.name}" collides with "${prev}" — keeping the first`)
      return false
    }
    seenNorm.set(r.nameNorm, r.name)
    return true
  })

  log(
    `kept ${deduped.length} cards | skips: ${Object.entries(skips)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')} | image join misses: ${joinMisses.length}`,
  )
  if (joinMisses.length) log(`⚠ join misses (imported without images): ${joinMisses.slice(0, 20).join(', ')}${joinMisses.length > 20 ? ' …' : ''}`)

  // ---- upsert ----
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const existing = await client.query<{ scryfallOracleId: string }>(
      'SELECT "scryfallOracleId" FROM "Card"',
    )
    const existingIds = new Set(existing.rows.map((r) => r.scryfallOracleId))

    const upsertSql = `
      INSERT INTO "Card" (
        id, "scryfallOracleId", "scryfallId", name, "nameNorm", "asciiName", "faceNames",
        layout, "manaCost", "manaValue", "typeLine", "oracleText", power, toughness,
        loyalty, defense, colors, "colorIdentity", keywords, supertypes,
        "commanderLegality", "canBeCommander", "hasAltDeckLimit", "isFunny", "edhrecRank",
        faces, "imageSmall", "imageNormal", "backImageSmall", "backImageNormal", "importedAt"
      )
      SELECT
        x.id, x."scryfallOracleId"::uuid, x."scryfallId"::uuid, x.name, x."nameNorm", x."asciiName", x."faceNames",
        x.layout, x."manaCost", x."manaValue", x."typeLine", x."oracleText", x.power, x.toughness,
        x.loyalty, x.defense, x.colors, x."colorIdentity", x.keywords, x.supertypes,
        x."commanderLegality"::"CommanderLegality", x."canBeCommander", x."hasAltDeckLimit", x."isFunny", x."edhrecRank",
        x.faces, x."imageSmall", x."imageNormal", x."backImageSmall", x."backImageNormal", now()
      FROM jsonb_to_recordset($1::jsonb) AS x(
        id text, "scryfallOracleId" text, "scryfallId" text, name text, "nameNorm" text,
        "asciiName" text, "faceNames" text[], layout text, "manaCost" text, "manaValue" float8,
        "typeLine" text, "oracleText" text, power text, toughness text, loyalty text, defense text,
        colors text[], "colorIdentity" text[], keywords text[], supertypes text[],
        "commanderLegality" text, "canBeCommander" boolean, "hasAltDeckLimit" boolean,
        "isFunny" boolean, "edhrecRank" int, faces jsonb, "imageSmall" text, "imageNormal" text,
        "backImageSmall" text, "backImageNormal" text
      )
      ON CONFLICT ("scryfallOracleId") DO UPDATE SET
        "scryfallId" = EXCLUDED."scryfallId", name = EXCLUDED.name, "nameNorm" = EXCLUDED."nameNorm",
        "asciiName" = EXCLUDED."asciiName", "faceNames" = EXCLUDED."faceNames", layout = EXCLUDED.layout,
        "manaCost" = EXCLUDED."manaCost", "manaValue" = EXCLUDED."manaValue", "typeLine" = EXCLUDED."typeLine",
        "oracleText" = EXCLUDED."oracleText", power = EXCLUDED.power, toughness = EXCLUDED.toughness,
        loyalty = EXCLUDED.loyalty, defense = EXCLUDED.defense, colors = EXCLUDED.colors,
        "colorIdentity" = EXCLUDED."colorIdentity", keywords = EXCLUDED.keywords, supertypes = EXCLUDED.supertypes,
        "commanderLegality" = EXCLUDED."commanderLegality", "canBeCommander" = EXCLUDED."canBeCommander",
        "hasAltDeckLimit" = EXCLUDED."hasAltDeckLimit", "isFunny" = EXCLUDED."isFunny",
        "edhrecRank" = EXCLUDED."edhrecRank", faces = EXCLUDED.faces,
        "imageSmall" = EXCLUDED."imageSmall", "imageNormal" = EXCLUDED."imageNormal",
        "backImageSmall" = EXCLUDED."backImageSmall", "backImageNormal" = EXCLUDED."backImageNormal",
        "importedAt" = now()
    `
    let inserted = 0
    let updated = 0
    for (let i = 0; i < deduped.length; i += CHUNK) {
      const chunk = deduped.slice(i, i + CHUNK).map((r) => ({ id: `c_${randomUUID()}`, ...r }))
      await client.query(upsertSql, [JSON.stringify(chunk)])
      for (const r of chunk) existingIds.has(r.scryfallOracleId) ? updated++ : inserted++
    }
    log(`cards upserted: ${inserted} new, ${updated} updated`)

    // ---- aliases: full rebuild (DELETE, not TRUNCATE — MVCC-friendly vs live imports) ----
    const allNorms = new Set(deduped.map((r) => r.nameNorm))
    const cardIdRows = await client.query<{ id: string; nameNorm: string }>(
      'SELECT id, "nameNorm" FROM "Card"',
    )
    const idByNorm = new Map(cardIdRows.rows.map((r) => [r.nameNorm, r.id]))

    const aliasMap = new Map<string, string>() // alias → cardId (first wins)
    let aliasCollisions = 0
    for (const r of deduped) {
      const cardId = idByNorm.get(r.nameNorm)
      if (!cardId) continue
      for (const alias of buildAliases(r)) {
        if (allNorms.has(alias)) continue // shadowed by a real card name (checked first at lookup)
        if (aliasMap.has(alias)) {
          aliasCollisions++
          continue
        }
        aliasMap.set(alias, cardId)
      }
    }
    await client.query('DELETE FROM "CardAlias"')
    const aliasRows = [...aliasMap.entries()].map(([alias, cardId]) => ({ alias, cardId }))
    for (let i = 0; i < aliasRows.length; i += CHUNK * 5) {
      await client.query(
        `INSERT INTO "CardAlias" (alias, "cardId")
         SELECT x.alias, x."cardId" FROM jsonb_to_recordset($1::jsonb) AS x(alias text, "cardId" text)`,
        [JSON.stringify(aliasRows.slice(i, i + CHUNK * 5))],
      )
    }
    log(`aliases: ${aliasRows.length} written, ${aliasCollisions} collisions (first won)`)

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }

  log(`done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
