# Realtime Game Engine & Wire Protocol — Design Doc
**Project:** self-hosted Commander table (Cockatrice replacement) · Nuxt 4 / Nitro WS / Prisma 7 / PostgreSQL · manual rules, 4 players, server-authoritative

---

## 0. Core stance (read this first)

- **Server-authoritative, dumb clients.** The only game logic lives in one pure reducer on the server. Clients send *intents*, receive *redacted facts*, and render. No rules engine anywhere — the reducer enforces *structural* legality only (card exists, actor may touch it), never MTG rules.
- **Incremental redacted events with a per-game `seq`, full-snapshot resync.** (Argued in §2.1.)
- **One visibility function.** Snapshot redaction and event redaction share a single `visibleTo(card, viewer, state)` predicate. This is the anti-leak keystone (§3, §8).
- **Deterministic replay.** Every nondeterministic outcome (shuffle permutation, die roll) is captured in the persisted event row, so `snapshot + event tail → identical state` (§4.5).

---

## 1. State model (TypeScript)

All types live in `shared/types/` (auto-imported both sides), zod schemas in `shared/schemas/` imported via `#shared/schemas`.

```ts
// ---------- identity ----------
export type PlayerId = string   // uuid minted at seat claim, stable for the game
export type CardId   = string   // uuid per card *instance* in this game
export type CatalogId = string  // MTGJSON uuid of the printed card (null for custom tokens)

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C'

// ---------- turn ----------
export const STEPS = [
  'untap', 'upkeep', 'draw', 'main1',
  'combat_begin', 'attackers', 'blockers', 'damage', 'combat_end',
  'main2', 'end', 'cleanup',
] as const
export type Step = typeof STEPS[number]

export interface TurnState {
  order: PlayerId[]        // seat order, fixed at game start (randomized once)
  activePlayer: PlayerId
  step: Step
  turnNumber: number       // starts at 1
}

// ---------- player ----------
export interface ManaPool { W: number; U: number; B: number; R: number; G: number; C: number }

export interface PlayerState {
  id: PlayerId
  name: string
  seat: 0 | 1 | 2 | 3
  life: number                              // default 40
  poison: number
  counters: Record<string, number>          // free-form: 'energy', 'experience', 'rad', ...
  manaPool: ManaPool
  commanderIds: CardId[]                    // 1–2 (partners/background)
  commanderDamage: Record<CardId, number>   // key = *opposing* commander CardId → damage taken FROM it
  connected: boolean
  hasConceded: boolean
}

// ---------- zones ----------
export type ZoneKind = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'
export type ZoneRef  = { kind: ZoneKind; player: PlayerId } | { kind: 'stack' }

// ---------- cards ----------
export interface TokenSpec {
  name: string
  pt: string | null            // '1/1', '*/*', null for non-creatures (Treasure…)
  colors: ManaColor[]
  typeLine: string             // 'Token Creature — Soldier'
  text: string
  fromCatalogId: CatalogId | null  // set for copy-tokens → render the real card image
}

export interface CardInstance {
  id: CardId
  catalogId: CatalogId | null      // null only for custom tokens
  ownerId: PlayerId                // immutable — whose deck it belongs to
  controllerId: PlayerId           // mutable — steal effects, manual control changes
  zone: ZoneRef
  x: number; y: number             // battlefield free position, normalized 0..1 (ignored elsewhere)
  tapped: boolean
  faceDown: boolean                // morph, face-down exile, hidden plays
  faceIndex: number                // 0 = front; 1 = back face (transform / MDFC / flip)
  counters: Record<string, number> // '+1/+1', 'loyalty', 'charge', …
  attachedTo: CardId | null        // auras / equipment / fortify
  isToken: boolean                 // tokens are DELETED when they leave the battlefield
  tokenSpec: TokenSpec | null
  isCommander: boolean
  revealedTo: PlayerId[] | null    // extra visibility grants on a hidden card (null = default rules)
}

// ---------- private peek sessions (scry / look / search) ----------
export interface Peek {
  mode: 'scry' | 'look' | 'search'
  n: number                        // requested count (search: whole library)
  cardIds: CardId[]                // in current top-down order
}

// ---------- server-side full state (NEVER serialized to a client as-is) ----------
export interface ServerGameState {
  id: string
  status: 'lobby' | 'active' | 'ended'
  players: Record<PlayerId, PlayerState>
  cards: Record<CardId, CardInstance>        // every instance, full identity
  zones: {
    perPlayer: Record<PlayerId, Record<ZoneKind, CardId[]>>  // ordered; index 0 = TOP
    stack: CardId[]                                          // last = top of stack
  }
  turn: TurnState
  markers: { monarch: PlayerId | null; initiative: PlayerId | null }
  peeks: Partial<Record<PlayerId, Peek>>     // at most one active peek per player
  seq: number
}
```

