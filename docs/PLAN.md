# Arpenteurs — Online MTG Commander Table (Cockatrice replacement)

## Context

Build from scratch, in the empty `/home/louis/Documents/perso/arpenteurs` directory, a self-hosted web app to play Magic: The Gathering **Commander (up to 4 players)** online — replacing Cockatrice/XMage. Like Cockatrice, the app enforces **no MTG rules**: it is a shared virtual table with manual actions; players enforce rules socially. Goals: faster, lighter, more user-friendly than Cockatrice.

Decisions confirmed with the user: Nuxt 4 + Prisma + **PostgreSQL**; **ephemeral username + long-lived cookie** (no accounts); **MTGJSON AtomicCards** card catalog with low-quality Scryfall images; **server-authoritative in-memory games with DB snapshots** (reconnect + restart survival).

This plan was produced by a research+design+adversarial-critique workflow (facts verified live 2026-07-05: MTGJSON 5.3.0, Scryfall bulk API, Nuxt 4.4.8, Prisma 7.8). All critic blockers are folded in below.

**First implementation action: store this plan in the repo as `docs/PLAN.md`** and keep it updated as milestones complete.

## Stack (versions verified July 2026)

- `nuxt@^4.4` (Node 24, pnpm), `@pinia/nuxt` (pinia 3), `@nuxt/ui@^4.9` (free, brings Tailwind v4) for lobby/menus/dialogs; game board = custom components.
- `prisma@^7` + `@prisma/client@^7` + `@prisma/adapter-pg` + `pg`. Generator `provider = "prisma-client"` with explicit `output` (v7 requirement). **No `@prisma/nuxt`** (deprecated) — manual singleton in `server/utils/db.ts` (globalThis-cached in dev).
- **Nitro native WebSockets** (`nitro.experimental.websocket: true`, handler in `server/routes/ws/game.ts` via `defineWebSocketHandler`/crossws). Verified production-ready for single-node; socket.io adds nothing here. Known bug nuxt#33829: upgrade-context doesn't reach `open()` → re-parse cookie from `peer.request.headers` in `open` (documented workaround).
- `zod@^4` schemas in `shared/` (used by both client and ws server), `@vueuse/core` (`useWebSocket` auto-reconnect + heartbeat), `vitest@^4` + `@nuxt/test-utils@^4`.
- `postgres:17-alpine` via docker-compose; `pg_trgm` extension (fuzzy card search + did-you-mean).

## Project structure

```
app/            pages/ (index, decks, l/[code], game/[id])  components/ (board/*, lobby/*)
                stores/ (game.ts, session.ts)  composables/ (useGameSocket.ts)
server/         api/ (auth, cards, decks, lobbies, games)  routes/ws/game.ts
                game/ (reducer.ts, redact.ts, room.ts, persist.ts, rng.ts, authorize.ts)
                utils/ (db.ts, session.ts, scrypt.ts)
shared/         types/ (game.ts, messages.ts)  schemas/ (messages.ts — zod)  utils/ (tokenParse.ts, decklistParse.ts, norm.ts)
prisma/         schema.prisma, migrations/
scripts/        import-cards.ts
docs/           PLAN.md (this plan)
docker-compose.yml  .env.example
```

## 1. Card catalog & import (Milestone M1)

**Verified fact:** AtomicCards has `scryfallOracleId` on 100% of its 35,557 faces but **zero printing-specific `scryfallId`** → MTGJSON alone cannot produce image URLs. Pipeline = **AtomicCards (source of truth) ⋈ Scryfall `oracle_cards` bulk (images only)** on `scryfallOracleId ⇔ oracle_id` (one entry per oracle id, canonical printing pre-chosen — exactly "one low-quality image per card").

