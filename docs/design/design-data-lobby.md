# Design Doc — Self-hosted Manual EDH Table ("Cockatrice replacement")

Stack held fixed: Nuxt 4 (Nitro API + SSR), Prisma, PostgreSQL 17, pnpm, TS, Node 24. Server-authoritative in-memory game state, DB snapshots, manual rules. One process, up to 4 players/game.

---

## 1. Prisma Schema

```prisma
// prisma/schema.prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pg_trgm]
}

// ---------- Card catalog (AtomicCards ⋈ Scryfall oracle_cards) ----------

enum CommanderLegality {
  LEGAL       // MTGJSON "Legal"
  BANNED      // "Banned"
  RESTRICTED  // "Restricted" (never happens for commander, kept for safety)
  NOT_LEGAL   // key absent (only present if imported with --include-acorn)
}

model Card {
  id                String            @id @default(cuid())
  scryfallOracleId  String            @unique @db.Uuid  // natural key for idempotent upserts
  scryfallId        String            @db.Uuid          // printing chosen by oracle_cards bulk
  name              String                              // full MTGJSON name, "A // B" for multiface
  nameNorm          String            @unique           // normalized (see §3) — exact decklist lookup
  asciiName         String?
  faceNames         String[]                            // e.g. ["Delver of Secrets","Insectile Aberration"]
  layout            String                              // normal | transform | modal_dfc | split | adventure | meld | ...
  manaCost          String?                             // "{2}{R}{R}"
  manaValue         Float                               // Float: half-mana Un-cards exist
  typeLine          String
  oracleText        String?                             // faces joined with "\n//\n"
  power             String?                             // String: "*", "1+*"
  toughness         String?
  loyalty           String?
  defense           String?
  colors            String[]
  colorIdentity     String[]                            // ["W","U"...]
  keywords          String[]
  supertypes        String[]                            // "Basic" → singleton exemption
  commanderLegality CommanderLegality
  canBeCommander    Boolean           @default(false)   // MTGJSON leadershipSkills.commander
  hasAltDeckLimit   Boolean           @default(false)   // Persistent Petitioners etc.
  isFunny           Boolean           @default(false)
  edhrecRank        Int?
  imageSmall        String                              // 146×204 — Scryfall URL VERBATIM incl. ?timestamp
  imageNormal       String                              // 488×680
  backImageSmall    String?                             // transform / modal_dfc only
  backImageNormal   String?
  importedAt        DateTime          @updatedAt

  aliases   CardAlias[]
  deckCards DeckCard[]

  // trigram GIN: accelerates ILIKE '%q%' AND powers similarity() for did-you-mean
  @@index([nameNorm(ops: raw("gin_trgm_ops"))], type: Gin)
}

// Alias table: faceNames, front half of "A // B", asciiName — all normalized.
// Required because AtomicCards has NO key "Bruna, the Fading Light" alone (meld gotcha).
model CardAlias {
  alias  String @id            // normalized string
  cardId String
  card   Card   @relation(fields: [cardId], references: [id], onDelete: Cascade)
  @@index([cardId])
}

// ---------- Identity (ephemeral, no passwords) ----------

model User {
  id         String   @id @default(cuid())
  username   String                       // NOT unique — ephemeral display name
  tokenHash  String   @unique             // sha256(raw cookie token), hex. Raw token only in cookie.
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())

  decks       Deck[]
  seats       LobbySeat[]
  gamePlayers GamePlayer[]
}

// ---------- Decks ----------

enum DeckSection { COMMANDER MAIN }

model Deck {
  id        String   @id @default(cuid())
  ownerId   String
  owner     User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  name      String
  rawText   String?                       // original paste, for re-import & debugging
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  cards     DeckCard[]
  @@index([ownerId])
}

model DeckCard {
  id       String      @id @default(cuid())
  deckId   String
  cardId   String
  section  DeckSection @default(MAIN)
  quantity Int         @default(1)
  deck     Deck        @relation(fields: [deckId], references: [id], onDelete: Cascade)
  card     Card        @relation(fields: [cardId], references: [id])
  @@unique([deckId, cardId, section])
  @@index([cardId])
}

// ---------- Lobby ----------

enum LobbyStatus { OPEN STARTING IN_GAME FINISHED }

model Lobby {
  id           String      @id @default(cuid())
  inviteCode   String      @unique          // 10-char base62, crypto-random
  name         String
  passwordHash String?                      // scrypt string (§4), null = no password
  hostId       String
  status       LobbyStatus @default(OPEN)
  maxSeats     Int         @default(4)
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt
  seats        LobbySeat[]
  games        Game[]
  @@index([status, createdAt])              // public lobby list
}

model LobbySeat {
  id        String   @id @default(cuid())
  lobbyId   String
  userId    String
  seatIndex Int                             // 0..3
  deckId    String?
  isReady   Boolean  @default(false)
  joinedAt  DateTime @default(now())
  lobby     Lobby    @relation(fields: [lobbyId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id])
  @@unique([lobbyId, userId])
  @@unique([lobbyId, seatIndex])
}

// ---------- Game ----------

enum GameStatus { ACTIVE FINISHED ABANDONED }

model Game {
  id          String     @id @default(cuid())
  lobbyId     String
  lobby       Lobby      @relation(fields: [lobbyId], references: [id])
  status      GameStatus @default(ACTIVE)
  snapshot    Json                          // FULL unredacted authoritative state
  snapshotSeq Int        @default(0)        // last event seq folded into snapshot
  startedAt   DateTime   @default(now())
  endedAt     DateTime?
  winnerSeat  Int?
  players     GamePlayer[]
  events      GameEvent[]
  @@index([lobbyId])
  @@index([status])
}

model GamePlayer {
  gameId    String
  userId    String
  seatIndex Int
  deckId    String?                         // deck as-of game start (reconnection auth = row exists)
  game      Game   @relation(fields: [gameId], references: [id], onDelete: Cascade)
  user      User   @relation(fields: [userId], references: [id])
  @@id([gameId, userId])
  @@unique([gameId, seatIndex])
}

model GameEvent {
  id        BigInt   @id @default(autoincrement())
  gameId    String
  seq       Int                             // per-game monotonic, starts at 1
  actorSeat Int?                            // null = system
  type      String                          // "MOVE_CARD" | "SET_LIFE" | "ROLL_DIE" | "CHAT" | ...
  publicLog String?                         // pre-redacted human-readable line; null = not logged
  payload   Json                            // full detail — MAY contain hidden info, NEVER sent raw to clients
  createdAt DateTime @default(now())
  game      Game     @relation(fields: [gameId], references: [id], onDelete: Cascade)
  @@unique([gameId, seq])
}
```