**Invariant (reducer-maintained, asserted in tests):** `card.zone` and membership in exactly one `zones` array always agree. The arrays carry *order* (library order, graveyard stack, battlefield z-order, stack order); `card.zone` gives O(1) lookup.

**Client-side redacted state** — same shape, with hidden information *structurally impossible* to hold:

```ts
export type RedactedCard =
  | (CardInstance & { hidden?: never })                                   // visible to this viewer
  | (Omit<CardInstance, 'catalogId' | 'tokenSpec' | 'faceIndex'>          // identity stripped
      & { hidden: true; catalogId: null; tokenSpec: null })

export interface ClientGameState {
  id: string
  status: 'lobby' | 'active' | 'ended'
  you: PlayerId
  players: Record<PlayerId, PlayerState>
  cards: Record<CardId, RedactedCard>        // ONLY instances this viewer may see exist
  zones: {
    perPlayer: Record<PlayerId, {
      battlefield: CardId[]
      graveyard: CardId[]
      exile: CardId[]                        // face-down exile ids present, identity-stripped
      command: CardId[]
      hand: CardId[] | { count: number }     // ids + order for YOUR hand only
      library: { count: number }             // count-only for EVERYONE — see §3
    }>
    stack: CardId[]
  }
  turn: TurnState
  markers: { monarch: PlayerId | null; initiative: PlayerId | null }
  peek: (Peek & { cards: CardInstance[] }) | null   // YOUR active peek, full contents
  seq: number
}
```

Size check: 4 players × ~100-card decks + tokens ≈ 300–450 instances. Full redacted snapshot ≈ 60–120 KB pretty JSON, <30 KB gzipped (Nitro ws permessage-deflate). Cheap enough to send on every (re)connect.

---

## 2. Wire protocol

### 2.1 Decision: incremental events + seq, snapshot only for (re)sync

| | Full-state broadcast per action | **Incremental events + seq (chosen)** |
|---|---|---|
| Redaction code | Still needed per-recipient (4 different payloads) — no savings | Per-event, from the same visibility function |
| Bandwidth | ~30 KB gz × 4 recipients per tap/drag | 100–400 B per event |
| Client rendering | Full-tree diff every action; drag = snapshot storm | Targeted store patch; trivial CSS transitions |
| Game log | Needs a separate event feed anyway | Log lines ARE the events — one design |
| Complexity | One redaction path | Two paths (event + snapshot) — mitigated by shared visibility fn + property tests (§8) |

The would-be simplicity of full-state broadcast evaporates because redaction is per-recipient either way and a non-leaking log needs an event stream regardless. So: **events with `seq`, and the snapshot machinery (needed anyway for join/reconnect/restart) doubles as the resync path.**

**Seq semantics:** one accepted action → `state.seq += 1` → exactly **one** event per recipient, all carrying that seq (payloads differ per recipient due to redaction). Client asserts `incoming.seq === lastSeq + 1`; on any gap or overlap it sends `{ "type": "resync" }` and ignores further events until the `sync` arrives. `sync` unconditionally replaces the store (even if its seq is *lower* — covers crash-recovery where the server lost a write-behind tail, §4.5).

### 2.2 Envelopes

```jsonc
// client → server (flat, discriminated on "type"; optional "id" for error correlation)
{ "id": "c-41", "type": "card.move", "cardId": "…", "to": { "kind": "battlefield", "player": "p1" }, "x": 0.31, "y": 0.55 }

// server → client (every state event)
{ "seq": 812, "ts": 1751712000123, "type": "card.moved", "actor": "p1", /* payload */ }

// server → client rejection (no seq consumed, sent only to the actor)
{ "type": "error", "reqId": "c-41", "code": "NOT_CONTROLLER", "message": "You don't control this card." }

// full snapshot (on open, and answering "resync")
{ "type": "sync", "seq": 812, "state": { /* ClientGameState */ } }
```

