/**
 * Rules-engine state model (enforced mode). Kept separate from the manual
 * engine's shared/types/game.ts. 1v1 / 20-life for M-R0; generalises to
 * multiplayer + Commander in M-R4.
 *
 * The engine is server-authoritative and event-driven. Characteristics in M-R0
 * come straight from the CardDefinition (no continuous-effects layer system yet
 * — that's M-R1), so a GameObject stores only instance state + status.
 */

export type PlayerId = string
export type ObjId = string
export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C'
export type ManaPool = Record<ManaColor, number>

export type CardType =
  | 'Land'
  | 'Creature'
  | 'Instant'
  | 'Sorcery'
  | 'Artifact'
  | 'Enchantment'
  | 'Planeswalker'
  | 'Battle'

export type RulesZone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'
export type NonStackZone = RulesZone

/** Evergreen keywords the engine automates (combat + a few non-combat). */
export type Keyword =
  | 'flying'
  | 'reach'
  | 'vigilance'
  | 'haste'
  | 'defender'
  | 'menace'
  | 'trample'
  | 'deathtouch'
  | 'lifelink'
  | 'first strike'
  | 'double strike'
  | 'indestructible'
  | 'hexproof'
  | 'flash'
  // evasion keywords (block restrictions — CR 509/702)
  | 'fear'
  | 'intimidate'
  | 'skulk'
  | 'shadow'
  | 'horsemanship'
  | 'islandwalk'
  | 'swampwalk'
  | 'mountainwalk'
  | 'forestwalk'
  | 'plainswalk'
  | 'shroud'
  | 'prowess'
  | 'persist'
  | 'undying'
  | 'exalted'
  | 'flanking'
  | 'battle cry'
  | 'infect'
  | 'wither'
  | 'phasing'
  | 'banding'

// Turn structure. Combat is split so priority is granted in each step.
export const STEPS = [
  'untap',
  'upkeep',
  'draw',
  'main1',
  'begin_combat',
  'declare_attackers',
  'declare_blockers',
  'combat_damage',
  'end_combat',
  'main2',
  'end',
  'cleanup',
] as const
export type Step = (typeof STEPS)[number]

/** A permanent / card instance in any zone (incl. a spell on the stack). */
export interface GameObject {
  id: ObjId
  defName: string // normalized card-definition key (registry lookup)
  ownerId: PlayerId
  controllerId: PlayerId
  zone: RulesZone | 'stack'
  tapped: boolean
  /** entered the battlefield under its controller's control this turn */
  summoningSick: boolean
  /** combat damage marked this turn (creatures) */
  damageMarked: number
  /** counters on the object (e.g. "+1/+1"); manual for unimplemented cards */
  counters: Record<string, number>
  isCommander: boolean
  /**
   * IMPULSE DRAW ("exile the top N cards of your library; … you may play those cards"): who may play
   * this exiled card, and how long the window lasts — 'endOfTurn' (Jeska's Will: "you may play them
   * this turn") or 'endOfYourNextTurn' (Reckless Impulse). `playableFromTurn` is the turn it was
   * exiled on, so the longer window can tell "your next turn" from the current one. Cleared as the
   * window closes; the card then simply stays in exile.
   */
  /** "As this permanent enters, choose a creature type." (Cavern of Souls, Patchwork Banner) */
  chosenType?: string
  playableBy?: PlayerId
  playableUntil?: 'endOfTurn' | 'endOfYourNextTurn'
  playableFromTurn?: number
  /** host this Aura/Equipment is attached to (null = unattached); cleared on zone change */
  attachedTo?: ObjId | null
  /** current loyalty (planeswalkers); set from the definition on entering the battlefield */
  loyalty?: number
  /** a loyalty ability has been activated this turn (once-per-turn restriction, CR 606.3) */
  loyaltyActivatedThisTurn?: boolean
  /** a `oncePerTurn` triggered ability of this object has already fired this turn */
  triggeredThisTurn?: boolean
  // combat (transient, cleared at end of combat)
  attackingDefender: PlayerId | null // the player this creature is attacking (a PW's controller if attacking a PW)
  /** the planeswalker this creature is attacking (null = attacking the player directly) */
  attackingPwId?: ObjId | null
  blockingAttackerId: ObjId | null // the attacker this creature is blocking
  /** took damage from a deathtouch source this turn → destroyed by SBA (704.5g) */
  deathtouched?: boolean
  /** phased out (CR 702.26 / 502.1) — stays in the battlefield zone but is treated as though
   *  it doesn't exist until it phases in at its controller's next untap step */
  phasedOut?: boolean
  /** set on a permanent phased out INDIRECTLY (an attachment dragged out with its host) — it
   *  phases back in only when the host (this id) phases in, per CR 702.26e */
  phasedOutBy?: ObjId
  /** Adventure (CR 715): this card is in exile having been cast as its adventure half; its owner
   *  may cast the creature side from exile. Cleared when it leaves exile. */
  adventured?: boolean
  /** Face-down (foretell CR 702.143 / morph CR 702.37): the card's identity is hidden from everyone
   *  except its owner — the redactor sends `defName: null` to non-owners. */
  faceDown?: boolean
  /** Foretell: the turn number this card was foretold (it can't be cast until a LATER turn). */
  foretoldTurn?: number
  /** Monstrosity (CR 701.31): this creature has become monstrous — its monstrosity ability can't
   *  make it monstrous again. (Adapt has no flag; it checks for existing +1/+1 counters instead.) */
  monstrous?: boolean
  /** Bestow (CR 702.103): this permanent was cast for its bestow cost and is currently an AURA
   *  attached to a creature (not itself a creature). If the host leaves it becomes a creature
   *  (this flag clears). While set, it's excluded from the creature helpers. */
  bestowed?: boolean
}

