/**
 * Card-scripting framework. A card is data: static characteristics plus a small
 * set of composable abilities/effects. Coverage grows by adding effect
 * primitives (effects.ts) and card definitions (starter.ts, later sets/*).
 *
 * M-R0 supports: vanilla creatures, basic-land mana abilities, and
 * instant/sorcery spells with an effect + targets. Triggered/static abilities
 * and the layer system arrive in M-R1+.
 */
import type { CardType, Keyword, ManaColor, ObjId, PlayerId, RulesGameState } from '#shared/rules/types'

/** Everything an effect needs to mutate the game. Effects only touch state through here. */
export interface EffectContext {
  state: RulesGameState
  controllerId: PlayerId
  sourceId: ObjId
  targets: (ObjId | PlayerId)[]
  /** the chosen value of X for an {X} spell/ability (0 when the card has no X) */
  x?: number
  /** whether this spell was kicked (its optional kicker cost was paid) — CR 702.33 */
  kicked?: boolean
}

export type Effect = (ctx: EffectContext) => void

/** Narrows a creature/permanent target (e.g. "target artifact or enchantment an opponent controls"). */
export interface TargetFilter {
  types?: CardType[] // target must be (at least) one of these card types
  excludeTypes?: CardType[] // target must be NONE of these card types (e.g. nonland)
  subtypes?: string[] // target must have one of these subtypes
  controller?: 'you' | 'opponent' // relative to the targeting player
  /** target's mana value must be at least this (Despark: "mana value 4 or greater") */
  minManaValue?: number
  /** target's mana value must be at most this (Sun Titan: "mana value 3 or less") */
  maxManaValue?: number
  /** exclude BASIC lands (Boseiju: "nonbasic land") */
  excludeBasic?: boolean
  /** only a creature currently attacking or blocking (Eiganjo) */
  attackingOrBlocking?: boolean
}

export interface TargetSpec {
  /**
   * creature/permanent = on the battlefield (permanent = any type — land, artifact,
   * enchantment, …); player; anyTarget = creature or player; spell = a spell on
   * the stack (counters); graveyardCard = a card in a graveyard (recursion).
   */
  kind: 'creature' | 'permanent' | 'player' | 'anyTarget' | 'spell' | 'graveyardCard'
  count: number
  /** optional narrowing for creature/permanent targets */
  filter?: TargetFilter
  /**
   * "You MAY …" / "up to one target …" — the ability may be put on the stack with NO target, in which
   * case its effect does nothing (CR 601.2c). Without this, a targeted "you may" trigger would force
   * the effect whenever a legal target existed, which is stricter than the card.
   */
  optional?: boolean
}

export interface Cost {
  mana?: string // e.g. "{1}{G}"
  tap?: boolean // {T}
  /** "Sacrifice a creature" as part of the cost (aristocrat sac outlets, and the Altars' mana
   *  abilities). Paid at activation time — the activating player chooses which creature(s). */
  sacrifice?: { count: number; filter: 'creature' | 'treasure' }
  /**
   * "Pay N life" as part of the cost (the fetch lands). CR 119.4: payable only while your life
   * total is at least N — paying it to 0 is legal and the 0-life SBA then ends your game.
   */
  life?: number
  /**
   * "Pay life equal to the number of colors in your commanders' color identity" (War Room) — a
   * life cost whose amount depends on the board, so it can't be a fixed `life`. DOCUMENTED
   * SIMPLIFICATION: colour identity is approximated by the commander card's printed COLOURS,
   * which differs for a commander whose identity comes only from mana symbols in its text.
   * Adds to `life` when both are present.
   */
  lifeFromCommanderColors?: boolean
  /**
   * "Sacrifice this permanent" as part of the cost (Evolving Wilds, Mind Stone). Nothing to
   * choose — the source itself is sacrificed once the ability is on the stack, so the ability
   * still resolves from the graveyard (CR 602.2a: paying costs doesn't remove it from the stack).
   */
  sacrificeSelf?: boolean
}

/**
 * A planeswalker loyalty ability (CR 606). `cost` is the loyalty change (+N / 0 / −N);
 * a negative cost is only payable if current loyalty + cost ≥ 0. Once per turn per
 * planeswalker, at sorcery speed.
 */
export interface LoyaltyAbility {
  cost: number
  targets?: TargetSpec[]
  effect: Effect
}

