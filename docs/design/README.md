# Design inputs (historical)

These documents are the raw inputs that produced [../PLAN.md](../PLAN.md): two research reports (facts verified live on 2026-07-05), two architecture design docs, and two adversarial critique reports.

**⚠️ `docs/PLAN.md` is the single source of truth.** The two design docs contradict each other in places (persistence model, API paths, schema details) — the critics flagged those contradictions and PLAN.md is the reconciliation. When a design doc here disagrees with PLAN.md, PLAN.md wins.

| File | What it is |
|---|---|
| `research-card-data.md` | Verified MTGJSON AtomicCards + Scryfall bulk/CDN facts (formats, sizes, URLs, licensing) |
| `research-stack.md` | Verified Nuxt 4.4 / Nitro WebSockets / Prisma 7 / library versions + gotchas |
| `design-data-lobby.md` | Prisma schema, HTTP API, lobby lifecycle, import pipeline design |
| `design-engine-protocol.md` | Game state model, wire protocol, redaction rules, server/client architecture |
| `critique-feature-parity.md` | Gaps vs. Cockatrice/real-table UX (arrows, mulligan, tax, concede, UI spec…) |
| `critique-robustness.md` | Security/correctness findings (id tracking, tutor exploit, races, flood control…) |