**Import script** (`pnpm cards:import`, ~2–3 min, idempotent, weekly/manual re-runs):
1. Resolve Scryfall bulk URI via `GET https://api.scryfall.com/bulk-data/oracle_cards` (URIs rotate; mandatory `User-Agent` + `Accept` headers) → stream gzipped JSONL (~23 MB) → `Map<oracle_id, images>`. Images: top-level `image_uris` for normal/split/adventure/flip/aftermath/meld; `card_faces[i].image_uris` for transform/modal_dfc (face 1 → back image). Store URLs **verbatim incl. `?timestamp`**.
2. `GET https://mtgjson.com/api/v5/AtomicCards.json.gz` (~50 MB; Node-native gunzip) → parse in memory (`--max-old-space-size=4096`).
3. Filter: skip layouts `vanguard/planar/scheme`; skip `A-` Alchemy names; skip reversible-card duplicate keys (identical `//` halves); **default keep only cards with `legalities.commander` present** (`Legal` AND `Banned` both kept — validator warns, never blocks; house rules exist). Dedupe by oracleId.
4. Upsert in 1000-row batches, `ON CONFLICT ("scryfallOracleId") DO UPDATE` (cuids generated in JS — stable `Card.id` across re-imports so `DeckCard` FKs never dangle; never delete Card rows). Card upserts + alias rebuild in **one transaction**; aliases rebuilt via `DELETE` (not `TRUNCATE` — avoids ACCESS EXCLUSIVE lock vs live decklist imports). Detect `nameNorm` collisions in JS pre-write (log, first wins).
5. **`CardAlias` table** (normalized): each `faceName`, front half of `"A // B"`, `asciiName`. Required — verified meld gotcha: no atomic key `"Bruna, the Fading Light"` exists alone. Alias colliding with a card's own `nameNorm` resolves to that card.

**Card row:** name, nameNorm (unique), faceNames[], layout, manaCost, manaValue, typeLine, oracleText (faces joined `\n//\n`), power/toughness/loyalty/defense (strings — `*` exists), colors, colorIdentity, keywords, supertypes, commanderLegality enum, canBeCommander (`leadershipSkills.commander`), hasAltDeckLimit, isFunny, edhrecRank, imageSmall/imageNormal (+ backImageSmall/Normal), scryfallOracleId (unique), scryfallId. GIN trgm index on nameNorm.

**Licensing (required):** app footer carries the exact Wizards Fan Content Policy notice + Scryfall/MTGJSON attribution; app stays free.

## 2. Identity, decks, decklist import (M2)

- **Auth:** `POST /api/auth/claim {username}` mints 32-byte token → **httpOnly** cookie `sid` (SameSite=Lax, 1 year); DB stores `sha256(token)` only. Username: 1–24 chars, control/zero-width chars stripped, rendered only as DOM text (log-spoofing defense). `GET/PATCH /api/auth/me`.
- **Decks:** normalized rows (`Deck` + `DeckCard{cardId, section COMMANDER|MAIN, quantity}`) — FK integrity to catalog, partners = 2 COMMANDER rows. CRUD + `PUT /api/decks/:id/commanders`.
- **Decklist parser** (`shared/utils/decklistParse.ts`, pure, heavily unit-tested): normalizer (NFKC, lowercase, curly quotes, Æ→ae, strip diacritics); line grammar accepts `1 Sol Ring` / `1x Sol Ring` / `Sol Ring` / `4 Sol Ring (C21) 125 *F* [Ramp]` (set/collector/foil/category ignored); section headers Commander/Deck/Mainboard/Sideboard(discarded+reported)/About(skipped); comment lines `//` `#`. Resolution order: nameNorm exact → CardAlias → slash-variant canonicalization (`Fire//Ice`→`Fire // Ice`) + front-half retry → **fuzzy pg_trgm suggestions only, never auto-accepted**.
- `POST /api/decks/import {name, text, commit, skipUnresolved}` → structured report: resolved / unresolved (with suggestions) / skipped / warnings (`CARD_COUNT` ≠100 — warn only, **never hard-enforce**; `DUPLICATE_NONBASIC` (Basic + hasAltDeckLimit exempt); `BANNED_IN_COMMANDER`; color-identity vs commander) / commander {designated, guess, required}. No Commander section → UI picker filtered to `canBeCommander`, pre-selecting first-block guess.
- **Card search:** `GET /api/cards/search?q=` — prefix matches ranked first, then trgm similarity.

## 3. Lobbies (M3)