/** Activated ability (M-R0: only mana abilities on lands). */
export interface ActivatedAbility {
  kind: 'activated'
  cost: Cost
  isMana?: boolean
  /** colours a mana ability can produce (introspectable metadata for legality/autotap) */
  produces?: ManaColor[]
  /**
   * true = the player CHOOSES one of `produces` on tap (guildgate/dork/rock → the
   * engine adds one mana of the chosen colour). false/absent = fixed output: the
   * engine runs `effect` (Sol Ring adds {C}{C}; a Signet adds {W}{U}; a mono dork
   * adds its one colour).
   */
  chooseColor?: boolean
  /**
   * Mana abilities that hurt (Ancient Tomb, City of Brass, the pain lands): this much damage is
   * dealt to the activating player as the ability is used. Declared here rather than inside
   * `effect` because a colour-CHOICE source never runs its effect (the engine adds the chosen
   * colour itself). City of Brass's printed "whenever this becomes tapped" is simplified to
   * tapping-for-mana — the only way it is tapped in practice.
   */
  damageOnTapForMana?: number
  /**
   * "Activate only if you control five or more lands." (Temple of the False God) — a declarative
   * condition so `redact` can hide the source when it isn't active, instead of a predicate the
   * client can't evaluate.
   */
  requiresLandsAtLeast?: number
  /** "Activate only if you control three or more artifacts." (Mox Opal's metalcraft) */
  requiresArtifactsAtLeast?: number
  /** "Activate only if you created a token this turn." (Idol of Oblivion) */
  requiresCreatedToken?: boolean
  /**
   * An ability a SAGA chapter granted to itself — "I — This Saga gains '{T}: Add {C}.'" (Urza's Saga).
   * The ability exists once the Saga has that many lore counters, which is exactly when the chapter has
   * been reached; declaring it this way keeps redact able to hide it until then.
   * DOCUMENTED SIMPLIFICATION: the lore counter is added as the chapter TRIGGERS, so the ability is
   * usable a moment earlier than if it waited for that chapter ability to resolve.
   */
  requiresLoreAtLeast?: number
  /**
   * A mana ability whose available colours depend on the board rather than a printed list:
   * `yourLands` = any type a land you control could produce (Reflecting Pool),
   * `yourLegendaries` = any colour among legendary creatures and planeswalkers you control (Mox Amber).
   * The engine computes the set for validation and redact surfaces it as the source's colour choices.
   */
  dynamicProduces?: 'yourLands' | 'yourLegendaries' | 'imprinted'
  /**
   * A FILTER mana ability (the filter lands: "{W/B}, {T}: Add {W}{W}, {W}{B}, or {B}{B}"): pay one
   * mana of any colour in `payFrom`, then add the chosen pair from `outputs`. Both choices come in on
   * r.tapMana (`payColor` + `pair`), since neither the single-colour `chooseColor` path nor a fixed
   * `produces` list can express "one in, two out, three combinations".
   */
  filter?: { payFrom: ManaColor[]; outputs: [ManaColor, ManaColor][] }
  /**
   * Nykthos: "Add an amount of mana of that color equal to your devotion to that color." The colour
   * is chosen on tap (`chooseColor`) and the AMOUNT is that colour's devotion — the number of mana
   * symbols of it among the mana costs of permanents you control (CR 700.5).
   */
  manaEqualToDevotion?: boolean
  /**
   * RESTRICTED mana (CR 106.6): the mana this ability makes goes into a separate bucket that can only
   * pay for a matching spell. `chosenTypeOnly` = "only to cast a creature spell of the chosen type"
   * (reads the source's as-enters `chosenType`), `legendaryOnly` = "only to cast a legendary spell",
   * `uncounterable` = "…and that spell can't be countered" (Cavern of Souls, Delighted Halfling).
   */
  manaRestriction?: {
    chosenTypeOnly?: boolean
    legendaryOnly?: boolean
    uncounterable?: boolean
    /** Secluded Courtyard: "…or activate an ability of a creature source of the chosen type" */
    alsoTypeAbilities?: boolean
  }
  targets?: TargetSpec[]
  effect: Effect
}

export type Ability = ActivatedAbility

export interface SpellAbility {
  targets?: TargetSpec[]
  effect: Effect
}

/** One mode of a modal ("choose one") spell — its own target list + effect. */
export interface SpellMode {
  label: string
  targets?: TargetSpec[]
  effect: Effect
}

/** A triggered ability body (CR 603): optional targets chosen when it goes on the stack. */
export interface TriggeredAbility {
  /**
   * "You may pay {N}. If you do, …" (Mana Vault's untap) — the mirror image of the `unlessPay` clause
   * on cast/draw triggers: here the effect happens only when the cost IS paid. The ability's own
   * `effect` is what runs on payment; declining does nothing.
   */
  mayPay?: string
  targets?: TargetSpec[]
  effect: Effect
  /**
   * What event this watches. Absent = the source's OWN event (plain ETB/dies).
   * `scope: 'anyCreature'` fires for any creature's event (e.g. Soul Warden),
   * narrowed by `controllerOnly` (creatures you control) / `excludeSelf`.
   * `scope: 'attachedCreature'` fires only for the creature this Aura/Equipment is
   * attached to (Skullclamp's "whenever equipped creature dies").
   */
  watch?: { scope: 'anyCreature' | 'attachedCreature'; controllerOnly?: boolean; excludeSelf?: boolean }
  /**
   * An "intervening if" clause (Land Tax: "if an opponent controls more lands than you"). Checked as
   * the trigger would go on the stack; a false condition simply means it does not trigger.
   */
  condition?: (state: RulesGameState, controllerId: PlayerId, sourceId: ObjId) => boolean
  /**
   * "This ability triggers only once each turn." (Morbid Opportunist) — tracked per source object,
   * reset with the other per-turn state at the untap step.
   */
  oncePerTurn?: boolean
}
/** The trigger events the engine emits. */
export type TriggerKind =
  | 'etb' | 'dies' | 'attacks' | 'upkeep' | 'cast' | 'draw' | 'landfall' | 'combatDamage' | 'drawStep'
  | 'beginCombat' | 'leavesBattlefield'