export type StackItemKind = 'spell' | 'ability'

/** A spell or ability on the stack. */
export interface StackItem {
  id: ObjId // spell: the card object's id; ability: a synthetic id
  kind: StackItemKind
  controllerId: PlayerId
  defName: string
  sourceId: ObjId // the card object this originated from
  abilityIndex: number | null // for activated abilities
  /** which triggered ability this is (for kind: 'ability') */
  trigger?:
    | 'etb' | 'dies' | 'attacks' | 'upkeep' | 'cast' | 'draw' | 'landfall' | 'combatDamage' | 'drawStep'
    | 'beginCombat' | 'leavesBattlefield' | 'etbWatch'
  targets: (ObjId | PlayerId)[]
  /** chosen X for an {X} spell (resolves the effect with this value) */
  x?: number
  /** chosen mode index for a modal ("choose one") spell */
  mode?: number
  /**
   * Chosen modes for a MULTI-mode spell ("choose two" / "choose one or more" / "choose both"),
   * in printed order. `mode` stays the single-mode field (and the split-card half), so a card is
   * resolved either through `mode` or through `modes`, never both.
   */
  modes?: number[]
  /** which loyalty ability is resolving (index into def.loyaltyAbilities) */
  loyaltyIndex?: number
  /** cycling's ability on the stack: on resolution its controller draws a card (CR 702.29) */
  cycling?: boolean
  /** a CHANNEL ability on the stack (the card was already discarded as its cost) */
  channel?: boolean
  /** ward's triggered ability on the stack (CR 702.21): on resolution, counter `triggeringId`
   *  unless its controller (`payer`) pays `cost`. */
  ward?: { triggeringId: ObjId; cost: string; payer: PlayerId }
  /** cascade's triggered ability on the stack (CR 702.85): on resolution, dig the controller's
   *  library for a nonland with mana value < `mv`. */
  cascade?: { mv: number }
  /** cast-trigger (CR 603.2): who cast the spell that triggered this — the player who may pay an
   *  "unless that player pays {N}" cost when it resolves (Rhystic Study). */
  castPayer?: PlayerId
  /**
   * "…and that spell can't be countered" (Cavern of Souls, Delighted Halfling): true when RESTRICTED
   * mana carrying that rider paid for this spell. `def.cantBeCountered` covers the printed version.
   */
  cantBeCountered?: boolean
  /** whether this spell was cast kicked (its optional kicker cost was paid) — CR 702.33 */
  kicked?: boolean
  /** Saga chapter ability on the stack (CR 714): the 1-based chapter number resolving (its
   *  effect is `def.saga.chapters[sagaChapter - 1]`). */
  sagaChapter?: number
  /** a GRANTED triggered ability resolving: its body is `getDef(defName).grantedAbilities[grantedKey]` */
  grantedKey?: string
  /** Adventure (CR 715): this spell is the adventure half — on resolution it exiles the card
   *  (adventured) instead of going to the graveyard, rather than resolving as the creature. */
  adventure?: boolean
  /** Flashback (CR 702.34): this spell was cast from the graveyard via flashback — it is exiled
   *  as it leaves the stack (resolved or countered) instead of returning to the graveyard. */
  flashback?: boolean
  /** Suspend (CR 702.62e): this spell was cast from suspend — if it's a creature it enters with
   *  haste (until it next leaves the battlefield). */
  suspendHaste?: boolean
  /** Buyback (CR 702.27): the buyback cost was paid — on resolution this spell returns to its
   *  owner's hand instead of the graveyard. */
  buyback?: boolean
  /** Bestow (CR 702.103): cast for the bestow cost → enters as an Aura attached to its target. */
  bestow?: boolean
  /** Morph (CR 702.37): cast face down → enters as a 2/2 face-down creature. */
  faceDown?: boolean
  /** Evoke (CR 702.74): cast for the evoke cost → sacrificed as it enters (ETB triggers still fire). */
  evoke?: boolean
  /** Overload (CR 702.96): cast for the overload cost → resolves its untargeted "each" body. */
  overloaded?: boolean
  /** Morph (CR 702.37): this spell is being cast face down → it enters as a 2/2 face-down creature. */
  faceDown?: boolean
}