All client messages validated by one zod v4 discriminated union `ClientMsg` in `shared/schemas/messages.ts`; server events by `ServerMsg` (used by client in dev to catch drift).

### 2.3 Client→server action catalog (complete for v1)

REST handles the non-realtime edges (SSR-friendly, big payloads): `POST /api/session` (mint username + httpOnly year-long `player_token` cookie), `POST /api/games` (create lobby, optional bcrypt-hashed password), `POST /api/games/:id/join` (password check → seat membership row), `POST /api/games/:id/deck` (paste import → `{ resolved: n, commander: [...], unresolved: [{line, reason}] }`; Moxfield `1 Sol Ring (C21) 125`, MTGA `1 Sol Ring (KLD) 232`, plain `1 Sol Ring` — strip set/collector/foil annotations, match by exact then case/diacritic-insensitive name against the 35k-card catalog), `GET /api/games/:id` (lobby info for SSR). Everything below is WS (`wss://host/ws/game?g=<gameId>`).

| # | `type` | Payload | Notes / covers |
|---|---|---|---|
| **Lobby** |||||
| 1 | `lobby.ready` | `{ ready: boolean }` | requires imported deck + designated commander |
| 2 | `lobby.start` | `{}` | host only; server randomizes turn order, shuffles all libraries, deals 7, snapshots |
| **Session** |||||
| 3 | `resync` | `{}` | answer: `sync` |
| 4 | `game.concede` | `{}` | player stays seated & visible, flagged |
| 5 | `game.leave` | `{}` | frees the seat in lobby; in-game = concede + disconnect |
| **Turn** |||||
| 6 | `turn.next` | `{}` | advance one step; `cleanup` wraps to next player's `untap`, bumps `turnNumber` when wrapping past last seat |
| 7 | `turn.setStep` | `{ step: Step }` | jump anywhere in current turn |
| 8 | `turn.pass` | `{}` | shortcut: next player, `untap` |
| **Player counters** |||||
| 9 | `player.life` | `{ delta: number }` | self only |
| 10 | `player.poison` | `{ delta: number }` | self only |
| 11 | `player.counter` | `{ name: string, delta: number }` | energy, experience, commander-tax… |
| 12 | `player.commanderDamage` | `{ commanderId: CardId, delta: number }` | adjusts YOUR damage-taken from that commander; life is NOT auto-linked in v1 (log line reminds) |
| 13 | `player.marker` | `{ marker: 'monarch'\|'initiative', playerId: PlayerId\|null }` | anyone may set (manual etiquette) |
| **Mana** |||||
| 14 | `mana.change` | `{ color: ManaColor, delta: number }` | clamped ≥ 0, self only |
| 15 | `mana.clear` | `{}` | zero all six, self only |
| **Deck** |||||
| 16 | `deck.draw` | `{ n: number }` | draw 1 or X (1 ≤ n ≤ library) |
| 17 | `deck.shuffle` | `{}` | crypto Fisher–Yates (§4.4) |
| 18 | `deck.mulligan` | `{ draw: number }` | hand → library, shuffle, draw `draw` (player applies London bottoming manually afterwards via card.move) |
| 19 | `deck.scry` | `{ n: number }` | opens private peek (mode `scry`) |
| 20 | `deck.look` | `{ n: number }` | private peek, mode `look` (look at top X) |
| 21 | `deck.search` | `{}` | private peek over the whole library, mode `search` |
| 22 | `peek.resolve` | `{ toTop: CardId[], toBottom: CardId[], moves: [{ cardId, to: MoveTarget }] }` | one resolution shape for all three modes: scry = toTop (new order) + toBottom; look = usually all toTop unchanged; search = `moves` (picks) then **forced shuffle**; any peeked card not mentioned keeps relative order on top |
| 23 | `peek.cancel` | `{}` | close overlay, library untouched (search still forces shuffle — you saw the order) |
| 24 | `deck.revealTop` | `{ n: number }` | PUBLIC: broadcast identities of top n, order preserved |
| 25 | `hand.reveal` | `{}` | PUBLIC: broadcast full hand contents |
| **Cards** |||||
| 26 | `card.move` | `{ cardId, to: MoveTarget, faceDown?: boolean, x?: number, y?: number }` where `MoveTarget = ZoneRef & { index?: number \| 'top' \| 'bottom' }` | THE universal move: play, discard, exile, bounce, tuck top/bottom/N-th, to stack, to command zone, from graveyard, from a peek. Tokens moving off battlefield are deleted (event says so). Moving into library at a known index is public knowledge of *position*, never of surrounding cards |
| 27 | `card.position` | `{ cardId, x: number, y: number }` | battlefield drag; throttled client-side to ~1/100 ms; **not logged** |
| 28 | `card.tap` | `{ cardIds: CardId[], tapped: boolean }` | multi-select tap/untap |
| 29 | `board.untapAll` | `{}` | untaps all cards you control |
| 30 | `card.face` | `{ cardId, faceDown?: boolean, faceIndex?: number }` | turn face-down/up, transform/flip |
| 31 | `card.counter` | `{ cardId, name: string, delta: number }` | +1/+1, loyalty, … |
| 32 | `card.attach` | `{ cardId, targetId: CardId \| null }` | null = unattach; cycle check server-side |
| 33 | `card.control` | `{ cardId, controllerId: PlayerId }` | manual steal/donate effects |
| 34 | `card.reveal` | `{ cardId, to: PlayerId[] \| 'all' }` | reveal a hand card / face-down card (sets `revealedTo` or broadcasts) |
| 35 | `token.create` | `{ spec: TokenSpec, quantity: number, tapped?: boolean }` | manual dialog and auto-suggest (§6) both land here |
| **Table talk** |||||
| 36 | `chat.send` | `{ text: string }` | 1–500 chars |
| 37 | `game.roll` | `{ sides: number, count?: number }` | crypto `randomInt` |
| 38 | `game.coin` | `{ count?: number }` | |

