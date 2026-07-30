# Arpenteurs — repo guide

Online MTG Commander table (Cockatrice replacement). `docs/PLAN.md` is the architecture source of truth — read it before structural changes. `docs/design/` = historical inputs (PLAN.md wins on conflict).

## Commands

- `pnpm test` — full unit suite. `tests/unit/leak.spec.ts` (manual mode) and `tests/unit/rules-leak.spec.ts` (enforced mode) are **CI-blocking**: they fuzz games and assert zero hidden-information leaks. Never weaken them to make a change pass.
- `pnpm db:up && pnpm db:migrate` — local Postgres (docker, port 5432) + migrations. Prisma 7: connection config lives in `prisma.config.ts` (NOT in schema.prisma datasource).
- `pnpm cards:import` — refresh the card catalog (idempotent, needs network).
- `pnpm tokens:import` — fetch representative token art (Beast/Soldier/Treasure/…) into the `TokenImage` table (idempotent, needs network). Tokens aren't in AtomicCards, so this is separate from `cards:import` and survives a card re-import; `/api/cards/display` resolves `itok:`/`tok:` defNames to this art via `shared/utils/tokenDefName.ts`.
- `node tests/e2e/game-flow.mjs http://localhost:3998` — full ws e2e (server must be running with an imported catalog).
- `pnpm build && pnpm start` — always verify a Nitro/Prisma-touching change builds; dev-mode success does not guarantee prod bundling.
- `pnpm typecheck` — **part of the gate, not optional**. Neither `vitest` (type-stripping) nor `nuxt build` typechecks, so the shared types can silently drift away from the engine that uses them: `shared/rules/types.ts` is the client contract, and a stale union there means `redact` publishes something the client can't represent. Run it with the tests on any change to `shared/rules/`, `server/rules/` or the board components.

## Invariants (violating these = bug, no exceptions)

1. **All game state reaching a client goes through `server/game/visibility.ts`** (`redactCard`/`redactStateFor`/`redactPeek`). Never JSON-serialize `ServerGameState`, `state.catalog`, or raw `CardInstance`s to a peer.
2. **Library order is never serialized to anyone** — counts only. Peeks (scry/look/search) are the only sanctioned window, actor-only.
3. **Card instance ids are re-minted on hidden-zone entry** (hand/library/face-down exile) and on every shuffle (`remintId`/`shuffleLibrary` in reducer.ts). Any new zone-moving code must preserve this.
4. Every ws message field is bounded with zod — manual mode in `shared/schemas/messages.ts`, enforced mode in `shared/rules/messages.ts`. New actions need bounds + reducer/engine handler + log line + leak-fuzzer coverage (both `leak.spec.ts` and `rules-leak.spec.ts` are CI-blocking and history-aware).
5. Usernames/chat render as text interpolation only — never `v-html`.
6. **Two game modes coexist** (Lobby.mode): MANUAL — no MTG rules enforcement, structural legality only (the original premise); ENFORCED — the rules engine under `server/rules/` + `shared/rules/` (see `docs/RULES-ENGINE.md`; 2–4 player Commander). Enforced mode is an **assisted table**: implemented cards run automatically; unimplemented cards get a catalog-derived fallback body (`server/rules/cards/fallback.ts`), are never auto-destroyed by SBA, and are hand-run via manual overrides (`r.m*`). Manual-mode behaviour must never change as a side effect of engine work. New enforced cards/mechanics need: DSL definition + engine support + unit tests + `rules-leak.spec.ts` still green. Evergreen combat keywords are automated (M-R1) — French-vanilla creatures declare `keywords: Keyword[]` and the engine enforces them in combat; only add a card as *implemented* (not a fallback) when its ENTIRE rules are captured (keywords + vanilla body), else its unhandled text is silently ignored. Manual overrides must only touch the actor's own objects and must re-mint ids on public→hidden moves (invariant #3).

## Conventions

- Nitro auto-imports `server/utils/*` (db, requireUser, …); shared code via `#shared/...` (also aliased in vitest.config.ts).
- zod v4, `readValidatedBody`/`getValidatedQuery`; errors via `createError`.
- Prisma client is generated INTO `server/generated/prisma` (gitignored) — `pnpm install` runs `prisma generate`. Import types from there, not `@prisma/client`.
- UI: Nuxt UI v4 + Tailwind v4 utilities; English UI text.
- Node 24 runs `.ts` scripts natively (type-stripping): relative imports in `scripts/` need explicit `.ts` extensions; no enums/namespaces in those files.