/**
 * One Saga chapter ability (CR 714). Chapter N triggers when the Saga's lore counter reaches N
 * (it enters with one lore counter → chapter I; another is added after each of the controller's
 * draw steps). Like a triggered ability, it may choose targets when it goes on the stack.
 */
export interface SagaChapter {
  targets?: TargetSpec[]
  effect: Effect
}

/** Which creatures a static effect (anthem / keyword grant) applies to. Empty = all creatures. */
export interface AffectsFilter {
  controllerOnly?: boolean // "creatures YOU control"
  excludeSelf?: boolean // "OTHER creatures…"
  subtype?: string // lord filter, e.g. "Goblin"
  /** "creatures you control of the CHOSEN type" (Patchwork Banner) — reads the source's chosenType */
  subtypeChosen?: boolean
}

/**
 * A static continuous P/T modifier from a permanent on the battlefield
 * (CR 613 layer 7c) — anthems ("creatures you control get +1/+1") and lords
 * ("other Goblins you control get +1/+1").
 */
export interface StaticPTEffect {
  affects: AffectsFilter
  power: number
  toughness: number
}

/**
 * A static keyword grant from a permanent on the battlefield (CR 613 layer 6) —
 * "creatures you control have haste", "other Goblins you control have menace".
 */
export interface StaticKeywordGrant {
  affects: AffectsFilter
  keywords: Keyword[]
}