**Authorization matrix (checked before the reducer):** rows 9–12, 14–25, 29 → self only. Card actions (26–34) → actor must be `controllerId` of the card (for non-battlefield zones: `ownerId`); exception: `card.move` out of an opponent's public zone is **denied** in v1 (ask them). Turn actions, markers, chat, dice → any seated player. Lobby.start → host. Everything else rejected with `error`.

### 2.4 Server→client events

Events are **compound facts**: they carry the resulting values the client needs (counts, the redacted card object), so client appliers are dumb assignments — no game logic client-side. Catalog mirrors actions: `lobby.updated`, `game.started`, `player.connected/disconnected`, `player.updated` (life/poison/counters/mana/commanderDamage — one event type, field-patch payload), `marker.set`, `turn.changed`, `deck.drew`, `deck.shuffled`, `deck.mulliganed`, `peek.opened` *(actor only)*, `peek.updated` *(actor only)*, `peek.resolved`, `deck.revealedTop`, `hand.revealed`, `card.moved`, `card.positioned`, `card.tapped`, `board.untappedAll`, `card.faceChanged`, `card.counterChanged`, `card.attached`, `card.controlChanged`, `card.revealed`, `tokens.created`, `chat`, `dice.rolled`, `coin.flipped`, `player.conceded`, `game.ended`, `sync`, `error`.

**Real examples — the same action, per recipient:**

*Alice (p1) draws 2:*
```jsonc
// → Alice
{ "seq": 813, "type": "deck.drew", "actor": "p1", "n": 2,
  "cards": [ { "id": "c-812", "catalogId": "a4f0…", "ownerId": "p1", "controllerId": "p1",
               "zone": { "kind": "hand", "player": "p1" }, "tapped": false, "faceDown": false,
               "faceIndex": 0, "counters": {}, "attachedTo": null, "isToken": false,
               "tokenSpec": null, "isCommander": false, "revealedTo": null, "x": 0, "y": 0 },
             { "id": "c-455", "catalogId": "9b21…", /* … */ } ],
  "handCount": 9, "libraryCount": 84 }
// → Bob, Carol, Dave (no ids, no identities)
{ "seq": 813, "type": "deck.drew", "actor": "p1", "n": 2, "handCount": 9, "libraryCount": 84 }
```

*Bob plays a card from hand to battlefield:*
```jsonc
// → everyone (identical: card becomes public; opponents learn the id NOW, not before)
{ "seq": 814, "type": "card.moved", "actor": "p2",
  "card": { "id": "c-231", "catalogId": "77aa…", "zone": { "kind": "battlefield", "player": "p2" },
            "x": 0.42, "y": 0.61, "tapped": false, /* full instance */ },
  "from": { "kind": "hand", "player": "p2" },
  "counts": { "hand": { "p2": 6 } } }
```

