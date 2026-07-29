/**
 * M-R0 curated starter pool: basic lands, vanilla creatures, and simple spells
 * that exercise the whole spine (mana, timing, the stack, targeting, combat,
 * SBA). All are real Magic cards so decklists resolve from the catalog.
 */
import type { CardDefinition } from './dsl'
import { battlefieldCreatures } from '../state'
import { controlledLands } from '../engine'
import {
  adapt,
  addCounters,
  addCountersToEachControlled,
  addLoyaltyToOtherPlaneswalkers,
  addMana,
  addManaPerLandSubtype,
  addManaPerColorAmongPermanents,
  addManaPerOpponentTappedLand,
  monstrosity,
  counterTarget,
  chaosWarpTarget,
  counterTargetGrantingToken,
  counterTargetGrantingTreasures,
  createToken,
  createTreasures,
  damageAllCreatures,
  dealDamage,
  dealDamageKicked,
  dealDamageX,
  dealToEachOpponent,
  dealToEachPlayer,
  destroyAllArtifactsYouDontControl,
  destroyAllCreatures,
  destroyPermanent,
  destroyPermanentGrantToken,
  destroyPermanentControllerGains,
  discardAtRandom,
  destroyTarget,
  drainEachOpponentByDevotion,
  drainEachOpponentX,
  drainTargetPlayer,
  drawCards,
  drawCardsX,
  drawPerControlledCreature,
  earthquakeX,
  exileGraveyard,
  extraLandDrop,
  exileTarget,
  fight,
  gainAndDrawEqualToLands,
  gainLifeEqualToPowerForController,
  grantKeywordsToControlled,
  grantProtection,
  makeUnblockable,
  returnAllAttackersToHand,
  returnAllNonlandYouDontControlToHand,
  returnToHand,
  eachOpponentLoses,
  gainLife,
  gainLifeX,
  gainLifePerBigCreature,
  gainLifePerSpellThisTurn,
  loseAllAbilities,
  loseLife,
  mill,
  playersDiscard,
  playersSacrifice,
  pump,
  weakenAllCreatures,
  weakenAllCreaturesX,
  weakenControlledCreatures,
  pumpSelf,
  putBackOnTop,
  returnFromGraveyard,
  scry,
  searchLibrary,
  sequence,
  surveil,
  setBasePT,
  lookTransformIfInstantSorcery,
  targetPlayerDrawDrain,
  selfDiscard,
  exileTargetControllerFetchesLand,
  destroyLoseLifeEqualToMV,
  reanimate,
} from './effects'
import type { Keyword, ManaColor } from '#shared/rules/types'

const basic = (name: string, color: ManaColor, subtype: string): CardDefinition => ({
  name,
  types: ['Land'],
  supertypes: ['Basic'],
  subtypes: [subtype],
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [color], effect: addMana(color) }],
})

/** A Guildgate: enters tapped, "{T}: Add {a} or {b}." (colour chosen on tap). */
const guildgate = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  subtypes: ['Gate'],
  entersTapped: true,
  // effect unused for a colour-choice source (the engine adds the chosen colour)
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/** An Onslaught cycling land: enters tapped, "{T}: Add {c}." + "Cycling {c}". Entire
 *  rules captured (tapland mana ability + plain cycling → discard, draw a card). */
const cyclingLand = (name: string, color: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  entersTapped: true,
  cyclingCost: `{${color}}`,
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [color], effect: addMana(color) }],
})

/**
 * A pay-1-life fetch land (Onslaught + Zendikar cycles): "{T}, Pay 1 life, Sacrifice this land:
 * Search your library for an [a] or [b] card, put it onto the battlefield, then shuffle." The
 * fetched land enters UNTAPPED (the tapped, {1}-cost Mirage cycle is a different set of cards), and
 * the subtype filter matches basic AND nonbasic lands with that type — exactly the printed rules.
 */
const fetchLand = (name: string, a: string, b: string): CardDefinition => ({
  name,
  types: ['Land'],
  abilities: [
    {
      kind: 'activated',
      cost: { tap: true, life: 1, sacrificeSelf: true },
      effect: searchLibrary({ filter: { landSubtypes: [a, b] }, dest: 'battlefield', count: 1 }),
    },
  ],
})

/**
 * A shockland (Ravnica cycle): a dual-typed land whose printed types give it "{T}: Add {a} or {b}",
 * plus "As this land enters, you may pay 2 life. If you don't, it enters tapped." The real basic
 * land subtypes matter — a fetch land can find one.
 */
const shockland = (name: string, a: ManaColor, b: ManaColor, subtypes: [string, string]): CardDefinition => ({
  name,
  types: ['Land'],
  subtypes,
  entersTappedUnlessPayLife: 2,
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/**
 * A pain land (Ice Age / Apocalypse cycles): "{T}: Add {C}." and "{T}: Add {a} or {b}. This land
 * deals 1 damage to you." Two separate mana abilities — r.tapMana picks the one that can make the
 * requested colour, so asking for {C} is free and asking for a colour costs 1 life.
 */
const painLand = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  abilities: [
    { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C') },
    {
      kind: 'activated',
      cost: { tap: true },
      isMana: true,
      produces: [a, b],
      chooseColor: true,
      damageOnTapForMana: 1,
      effect: addMana(a),
    },
  ],
})

/**
 * A check land (M10 / Innistrad cycles): "This land enters tapped unless you control an [x] or a
 * [y]. {T}: Add {a} or {b}." The subtypes checked are the two basic land types of its colours.
 */
const checkLand = (name: string, a: ManaColor, b: ManaColor, need: [string, string]): CardDefinition => ({
  name,
  types: ['Land'],
  entersTappedUnlessControlLandType: need,
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/** A scry-land: enters tapped, "When ~ enters, scry 1.", "{T}: Add {a} or {b}." */
const scryland = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  entersTapped: true,
  enters: { effect: scry(1) },
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/**
 * A Talisman: "{T}: Add {C}." and "{T}: Add {a} or {b}. This artifact deals 1 damage to you." — the
 * pain-land shape on an artifact (two mana abilities; r.tapMana picks by the colour asked for).
 */
const talisman = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Artifact'],
  manaCost: '{2}',
  abilities: [
    { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C') },
    {
      kind: 'activated',
      cost: { tap: true },
      isMana: true,
      produces: [a, b],
      chooseColor: true,
      damageOnTapForMana: 1,
      effect: addMana(a),
    },
  ],
})

/**
 * A battle land (Battle for Zendikar duals): "enters tapped unless you control two or more basic
 * lands", with the two real basic land types so a fetch land can find it.
 */
const battleLand = (name: string, a: ManaColor, b: ManaColor, subtypes: [string, string]): CardDefinition => ({
  name,
  types: ['Land'],
  subtypes,
  entersTappedUnlessBasicsAtLeast: 2,
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/** A Battlebond land: "enters tapped unless you have two or more opponents", dual-colour. */
const bondLand = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  entersTappedUnlessOpponentsAtLeast: 2,
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/** A slow land (Innistrad: Midnight Hunt / Crimson Vow): "unless you control two or more OTHER lands". */
const slowLand = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  entersTappedUnlessOtherLandsAtLeast: 2,
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/** An original dual land: untapped, two real basic land types, "{T}: Add {a} or {b}." */
const dualLand = (name: string, a: ManaColor, b: ManaColor, subtypes: [string, string]): CardDefinition => ({
  name,
  types: ['Land'],
  subtypes,
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/**
 * A Karoo ("bounce") land: enters tapped, "When this land enters, return a land you control to its
 * owner's hand", and "{T}: Add {a}{b}" (two mana at once, a fixed output).
 */
const karooLand = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  entersTapped: true,
  enters: {
    targets: [{ kind: 'permanent', count: 1, filter: { types: ['Land'], controller: 'you' } }],
    effect: returnToHand(),
  },
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], effect: addMana(a, b) }],
})

/** A surveil land (Murders at Karlov Manor): enters tapped, ETB surveil 1, dual-colour. */
const surveilLand = (name: string, a: ManaColor, b: ManaColor, subtypes: [string, string]): CardDefinition => ({
  name,
  types: ['Land'],
  subtypes,
  entersTapped: true,
  enters: { effect: surveil(1) },
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/** A "Snarl" land: untapped if you reveal a matching land card from hand, else tapped. */
const revealLand = (name: string, a: ManaColor, b: ManaColor, need: [string, string]): CardDefinition => ({
  name,
  types: ['Land'],
  entersTappedUnlessRevealFromHand: need,
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
})

/**
 * A horizon land: "{T}, Pay 1 life: Add {a} or {b}." and "{1}, {T}, Sacrifice this land: Draw a card."
 * (a life-cost mana ability plus a sac-self draw — both existing primitives).
 */
const horizonLand = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  abilities: [
    { kind: 'activated', cost: { tap: true, life: 1 }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) },
    { kind: 'activated', cost: { mana: '{1}', tap: true, sacrificeSelf: true }, effect: drawCards(1) },
  ],
})

/** A tri-land (Shards/Khans): enters tapped, "{T}: Add {a}, {b}, or {c}." */
const triLand = (name: string, a: ManaColor, b: ManaColor, c: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  entersTapped: true,
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b, c], chooseColor: true, effect: addMana(a) }],
})

/** A Triome: a tri-land with three real basic land types and Cycling {3}. */
const triome = (name: string, a: ManaColor, b: ManaColor, c: ManaColor, subtypes: [string, string, string]): CardDefinition => ({
  name,
  types: ['Land'],
  subtypes,
  entersTapped: true,
  cyclingCost: '{3}',
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b, c], chooseColor: true, effect: addMana(a) }],
})

/** An artifact land: "{T}: Add {c}." — an Artifact AND a Land. */
const artifactLand = (name: string, c: ManaColor): CardDefinition => ({
  name,
  types: ['Artifact', 'Land'],
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [c], effect: addMana(c) }],
})

/** A Medallion: "[colour] spells you cast cost {1} less to cast." */
const medallion = (name: string, color: ManaColor): CardDefinition => ({
  name,
  types: ['Artifact'],
  manaCost: '{2}',
  spellCostReduction: { amount: 1, colors: [color] },
})

/** A Signet: "{1}, {T}: Add {a}{b}." — fixed dual-colour ramp + fixing (not a choice). */
const signet = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Artifact'],
  abilities: [{ kind: 'activated', cost: { tap: true, mana: '{1}' }, isMana: true, produces: [a, b], effect: addMana(a, b) }],
})

/** A creature mana dork: printed body + "{T}: Add …" (single colour, or a choice when produces>1). */
const manaDork = (
  name: string,
  manaCost: string,
  colors: ManaColor[],
  subtypes: string[],
  produces: ManaColor[],
  opts: { power?: number; toughness?: number; keywords?: Keyword[] } = {},
): CardDefinition => ({
  name,
  types: ['Creature'],
  subtypes,
  manaCost,
  colors,
  power: opts.power ?? 1,
  toughness: opts.toughness ?? 1,
  keywords: opts.keywords,
  // multi-colour dork (e.g. Birds) = a colour choice; a mono dork = fixed output
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces, chooseColor: produces.length > 1, effect: addMana(produces[0]!) }],
})

const vanilla = (
  name: string,
  manaCost: string,
  colors: ManaColor[],
  power: number,
  toughness: number,
  subtypes: string[],
): CardDefinition => ({ name, types: ['Creature'], subtypes, manaCost, colors, power, toughness })

/** French-vanilla creature: printed body + evergreen keywords only, no other text. */
const keyworded = (
  name: string,
  manaCost: string,
  colors: ManaColor[],
  power: number,
  toughness: number,
  subtypes: string[],
  keywords: Keyword[],
): CardDefinition => ({ name, types: ['Creature'], subtypes, manaCost, colors, power, toughness, keywords })

const legend = (
  name: string,
  manaCost: string,
  colors: ManaColor[],
  power: number,
  toughness: number,
  subtypes: string[],
): CardDefinition => ({
  name,
  types: ['Creature'],
  supertypes: ['Legendary'],
  subtypes,
  manaCost,
  colors,
  power,
  toughness,
})

