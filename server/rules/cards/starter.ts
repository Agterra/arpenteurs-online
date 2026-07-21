/**
 * M-R0 curated starter pool: basic lands, vanilla creatures, and simple spells
 * that exercise the whole spine (mana, timing, the stack, targeting, combat,
 * SBA). All are real Magic cards so decklists resolve from the catalog.
 */
import type { CardDefinition } from './dsl'
import { battlefieldCreatures } from '../state'
import {
  adapt,
  addCounters,
  addCountersToEachControlled,
  addLoyaltyToOtherPlaneswalkers,
  addMana,
  monstrosity,
  counterTarget,
  createToken,
  damageAllCreatures,
  dealDamage,
  dealDamageKicked,
  dealDamageX,
  dealToEachOpponent,
  dealToEachPlayer,
  destroyAllCreatures,
  destroyPermanent,
  destroyPermanentGrantToken,
  destroyTarget,
  drawCards,
  drawCardsX,
  earthquakeX,
  exileTarget,
  fight,
  gainAndDrawEqualToLands,
  gainLifeEqualToPowerForController,
  grantProtection,
  returnToHand,
  eachOpponentLoses,
  gainLife,
  gainLifeX,
  loseAllAbilities,
  loseLife,
  mill,
  playersDiscard,
  playersSacrifice,
  pump,
  weakenAllCreatures,
  weakenControlledCreatures,
  pumpSelf,
  returnFromGraveyard,
  scry,
  searchLibrary,
  sequence,
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

/** A scry-land: enters tapped, "When ~ enters, scry 1.", "{T}: Add {a} or {b}." */
const scryland = (name: string, a: ManaColor, b: ManaColor): CardDefinition => ({
  name,
  types: ['Land'],
  entersTapped: true,
  enters: { effect: scry(1) },
  abilities: [{ kind: 'activated', cost: { tap: true }, isMana: true, produces: [a, b], chooseColor: true, effect: addMana(a) }],
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
]