Prisma: `Lobby{inviteCode unique 10-char base62, name, passwordHash?, visibility PUBLIC|UNLISTED, hostId, status OPEN|STARTING|IN_GAME|FINISHED, maxSeats 4}` + `LobbySeat{seatIndex, deckId, isReady}` (+unique constraints as race backstops).

- Invite link `/l/:code`. **UNLISTED lobbies never appear in the list** (critic fix — the list previously leaked every invite code); PUBLIC lobbies listed intentionally. Password = `node:crypto` scrypt (N=2^15, r=8, p=1, keylen=64, salt 16B, timingSafeEqual), stored as `scrypt$N$r$p$salt$hash`. Join attempts throttled (5/min/user/lobby).
- Routes: `POST /api/lobbies`, `GET /api/lobbies` (PUBLIC+OPEN only), `GET/join/leave/kick/start /api/lobbies/:code/...`, `PATCH /api/lobbies/:code/me {deckId, isReady}` (deck change resets ready). Non-member GET → preview only. Join when IN_GAME + requester is a GamePlayer → `{rejoin, gameId}`.
- Host transfer on 60s disconnect (OPEN only); empty lobby → FINISHED; kick allowed OPEN **and IN_GAME** (kicked seat → conceded — mid-game griefer fix).
- **Start** (host, all ready, ≥1 seat — solo goldfishing OK): blocking errors = no deck / no commander; everything else warnings. Single transaction with `status: OPEN→STARTING` optimistic guard → build initial snapshot (random first player logged, life 40, commanders in command zone, libraries crypto-shuffled, hands of 7 dealt, **status `mulligans`**) → `Game` + `GamePlayer` rows → IN_GAME → broadcast `game_started`.
- **Rematch:** any player sends `game.finish {winnerSeat?}` → Game FINISHED, lobby back to OPEN, seats kept, ready reset; new start = new Game row (match history for free).

## 4. Game engine & wire protocol (M4 — the heart)

### State (in `shared/types/game.ts`)
`ServerGameState{players, cards Record<CardId,CardInstance>, zones{perPlayer{library|hand|battlefield|graveyard|exile|command: CardId[] ordered}, stack}, turn{order, activePlayer, step, turnNumber}, markers Record<string, PlayerId|string|null> (monarch/initiative/daynight/custom), peeks, seq, status 'mulligans'|'active'|'ended'}`.
`PlayerState{life, poison, counters{}, manaPool{W,U,B,R,G,C}, commanderIds, commanderDamage per opposing commander, **commanderTax per own commander**, mullCount, keptHand, hasConceded}`. **Presence (`connected`) is NOT in game state** — derived from room peers, broadcast as non-seq presence messages (critic fix: keeps snapshot/replay contract clean, no ghost-connected players after restart).
`CardInstance{id, catalogId=Card.id, ownerId, controllerId, zone, x,y (0..1), tapped, faceDown, faceIndex, counters{}, attachedTo, attachOrder, isToken, tokenSpec, isCommander, revealedTo}`.

### Protocol: incremental redacted events + seq; full-snapshot `sync` for join/reconnect/desync
One accepted action → seq+1 → one event per recipient (payloads differ by redaction). Client asserts contiguous seq; on gap sends `resync` (throttled 1/5s) → `sync` replaces store unconditionally (even lower seq — restart recovery). Rejections consume no seq, actor-only. All client messages validated by one zod discriminated union **with `.max()` bounds on every field** (token quantity ≤20, die sides ≤1000, draw/scry/look n ≤ library, text ≤500, |life delta| ≤999, x/y clamped) + ws `maxPayload` 64 KB + per-peer token bucket (20 msg/s burst 60) — critic OOM/flood fixes.