**Key decisions & justifications**

- **Deck cards: normalized rows, not jsonb.** For ~100 cards/deck the write cost is one `createMany` (trivial). Wins: FK integrity to `Card` (catalog re-imports upsert on `scryfallOracleId` and preserve `Card.id`, so decks never dangle), hydrated deck views via one `include`, queries like "decks containing X", per-section commander modeling (`COMMANDER` section holds 1–2 rows → partners for free). jsonb would force app-level id validation and re-resolution logic for zero benefit at this scale.
- **Exact name lookup:** `nameNorm` (unique btree) + `CardAlias` PK — both O(1) index hits. Normalization happens in app code, so no functional index needed.
- **Fuzzy autocomplete: pg_trgm, not bare ILIKE.** Honest sizing: at 35k rows a seq-scan `ILIKE '%sol%'` costs single-digit ms — speed alone doesn't justify anything. But `pg_trgm` (a) accelerates ILIKE via the same GIN index anyway, and (b) is the only way to get ranked typo-tolerant `similarity()` suggestions for unresolved decklist lines ("Solring" → "Sol Ring"), which is a required feature. One extension, both features → **pg_trgm**. (No `unaccent` needed: MTGJSON's `asciiName` covers diacritics.)
- **Event log + snapshot discipline (removes replay risk):** every accepted action is persisted in ONE transaction: `INSERT GameEvent(seq=n)` + `UPDATE Game SET snapshot=…, snapshotSeq=n WHERE id=? AND snapshotSeq=n-1` (optimistic guard; 0 rows updated → reject/resync). Restart recovery = load `snapshot` only. Events are audit/log/chat history — **never replayed through game logic**, so replay determinism is a non-problem. At human action rates (a few actions/sec across 4 players) writing a ~100–200 KB jsonb per action is negligible for Postgres.

---