export interface PlayerRState {
  id: PlayerId
  seat: number
  name: string
  life: number
  /** poison counters (infect) — a player with 10+ loses the game (CR 704.5c) */
  poison: number
  manaPool: ManaPool
  /**
   * RESTRICTED mana (CR 106.6): "Spend this mana only to cast a creature spell of the chosen type"
   * (Cavern of Souls) / "only to cast a legendary spell" (Delighted Halfling). Kept apart from
   * `manaPool` so it can only pay for a matching spell; emptied with the pool at every step change.
   * `uncounterable` carries the "and that spell can't be countered" rider onto whatever it pays for.
   */
  restrictedMana?: {
    color: ManaColor
    amount: number
    creatureType?: string
    legendary?: boolean
    uncounterable?: boolean
    /** Secluded Courtyard: may also pay to ACTIVATE an ability of a creature source of that type */
    typeAbilities?: boolean
    /** Path of Ancestry: unrestricted mana that scries 1 when spent on a creature sharing a type
     *  with your commander */
    scryIfSharesCommanderType?: boolean
  }[]
  landsPlayedThisTurn: number
  /** "Activate only if you created a token this turn." (Idol of Oblivion) — reset at your untap step */
  createdTokenThisTurn?: boolean
  /**
   * "You gain protection from everything" (Teferi's Protection, The One Ring) — until this player's
   * NEXT turn, so it is cleared at their untap step. While it holds, an opponent's spell or ability
   * can't target them and damage to them is prevented (CR 702.16).
   */
  protectedFromEverything?: boolean
  /** "Your life total can't change" (Teferi's Protection) — enforced in changeLife, same window */
  lifeCantChange?: boolean
  /** noncreature spells this player has cast this turn (Esper Sentinel's "first each turn") */
  noncreatureSpellsThisTurn?: number
  /** extra land drops granted this turn (Explore) — added on top of the one-per-turn allowance */
  extraLandsThisTurn?: number
  /** spells this player has cast this turn (Aetherflux Reservoir counts them) */
  spellsThisTurn?: number
  hasLost: boolean
  /** the player's commander object id (exactly one; no partners yet) */
  commanderId: ObjId | null
  /** casts from the command zone so far → +{2}×tax on the next cast */
  commanderTax: number
  /** combat damage TAKEN per commander object id (≥21 from one → lose, CR 704.5v) */
  commanderDamage: Record<ObjId, number>
  /** London mulligan bookkeeping (pre-game): times mulliganed, and kept-yet */
  mullCount: number
  keptHand: boolean
}