*Alice scries 2 → resolves 1 top / 1 bottom:*
```jsonc
// deck.scry → Alice only:
{ "seq": 815, "type": "peek.opened", "mode": "scry", "n": 2,
  "cards": [ { "id": "c-118", "catalogId": "…" }, { "id": "c-903", "catalogId": "…" } ] }
// deck.scry → others (log-only):
{ "seq": 815, "type": "peek.opened", "actor": "p1", "mode": "scry", "n": 2 }
// peek.resolve → everyone (contents never mentioned):
{ "seq": 816, "type": "peek.resolved", "actor": "p1", "mode": "scry",
  "summary": { "toTop": 1, "toBottom": 2 } }   // toBottom counts "bottom" placements incl. unmentioned? no — exact counts of the resolution
```

*Die roll:* `{ "seq": 817, "type": "dice.rolled", "actor": "p3", "sides": 20, "results": [14] }`

### 2.5 Game-log design (leak-proof by construction)

There is **no separate log channel**. The client renders log lines from the event stream it already received — so a viewer's log can only contain what that viewer was allowed to see. Rendering table (excerpt):

| Event (as received by an opponent) | Rendered line |
|---|---|
| `deck.drew {actor, n:2}` (no `cards`) | "Alice drew 2 cards." |
| `peek.opened {mode:'scry', n:2}` | "Alice is scrying 2…" |
| `peek.resolved {mode:'scry', summary:{toTop:1,toBottom:1}}` | "Alice scried 2 (1 to top, 1 to bottom)." |
| `peek.opened {mode:'search'}` / `peek.resolved {mode:'search', summary:{toHand:1}, shuffled:true}` | "Bob searched his library." / "Bob put a card into his hand and shuffled." |
| `card.moved` w/ hidden destination (battlefield→hand of owner) | "Carol returned Llanowar Elves to her hand." (identity was already public) |
| `card.moved` hand→library faceDown | "Dave put a card from his hand on top of his library." |
| `hand.revealed {cards:[…]}` | "Alice revealed her hand: Sol Ring, …" |
| `card.positioned` | *(not logged)* |

Rule of thumb encoded in the redactor: **an event names a card iff its identity is public to that viewer at the moment of the event** (was public before, or becomes public by entering a public zone face-up, or is explicitly revealed).

---

## 3. Hidden-information redaction rules (exact table)

“Identity” = `catalogId` + faces + tokenSpec. “Presence” = an id exists at some position. Instance ids are **only ever serialized to a viewer once identity is visible to them** (hidden zones expose counts, not ids — prevents cross-zone tracking, e.g. knowing the tutored card is the one played 3 turns later).

| Zone / situation | Owner sees | Opponents see | Log says |
|---|---|---|---|
| **Own hand** | Full identities + order | — | — |
| **Opponent hand** | — | `{ count }` only; no ids | "drew N", "discarded X" (X named — graveyard is public) |
| **Library (all)** | `{ count }` only — **order is NEVER serialized to any client, owner included**; server-only | `{ count }` only | "shuffled", "drew N", "put a card on top" |
| **Battlefield, face-up** | full | full (incl. counters, tapped, attachments, position) | full names |
| **Battlefield, face-down** | full identity (`faceDown:true` + real `catalogId`) | presence + position + counters, `hidden:true`, `catalogId:null` | "played a card face down"; never the name |
| **Face-down card with `revealedTo`** | full | full for listed viewers, hidden for the rest | "revealed a face-down card to Carol" (no name for others) |
| **Graveyard** | public, ordered (top last) | same | full names |
| **Exile, face-up** | public | public | full names |
| **Exile, face-down** (foretell, etc.) | full identity | presence only, `hidden:true` | "exiled a card face down" |
| **Command zone** | public | public | full names |
| **Stack** | public (face-up); face-down allowed → hidden as battlefield rule | same | full names / "a face-down card" |
| **Scry / look / search peek** | full contents in `peek.opened/updated` — **actor only**; peek survives reconnect via `sync.state.peek` | log-only event, `n` and mode | "is scrying 2", "searched their library" |
| **Reveal top X / reveal hand** | broadcast contents to all (or to `to:` list) | contents (if addressed) | names listed |
| **`sync` snapshot** | Composed with exactly the same rules; `peek` included for the viewer only | idem | — |

