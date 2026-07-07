# Arpenteurs — repo guide

Online MTG Commander table (Cockatrice replacement). `docs/PLAN.md` is the architecture source of truth — read it before structural changes. `docs/design/` = historical inputs (PLAN.md wins on conflict).

## Commands

- `pnpm test` — full unit suite. `tests/unit/leak.spec.ts` is **CI-blocking**: it fuzzes games and asserts zero hidden-information leaks. Never weaken it to make a change pass.
- `pnpm db:up && pnpm db:migrate` — local Postgres (docker, port 5432) + migrations. Prisma 7: connection config lives in `prisma.config.ts` (NOT in schema.prisma datasource).
- `pnpm cards:import` — refresh the card catalog (idempotent, needs network).
- `node tests/e2e/game-flow.mjs http://localhost:3998` — full ws e2e (server must be running with an imported catalog).
- `pnpm build && pnpm start` — always verify a Nitro/Prisma-touching change builds; dev-mode success does not guarantee prod bundling.

## Invariants (violating these = bug, no exceptions)

1. **All game state reaching a client goes through `server/game/visibility.ts`** (`redactCard`/`redactStateFor`/`redactPeek`). Never JSON-serialize `ServerGameState`, `state.catalog`, or raw `CardInstance`s to a peer.
2. **Library order is never serialized to anyone** — counts only. Peeks (scry/look/search) are the only sanctioned window, actor-only.
3. **Card instance ids are re-minted on hidden-zone entry** (hand/library/face-down exile) and on every shuffle (`remintId`/`shuffleLibrary` in reducer.ts). Any new zone-moving code must preserve this.
4. Every ws message field is bounded in `shared/schemas/messages.ts` (zod). New actions need bounds + reducer handler + log renderer + leak-fuzzer coverage.
5. Usernames/chat render as text interpolation only — never `v-html`.
6. No MTG rules enforcement — structural legality only (the whole product premise).

## Conventions

- Nitro auto-imports `server/utils/*` (db, requireUser, …); shared code via `#shared/...` (also aliased in vitest.config.ts).
- zod v4, `readValidatedBody`/`getValidatedQuery`; errors via `createError`.
- Prisma client is generated INTO `server/generated/prisma` (gitignored) — `pnpm install` runs `prisma generate`. Import types from there, not `@prisma/client`.
- UI: Nuxt UI v4 + Tailwind v4 utilities; English UI text.
- Node 24 runs `.ts` scripts natively (type-stripping): relative imports in `scripts/` need explicit `.ts` extensions; no enums/namespaces in those files.
