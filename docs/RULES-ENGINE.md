# Rules Engine — design & roadmap

> **Status (2026-07-08):** SHIPPED — M-R0 spine · M-R4 multiplayer Commander · assisted table · London mulligans · M-R1 (combat keywords + full layer-6/7 P/T: set/anthems/pumps/counters, keyword grants & ability loss) · M-R2 (triggered abilities incl. watch-others aristocrats, activated abilities, tokens, board wipes, counterspells). ~371 unit tests + CI leak fuzzer + 4-player e2e, all green. ~117-card pool (through B4 sacrifice/edicts).
>
> **Coverage batch 1 (2026-07-08):** *"target any permanent"* — new `TargetSpec.kind: 'permanent'` wired through the DSL, engine (`isLegalTarget`/`hasAnyLegalTarget`; hexproof now applies to any permanent), the redaction target-kind unions, and the client picker (`'permanent'` `TargetClass` — every battlefield permanent becomes targetable). New effect primitives `destroyPermanent()` and `destroyPermanentGrantToken(spec)` (token minted for the *destroyed permanent's controller*; `createToken` now takes an owner). Cards: **Vindicate**, **Beast Within**, **Generous Gift**. Leak-safe (destroy→graveyard and tokens are public zones). Prioritised by live `edhrecRank` (capability × popularity; fun set excluded). `tests/unit/rules-removal.spec.ts` (red→green).
>
> **Coverage batch B1 (2026-07-08):** pure-data staples (~20 cards), leak-safe by construction (no public→hidden moves; not in the fuzzer pool). One engine fix: **`r.playLand` now fires ETB triggers** (mirrors `resolveSpell`) so lands with enter-the-battlefield abilities work. New helpers `scryland`/`manaDork`. Cards: **10 scry Temples** (enter tapped + ETB scry 1 + dual mana), any-colour dorks/rock (**Birds of Paradise**, **Fyndhorn Elves**, **Avacyn's Pilgrim**, **Manalith**), burn (**Lightning Strike**, **Volcanic Hammer**), removal (**Grasp of Darkness** −4/−4), draw (**Harmonize**, **Concentrate**, **Ambition's Cost**, **Ancient Craving**). All via existing primitives. `tests/unit/rules-staples-b1.spec.ts` (red→green). Roadmap + adversarial critique for the remaining batches (B2–B10) captured; the leak-critical ones (bounce/tutor/recursion) carry explicit mitigations (commander-reroute on bounce-to-hand; fuzzer invariant-#1 must exclude the actor's own peek; `randomAction` must drive each new `pending` kind).
>
> **Coverage batch B2 (2026-07-08):** pure-data value/go-wide (14 cards), leak-safe by construction. New primitive `dealToEachOpponent(n)` (ready for token-ETB pingers once that gap is fixed). Cards: token spells (**Raise the Alarm**, **Midnight Haunting**, **Dragon Fodder**, **Krenko's Command**), ETB value (**Cloudblazer** draw 2/gain 2, **Wall of Blossoms** ETB draw + defender), dies value (**Tukatongue Thallid** → Saproling), anthems/lords (**Gaea's Anthem**, **Levitation** = "your creatures have flying", **Goblin Chieftain** + **Field Marshal** subtype lords with +1/+1 & keyword grants), aristocrat drains (**Cruel Celebrant**, **Bastion of Remembrance** — dies-watch, reuses the Zulaport machinery), **Soul's Attendant**. `tests/unit/rules-staples-b2.spec.ts` (red→green). **Known limitation (now fixed — see below):** token *creation* used to bypass `fireEntersTriggers`.
>
> **Coverage batch B10 (2026-07-09) — LEAK-CRITICAL: library search (ramp + tutors).** New `searchLibrary({filter,dest,tapped,count})` effect + `r.search` message + `pending: 'search'` / `pendingSearch` state. Follows the scry precedent exactly: the matching library ids are revealed to the ACTOR ONLY via `redact` (a sanctioned peek — the client `search` field is player-gated like `scry`), and after the pick the library is **shuffled + re-minted** (`remintLibrary`) so peeked ids can't be tracked; a to-hand fetch re-mints via `remintForHiddenEntry` (invariant #3). Client: a search-picker modal mirroring the scry modal. Cards: **Rampant Growth** & **Solemn Simulacrum** (basic land → battlefield tapped; Solemn also dies→draw), **Demonic Tutor** / **Diabolic Tutor** (any card → hand). Also fixed a latent redact bug: `pending:'scry'` (and now `'search'`) wrongly fell through to the discard branch of `computeLegal`; now they yield no action buttons (the modal drives them). Covered by `tests/unit/rules-staples-b10.spec.ts` (asserts opponents see no library id + the fetched card re-mints). **Adversarial leak-audit workflow (post-implementation) found + fixed two issues:** (1) a **commander** moved/tutored into a hidden zone kept its stable id (broadcast as `commanderId`) — now `r.mMove` and the search to-hand branch **reroute a commander to the command zone** (matching death/exile/bounce); (2) the CI fuzzer never exercised scry/search re-mint — now the fuzzer runs its own deck (scry Temple + Solemn Simulacrum), invariant #1 excludes the actor's own sanctioned peek (`pendingScry`/`pendingSearch`), `randomAction` drives `r.scry`/`r.search`, dual-source taps pass a colour, and `maybeOverride` now includes commanders — so the history-aware invariant #4 regression-guards the search/scry re-mint AND the commander reroute. Also hardened: the search handler no longer clobbers a fetched permanent's ETB-trigger pending.
>
> **Coverage batch B4 (2026-07-09): sacrifice & edicts.** Two mechanisms. **(1) Edicts** — a spell/ability makes players sacrifice a creature of THEIR OWN choice: new `pending: 'sacrifice'` / `pendingSacrifice {player, candidateIds, count, queue}` state + `r.sacrifice {objIds}` message + `playersSacrifice(who: 'target'|'each', count)` effect. "each player" runs a queue in APNAP order (`openSacrifice`/`advanceSacrificeQueue` in engine); players controlling no creature are skipped and the spell still resolves. **(2) Sac outlets** — an activated ability whose cost is "Sacrifice a creature": `Cost.sacrifice {count, filter}` + `r.activate.sacrifices` (optional). Validated before any mutation, then paid AFTER the ability is on the stack so the sacrificed creature's dies triggers land above it and resolve first (CR 603.3b ordering). `redact`/`LegalActions` gained `needsSacrifice`/`sacrificeCount`/`sacrificeableIds` (drives the client) and `activations[].sacCost` (a sac ability is only offered when the player controls enough creatures). Client: a forced-sacrifice modal (edict) + a sacrifice-as-cost picker on activation, plus a new `'player'` `TargetClass` so a player-target edict is castable by clicking a HUD; auto-pass hands control back on a pending sacrifice. Cards: **Diabolic Edict** (target player sacrifices), **Fleshbag Marauder** (ETB each player sacrifices), **Viscera Seer** (sac → Scry 1), **Bloodthrone Vampire** (sac → +2/+2). All zone moves are battlefield→graveyard (public→public) so no re-mint is involved. `tests/unit/rules-staples-b4.spec.ts` (edicts incl. no-op + illegal-sacrifice rejection, APNAP queue, sac-cost + dies-trigger ordering, self-pump). CI fuzzer extended: FUZZ_DECK now includes black mana + Fleshbag/Diabolic Edict/Viscera Seer, and `randomAction` gained a `sacrifice` pending branch **and** an `r.activate` branch (paying mana + sac costs) so both new paths are fuzz-covered. **Adversarial review (post-implementation) found + fixed two bugs** (regression-tested in the b4 spec): (1) `repairControlFlow` didn't handle the new `sacrifice` pending kind, so a queued player conceding mid-queue abandoned the rest of an each-player queue and left `pendingSacrifice` dangling — now it calls `advanceSacrificeQueue` to skip the leaver and prompt the next; (2) `r.sacrifice`/`redact` pinned the prompt-time `candidateIds` snapshot, so a chooser manually bouncing their creatures (`r.mMove` → re-mint) made the sacrifice unsatisfiable and wedged the game — now both validate/display against the **live** board (snapshot ∩ still-controlled), self-healing like `r.discard`. **Known latent (unreached today):** `r.activate` deducts mana before validating targets with no rollback — none of the four B4 sac abilities has both a mana cost and a target, but a future sac outlet that does would lose the mana on an illegal-target throw; validate targets before deducting when adding such a card.
>
> **Engine fix + Coverage batch B3 (2026-07-09):**
> - **Token ETB triggers fire.** `fireEntersTriggers` is now exported from `engine.ts` and called by `spawnTokens` for every token minted (the `effects→engine` edge is a call-time-only cycle via a hoisted function export — verified init-safe, mirrors the existing `effects→registry` cycle). Fixes the long-standing gap where Soul Warden/Soul's Attendant didn't see tokens, and unblocks **Impact Tremors** ("whenever a creature you control enters, deal 1 to each opponent" — new `dealToEachOpponent` primitive).
> - **`TargetSpec.filter`** (`{ types?, excludeTypes?, subtypes?, controller? }`) narrows creature/permanent targets in `isLegalTarget`/`hasAnyLegalTarget` (both now filter-aware; `hasAnyLegalTarget` takes `byController` and is exported so `redact.computeLegal` uses it for a precise, filter-aware castability gate replacing the old ad-hoc creature/spell checks). Cards: **Naturalize**, **Disenchant** (artifact/enchantment), **Mortify** (creature/enchantment), **Putrefy** (artifact/creature), **Ravenous Chupacabra** (ETB destroy a creature *an opponent controls*). Leak-safe. `tests/unit/rules-staples-b2.spec.ts` (token-ETB) + `rules-staples-b3.spec.ts` (red→green).
>
> **Coverage batch B7 (2026-07-09):** exile removal. New primitives `exileTarget()` (battlefield→exile, public→public so no re-mint; a commander instead goes to its command zone) and `gainLifeEqualToPowerForController()` (reads `currentPower` before exile — `effects→characteristics` is now safe since characteristics is already in the transitive graph via engine). Cards: **Swords to Plowshares** (#11 staple — exile + controller gains life = power), **Utter End** / **Anguished Unmaking** (exile target *nonland* permanent via `excludeTypes:['Land']`; Anguished also `loseLife(3)`). Leak-safe. `tests/unit/rules-staples-b7.spec.ts` (red→green, incl. the commander→command-zone edge).
>
> **Coverage batch B6 (2026-07-09):** +1/+1 counter placement. New primitives `addCounters(kind,n)` and `addCountersToEachControlled(kind,n)` (write `obj.counters['+1/+1']`; layer 7d + SBA 704.5q already interpret them — no characteristics/SBA change). Cards: **Gird for Battle** (+2/+2 on a creature you control — `controller:'you'` filter), **Bond Beetle** (ETB counter on a creature you control), **Cathars' Crusade** (counter on each of your creatures whenever one enters — now fires off tokens thanks to the token-ETB fix). Leak-safe. `tests/unit/rules-staples-b6.spec.ts` (red→green).
>
> **Coverage batch B5 (2026-07-09):** cost-bearing mana abilities + entersTapped-on-cast. New `ActivatedAbility.chooseColor` disambiguates a colour CHOICE (guildgate/dork/rock → engine adds the chosen colour) from FIXED output (Sol Ring/Signet → engine runs `effect`); the old `produces.length>1` heuristic is gone. `r.tapMana` now accepts a mana cost (`cost.mana`, e.g. a Signet's `{1}`), paid from the pool via `planPayment` (atomic — throws before tapping); `resolveSpell` honors `entersTapped` for cast permanents (mirrors `r.playLand`); `redact` surfaces cost-bearing sources in `manaSourceIds` and only prompts a colour for `chooseColor` sources. Migrated guildgates/scrylands/dorks/Manalith to `chooseColor`. Cards: **10 Signets** (Azorius…Orzhov), **Worn Powerstone** (enters tapped, {C}{C}), **Thran Dynamo** ({C}{C}{C}). `tests/unit/rules-staples-b5.spec.ts` (red→green, incl. guildgate regression).
>
> **Sample deck (2026-07-09):** a one-click **"Load sample deck"** on `/decks` (`shared/data/sampleDeck.ts` → the existing import flow) builds a ~110-card, 5-colour "Engine Playtest" deck made ENTIRELY of implemented cards (commander: Jedit Ojanen) — starting an enforced game with it exercises every mechanic with zero assisted-table fallbacks. Not a legal Commander deck (count/identity are warnings, not blockers — by design). `tests/unit/sample-deck.spec.ts` guarantees every listed card stays implemented; all 102 names verified to resolve against the catalog.
>
> **Coverage batch B8 (2026-07-09) — first LEAK-CRITICAL batch:** bounce (return to hand). New `returnToHand()` effect: battlefield→hand is public→hidden, so it re-mints the id via the now-exported `remintForHiddenEntry` (invariant #3), and a **commander is rerouted to the command zone** (never a hidden hand — else its id leaks via `player.commanderId`). Cards: **Unsummon** (creature), **Boomerang** (permanent), **Man-o'-War** (ETB bounce). `tests/unit/rules-staples-b8.spec.ts` asserts the re-mint + that an opponent's redacted view never contains a bounced hand id + the commander→command-zone reroute. (Bounce cards are intentionally NOT in the CI fuzzer's fixed deck; the re-mint mechanism is already fuzz-covered via the `r.mMove`→hand override, and the commander case is directly tested.)
> - **M-R0** — engine spine (priority, stack, mana, casting, combat, SBA) + starter pool, adversarially reviewed (4 findings fixed).
> - **M-R4 (multiplayer/Commander, pulled forward at user request)** — 2–4 players, 40 life, command zone with commander cast + tax, commander damage (21 lethal), APNAP priority, per-defender attack declarations, multiplayer block queue, rule 800.4a elimination (a dead player's cards leave; game continues), commander auto-return. Vanilla legendary commanders added to the starter pool. Enforced Commander lobbies (2–4 seats) and a multiplayer board (all opponents, command zones, attacker→defender assignment, commander-damage display).
> - **Assisted table** — enforced games no longer block on unimplemented cards. Any card the engine doesn't code gets a **catalog-derived fallback body** (type line, P/T, mana cost, oracle text; flagged `unimplemented`) so it can be cast and can fight, but the engine **never auto-destroys it** (SBA skips unimplemented creatures — the controller removes it by hand). Its actual effects are run via Cockatrice-style **manual overrides** (`r.mMove`/`mLife`/`mMana`/`mTap`/`mDraw`/`mToken`/`mCounter`), each server-validated to touch only your own objects and to preserve hidden-info invariants (public→hidden moves re-mint the id — invariant #3). Only the commander must still be a real legendary creature. Adversarially reviewed (control-flow wedge + re-mint findings fixed). 226 unit tests incl. the rules-leak fuzzer (2/3/4-player, now history-aware and exercising the manual overrides); 4-player e2e green (incl. manual overrides over the wire).
>
> - **M-R1 (combat keywords)** — the evergreen combat keywords now run automatically: `flying`/`reach` (block legality), `vigilance` (no tap on attack), `haste` (ignores summoning sickness), `defender` (can't attack), `menace` (needs ≥2 blockers), `deathtouch` (any damage lethal → SBA), `lifelink` (controller gains life), `trample` (excess spills to the defending player, commander-damage aware), `first strike` / `double strike` (two combat-damage sub-steps). Declared as `keywords: Keyword[]` on a `CardDefinition`; French-vanilla starter creatures added (Wind Drake, Serra Angel, Youthful Knight, Fencing Ace, Giant Spider, Vampire Nighthawk, Colossal Dreadmaw, Boggart Brute, Raging Goblin, Wall of Wood). Client cards carry `keywords` and show abbreviated badges. Adversarially reviewed (trample-with-no-surviving-blocker bug found + fixed with a regression test).
>
> - **M-R1 (layer system, P/T + keywords)** — `server/rules/characteristics.ts` computes effective P/T (`currentPower`/`currentToughness`) and effective keywords (`currentKeywords`) from base + continuous effects, read by combat, SBA, and redaction: **+1/+1 / -1/-1 counters** (cancel via CR 704.5q on any permanent), **static anthems / lords** (CR 613 layer 7c — `statics: StaticPTEffect[]`; Glorious Anthem), **until-end-of-turn pump spells** (`state.pumps`, cleared at cleanup / on zone change; Giant Growth), and **static keyword grants** (CR 613 layer 6 — `staticKeywords: StaticKeywordGrant[]`; Fervor = "creatures you control have haste"). All P/T sources additive; effects apply only to battlefield objects; manual moves/counters re-run SBA. Counters/keyword grants give the assisted-table overrides real mechanical effect. Client cards carry effective `keywords` + `power`/`toughness` (badge when changed). Adversarially reviewed (3 bugs found + fixed: off-battlefield leak, SBA-after-manual-move, pump reattach).
>
> - **Mulligans (London)** — enforced games open in a `'mulligans'` phase: each player keeps (bottoming `mullCount` cards) or mulligans (reshuffle + redraw 7, **re-minting the library** so a seen hand can't be tracked into the hidden library); turn 1 begins only once every remaining player has kept. `r.mulligan` / `r.keep {toBottom}` messages; a mulligan bar on the enforced board. Normal actions are rejected during the phase.
>
> - **M-R2 (triggered + activated abilities)** — the stack now carries `kind: 'ability'` items with a `trigger` kind (`etb`/`dies`/`attacks`) or an `abilityIndex` (activated). **Triggered** (CR 603): `enters` / `dies` on a `CardDefinition`; non-targeted go straight on the stack, targeted (Flametongue Kavu — "4 damage to target creature") set a `pending` target choice (`r.chooseTargets`, removed if no legal target — 603.3c, fizzle on resolution). Cards: Elvish Visionary / Wall of Omens / Angel of Mercy (ETB draw/gain), **Doomed Traveler** (dies → a real 1/1 flying Spirit **token** via the new `createToken` primitive / `registerImplementedToken`). **Activated** (CR 602): `abilities` with a non-mana cost; `r.activate {objId, abilityIndex, targets}` pays tap ± mana, honors summoning sickness (302.6), then stacks + resolves. Cards: **Prodigal Sorcerer** ("{T}: 1 damage to any target"), **Jayemdae Tome** ("{4},{T}: draw"). Client: activate via the card menu, with target selection reusing the targeting affordances. A perf pass made the layer-7/keyword scans allocation-free (leak fuzzer 176s→50s). Non-ETB *triggered* variety (attacks/upkeep) and multi-ability UI still to come.
>
> - **Enforced board UX** — hover-to-zoom card preview (normal-size image + oracle text after ~0.45 s, incl. hand-run assisted cards) via `RulesCardPreview`; the mulligan bar; keyword/counter/P·T badges. 271 unit tests + 4-player e2e green (mulligans, keyword grants, manual overrides over the wire).
>
> Still deferred within **M-R1**: layer 7b ("set" P/T, e.g. "becomes a 1/1"), keyword *removal* ("loses all abilities"), and layers 1–5 (copy / control / text / type / color changing). The `characteristics.ts` seam is where these slot in. Then triggers (M-R2), replacement effects (M-R3), and perpetual card coverage. Growing engine coverage shrinks how much the assisted table leaves to the players.

## Context & honest scope

Goal: an **Arena-like enforced mode** — the app knows the rules, only lets you take legal actions, resolves the stack, applies effects. This is the opposite of the current manual table (invariant #6: "no rules enforcement").

**This is a multi-year, perpetual program, not a task.** "All ~28,000 cards with every interaction" is XMage-scale (≈20 years, many contributors, hundreds of cards hand-coded per set, *forever*). No one ships it in one pass. What we build is:

1. a **correct rules-engine core** (the hard, finite part), and
2. a **card-scripting framework** so cards are mostly declarative data, plus
3. a **card library that grows every milestone, indefinitely.**

### Decisions (confirmed with the user)

- **Coexist, don't replace.** Enforced mode is a new per-lobby option alongside the manual table. Implemented cards play with full rules; the manual table remains the fallback for everything not yet coded — preserving "works with any card day one." Invariant #6 is relaxed *only for enforced games*; manual games keep it.
- **Bring the engine up in 1v1 / 20 life first.** Multiplayer priority, politics, Commander (40 life, command zone, tax, commander damage) multiply the hardest engine problems — defer them to M-R4. Duels prove the spine fastest.
- **Prove it on a tiny curated card set** (~12 → ~50 cards), not a precon or a full set. Each later milestone grows coverage.

## Reuse (build on the existing plumbing, don't duplicate)

The enforced engine reuses, unchanged where possible:
- **ws transport & room registry** — `server/game/room.ts` (single-flight rehydrate, snapshot cadence, rate limiting, presence). Add a `mode` branch.
- **Redaction discipline** — `server/game/visibility.ts` (`redactStateFor`, `visibleTo`, id re-minting on hidden-zone entry). The rules state redacts the same way; library order stays secret, hands hidden. This is non-negotiable and reused wholesale.
- **Persistence** — full-state snapshot to `Game.snapshot` jsonb (mode-tagged); no replay needed.
- **Protocol shape** — `shared/schemas/messages.ts` discriminated-union pattern; enforced mode adds its own message variants.
- **Client renderer** — `app/components/board/*` renders zones/cards/stack already; enforced mode *adds* a priority bar, legal-action highlighting, targeting/choice prompts, and "yield/auto-pass" — it does not rebuild the board.
- **Card catalog** — `Card` (oracleText, typeLine, manaCost, power/toughness, keywords, colorIdentity, faces) seeds card definitions; hand-authored definitions override/augment it.

## Architecture

Server-authoritative, **event-driven**, deterministic given the shuffle RNG (reuses `server/game/rng.ts`). New code under `server/rules/`; shared types under `shared/rules/`.

```
server/rules/
  state.ts        # RulesGameState, GameObject (characteristics + status), zones, mana pool
  engine.ts       # the loop: advance steps, grant priority (APNAP), resolve stack, run SBA
  turn.ts         # phase/step machine (untap→upkeep→draw→main1→combat…→main2→end→cleanup)
  priority.ts     # priority passing; "all passed" → step advance or top-of-stack resolves
  stack.ts        # cast spell / activate ability → put on stack; resolve LIFO
  cost.ts         # cost determination + payment (reuses shared/utils/manaCost.ts) ; mana abilities
  targeting.ts    # legal-target computation + validation ("as you cast/activate")
  sba.ts          # state-based actions (lethal damage, 0 toughness, 0 life, later: +1/-1 annihilation, legend rule)
  combat.ts       # declare attackers/blockers, ordering, first-strike/normal damage steps
  events.ts       # GameEvent taxonomy + observe hooks (triggered abilities, later: replacement/prevention)
  layers.ts       # [M-R1] continuous-effects layer system (rule 613) — the hardest subsystem
  actions.ts      # player action handlers → engine calls (cast, activate, pass, declare, choose targets/modes/X)
  legal.ts        # enumerate legal actions for the player with priority (drives client affordances + validation)
  cards/
    dsl.ts        # CardDefinition + Ability + Effect primitives (the scripting framework)
    effects.ts    # composable effect primitives: dealDamage, draw, destroy, gainLife, addCounters, createToken, pumpEOT…
    keywords.ts   # [M-R1] flying, trample, deathtouch, lifelink, vigilance, haste, first strike, double strike, menace, reach, defender
    registry.ts   # normalized-name → CardDefinition
    sets/starter.ts  # the curated card definitions
shared/rules/
  state.ts        # RulesClientState (redacted), extra fields: priorityPlayer, legalActions, pending choices, stack view
  messages.ts     # enforced-mode client messages (zod)
```

### Core model

- **GameObject**: id, ownerId, controllerId, zone, characteristics (name, manaCost, colors, types/subtypes/supertypes, basePower/baseToughness, abilities), plus status (tapped, flipped, faceDown, phasedOut), counters, damageMarked, attachments, summoningSick. Continuous effects (M-R1) are applied over base characteristics via the layer system to yield *current* characteristics.
- **Card DSL** (`cards/dsl.ts`) — a card is data:
  ```ts
  interface CardDefinition {
    name: string
    types: CardType[]; subtypes?: string[]; supertypes?: string[]
    manaCost?: string; colors?: ManaColor[]
    power?: number; toughness?: number
    abilities?: Ability[]
  }
  type Ability =
    | { kind: 'spell'; targets?: TargetSpec[]; effect: Effect }          // instant/sorcery
    | { kind: 'activated'; cost: Cost; isMana?: boolean; targets?: TargetSpec[]; effect: Effect }
    | { kind: 'triggered'; when: EventFilter; effect: Effect }           // [M-R2]
    | { kind: 'static'; mod: StaticMod }                                 // [M-R1]
    | { kind: 'keyword'; keyword: Keyword }                              // [M-R1]
  type Effect = (ctx: EffectContext) => void   // mutates game via engine primitives only
  ```
  Coverage grows by adding **effect primitives** (`effects.ts`) and **card definitions** (`sets/*`). Most cards become a few lines of data; genuinely unique cards get bespoke `Effect` code.

### Hidden information

The rules state redacts through the same principles as the manual engine (own hand visible, opponent hand count-only, library order never serialized, face-down identity hidden). The rules-leak fuzzer (CI-blocking) fuzzes 2/3/4-player games — now **history-aware** (an id currently in a hidden zone must never have been serialized to that viewer before) and exercising the manual overrides, so a public→hidden move that failed to re-mint would fail it. **This constraint is preserved, not relaxed** — the assisted-table manual moves (`r.mMove`) re-mint an object's id on public→hidden entry, exactly like the manual engine.

## Milestone roadmap (the program)

| # | Deliverable |
|---|---|
| **M-R0** (first build) | **1v1 spine, no layers/keywords/triggers.** Objects/zones, turn+step machine, priority passing, the stack, mana pool + tap-land mana abilities, cast (sorcery-speed vs instant timing), one-land-per-turn, combat (attackers/blockers/damage), SBA (lethal/0-toughness dies, 0-life loses), win/loss. Card DSL + registry + ~12 cards: 5 basic lands, 2–3 vanilla creatures, 2–3 burn spells (Shock/Lightning Bolt) exercising the stack + targeting. Enforced-mode client: priority bar, pass/resolve, legal-action highlight, targeting. Deterministic; unit + scripted-game tests. Lobby `mode` flag. |
| **M-R1** | ✅ **Combat keywords** (flying/reach/vigilance/haste/defender/menace/deathtouch/lifelink/trample/first+double strike). ✅ **Non-combat keywords**: indestructible (survives lethal/destroy, 0-tough still dies), flash (instant-speed cast), hexproof (opponents can't target). ✅ **Layer 7 P/T**: 7b set-base (Ovinize), 7c anthems + pumps (Giant Growth), 7d counters (annihilate). ✅ **Layer 6**: keyword grants (Fervor) + "loses all abilities" (Ovinize). ⏳ Remaining: ward/protection, layers 1–5 (copy/control/text/type/color). |
| **M-R2** | ✅ triggered abilities — ETB + dies, **self AND watch-others** (`watch: { scope:'anyCreature', controllerOnly?, excludeSelf? }` → Soul Warden, Zulaport Cutthroat aristocrats), targeted/non-targeted with stack + fizzle. ✅ activated abilities (tap ± mana, targets). ✅ mana dorks (summoning-sick {T}), firebreathing, tokens (`createToken`), board wipes, **counterspells** (target a spell on the stack). Primitives: dealDamage/damageAllCreatures/destroyTarget/destroyAllCreatures/counterTarget/draw/gain/loseLife/eachOpponentLoses/pump/pumpSelf/setBasePT/loseAllAbilities/createToken/addMana/sequence. ✅ **mana fixing**: enters-tapped (replacement) + dual-colour "choose on tap" lands (10 Guildgates, `r.tapMana {color}` + client colour picker). ✅ **scry** (Crystal Ball) — `r.scry`, actor-only peek at the top-N (hidden-info-safe redaction: opponents never see the scried cards; library re-minted after), + client scry modal. Card pool ~60 (sweepers Pyroclasm/Wrath, Flame Slash, Lightning Helix, Titanic Growth, Guildgates, Crystal Ball…). ⚠ simultaneous deaths processed sequentially. ⏳ attacks/upkeep triggers, LTB, ward/protection, enters-with-counters, tutors. |
| **M-R3** | **Replacement & prevention** effects, modal & X spells, more keywords, targeting edge cases. |
| **M-R4** | **Generalize to multiplayer + Commander**: APNAP with >2, command zone, commander tax/damage/casting, 40 life. |
| **M-R5+** | **Perpetual card coverage** — implement cards by popularity/set; each = DSL definition (+ new primitives as needed). Never "done". |
| Parallel | **Enforced-mode client UX**: targeting arrows (reuse), choice prompts (modes/X), auto-pass/"yield" stops, combat declaration UI. |

## Coexistence wiring

- `Lobby.mode: MANUAL | ENFORCED` (Prisma migration; default MANUAL). Start builds either the manual `ServerGameState` or a `RulesGameState`; both snapshot into `Game.snapshot` (tagged) and run in the same room registry.
- Enforced start validates only that each deck has **exactly one commander that is a legendary creature** (registry def OR catalog type line). Unimplemented cards **do not block** — the assisted table gives them a catalog-derived body (`server/rules/cards/fallback.ts`, registered via `registerFallback` in lifecycle before `buildRulesGame`; idempotent, never overwrites a real def).
- ws handler routes by the room's mode to the manual reducer or the rules engine. The rules engine accepts the manual-override messages (`r.m*`) any time the game is active; a `repairControlFlow` safety net runs after every action so a player who self-eliminates (e.g. `r.mLife` to 0) while owing a pending decision or holding priority can't wedge a 3–4 player game.
- **Known limitation:** `r.mToken` interns each distinct token spec in a process-global registry that is never freed; a client spamming unique specs grows memory over the process lifetime. Acceptable for a self-hosted table; revisit (instance-level token defs) if it matters.

## M-R0 — concrete first deliverable

Files: everything under `server/rules/` above except `layers.ts`/`keywords.ts`/triggered abilities (M-R1+). Starter pool in `cards/sets/starter.ts`. `shared/rules/*`. Client: extend `app/components/board/` with a priority/pass control, playable-card + attacker highlighting, and reuse the targeting overlay for burn. Lobby `mode` + enforced-start validation.

Enforcement in M-R0: legal-actions only (illegal rejected with reason), land-per-turn, mana payment, sorcery-speed timing, priority/stack resolution, combat damage, SBA death/loss, win detection.

## Verification

- **Engine unit tests** (`tests/unit/rules-*.spec.ts`): a scripted duel — play lands, cast a 2/2, attack, cast Shock to kill a blocker, race to 0 life → win; timing rejections (creature at instant speed), one-land-per-turn rejection, priority-pass step advance, stack LIFO resolution, SBA death.
- **Redaction**: extend the leak fuzzer to the rules state (library order / opponent hand never serialized).
- **Build**: `pnpm build` (prod bundling) + `pnpm start`.
- **e2e**: a 2-client enforced game over ws reaching a win, asserting only-legal-actions and convergence.

## Risks / non-goals for M-R0

- Riskiest subsystem overall is the **layer system (M-R1)** and **replacement effects (M-R3)** — deferred deliberately; M-R0 uses only vanilla creatures + direct-damage so it needs neither.
- No triggered abilities, no continuous effects, no keywords in M-R0 (M-R1).
- Not multiplayer/Commander yet (M-R4).
- Card coverage is perpetual; "Arena parity" is the horizon, not a milestone.
