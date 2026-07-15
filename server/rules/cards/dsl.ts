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
   */
  watch?: { scope: 'anyCreature'; controllerOnly?: boolean; excludeSelf?: boolean }
}
/** The trigger events the engine emits. */
export type TriggerKind = 'etb' | 'dies' | 'attacks' | 'upkeep'

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
   * True for "assisted table" fallbacks auto-built from the catalog: the engine
   * knows the printed body (types/P·T/cost) but NOT the card's rules text. Such
   * cards are castable and fight, but their effects are player-run via manual
   * overrides and the engine NEVER auto-destroys them (see checkSBA).
   */
  unimplemented?: boolean
  /** printed rules text (shown to players so they can hand-run an unimplemented card) */
  oracleText?: string
  /** replacement effect: this permanent enters the battlefield tapped (e.g. Guildgates) */
  entersTapped?: boolean
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
   * Ward (CR 702.21): "Whenever this permanent becomes the target of a spell or ability an
   * opponent controls, counter it unless that player pays [cost]." Set to the mana part of
   * the ward cost (e.g. '{2}'); the engine queues the ward trigger and runs the pay-or-
   * counter decision. Mana ward only — ward—pay-life / ward—discard are deferred.
   */
  ward?: string
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
   * Protection from [colour] (CR 702.16, the "DEBT" rule): this permanent can't be Damaged,
   * Enchanted/Equipped, Blocked, or Targeted by anything of the listed colours. Printed only —
   * GRANTED protection (Mother of Runes) is deferred.
   */
  protectionFrom?: ManaColor[]
}

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
