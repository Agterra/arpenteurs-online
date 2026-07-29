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
}

export interface Cost {
  mana?: string // e.g. "{1}{G}"
  tap?: boolean // {T}
  /** "Sacrifice a creature" as part of the cost (aristocrat sac outlets). Paid at
   *  activation time — the activating player chooses which creature(s). */
  sacrifice?: { count: number; filter: 'creature' }
  /**
   * "Pay N life" as part of the cost (the fetch lands). CR 119.4: payable only while your life
   * total is at least N — paying it to 0 is legal and the 0-life SBA then ends your game.
   */
  life?: number
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
}
/** The trigger events the engine emits. */
export type TriggerKind = 'etb' | 'dies' | 'attacks' | 'upkeep' | 'cast' | 'draw'

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
  /** static keyword grants (anthems / lords) — CR 613 layer 6 */
  staticKeywords?: StaticKeywordGrant[]
  /** the spell ability for instants/sorceries */
  spell?: SpellAbility
  /** modal ("choose one") spell: the caster picks one mode at cast time */
  modes?: SpellMode[]
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
  /** "At the beginning of your upkeep, …" — fires each of the controller's upkeeps */
  upkeep?: TriggeredAbility
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
    watch?: { opponentsOnly?: boolean; noncreatureOnly?: boolean; firstEachTurn?: boolean }
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
  /** engine-set: the OTHER face's registered name (both faces get one). */
  transformsTo?: string
  /** engine-set on the back face — used to revert to the front when leaving the battlefield. */
  isBackFace?: boolean
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
  grantsToHost?: { power?: number; toughness?: number; keywords?: Keyword[]; cantAttack?: boolean; cantBlock?: boolean }
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
