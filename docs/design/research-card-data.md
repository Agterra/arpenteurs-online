# Card Import Research Report — MTGJSON AtomicCards + Scryfall images (verified 2026-07-05)

All numbers below were verified **live today** against the actual files/endpoints (not from memory). MTGJSON build inspected: `meta.version = "5.3.0+20260704"` (2026-07-04 daily build). Scryfall bulk inspected: oracle_cards of 2026-07-05 09:02 UTC.

---

## 1. MTGJSON v5 AtomicCards.json

**Download URLs** (listed at https://mtgjson.com/downloads/all-files/, base `https://mtgjson.com/api/v5/`):
- `https://mtgjson.com/api/v5/AtomicCards.json` — **156,499,584 bytes (~149 MiB)** (verified via HTTP HEAD)
- `https://mtgjson.com/api/v5/AtomicCards.json.xz` — **24,778,616 B (~24 MB)** ← smallest, recommended
- `https://mtgjson.com/api/v5/AtomicCards.json.bz2` — 31,330,162 B
- `https://mtgjson.com/api/v5/AtomicCards.json.gz` — 50,209,339 B
- `https://mtgjson.com/api/v5/AtomicCards.json.zip` — 50,209,434 B
- Format-filtered variants exist with the same pattern: `LegacyAtomic`, `ModernAtomic`, `PauperAtomic`, `PioneerAtomic`, `StandardAtomic`, `VintageAtomic` (no "CommanderAtomic" exists — you filter yourself).

**Top-level structure** (verified by fetching the first bytes of the real file):
```json
{"meta": {"date": "2026-07-04", "version": "5.3.0+20260704"},
 "data": { "<card name>": [ {face object}, {face object}, ... ], ... }}
```
Yes: `data` is an object keyed by card `name`, each value an **ARRAY of Card (Atomic) face objects** (single-faced cards = 1-element array). Verified counts in the current build: **34,633 name keys, 35,557 face objects**.

**Per-face fields** (docs: https://mtgjson.com/data-models/card/card-atomic/). Required: `name` (full name, `//` delimiter for multi-face), `colorIdentity`, `colors`, `convertedManaCost` (deprecated → `manaValue`), `identifiers`, `layout`, `legalities`, `manaValue`, `purchaseUrls`, `relatedCards`, `subtypes`, `supertypes`, `type` (full printed type line, em-dash delimiter), `types`. Optional: `asciiName`, `colorIndicator`, `defense` (battles), `edhrecRank`, `edhrecSaltiness`, `faceConvertedManaCost` (deprecated), `faceManaValue`, `faceName`, `firstPrinting`, `foreignData`, `hand`/`life` (Vanguard only), `hasAlternativeDeckLimit`, `isFunny`, `isGameChanger`, `isReserved`, `keywords`, `leadershipSkills`, `loyalty`, `manaCost` (curly-brace symbols, e.g. `{2}{R}{R}{G}{G}`), `power`, `toughness`, `printings`, `rulings`, `side`, `subsets`, `text`.

**Multi-face representation** (all verified against the real file):
- **transform** (`Delver of Secrets // Insectile Aberration`): keyed under the full `//` name; 2 face objects with `faceName`, `side: "a"/"b"`, `layout: "transform"`, per-face `power/toughness/colors/type`, shared `manaValue` (card-level) + per-face `faceManaValue` (back face has `manaCost: null`, `faceManaValue: 0`). **Both faces carry the SAME `identifiers.scryfallOracleId`.**
- **modal_dfc** (`Agadeem's Awakening // Agadeem, the Undercrypt`): same shape, `layout: "modal_dfc"`.
- **split** (`Fire // Ice`): 2 faces, `side a/b`, `manaValue: 4` (combined) with `faceManaValue: 2` each; `colors` per face, `colorIdentity` full (`["R","U"]` on both).
- **adventure** (`Brazen Borrower // Petty Theft`): 2 faces; side b `type: "Instant — Adventure"`.
- **meld**: THREE separate keys exist: `"Bruna, the Fading Light // Brisela, Voice of Nightmares"` (side-a face only), `"Gisela, the Broken Blade // Brisela, Voice of Nightmares"` (same), and `"Brisela, Voice of Nightmares"` alone (single side-b face, `layout: "meld"`). **Gotcha: there is NO key `"Bruna, the Fading Light"` alone** — your decklist matcher must index by `faceName` and by `name.split(" // ")[0]` in addition to full `name`.
- **reversible_card** (70 keys): degenerate duplicates like `"Adrix and Nev, Twincasters // Adrix and Nev, Twincasters"` that coexist with the normal `"Adrix and Nev, Twincasters"` entry — **dedupe by `scryfallOracleId`, prefer the non-`//` key** (or skip keys where both `//` halves are identical).
- Layout distribution in current build (per name, face[0]): normal 32,925; transform 401; planar 207; saga 168; adventure 157; split 109; vanguard 107; scheme 102; modal_dfc 100; reversible_card 70; prepare 50; class 38; mutate 34; aftermath 27; leveler 26; flip 21; meld 21; prototype 21; host 20; case 15; augment 14.

## 2. Scryfall identifiers in AtomicCards — can we build image URLs from MTGJSON alone?

**NO.** Verified across the entire file: **all 35,557 face objects have `identifiers.scryfallOracleId`; exactly 0 have `scryfallId`** (the printing-specific UUID). The Identifiers model (https://mtgjson.com/data-models/identifiers/) documents `scryfallId`, `scryfallOracleId`, `scryfallIllustrationId`, `scryfallCardBackId`, etc., but on Card (Atomic) only `scryfallOracleId` is populated (an atomic card is printing-agnostic, so this is by design). Scryfall image URLs are keyed by the **printing** card `id` (see §3), and there is no URL scheme addressing images by oracle id. → MTGJSON alone cannot yield image URLs; a join with Scryfall bulk data is mandatory (§4).

## 3. Scryfall images, CDN, rate limits, bulk data

**CDN URL structure** (verified live via API): `https://cards.scryfall.io/{version}/{front|back}/{id[0]}/{id[1]}/{id}.jpg?{revision-timestamp}` where `id` is the **printing-specific Scryfall card id**. Example (Sol Ring, id `91fdb56b-...`): `https://cards.scryfall.io/small/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.jpg?1782682494`. The docs say to take URLs from `image_uris` rather than constructing them: "Links to these images are available in each Card object's `image_uris` properties" (https://scryfall.com/docs/api/images) — **store the full URL verbatim including the `?timestamp`** (cache-buster; it changes when scans are updated).

**Sizes** (https://scryfall.com/docs/api/images, verified 2026 — note the docs were restructured and NEW WEBP variants exist):
| version | dims | format | note |
|---|---|---|---|
| `small` | 146×204 | JPG | "Designed for use as thumbnail or list icon" |
| `normal` | 488×680 | JPG | standard display |
| `large` | 672×936 | JPG | |
| `png` | 745×1040 | PNG | transparent, rounded |
| `border_crop` | 480×680 | JPG | |
| `art_crop` | varies | JPG | art only |
| `thumb` / `grid` / `display` | 146×204 / 488×680 / 672×936 | WEBP | new; "replaces small/normal/large" |
(`image_uris` in card objects still exposes the classic six keys; WEBP variants are newer additions.)

**Rate limits** (https://scryfall.com/docs/api/rate-limits, quoted): `/cards/search`, `/cards/named`, `/cards/random`, `/cards/collection` — **2/second (500ms)**; `/cards/manifest` — 10/minute; **all other API methods — 10/second (100ms)**. Crucially: **"The direct file origins located at \*.io do not have rate limits"** — i.e. `cards.scryfall.io` (images) and `data.scryfall.io` (bulk) are explicitly exempt, which sanctions hotlinking card images at any volume. 429 ⇒ 30-second lockout; ignoring 429s ⇒ block. API requests (api.scryfall.com) **must include an accurate `User-Agent` and an `Accept` header** (https://scryfall.com/docs/api). Also: "If you need to … resolve a large number of card images, you must use the bulk data files." No API key needed. Usage guidelines (https://scryfall.com/docs/api): data/images are free "as part of the Wizards of the Coast Fan Content Policy"; you may not paywall Scryfall data, may not imply Scryfall endorsement, and must not imply the cards are from another game/creator.

**Bulk data**: discovery endpoint `https://api.scryfall.com/bulk-data` (verified live). `oracle_cards` entry: description (quoted from live API): "A JSON file containing one Scryfall card object for each Oracle ID on Scryfall. The chosen sets for the cards are an attempt to return the most up-to-date recognizable version of the card." — i.e. **one-entry-per-oracle-id guaranteed, canonical printing chosen for you** (exactly the "one canonical image" you want). Current size: **179,321,865 B (~171 MB) uncompressed; `jsonl_download_uri` (gzipped JSONL) = 22,735,788 B (~23 MB)** — the docs now recommend the JSONL variant (https://scryfall.com/docs/api/bulk-data). Download URIs are **timestamped and rotate** (e.g. `https://data.scryfall.io/oracle-cards/oracle-cards-20260705090234.json`) — always resolve the current URI via the discovery endpoint first. "Bulk data is only collected once every 12-24 hours"; "If you only need gameplay information, downloading card data once per week or right after set releases would most likely be sufficient."

**`image_uris` / `card_faces` per layout in oracle_cards** (verified live): `normal`/`split`/`adventure`/`flip`/`aftermath`/`meld` ⇒ top-level `image_uris` only (split's `card_faces` exist but have **no** per-face images — both halves are on one scan); `transform`/`modal_dfc` ⇒ **no top-level `image_uris`**, instead `card_faces[i].image_uris` with `/front/` for face 0 and `/back/` for face 1; meld parts and the meld result are **separate oracle entries under their single-face names** (`"Bruna, the Fading Light"`, `"Brisela, Voice of Nightmares"`), each with a top-level image.

## 4. Recommended pipeline — verdict

- **(a) AtomicCards alone: NOT viable for images.** Verified: zero `scryfallId` in the whole file; no oracle-id-addressable image URL scheme exists.
- **(c) oracle_cards alone: viable but ignores the user's MTGJSON choice**, and loses MTGJSON conveniences (`leadershipSkills.commander`, `faceManaValue`, `asciiName`, `edhrecRank`, `isFunny`, cleanly pre-deduplicated atomic names), and requires filtering out ~7,600 non-playable entries (tokens 1,194 + double_faced_token 80, art_series 2,243, emblems 87, memorabilia set_type 2,695…) that **AtomicCards never contains in the first place** (verified: no token/art_series/emblem layouts in atomic).
- **(b) RECOMMENDED: AtomicCards as source of truth + minimal join to oracle_cards for images only.** Join key: `data[name][0].identifiers.scryfallOracleId` ⇔ oracle_cards `oracle_id`. Coverage verified: **35,557/35,557 atomic faces have an oracleId (100%)**, and oracle_cards has one entry per oracle id including Alchemy (`set_type: "alchemy"`, 746 entries) — expect ~zero join misses; log any and fall back to `GET https://api.scryfall.com/cards/named?exact=<name>` at ≤2 req/s.

**Concrete pipeline (one DB row per playable name):**
1. `GET https://mtgjson.com/api/v5/AtomicCards.json.xz` (24 MB) → decompress → parse (156 MB JSON; fine in Node 24 memory, or stream).
2. Resolve current oracle bulk: `GET https://api.scryfall.com/bulk-data/oracle_cards` (or list endpoint) with proper `User-Agent`/`Accept` → download `jsonl_download_uri` (~23 MB gzip) → stream line-by-line → build `Map<oracle_id, {scryfallId, imgSmall, imgNormal, backImgSmall?, backImgNormal?}>` using top-level `image_uris` else `card_faces[*].image_uris`.
3. For each atomic key: **skip** `layout ∈ {vanguard, planar, scheme}` (not playable cards); **skip** names starting `"A-"` (217 Alchemy rebalances; they also naturally lack `legalities.commander`); **skip** reversible duplicates (`nameA === nameB` around `//`); dedupe by oracleId.
4. Row: `name`, `faceNames[]`, `manaCost`, `manaValue`, `typeLine` (`type`), `oracleText` (`text`, faces joined `\n//\n`), `power/toughness/loyalty/defense`, `colorIdentity`, `keywords`, `layout`, `commanderLegality` = `legalities.commander ?? "Not Legal"`, `canBeCommander` = `leadershipSkills.commander ?? false`, `scryfallOracleId`, `imageSmall/imageNormal` (+ back-face URLs for transform/modal_dfc), `asciiName` (matching aid), `isFunny`, `hasAlternativeDeckLimit`.
5. Build lookup indexes for decklist import: full `name`, each `faceName`, front half of `//` names, and `asciiName` (all lowercased) — required because paste formats reference `"Bruna, the Fading Light"`/`"Delver of Secrets"` without the `//` suffix.
6. Do NOT hard-exclude non-Legal cards — store the legality string and warn in the UI (house-rules groups exist); default deck validation = `commanderLegality === "Legal"` (+ `"Banned"` visible with a flag).

## 5. Implementer's checklist (licensing, cadence, filtering)

**Licensing/attribution:**
- **Wizards Fan Content Policy** (https://company.wizards.com/en/legal/fancontentpolicy): app must be free (no payments/subscriptions/registrations gating content; donations/ads OK); do NOT use MTG logos/trademarks; must display the exact notice: *"[App name] is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC."*
- **Scryfall** (https://scryfall.com/docs/api): no paywalling of Scryfall data, no implied Scryfall endorsement, don't imply cards are from another game; card images/text are copyright Wizards. Hotlinking images from `cards.scryfall.io` is effectively sanctioned (no rate limits on `*.scryfall.io` file origins), but caching/re-hosting the small images locally is also fine and kinder.
- **MTGJSON** (https://mtgjson.com/faq/): MIT license, free; attribution appreciated, not legally required beyond MIT.

**Update cadence:** MTGJSON rebuilds **daily** ("Builds kick off at 1:00AM EST and go live at 9:00AM EST", https://mtgjson.com/faq/; confirmed `Last-Modified: 2026-07-04`). Scryfall bulk every **12–24h**; Scryfall itself says weekly refresh suffices for gameplay data. → a weekly cron re-import (or manual trigger after set releases) is appropriate.

**Filtering gotchas (all verified in current data):**
- **Tokens/art cards/emblems/memorabilia: already absent from AtomicCards** — nothing to do (they only appear in oracle_cards; since the join direction is atomic→oracle, they never enter your DB).
- **Alchemy/digital**: atomic keys prefixed `"A-"` (217). Their `legalities` contain only `brawl`/`historic` etc. (verified: `A-Alrund…` = `{brawl: Legal, historic: Legal}`) — the `A-` prefix test plus absent `legalities.commander` both work. In Scryfall terms they'd be `digital: true, games: ["arena"]` (2,141 such oracle entries).
- **Non-card layouts to drop**: `vanguard` (107), `planar` (207), `scheme` (102). Keep `saga/class/case/prototype/mutate/leveler/host/augment/flip/aftermath/prepare` — real cards.
- **Un-set/funny cards**: do NOT filter on `isFunny` blindly — verified that Unfinity eternal-legal cards (`Space Beleren`, `Saw in Half`) have `legalities.commander: "Legal"` (and `isFunny` unset) while acorn-only cards simply lack the `commander` key. **Filter/flag on `legalities.commander` presence, not on `isFunny`.**
- **Commander legality lives at** `legalities.commander` with values `"Legal" | "Banned" | "Restricted"` (MTGJSON capitalization; verified: Sol Ring `commander: "Legal"`, Black Lotus `commander: "Banned"`, Ancestral Recall `vintage: "Restricted"`; **missing key = not legal**, e.g. un-set cards have `legalities: {}`). Scryfall's equivalent is lowercase `legal | not_legal | banned` (verified distribution: 31,622 / 6,528 / 83). All 23 MTGJSON format keys: alchemy, brawl, commander, duel, explorer, future, gladiator, historic, historicbrawl, legacy, modern, oathbreaker, oldschool, pauper, paupercommander, penny, pioneer, predh, premodern, standard, standardbrawl, timeless, vintage (https://mtgjson.com/data-models/legalities/).
- **"Can be your commander"** is separate: `leadershipSkills` — live data has 5 booleans `{brawl, commander, oathbreaker, pauper_commander, predh}` (docs page only lists 3 — docs lag; verified Atraxa `{commander: true, …}`).
- Basic lands: `supertypes: ["Basic"]`, `legalities.commander: "Legal"` — exempt from singleton rule in your deck validator, along with `hasAlternativeDeckLimit: true` cards (Seven Dwarves, Persistent Petitioners…).
- Card names can contain `"` (e.g. `"Ach! Hans, Run!"` key is `"\"Ach! Hans, Run!\""`) and unicode (use `asciiName` fallback for matching).