**Action catalog (complete v1):** `lobby.ready/start`; `resync`; `game.concede/leave/finish`; `turn.next/setStep/pass` (active player or host only); `player.life/poison/counter/commanderDamage/marker`; `mana.change/clear`; `deck.draw/shuffle/mulligan/scry/look/search/revealTop`; `hand.reveal {to?: PlayerId[]|'all'}`; `peek.resolve {toTop, toBottom, moves}` / `peek.cancel`; `card.move` (universal, `MoveTarget = zone + index|top|bottom`), `card.position` (ephemeral — see below), `card.tap {cardIds[]}` (multi-select), `board.untapAll`, `card.face`, `card.counter`, `card.attach`, `card.control`, `card.reveal {to}`, **`card.arrow {fromCardId, toCardId|toPlayerId}`** (attack/target arrows, auto-cleared leaving combat — critic: Cockatrice's most-used manual feature); `token.create {spec, quantity, zone: battlefield|stack, tapped?}`; `chat.send`; `game.roll/coin`.

**Mulligan (London, critic fix):** game starts in `mulligans` status; `deck.mulligan {}` = hand→library, shuffle, always redraw 7, mullCount++; `deck.keep {bottomCount}` opens peek-style "choose N to bottom" resolved via `peek.resolve.toBottom`; all-kept → status `active`, turn 1 untap. Log: "Louis mulligans to 6 (mulligan #2)".

**Commander bookkeeping (critic fix):** commander moving INTO command zone (post-setup) prompts one-click tax increment; tax badge on command-zone card showing current cast cost; commanderDamage adjusted per opposing commander (life not auto-linked; log reminds).

**Concede (critic fix, rule 800.4a):** all cards owned by the conceding player leave the game; control of others' cards they controlled reverts to owners; turn rotation skips `hasConceded` players; logged.

**Peeks (critic fixes):** while a peek is open, all other library-touching actions by that player are rejected (`PEEK_OPEN`); `peek.resolve` validates ids ⊆ peek.cardIds, no duplicates; search always forces shuffle (even on cancel); peek auto-cancels on disconnect/game end; **`card.move` with a library source is rejected unless the card is in the actor's active peek** (blocks the silent-tutor exploit).

**Attachments (critic fix):** host leaving battlefield auto-unattaches all attachments in place (logged); attachments follow host position, render offset-stacked in `attachOrder`.

### Hidden-information redaction — the #1 invariant
Single `visibleTo(card, viewer, state)` used by BOTH the per-event redactor and the snapshot redactor. Rules: own hand full; opponent hand/library **count only, no ids**; library order **never serialized to anyone, owner included**; face-down cards: owner full, others presence+position only (`hidden: true, catalogId: null` — typed so hidden cards *cannot* carry identity); graveyard/exile-face-up/command/stack public; peek contents actor-only (survive reconnect in own `sync`); reveals explicit.
Critic blockers folded in:
- **Fresh CardId minted whenever a card enters a hidden zone** (hand from elsewhere, library, face-down exile) **+ re-key all library ids on every shuffle** — kills cross-zone identity tracking (a bounced-then-shuffled card must not be trackable; paper-equivalent privacy).
- **Visibility-delta rule:** every event carries, per recipient, full redacted card objects for all cards whose visibility changed (search putting a card onto the battlefield materializes it for opponents; no silent desyncs).
- Visible `RedactedCard`s **embed catalog display data** (name, typeLine, pt, image URLs) — events self-contained, no N+1 card fetches (critic blocker).
- Game log = client-side rendering of the received event stream → a viewer's log physically cannot contain what they couldn't see. **Log persistence (critic fix):** each GameEvent row stores a pre-rendered `publicLine` + optional `privateLines[seat]`; `sync` includes last 200 viewer-filtered log lines + chat tail (log survives refresh/reconnect/restart).
- CI-blocking vitest **property test**: fuzz action sequences, serialize every event + snapshot for all 4 viewers, assert (a) no hidden card identity ever appears in a wrong stream, (b) history-aware: no id currently in a hidden zone was previously serialized to that viewer, (c) event-applied client state deep-equals `redactStateFor(viewer, state)` after every action.

### Server architecture
- Room registry `Map<gameId, Promise<Room>>` — **single-flight rehydration** (critic fix: no split-brain on simultaneous reconnects); eviction timer re-checks peers + in-flight opens; 10 min empty → final snapshot + delete; superseded duplicate session closes old peer without flipping presence (keyed by peer.id).
- Action pipeline is **synchronous validate→authorize→reduce→broadcast** (Node's single-threaded message handling = the serialization mechanism; no locks). Authorization matrix: self-only for counters/mana/deck/peeks; card actions require controller (owner off-battlefield); moving cards out of opponents' zones denied (ask them); turn control = active player or host.
- **Persistence (reconciled — critics found the two designs conflicted):** periodic **full-snapshot** writes: every 10 actions OR 5 s debounce OR immediately on game start/end/mulligans-done/last-peer-disconnect **and on Nitro close hook** (dev HMR reload → lossless). GameEvent rows are appended write-behind for **log/history only — never replayed through game logic** (no deterministic-replay machinery = the engine design's riskiest point deleted). Recovery = load snapshot, done; worst crash loss ≈ 5 s of manual actions (players redo a click — acceptable for a manual table). Persist-queue failure → pause room (`SERVER_PAUSED`), retry with backoff, force snapshot.
- **`card.position` is ephemeral** (critic fix): broadcast live + applied in memory, **no seq, no GameEvent row**, doesn't advance the snapshot counter; captured by the next regular snapshot (position staleness after crash = cosmetic). Client renders local drag immediately (view-layer only — no optimistic state; store remains server truth). Otherwise **no optimistic updates in v1** (RTT <100 ms self-hosted; rollback machinery is the biggest realtime-client bug source).
- Shuffles/rolls: `crypto.randomInt` Fisher–Yates server-side.
- **WS auth:** cookie rides same-origin upgrade; parse in `open()` via `peer.request.headers` (nuxt#33829 workaround); **reject upgrades whose Origin ≠ configured public origin** (CSWSH defense); membership = GamePlayer row.

### Client
Pinia store: `ClientGameState` + `applyEvent` (dumb field assignments — events carry resulting values) + `applySync` + derived log. `useGameSocket`: VueUse `useWebSocket` (`autoReconnect` exp backoff, heartbeat ping/pong), opened `onMounted` only; board in `<ClientOnly>` painted by first `sync` (SSR renders frame + lobby data via `useFetch`).

### Token auto-suggestion (`shared/utils/tokenParse.ts`, pure, corpus-tested)
Stage 1: named-artifact table (Treasure/Food/Clue/Blood/…, canned specs). Stage 2: regex grammar over "create …" sentences → qty/pt/colors/subtypes/abilities prefill (~75–85% of Commander staples). "Copy of" → *Copy target permanent* button building `tokenSpec.fromCatalogId` from a clicked card. Parse failure → same dialog, blank — never blocks manual creation.

## 5. Game board UI (M5 — critic: this is the product)

Concrete interaction spec (desktop-first; mobile is an explicit non-goal):
- **Layout (1080p+):** central 2×2 battlefield grid (your quadrant bottom-left, resizes to 1×1/1×3 for fewer players); each quadrant has a slim player HUD (avatar seat color, life big, poison, commander damage matrix popover, mana pool row, counters) + zone chips (library count, graveyard/exile/command thumbnails). Your hand = bottom fan/strip overlay. Right sidebar = tabbed log/chat. Top = phase ribbon (12 steps, active player highlight, turn number, Next Step / Pass Turn buttons + keyboard shortcuts Space/Enter).
- **Cards:** `small` images on board (146×204 natively — light); **hover ≥300 ms → `normal` image preview panel** (fixed position, shows back face on hover-flip key, oracle text under image from catalog — no Scryfall API calls in-game). `onerror` → text placeholder rendered from name/cost/typeLine/pt (game stays playable through a Scryfall outage; optional v2: local image mirror behind a config flag).
- **Interactions:** drag card → drop targets highlight (zones + battlefield free position); drop on library → top/bottom popover; double-click = tap/untap; right-click context menu (move to…, face-down, counters, attach, reveal, clone-token); marquee multi-select + `T` mass tap; counter chips rendered on card with click +1 / right-click −1 (no dialog for the common case); attack/target arrows drawn by drag-from-card-with-modifier, cleared on combat end.
- **Overlays:** scry/look/search = modal card strip with drag-to-top/bottom/pick lanes (search gets filter box); zone browsers (click graveyard/exile) = scrollable grid; token dialog with suggestion chips; mulligan bar during `mulligans` status; die-roll/coin widgets in log.
- **Lobby/deck screens:** Nuxt UI components (forms, modals, toasts) — fast to build, consistent.

## 6. Milestones & order

| # | Deliverable | Key tests |
|---|---|---|
| M0 | Scaffold: Nuxt 4 app, pinia, @nuxt/ui, Tailwind v4, zod, vitest projects (unit/nuxt/e2e), Prisma 7 + adapter-pg, docker-compose PG17, .env.example, scripts, `docs/PLAN.md` | `pnpm build` + `node .output/server/index.mjs` boots (Prisma/Nitro ESM check — do this EARLY) |
| M1 | Card catalog: schema + migrations (pg_trgm), import script, search API | import run against real data (~29k rows); resolution unit tests (meld/split/MDFC/reversible fixtures) |
| M2 | Auth + decks + decklist parser + deck UI | parser corpus tests (Moxfield/MTGA/Archidekt exports, edge names); import endpoint dry-run/commit tests |
| M3 | Lobbies: CRUD/join/password/ready/kick/transfer, lobby ws presence, start→Game | API tests incl. password, race guards, UNLISTED privacy |
| M4 | Engine: reducer + full action catalog, redaction, rooms, persistence, reconnect | **redaction property test (CI-blocking)**, reducer invariant tests, snapshot/recovery tests, 4-client scripted e2e game over real ws asserting convergence + no leaks |
| M5 | Game board UI (spec §5), peek/token/mulligan overlays, log/chat | component tests for overlays; manual 2-browser playtest; e2e happy path |
| M6 | Hardening: rate limits, image fallback, rematch, footer legal notice, README | full suite green; `/code-review` + `/security-review` on ws/auth/redaction |
| M7 | Backoffice (`/admin`): live lobbies/games, card catalog browser, KPIs | admin auth tests (no token → 403); KPI queries against seeded data |

Each milestone ships with its tests (per QA rules); bug fixes get failing regression tests first.

## 6b. Backoffice (M7 — added by user request 2026-07-05)

`/admin` area, server-rendered with Nuxt UI tables. Auth: **`NUXT_ADMIN_TOKEN` env secret** → `/admin/login` form sets a separate httpOnly `admin` cookie (timingSafeEqual comparison); regular users have no admin rights — fits the no-accounts philosophy. All `/api/admin/**` routes 403 without the cookie.

- **Lobbies & games:** live table of lobbies (status, seats, host, created, has-password — never the password itself) and running games (turn number, connected peers from the room registry, last action time). Drill-down shows public metadata only — the backoffice is NOT a spectator mode and never exposes redacted card contents.
- **Card catalog:** searchable/paginated browser over the Card table (reuses the search API + filters by legality/layout); import freshness panel (row count, max importedAt, join-miss log); re-import trigger button.
- **KPIs / metrics** (SQL aggregates, no external metrics stack in v1): users/decks/lobbies created per day, games started/finished per day, avg + p50/p90 game duration, actions per game (GameEvent counts), live concurrent games + connected peers (room registry), catalog size.

## 7. Explicit v1 non-goals

Undo/rewind (card.move IS the undo, hidden-info makes real undo unsolvable); spectators (5th redaction viewer class — door left open by design); any rules automation; per-card rulings (right-click → Scryfall tab); multi-node/Redis (single node is a design premise); optimistic state; replay viewer (events already stored); sideboard/wishboard; mobile layout; sound.

## 8. Verification (end-to-end)

1. `pnpm db:up && pnpm db:migrate && pnpm cards:import` — real import, row count ≈29k, spot-check Sol Ring/Delver/Bruna/Fire//Ice resolution + image URLs load.
2. `pnpm test` — unit (reducer, redaction property test, parsers, token corpus) + nuxt + e2e projects.
3. `pnpm build && node .output/server/index.mjs` — production boot with ws.
4. Scripted 4-client ws e2e: full game (mulligans → turns → scry/search/tokens/combat arrows → concede → finish → rematch), asserting seq continuity, state convergence, zero hidden-info leakage, reconnect mid-game (kill a socket, reconnect, deep-equal resync), server-restart recovery (reload room from snapshot).
5. Manual: two browsers side by side, one full turn cycle; kill `pnpm dev` mid-game and verify resume.
