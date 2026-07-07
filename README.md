# Arpenteurs

A self-hosted online table for **Magic: The Gathering — Commander** (up to 4 players). A modern replacement for Cockatrice/XMage: faster, lighter, more user-friendly. Like a real table, the app enforces **no game rules** — it gives you a shared battlefield, zones, counters and dice; players enforce the rules socially.

## Features

- Ephemeral identity: pick a username, no account — a browser cookie remembers you.
- Lobbies with invite links, optional passwords, public/unlisted visibility, up to 4 seats.
- Decklist import by pasting text (Moxfield / MTGA / Archidekt / plain formats), commander designation, unresolved-line report with did-you-mean suggestions.
- Full card catalog (~31k Commander-playable cards) from MTGJSON, low-bandwidth images from Scryfall.
- Real-time play over WebSockets: server-authoritative, per-player redacted — hand contents and library order physically never reach other clients (property-tested in CI).
- London mulligans, scry/look/search overlays, reveal, tokens (with auto-suggestions parsed from oracle text), commander damage & tax, poison, mana pool, markers (monarch, initiative, day/night), attack/target arrows, die rolls, chat, hidden-info-safe game log.
- Reconnect mid-game; games survive server restarts (DB snapshots).
- `/admin` backoffice: live lobbies/games, card catalog browser, KPIs.

## Stack

Nuxt 4 (SSR + Nitro API + native WebSockets) · Prisma 7 · PostgreSQL 17 · Pinia · Nuxt UI v4 / Tailwind v4 · zod v4 · Vitest. Single-node by design.

## Getting started

```bash
cp .env.example .env          # adjust if needed (NUXT_ADMIN_TOKEN for /admin)
pnpm install
pnpm db:up                    # postgres:17-alpine via docker compose
pnpm db:migrate
pnpm cards:import             # ~2-3 min: MTGJSON AtomicCards ⋈ Scryfall images
pnpm dev
```

| Script | What |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | dev server / prod build / run `.output` |
| `pnpm test` | full unit suite (incl. the CI-blocking hidden-info leak fuzzer) |
| `node tests/e2e/game-flow.mjs [url]` | end-to-end: users → decks → lobby → ws game (needs a running server + imported catalog) |
| `pnpm cards:import` | idempotent catalog refresh (weekly / after set releases) |
| `pnpm db:studio` | Prisma Studio |

## Architecture

`docs/PLAN.md` is the source of truth; `docs/design/` holds the research and design inputs. Highlights:

- `server/game/` — the engine: pure-ish reducer, **`visibility.ts` is the single redaction path** (never serialize game state around it), room registry with single-flight rehydration, write-behind event log (pre-redacted log lines), periodic snapshots (also flushed on Nitro close → lossless dev reloads).
- `shared/` — TS types + zod message schemas shared client/server (every ws message is bound-checked).
- Card instance ids are **re-minted whenever a card enters a hidden zone** and on every shuffle — hidden cards cannot be tracked across zones, by construction.

## Legal

Arpenteurs is unofficial Fan Content permitted under the [Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.

Card data by [MTGJSON](https://mtgjson.com) (MIT) · card images by [Scryfall](https://scryfall.com). This app is free and must remain free.