export interface RulesGameState {
  id: string
  mode: 'enforced'
  players: Record<PlayerId, PlayerRState>
  turnOrder: PlayerId[]
  activePlayer: PlayerId
  step: Step
  turnNumber: number
  /** who currently holds priority (null while the engine performs turn-based actions) */
  priorityPlayer: PlayerId | null
  /** players who have passed priority since the last stack change / step start */
  passed: PlayerId[]
  /** engine is waiting for a player decision (no priority until it's made) */
  pending: { kind: 'attackers' | 'blockers' | 'discard' | 'trigger' | 'scry' | 'search' | 'sacrifice' | 'ward' | 'cascade' | 'madness' | 'entersChoice' | 'optionalPay' | 'putBack'; player: PlayerId } | null
  /** details of a triggered ability awaiting its controller's target choice */
  pendingTrigger: { sourceId: ObjId; defName: string; controllerId: PlayerId; trigger: 'etb' | 'dies' | 'attacks' | 'upkeep'; sagaChapter?: number } | null
  /** an active scry: the top-N library ids (top first) the scrying player is looking at */
  /**
   * An active scry. `thenDraw` is the "…then draw a card" half of Opt / Preordain: it MUST wait for
   * the scry to be answered — drawing while the peek is open would take a card the player is still
   * looking at (it left a dangling id in the hand; the leak fuzzer caught it).
   */
  pendingScry: {
    player: PlayerId
    cardIds: ObjId[]
    thenDraw?: number
    /** surveil (CR 701.42): the cards NOT kept on top go to the GRAVEYARD, not to the bottom */
    surveil?: boolean
    /**
     * Ponder: the peeked cards go back on top in an order the player CHOOSES (r.scry.order), and they
     * may shuffle instead (r.scry.shuffle). Nothing goes to the bottom or the graveyard.
     */
    reorder?: boolean
  } | null
  /**
   * An active library search (tutor / land-ramp): the matching library ids the
   * searching player may pick from. Exposed ONLY to the actor (sanctioned peek,
   * like scry); the library is shuffled + re-minted after resolution.
   */
  pendingSearch: {
    player: PlayerId
    matchIds: ObjId[]
    dest: 'battlefield' | 'hand' | 'libraryTop' | 'graveyard'
    tapped: boolean
    count: number
    /** the tutors: the chosen card is REVEALED (its name is logged) as it goes on top */
    reveal?: boolean
    /** Myriad Landscape: "up to two basic land cards THAT SHARE A LAND TYPE" */
    shareSubtype?: boolean
    /** Krosan Verge: "a Forest card AND a Plains card" — the picks must cover both subtypes */
    pairSubtypes?: [string, string]
    /**
     * Split destination (e.g. Cultivate / Kodama's Reach: "put one onto the battlefield
     * tapped and the other into your hand"): the FIRST chosen card is routed via `first`,
     * every subsequent chosen card via `rest`. When absent, all picks use `dest`/`tapped`.
     */
    /**
     * Fabled Passage: "…put it onto the battlefield tapped … then if you control four or more
     * lands, untap that land." The count is taken AFTER the fetched land entered (it counts
     * itself). A plain number so the pending stays serialisable in a snapshot.
     */
    untapIfLandsAtLeast?: number
    split?: {
      first: { dest: 'battlefield' | 'hand' | 'libraryTop' | 'graveyard'; tapped: boolean }
      rest: { dest: 'battlefield' | 'hand' | 'libraryTop' | 'graveyard'; tapped: boolean }
    }
  } | null
  /**
   * An active forced sacrifice (edicts / each-player sacrifices). The current
   * chooser picks `count` of `candidateIds` (creatures they control) to
   * sacrifice; `queue` holds the remaining players who must each still
   * sacrifice, prompted one at a time in APNAP order. Battlefield ids are
   * public, so this carries no hidden information.
   */
  pendingSacrifice: {
    player: PlayerId
    candidateIds: ObjId[]
    count: number
    queue: PlayerId[]
  } | null
  /**
   * A FORCED discard (Mind Rot / "each player discards"): the current chooser
   * discards `count` cards of their choice from their hand; `queue` holds the
   * remaining players (each-player discards). Distinguishes a forced discard from
   * the cleanup-step discard (which has pendingDiscard null and uses hand−7).
   */
  /**
   * "You may put a land card from your hand onto the battlefield" (Growth Spiral) / "you may exile a
   * nonartifact, nonland card from your hand" (Chrome Mox's imprint): the player picks up to `count`
   * cards from their OWN hand and they go to `dest`. Hidden→hidden or hidden→public depending on the
   * destination; `sourceId` is the permanent to imprint onto, when there is one.
   */
  pendingHandChoice: {
    player: PlayerId
    count: number
    filter: 'land' | 'nonartifactNonland' | 'any'
    dest: 'battlefield' | 'exile'
    optional: boolean
    sourceId?: ObjId
    imprint?: boolean
  } | null
  /**
   * PROLIFERATE (CR 701.28): "Choose any number of permanents and/or players with a counter on them,
   * then give each another counter of each kind already there." `remaining` counts how many
   * proliferations are still to come (Contagion Engine proliferates twice, each with its own choice).
   */
  pendingProliferate: { player: PlayerId; remaining: number } | null
  /**
   * "Look at the top card of your library. If it's a creature card of the chosen type, you may reveal
   * it and put it into your hand." (Herald's Horn) — an actor-only peek at ONE card with a yes/no
   * answer (r.revealTop). The id is published to that player alone, like a scry.
   */
  pendingRevealTop: { player: PlayerId; cardId: ObjId; sourceName: string } | null
  /** "…may draw up to two cards" (Arcane Denial): a count between 0 and `max` (r.mayDraw) */
  pendingMayDraw: { player: PlayerId; max: number; sourceName: string; exact?: boolean } | null
  /**
   * "You may choose new targets for target spell or ability" (Deflecting Swat) — `player` re-aims the
   * stack item `itemId`; the new targets must still be legal FOR THAT ITEM'S controller (CR 115.7b).
   */
  pendingRetarget: { player: PlayerId; itemId: ObjId; sourceName: string } | null
  pendingDiscard: {
    player: PlayerId
    count: number
    queue: PlayerId[]
    /**
     * Frantic Search: "…then untap up to three lands." The untap must wait for the discard to be
     * answered, so it rides along here (same pattern as pendingScry.thenDraw).
     */
    thenUntapLands?: number
  } | null
  /**
   * An active WARD trigger resolving (CR 702.21): the spell/ability's controller
   * (`player`) must pay `cost` or the triggering spell/ability (`triggeringId` on the
   * stack) is countered. Battlefield/stack ids are public → no hidden information.
   */
  pendingWard: {
    player: PlayerId
    triggeringId: ObjId
    cost: string
  } | null
  /**
   * An active CASCADE (CR 702.85): after exiling from the top of the library until a nonland
   * hit (`hitId`, mana value < the cascade spell's), the caster MAY cast it for free; `exiledIds`
   * are all the cards exiled this way (the hit + the passed-over cards), which go to the bottom
   * of the library in a random order once the decision is made. The exiled cards are FACE-UP in
   * exile (public), so this carries no hidden information; the return-to-library re-mints them.
   */
  pendingCascade: {
    player: PlayerId
    hitId: ObjId
    exiledIds: ObjId[]
  } | null
  /** Madness (CR 702.35): a discarded madness card is exiled and its owner may cast it for the
   *  madness cost or let it go to the graveyard. `resume` = what discard flow to continue after. */
  pendingMadness: { player: PlayerId; cardId: ObjId; resume: 'cleanup' | 'forced' } | null
  /**
   * An as-enters replacement CHOICE (CR 614.12) — the shocklands' "As this land enters, you may pay
   * N life. If you don't, it enters tapped." The permanent is already on the battlefield (untapped)
   * and no player can act until the choice is answered (`pending` blocks priority), so declining and
   * tapping it is equivalent to it having entered tapped. Battlefield ids are public.
   */
  pendingEntersChoice: { player: PlayerId; objId: ObjId; life: number } | null
  /**
   * "As this permanent enters, choose a creature type." — its controller picks one before anything
   * else happens (r.chooseType). Queued like the pay-life as-enters choice.
   */
  pendingTypeChoice: { player: PlayerId; objId: ObjId } | null
  /**
   * "…then put two cards from your hand on top of your library in any order." (Brainstorm) — the
   * player picks `count` cards from their own hand; the ids sent back are hand ids they already
   * hold, and hand → library is hidden → hidden, so nothing new is revealed either way.
   */
  pendingPutBack: { player: PlayerId; count: number } | null
  /**
   * Scheduled DELAYED triggers (CR 603.7) — "at the beginning of your next upkeep / main phase".
   * `defName` + `key` point at the body in `CardDefinition.delayed` (functions can't be serialised);
   * `x` carries any value captured when it was scheduled (Mana Drain's mana value). It fires at the
   * matching step of a LATER turn than the one it was created on.
   */
  /**
   * Triggered abilities GRANTED to a permanent until end of turn (Malakir Rebirth / Feign Death:
   * 'that creature gains "When this creature dies, …"'). The body lives in the GRANTING card's
   * `grantedAbilities` record and is referenced by `defName` + `key` (the same trick as
   * `delayedTriggers`), so nothing here holds a function. Cleared at cleanup with the other
   * until-end-of-turn effects.
   */
  grantedTriggers?: { objId: ObjId; defName: string; key: string; trigger: 'dies' }[]
  delayedTriggers: {
    at: 'nextUpkeep' | 'nextMainPhase'
    player: PlayerId
    defName: string
    key: string
    x?: number
    createdTurn: number
    /**
     * "at the beginning of the NEXT TURN's upkeep" (Arcane Denial) — fires at the first such step after
     * it was created, whoever is active, rather than waiting for `player`'s own next turn. `player`
     * still says who the effect is for.
     */
    anyPlayersTurn?: boolean
  }[]
  /** as-enters choices waiting to be opened, in entry order (several permanents can enter at once) */
  entersChoiceQueue: { player: PlayerId; objId: ObjId; life: number; chooseType?: boolean }[]
  /**
   * An "…unless that player pays {N}" decision (Rhystic Study, Esper Sentinel): a triggered ability
   * has resolved and `player` — the one who cast the spell — may pay `cost` to stop it. Declining
   * runs the trigger's effect for `beneficiary`. `defName`/`sourceId` identify the ability (its
   * effect is read back from the definition, which is not serialisable). Public ids only.
   */
  pendingOptionalPay: {
    player: PlayerId
    beneficiary: PlayerId
    cost: string
    defName: string
    sourceId: ObjId
    /** which trigger opened it — picks `castSpell` / `drawnCard` / a `delayed` entry off the def */
    trigger: 'cast' | 'draw' | 'delayed' | 'upkeep'
    /** true when the effect happens ON PAYMENT ("you may pay {4}: if you do, untap") */
    effectOnPay?: boolean
    /** CUMULATIVE UPKEEP: declining sacrifices `sourceId` (there is no ability body to run) */
    cumulativeUpkeep?: boolean
    /** for a delayed trigger: which `CardDefinition.delayed` entry this is */
    delayedKey?: string
  } | null
  /** true only on the very first turn's first player (skips their draw) */
  firstTurnSkipDraw: boolean
  /**
   * Combat bookkeeping: attackerId → blockerIds in declared damage order.
   * An attacker with a key here "became blocked" (stays blocked even if its
   * blockers die — rule 509.2). Cleared at end of combat.
   */
  blockOrders: Record<ObjId, ObjId[]>
  /** ≥1 attacker was declared this combat (drives the CR 508.8 skip precisely) */
  attackersDeclaredThisCombat: boolean
  /** defenders who have completed their block declaration this combat (multiplayer queue) */
  blockersDone: PlayerId[]
  /** until-end-of-turn P/T boosts (CR 613 layer 7c, temporary); cleared each cleanup */
  pumps: { objId: ObjId; power: number; toughness: number }[]
  /** until-end-of-turn "set base P/T" effects (CR 613 layer 7b); last one wins */
  setPT: { objId: ObjId; power: number; toughness: number }[]
  /** until-end-of-turn "loses all abilities" (CR 613 layer 6) — object ids */
  loseAbilities: ObjId[]
  /** until-end-of-turn granted protection from a colour (CR 613 layer 6); cleared each cleanup */
  protectionGrants: { objId: ObjId; color: ManaColor }[]
  /**
   * until-end-of-turn granted keywords (CR 613 layer 6) — Heroic Intervention's hexproof +
   * indestructible. Unlike static grants from a permanent (auras/anthems, creatures only), these
   * reach ANY permanent type: a land can gain hexproof. Cleared each cleanup.
   */
  keywordGrants: { objId: ObjId; keyword: Keyword }[]
  /** until-end-of-turn "can't be blocked" (Rogue's Passage); cleared each cleanup */
  unblockable: ObjId[]
  objects: Record<ObjId, GameObject>
  zones: {
    perPlayer: Record<PlayerId, Record<NonStackZone, ObjId[]>>
    stack: StackItem[] // last element = top of stack
  }
  status: 'mulligans' | 'active' | 'ended'
  winner: PlayerId | null
  log: string[]
  seq: number
}