export const STARTER_SET: CardDefinition[] = [
  basic('Plains', 'W', 'Plains'),
  basic('Island', 'U', 'Island'),
  basic('Swamp', 'B', 'Swamp'),
  basic('Mountain', 'R', 'Mountain'),
  basic('Forest', 'G', 'Forest'),

  // Guildgates (enters tapped, dual-colour) — mana fixing
  guildgate('Azorius Guildgate', 'W', 'U'),
  guildgate('Dimir Guildgate', 'U', 'B'),
  guildgate('Rakdos Guildgate', 'B', 'R'),
  guildgate('Gruul Guildgate', 'R', 'G'),
  guildgate('Selesnya Guildgate', 'G', 'W'),
  guildgate('Golgari Guildgate', 'B', 'G'),
  guildgate('Izzet Guildgate', 'U', 'R'),
  guildgate('Boros Guildgate', 'R', 'W'),
  guildgate('Simic Guildgate', 'G', 'U'),
  guildgate('Orzhov Guildgate', 'W', 'B'),

  // Scry Temples (enters tapped, ETB scry 1, dual-colour) — mana fixing + smoothing
  scryland('Temple of Enlightenment', 'W', 'U'),
  scryland('Temple of Deceit', 'U', 'B'),
  scryland('Temple of Malice', 'B', 'R'),
  scryland('Temple of Abandon', 'R', 'G'),
  scryland('Temple of Plenty', 'G', 'W'),
  scryland('Temple of Mystery', 'G', 'U'),
  scryland('Temple of Epiphany', 'U', 'R'),
  scryland('Temple of Malady', 'B', 'G'),
  scryland('Temple of Silence', 'W', 'B'),
  scryland('Temple of Triumph', 'R', 'W'),

  // Onslaught cycling lands (enters tapped, {T}: add one colour, Cycling {colour})
  cyclingLand('Secluded Steppe', 'W'),
  cyclingLand('Lonely Sandbar', 'U'),
  cyclingLand('Barren Moor', 'B'),
  cyclingLand('Forgotten Cave', 'R'),
  cyclingLand('Tranquil Thicket', 'G'),

  // --- Coverage batch B1: mana dorks/rock, efficient burn/removal, card draw ---
  manaDork('Birds of Paradise', '{G}', ['G'], ['Bird'], ['W', 'U', 'B', 'R', 'G'], { power: 0, toughness: 1, keywords: ['flying'] }),
  manaDork('Fyndhorn Elves', '{G}', ['G'], ['Elf', 'Druid'], ['G']),
  manaDork("Avacyn's Pilgrim", '{1}{W}', ['W'], ['Human', 'Monk'], ['W']),
  {
    name: 'Manalith',
    types: ['Artifact'],
    manaCost: '{3}',
    // "{T}: Add one mana of any colour."
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['W', 'U', 'B', 'R', 'G'], chooseColor: true, effect: addMana('W') }],
  },
  {
    name: 'Lightning Strike',
    types: ['Instant'],
    manaCost: '{1}{R}',
    colors: ['R'],
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamage(3) },
  },
  {
    name: 'Volcanic Hammer',
    types: ['Sorcery'],
    manaCost: '{1}{R}',
    colors: ['R'],
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamage(3) },
  },
  {
    name: 'Grasp of Darkness',
    types: ['Instant'],
    manaCost: '{B}{B}',
    colors: ['B'],
    // "Target creature gets -4/-4 until end of turn."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: pump(-4, -4) },
  },
  {
    name: 'Harmonize',
    types: ['Sorcery'],
    manaCost: '{2}{G}{G}',
    colors: ['G'],
    spell: { effect: drawCards(3) },
  },
  {
    name: 'Concentrate',
    types: ['Instant'],
    manaCost: '{2}{U}{U}',
    colors: ['U'],
    spell: { effect: drawCards(3) },
  },
  {
    name: "Ambition's Cost",
    types: ['Sorcery'],
    manaCost: '{2}{B}{B}',
    colors: ['B'],
    // "You draw three cards and you lose 3 life."
    spell: { effect: sequence(drawCards(3), loseLife(3)) },
  },
  {
    name: 'Ancient Craving',
    types: ['Sorcery'],
    manaCost: '{2}{B}{B}',
    colors: ['B'],
    // "You draw three cards and you lose 3 life."
    spell: { effect: sequence(drawCards(3), loseLife(3)) },
  },

  // --- Coverage batch B2: go-wide tokens, ETB/dies value, anthems/lords, aristocrat drains ---
  {
    name: 'Raise the Alarm',
    types: ['Instant'],
    manaCost: '{1}{W}',
    colors: ['W'],
    spell: { effect: createToken({ name: 'Soldier', power: 1, toughness: 1, subtypes: ['Soldier'] }, 2) },
  },
  {
    name: 'Midnight Haunting',
    types: ['Instant'],
    manaCost: '{2}{W}',
    colors: ['W'],
    spell: { effect: createToken({ name: 'Spirit', power: 1, toughness: 1, subtypes: ['Spirit'], keywords: ['flying'] }, 2) },
  },
  {
    name: 'Dragon Fodder',
    types: ['Sorcery'],
    manaCost: '{1}{R}',
    colors: ['R'],
    spell: { effect: createToken({ name: 'Goblin', power: 1, toughness: 1, subtypes: ['Goblin'] }, 2) },
  },
  {
    name: "Krenko's Command",
    types: ['Sorcery'],
    manaCost: '{1}{R}',
    colors: ['R'],
    spell: { effect: createToken({ name: 'Goblin', power: 1, toughness: 1, subtypes: ['Goblin'] }, 2) },
  },
  {
    name: 'Cloudblazer',
    types: ['Creature'],
    subtypes: ['Human', 'Scout'],
    manaCost: '{3}{W}{U}',
    colors: ['W', 'U'],
    power: 2,
    toughness: 2,
    keywords: ['flying'],
    // "When Cloudblazer enters, you draw two cards and you gain 2 life."
    enters: { effect: sequence(drawCards(2), gainLife(2)) },
  },
  {
    name: 'Wall of Blossoms',
    types: ['Creature'],
    subtypes: ['Plant', 'Wall'],
    manaCost: '{1}{G}',
    colors: ['G'],
    power: 0,
    toughness: 4,
    keywords: ['defender'],
    enters: { effect: drawCards(1) },
  },
  {
    name: 'Tukatongue Thallid',
    types: ['Creature'],
    subtypes: ['Fungus'],
    manaCost: '{G}',
    colors: ['G'],
    power: 1,
    toughness: 1,
    // "When Tukatongue Thallid dies, create a 1/1 green Saproling creature token."
    dies: { effect: createToken({ name: 'Saproling', power: 1, toughness: 1, subtypes: ['Saproling'] }) },
  },
  {
    name: "Gaea's Anthem",
    types: ['Enchantment'],
    manaCost: '{1}{G}{G}',
    colors: ['G'],
    statics: [{ affects: { controllerOnly: true }, power: 1, toughness: 1 }],
  },
  {
    name: 'Levitation',
    types: ['Enchantment'],
    manaCost: '{2}{U}',
    colors: ['U'],
    // "Creatures you control have flying."
    staticKeywords: [{ affects: { controllerOnly: true }, keywords: ['flying'] }],
  },
  {
    name: 'Goblin Chieftain',
    types: ['Creature'],
    subtypes: ['Goblin'],
    manaCost: '{1}{R}{R}',
    colors: ['R'],
    power: 2,
    toughness: 2,
    keywords: ['haste'], // "Goblin Chieftain has haste."
    // "Other Goblin creatures you control get +1/+1 and have haste."
    statics: [{ affects: { controllerOnly: true, excludeSelf: true, subtype: 'Goblin' }, power: 1, toughness: 1 }],
    staticKeywords: [{ affects: { controllerOnly: true, excludeSelf: true, subtype: 'Goblin' }, keywords: ['haste'] }],
  },
  {
    name: 'Field Marshal',
    types: ['Creature'],
    subtypes: ['Human', 'Soldier'],
    manaCost: '{1}{W}{W}',
    colors: ['W'],
    power: 2,
    toughness: 2,
    // "Other Soldier creatures you control get +1/+1 and have first strike."
    statics: [{ affects: { controllerOnly: true, excludeSelf: true, subtype: 'Soldier' }, power: 1, toughness: 1 }],
    staticKeywords: [{ affects: { controllerOnly: true, excludeSelf: true, subtype: 'Soldier' }, keywords: ['first strike'] }],
  },
  {
    name: 'Cruel Celebrant',
    types: ['Creature'],
    subtypes: ['Vampire'],
    manaCost: '{W}{B}',
    colors: ['W', 'B'],
    power: 1,
    toughness: 2,
    // "Whenever Cruel Celebrant or another creature you control dies, each opponent loses 1 life and you gain 1 life."
    dies: { watch: { scope: 'anyCreature', controllerOnly: true }, effect: sequence(eachOpponentLoses(1), gainLife(1)) },
  },
  {
    name: 'Bastion of Remembrance',
    types: ['Enchantment'],
    manaCost: '{2}{B}',
    colors: ['B'],
    // "When ~ enters, create a 1/1 white Human Soldier. Whenever a creature you control dies, each opponent loses 1 life and you gain 1 life."
    enters: { effect: createToken({ name: 'Soldier', power: 1, toughness: 1, subtypes: ['Human', 'Soldier'] }) },
    dies: { watch: { scope: 'anyCreature', controllerOnly: true }, effect: sequence(eachOpponentLoses(1), gainLife(1)) },
  },
  {
    name: "Soul's Attendant",
    types: ['Creature'],
    subtypes: ['Human', 'Cleric'],
    manaCost: '{W}',
    colors: ['W'],
    power: 1,
    toughness: 1,
    // "Whenever another creature enters, you gain 1 life."
    enters: { watch: { scope: 'anyCreature', excludeSelf: true }, effect: gainLife(1) },
  },
  {
    name: 'Impact Tremors',
    types: ['Enchantment'],
    manaCost: '{1}{R}',
    colors: ['R'],
    // "Whenever a creature you control enters, Impact Tremors deals 1 damage to each opponent."
    enters: { watch: { scope: 'anyCreature', controllerOnly: true }, effect: dealToEachOpponent(1) },
  },

  // --- Coverage batch B3: filtered / noncreature removal ---
  {
    name: 'Naturalize',
    types: ['Instant'],
    manaCost: '{1}{G}',
    colors: ['G'],
    // "Destroy target artifact or enchantment."
    spell: { targets: [{ kind: 'permanent', count: 1, filter: { types: ['Artifact', 'Enchantment'] } }], effect: destroyPermanent() },
  },
  {
    name: 'Disenchant',
    types: ['Instant'],
    manaCost: '{1}{W}',
    colors: ['W'],
    // "Destroy target artifact or enchantment."
    spell: { targets: [{ kind: 'permanent', count: 1, filter: { types: ['Artifact', 'Enchantment'] } }], effect: destroyPermanent() },
  },
  {
    name: 'Mortify',
    types: ['Instant'],
    manaCost: '{1}{W}{B}',
    colors: ['W', 'B'],
    // "Destroy target creature or enchantment."
    spell: { targets: [{ kind: 'permanent', count: 1, filter: { types: ['Creature', 'Enchantment'] } }], effect: destroyPermanent() },
  },
  {
    name: 'Putrefy',
    types: ['Instant'],
    manaCost: '{1}{B}{G}',
    colors: ['B', 'G'],
    // "Destroy target artifact or creature. It can't be regenerated." (no regen in engine)
    spell: { targets: [{ kind: 'permanent', count: 1, filter: { types: ['Artifact', 'Creature'] } }], effect: destroyPermanent() },
  },
  {
    name: 'Ravenous Chupacabra',
    types: ['Creature'],
    subtypes: ['Beast', 'Horror'],
    manaCost: '{2}{B}{B}',
    colors: ['B'],
    power: 2,
    toughness: 2,
    // "When Ravenous Chupacabra enters, destroy target creature an opponent controls."
    enters: { targets: [{ kind: 'creature', count: 1, filter: { controller: 'opponent' } }], effect: destroyTarget() },
  },

  // --- Coverage batch B7: exile removal ---
  {
    name: 'Swords to Plowshares',
    types: ['Instant'],
    manaCost: '{W}',
    colors: ['W'],
    // "Exile target creature. Its controller gains life equal to its power."
    spell: {
      targets: [{ kind: 'creature', count: 1 }],
      effect: sequence(gainLifeEqualToPowerForController(), exileTarget()),
    },
  },
  {
    name: 'Utter End',
    types: ['Instant'],
    manaCost: '{2}{W}{B}',
    colors: ['W', 'B'],
    // "Exile target nonland permanent."
    spell: { targets: [{ kind: 'permanent', count: 1, filter: { excludeTypes: ['Land'] } }], effect: exileTarget() },
  },
  {
    name: 'Anguished Unmaking',
    types: ['Instant'],
    manaCost: '{1}{W}{B}',
    colors: ['W', 'B'],
    // "Exile target nonland permanent. You lose 3 life."
    spell: {
      targets: [{ kind: 'permanent', count: 1, filter: { excludeTypes: ['Land'] } }],
      effect: sequence(exileTarget(), loseLife(3)),
    },
  },

  // --- Coverage batch B6: +1/+1 counters ---
  {
    name: 'Gird for Battle',
    types: ['Sorcery'],
    manaCost: '{W}',
    colors: ['W'],
    // "Put two +1/+1 counters on target creature you control."
    spell: {
      targets: [{ kind: 'creature', count: 1, filter: { controller: 'you' } }],
      effect: addCounters('+1/+1', 2),
    },
  },
  {
    name: 'Bond Beetle',
    types: ['Creature'],
    subtypes: ['Insect'],
    manaCost: '{G}',
    colors: ['G'],
    power: 0,
    toughness: 1,
    // "When Bond Beetle enters, put a +1/+1 counter on target creature you control."
    enters: {
      targets: [{ kind: 'creature', count: 1, filter: { controller: 'you' } }],
      effect: addCounters('+1/+1', 1),
    },
  },
  {
    name: "Cathars' Crusade",
    types: ['Enchantment'],
    manaCost: '{3}{W}{W}',
    colors: ['W'],
    // "Whenever a creature enters the battlefield under your control, put a +1/+1 counter on each creature you control."
    enters: { watch: { scope: 'anyCreature', controllerOnly: true }, effect: addCountersToEachControlled('+1/+1', 1) },
  },

  // --- Coverage batch B5: cost-bearing mana rocks (Signets) + colourless rocks ---
  signet('Azorius Signet', 'W', 'U'),
  signet('Dimir Signet', 'U', 'B'),
  signet('Rakdos Signet', 'B', 'R'),
  signet('Gruul Signet', 'R', 'G'),
  signet('Selesnya Signet', 'G', 'W'),
  signet('Golgari Signet', 'B', 'G'),
  signet('Izzet Signet', 'U', 'R'),
  signet('Boros Signet', 'R', 'W'),
  signet('Simic Signet', 'G', 'U'),
  signet('Orzhov Signet', 'W', 'B'),
  {
    name: 'Worn Powerstone',
    types: ['Artifact'],
    manaCost: '{3}',
    entersTapped: true,
    // "Worn Powerstone enters tapped. {T}: Add {C}{C}."
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C', 'C') }],
  },
  {
    name: 'Thran Dynamo',
    types: ['Artifact'],
    manaCost: '{4}',
    // "{T}: Add {C}{C}{C}."
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C', 'C', 'C') }],
  },

  // --- Coverage batch B8: bounce (return to hand) ---
  {
    name: 'Unsummon',
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Return target creature to its owner's hand."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: returnToHand() },
  },
  {
    name: 'Boomerang',
    types: ['Instant'],
    manaCost: '{U}{U}',
    colors: ['U'],
    // "Return target permanent to its owner's hand."
    spell: { targets: [{ kind: 'permanent', count: 1 }], effect: returnToHand() },
  },
  {
    name: "Man-o'-War",
    types: ['Creature'],
    subtypes: ['Jellyfish'],
    manaCost: '{2}{U}',
    colors: ['U'],
    power: 2,
    toughness: 2,
    // "When Man-o'-War enters, return target creature to its owner's hand."
    enters: { targets: [{ kind: 'creature', count: 1 }], effect: returnToHand() },
  },

  // --- Coverage batch B10: library search (ramp + tutors) ---
  {
    name: 'Rampant Growth',
    types: ['Sorcery'],
    manaCost: '{1}{G}',
    colors: ['G'],
    // "Search your library for a basic land card, put it onto the battlefield tapped, then shuffle."
    spell: { effect: searchLibrary({ filter: 'basicLand', dest: 'battlefield', tapped: true, count: 1 }) },
  },
  {
    name: 'Demonic Tutor',
    types: ['Sorcery'],
    manaCost: '{1}{B}',
    colors: ['B'],
    // "Search your library for a card, put that card into your hand, then shuffle."
    spell: { effect: searchLibrary({ filter: 'any', dest: 'hand', count: 1 }) },
  },
  {
    name: 'Diabolic Tutor',
    types: ['Sorcery'],
    manaCost: '{3}{B}',
    colors: ['B'],
    // "Search your library for a card, put that card into your hand, then shuffle."
    spell: { effect: searchLibrary({ filter: 'any', dest: 'hand', count: 1 }) },
  },
  {
    name: 'Solemn Simulacrum',
    types: ['Artifact', 'Creature'],
    subtypes: ['Golem'],
    manaCost: '{4}',
    power: 2,
    toughness: 2,
    // "When ~ enters, search for a basic land, put it onto the battlefield tapped, then shuffle."
    enters: { effect: searchLibrary({ filter: 'basicLand', dest: 'battlefield', tapped: true, count: 1 }) },
    // "When ~ dies, draw a card."
    dies: { effect: drawCards(1) },
  },

  // --- Coverage batch B4: sacrifice & edicts ---
  {
    name: 'Diabolic Edict',
    types: ['Instant'],
    manaCost: '{1}{B}',
    colors: ['B'],
    // "Target player sacrifices a creature." (that player chooses which)
    spell: { targets: [{ kind: 'player', count: 1 }], effect: playersSacrifice('target', 1) },
  },
  {
    name: 'Fleshbag Marauder',
    types: ['Creature'],
    subtypes: ['Zombie', 'Warrior'],
    manaCost: '{2}{B}',
    colors: ['B'],
    power: 2,
    toughness: 2,
    // "When Fleshbag Marauder enters, each player sacrifices a creature."
    enters: { effect: playersSacrifice('each', 1) },
  },
  {
    name: 'Viscera Seer',
    types: ['Creature'],
    subtypes: ['Vampire', 'Wizard'],
    manaCost: '{B}',
    colors: ['B'],
    power: 1,
    toughness: 1,
    // "Sacrifice a creature: Scry 1."
    abilities: [{ kind: 'activated', cost: { sacrifice: { count: 1, filter: 'creature' } }, effect: scry(1) }],
  },
  {
    name: 'Bloodthrone Vampire',
    types: ['Creature'],
    subtypes: ['Vampire'],
    manaCost: '{1}{B}',
    colors: ['B'],
    power: 1,
    toughness: 1,
    // "Sacrifice a creature: Bloodthrone Vampire gets +2/+2 until end of turn."
    abilities: [{ kind: 'activated', cost: { sacrifice: { count: 1, filter: 'creature' } }, effect: pumpSelf(2, 2) }],
  },

  // --- Coverage batch T: turn-based triggers (upkeep + attacks) ---
  {
    name: 'Phyrexian Arena',
    types: ['Enchantment'],
    manaCost: '{1}{B}{B}',
    colors: ['B'],
    // "At the beginning of your upkeep, you draw a card and you lose 1 life."
    upkeep: { effect: sequence(drawCards(1), loseLife(1)) },
  },
  {
    name: 'Bitterblossom',
    types: ['Enchantment'],
    subtypes: ['Faerie'],
    manaCost: '{1}{B}',
    colors: ['B'],
    // "At the beginning of your upkeep, you lose 1 life and create a 1/1 black Faerie Rogue creature token with flying."
    upkeep: {
      effect: sequence(
        loseLife(1),
        createToken({ name: 'Faerie Rogue', power: 1, toughness: 1, subtypes: ['Faerie', 'Rogue'], keywords: ['flying'] }, 1),
      ),
    },
  },
  {
    name: 'Borderland Marauder',
    types: ['Creature'],
    subtypes: ['Human', 'Warrior'],
    manaCost: '{1}{R}',
    colors: ['R'],
    power: 1,
    toughness: 2,
    // "Whenever this creature attacks, it gets +2/+0 until end of turn."
    attacks: { effect: pumpSelf(2, 0) },
  },
  {
    name: 'Vicious Conquistador',
    types: ['Creature'],
    subtypes: ['Vampire', 'Soldier'],
    manaCost: '{B}',
    colors: ['B'],
    power: 1,
    toughness: 2,
    // "Whenever this creature attacks, each opponent loses 1 life."
    attacks: { effect: eachOpponentLoses(1) },
  },
  {
    name: 'Audacious Thief',
    types: ['Creature'],
    subtypes: ['Human', 'Rogue'],
    manaCost: '{2}{B}',
    colors: ['B'],
    power: 2,
    toughness: 2,
    // "Whenever this creature attacks, you draw a card and you lose 1 life."
    attacks: { effect: sequence(drawCards(1), loseLife(1)) },
  },

  // --- Coverage batch AE: Auras & Equipment (attach → static grant to the host) ---
  {
    name: 'Unholy Strength',
    types: ['Enchantment'],
    subtypes: ['Aura'],
    manaCost: '{B}',
    colors: ['B'],
    // "Enchant creature. Enchanted creature gets +2/+1."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: sequence() },
    grantsToHost: { power: 2, toughness: 1 },
  },
  {
    name: 'Holy Strength',
    types: ['Enchantment'],
    subtypes: ['Aura'],
    manaCost: '{W}',
    colors: ['W'],
    // "Enchant creature. Enchanted creature gets +1/+2."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: sequence() },
    grantsToHost: { power: 1, toughness: 2 },
  },
  {
    name: 'Angelic Gift',
    types: ['Enchantment'],
    subtypes: ['Aura'],
    manaCost: '{1}{W}',
    colors: ['W'],
    // "Enchant creature. When this Aura enters, draw a card. Enchanted creature has flying."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: sequence() },
    enters: { effect: drawCards(1) },
    grantsToHost: { keywords: ['flying'] },
  },
  {
    name: 'Pacifism',
    types: ['Enchantment'],
    subtypes: ['Aura'],
    manaCost: '{1}{W}',
    colors: ['W'],
    // "Enchant creature. Enchanted creature can't attack or block."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: sequence() },
    grantsToHost: { cantAttack: true, cantBlock: true },
  },
  {
    name: 'Bonesplitter',
    types: ['Artifact'],
    subtypes: ['Equipment'],
    manaCost: '{1}',
    // "Equipped creature gets +2/+0. Equip {1}"
    equipCost: '{1}',
    grantsToHost: { power: 2, toughness: 0 },
  },
  {
    name: 'Vulshok Morningstar',
    types: ['Artifact'],
    subtypes: ['Equipment'],
    manaCost: '{2}',
    // "Equipped creature gets +2/+2. Equip {2}"
    equipCost: '{2}',
    grantsToHost: { power: 2, toughness: 2 },
  },
  {
    name: 'Loxodon Warhammer',
    types: ['Artifact'],
    subtypes: ['Equipment'],
    manaCost: '{3}',
    // "Equipped creature gets +3/+0 and has trample and lifelink. Equip {3}"
    equipCost: '{3}',
    grantsToHost: { power: 3, toughness: 0, keywords: ['trample', 'lifelink'] },
  },
  {
    name: 'Sword of Vengeance',
    types: ['Artifact'],
    subtypes: ['Equipment'],
    manaCost: '{3}',
    // "Equipped creature gets +2/+0 and has first strike, vigilance, trample, and haste. Equip {3}"
    equipCost: '{3}',
    grantsToHost: { power: 2, toughness: 0, keywords: ['first strike', 'vigilance', 'trample', 'haste'] },
  },

  // --- Coverage batch MX: X spells + modal ("choose one") ---
  {
    name: 'Blaze',
    types: ['Sorcery'],
    manaCost: '{X}{R}',
    colors: ['R'],
    // "Blaze deals X damage to any target."
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamageX() },
  },
  {
    name: 'Mind Spring',
    types: ['Sorcery'],
    manaCost: '{X}{U}{U}',
    colors: ['U'],
    // "Draw X cards."
    spell: { effect: drawCardsX() },
  },
  {
    name: "Sphinx's Revelation",
    types: ['Instant'],
    manaCost: '{X}{W}{U}{U}',
    colors: ['W', 'U'],
    // "You gain X life and draw X cards."
    spell: { effect: sequence(gainLifeX(), drawCardsX()) },
  },
  {
    name: 'Earthquake',
    types: ['Sorcery'],
    manaCost: '{X}{R}',
    colors: ['R'],
    // "Earthquake deals X damage to each creature without flying and each player."
    spell: { effect: earthquakeX() },
  },
  {
    name: 'Abrade',
    types: ['Instant'],
    manaCost: '{1}{R}',
    colors: ['R'],
    // "Choose one — • deals 3 damage to target creature. • Destroy target artifact."
    modes: [
      { label: 'Deal 3 damage to target creature', targets: [{ kind: 'creature', count: 1 }], effect: dealDamage(3) },
      { label: 'Destroy target artifact', targets: [{ kind: 'permanent', count: 1, filter: { types: ['Artifact'] } }], effect: destroyPermanent() },
    ],
  },

  // --- Coverage batch SUB2: granted protection (layer-6 protection-from-colour grant) ---
  {
    name: 'Gods Willing',
    types: ['Instant'],
    manaCost: '{W}',
    colors: ['W'],
    // "Target creature you control gains protection from the color of your choice until end of turn. Scry 1."
    // Modelled as 5 modes (one per colour) — reuses the modal mode-picker for the colour choice.
    modes: (['W', 'U', 'B', 'R', 'G'] as ManaColor[]).map((color) => ({
      label: `Protection from ${({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' } as const)[color]}`,
      targets: [{ kind: 'creature' as const, count: 1, filter: { controller: 'you' as const } }],
      effect: sequence(grantProtection([color]), scry(1)),
    })),
  },

  // --- Coverage batch GY: graveyard recursion (return to hand) ---
  {
    name: 'Raise Dead',
    types: ['Sorcery'],
    manaCost: '{B}',
    colors: ['B'],
    // "Return target creature card from your graveyard to your hand."
    spell: { targets: [{ kind: 'graveyardCard', count: 1, filter: { controller: 'you', types: ['Creature'] } }], effect: returnFromGraveyard() },
  },
  {
    name: 'Regrowth',
    types: ['Sorcery'],
    manaCost: '{1}{G}',
    colors: ['G'],
    // "Return target card from your graveyard to your hand."
    spell: { targets: [{ kind: 'graveyardCard', count: 1, filter: { controller: 'you' } }], effect: returnFromGraveyard() },
  },

  // --- Coverage batch KIK: kicker (optional additional cost → more/different effect) ---
  {
    name: 'Burst Lightning',
    types: ['Instant'],
    manaCost: '{R}',
    colors: ['R'],
    kickerCost: '{4}',
    // "Deals 2 damage to any target. If kicked, it deals 4 damage instead."
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamageKicked(2, 4) },
  },
  {
    name: 'Marsh Casualties',
    types: ['Sorcery'],
    manaCost: '{B}{B}',
    colors: ['B'],
    kickerCost: '{3}',
    // "Creatures target player controls get -1/-1 until end of turn. If kicked, -2/-2 instead."
    spell: { targets: [{ kind: 'player', count: 1 }], effect: weakenControlledCreatures(1, 2) },
  },

  // --- Coverage batch BR: recognizable staples via existing primitives ---
  {
    name: "Hero's Downfall",
    types: ['Instant'],
    manaCost: '{1}{B}{B}',
    colors: ['B'],
    // "Destroy target creature or planeswalker."
    spell: { targets: [{ kind: 'permanent', count: 1, filter: { types: ['Creature', 'Planeswalker'] } }], effect: destroyPermanent() },
  },
  // (Night's Whisper and Flametongue Kavu already exist earlier in the pool — not re-added here)
  {
    name: 'Acidic Slime',
    types: ['Creature'],
    subtypes: ['Ooze'],
    manaCost: '{3}{G}{G}',
    colors: ['G'],
    power: 2,
    toughness: 2,
    keywords: ['deathtouch'],
    // "When this creature enters, destroy target artifact, enchantment, or land."
    enters: { targets: [{ kind: 'permanent', count: 1, filter: { types: ['Artifact', 'Enchantment', 'Land'] } }], effect: destroyPermanent() },
  },
  {
    name: 'Flame Rift',
    types: ['Sorcery'],
    manaCost: '{1}{R}',
    colors: ['R'],
    // "Flame Rift deals 4 damage to each player." (symmetric — hits you too)
    spell: { effect: dealToEachPlayer(4) },
  },
  {
    name: 'Languish',
    types: ['Sorcery'],
    manaCost: '{2}{B}{B}',
    colors: ['B'],
    // "All creatures get -4/-4 until end of turn."
    spell: { effect: weakenAllCreatures(4) },
  },

  // --- Coverage batch MILL: mill (top of library → graveyard) ---
  {
    name: 'Tome Scour',
    types: ['Sorcery'],
    manaCost: '{U}',
    colors: ['U'],
    // "Target player mills five cards."
    spell: { targets: [{ kind: 'player', count: 1 }], effect: mill(5) },
  },
  {
    name: 'Mind Sculpt',
    types: ['Sorcery'],
    manaCost: '{1}{U}',
    colors: ['U'],
    // "Target opponent mills seven cards."
    spell: { targets: [{ kind: 'player', count: 1, filter: { controller: 'opponent' } }], effect: mill(7) },
  },
  {
    name: 'Thought Scour',
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Target player mills two cards. Draw a card."
    spell: { targets: [{ kind: 'player', count: 1 }], effect: sequence(mill(2), drawCards(1)) },
  },

  // --- Coverage batch DSC: forced discard (target / each player) ---
  {
    name: 'Mind Rot',
    types: ['Sorcery'],
    manaCost: '{2}{B}',
    colors: ['B'],
    // "Target player discards two cards."
    spell: { targets: [{ kind: 'player', count: 1 }], effect: playersDiscard('target', 2) },
  },
  {
    name: 'Ravenous Rats',
    types: ['Creature'],
    subtypes: ['Rat'],
    manaCost: '{1}{B}',
    colors: ['B'],
    power: 1,
    toughness: 1,
    // "When Ravenous Rats enters, target opponent discards a card."
    enters: { targets: [{ kind: 'player', count: 1, filter: { controller: 'opponent' } }], effect: playersDiscard('target', 1) },
  },

  // --- Coverage batch FC: fight + enters-with-counters ---
  {
    name: 'Pounce',
    types: ['Instant'],
    manaCost: '{1}{G}',
    colors: ['G'],
    // "Target creature you control fights target creature you don't control."
    spell: {
      targets: [
        { kind: 'creature', count: 1, filter: { controller: 'you' } },
        { kind: 'creature', count: 1, filter: { controller: 'opponent' } },
      ],
      effect: fight(),
    },
  },
  {
    name: 'Prey Upon',
    types: ['Sorcery'],
    manaCost: '{G}',
    colors: ['G'],
    // "Target creature you control fights target creature you don't control."
    spell: {
      targets: [
        { kind: 'creature', count: 1, filter: { controller: 'you' } },
        { kind: 'creature', count: 1, filter: { controller: 'opponent' } },
      ],
      effect: fight(),
    },
  },
  {
    name: 'Faithful Watchdog',
    types: ['Creature'],
    subtypes: ['Dog'],
    manaCost: '{G}{W}',
    colors: ['G', 'W'],
    power: 0,
    toughness: 0,
    keywords: ['vigilance'],
    // "This creature enters with three +1/+1 counters on it." (a 0/0 → 3/3)
    entersWithCounters: 3,
  },

  // --- Coverage batch PW: planeswalkers (loyalty core; attackability + emblems deferred) ---
  {
    name: 'Nissa, Voice of Zendikar',
    types: ['Planeswalker'],
    supertypes: ['Legendary'],
    subtypes: ['Nissa'],
    manaCost: '{1}{G}{G}',
    colors: ['G'],
    loyalty: 3,
    loyaltyAbilities: [
      // [+1]: Create a 0/1 green Plant creature token.
      { cost: 1, effect: createToken({ name: 'Plant', power: 0, toughness: 1, subtypes: ['Plant'] }, 1) },
      // [−2]: Put a +1/+1 counter on each creature you control.
      { cost: -2, effect: addCountersToEachControlled('+1/+1', 1) },
      // [−7]: You gain X life and draw X cards, where X is the number of lands you control.
      { cost: -7, effect: gainAndDrawEqualToLands() },
    ],
  },
  {
    name: 'Ajani, the Greathearted',
    types: ['Planeswalker'],
    supertypes: ['Legendary'],
    subtypes: ['Ajani'],
    manaCost: '{2}{G}{W}',
    colors: ['G', 'W'],
    loyalty: 5,
    // "Creatures you control have vigilance."
    staticKeywords: [{ affects: { controllerOnly: true }, keywords: ['vigilance'] }],
    loyaltyAbilities: [
      // [+1]: You gain 3 life.
      { cost: 1, effect: gainLife(3) },
      // [−2]: +1/+1 counter on each creature you control and a loyalty counter on each other planeswalker you control.
      { cost: -2, effect: sequence(addCountersToEachControlled('+1/+1', 1), addLoyaltyToOtherPlaneswalkers(1)) },
    ],
  },

  vanilla('Savannah Lions', '{W}', ['W'], 2, 1, ['Cat']),
  vanilla('Merfolk of the Pearl Trident', '{U}', ['U'], 1, 1, ['Merfolk']),
  vanilla('Grizzly Bears', '{1}{G}', ['G'], 2, 2, ['Bear']),
  vanilla('Gray Ogre', '{2}{R}', ['R'], 2, 2, ['Ogre']),
  vanilla('Hill Giant', '{3}{R}', ['R'], 3, 3, ['Giant']),
  vanilla('Centaur Courser', '{2}{G}', ['G'], 3, 3, ['Centaur', 'Warrior']),

  // French-vanilla creatures exercising each evergreen combat keyword (M-R1)
  keyworded('Wind Drake', '{2}{U}', ['U'], 2, 2, ['Drake'], ['flying']),
  keyworded('Serra Angel', '{3}{W}{W}', ['W'], 4, 4, ['Angel'], ['flying', 'vigilance']),
  keyworded('Youthful Knight', '{1}{W}', ['W'], 2, 2, ['Human', 'Knight'], ['first strike']),
  keyworded('Fencing Ace', '{1}{W}', ['W'], 1, 1, ['Human', 'Soldier'], ['double strike']),
  keyworded('Giant Spider', '{3}{G}', ['G'], 2, 4, ['Spider'], ['reach']),
  keyworded('Vampire Nighthawk', '{1}{B}{B}', ['B'], 2, 3, ['Vampire', 'Shaman'], ['flying', 'deathtouch', 'lifelink']),
  keyworded('Colossal Dreadmaw', '{4}{G}{G}', ['G'], 6, 6, ['Dinosaur'], ['trample']),
  keyworded('Boggart Brute', '{2}{B}', ['B'], 3, 2, ['Goblin', 'Warrior'], ['menace']),
  keyworded('Raging Goblin', '{R}', ['R'], 1, 1, ['Goblin', 'Berserker'], ['haste']),
  keyworded('Wall of Wood', '{G}', ['G'], 0, 3, ['Wall'], ['defender']),

  // vanilla legendary creatures — the starter commanders
  legend('Isamaru, Hound of Konda', '{W}', ['W'], 2, 2, ['Dog']),
  legend('Torsten Von Ursus', '{3}{W}{W}', ['W'], 5, 5, ['Human', 'Soldier']),
  legend('Jedit Ojanen', '{4}{W}{U}', ['W', 'U'], 5, 5, ['Cat', 'Warrior']),
  legend('Jerrard of the Closed Fist', '{4}{R}{R}', ['R'], 6, 5, ['Human', 'Knight']),
  legend('Barktooth Warbeard', '{4}{B}{R}', ['B', 'R'], 6, 5, ['Human', 'Warrior']),
  legend('Marhault Elsdragon', '{3}{R}{G}', ['R', 'G'], 4, 6, ['Elf', 'Warrior']),

  {
    name: 'Shock',
    types: ['Instant'],
    manaCost: '{R}',
    colors: ['R'],
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamage(2) },
  },
  {
    name: 'Lightning Bolt',
    types: ['Instant'],
    manaCost: '{R}',
    colors: ['R'],
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamage(3) },
  },
  {
    name: 'Flame Slash',
    types: ['Sorcery'],
    manaCost: '{R}',
    colors: ['R'],
    // "Flame Slash deals 4 damage to target creature."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: dealDamage(4) },
  },
  {
    name: 'Pyroclasm',
    types: ['Sorcery'],
    manaCost: '{1}{R}',
    colors: ['R'],
    // "Pyroclasm deals 2 damage to each creature."
    spell: { effect: damageAllCreatures(2) },
  },
  {
    name: 'Char',
    types: ['Instant'],
    manaCost: '{1}{R}{R}',
    colors: ['R'],
    // "Char deals 3 damage to any target and 1 damage to you."
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: sequence(dealDamage(3), loseLife(1)) },
  },
  {
    name: 'Murder',
    types: ['Instant'],
    manaCost: '{1}{B}{B}',
    colors: ['B'],
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: destroyTarget() },
  },
  {
    name: 'Vindicate',
    types: ['Sorcery'],
    manaCost: '{W}{B}{B}',
    colors: ['W', 'B'],
    // "Destroy target permanent."
    spell: { targets: [{ kind: 'permanent', count: 1 }], effect: destroyPermanent() },
  },
  {
    name: 'Beast Within',
    types: ['Instant'],
    manaCost: '{2}{G}',
    colors: ['G'],
    // "Destroy target permanent. Its controller creates a 3/3 green Beast creature token."
    spell: {
      targets: [{ kind: 'permanent', count: 1 }],
      effect: destroyPermanentGrantToken({ name: 'Beast', power: 3, toughness: 3, subtypes: ['Beast'] }),
    },
  },
  {
    name: 'Generous Gift',
    types: ['Instant'],
    manaCost: '{2}{W}',
    colors: ['W'],
    // "Destroy target permanent. Its controller creates a 3/3 Elephant creature token."
    spell: {
      targets: [{ kind: 'permanent', count: 1 }],
      effect: destroyPermanentGrantToken({ name: 'Elephant', power: 3, toughness: 3, subtypes: ['Elephant'] }),
    },
  },
  {
    name: 'Disfigure',
    types: ['Instant'],
    manaCost: '{B}',
    colors: ['B'],
    // "Target creature gets -2/-2 until end of turn." (pump with negatives → SBA can kill it)
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: pump(-2, -2) },
  },
  {
    name: 'Mulldrifter',
    types: ['Creature'],
    subtypes: ['Elemental'],
    manaCost: '{4}{U}',
    colors: ['U'],
    power: 2,
    toughness: 2,
    keywords: ['flying'],
    evokeCost: '{2}{U}', // Evoke (CR 702.74) — cast for {2}{U}, sacrificed on enter (batch MECH11)
    enters: { effect: drawCards(2) },
  },
  {
    name: 'Counterspell',
    types: ['Instant'],
    manaCost: '{U}{U}',
    colors: ['U'],
    // "Counter target spell."
    spell: { targets: [{ kind: 'spell', count: 1 }], effect: counterTarget() },
  },
  {
    name: 'Ovinize',
    types: ['Instant'],
    manaCost: '{1}{U}',
    colors: ['U'],
    // "Until end of turn, target creature loses all abilities and has base power and toughness 0/1."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: sequence(setBasePT(0, 1), loseAllAbilities()) },
  },
  {
    name: 'Divination',
    types: ['Sorcery'],
    manaCost: '{2}{U}',
    colors: ['U'],
    spell: { effect: drawCards(2) },
  },
  {
    name: 'Revitalize',
    types: ['Instant'],
    manaCost: '{1}{W}',
    colors: ['W'],
    spell: { effect: sequence(gainLife(3), drawCards(1)) },
  },
  {
    name: 'Giant Growth',
    types: ['Instant'],
    manaCost: '{G}',
    colors: ['G'],
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: pump(3, 3) },
  },
  {
    name: 'Titanic Growth',
    types: ['Instant'],
    manaCost: '{2}{G}',
    colors: ['G'],
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: pump(4, 4) },
  },
  {
    name: 'Lightning Helix',
    types: ['Instant'],
    manaCost: '{R}{W}',
    colors: ['R', 'W'],
    // "Lightning Helix deals 3 damage to any target. You gain 3 life."
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: sequence(dealDamage(3), gainLife(3)) },
  },

  // static anthem (CR 613 layer 7c) — a noncreature permanent that buffs your team
  {
    name: 'Glorious Anthem',
    types: ['Enchantment'],
    manaCost: '{1}{W}{W}',
    colors: ['W'],
    statics: [{ affects: { controllerOnly: true }, power: 1, toughness: 1 }],
  },
  // static keyword grant (CR 613 layer 6) — "Creatures you control have haste."
  {
    name: 'Fervor',
    types: ['Enchantment'],
    manaCost: '{2}{R}',
    colors: ['R'],
    staticKeywords: [{ affects: { controllerOnly: true }, keywords: ['haste'] }],
  },

  // enters-the-battlefield triggered abilities (CR 603) — non-targeted
  {
    name: 'Elvish Visionary',
    types: ['Creature'],
    subtypes: ['Elf', 'Shaman'],
    manaCost: '{1}{G}',
    colors: ['G'],
    power: 1,
    toughness: 1,
    enters: { effect: drawCards(1) },
  },
  {
    name: 'Wall of Omens',
    types: ['Creature'],
    subtypes: ['Wall'],
    manaCost: '{1}{W}',
    colors: ['W'],
    power: 0,
    toughness: 4,
    keywords: ['defender'],
    enters: { effect: drawCards(1) },
  },
  {
    name: 'Angel of Mercy',
    types: ['Creature'],
    subtypes: ['Angel'],
    manaCost: '{4}{W}',
    colors: ['W'],
    power: 3,
    toughness: 3,
    keywords: ['flying'],
    enters: { effect: gainLife(3) }, // ETB + a keyword together
  },
  {
    name: 'Soul Warden',
    types: ['Creature'],
    subtypes: ['Human', 'Cleric'],
    manaCost: '{W}',
    colors: ['W'],
    power: 1,
    toughness: 1,
    // "Whenever another creature enters the battlefield, you gain 1 life." (watches others)
    enters: { watch: { scope: 'anyCreature', excludeSelf: true }, effect: gainLife(1) },
  },
  {
    name: 'Flametongue Kavu',
    types: ['Creature'],
    subtypes: ['Kavu'],
    manaCost: '{3}{R}',
    colors: ['R'],
    power: 4,
    toughness: 2,
    // targeted ETB (CR 603): "deals 4 damage to target creature"
    enters: { targets: [{ kind: 'creature', count: 1 }], effect: dealDamage(4) },
  },
  {
    name: 'Doomed Traveler',
    types: ['Creature'],
    subtypes: ['Human', 'Soldier'],
    manaCost: '{W}',
    colors: ['W'],
    power: 1,
    toughness: 1,
    // death trigger (CR 603): "When Doomed Traveler dies, create a 1/1 white Spirit with flying."
    dies: { effect: createToken({ name: 'Spirit', power: 1, toughness: 1, subtypes: ['Spirit'], keywords: ['flying'] }) },
  },
  {
    name: 'Zulaport Cutthroat',
    types: ['Creature'],
    subtypes: ['Human', 'Cleric'],
    manaCost: '{1}{B}',
    colors: ['B'],
    power: 1,
    toughness: 1,
    // "Whenever Zulaport Cutthroat or another creature you control dies, each
    // opponent loses 1 life and you gain 1 life." (watches your creatures, incl. self)
    dies: { watch: { scope: 'anyCreature', controllerOnly: true }, effect: sequence(eachOpponentLoses(1), gainLife(1)) },
  },

  // activated abilities (CR 602)
  {
    name: 'Prodigal Sorcerer',
    types: ['Creature'],
    subtypes: ['Human', 'Wizard'],
    manaCost: '{2}{U}',
    colors: ['U'],
    power: 1,
    toughness: 1,
    // "{T}: Prodigal Sorcerer deals 1 damage to any target."
    abilities: [{ kind: 'activated', cost: { tap: true }, targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamage(1) }],
  },
  {
    name: 'Jayemdae Tome',
    types: ['Artifact'],
    manaCost: '{4}',
    // "{4}, {T}: Draw a card."
    abilities: [{ kind: 'activated', cost: { tap: true, mana: '{4}' }, effect: drawCards(1) }],
  },

  // mana dorks — creatures with a {T} mana ability (respect summoning sickness)
  {
    name: 'Llanowar Elves',
    types: ['Creature'],
    subtypes: ['Elf', 'Druid'],
    manaCost: '{G}',
    colors: ['G'],
    power: 1,
    toughness: 1,
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['G'], effect: addMana('G') }],
  },
  {
    name: 'Elvish Mystic',
    types: ['Creature'],
    subtypes: ['Elf', 'Druid'],
    manaCost: '{G}',
    colors: ['G'],
    power: 1,
    toughness: 1,
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['G'], effect: addMana('G') }],
  },
  {
    name: 'Shivan Dragon',
    types: ['Creature'],
    subtypes: ['Dragon'],
    manaCost: '{4}{R}{R}',
    colors: ['R'],
    power: 5,
    toughness: 5,
    keywords: ['flying'],
    // firebreathing: "{R}: Shivan Dragon gets +1/+0 until end of turn."
    abilities: [{ kind: 'activated', cost: { mana: '{R}' }, effect: pumpSelf(1, 0) }],
  },
  {
    name: "Night's Whisper",
    types: ['Sorcery'],
    manaCost: '{1}{B}',
    colors: ['B'],
    // "You draw two cards and you lose 2 life."
    spell: { effect: sequence(drawCards(2), loseLife(2)) },
  },

  // non-combat keywords
  {
    name: 'Darksteel Myr',
    types: ['Artifact', 'Creature'],
    subtypes: ['Myr'],
    manaCost: '{1}',
    power: 0,
    toughness: 1,
    keywords: ['indestructible'],
  },
  keyworded('Ambush Viper', '{1}{G}', ['G'], 2, 1, ['Snake'], ['flash', 'deathtouch']),
  keyworded('Gladecover Scout', '{G}', ['G'], 1, 1, ['Elf', 'Scout'], ['hexproof']),

  // mana rock — "{T}: Add {C}{C}."
  {
    name: 'Sol Ring',
    types: ['Artifact'],
    manaCost: '{1}',
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C', 'C') }],
  },
  {
    name: 'Crystal Ball',
    types: ['Artifact'],
    manaCost: '{2}',
    // "{1}, {T}: Scry 2."
    abilities: [{ kind: 'activated', cost: { tap: true, mana: '{1}' }, effect: scry(2) }],
  },
  // more flyers / bodies for the pool
  keyworded('Air Elemental', '{3}{U}{U}', ['U'], 4, 4, ['Elemental'], ['flying']),
  keyworded('Mahamoti Djinn', '{4}{U}{U}', ['U'], 5, 6, ['Djinn'], ['flying']),
  vanilla('Craw Wurm', '{4}{G}{G}', ['G'], 6, 4, ['Wurm']),

  // board wipes (destroy all creatures)
  {
    name: 'Wrath of God',
    types: ['Sorcery'],
    manaCost: '{2}{W}{W}',
    colors: ['W'],
    spell: { effect: destroyAllCreatures() },
  },
  {
    name: 'Day of Judgment',
    types: ['Sorcery'],
    manaCost: '{2}{W}{W}',
    colors: ['W'],
    spell: { effect: destroyAllCreatures() },
  },
  {
    name: 'Damnation',
    types: ['Sorcery'],
    manaCost: '{2}{B}{B}',
    colors: ['B'],
    // "Destroy all creatures. They can't be regenerated." (regeneration isn't modeled → vacuous, as on Wrath of God)
    spell: { effect: destroyAllCreatures() },
  },

  // --- Coverage batch BR2: more removal staples (existing primitives) ---
  {
    name: 'Terminate',
    types: ['Instant'],
    manaCost: '{B}{R}',
    colors: ['B', 'R'],
    // "Destroy target creature. It can't be regenerated."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: destroyPermanent() },
  },
  {
    name: 'Go for the Throat',
    types: ['Instant'],
    manaCost: '{1}{B}',
    colors: ['B'],
    // "Destroy target nonartifact creature."
    spell: { targets: [{ kind: 'creature', count: 1, filter: { excludeTypes: ['Artifact'] } }], effect: destroyPermanent() },
  },
  {
    name: 'Pongify',
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Destroy target creature. Its controller creates a 3/3 green Ape creature token."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: destroyPermanentGrantToken({ name: 'Ape', power: 3, toughness: 3, subtypes: ['Ape'] }) },
  },
  {
    name: 'Rapid Hybridization',
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Destroy target creature. That creature's controller creates a 3/3 green Frog Lizard creature token."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: destroyPermanentGrantToken({ name: 'Frog Lizard', power: 3, toughness: 3, subtypes: ['Frog', 'Lizard'] }) },
  },

  // --- Coverage batch WARD: ward (counter a targeting spell/ability unless you pay) ---
  {
    name: 'Tomakul Honor Guard',
    types: ['Creature'],
    subtypes: ['Human', 'Soldier'],
    manaCost: '{1}{G}',
    colors: ['G'],
    power: 3,
    toughness: 1,
    ward: '{2}',
  },
  {
    name: 'Waterfall Aerialist',
    types: ['Creature'],
    subtypes: ['Djinn', 'Wizard'],
    manaCost: '{3}{U}',
    colors: ['U'],
    power: 3,
    toughness: 1,
    keywords: ['flying'],
    ward: '{2}',
  },

  // --- Coverage batch BR3: a cantrip flyer (Serra Angel / Vampire Nighthawk / Colossal
  // Dreadmaw already exist above, so only Cloudkin Seer is new here) ---
  {
    name: 'Cloudkin Seer',
    types: ['Creature'],
    subtypes: ['Elemental', 'Wizard'],
    manaCost: '{2}{U}',
    colors: ['U'],
    power: 2,
    toughness: 1,
    keywords: ['flying'],
    // "When this creature enters, draw a card."
    enters: { effect: drawCards(1) },
  },

  // --- Coverage batch CASCADE: cascade (CR 702.85) ---
  {
    name: 'Shardless Agent',
    types: ['Artifact', 'Creature'],
    subtypes: ['Human', 'Rogue'],
    manaCost: '{1}{G}{U}',
    colors: ['G', 'U'],
    power: 2,
    toughness: 2,
    cascade: true,
  },
  {
    name: 'Bloodbraid Elf',
    types: ['Creature'],
    subtypes: ['Elf', 'Berserker'],
    manaCost: '{2}{R}{G}',
    colors: ['R', 'G'],
    power: 3,
    toughness: 2,
    keywords: ['haste'],
    cascade: true,
  },

  // --- Coverage batch KW1: evasion keywords (block restrictions) ---
  keyworded('Prickly Boggart', '{B}', ['B'], 1, 1, ['Goblin', 'Rogue'], ['fear']),
  keyworded("Krenko's Enforcer", '{1}{R}{R}', ['R'], 2, 2, ['Goblin', 'Rogue'], ['intimidate']),
  keyworded('Vampire Cutthroat', '{B}', ['B'], 1, 1, ['Vampire', 'Rogue'], ['skulk', 'lifelink']),
  keyworded('Soltari Foot Soldier', '{W}', ['W'], 1, 1, ['Soltari', 'Soldier'], ['shadow']),
  keyworded('Pale Bears', '{2}{G}', ['G'], 2, 2, ['Bear'], ['islandwalk']),
  keyworded('Marsh Boa', '{G}', ['G'], 1, 1, ['Snake'], ['swampwalk']),

  // --- Coverage batch KW2: protection from [colour] (CR 702.16, the DEBT rule) ---
  {
    name: 'White Knight',
    types: ['Creature'],
    subtypes: ['Human', 'Knight'],
    manaCost: '{W}{W}',
    colors: ['W'],
    power: 2,
    toughness: 2,
    keywords: ['first strike'],
    protectionFrom: ['B'],
  },
  {
    name: 'Black Knight',
    types: ['Creature'],
    subtypes: ['Human', 'Knight'],
    manaCost: '{B}{B}',
    colors: ['B'],
    power: 2,
    toughness: 2,
    keywords: ['first strike'],
    protectionFrom: ['W'],
  },
  {
    name: 'Paladin en-Vec',
    types: ['Creature'],
    subtypes: ['Human', 'Knight'],
    manaCost: '{1}{W}{W}',
    colors: ['W'],
    power: 2,
    toughness: 2,
    keywords: ['first strike'],
    protectionFrom: ['B', 'R'],
  },

  // --- Coverage batch KW3: shroud + prowess ---
  keyworded('Elvish Lookout', '{G}', ['G'], 1, 1, ['Elf'], ['shroud']),
  keyworded('Pincher Beetles', '{2}{G}', ['G'], 3, 1, ['Insect'], ['shroud']),
  keyworded('Monastery Swiftspear', '{R}', ['R'], 1, 2, ['Human', 'Monk'], ['haste', 'prowess']),

  // --- Coverage batch KW4: persist + undying (dies → return with a counter) ---
  keyworded('Young Wolf', '{G}', ['G'], 1, 1, ['Wolf'], ['undying']),
  keyworded('Strangleroot Geist', '{G}{G}', ['G'], 2, 1, ['Spirit'], ['haste', 'undying']),
  keyworded('Putrid Goblin', '{1}{B}', ['B'], 2, 2, ['Zombie', 'Goblin'], ['persist']),
  keyworded('Lingering Tormentor', '{3}{B}', ['B'], 2, 2, ['Zombie'], ['fear', 'persist']),

  // --- Coverage batch KW5: exalted, flanking, battle cry (combat-trigger keywords) ---
  {
    name: 'Knight of Glory',
    types: ['Creature'],
    subtypes: ['Human', 'Knight'],
    manaCost: '{1}{W}',
    colors: ['W'],
    power: 2,
    toughness: 1,
    keywords: ['exalted'],
    protectionFrom: ['B'],
  },
  keyworded('Benalish Cavalry', '{1}{W}', ['W'], 2, 2, ['Human', 'Knight'], ['flanking']),
  keyworded('Accorder Paladin', '{1}{W}', ['W'], 3, 1, ['Human', 'Knight'], ['battle cry']),
  keyworded('Goblin Wardriver', '{R}{R}', ['R'], 2, 2, ['Goblin', 'Warrior'], ['battle cry']),

  // --- Coverage batch SUB1: infect (poison to players, -1/-1 counters to creatures). Wither
  // shares the same engine branch (damage as -1/-1 counters) — mechanism ready, no starter card yet. ---
  keyworded('Glistener Elf', '{G}', ['G'], 1, 1, ['Elf'], ['infect']),
  keyworded('Plague Stinger', '{1}{B}', ['B'], 2, 2, ['Insect'], ['flying', 'infect']),

  // --- Coverage batch SUB3: phasing (permanent toggles in/out each untap; CR 702.26) ---
  keyworded('Teferi\'s Honor Guard', '{3}{W}', ['W'], 2, 4, ['Human', 'Soldier'], ['phasing']),
  keyworded('Rainbow Efreet', '{4}{U}{U}', ['U'], 4, 4, ['Efreet'], ['flying', 'phasing']),

  // --- Coverage batch SUB4: banding (defensive damage-assignment control subset; CR 702.22) ---
  keyworded('Benalish Hero', '{W}', ['W'], 1, 1, ['Human', 'Soldier'], ['banding']),
  keyworded('Mesa Pegasus', '{1}{W}', ['W'], 1, 1, ['Pegasus'], ['flying', 'banding']),

  // --- Coverage batch MECH1: Sagas (CR 714 — lore counters, chapter triggers, self-sacrifice) ---
  {
    name: 'Birth of Meletis',
    types: ['Enchantment'],
    subtypes: ['Saga'],
    manaCost: '{1}{W}',
    colors: ['W'],
    // "(I) Create a 0/4 white Wall creature token with defender. (II) You gain 2 life.
    //  (III) Search your library for a basic land card, reveal it, put it into your hand, shuffle."
    saga: {
      chapters: [
        { effect: createToken({ name: 'Wall', power: 0, toughness: 4, subtypes: ['Wall'], keywords: ['defender'] }) },
        { effect: gainLife(2) },
        { effect: searchLibrary({ filter: 'basicLand', dest: 'hand', count: 1 }) },
      ],
    },
  },

  // --- Coverage batch MECH2: Adventure (CR 715 — cast the adventure, exile it, cast the creature later) ---
  {
    // Creature side: French-vanilla (lifelink). Adventure side "Swift End": destroy + lose 2 life.
    name: 'Murderous Rider',
    types: ['Creature'],
    subtypes: ['Zombie', 'Knight'],
    manaCost: '{1}{B}{B}',
    colors: ['B'],
    power: 2,
    toughness: 3,
    keywords: ['lifelink'],
    adventure: {
      name: 'Swift End',
      types: ['Instant'],
      manaCost: '{1}{B}{B}',
      targets: [{ kind: 'creature', count: 1 }],
      effect: sequence(destroyTarget(), loseLife(2)),
    },
  },

  // --- Coverage batch MECH3: Flashback (CR 702.34 — cast from the graveyard, then exile) ---
  {
    name: 'Firebolt',
    types: ['Sorcery'],
    manaCost: '{R}',
    colors: ['R'],
    flashbackCost: '{4}{R}',
    // "Firebolt deals 2 damage to any target. Flashback {4}{R}."
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamage(2) },
  },

  // --- Coverage batch MECH4: Convoke (CR 702.51 — tap creatures to help pay a spell's cost) ---
  {
    // French-vanilla (trample) creature with convoke — its entire rules are captured.
    name: 'Siege Wurm',
    types: ['Creature'],
    subtypes: ['Wurm'],
    manaCost: '{4}{G}{G}',
    colors: ['G'],
    power: 5,
    toughness: 5,
    keywords: ['trample'],
    convoke: true,
  },

  // --- Coverage batch MECH5: Monstrosity (CR 701.31) + Adapt (CR 701.44) — once-only +1/+1 counters ---
  {
    // French-vanilla (reach) + adapt; entire rules captured.
    name: 'Aerie Bowmasters',
    types: ['Creature'],
    subtypes: ['Dinosaur'],
    manaCost: '{3}{G}',
    colors: ['G'],
    power: 3,
    toughness: 3,
    keywords: ['reach'],
    // "{5}{G}: Adapt 2."
    abilities: [{ kind: 'activated', cost: { mana: '{5}{G}' }, effect: adapt(2) }],
  },
  {
    // French-vanilla (reach) + monstrosity; entire rules captured.
    name: 'Nessian Asp',
    types: ['Creature'],
    subtypes: ['Snake'],
    manaCost: '{4}{G}',
    colors: ['G'],
    power: 4,
    toughness: 5,
    keywords: ['reach'],
    // "{6}{G}: Monstrosity 4."
    abilities: [{ kind: 'activated', cost: { mana: '{6}{G}' }, effect: monstrosity(4) }],
  },

  // --- Coverage batch MECH6: Split cards (CR 709 — two halves on one card, pick one to cast) ---
  {
    name: 'Assault // Battery',
    types: ['Instant', 'Sorcery'],
    manaCost: '{R}', // off-stack display only; each half carries its own cost
    colors: ['R', 'G'],
    split: {
      left: { name: 'Assault', types: ['Instant'], manaCost: '{R}', targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamage(2) },
      right: { name: 'Battery', types: ['Sorcery'], manaCost: '{3}{G}', effect: createToken({ name: 'Elephant', power: 3, toughness: 3, subtypes: ['Elephant'] }) },
    },
  },

  // --- Coverage batch MECH7: Suspend (CR 702.62 — exile with time counters, cast when the last is removed) ---
  {
    // French-vanilla (flying) + suspend; entire rules captured. A creature cast from suspend has haste.
    name: 'Errant Ephemeron',
    types: ['Creature'],
    subtypes: ['Illusion'],
    manaCost: '{6}{U}',
    colors: ['U'],
    power: 6,
    toughness: 4,
    keywords: ['flying'],
    suspend: { n: 4, cost: '{1}{U}' },
  },
  {
    // Non-targeted suspend sorcery: auto-casts when the last time counter is removed.
    name: 'Search for Tomorrow',
    types: ['Sorcery'],
    manaCost: '{2}{G}',
    colors: ['G'],
    suspend: { n: 2, cost: '{G}' },
    // "Search your library for a basic land card and put it onto the battlefield."
    spell: { effect: searchLibrary({ filter: 'basicLand', dest: 'battlefield' }) },
  },

  // --- Coverage batch MECH8: Retrace (CR 702.81 — recast from graveyard by discarding a land) ---
  {
    name: "Raven's Crime",
    types: ['Sorcery'],
    manaCost: '{B}',
    colors: ['B'],
    retrace: true,
    // "Target player discards a card. Retrace"
    spell: { targets: [{ kind: 'player', count: 1 }], effect: playersDiscard('target', 1) },
  },

  // --- Coverage batch MECH9: Buyback (CR 702.27 — pay extra, return to hand on resolve) ---
  {
    name: 'Capsize',
    types: ['Instant'],
    manaCost: '{1}{U}{U}',
    colors: ['U'],
    buybackCost: '{3}',
    // "Return target permanent to its owner's hand. Buyback {3}"
    spell: { targets: [{ kind: 'permanent', count: 1 }], effect: returnToHand() },
  },

  // --- Coverage batch MECH10: Bestow (CR 702.103 — cast as a creature OR as an Aura) ---
  {
    // Enchantment Creature — Nyxborn Satyr, 1/1. Cast as a 1/1 creature, or bestow {1}{G} as an
    // Aura granting the enchanted creature +1/+1 (via grantsToHost). Entire rules captured.
    name: 'Nyxborn Rollicker',
    types: ['Enchantment', 'Creature'],
    subtypes: ['Nyxborn', 'Satyr'],
    manaCost: '{G}',
    colors: ['G'],
    power: 1,
    toughness: 1,
    bestowCost: '{1}{G}',
    grantsToHost: { power: 1, toughness: 1 },
  },

  // MECH11 (Evoke, CR 702.74) added evokeCost to the existing Mulldrifter above.

  // --- Coverage batch MECH12: Escape (CR 702.139 — recast from graveyard by exiling other cards) ---
  {
    // Entire rules captured: ETB Goat token + "Sacrifice a creature: Scry 1" + escape.
    name: 'Woe Strider',
    types: ['Creature'],
    subtypes: ['Horror'],
    manaCost: '{1}{B}',
    colors: ['B'],
    power: 3,
    toughness: 2,
    escape: { cost: '{3}{B}', exileCount: 4 },
    enters: { effect: createToken({ name: 'Goat', power: 0, toughness: 1, subtypes: ['Goat'] }) },
    abilities: [{ kind: 'activated', cost: { sacrifice: { count: 1, filter: 'creature' } }, effect: scry(1) }],
  },

  // --- Coverage batch MECH16: Morph (CR 702.37 — cast face down as a 2/2, turn up for morph cost) ---
  {
    // First strike + morph; entire rules captured. Face down it's a 2/2 vanilla; face up a 3/1 FS.
    name: 'Battering Craghorn',
    types: ['Creature'],
    subtypes: ['Beast'],
    manaCost: '{3}{R}{R}',
    colors: ['R'],
    power: 3,
    toughness: 1,
    keywords: ['first strike'],
    morphCost: '{2}{R}{R}',
  },

  // --- Coverage batch MECH15: Foretell (CR 702.143 — exile face-down for {2}, cast later) ---
  {
    // French-vanilla (flying) + foretell; entire rules captured.
    name: 'Augury Raven',
    types: ['Creature'],
    subtypes: ['Bird'],
    manaCost: '{3}{U}',
    colors: ['U'],
    power: 2,
    toughness: 3,
    keywords: ['flying'],
    foretellCost: '{2}{U}',
  },

  // --- Coverage batch MECH14: Madness (CR 702.35 — discard → cast for madness cost, else graveyard) ---
  {
    name: 'Fiery Temper',
    types: ['Instant'],
    manaCost: '{1}{R}{R}',
    colors: ['R'],
    madnessCost: '{R}',
    // "Fiery Temper deals 3 damage to any target. Madness {R}."
    spell: { targets: [{ kind: 'anyTarget', count: 1 }], effect: dealDamage(3) },
  },

  // --- Coverage batch MECH13: Transform DFC (CR 712 — two faces, defName-swap) ---
  {
    name: 'Delver of Secrets',
    types: ['Creature'],
    subtypes: ['Human', 'Wizard'],
    manaCost: '{U}',
    colors: ['U'],
    power: 1,
    toughness: 1,
    // "At the beginning of your upkeep, look at the top card of your library. You may reveal it.
    //  If an instant or sorcery card is revealed this way, transform Delver of Secrets."
    upkeep: { effect: lookTransformIfInstantSorcery() },
    back: {
      name: 'Insectile Aberration',
      types: ['Creature'],
      subtypes: ['Human', 'Insect'],
      colors: ['U'],
      power: 3,
      toughness: 2,
      keywords: ['flying'],
    },
  },

  // ===== Perpetual card-by-card coverage (M-R5+): popular Commander staples =====
  // --- Coverage batch CARD1: clean staples that reuse existing primitives ---
  {
    name: 'Dark Ritual',
    types: ['Instant'],
    manaCost: '{B}',
    colors: ['B'],
    // "Add {B}{B}{B}."
    spell: { effect: addMana('B', 'B', 'B') },
  },
  {
    name: 'Cancel',
    types: ['Instant'],
    manaCost: '{1}{U}{U}',
    colors: ['U'],
    // "Counter target spell."
    spell: { targets: [{ kind: 'spell', count: 1 }], effect: counterTarget() },
  },
  {
    name: 'Swiftfoot Boots',
    types: ['Artifact'],
    subtypes: ['Equipment'],
    manaCost: '{2}',
    // "Equipped creature has hexproof and haste. Equip {1}"
    equipCost: '{1}',
    grantsToHost: { keywords: ['hexproof', 'haste'] },
  },
  {
    name: 'Lightning Greaves',
    types: ['Artifact'],
    subtypes: ['Equipment'],
    manaCost: '{2}',
    // "Equipped creature has haste and shroud. Equip {0}"
    equipCost: '{0}',
    grantsToHost: { keywords: ['shroud', 'haste'] },
  },

  // --- Coverage batch CARD2: card advantage (2 small new primitives) ---
  {
    name: 'Sign in Blood',
    types: ['Sorcery'],
    manaCost: '{B}{B}',
    colors: ['B'],
    // "Target player draws two cards and loses 2 life."
    spell: { targets: [{ kind: 'player', count: 1 }], effect: targetPlayerDrawDrain(2, 2) },
  },
  {
    name: 'Faithless Looting',
    types: ['Sorcery'],
    manaCost: '{R}',
    colors: ['R'],
    flashbackCost: '{2}{R}',
    // "Draw two cards, then discard two cards. Flashback {2}{R}."
    spell: { effect: sequence(drawCards(2), selfDiscard(2)) },
  },

  // --- Coverage batch CARD3: premium removal / counter (exile-fetch + spell-target filter) ---
  {
    name: 'Path to Exile',
    types: ['Instant'],
    manaCost: '{W}',
    colors: ['W'],
    // "Exile target creature. Its controller may search their library for a basic land card, put
    //  that card onto the battlefield tapped, then shuffle."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: exileTargetControllerFetchesLand() },
  },
  {
    name: 'Negate',
    types: ['Instant'],
    manaCost: '{1}{U}',
    colors: ['U'],
    // "Counter target noncreature spell."
    spell: { targets: [{ kind: 'spell', count: 1, filter: { excludeTypes: ['Creature'] } }], effect: counterTarget() },
  },
  {
    name: 'Feed the Swarm',
    types: ['Sorcery'],
    manaCost: '{1}{B}',
    colors: ['B'],
    // "Destroy target creature or enchantment an opponent controls. You lose life equal to that
    //  permanent's mana value."
    spell: {
      targets: [{ kind: 'permanent', count: 1, filter: { types: ['Creature', 'Enchantment'], controller: 'opponent' } }],
      effect: destroyLoseLifeEqualToMV(),
    },
  },
  {
    name: 'Reanimate',
    types: ['Sorcery'],
    manaCost: '{B}',
    colors: ['B'],
    // "Put target creature card from a graveyard onto the battlefield under your control. You lose life
    //  equal to its mana value."
    spell: {
      targets: [{ kind: 'graveyardCard', count: 1, filter: { types: ['Creature'] } }],
      effect: reanimate(),
    },
  },
  {
    name: 'Cultivate',
    types: ['Sorcery'],
    manaCost: '{2}{G}',
    colors: ['G'],
    // "Search your library for up to two basic land cards, reveal those cards, and put one onto the
    //  battlefield tapped and the other into your hand, then shuffle."
    spell: {
      effect: searchLibrary({
        filter: 'basicLand',
        dest: 'battlefield',
        count: 2,
        split: { first: { dest: 'battlefield', tapped: true }, rest: { dest: 'hand', tapped: false } },
      }),
    },
  },
  {
    name: "Kodama's Reach",
    types: ['Sorcery'],
    manaCost: '{2}{G}',
    colors: ['G'],
    // "Search your library for up to two basic land cards, reveal those cards, and put one onto the
    //  battlefield tapped and the other into your hand, then shuffle." (functionally Cultivate)
    spell: {
      effect: searchLibrary({
        filter: 'basicLand',
        dest: 'battlefield',
        count: 2,
        split: { first: { dest: 'battlefield', tapped: true }, rest: { dest: 'hand', tapped: false } },
      }),
    },
  },
  {
    name: 'Farseek',
    types: ['Sorcery'],
    manaCost: '{1}{G}',
    colors: ['G'],
    // "Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield
    //  tapped, then shuffle." (basic OR non-basic with those land types)
    spell: {
      effect: searchLibrary({ filter: { landSubtypes: ['Plains', 'Island', 'Swamp', 'Mountain'] }, dest: 'battlefield', tapped: true, count: 1 }),
    },
  },
  {
    name: "Nature's Lore",
    types: ['Sorcery'],
    manaCost: '{1}{G}',
    colors: ['G'],
    // "Search your library for a Forest card, put that card onto the battlefield, then shuffle." (untapped)
    spell: {
      effect: searchLibrary({ filter: { landSubtypes: ['Forest'] }, dest: 'battlefield', count: 1 }),
    },
  },
  {
    name: 'Three Visits',
    types: ['Sorcery'],
    manaCost: '{1}{G}',
    colors: ['G'],
    // "Search your library for a Forest card, put it onto the battlefield, then shuffle." (functionally Nature's Lore)
    spell: {
      effect: searchLibrary({ filter: { landSubtypes: ['Forest'] }, dest: 'battlefield', count: 1 }),
    },
  },
  {
    name: 'Arcane Signet',
    types: ['Artifact'],
    manaCost: '{2}',
    // "{T}: Add one mana of any color in your commander's color identity." Simplified for the assisted
    //  table to any colour (a rock's identity restriction isn't tracked); colour chosen on tap.
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['W', 'U', 'B', 'R', 'G'], chooseColor: true, effect: addMana('W') }],
  },
  {
    name: 'Fellwar Stone',
    types: ['Artifact'],
    manaCost: '{2}',
    // "{T}: Add one mana of any color that a land an opponent controls could produce." Simplified to
    //  any colour for the assisted table; colour chosen on tap.
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['W', 'U', 'B', 'R', 'G'], chooseColor: true, effect: addMana('W') }],
  },
  {
    name: 'Blasphemous Act',
    types: ['Sorcery'],
    manaCost: '{8}{R}',
    colors: ['R'],
    // "This spell costs {1} less to cast for each creature on the battlefield. Blasphemous Act deals
    //  13 damage to each creature."
    costReduction: (state) => battlefieldCreatures(state).length,
    spell: { effect: damageAllCreatures(13) },
  },

  // --- Coverage batch CARD8: the most-played utility lands + no-maximum-hand-size ---
  {
    name: 'Command Tower',
    types: ['Land'],
    // "{T}: Add one mana of any color in your commander's color identity." Simplified for the
    //  assisted table to any colour (identity restriction isn't tracked), as for Arcane Signet.
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['W', 'U', 'B', 'R', 'G'], chooseColor: true, effect: addMana('W') }],
  },
  {
    name: 'Exotic Orchard',
    types: ['Land'],
    // "{T}: Add one mana of any color that a land an opponent controls could produce." Simplified to
    //  any colour (as Fellwar Stone) — the opponents'-lands restriction isn't tracked.
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['W', 'U', 'B', 'R', 'G'], chooseColor: true, effect: addMana('W') }],
  },
  {
    name: 'Reliquary Tower',
    types: ['Land'],
    // "You have no maximum hand size. {T}: Add {C}."
    noMaxHandSize: true,
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C') }],
  },
  {
    name: 'Thought Vessel',
    types: ['Artifact'],
    manaCost: '{2}',
    // "You have no maximum hand size. {T}: Add {C}."
    noMaxHandSize: true,
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C') }],
  },

  // --- Coverage batch CARD9: sacrifice-this-permanent costs (fetch lands, sac-for-draw rocks) ---
  ...(['Evolving Wilds', 'Terramorphic Expanse'] as const).map(
    (name): CardDefinition => ({
      name,
      types: ['Land'],
      // "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the
      //  battlefield tapped, then shuffle." (functionally identical cards)
      abilities: [
        {
          kind: 'activated',
          cost: { tap: true, sacrificeSelf: true },
          effect: searchLibrary({ filter: 'basicLand', dest: 'battlefield', tapped: true, count: 1 }),
        },
      ],
    }),
  ),
  {
    name: 'Mind Stone',
    types: ['Artifact'],
    manaCost: '{2}',
    // "{T}: Add {C}." / "{1}, {T}, Sacrifice this artifact: Draw a card."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C') },
      { kind: 'activated', cost: { mana: '{1}', tap: true, sacrificeSelf: true }, effect: drawCards(1) },
    ],
  },
  {
    name: "Commander's Sphere",
    types: ['Artifact'],
    manaCost: '{3}',
    // "{T}: Add one mana of any color in your commander's color identity." (simplified to any
    //  colour as for Arcane Signet) / "Sacrifice this artifact: Draw a card." (no {T} — usable
    //  even while tapped)
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['W', 'U', 'B', 'R', 'G'], chooseColor: true, effect: addMana('W') },
      { kind: 'activated', cost: { sacrificeSelf: true }, effect: drawCards(1) },
    ],
  },
  {
    name: 'Bojuka Bog',
    types: ['Land'],
    // "This land enters tapped. When this land enters, exile target player's graveyard."
    entersTapped: true,
    enters: { targets: [{ kind: 'player', count: 1 }], effect: exileGraveyard() },
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['B'], effect: addMana('B') }],
  },

  // --- Coverage batch CARD10: until-end-of-turn keyword grants + "can't be blocked" ---
  {
    name: 'Heroic Intervention',
    types: ['Instant'],
    manaCost: '{1}{G}',
    colors: ['G'],
    // "Permanents you control gain hexproof and indestructible until end of turn."
    spell: { effect: grantKeywordsToControlled(['hexproof', 'indestructible']) },
  },
  {
    name: "Rogue's Passage",
    types: ['Land'],
    // "{T}: Add {C}." / "{4}, {T}: Target creature can't be blocked this turn."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C') },
      { kind: 'activated', cost: { mana: '{4}', tap: true }, targets: [{ kind: 'creature', count: 1 }], effect: makeUnblockable() },
    ],
  },

  // --- Coverage batch CARD11: the pay-1-life fetch lands (Onslaught + Zendikar cycles) ---
  fetchLand('Polluted Delta', 'Island', 'Swamp'),
  fetchLand('Flooded Strand', 'Plains', 'Island'),
  fetchLand('Misty Rainforest', 'Forest', 'Island'),
  fetchLand('Bloodstained Mire', 'Swamp', 'Mountain'),
  fetchLand('Windswept Heath', 'Forest', 'Plains'),
  fetchLand('Wooded Foothills', 'Mountain', 'Forest'),
  fetchLand('Verdant Catacombs', 'Swamp', 'Forest'),
  fetchLand('Scalding Tarn', 'Island', 'Mountain'),
  fetchLand('Marsh Flats', 'Plains', 'Swamp'),
  fetchLand('Arid Mesa', 'Mountain', 'Plains'),

  // --- Coverage batch CARD12: the shocklands (Ravnica cycle) — as-enters pay-2-life choice ---
  shockland('Watery Grave', 'U', 'B', ['Island', 'Swamp']),
  shockland('Godless Shrine', 'W', 'B', ['Plains', 'Swamp']),
  shockland('Breeding Pool', 'G', 'U', ['Forest', 'Island']),
  shockland('Hallowed Fountain', 'W', 'U', ['Plains', 'Island']),
  shockland('Steam Vents', 'U', 'R', ['Island', 'Mountain']),
  shockland('Stomping Ground', 'R', 'G', ['Mountain', 'Forest']),
  shockland('Blood Crypt', 'B', 'R', ['Swamp', 'Mountain']),
  shockland('Overgrown Tomb', 'B', 'G', ['Swamp', 'Forest']),
  shockland('Sacred Foundry', 'R', 'W', ['Mountain', 'Plains']),
  shockland('Temple Garden', 'G', 'W', ['Forest', 'Plains']),

  // --- Coverage batch CARD13: equipped-creature-dies trigger + conditional fetch untap ---
  {
    name: 'Skullclamp',
    types: ['Artifact'],
    subtypes: ['Equipment'],
    manaCost: '{1}',
    // "Equipped creature gets +1/-1. Whenever equipped creature dies, draw two cards. Equip {1}"
    equipCost: '{1}',
    grantsToHost: { power: 1, toughness: -1 },
    dies: { watch: { scope: 'attachedCreature' }, effect: drawCards(2) },
  },
  {
    name: 'Fabled Passage',
    types: ['Land'],
    // "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the
    //  battlefield tapped, then shuffle. Then if you control four or more lands, untap that land."
    abilities: [
      {
        kind: 'activated',
        cost: { tap: true, sacrificeSelf: true },
        effect: searchLibrary({ filter: 'basicLand', dest: 'battlefield', tapped: true, count: 1, untapIfLandsAtLeast: 4 }),
      },
    ],
  },

  // --- Coverage batch CARD14: Treasure tokens ---
  {
    name: "An Offer You Can't Refuse",
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Counter target noncreature spell. Its controller creates two Treasure tokens."
    spell: {
      targets: [{ kind: 'spell', count: 1, filter: { excludeTypes: ['Creature'] } }],
      effect: counterTargetGrantingTreasures(2),
    },
  },
  {
    name: 'Pitiless Plunderer',
    types: ['Creature'],
    subtypes: ['Human', 'Pirate'],
    manaCost: '{3}{B}',
    colors: ['B'],
    power: 1,
    toughness: 4,
    // "Whenever another creature you control dies, create a Treasure token."
    dies: { watch: { scope: 'anyCreature', controllerOnly: true, excludeSelf: true }, effect: createTreasures(1) },
  },

  // --- Coverage batch CARD15: overload (CR 702.96) ---
  {
    name: 'Cyclonic Rift',
    types: ['Instant'],
    manaCost: '{1}{U}',
    colors: ['U'],
    // "Return target nonland permanent you don't control to its owner's hand. Overload {6}{U}"
    spell: {
      targets: [{ kind: 'permanent', count: 1, filter: { excludeTypes: ['Land'], controller: 'opponent' } }],
      effect: returnToHand(),
    },
    overload: { cost: '{6}{U}', effect: returnAllNonlandYouDontControlToHand() },
  },
  {
    name: 'Vandalblast',
    types: ['Sorcery'],
    manaCost: '{R}',
    colors: ['R'],
    // "Destroy target artifact you don't control. Overload {4}{R}"
    spell: {
      targets: [{ kind: 'permanent', count: 1, filter: { types: ['Artifact'], controller: 'opponent' } }],
      effect: destroyPermanent(),
    },
    overload: { cost: '{4}{R}', effect: destroyAllArtifactsYouDontControl() },
  },
  {
    name: 'Damn',
    types: ['Sorcery'],
    manaCost: '{B}{B}',
    colors: ['B'],
    // "Destroy target creature. A creature destroyed this way can't be regenerated. Overload
    //  {2}{W}{W}" (regeneration doesn't exist in this engine, so the rider is a no-op)
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: destroyTarget() },
    overload: { cost: '{2}{W}{W}', effect: destroyAllCreatures() },
  },

  // --- Coverage batch CARD16: cast triggers with an "unless that player pays" tax ---
  {
    name: 'Rhystic Study',
    types: ['Enchantment'],
    manaCost: '{2}{U}',
    colors: ['U'],
    // "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}."
    castSpell: { watch: { opponentsOnly: true }, unlessPay: '{1}', effect: drawCards(1) },
  },
  {
    name: 'Esper Sentinel',
    types: ['Artifact', 'Creature'],
    subtypes: ['Human', 'Soldier'],
    manaCost: '{W}',
    colors: ['W'],
    power: 1,
    toughness: 1,
    // "Whenever an opponent casts their first noncreature spell each turn, draw a card unless that
    //  player pays {X}, where X is this creature's power." (X follows its CURRENT power — anthems
    //  and counters raise the tax)
    castSpell: {
      watch: { opponentsOnly: true, noncreatureOnly: true, firstEachTurn: true },
      unlessPayFromPower: true,
      effect: drawCards(1),
    },
  },

  // --- Coverage batch CARD17: mana that hurts (life/damage on tap) ---
  {
    name: 'Ancient Tomb',
    types: ['Land'],
    // "{T}: Add {C}{C}. This land deals 2 damage to you."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], damageOnTapForMana: 2, effect: addMana('C', 'C') },
    ],
  },
  {
    name: 'City of Brass',
    types: ['Land'],
    // "Whenever this land becomes tapped, it deals 1 damage to you. {T}: Add one mana of any color."
    //  (the damage is modelled on tapping FOR MANA — see damageOnTapForMana)
    abilities: [
      {
        kind: 'activated',
        cost: { tap: true },
        isMana: true,
        produces: ['W', 'U', 'B', 'R', 'G'],
        chooseColor: true,
        damageOnTapForMana: 1,
        effect: addMana('W'),
      },
    ],
  },
  {
    name: 'Mana Confluence',
    types: ['Land'],
    // "{T}, Pay 1 life: Add one mana of any color."
    abilities: [
      {
        kind: 'activated',
        cost: { tap: true, life: 1 },
        isMana: true,
        produces: ['W', 'U', 'B', 'R', 'G'],
        chooseColor: true,
        effect: addMana('W'),
      },
    ],
  },
  // the ten pain lands
  painLand('Shivan Reef', 'U', 'R'),
  painLand('Battlefield Forge', 'R', 'W'),
  painLand('Caves of Koilos', 'W', 'B'),
  painLand('Yavimaya Coast', 'G', 'U'),
  painLand('Llanowar Wastes', 'B', 'G'),
  painLand('Underground River', 'U', 'B'),
  painLand('Adarkar Wastes', 'W', 'U'),
  painLand('Sulfurous Springs', 'B', 'R'),
  painLand('Karplusan Forest', 'R', 'G'),
  painLand('Brushland', 'G', 'W'),

  // --- Coverage batch CARD18: pay-X-life as an additional cost + a draw tax ---
  {
    name: 'Toxic Deluge',
    types: ['Sorcery'],
    manaCost: '{2}{B}',
    colors: ['B'],
    // "As an additional cost to cast this spell, pay X life. All creatures get -X/-X until end of turn."
    additionalLifeCostX: true,
    spell: { effect: weakenAllCreaturesX() },
  },
  {
    name: 'Smothering Tithe',
    types: ['Enchantment'],
    manaCost: '{3}{W}',
    colors: ['W'],
    // "Whenever an opponent draws a card, that player may pay {2}. If they don't, you create a
    //  Treasure token."
    drawnCard: { watch: { opponentsOnly: true }, unlessPay: '{2}', effect: createTreasures(1) },
  },

  // --- Coverage batch CARD19: the check lands + a conditional mana land + Swan Song ---
  checkLand('Sulfur Falls', 'U', 'R', ['Island', 'Mountain']),
  checkLand('Clifftop Retreat', 'R', 'W', ['Mountain', 'Plains']),
  checkLand('Dragonskull Summit', 'B', 'R', ['Swamp', 'Mountain']),
  checkLand('Isolated Chapel', 'W', 'B', ['Plains', 'Swamp']),
  checkLand('Glacial Fortress', 'W', 'U', ['Plains', 'Island']),
  checkLand('Hinterland Harbor', 'G', 'U', ['Forest', 'Island']),
  checkLand('Drowned Catacomb', 'U', 'B', ['Island', 'Swamp']),
  checkLand('Woodland Cemetery', 'B', 'G', ['Swamp', 'Forest']),
  checkLand('Rootbound Crag', 'R', 'G', ['Mountain', 'Forest']),
  checkLand('Sunpetal Grove', 'G', 'W', ['Forest', 'Plains']),
  {
    name: 'Temple of the False God',
    types: ['Land'],
    // "{T}: Add {C}{C}. Activate only if you control five or more lands."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], requiresLandsAtLeast: 5, effect: addMana('C', 'C') },
    ],
  },
  {
    name: 'Swan Song',
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Counter target enchantment, instant, or sorcery spell. Its controller creates a 2/2 blue
    //  Bird creature token with flying."
    spell: {
      targets: [{ kind: 'spell', count: 1, filter: { types: ['Enchantment', 'Instant', 'Sorcery'] } }],
      effect: counterTargetGrantingToken({ name: 'Bird', power: 2, toughness: 2, subtypes: ['Bird'], keywords: ['flying'] }, 1),
    },
  },

  // --- Coverage batch CARD20: shuffle-a-permanent-away, and draw-then-put-back ---
  {
    name: 'Chaos Warp',
    types: ['Instant'],
    manaCost: '{2}{R}',
    colors: ['R'],
    // "The owner of target permanent shuffles it into their library, then reveals the top card of
    //  their library. If it's a permanent card, they put it onto the battlefield."
    spell: { targets: [{ kind: 'permanent', count: 1 }], effect: chaosWarpTarget() },
  },
  {
    name: 'Brainstorm',
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Draw three cards, then put two cards from your hand on top of your library in any order."
    spell: { effect: sequence(drawCards(3), putBackOnTop(2)) },
  },

  // --- Coverage batch CARD21: the Talismans, the battle lands, a sac-fetch creature and the
  //     "free if you control a commander" spells ---
  talisman('Talisman of Dominance', 'U', 'B'),
  talisman('Talisman of Creativity', 'U', 'R'),
  talisman('Talisman of Indulgence', 'B', 'R'),
  talisman('Talisman of Hierarchy', 'W', 'B'),
  talisman('Talisman of Progress', 'W', 'U'),
  talisman('Talisman of Conviction', 'R', 'W'),
  talisman('Talisman of Curiosity', 'G', 'U'),
  talisman('Talisman of Resilience', 'B', 'G'),
  talisman('Talisman of Impulse', 'R', 'G'),
  talisman('Talisman of Unity', 'G', 'W'),
  battleLand('Cinder Glade', 'R', 'G', ['Mountain', 'Forest']),
  battleLand('Sunken Hollow', 'U', 'B', ['Island', 'Swamp']),
  battleLand('Smoldering Marsh', 'B', 'R', ['Swamp', 'Mountain']),
  battleLand('Canopy Vista', 'G', 'W', ['Forest', 'Plains']),
  battleLand('Prairie Stream', 'W', 'U', ['Plains', 'Island']),
  {
    name: 'Sakura-Tribe Elder',
    types: ['Creature'],
    subtypes: ['Snake', 'Shaman'],
    manaCost: '{1}{G}',
    colors: ['G'],
    power: 1,
    toughness: 1,
    // "Sacrifice this creature: Search your library for a basic land card, put that card onto the
    //  battlefield tapped, then shuffle." (no {T}, so it works the turn it lands)
    abilities: [
      {
        kind: 'activated',
        cost: { sacrificeSelf: true },
        effect: searchLibrary({ filter: 'basicLand', dest: 'battlefield', tapped: true, count: 1 }),
      },
    ],
  },
  {
    name: 'Fierce Guardianship',
    types: ['Instant'],
    manaCost: '{2}{U}',
    colors: ['U'],
    // "If you control a commander, you may cast this spell without paying its mana cost.
    //  Counter target noncreature spell."
    freeIfCommander: true,
    spell: { targets: [{ kind: 'spell', count: 1, filter: { excludeTypes: ['Creature'] } }], effect: counterTarget() },
  },
  {
    name: 'Deadly Rollick',
    types: ['Instant'],
    manaCost: '{3}{B}',
    colors: ['B'],
    // "If you control a commander, you may cast this spell without paying its mana cost.
    //  Exile target creature."
    freeIfCommander: true,
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: exileTarget() },
  },

  // --- Coverage batch CARD22: the tutors (search → on TOP of your library) + two sac artifacts ---
  {
    name: 'Vampiric Tutor',
    types: ['Instant'],
    manaCost: '{B}',
    colors: ['B'],
    // "Search your library for a card, then shuffle and put that card on top. You lose 2 life."
    //  (no reveal — only its owner knows what is on top)
    spell: { effect: sequence(searchLibrary({ filter: 'any', dest: 'libraryTop', count: 1 }), loseLife(2)) },
  },
  {
    name: 'Enlightened Tutor',
    types: ['Instant'],
    manaCost: '{W}',
    colors: ['W'],
    // "Search your library for an artifact or enchantment card, reveal it, then shuffle and put
    //  that card on top."
    spell: { effect: searchLibrary({ filter: { types: ['Artifact', 'Enchantment'] }, dest: 'libraryTop', count: 1, reveal: true }) },
  },
  {
    name: 'Mystical Tutor',
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Search your library for an instant or sorcery card, reveal it, then shuffle and put that
    //  card on top."
    spell: { effect: searchLibrary({ filter: { types: ['Instant', 'Sorcery'] }, dest: 'libraryTop', count: 1, reveal: true }) },
  },
  {
    name: 'Worldly Tutor',
    types: ['Instant'],
    manaCost: '{G}',
    colors: ['G'],
    // "Search your library for a creature card, reveal it, then shuffle and put the card on top."
    spell: { effect: searchLibrary({ filter: { types: ['Creature'] }, dest: 'libraryTop', count: 1, reveal: true }) },
  },
  {
    name: 'Lotus Petal',
    types: ['Artifact'],
    manaCost: '{0}',
    // "{T}, Sacrifice this artifact: Add one mana of any color." (a one-shot Treasure, in effect)
    abilities: [
      {
        kind: 'activated',
        cost: { tap: true, sacrificeSelf: true },
        isMana: true,
        produces: ['W', 'U', 'B', 'R', 'G'],
        chooseColor: true,
        effect: addMana('W'),
      },
    ],
  },
  {
    name: "Wayfarer's Bauble",
    types: ['Artifact'],
    manaCost: '{1}',
    // "{2}, {T}, Sacrifice this artifact: Search your library for a basic land card, put that card
    //  onto the battlefield tapped, then shuffle."
    abilities: [
      {
        kind: 'activated',
        cost: { mana: '{2}', tap: true, sacrificeSelf: true },
        effect: searchLibrary({ filter: 'basicLand', dest: 'battlefield', tapped: true, count: 1 }),
      },
    ],
  },

  // --- Coverage batch CARD23: the Battlebond + slow land cycles, and four singles ---
  bondLand('Morphic Pool', 'U', 'B'),
  bondLand('Rejuvenating Springs', 'G', 'U'),
  bondLand('Training Center', 'U', 'R'),
  bondLand('Luxury Suite', 'B', 'R'),
  bondLand('Sea of Clouds', 'W', 'U'),
  bondLand('Vault of Champions', 'W', 'B'),
  bondLand('Spectator Seating', 'R', 'W'),
  bondLand('Undergrowth Stadium', 'B', 'G'),
  bondLand('Spire Garden', 'R', 'G'),
  bondLand('Bountiful Promenade', 'G', 'W'),
  slowLand('Dreamroot Cascade', 'G', 'U'),
  slowLand('Stormcarved Coast', 'U', 'R'),
  slowLand('Rockfall Vale', 'R', 'G'),
  slowLand('Shipwreck Marsh', 'U', 'B'),
  slowLand('Deserted Beach', 'W', 'U'),
  slowLand('Haunted Ridge', 'B', 'R'),
  slowLand('Sundown Pass', 'R', 'W'),
  slowLand('Shattered Sanctum', 'W', 'B'),
  slowLand('Overgrown Farmland', 'G', 'W'),
  slowLand('Deathcap Glade', 'B', 'G'),
  {
    name: 'Prismatic Vista',
    types: ['Land'],
    // "{T}, Pay 1 life, Sacrifice this land: Search your library for a basic land card, put it onto
    //  the battlefield, then shuffle." (untapped — unlike the tapped fetches)
    abilities: [
      {
        kind: 'activated',
        cost: { tap: true, life: 1, sacrificeSelf: true },
        effect: searchLibrary({ filter: 'basicLand', dest: 'battlefield', count: 1 }),
      },
    ],
  },
  {
    name: 'Cabal Coffers',
    types: ['Land'],
    // "{2}, {T}: Add {B} for each Swamp you control." (a count-based amount, so the engine runs the
    //  effect rather than a fixed/chosen output)
    abilities: [
      {
        kind: 'activated',
        cost: { mana: '{2}', tap: true },
        isMana: true,
        produces: ['B'],
        effect: addManaPerLandSubtype('B', 'Swamp'),
      },
    ],
  },
  {
    name: 'Blood Artist',
    types: ['Creature'],
    subtypes: ['Vampire'],
    manaCost: '{1}{B}',
    colors: ['B'],
    power: 0,
    toughness: 1,
    // "Whenever this creature or another creature dies, target player loses 1 life and you gain 1
    //  life." (this OR another → a watcher that does not exclude itself)
    dies: {
      watch: { scope: 'anyCreature' },
      targets: [{ kind: 'player', count: 1 }],
      effect: drainTargetPlayer(1),
    },
  },
  {
    name: 'Stroke of Midnight',
    types: ['Instant'],
    manaCost: '{2}{W}',
    colors: ['W'],
    // "Destroy target nonland permanent. Its controller creates a 1/1 white Human creature token."
    spell: {
      targets: [{ kind: 'permanent', count: 1, filter: { excludeTypes: ['Land'] } }],
      effect: destroyPermanentGrantToken({ name: 'Human', power: 1, toughness: 1, subtypes: ['Human'] }),
    },
  },

  // --- Coverage batch CARD24: additional costs chosen as you cast (sacrifice / discard) ---
  {
    name: 'Village Rites',
    types: ['Instant'],
    manaCost: '{B}',
    colors: ['B'],
    // "As an additional cost to cast this spell, sacrifice a creature. Draw two cards."
    additionalCost: { sacrifice: { count: 1, filter: 'creature' } },
    spell: { effect: drawCards(2) },
  },
  {
    name: 'Deadly Dispute',
    types: ['Instant'],
    manaCost: '{1}{B}',
    colors: ['B'],
    // "As an additional cost to cast this spell, sacrifice an artifact or creature. Draw two cards
    //  and create a Treasure token."
    additionalCost: { sacrifice: { count: 1, filter: 'artifactOrCreature' } },
    spell: { effect: sequence(drawCards(2), createTreasures(1)) },
  },
  {
    name: 'Thrill of Possibility',
    types: ['Instant'],
    manaCost: '{1}{R}',
    colors: ['R'],
    // "As an additional cost to cast this spell, discard a card. Draw two cards."
    additionalCost: { discard: 1 },
    spell: { effect: drawCards(2) },
  },
  {
    name: 'Big Score',
    types: ['Instant'],
    manaCost: '{3}{R}',
    colors: ['R'],
    // "As an additional cost to cast this spell, discard a card. Draw two cards and create two
    //  Treasure tokens."
    additionalCost: { discard: 1 },
    spell: { effect: sequence(drawCards(2), createTreasures(2)) },
  },
  {
    name: 'Unexpected Windfall',
    types: ['Instant'],
    manaCost: '{2}{R}{R}',
    colors: ['R'],
    // "As an additional cost to cast this spell, discard a card. Draw two cards and create two
    //  Treasure tokens."
    additionalCost: { discard: 1 },
    spell: { effect: sequence(drawCards(2), createTreasures(2)) },
  },

  // --- Coverage batch CARD25: cantrips, an extra land drop, an own-cast trigger, sac-a-land ---
  {
    name: 'Opt',
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Scry 1. Draw a card." — the draw waits for the scry to be answered (see pendingScry.thenDraw)
    spell: { effect: scry(1, { thenDraw: 1 }) },
  },
  {
    name: 'Preordain',
    types: ['Sorcery'],
    manaCost: '{U}',
    colors: ['U'],
    // "Scry 2, then draw a card."
    spell: { effect: scry(2, { thenDraw: 1 }) },
  },
  {
    name: 'Ornithopter of Paradise',
    types: ['Artifact', 'Creature'],
    subtypes: ['Thopter'],
    manaCost: '{2}',
    power: 0,
    toughness: 2,
    keywords: ['flying'],
    // "Flying. {T}: Add one mana of any color."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['W', 'U', 'B', 'R', 'G'], chooseColor: true, effect: addMana('W') },
    ],
  },
  {
    name: 'Explore',
    types: ['Sorcery'],
    manaCost: '{1}{G}',
    colors: ['G'],
    // "You may play an additional land this turn. Draw a card."
    spell: { effect: sequence(extraLandDrop(1), drawCards(1)) },
  },
  {
    name: 'Beast Whisperer',
    types: ['Creature'],
    subtypes: ['Elf', 'Druid'],
    manaCost: '{2}{G}{G}',
    colors: ['G'],
    power: 2,
    toughness: 3,
    // "Whenever you cast a creature spell, draw a card."
    castSpell: { watch: { selfOnly: true, creatureOnly: true }, effect: drawCards(1) },
  },
  {
    name: "Dovin's Veto",
    types: ['Instant'],
    manaCost: '{W}{U}',
    colors: ['W', 'U'],
    // "This spell can't be countered. Counter target noncreature spell."
    cantBeCountered: true,
    spell: { targets: [{ kind: 'spell', count: 1, filter: { excludeTypes: ['Creature'] } }], effect: counterTarget() },
  },
  {
    name: 'Crop Rotation',
    types: ['Instant'],
    manaCost: '{G}',
    colors: ['G'],
    // "As an additional cost to cast this spell, sacrifice a land. Search your library for a land
    //  card, put that card onto the battlefield, then shuffle." (any land, and untapped)
    additionalCost: { sacrifice: { count: 1, filter: 'land' } },
    spell: { effect: searchLibrary({ filter: { types: ['Land'] }, dest: 'battlefield', count: 1 }) },
  },
  {
    name: 'Harrow',
    types: ['Instant'],
    manaCost: '{2}{G}',
    colors: ['G'],
    // "As an additional cost to cast this spell, sacrifice a land. Search your library for up to two
    //  basic land cards, put them onto the battlefield, then shuffle."
    additionalCost: { sacrifice: { count: 1, filter: 'land' } },
    spell: { effect: searchLibrary({ filter: 'basicLand', dest: 'battlefield', count: 2 }) },
  },

  // --- Coverage batch CARD26: devotion, cost reduction from permanents, and four land cycles ---
  {
    name: 'Gray Merchant of Asphodel',
    types: ['Creature'],
    subtypes: ['Zombie'],
    manaCost: '{3}{B}{B}',
    colors: ['B'],
    power: 2,
    toughness: 2,
    // "When this creature enters, each opponent loses X life, where X is your devotion to black.
    //  You gain life equal to the life lost this way."
    enters: { effect: drainEachOpponentByDevotion('B') },
  },
  {
    name: 'Nykthos, Shrine to Nyx',
    types: ['Land'],
    supertypes: ['Legendary'],
    // "{T}: Add {C}." / "{2}, {T}: Choose a color. Add an amount of mana of that color equal to your
    //  devotion to that color."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C') },
      {
        kind: 'activated',
        cost: { mana: '{2}', tap: true },
        isMana: true,
        produces: ['W', 'U', 'B', 'R', 'G'],
        chooseColor: true,
        manaEqualToDevotion: true,
        effect: addMana('W'),
      },
    ],
  },
  {
    name: 'Foundry Inspector',
    types: ['Artifact', 'Creature'],
    subtypes: ['Construct'],
    manaCost: '{3}',
    power: 3,
    toughness: 2,
    // "Artifact spells you cast cost {1} less to cast."
    spellCostReduction: { amount: 1, types: ['Artifact'] },
  },
  medallion('Jet Medallion', 'B'),
  medallion('Ruby Medallion', 'R'),
  medallion('Sapphire Medallion', 'U'),
  medallion('Emerald Medallion', 'G'),
  medallion('Pearl Medallion', 'W'),
  // the original dual lands (untapped, real basic land types — fetchable)
  dualLand('Underground Sea', 'U', 'B', ['Island', 'Swamp']),
  dualLand('Volcanic Island', 'U', 'R', ['Island', 'Mountain']),
  dualLand('Tropical Island', 'G', 'U', ['Forest', 'Island']),
  dualLand('Tundra', 'W', 'U', ['Plains', 'Island']),
  dualLand('Badlands', 'B', 'R', ['Swamp', 'Mountain']),
  dualLand('Scrubland', 'W', 'B', ['Plains', 'Swamp']),
  dualLand('Bayou', 'B', 'G', ['Swamp', 'Forest']),
  dualLand('Plateau', 'R', 'W', ['Mountain', 'Plains']),
  dualLand('Savannah', 'G', 'W', ['Forest', 'Plains']),
  dualLand('Taiga', 'R', 'G', ['Mountain', 'Forest']),
  // the tri-lands (Shards of Alara / Khans of Tarkir)
  triLand('Arcane Sanctum', 'W', 'U', 'B'),
  triLand('Crumbling Necropolis', 'U', 'B', 'R'),
  triLand('Savage Lands', 'B', 'R', 'G'),
  triLand('Jungle Shrine', 'R', 'G', 'W'),
  triLand('Seaside Citadel', 'G', 'W', 'U'),
  triLand('Nomad Outpost', 'R', 'W', 'B'),
  triLand('Mystic Monastery', 'U', 'R', 'W'),
  triLand('Opulent Palace', 'B', 'G', 'U'),
  triLand('Frontier Bivouac', 'G', 'U', 'R'),
  triLand('Sandsteppe Citadel', 'W', 'B', 'G'),
  // the Triomes (three basic land types + Cycling {3})
  triome('Ketria Triome', 'G', 'U', 'R', ['Forest', 'Island', 'Mountain']),
  triome("Jetmir's Garden", 'R', 'G', 'W', ['Mountain', 'Forest', 'Plains']),
  triome("Spara's Headquarters", 'G', 'W', 'U', ['Forest', 'Plains', 'Island']),
  triome('Indatha Triome', 'W', 'B', 'G', ['Plains', 'Swamp', 'Forest']),
  triome('Raugrin Triome', 'U', 'R', 'W', ['Island', 'Mountain', 'Plains']),
  triome('Savai Triome', 'R', 'W', 'B', ['Mountain', 'Plains', 'Swamp']),
  triome('Zagoth Triome', 'B', 'G', 'U', ['Swamp', 'Forest', 'Island']),
  triome("Raffine's Tower", 'W', 'U', 'B', ['Plains', 'Island', 'Swamp']),
  triome("Xander's Lounge", 'U', 'B', 'R', ['Island', 'Swamp', 'Mountain']),
  triome("Ziatora's Proving Ground", 'B', 'R', 'G', ['Swamp', 'Mountain', 'Forest']),
  // the artifact lands
  artifactLand('Seat of the Synod', 'U'),
  artifactLand('Great Furnace', 'R'),
  artifactLand('Tree of Tales', 'G'),
  artifactLand('Ancient Den', 'W'),
  artifactLand('Vault of Whispers', 'B'),
  {
    name: 'Darksteel Citadel',
    types: ['Artifact', 'Land'],
    keywords: ['indestructible'],
    // "Indestructible. {T}: Add {C}."
    abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C') }],
  },

  // --- Coverage batch CARD27: the reveal lands, a static extra land drop, and six singles ---
  revealLand('Choked Estuary', 'U', 'B', ['Island', 'Swamp']),
  revealLand('Foreboding Ruins', 'B', 'R', ['Swamp', 'Mountain']),
  revealLand('Frostboil Snarl', 'U', 'R', ['Island', 'Mountain']),
  revealLand('Fortified Village', 'G', 'W', ['Forest', 'Plains']),
  revealLand('Port Town', 'W', 'U', ['Plains', 'Island']),
  revealLand('Furycalm Snarl', 'R', 'W', ['Mountain', 'Plains']),
  revealLand('Game Trail', 'R', 'G', ['Mountain', 'Forest']),
  revealLand('Shineshadow Snarl', 'W', 'B', ['Plains', 'Swamp']),
  revealLand('Necroblossom Snarl', 'B', 'G', ['Swamp', 'Forest']),
  revealLand('Vineglimmer Snarl', 'G', 'U', ['Forest', 'Island']),
  {
    name: 'Exploration',
    types: ['Enchantment'],
    manaCost: '{G}',
    colors: ['G'],
    // "You may play an additional land on each of your turns."
    extraLandDrops: 1,
  },
  {
    name: 'Infernal Grasp',
    types: ['Instant'],
    manaCost: '{1}{B}',
    colors: ['B'],
    // "Destroy target creature. You lose 2 life."
    spell: { targets: [{ kind: 'creature', count: 1 }], effect: sequence(destroyTarget(), loseLife(2)) },
  },
  {
    name: 'Withering Torment',
    types: ['Instant'],
    manaCost: '{2}{B}',
    colors: ['B'],
    // "Destroy target creature or enchantment. You lose 2 life."
    spell: {
      targets: [{ kind: 'permanent', count: 1, filter: { types: ['Creature', 'Enchantment'] } }],
      effect: sequence(destroyPermanent(), loseLife(2)),
    },
  },
  {
    name: 'Exsanguinate',
    types: ['Sorcery'],
    manaCost: '{X}{B}{B}',
    colors: ['B'],
    // "Each opponent loses X life. You gain life equal to the life lost this way."
    spell: { effect: drainEachOpponentX() },
  },
  {
    name: 'Basilisk Collar',
    types: ['Artifact'],
    subtypes: ['Equipment'],
    manaCost: '{1}',
    // "Equipped creature has deathtouch and lifelink. Equip {1}"
    equipCost: '{1}',
    grantsToHost: { keywords: ['deathtouch', 'lifelink'] },
  },
  {
    name: 'Skyshroud Claim',
    types: ['Sorcery'],
    manaCost: '{3}{G}',
    colors: ['G'],
    // "Search your library for up to two Forest cards, put them onto the battlefield, then shuffle."
    spell: { effect: searchLibrary({ filter: { landSubtypes: ['Forest'] }, dest: 'battlefield', count: 2 }) },
  },
  {
    name: 'Diabolic Intent',
    types: ['Sorcery'],
    manaCost: '{1}{B}',
    colors: ['B'],
    // "As an additional cost to cast this spell, sacrifice a creature. Search your library for a
    //  card, put that card into your hand, then shuffle."
    additionalCost: { sacrifice: { count: 1, filter: 'creature' } },
    spell: { effect: searchLibrary({ filter: 'any', dest: 'hand', count: 1 }) },
  },
  {
    name: 'Aetherize',
    types: ['Instant'],
    manaCost: '{3}{U}',
    colors: ['U'],
    // "Return all attacking creatures to their owner's hand."
    spell: { effect: returnAllAttackersToHand() },
  },
  {
    name: 'Morbid Opportunist',
    types: ['Creature'],
    subtypes: ['Human', 'Wizard'],
    manaCost: '{2}{B}',
    colors: ['B'],
    power: 1,
    toughness: 3,
    // "Whenever one or more other creatures die, draw a card. This ability triggers only once each turn."
    dies: { watch: { scope: 'anyCreature', excludeSelf: true }, oncePerTurn: true, effect: drawCards(1) },
  },

  // --- Coverage batch CARD28: the Karoo lands, landfall, and five singles ---
  karooLand('Simic Growth Chamber', 'G', 'U'),
  karooLand('Golgari Rot Farm', 'B', 'G'),
  karooLand('Dimir Aqueduct', 'U', 'B'),
  karooLand('Orzhov Basilica', 'W', 'B'),
  karooLand('Izzet Boilerworks', 'U', 'R'),
  karooLand('Gruul Turf', 'R', 'G'),
  karooLand('Azorius Chancery', 'W', 'U'),
  karooLand('Boros Garrison', 'R', 'W'),
  karooLand('Rakdos Carnarium', 'B', 'R'),
  karooLand('Selesnya Sanctuary', 'G', 'W'),
  {
    name: 'Azusa, Lost but Seeking',
    types: ['Creature'],
    supertypes: ['Legendary'],
    subtypes: ['Human', 'Monk'],
    manaCost: '{2}{G}',
    colors: ['G'],
    power: 1,
    toughness: 2,
    // "You may play two additional lands on each of your turns."
    extraLandDrops: 2,
  },
  {
    name: 'Seething Song',
    types: ['Sorcery'],
    manaCost: '{2}{R}',
    colors: ['R'],
    // "Add {R}{R}{R}{R}{R}."
    spell: { effect: addMana('R', 'R', 'R', 'R', 'R') },
  },
  {
    name: 'Mana Geyser',
    types: ['Sorcery'],
    manaCost: '{3}{R}{R}',
    colors: ['R'],
    // "Add {R} for each tapped land your opponents control."
    spell: { effect: addManaPerOpponentTappedLand('R') },
  },
  {
    name: 'Entomb',
    types: ['Instant'],
    manaCost: '{B}',
    colors: ['B'],
    // "Search your library for a card, put that card into your graveyard, then shuffle."
    spell: { effect: searchLibrary({ filter: 'any', dest: 'graveyard', count: 1 }) },
  },
  {
    name: 'Baleful Strix',
    types: ['Artifact', 'Creature'],
    subtypes: ['Bird'],
    manaCost: '{U}{B}',
    colors: ['U', 'B'],
    power: 1,
    toughness: 1,
    keywords: ['flying', 'deathtouch'],
    // "Flying, deathtouch. When this creature enters, draw a card."
    enters: { effect: drawCards(1) },
  },
  {
    name: 'Whispersilk Cloak',
    types: ['Artifact'],
    subtypes: ['Equipment'],
    manaCost: '{3}',
    // "Equipped creature can't be blocked and has shroud. Equip {2}"
    equipCost: '{2}',
    grantsToHost: { keywords: ['shroud'], cantBeBlocked: true },
  },
  {
    name: 'Rampaging Baloths',
    types: ['Creature'],
    subtypes: ['Beast'],
    manaCost: '{4}{G}{G}',
    colors: ['G'],
    power: 6,
    toughness: 6,
    keywords: ['trample'],
    // "Trample. Landfall — Whenever a land you control enters, create a 4/4 green Beast creature token."
    landEnters: { effect: createToken({ name: 'Beast', power: 4, toughness: 4, subtypes: ['Beast'] }) },
  },

  // --- Coverage batch CARD29: typed cast triggers, an intervening "if", mana-value targeting ---
  {
    name: "Nature's Claim",
    types: ['Instant'],
    manaCost: '{G}',
    colors: ['G'],
    // "Destroy target artifact or enchantment. Its controller gains 4 life."
    spell: {
      targets: [{ kind: 'permanent', count: 1, filter: { types: ['Artifact', 'Enchantment'] } }],
      effect: destroyPermanentControllerGains(4),
    },
  },
  {
    name: 'Buried Alive',
    types: ['Sorcery'],
    manaCost: '{2}{B}',
    colors: ['B'],
    // "Search your library for up to three creature cards, put them into your graveyard, then shuffle."
    spell: { effect: searchLibrary({ filter: { types: ['Creature'] }, dest: 'graveyard', count: 3 }) },
  },
  {
    name: 'Shamanic Revelation',
    types: ['Sorcery'],
    manaCost: '{3}{G}{G}',
    colors: ['G'],
    // "Draw a card for each creature you control. Ferocious — You gain 4 life for each creature you
    //  control with power 4 or greater."
    spell: { effect: sequence(drawPerControlledCreature(), gainLifePerBigCreature(4, 4)) },
  },
  {
    name: 'Despark',
    types: ['Instant'],
    manaCost: '{W}{B}',
    colors: ['W', 'B'],
    // "Exile target permanent with mana value 4 or greater."
    spell: { targets: [{ kind: 'permanent', count: 1, filter: { minManaValue: 4 } }], effect: exileTarget() },
  },
  {
    name: 'Guttersnipe',
    types: ['Creature'],
    subtypes: ['Goblin', 'Shaman'],
    manaCost: '{2}{R}',
    colors: ['R'],
    power: 2,
    toughness: 2,
    // "Whenever you cast an instant or sorcery spell, this creature deals 2 damage to each opponent."
    castSpell: { watch: { selfOnly: true, typesOnly: ['Instant', 'Sorcery'] }, effect: dealToEachOpponent(2) },
  },
  {
    name: 'Archmage Emeritus',
    types: ['Creature'],
    subtypes: ['Human', 'Wizard'],
    manaCost: '{2}{U}{U}',
    colors: ['U'],
    power: 2,
    toughness: 2,
    // "Magecraft — Whenever you cast or copy an instant or sorcery spell, draw a card." (the engine
    //  has no spell copies, so casting is the whole of it here)
    castSpell: { watch: { selfOnly: true, typesOnly: ['Instant', 'Sorcery'] }, effect: drawCards(1) },
  },
  {
    name: 'Aetherflux Reservoir',
    types: ['Artifact'],
    manaCost: '{4}',
    // "Whenever you cast a spell, you gain 1 life for each spell you've cast this turn."
    castSpell: { watch: { selfOnly: true }, effect: gainLifePerSpellThisTurn() },
    // "Pay 50 life: This artifact deals 50 damage to any target."
    abilities: [
      {
        kind: 'activated',
        cost: { life: 50 },
        targets: [{ kind: 'anyTarget', count: 1 }],
        effect: dealDamage(50),
      },
    ],
  },
  {
    name: 'Land Tax',
    types: ['Enchantment'],
    manaCost: '{W}',
    colors: ['W'],
    // "At the beginning of your upkeep, IF an opponent controls more lands than you, you may search
    //  your library for up to three basic land cards, reveal them, put them into your hand, then
    //  shuffle." (the search itself is optional by taking nothing)
    upkeep: {
      condition: (state, controllerId) =>
        state.turnOrder.some(
          (pid) => pid !== controllerId && !state.players[pid]!.hasLost && controlledLands(state, pid) > controlledLands(state, controllerId),
        ),
      effect: searchLibrary({ filter: 'basicLand', dest: 'hand', count: 3, reveal: true }),
    },
  },

  // --- Coverage batch CARD30: surveil (Consider + the ten surveil lands) and the horizon lands ---
  {
    name: 'Consider',
    types: ['Instant'],
    manaCost: '{U}',
    colors: ['U'],
    // "Surveil 1. Draw a card." (the draw waits for the surveil, like Opt's)
    spell: { effect: surveil(1, { thenDraw: 1 }) },
  },
  surveilLand('Undercity Sewers', 'U', 'B', ['Island', 'Swamp']),
  surveilLand('Underground Mortuary', 'B', 'G', ['Swamp', 'Forest']),
  surveilLand('Hedge Maze', 'G', 'U', ['Forest', 'Island']),
  surveilLand('Raucous Theater', 'B', 'R', ['Swamp', 'Mountain']),
  surveilLand('Shadowy Backstreet', 'W', 'B', ['Plains', 'Swamp']),
  surveilLand('Thundering Falls', 'U', 'R', ['Island', 'Mountain']),
  surveilLand('Commercial District', 'R', 'G', ['Mountain', 'Forest']),
  surveilLand('Meticulous Archive', 'W', 'U', ['Plains', 'Island']),
  surveilLand('Lush Portico', 'G', 'W', ['Forest', 'Plains']),
  surveilLand('Elegant Parlor', 'R', 'W', ['Mountain', 'Plains']),
  // the horizon lands: "{T}, Pay 1 life: Add {a} or {b}" / "{1}, {T}, Sacrifice: Draw a card"
  horizonLand('Horizon Canopy', 'G', 'W'),
  horizonLand('Silent Clearing', 'W', 'B'),
  horizonLand('Sunbaked Canyon', 'R', 'W'),
  horizonLand('Nurturing Peatland', 'B', 'G'),
  horizonLand('Waterlogged Grove', 'G', 'U'),
  horizonLand('Fiery Islet', 'U', 'R'),

  // --- Coverage batch CARD31: metalcraft, dynamic mana colours, sac-for-mana, Grand Abolisher ---
  {
    name: 'Decanter of Endless Water',
    types: ['Artifact'],
    manaCost: '{3}',
    // "You have no maximum hand size. {T}: Add one mana of any color."
    noMaxHandSize: true,
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['W', 'U', 'B', 'R', 'G'], chooseColor: true, effect: addMana('W') },
    ],
  },
  {
    name: 'Mox Opal',
    types: ['Artifact'],
    supertypes: ['Legendary'],
    manaCost: '{0}',
    // "Metalcraft — {T}: Add one mana of any color. Activate only if you control three or more artifacts."
    abilities: [
      {
        kind: 'activated',
        cost: { tap: true },
        isMana: true,
        produces: ['W', 'U', 'B', 'R', 'G'],
        chooseColor: true,
        requiresArtifactsAtLeast: 3,
        effect: addMana('W'),
      },
    ],
  },
  {
    name: 'Mox Amber',
    types: ['Artifact'],
    supertypes: ['Legendary'],
    manaCost: '{0}',
    // "{T}: Add one mana of any color among legendary creatures and planeswalkers you control."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, chooseColor: true, dynamicProduces: 'yourLegendaries', effect: addMana('W') },
    ],
  },
  {
    name: 'Reflecting Pool',
    types: ['Land'],
    // "{T}: Add one mana of any type that a land you control could produce."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, chooseColor: true, dynamicProduces: 'yourLands', effect: addMana('C') },
    ],
  },
  {
    name: "Ashnod's Altar",
    types: ['Artifact'],
    manaCost: '{3}',
    // "Sacrifice a creature: Add {C}{C}." (no {T} — repeatable while creatures last)
    abilities: [
      {
        kind: 'activated',
        cost: { sacrifice: { count: 1, filter: 'creature' } },
        isMana: true,
        produces: ['C'],
        effect: addMana('C', 'C'),
      },
    ],
  },
  {
    name: 'Phyrexian Altar',
    types: ['Artifact'],
    manaCost: '{3}',
    // "Sacrifice a creature: Add one mana of any color."
    abilities: [
      {
        kind: 'activated',
        cost: { sacrifice: { count: 1, filter: 'creature' } },
        isMana: true,
        produces: ['W', 'U', 'B', 'R', 'G'],
        chooseColor: true,
        effect: addMana('W'),
      },
    ],
  },
  {
    name: 'Phyrexian Tower',
    types: ['Land'],
    // "{T}: Add {C}." / "{T}, Sacrifice a creature: Add {B}{B}."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['C'], effect: addMana('C') },
      {
        kind: 'activated',
        cost: { tap: true, sacrifice: { count: 1, filter: 'creature' } },
        isMana: true,
        produces: ['B'],
        effect: addMana('B', 'B'),
      },
    ],
  },
  {
    name: 'Bloom Tender',
    types: ['Creature'],
    subtypes: ['Elf', 'Druid'],
    manaCost: '{1}{G}',
    colors: ['G'],
    power: 1,
    toughness: 1,
    // "Vivid — {T}: For each color among permanents you control, add one mana of that color."
    abilities: [
      { kind: 'activated', cost: { tap: true }, isMana: true, produces: ['W', 'U', 'B', 'R', 'G'], effect: addManaPerColorAmongPermanents() },
    ],
  },
  {
    name: 'Gamble',
    types: ['Sorcery'],
    manaCost: '{R}',
    colors: ['R'],
    // "Search your library for a card, put that card into your hand, discard a card at random, then
    //  shuffle." (the discard happens as the search is answered — see r.search)
    spell: { effect: sequence(searchLibrary({ filter: 'any', dest: 'hand', count: 1 }), discardAtRandom(1)) },
  },
  {
    name: 'Grand Abolisher',
    types: ['Creature'],
    subtypes: ['Human', 'Cleric'],
    manaCost: '{W}{W}',
    colors: ['W'],
    power: 2,
    toughness: 2,
    // "During your turn, your opponents can't cast spells or activate abilities of artifacts,
    //  creatures, or enchantments."
    opponentsCantActOnYourTurn: true,
  },
]