export interface CardDefinition {
  name: string
  types: CardType[]
  subtypes?: string[]
  supertypes?: string[]
  manaCost?: string
  colors?: ManaColor[]
  power?: number
  toughness?: number
  /** enters the battlefield with this many +1/+1 counters (unconditional) */
  entersWithCounters?: number
  /** starting loyalty (planeswalkers) */
  loyalty?: number
  /** planeswalker loyalty abilities (CR 606) — activated once per turn at sorcery speed */
  loyaltyAbilities?: LoyaltyAbility[]
  /** evergreen combat keywords the engine enforces (M-R1) */
  keywords?: Keyword[]
  /** activated abilities (permanents) — M-R0: land mana abilities */
  abilities?: Ability[]
  /** static continuous P/T modifiers (anthems / lords) — CR 613 layer 7c */
  statics?: StaticPTEffect[]
  /**
   * A P/T that counts something on the board — "gets +1/+1 for each artifact you control" (Urza's
   * Saga's Construct) or "+1/+0 for each artifact you control" (Storm-Kiln Artist). Applied in
   * `currentPT` (CR 613 layer 7c) so it follows the board live.
   */
  dynamicPT?: { per: 'artifactsYouControl'; power: number; toughness: number }
  /** static keyword grants (anthems / lords) — CR 613 layer 6 */
  staticKeywords?: StaticKeywordGrant[]
  /** the spell ability for instants/sorceries */
  spell?: SpellAbility
  /**
   * "As this permanent enters, choose a creature type." (Cavern of Souls, Patchwork Banner) — its
   * controller chooses before anything else happens (CR 614.12c); the pick lands on the object as
   * `chosenType` and is read by that card's own abilities (a type anthem, restricted mana, …).
   */
  entersChooseType?: boolean
  /** modal ("choose one") spell: the caster picks one mode at cast time */
  modes?: SpellMode[]
  /**
   * How MANY of `modes` are chosen, when it isn't one (CR 700.2). Exactly one of:
   *   `count: 2`          — "Choose two —" (Austere Command). Duplicates are illegal (CR 700.2d).
   *   `oneOrMore: true`   — "Choose one or more —" (Farewell).
   *   `bothIfCommander`   — "Choose one. If you control a commander as you cast this spell, you may
   *                          choose both instead." (Akroma's Will) — 2 modes only with a commander
   *                          ON THE BATTLEFIELD, the same check the free-cast spells use.
   * The chosen modes always resolve in PRINTED order, whatever order they were picked in (CR 601.2b).
   */
  modeRule?: { count?: number; oneOrMore?: boolean; bothIfCommander?: boolean }
  /**
   * Split card (CR 709): two instant/sorcery halves on one card, each with its own name / types /
   * mana cost / effect. The caster picks a half at cast time via `mode` (0 = left, 1 = right); the
   * card goes to the graveyard on resolution like any instant/sorcery. (Fuse is not supported.)
   * Give the card `types` covering both halves (e.g. `['Instant','Sorcery']`).
   */
  split?: {
    left: { name: string; types: CardType[]; manaCost: string } & SpellAbility
    right: { name: string; types: CardType[]; manaCost: string } & SpellAbility
  }
  /**
   * Triggered abilities (CR 603). Each fires on its event, is put on the stack
   * when its controller next gets priority, and resolves like a spell. If it has
   * `targets` the controller chooses them (removed if none legal — 603.3c).
   * `enters` = ETB, `dies` = this leaves the battlefield for the graveyard,
   * `attacks` = this attacks.
   */
  enters?: TriggeredAbility
  dies?: TriggeredAbility
  attacks?: TriggeredAbility
  /**
   * DELAYED triggered abilities (CR 603.7): "At the beginning of your next upkeep / next main phase,
   * …", scheduled by an effect (`scheduleDelayed`) and keyed here so the scheduled entry — which
   * lives in serialisable state — can find its body again. `unlessPay` makes it a pay-or-else
   * decision (Pact of Negation: pay {3}{U}{U} or `effect` happens, which is losing the game).
   */
  delayed?: Record<string, { at: 'nextUpkeep' | 'nextMainPhase'; unlessPay?: string; effect: Effect }>
  /**
   * Triggered abilities this card GRANTS to another permanent until end of turn — 'that creature
   * gains "When this creature dies, return it to the battlefield tapped…"' (Malakir Rebirth, Feign
   * Death). Keyed like `delayed`: the state only stores this card's name + the key, never a function.
   * The granted ability's source is the creature that gained it, so its effect reads ctx.sourceId.
   */
  grantedAbilities?: Record<string, TriggeredAbility>
  /**
   * CHANNEL (CR 702.140-style ability word on the Kamigawa legendary lands): "Channel — [cost],
   * Discard this card: [effect]." An activated ability used from the HAND at instant speed: the mana
   * is paid, the card is discarded as part of the cost, and the ability goes on the stack (so it can
   * be responded to). `reducedByLegendaries` implements "costs {1} less to activate for each
   * legendary creature you control" against the GENERIC portion.
   *
   * LANDCYCLING (CR 702.29) has the very same shape — "[cost], Discard this card: Search your
   * library for a … land card, reveal it, put it into your hand, then shuffle" — so it reuses this
   * plumbing; `label` renames the client's button ("Landcycle {1}" for Ash Barrens).
   */
  channel?: { cost: string; label?: string; reducedByLegendaries?: boolean; targets?: TargetSpec[]; effect: Effect }
  /**
   * "Whenever [this creature / equipped creature / one or more creatures you control] deals combat
   * damage to a player, …" (CR 603.2). `watch.scope` picks the source: absent = this permanent itself
   * dealt the damage, 'attachedCreature' = the creature this Equipment/Aura is attached to,
   * 'anyCreature' (+ controllerOnly) = the "one or more creatures you control" wording, which fires
   * ONCE per damaged player however many creatures connected.
   *
   * The DAMAGED PLAYER is passed as the ability's implicit target when it declares no `targets`, so
   * "that player discards a card" needs no choice; an ability that declares targets (Sword of Fire
   * and Ice: "deals 2 damage to any target") picks them the normal way and cannot see that player.
   */
  combatDamage?: TriggeredAbility
  /** "At the beginning of your upkeep, …" — fires each of the controller's upkeeps */
  upkeep?: TriggeredAbility
  /**
   * Landfall — "Whenever a land you control enters, …" (Rampaging Baloths). Fires from the same
   * entry hook as the ETB watchers, once per land entering under this permanent's controller.
   */
  landEnters?: TriggeredAbility
  /**
   * "Whenever an opponent casts a spell, …" (CR 603.2) — a CAST trigger, put on the stack above the
   * spell that caused it, so it resolves first. `watch` narrows which casts fire it.
   *
   * `unlessPay` makes it the "tax" shape (Rhystic Study, Esper Sentinel): when the ability resolves,
   * the player who cast the spell may pay that cost; only if they DON'T does `effect` happen (for
   * this permanent's controller). `unlessPayFromPower` computes the cost as {X} = the source's
   * current power instead of a fixed string.
   */
  castSpell?: {
    watch?: {
      opponentsOnly?: boolean
      selfOnly?: boolean
      creatureOnly?: boolean
      noncreatureOnly?: boolean
      /** only spells of these card types (Guttersnipe: instant or sorcery) */
      typesOnly?: CardType[]
      firstEachTurn?: boolean
    }
    unlessPay?: string
    unlessPayFromPower?: boolean
    effect: Effect
  }
  /**
   * "Whenever an opponent draws a card, …" (Smothering Tithe) — same shape as `castSpell`: the
   * trigger goes on the stack and, with `unlessPay`, opens the pay-or-it-happens decision for the
   * player who drew. Fires once per card drawn, and never during the pre-game draws.
   */
  drawnCard?: {
    watch?: { opponentsOnly?: boolean }
    unlessPay?: string
    effect: Effect
  }
  /**
   * "As an additional cost to cast this spell, pay X life." (Toxic Deluge) — the caster chooses X
   * (passed as `r.cast.x`, so the effect reads `ctx.x`), must have that much life (CR 119.4), and
   * pays it as the spell is cast. Independent of {X} in the mana cost, which this does NOT add to.
   */
  additionalLifeCostX?: boolean
  /**
   * "As an additional cost to cast this spell, sacrifice a creature / discard a card." The caster
   * chooses what to pay as they cast it (`r.cast.sacrifices` / `r.cast.discards`); the engine
   * validates before any mutation and pays it with the other costs. A sacrifice hits the graveyard
   * AFTER the spell is on the stack, so its dies triggers resolve above the spell (CR 603.3b).
   */
  additionalCost?: { sacrifice?: { count: number; filter: 'creature' | 'artifactOrCreature' | 'land' }; discard?: number }
  /** "This spell can't be countered." (Dovin's Veto) — every counter effect skips it. */
  cantBeCountered?: boolean
  /**
   * Grand Abolisher: "During your turn, your opponents can't cast spells or activate abilities of
   * artifacts, creatures, or enchantments." A static restriction checked in r.cast / r.activate.
   */
  opponentsCantActOnYourTurn?: boolean
  /**
   * Propaganda / Ghostly Prison: "Creatures can't attack you unless their controller pays {N} for
   * each creature they control that's attacking you." A generic mana cost paid as attackers are
   * declared (CR 508.1g): the engine sums the tax across the defender's taxing permanents and
   * deducts it from the attacking player's pool, refusing the declaration if they can't pay.
   */
  attackTax?: number
  /**
   * Chromatic Lantern: 'Lands you control have "{T}: Add one mana of any color."' A granted mana
   * ability — r.tapMana accepts these colours from any land its controller controls, and redact adds
   * them to that land's colour choices.
   */
  grantsLandManaColors?: ManaColor[]
  /**
   * A static cost reduction this PERMANENT gives your spells (Foundry Inspector: "artifact spells
   * you cast cost {1} less"; the Medallions: "[colour] spells you cast cost {1} less"). Summed over
   * every matching permanent you control as a spell is cast, applied to the GENERIC portion only,
   * and mirrored in redact's castability check. `types`/`colors` empty = every spell you cast.
   */
  spellCostReduction?: { amount: number; types?: CardType[]; colors?: ManaColor[] }
  /**
   * Saga (CR 714): an Enchantment — Saga with ordered chapter abilities. `chapters[0]` is
   * chapter I. The engine adds a lore counter as it enters (→ chapter I) and after each of the
   * controller's draw steps (→ the next chapter), and sacrifices it after the final chapter's
   * ability has left the stack. Give the card `types: ['Enchantment']`, `subtypes: ['Saga']`.
   */
  saga?: { chapters: SagaChapter[] }
  /**
   * Adventure (CR 715): the card is a creature (the main def carries its creature body/cost) that
   * may instead be cast as this instant/sorcery "adventure". When the adventure resolves it is
   * EXILED (not put into the graveyard) and its owner may afterwards cast the creature from exile.
   * `manaCost`/`types` are the adventure half's; `spell` is its effect + targets.
   */
  adventure?: { name: string; types: CardType[]; manaCost: string } & SpellAbility
  /**
   * Flashback (CR 702.34): "You may cast this card from your graveyard by paying [cost]. Then
   * exile it." Set to the mana part of the flashback cost (e.g. '{4}{R}'). The engine lets the
   * owner cast the instant/sorcery from their graveyard for this cost, and exiles it as it leaves
   * the stack (on resolution OR if countered) instead of returning it to the graveyard. Mana-only
   * flashback (life/other additional costs are deferred).
   */
  flashbackCost?: string
  /**
   * Retrace (CR 702.81): "You may cast this card from your graveyard by discarding a land card in
   * addition to paying its other costs." Unlike flashback, the card is NOT exiled — it returns to
   * the graveyard on resolution and can be retraced again. The land to discard is passed as
   * `r.cast.retraceLand`.
   */
  retrace?: boolean
  /**
   * Escape (CR 702.139): "You may cast this card from your graveyard by paying [cost] and exiling
   * N other cards from your graveyard." Not self-exiled — it resolves normally (creature enters /
   * spell to graveyard) and can be escaped again later. `cost` is the escape mana cost; the N cards
   * to exile are passed as `r.cast.escapeExile`.
   */
  escape?: { cost: string; exileCount: number }
  /**
   * Buyback (CR 702.27): "You may pay an additional [cost] as you cast this spell. If you do, put
   * it into your hand instead of into your graveyard as it resolves." Set to the mana part of the
   * buyback cost; passed via `r.cast.buyback`. Only applies on resolution (a fizzled spell still
   * goes to the graveyard).
   */
  buybackCost?: string
  /**
   * Bestow (CR 702.103): a creature (Enchantment Creature — Aura) that may instead be cast for its
   * bestow cost as an Aura enchanting a creature, granting the host `grantsToHost`. If the enchanted
   * creature leaves, it stops being an Aura and becomes a creature (still on the battlefield). Set
   * to the bestow mana cost; declare the bonus in `grantsToHost`. Cast as bestow via `r.cast.bestow`.
   */
  bestowCost?: string
  /**
   * Evoke (CR 702.74): "You may cast this spell for its evoke cost. If its evoke cost was paid,
   * it's sacrificed when it enters the battlefield." Its enters-the-battlefield triggers still fire
   * (they're on the stack when it's sacrificed). Set to the evoke mana cost; cast via `r.cast.evoke`.
   */
  evokeCost?: string
  /**
   * Madness (CR 702.35): "If you discard this card, exile it. You may cast it for its madness cost;
   * if you don't, put it into your graveyard." Set to the madness mana cost; the engine opens a
   * cast-or-graveyard window (`r.madness`) when this card is discarded.
   */
  madnessCost?: string
  /**
   * Foretell (CR 702.143): "During your turn, pay {2} and exile this card face down." On a LATER
   * turn you may cast it from exile for its foretell cost. Set to the foretell mana cost; the {2}
   * to foretell is fixed. Foretelling reveals nothing to opponents (the card is face-down).
   */
  foretellCost?: string
  /**
   * Morph (CR 702.37): "You may cast this card face down as a 2/2 creature for {3}. Turn it face up
   * any time for its morph cost." Set to the morph (turn-face-up) mana cost; casting face-down is a
   * fixed {3}. While face down it's a 2/2 with no name/types/abilities (see characteristics).
   */
  morphCost?: string
  /**
   * Convoke (CR 702.51): "Your creatures can help cast this spell." As you cast it you may tap any
   * number of untapped creatures you control; each pays for {1} or one mana of that creature's
   * colours. The tapped creatures are chosen client-side and passed as `r.cast.convoke`.
   */
  convoke?: boolean
  /**
   * Suspend (CR 702.62): "Suspend N—[cost]. Rather than cast this card, you may pay [cost] and
   * exile it with N time counters. At the beginning of your upkeep, remove a time counter; when
   * the last is removed, cast it without paying its mana cost (if a creature, it gains haste)."
   * `cost` is the mana part. NON-targeted suspend spells auto-cast when the last counter is removed;
   * targeted-suspend auto-cast (with a target choice) + creature haste are documented follow-ups.
   */
  suspend?: { n: number; cost: string }
  /**
   * True for "assisted table" fallbacks auto-built from the catalog: the engine
   * knows the printed body (types/P·T/cost) but NOT the card's rules text. Such
   * cards are castable and fight, but their effects are player-run via manual
   * overrides and the engine NEVER auto-destroys them (see checkSBA).
   */
  unimplemented?: boolean
  /** printed rules text (shown to players so they can hand-run an unimplemented card) */
  oracleText?: string
  /**
   * Transforming double-faced card (CR 712): the front face declares its back face here. The
   * registry registers BOTH faces (front + `back.name`) and links them via `transformsTo`; the
   * `transform()` effect swaps the object's `defName` between them, so every reader (`getDef`) sees
   * the current face automatically. A DFC reverts to its front face when it leaves the battlefield.
   */
  back?: CardDefinition
  /**
   * MODAL double-faced card (CR 712.4): the front face is a spell/creature, the back face is a LAND
   * you may PLAY instead of casting the front — no transforming involved, the choice is made as the
   * card leaves your hand. Registered and cross-linked exactly like `back`, so a back-face land that
   * leaves the battlefield reverts to its front face (CR 712.13) through the same code path.
   */
  modalBack?: CardDefinition
  /**
   * Animate Dead: an Aura cast on a creature CARD IN A GRAVEYARD. On resolution the card is put onto
   * the battlefield under the Aura's controller and the Aura attaches to it (CR 303.4h + the card's own
   * text), rather than the usual "attach to the targeted battlefield permanent".
   */
  reanimatingAura?: boolean
  /** engine-set: the OTHER face's registered name (both faces get one). */
  transformsTo?: string
  /** engine-set on the back face — used to revert to the front when leaving the battlefield. */
  isBackFace?: boolean
  /**
   * Counter-placement REPLACEMENT effect (CR 616): "If one or more +1/+1 counters would be put on a
   * creature you control, that many plus one / twice that many are put on it instead" (Hardened
   * Scales, Branching Evolution, Corpsejack Menace) or, for ANY counter on ANY permanent you control,
   * Doubling Season. Applied in `addCounters`, the single place counters are added.
   */
  counterReplacement?: {
    mode: 'plusOne' | 'double'
    /** absent = any counter kind (Doubling Season); '+1/+1' = only those */
    only?: '+1/+1'
    scope: 'creaturesYouControl' | 'permanentsYouControl'
  }
  /**
   * Token-creation REPLACEMENT effect (CR 616): "If an effect would create one or more tokens under
   * your control, it creates twice that many of those tokens instead" (Doubling Season, Parallel
   * Lives, Anointed Procession). Applied in `spawnTokens`; several stack multiplicatively.
   */
  tokenReplacement?: 'double'
  /**
   * "This land enters tapped unless you control three or more other Islands." (the Eldraine land
   * cycle) — like `entersTappedUnlessOtherLandsAtLeast`, but counting only lands with that SUBTYPE.
   */
  entersTappedUnlessOtherSubtypeAtLeast?: { subtype: string; count: number }
  /** "This permanent doesn't untap during your untap step." (Mana Vault, the Monoliths) */
  doesNotUntap?: boolean
  /**
   * "At the beginning of your draw step, …" — fires as the active player's draw step begins, BEFORE
   * the draw. Mana Vault's self-damage lives here (its pay-to-untap is an upkeep trigger).
   */
  drawStep?: TriggeredAbility
  /** "At the beginning of combat on your turn, …" (Helm of the Host, The Ozolith) — CR 506.1 */
  beginCombat?: TriggeredAbility
  /**
   * "When this permanent leaves the battlefield, …" / "Whenever a creature you control leaves the
   * battlefield, …" (Animate Dead, The Ozolith) — CR 603.6d, fired for ANY battlefield exit (dying,
   * exile, a bounce), unlike `dies`. The leaving object's counters are readable as `lastCounters`.
   */
  leavesBattlefield?: TriggeredAbility
  /** replacement effect: this permanent enters the battlefield tapped (e.g. Guildgates) */
  entersTapped?: boolean
  /**
   * The check lands: "This land enters tapped unless you control an Island or a Mountain." Listed
   * as land SUBTYPES; on any battlefield entry it enters tapped unless its controller already
   * controls a land with one of them (a basic Island, a shockland with the Island type, …).
   */
  entersTappedUnlessControlLandType?: string[]
  /**
   * The battle lands: "This land enters tapped unless you control two or more basic lands."
   * Counted on any battlefield entry, like the check lands' subtype condition.
   */
  entersTappedUnlessBasicsAtLeast?: number
  /**
   * The Battlebond lands: "This land enters tapped unless you have two or more opponents." In a
   * duel they always enter tapped; in 3–4 player Commander they don't. Opponents = players still in
   * the game other than the controller.
   */
  entersTappedUnlessOpponentsAtLeast?: number
  /** The slow lands: "This land enters tapped unless you control two or more OTHER lands." */
  entersTappedUnlessOtherLandsAtLeast?: number
  /**
   * The "Snarl" / reveal lands: "As this land enters, you may reveal an Island or Swamp card from
   * your hand. If you don't, this land enters tapped." Listed as land SUBTYPES. Since revealing is
   * free and always beneficial, the engine reveals automatically when a matching card is in hand
   * (logging it, so the information really is public) rather than opening a decision nobody would
   * decline — a documented simplification.
   */
  entersTappedUnlessRevealFromHand?: string[]
  /**
   * "You may play an additional land on each of your turns." (Exploration) — a STATIC allowance from
   * a permanent, summed with any one-shot `extraLandsThisTurn` grants (Explore).
   */
  extraLandDrops?: number
  /**
   * "If you control a commander, you may cast this spell without paying its mana cost."
   * (the free-spell cycle: Fierce Guardianship, Deadly Rollick, …). Cast via `r.cast.free`; the
   * engine verifies a commander permanent is on the caster's battlefield and skips the mana entirely.
   */
  freeIfCommander?: boolean
  /**
   * As-enters replacement CHOICE (CR 614.12) — the shocklands' "As this land enters, you may pay N
   * life. If you don't, it enters tapped." Set to the life amount. The engine opens an
   * `entersChoice` pending for its controller on ANY battlefield entry (played, fetched, moved),
   * and no player can act until it's answered. Not combinable with an `enters` trigger yet (one
   * pending slot) — guarded in rules-client-contract.spec.ts.
   */
  entersTappedUnlessPayLife?: number
  /**
   * Aura / Equipment: the continuous bonus granted to the ATTACHED host while this
   * permanent is attached to it (CR 613 layers 7c P/T + 6 keywords), plus optional
   * can't-attack / can't-block restrictions (Pacifism). An Aura (subtype 'Aura')
   * attaches on resolution to its spell target; Equipment (subtype 'Equipment')
   * attaches via its equip ability (`equipCost`).
   */
  grantsToHost?: {
    power?: number
    toughness?: number
    keywords?: Keyword[]
    cantAttack?: boolean
    cantBlock?: boolean
    /** "Equipped creature can't be blocked." (Whispersilk Cloak) */
    cantBeBlocked?: boolean
    /** "Equipped creature has protection from black and from green." (the Swords) — CR 613 layer 6 */
    protectionFrom?: ManaColor[]
  }
  /** Equipment: the mana cost of its equip activated ability (sorcery speed). */
  equipCost?: string
  /**
   * Cycling (CR 702.29): "[cost], Discard this card: Draw a card." An activated ability
   * usable only from the hand at instant speed. Set to the mana part of the cost (e.g.
   * '{2}'); the discard is handled by the engine. Plain cycling only — typecycling /
   * landcycling (which search) are deferred.
   */
  cyclingCost?: string
  /**
   * Kicker (CR 702.33): an OPTIONAL additional mana cost paid as the spell is cast. When
   * paid, the spell was "kicked" and its effect reads `ctx.kicked` to do more/different.
   * Set to the mana part of the kicker (e.g. '{4}'); the engine adds it to the cost when
   * the caster chooses to kick and threads the flag to resolution.
   */
  kickerCost?: string
  /**
   * Generic cost reduction computed dynamically as the spell is cast (CR 601.2f) — e.g.
   * Blasphemous Act ("costs {1} less for each creature on the battlefield") or a
   * commander-conditional discount. Returns how much to subtract from the GENERIC portion
   * of the cost (the engine floors it at 0; coloured pips are never reduced). Applied after
   * cost increases (tax / X / kicker / buyback), before convoke. Mirrored in redact's
   * castability check so the client highlights the reduced affordability.
   */
  costReduction?: (state: RulesGameState) => number
  /**
   * Ward (CR 702.21): "Whenever this permanent becomes the target of a spell or ability an
   * opponent controls, counter it unless that player pays [cost]." Set to the mana part of
   * the ward cost (e.g. '{2}'); the engine queues the ward trigger and runs the pay-or-
   * counter decision. Mana ward only — ward—pay-life / ward—discard are deferred.
   */
  ward?: string
  /**
   * Overload (CR 702.96): "You may cast this spell for its overload cost. If you do, change
   * 'target' in its text to 'each'." An ALTERNATIVE cost (it replaces the printed mana cost) and a
   * different, untargeted body — declared here as its own effect. Cast via `r.cast.overload`.
   */
  overload?: { cost: string; effect: Effect }
  /**
   * Cascade (CR 702.85): "When you cast this spell, exile from the top of your library until
   * you exile a nonland card with lesser mana value; you may cast it for free; put the rest on
   * the bottom in a random order." The engine runs the whole thing (single cascade only;
   * cascade on the free-cast card is not re-triggered — a documented simplification).
   */
  cascade?: boolean
  /** "This creature can't be blocked." (unconditional evasion, e.g. Invisible Stalker.) */
  cantBeBlocked?: boolean
  /**
   * "You have no maximum hand size." (CR 402.2 exception) — a static ability of a permanent on the
   * battlefield: while its controller controls it, the cleanup-step discard is skipped for them
   * (Reliquary Tower, Thought Vessel). Checked live in the cleanup step, so losing the permanent
   * mid-turn re-imposes the limit.
   */
  noMaxHandSize?: boolean
  /**
   * Protection from [colour] (CR 702.16, the "DEBT" rule): this permanent can't be Damaged,
   * Enchanted/Equipped, Blocked, or Targeted by anything of the listed colours. Printed only —
   * GRANTED protection (Mother of Runes) is deferred.
   */
  protectionFrom?: ManaColor[]
}