// ---------- client-facing redacted view ----------

/** A card as seen by one viewer. Hidden cards carry no identity (defName null). */
export interface RulesClientCard {
  id: ObjId
  defName: string | null // null when hidden from this viewer
  ownerId: PlayerId
  controllerId: PlayerId
  zone: RulesZone | 'stack'
  tapped: boolean
  summoningSick: boolean
  damageMarked: number
  counters: Record<string, number>
  /** current power/toughness incl. counters & continuous effects (null = not a creature) */
  power: number | null
  toughness: number | null
  /** current loyalty (planeswalkers only; null otherwise) */
  loyalty: number | null
  isCommander: boolean
  /** the creature type chosen as this permanent entered, if any (Cavern of Souls) */
  chosenType?: string
  /** IMPRINT (CR 702.61 — Chrome Mox): the def name of the card exiled by this permanent */
  imprintedDefName?: string
  /**
   * The counters this object had as it LEFT the battlefield — last known information for a
   * leaves-the-battlefield trigger that needs them (The Ozolith). Set by moveTo before counters are
   * cleared, so it is only meaningful right after such a move.
   */
  lastCounters?: Record<string, number>
  /** the host this Aura/Equipment was attached to as it left the battlefield (Animate Dead) */
  lastAttachedTo?: ObjId
  /** true when this permanent entered by RESOLVING as a spell — The One Ring's "if you cast it" */
  enteredByCast?: boolean | null
  /** host this Aura/Equipment is attached to (null/absent = unattached) */
  attachedTo?: ObjId | null
  /** true = an assisted-table fallback (printed body known, rules player-run) */
  unimplemented: boolean
  /** evergreen combat keywords the engine enforces (shown on the card) */
  keywords: Keyword[]
  attackingDefender: PlayerId | null
  /** the planeswalker this creature is attacking (so clients draw the arrow at it, not the player) */
  attackingPwId: ObjId | null
  blockingAttackerId: ObjId | null
  /** phased out — still public (its identity is known) but treated as not existing (CR 702.26) */
  phasedOut?: boolean
  /** in exile "on an adventure" — its owner may cast the creature side from exile (CR 715) */
  adventured?: boolean
  /** face-down (foretell / morph) — the client renders a card back; `defName` is null for non-owners */
  faceDown?: boolean
  hidden: boolean
}