## 2. Card Import Script (`scripts/import-cards.ts`)

Follows research verdict (b): AtomicCards = source of truth, oracle_cards = image join on `scryfallOracleId ⇔ oracle_id`.

**Download & parse strategy (zero extra deps on Node 24):**

1. **Scryfall images first**: `GET https://api.scryfall.com/bulk-data/oracle_cards` with `User-Agent: <app>/0.1 (louis@gravyr.fr)` and `Accept: application/json` (mandatory per Scryfall docs; api.scryfall.com is rate-limited, `data.scryfall.io` is not). Resolve `jsonl_download_uri` (URIs are timestamped and rotate — never hardcode). Download (~23 MB gz) → `zlib.createGunzip()` → `readline` line-by-line (JSONL streams trivially) → build `Map<oracle_id, {scryfallId, imageSmall, imageNormal, backImageSmall?, backImageNormal?}>`. Image extraction per layout (verified): top-level `image_uris` for normal/split/adventure/flip/aftermath/meld; `card_faces[0|1].image_uris` for transform/modal_dfc (face 1 → back fields). Store URLs **verbatim including `?timestamp`**.
2. **AtomicCards**: `GET https://mtgjson.com/api/v5/AtomicCards.json.gz` (50 MB — chosen over the smaller `.xz` because Node has native gzip and no native xz; avoids a dep or spawning `xz -d`). Gunzip to buffer → `JSON.parse` the 156 MB JSON **in memory**. On Node 24 this peaks around 1.5–2 GB heap — fine for a batch script; run with `NODE_OPTIONS=--max-old-space-size=4096` as a guard. Streaming JSON parsers are not worth the dependency here.
3. **Filter + map** each `data` key (order matters):
   - skip `layout ∈ {vanguard, planar, scheme}` (not playable cards);
   - skip Alchemy: name starts with `"A-"` (belt) or `legalities.commander` absent with only arena formats (suspenders);
   - skip reversible duplicates: key contains `" // "` with identical halves;
   - **default: skip cards where `legalities.commander` is absent** (acorn/un-set-only, digital-only) → "commander-playable paper cards only", ~29k rows. `Legal` AND `Banned` are both kept (research §6: don't hard-exclude Banned; deck validator warns). Optional `--include-acorn` flag imports the rest as `NOT_LEGAL` for house-rule tables;
   - dedupe by `scryfallOracleId` (first non-`//`-degenerate key wins);
   - join images from the Map; log misses (expected ≈0) and fall back to `GET /cards/named?exact=` at ≤2 req/s with proper headers; a card with no image after fallback is imported with a placeholder flag, not dropped.
4. **Alias generation** per card (all through the §3 normalizer): each `faceName`, `name.split(" // ")[0]`, `asciiName`. **Collision rule:** if an alias equals some card's own `nameNorm`, it must resolve to that card (covers "Brisela, Voice of Nightmares" being both a standalone meld card and a faceName of the two meld-pair entries); otherwise first-wins, collisions logged.

**Batched idempotent upserts** (35k `prisma.upsert` round-trips would take minutes — don't):

```ts
// chunks of 1000 → ~30 statements total
await prisma.$executeRawUnsafe(`
  INSERT INTO "Card" (id, "scryfallOracleId", name, "nameNorm", ...)
  SELECT gen_ulid_or_cuid(...), * FROM unnest($1::uuid[], $2::text[], ...)
  ON CONFLICT ("scryfallOracleId") DO UPDATE SET
    name = EXCLUDED.name, "nameNorm" = EXCLUDED."nameNorm",
    "imageSmall" = EXCLUDED."imageSmall", ...   -- everything except id
`, ...arrays);
```
`Card.id` is stable across re-imports (conflict target = oracle id, id untouched) → `DeckCard` FKs never break. After card upsert, rebuild `CardAlias` with `TRUNCATE + INSERT` in the same transaction (no inbound FKs on aliases). **Never delete Card rows** on re-import (decks may reference them); oracle ids effectively never disappear — log upstream-vanished ids only.

**Cadence & runtime:** wire as `pnpm cards:import`; run manually after set releases or via weekly cron (MTGJSON rebuilds daily, Scryfall says weekly suffices for gameplay data). Expected wall time: ~75 MB downloads 30–60 s + parse 10–15 s + JSONL stream ~5 s + upserts 10–30 s ⇒ **~1.5–3 min total**, idempotent, safe to re-run anytime.

---

## 3. Decklist Parser Spec

**Normalizer `norm(s)`** (used for both catalog columns and user input): Unicode NFKC → lowercase → curly quotes `’‘“”` → straight → `Æ/æ → ae`, strip remaining diacritics (NFD + remove combining marks) → collapse whitespace → trim.

**Line grammar** (applied per line, after comment stripping — lines starting `//` or `#` are skipped):

```
^\s*(?:(\d+)\s*[xX]?\s+)?      # qty, optional "x" suffix; absent ⇒ qty=1
(.+?)                          # card name (lazy)
(?:\s+\(([A-Za-z0-9]{2,6})\)\s*([0-9A-Za-z★-]+)?)?  # (SET) collector — IGNORED
(?:\s+\*[A-Za-z]+\*)*          # Moxfield foil/etched markers *F* — IGNORED
(?:\s+\[[^\]]*\])?             # Archidekt [Category] tag — IGNORED
(?:\s+\^[^^]*\^)?              # Archidekt color tag — IGNORED
\s*$
```
Accepts: `1 Sol Ring` / `1x Sol Ring` / `Sol Ring` / `4 Sol Ring (C21) 125` / `1 Sol Ring (C21) 125 *F*` / `1x Sol Ring (c21) 125 [Ramp]`.

**Sections:** header lines matched by `/^(commander|deck|main(board)?|sideboard|maybeboard|considering|companion|tokens?|about)s?\s*:?\s*$/i`. `Commander(:)` → COMMANDER; `Deck/Main(board)` → MAIN; `Sideboard/Maybeboard/Considering/Tokens` → parsed but discarded (reported as `skipped`); `About` block (MTGA) skipped entirely. Blank lines are block separators. **No headers present:** 1 block → all MAIN; multiple blocks → if the FIRST block has 1–2 lines that all resolve to `canBeCommander` cards, propose it as `commander.guess` (MTGA/Moxfield exports put the commander block first) — never silently designate.

**Name resolution order** (all via `norm`):
1. exact `Card.nameNorm`;
2. exact `CardAlias.alias` — covers `Delver of Secrets` → `Delver of Secrets // Insectile Aberration`, `Bruna, the Fading Light` (meld: no standalone atomic key exists), ascii forms;
3. slash variants: if input contains `/`, retry with `\s*/{1,2}\s*` canonicalized to ` // ` (matches `Fire // Ice`, `Fire//Ice`, `Fire / Ice`), then retry the front half alone;
4. **fuzzy = suggestions only, never auto-accept**: `SELECT id, name, similarity(nameNorm, $q) s FROM "Card" WHERE nameNorm % $q ORDER BY s DESC LIMIT 5` (threshold ≥ 0.35).

**Structured result** (returned by the import endpoint, `commit:false` = dry run):

```json
{
  "deckId": null,
  "resolved":   [{ "line": 4, "qty": 1, "cardId": "ck_...", "name": "Sol Ring", "section": "MAIN" }],
  "unresolved": [{ "line": 12, "raw": "1 Solring", "qty": 1, "query": "solring", "reason": "not_found",
                   "suggestions": [{ "cardId": "ck_...", "name": "Sol Ring", "score": 0.72 }] }],
  "skipped":    [{ "line": 30, "raw": "Sideboard", "reason": "section_ignored" }],
  "warnings":   [{ "code": "CARD_COUNT", "count": 98 },
                 { "code": "DUPLICATE_NONBASIC", "name": "Sol Ring" },
                 { "code": "BANNED_IN_COMMANDER", "name": "Black Lotus" }],
  "commander":  { "designated": [], "guess": ["ck_atraxa"], "required": true }
}
```

**Commander designation flow:** Commander section present → those 1–2 cards become `COMMANDER` rows (warn `NOT_A_COMMANDER` if `canBeCommander=false`, still allowed — house rules). Absent → `commander.required=true`; UI opens a picker over the imported list pre-filtered to `canBeCommander`, pre-selecting `commander.guess`; deck saves without commander, but the lobby ready-check blocks until one is set (§5). Duplicate resolved lines merge quantities; singleton violations are warnings only (Basic supertype and `hasAltDeckLimit` exempt).

---

## 4. HTTP API (Nuxt `server/api`)

**Auth model:** httpOnly cookie `sid` (SameSite=Lax, Secure, Max-Age 1 year) holding a raw token = 32 random bytes base64url. DB stores `sha256(token)` — a DB leak yields no usable sessions. Middleware resolves user, bumps `lastSeenAt`. "auth" below = valid cookie required (401 otherwise).

**Password hashing — `node:crypto` scrypt, zero deps:** `N=2^15 (32768), r=8, p=1, keylen=64, salt=randomBytes(16), maxmem=128*1024*1024` (scrypt memory = N·r·128 = 32 MiB, maxmem must exceed it). Stored as `scrypt$32768$8$1$<saltB64url>$<hashB64url>`; verify by re-deriving with stored params + `timingSafeEqual`. ~50 ms/hash — right cost for low-value lobby passwords.

| # | Method & path | Auth | Request → Response |
|---|---|---|---|
| 1 | `POST /api/auth/claim` | none | `{"username":"Louis"}` → sets cookie, `{"user":{"id":"u_1","username":"Louis"}}`. Idempotent if valid cookie already present (renames instead). |
| 2 | `GET /api/auth/me` | auth | → `{"user":{...}}` |
| 3 | `PATCH /api/auth/me` | auth | `{"username":"Lou"}` → `{"user":{...}}` |
| 4 | `GET /api/cards/search?q=sol&limit=20` | auth | → `{"results":[{"id":"ck_1","name":"Sol Ring","manaCost":"{1}","typeLine":"Artifact","imageSmall":"https://cards.scryfall.io/small/front/9/1/91fdb56b-....jpg?1782682494","canBeCommander":false}]}` — prefix ILIKE matches ranked first, then trgm similarity. |
| 5 | `GET /api/cards/:id` | auth | full card row |
| 6 | `GET /api/decks` | auth | `{"decks":[{"id":"d_1","name":"Atraxa","cardCount":100,"commanders":[{"name":"Atraxa, Praetors' Voice","imageSmall":"..."}]}]}` |
| 7 | `POST /api/decks` | auth | `{"name":"New deck"}` → deck |
| 8 | `GET /api/decks/:id` | owner | deck + hydrated `cards:[{qty, section, card:{...}}]` |
| 9 | `PATCH /api/decks/:id` | owner | `{"name":"..."}` → deck |
| 10 | `DELETE /api/decks/:id` | owner | 204 |
| 11 | `POST /api/decks/import` | auth | `{"name":"Pasted deck","text":"Commander\n1 Atraxa...\n\nDeck\n1 Sol Ring\n...","commit":true,"skipUnresolved":false}` → §3 result; deck created only when `commit && (unresolved.length===0 || skipUnresolved)`; else `deckId:null` (dry run / blocked). |
| 12 | `PUT /api/decks/:id/commanders` | owner | `{"cardIds":["ck_atraxa"]}` (1–2) → deck; 422 if cards not in deck. |
| 13 | `POST /api/lobbies` | auth | `{"name":"Friday pod","password":"hunter2"}` → `{"lobby":{"id":"l_1","inviteCode":"g7Kp2xQm4R","name":"Friday pod","hasPassword":true,"status":"OPEN","hostId":"u_1","seats":[...]}}` — creator auto-seated 0 as host. Invite link = `https://host/l/g7Kp2xQm4R`. |
| 14 | `GET /api/lobbies` | auth | open lobbies: `{"lobbies":[{"inviteCode":"...","name":"...","hasPassword":false,"seatCount":2,"maxSeats":4,"hostName":"Louis"}]}` |
| 15 | `GET /api/lobbies/:code` | auth | member → full detail (seats, usernames, deck names, ready flags, status, gameId if IN_GAME). Non-member → preview `{name, hasPassword, seatCount, maxSeats, status}`. |
| 16 | `POST /api/lobbies/:code/join` | auth | `{"password":"hunter2"}` → seat. 403 wrong password, 409 `{"error":"lobby_full"}`, and if IN_GAME but requester is a `GamePlayer` → `{"rejoin":true,"gameId":"g_1"}`. |
| 17 | `POST /api/lobbies/:code/leave` | member | 204; host leaving → transfer to lowest seatIndex, empty lobby → FINISHED. |
| 18 | `POST /api/lobbies/:code/kick` | host | `{"userId":"u_3"}` → 204, broadcast. |
| 19 | `PATCH /api/lobbies/:code/me` | member | `{"deckId":"d_1","isReady":true}` → seat. Changing deck resets `isReady`. |
| 20 | `POST /api/lobbies/:code/start` | host | `{}` → `{"gameId":"g_1"}` or 422 `{"errors":[{"seat":2,"code":"NO_COMMANDER"}],"warnings":[{"seat":1,"code":"CARD_COUNT","count":98}]}` (warnings alone don't block; `{"force":true}` unused in v1 since warnings never block). |
| 21 | `GET /api/games/:id/bootstrap` | GamePlayer | → `{"seq":412,"you":{"seatIndex":1},"players":[{"seat":0,"username":"Ana","life":34,...}],"view":{...redacted-for-you snapshot...},"wsPath":"/api/games/g_1/ws"}` |
| 22 | `WS /api/games/:id/ws` (+ `/api/lobbies/:code/ws`) | cookie on upgrade | Nitro `defineWebSocketHandler` (crossws; `nitro.experimental.websocket=true`). Cookie rides the upgrade request (same-origin) → no separate ws token. Client→server: `{"a":"MOVE_CARD","p":{...},"clientSeq":7}`. Server→client: `{"t":"event","seq":413,"pub":{...},"priv":{...only if addressed to you...}}`, `{"t":"sync","seq":413,"view":{...}}` on reconnect/desync, `{"t":"chat"|"lobby_update"|"game_started",...}`. |

---

## 5. Lobby Lifecycle State Machine

```
                 host start, validation OK          Game row + initial snapshot committed
   OPEN ────────────────────────────────► STARTING ────────────────────────────────► IN_GAME
    ▲  ▲                                     │ any failure → rollback                    │
    │  └────────────── rematch loop ─────────┴──────────────  game finished ────────────┘
    │                    (seats kept, isReady reset, lobby.games grows)
    └── join/leave/kick/ready/deck-select happen ONLY here
   OPEN or IN_GAME ──(host closes, or empty, or idle >24h sweep)──► FINISHED (terminal; game → ABANDONED if active)
```

- **Seats:** max 4 (`maxSeats`), enforced by counting inside the join transaction + `@@unique([lobbyId, seatIndex])` as the race backstop. Joining requires scrypt-verified password when set; the invite link `/l/:code` is the only discovery path for password-less private play (unlisted ≠ passworded; both supported).
- **Host powers:** kick (OPEN only), start, close lobby. **Host transfer:** ws heartbeat every 15 s; host disconnected > 60 s in OPEN → transfer to lowest-seatIndex connected member (broadcast `host_changed`). Host disconnect during IN_GAME changes nothing (host is a lobby concept).
- **Ready check:** `isReady` per seat, reset on deck change and on rematch. Start requires: every seated player ready, ≥1 seat (solo goldfishing allowed).
- **Deck validation at start** — blocking errors: seat has no deck; deck has zero COMMANDER rows. Non-blocking warnings (surfaced to the whole lobby, never enforced — proxies/house rules): card count ≠ 100, non-basic/non-`hasAltDeckLimit` duplicates, `commanderLegality != LEGAL` cards, color-identity violations vs commanders, 2 commanders without Partner text. **Never hard-enforce 100.**
- **Lobby → Game:** single transaction: guard `updateMany({where:{id, status:OPEN}, data:{status:STARTING}})` (0 rows → concurrent start, 409) → load decks → build initial snapshot in memory: random starting player (logged as system event), seat order = seatIndex, life 40, commanders in command zone, libraries shuffled server-side (`crypto` RNG), 7 cards drawn, empty mana pools, per-opponent commander-damage matrix, poison 0, turn 1/untap step → `create Game{snapshot, snapshotSeq:0}` + `GamePlayer` rows → lobby `IN_GAME` → broadcast `game_started {gameId}` on `lobby:{id}` channel; clients navigate and call bootstrap (§4 #21), then attach to ws room `game:{id}`. Game state is held in an in-process registry `Map<gameId, GameRoom>`; a room lazily rehydrates from `Game.snapshot` after a server restart (players reconnect, room reloads, play continues).
- **Finish & rematch:** any player (manual rules — table consensus is out-of-band) sends game action `FINISH_GAME {winnerSeat?}` → Game `FINISHED`, lobby back to `OPEN`, seats retained, all `isReady=false`. Rematch = ready-up + start again; a fresh Game row is created (lobby has many games — natural match history). Players who left mid-game are dropped from their seats on the OPEN transition.

---

## 6. Local Dev Setup

**`docker-compose.yml`**
```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: mtg
      POSTGRES_PASSWORD: mtg
      POSTGRES_DB: mtg
    ports: ["5432:5432"]
    volumes: [dbdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mtg -d mtg"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  dbdata:
```

**`.env` conventions** — `.env` gitignored, `.env.example` committed:
```bash
DATABASE_URL="postgresql://mtg:mtg@localhost:5432/mtg?schema=public"
NUXT_SESSION_COOKIE_NAME="sid"            # NUXT_* → Nuxt runtimeConfig auto-mapping
MTG_IMPORT_USER_AGENT="arpenteurs-mtg/0.1 (louis@gravyr.fr)"   # required by Scryfall API
```

**Prisma workflow:** `pg_trgm` declared in the schema (`postgresqlExtensions` preview) so `prisma migrate dev` emits `CREATE EXTENSION`; the trgm GIN index is in the schema too — if the Prisma version balks at `ops: raw(...)`, fall back to hand-adding `CREATE INDEX card_namenorm_trgm ON "Card" USING gin ("nameNorm" gin_trgm_ops);` in the generated migration SQL (migrations are editable before apply). Dev loop: `pnpm db:up` → `pnpm db:migrate` → `pnpm cards:import` → `pnpm dev`. Prod: `prisma migrate deploy`.

**`package.json` scripts** (Node 24 runs `.ts` natively via type stripping and has native `--env-file` — no tsx/dotenv deps):
```json
{
  "scripts": {
    "dev": "nuxt dev",
    "build": "nuxt build",
    "db:up": "docker compose up -d db",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:studio": "prisma studio",
    "cards:import": "node --env-file=.env --max-old-space-size=4096 scripts/import-cards.ts",
    "postinstall": "prisma generate"
  }
}
```
Fan Content Policy notice (exact required wording) goes in the app footer; MTGJSON (MIT) + Scryfall attribution alongside.

---

## Three Riskiest Design Points

1. **Hidden-information redaction is a cross-cutting invariant, not a feature.** Hands/libraries live in the unredacted `Game.snapshot` and in `GameEvent.payload`; one careless code path (sending raw snapshot, echoing an action payload, logging "drew Sol Ring" publicly) leaks. Mitigation baked in: clients only ever receive outputs of two centralized functions — `viewFor(snapshot, seat)` and `{pub, priv}` event splitting computed server-side at action time — and `publicLog` is written pre-redacted. This must be enforced by review + tests (e.g. a serialization test asserting no card names from hidden zones appear in any other seat's view/event stream).
2. **Single-process in-memory authority on experimental plumbing.** The `Map<gameId, GameRoom>` design hard-requires exactly one Node process (no PM2 cluster, no horizontal scale) and rests on Nitro's still-experimental crossws WebSockets; Nuxt dev-mode HMR can also wipe module state mid-game (mitigated by lazy rehydrate-from-snapshot, which doubles as the restart story). The per-action transactional snapshot write with the `snapshotSeq` optimistic guard is the safety net, but write amplification (~100–200 KB jsonb per action) and crossws behavior under flaky reconnects need early load testing — this is the part of the design with the least prior art in this stack.
3. **Upstream card-data drift.** Three moving parts we don't control: Scryfall image URLs mutate (`?timestamp` cache-buster changes; oracle_cards may re-pick the canonical printing), MTGJSON's schema/keys evolve daily-build by daily-build (the meld/reversible quirks this design encodes are empirical, not contractual), and name matching has a long tail (new degenerate layouts, alias collisions). Mitigations: weekly re-import refreshes URLs; import script logs join misses/alias collisions loudly instead of dying; optional later hardening = mirror the ~29k `small` JPGs locally (~150–300 MB, sanctioned by Scryfall) to fully decouple game nights from scryfall.io availability — worth doing before relying on this for a regular playgroup.