export const defIsSaga = (def: CardDefinition) => !!def.saga
export const defIsAura = (def: CardDefinition) => def.subtypes?.includes('Aura') ?? false
export const defIsEquipment = (def: CardDefinition) => def.subtypes?.includes('Equipment') ?? false

export const isPermanentType = (t: CardType) =>
  t === 'Land' || t === 'Creature' || t === 'Artifact' || t === 'Enchantment' || t === 'Planeswalker' || t === 'Battle'

export const defIsPermanent = (def: CardDefinition) => def.types.some(isPermanentType)
export const defIsCreature = (def: CardDefinition) => def.types.includes('Creature')
export const defHasKeyword = (def: CardDefinition, kw: Keyword) => def.keywords?.includes(kw) ?? false
export const defIsLand = (def: CardDefinition) => def.types.includes('Land')
export const defIsBasic = (def: CardDefinition) => def.supertypes?.includes('Basic') ?? false
/** Legendary creature → may be your commander (no partners/backgrounds yet). */
export const defIsValidCommander = (def: CardDefinition) =>
  defIsCreature(def) && (def.supertypes?.includes('Legendary') ?? false)
export const defIsSorcerySpeed = (def: CardDefinition) =>
  def.types.includes('Sorcery') || (defIsPermanent(def) && !def.types.includes('Instant'))
