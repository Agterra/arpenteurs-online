/**
 * Token art import: fetch a representative image for common game-token types from
 * Scryfall's search API and upsert into TokenImage (keyed by the normalized token
 * type name). Tokens aren't in the AtomicCards catalog, so this runs separately
 * from `cards:import` and is never touched by the card re-import.
 *
 * Run: pnpm tokens:import   (idempotent; needs network + a migrated DB)
 */
import pg from 'pg'
import { norm } from '../shared/utils/norm.ts'

const USER_AGENT = process.env.NUXT_SCRYFALL_USER_AGENT ?? 'arpenteurs/0.1 (tokens)'
const SEARCH = 'https://api.scryfall.com/cards/search'

// Token type-names to fetch art for: the ones the rules engine creates plus the
// most common tokens for the manual table. One representative image per name.
const TOKENS = [
  // engine-created (server/rules/cards/*)
  'Beast', 'Elephant', 'Soldier', 'Goblin', 'Saproling', 'Spirit',
  // common manual / staple tokens
  'Zombie', 'Treasure', 'Food', 'Clue', 'Blood', 'Angel', 'Demon', 'Dragon',
  'Bird', 'Cat', 'Elf Warrior', 'Elemental', 'Insect', 'Snake', 'Wolf', 'Human',
  'Servo', 'Thopter', 'Myr', 'Golem', 'Knight', 'Warrior', 'Wizard', 'Dinosaur',
  'Faerie', 'Squirrel', 'Vampire', 'Pest', 'Rat', 'Plant',
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchToken(name: string): Promise<{ typeLine: string; small: string | null; normal: string | null } | null> {
  const q = encodeURIComponent(`!"${name}" t:token game:paper`)
  const res = await fetch(`${SEARCH}?q=${q}&order=released&dir=desc&unique=cards`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
  if (res.status === 404) return null // no such token
  if (!res.ok) {
    console.warn(`[tokens] ${name} → HTTP ${res.status}`)
    return null
  }
  const json = (await res.json()) as { data?: { type_line?: string; image_uris?: Record<string, string>; card_faces?: { image_uris?: Record<string, string> }[] }[] }
  for (const c of json.data ?? []) {
    const img = c.image_uris ?? c.card_faces?.[0]?.image_uris
    if (img?.small || img?.normal) return { typeLine: c.type_line ?? `Token — ${name}`, small: img.small ?? null, normal: img.normal ?? null }
  }
  return null
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (run with --env-file=.env)')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  let ok = 0
  for (const name of TOKENS) {
    let t: Awaited<ReturnType<typeof fetchToken>> = null
    try {
      t = await fetchToken(name)
    } catch (e) {
      console.warn(`[tokens] ${name} fetch failed:`, (e as Error).message)
    }
    await sleep(120) // Scryfall asks ~10 req/s + a courteous delay
    if (!t) {
      console.log(`[tokens] ${name}: no art found`)
      continue
    }
    await pool.query(
      `INSERT INTO "TokenImage" ("nameNorm", "name", "typeLine", "imageSmall", "imageNormal")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("nameNorm") DO UPDATE
         SET "name" = $2, "typeLine" = $3, "imageSmall" = $4, "imageNormal" = $5`,
      [norm(name), name, t.typeLine, t.small, t.normal],
    )
    ok++
    console.log(`[tokens] ${name} ✓`)
  }
  await pool.end()
  console.log(`[tokens] imported ${ok}/${TOKENS.length} token images`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