Enforcement: `redactCardFor(viewer, card, state): RedactedCard | 'omit'` and `redactEventFor(viewer, event, state)` both call the single `visibleTo()`. `omit` for hidden-zone cards (they simply don't exist in `ClientGameState.cards`).

---

## 4. Server architecture (Nitro)

### 4.1 Files

```
server/
  routes/ws/game.ts        # defineWebSocketHandler (namespace /ws/game)
  api/…                    # REST: session, games, join, deck import
  game/
    room.ts                # registry, lifecycle, rehydration, eviction
    reducer.ts             # PURE: (state, action, fx) → { state, results }
    redact.ts              # visibleTo / redactEventFor / redactStateFor
    persist.ts             # event append queue + snapshot policy
    rng.ts                 # crypto shuffle / rolls
  utils/db.ts              # Prisma 7 singleton (adapter-pg), globalThis-cached in dev
shared/
  types/game.ts  schemas/messages.ts  utils/tokenParse.ts
```

### 4.2 Room registry

```ts
interface Room {
  state: ServerGameState
  peers: Map<string /* peer.id */, { peer: Peer; playerId: PlayerId }>
  persist: PersistQueue        // ordered write-behind (§4.5)
  actionsSinceSnapshot: number
  snapshotTimer: NodeJS.Timeout | null
  evictTimer: NodeJS.Timeout | null
}
const rooms = new Map<string, Room>()   // module-level; single-node by design
```

No crossws pub/sub topics: with ≤4 peers and **per-recipient payloads**, iterate `room.peers` and `peer.send()` each their own redaction (`peer.publish` excludes the sender anyway, which is wrong for us — the actor must receive the authoritative echo).

### 4.3 Connection lifecycle (works around verified Nitro facts)

- `upgrade(req)`: parse `req.headers.get('cookie')` with the `cookie` package, look up the token → session; look up `?g=` membership. Unknown/unauthorized → `return new Response(null, { status: 401 })`. **Do not rely on returned context** (nuxt#33829).
- `open(peer)`: re-parse the cookie from `peer.request.headers.get('cookie')` (the documented workaround), resolve `playerId`. If the room isn't in the registry → **rehydrate** (§4.5). If this player already has a live peer → `oldPeer.close(4000, 'superseded')` (single session per player). Register, mark `players[p].connected = true` (emits `player.connected`, seq++), then `peer.send(sync)` with that player's redacted snapshot. Reconnect, dev-reload recovery, and cold restart are all this same code path.
- `close(peer)`: mark disconnected (event), start eviction timer if the room has zero peers.
- Heartbeat: client sends `"ping"` (VueUse heartbeat), handler replies `"pong"` before JSON parsing.

### 4.4 Action pipeline (the hot path)

```ts
// message(peer, message) — synchronous from validate through broadcast: this IS the
// serialization mechanism. Node runs one message handler at a time; with zero awaits
// before the state mutation, near-simultaneous actions from 4 players are applied in
// arrival order and each reducer run sees the previous result. No locks, no priority.
const parsed = ClientMsg.safeParse(message.json())
if (!parsed.success) return peer.send({ type: 'error', code: 'BAD_MSG', … })
const auth = authorize(room.state, playerId, parsed.data)      // §2.3 matrix
if (!auth.ok) return peer.send({ type: 'error', reqId, code: auth.code, … })

const fx = makeFx()                                            // records rng draws
const { state, event } = reduce(room.state, parsed.data, playerId, fx)  // pure + throws ActionError
room.state = state
room.state.seq++
room.persist.append({ gameId, seq, actorId: playerId,
                      action: parsed.data, fx: fx.outcomes })  // ordered write-behind
for (const { peer: p, playerId: viewer } of room.peers.values())
  p.send(redactEventFor(viewer, event, state))                 // includes the actor
maybeSnapshot(room)                                            // every 25 actions OR 15 s debounce
```

- **Reducer purity:** `reduce` never touches Date/Math.random/DB; all nondeterminism flows through `fx` (`fx.shuffle(arr)` → crypto Fisher–Yates using `crypto.randomInt(i + 1)`, records the permutation; `fx.roll(sides)` records the result). This is what makes replay exact.
- **Rejections are free:** invalid/unauthorized actions consume no seq and are visible only to the actor.
- Snapshot triggers: 25 actions, 15 s idle debounce, plus immediate on `game.started`, `game.ended`, and last-peer-disconnect.

### 4.5 Persistence, restart recovery, eviction

Prisma models (sketch): `Player(token, name)`, `Game(id, status, hostId, passwordHash?, snapshot Json, snapshotSeq Int, updatedAt)`, `GameSeat(gameId, playerId, seat, deck Json)`, `GameEvent(gameId, seq, actorId, action Json, fx Json, createdAt, @@id([gameId, seq]))`.

- **Write-behind, ordered:** `PersistQueue` chains inserts on one promise per room (order preserved), never blocks the broadcast. Crash window = the last ≤1 s of actions; acceptable for a manual game because recovery emits `sync` and clients replace state unconditionally (§2.1) — the table just redoes a click or two. (Trade-off noted; flipping to await-before-broadcast is a 3-line change if it ever matters.)
- **Rehydrate (lazy):** on first contact with an unknown `gameId`: load `Game.snapshot`, then `GameEvent WHERE seq > snapshotSeq ORDER BY seq`, and re-run the reducer feeding each row's stored `fx` outcomes back in (replayed shuffle reproduces the exact permutation; replayed roll the exact result). Deterministic ⇒ byte-identical state. No eager boot scan needed — this also absorbs Nitro dev-server reloads wiping module state (verified pitfall).
- **Eviction:** all peers gone → after 10 min, final snapshot + `rooms.delete`. Game ended → snapshot, 5 min grace for "good game" chat, evict. DB hygiene: cron/route deleting `Game` + events `updatedAt > 7 days` for non-ended, 24 h for ended.

---

## 5. Client architecture

- **`app/stores/game.ts` (Pinia 3):** holds `ClientGameState`, `lastSeq`, `log: LogEntry[]`, `conn: 'connecting'|'open'|'resyncing'|'down'`. One `applyEvent(ev)` switch of dumb field assignments (payloads carry resulting values, §2.4) + `applySync(state)`. Log lines derived in the same pass (§2.5).
- **`app/composables/useGameSocket.ts`:** VueUse `useWebSocket(wsUrl, { immediate: false, autoReconnect: { retries: -1, delay: exp backoff 0.5→8 s }, heartbeat: { message: 'ping', pongTimeout: 10_000 } })`; `open()` in `onMounted` only (SSR-safe); URL built at mount from `location`. On message: `sync` → `applySync`; event with `seq === lastSeq+1` → apply; else → send `resync` once and buffer-drop until `sync`. Exposes `send(action)` (queues while reconnecting? no — drops with a toast; manual game, user just re-clicks).
- SSR renders page frame + lobby data via `useFetch`; board is `<ClientOnly>` painted by the first `sync` (verified hydration guidance).
- **Optimistic updates: NONE in v1**, with one cosmetic carve-out.
  - *For:* perceived-zero latency.
  - *Against (winning):* self-hosted single node, RTT typically 5–60 ms, worst-case <100 ms — a tap that confirms in 40 ms is indistinguishable from local. Optimistic state needs pending-action tracking, rollback on rejection, and reconciliation against the seq stream — the single largest bug source in realtime clients — to shave latency nobody perceives at these RTTs with 4 trusted players. Server echo also gives free total ordering when two players grab the same card.
  - *Carve-out:* **battlefield dragging** renders the local drag position immediately (pure view-layer transform), sends throttled `card.position`, and lets the echoed events (idempotent assignments) land silently. Without this, dragging at even 50 ms RTT visibly rubber-bands. This is not optimistic *state* — nothing to roll back; the store is only ever server truth.

---

## 6. Token auto-suggestion from oracle text

Pure function in `shared/utils/tokenParse.ts` (unit-tested against a fixture corpus), run client-side when the token dialog opens with a source card selected. Two stages:

**Stage 1 — named-token lookup** (runs first): `/creates? (?:a|an|one|two|three|\d+|x) (Treasure|Food|Clue|Blood|Gold|Map|Powerstone|Incubator|Junk|Shard) tokens?/i` → canned `TokenSpec` table (~12 entries with correct type lines/text: Treasure = "Artifact — Treasure, {T}, Sacrifice: add one mana of any color", etc.).

**Stage 2 — generic creature-token grammar** over each sentence containing "create":

```ts
const RE = /creates? (?<qty>a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+|x|that many)\s+(?<tapped>tapped )?(?:(?<p>[\dX*]+)\/(?<t>[\dX*]+) )?(?<colors>(?:white|blue|black|red|green|colorless)(?:(?:,| and) (?:white|blue|black|red|green))*)?\s*(?<types>[A-Z][\w' ]*?) (?:(?<kinds>artifact |enchantment |legendary )*creature )?tokens?(?:.*?with (?<abils>[^.]+?))?(?:\.|,| that| for)/i
```

Extraction: qty word→int (`x`/`that many` → prefill 1, focus the quantity field); colors → `ManaColor[]`; `types` → subtype words for name + type line (`Token Creature — Soldier`); `abils` split on `, ` / ` and ` → appended to `text`. Multiple `create` sentences → multiple suggestion chips above the dialog.

**Expected coverage:** the dominant template "create [N] [P/T] [colors] [Subtypes] creature token(s) [with …]" plus the named-artifact table covers roughly **75–85 %** of token-producing Commander staples. Known misses (by design): "a copy of" (offer a *Copy target permanent* button instead — builds `TokenSpec.fromCatalogId` from a clicked battlefield card), Role/Class tokens, tokens defined by other characteristics ("that's a copy of it, except…"), for-each quantities, back-face token makers. **Fallback is always graceful:** parse failure ⇒ the exact same dialog, just blank — never blocks token creation, worst case equals the manual path. Ship a `tokenParse.spec.ts` corpus of ~60 real oracle strings and treat coverage as a metric, not a promise.

---

## 7. Explicit v1 non-goals

| Non-goal | One-line justification |
|---|---|
| **Undo / rewind** | Inverting hidden-info actions (un-draw a seen card) is unsolvable UX; paper players just fix the board manually — `card.move` already is the undo. |
| **Spectators** | Adds a 5th viewer class to every redaction path for zero core value; event log + redaction design leaves the door open. |
| **Rules engine of any kind** (auto-untap, cost payment, triggers) | Premise of the app; every automation invites scope creep toward XMage. |
| **Per-card rulings / oracle browser** | Right-click → open Scryfall in a new tab; zero maintenance. |
| **Sound / rich animations** | CSS transitions on `card.moved` suffice; audio pipelines are pure weight. |
| **Multi-node scaling / Redis** | Self-hosted, one node, in-process rooms — YAGNI, and it buys the synchronous-pipeline simplicity of §4.4. |
| **Optimistic state prediction** | §5 — biggest bug class in realtime clients, imperceptible gain at <100 ms RTT. |
| **Replay viewer** | Event rows already stored; the viewer is a v2 feature, not a v1 schema change. |
| **Sideboard / "bring from outside the game"** | Rare in casual EDH; workaround = token.create a stand-in; revisit on demand. |
| **In-game deck editing, accounts, stats, matchmaking** | Ephemeral-identity philosophy; keep the DB three tables tall. |
| **Mobile/touch layout** | Drag-heavy battlefield is desktop-first; don't ship a bad tablet mode. |

---

## 8. Three riskiest design points

1. **Nitro experimental WebSockets.** Auth context doesn't propagate from `upgrade` (nuxt#33829 — closed "not planned"), dev reloads nuke module state, and "experimental" means the crossws surface can shift under a minor bump. Mitigations are designed-in (auth re-parse in `open`, lazy rehydration makes reloads/restarts the same path, pin `nuxt@4.4.x`) — but this is the one dependency where an upgrade can break the core loop; keep the socket handler thin so a fallback to a sidecar `ws` server (or socket.io) stays a one-file swap.
2. **Deterministic replay drift.** Recovery correctness depends on the reducer staying pure and every rng outcome being captured in `fx` — a single sneaky `Date.now()` or unrecorded shuffle silently corrupts the snapshot+tail path, and it fails *exactly when a crash already happened*. Mitigations: `fx` is the only injected capability (lint-ban `Math.random`/`Date` in `server/game/`), a vitest property test that replays random action sequences and asserts deep-equal states, and an aggressive snapshot cadence so tails stay short.
3. **Redaction as a cross-cutting concern.** Hidden info leaks through *two* serializers (per-event and snapshot) plus every future event type someone adds — one forgotten field (`cards` on an opponent's `deck.drew`, a peek in `sync`) is a cheating-enabling bug invisible in normal play. Mitigations: single `visibleTo()` used by both paths, `RedactedCard` typed so hidden cards *cannot* carry `catalogId`, and a property test that serializes every event and snapshot for all 4 viewers across fuzzed games and greps the JSON for any card identity the viewer shouldn't know. Treat that test as CI-blocking from day one.