export interface RulesClientState {
  id: string
  mode: 'enforced'
  you: PlayerId
  players: Record<PlayerId, PlayerRState>
  turnOrder: PlayerId[]
  activePlayer: PlayerId
  step: Step
  turnNumber: number
  priorityPlayer: PlayerId | null
  cards: Record<ObjId, RulesClientCard>
  zones: {
    perPlayer: Record<
      PlayerId,
      {
        battlefield: ObjId[]
        graveyard: ObjId[]
        exile: ObjId[]
        command: ObjId[]
        hand: ObjId[] | { count: number } // ids only for your own hand
        library: { count: number } // order never serialised
      }
    >
    stack: StackItem[]
  }
  /** legal actions for `you` right now — drives client affordances (filled by legal.ts) */
  legal: LegalActions
  status: 'mulligans' | 'active' | 'ended'
  winner: PlayerId | null
  log: string[]
  seq: number
  /** YOUR active scry (top-N ids you're looking at) — actor-only; null for everyone else */
  scry: { cardIds: ObjId[]; surveil?: boolean; reorder?: boolean } | null
  /** YOUR active library search — actor-only; the ids you may pick and how many */
  search: { matchIds: ObjId[]; dest: 'battlefield' | 'hand'; count: number } | null
}

/** What `you` may currently do (client uses this to enable/disable affordances). */
export interface LegalActions {
  hasPriority: boolean
  canPass: boolean
  playableLandIds: ObjId[]
  castableIds: ObjId[] // spells in hand you could cast right now
  manaSourceIds: ObjId[] // untapped permanents you can tap for mana
  /** colours each mana source can produce (>1 means the player must choose on tap) */
  manaSourceColors: Record<ObjId, ManaColor[]>
  /** mana sources whose ability also costs "Sacrifice a creature" (the Altars) → objId → how many */
  manaSourceSacCost: Record<ObjId, number>
  /**
   * Filter-land abilities usable right now: pay one mana of `payFrom` (you hold at least one) and add
   * the chosen `outputs` pair. The client renders the pair picker; r.tapMana takes `payColor` + `pair`.
   */
  manaFilters: { objId: ObjId; payFrom: ManaColor[]; outputs: [ManaColor, ManaColor][] }[]
  declarableAttackerIds: ObjId[]
  declarableBlockerIds: ObjId[]
  /** what each potential defender charges per attacker (Propaganda / Ghostly Prison) — 0 when free */
  attackTaxPerCreature: Record<PlayerId, number>
  /** players your attackers may be sent at (alive opponents) */
  attackablePlayerIds: PlayerId[]
  /** planeswalkers your attackers may be sent at (opponents' planeswalkers) */
  attackablePlaneswalkerIds: ObjId[]
  /** the attackers currently assigned against YOU (when declaring blocks) */
  incomingAttackerIds: ObjId[]
  needsAttackers: boolean
  needsBlockers: boolean
  /** a "choose new targets" decision is waiting (r.retarget): the item and what it can be aimed at */
  needsRetarget: boolean
  retargetItemId: ObjId | null
  retargetKind: 'creature' | 'permanent' | 'player' | 'anyTarget' | 'spell' | 'graveyardCard' | null
  retargetCount: number
  retargetSourceName: string
  /** a "you may draw up to N cards" decision is waiting (r.mayDraw) */
  needsMayDraw: boolean
  mayDrawMax: number
  /** true when the choice is all-or-nothing ("you may draw TWO cards", not "up to two") */
  mayDrawExact: boolean
  mayDrawSourceName: string
  /** a "look at the top card, you may take it" decision is waiting (r.revealTop) */
  needsRevealTop: boolean
  revealTopCardId: ObjId | null
  revealTopSourceName: string
  /** a PROLIFERATE choice is waiting: the permanents and players that have a counter right now */
  needsProliferate: boolean
  proliferateIds: ObjId[]
  proliferatePlayerIds: PlayerId[]
  /** a "choose a card from your hand" decision is waiting (r.handChoice) */
  needsHandChoice: boolean
  handChoiceCount: number
  handChoiceOptional: boolean
  /** the eligible cards in YOUR hand (already visible to you — no new information) */
  handChoiceIds: ObjId[]
  handChoiceLabel: string
  needsDiscard: boolean
  discardCount: number
  /** a forced sacrifice (edict) is waiting on you */
  needsSacrifice: boolean
  sacrificeCount: number
  /** creatures you control that you may choose to sacrifice right now */
  sacrificeableIds: ObjId[]
  /** a triggered ability of yours needs a target chosen */
  needsTriggerTargets: boolean
  triggerTargetKind: 'creature' | 'permanent' | 'player' | 'anyTarget' | 'spell' | 'graveyardCard' | null
  /** the trigger's target is optional ("you may…", "up to one…") → the client offers Decline */
  triggerTargetOptional: boolean
  /** for a graveyardCard trigger target: the graveyard cards that are legal picks right now */
  triggerGraveyardIds: ObjId[]
  triggerSourceName: string | null
  /** non-mana activated abilities you can use right now (cost = mana part, '' if none; sacCost = creatures to sacrifice as a cost) */
  activations: {
    objId: ObjId
    abilityIndex: number
    targetKind: 'creature' | 'permanent' | 'player' | 'anyTarget' | 'spell' | 'graveyardCard' | null
    cost: string
    sacCost: number
    /** what that sacrifice cost accepts ('creature' by default; 'treasure' for Face-Breaker) */
    sacFilter?: 'creature' | 'treasure'
    /** cost pieces the client shows when a permanent offers SEVERAL abilities (Idol of Oblivion) */
    taps?: boolean
    sacSelf?: boolean
    lifeCost: number
    /** for a graveyardCard target: the legal cards right now (the board renders them as a picker) */
    graveyardIds?: ObjId[]
  }[]
  /** your Equipment that can be equipped right now (sorcery speed, cost affordable, you control a creature) */
  equippableIds: ObjId[]
  /** loyalty abilities you may activate now (your planeswalkers, once/turn, cost affordable) */
  loyaltyActivations: { objId: ObjId; abilityIndex: number; cost: number }[]
  /** hand cards you can cycle right now (instant speed, cost affordable) — CR 702.29 */
  cyclable: { objId: ObjId; cost: string }[]
  /** hand cards whose CHANNEL ability you can use right now (cost already reduced) */
  channelable: {
    objId: ObjId
    cost: string
    targetKind: 'creature' | 'permanent' | 'player' | 'anyTarget' | 'graveyardCard' | null
    /** for a graveyardCard target: the legal cards right now */
    graveyardIds?: ObjId[]
    /** button label when the ability is not literally "Channel" (landcycling) */
    label?: string
  }[]
  /** castable cards that have a kicker — the client offers a "kick" toggle (cost = kicker's mana) — CR 702.33 */
  kickable: { objId: ObjId; cost: string }[]
  /** hand cards castable for their OVERLOAD cost right now (untargeted "each" body) — CR 702.96 */
  overloadable: { objId: ObjId; cost: string }[]
  /** hand cards castable for FREE right now because you control a commander (Fierce Guardianship) */
  freeCastable: ObjId[]
  /**
   * Castable cards that also demand an additional cost chosen at cast time (Village Rites: sacrifice
   * a creature; Thrill of Possibility: discard a card). The client collects the picks and passes
   * them to r.cast as `sacrifices` / `discards`.
   */
  castExtraCost: { objId: ObjId; sacrifice: number; sacFilter: 'creature' | 'artifactOrCreature'; discard: number }[]
  /** a ward trigger is resolving and YOU must decide to pay or let your spell/ability be countered (CR 702.21) */
  needsWard: boolean
  /** the ward cost you'd pay, and whether your current mana pool covers it */
  wardCost: string
  wardAffordable: boolean
  /** you must put cards from your hand on top of your library (Brainstorm) — click them in order */
  needsPutBack: boolean
  putBackCount: number
  /** an "unless you pay {N}" decision is waiting on YOU (Rhystic Study): pay, or the ability happens */
  needsOptionalPay: boolean
  /** the mana cost you'd pay, the ability's source name, and whether your pool covers it */
  optionalPayCost: string
  optionalPaySourceName: string
  optionalPayAffordable: boolean
  /** an as-enters choice is waiting on YOU: pay the life or the permanent enters tapped (shocklands) */
  /** an as-enters "choose a creature type" is waiting for you (r.chooseType) */
  needsTypeChoice: boolean
  typeChoiceName: string
  needsEntersChoice: boolean
  /** the life you'd pay, the permanent's name, and whether your life total allows it (CR 119.4) */
  entersChoiceLife: number
  entersChoiceName: string
  entersChoiceAffordable: boolean
  /** a cascade hit is waiting on YOU: cast the revealed card free or decline (CR 702.85) */
  needsCascade: boolean
  /** the exiled nonland "hit" you may cast for free */
  cascadeHitId: ObjId | null
  /** the hit's single client-deliverable target kind (creature/permanent/anyTarget/player); null when
   *  the hit needs no target OR needs input the client can't yet supply (modal / multi-target / spell / graveyardCard) */
  cascadeTargetKind: 'creature' | 'permanent' | 'player' | 'anyTarget' | 'spell' | 'graveyardCard' | null
  /** true when the hit can be free-cast with NO client input (non-modal, zero targets) → offer a plain "Cast free" */
  cascadeCanFreeCast: boolean
  // ---- alternative / other-zone casts the client renders as extra cast buttons ----
  /** graveyard cards castable via flashback right now (CR 702.34) — `r.cast` from the graveyard */
  flashbackable: { objId: ObjId; cost: string }[]
  /** graveyard cards castable via retrace right now (CR 702.81) — needs a land in hand to discard */
  retraceable: { objId: ObjId; cost: string }[]
  /** graveyard cards castable via escape right now (CR 702.139) — needs `exileCount` other GY cards */
  escapable: { objId: ObjId; cost: string; exileCount: number }[]
  /** hand creatures castable for their evoke cost (CR 702.74) */
  evokable: { objId: ObjId; cost: string }[]
  /** hand creatures castable as an Aura for their bestow cost (CR 702.103) — needs a creature target */
  bestowable: { objId: ObjId; cost: string }[]
  /** hand cards you can suspend right now (CR 702.62) — `r.suspend` */
  suspendable: { objId: ObjId; cost: string }[]
  /** hand cards whose Adventure half you can cast now (CR 715) */
  adventurable: { objId: ObjId; cost: string; name: string }[]
  /** exiled adventurer cards whose creature side you can cast from exile (CR 715) */
  castExileIds: ObjId[]
  /** LANDS exiled by an impulse effect that you may play right now (they use your land drop) */
  playableExileLandIds: ObjId[]
  /** hand cards whose modal-DFC LAND back face you may play right now (CR 712.4) */
  playableBackLandIds: ObjId[]
  /** castable cards with a buyback cost — the client offers a "buyback" toggle (CR 702.27) */
  buybackable: { objId: ObjId; cost: string }[]
}

export const emptyPool = (): ManaPool => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 })
