/**
 * M-R0 curated starter pool: basic lands, vanilla creatures, and simple spells
 * that exercise the whole spine (mana, timing, the stack, targeting, combat,
 * SBA). All are real Magic cards so decklists resolve from the catalog.
 */
import type { CardDefinition } from './dsl'
import {
  addCounters,
  addCountersToEachControlled,
  addMana,
  counterTarget,
  createToken,
  damageAllCreatures,
  dealDamage,
  dealToEachOpponent,
  destroyAllCreatures,
  destroyPermanent,
  destroyPermanentGrantToken,
  destroyTarget,
  drawCards,
  exileTarget,
  gainLifeEqualToPowerForController,
  returnToHand,
  eachOpponentLoses,
  gainLife,
  loseAllAbilities,
  loseLife,
  playersSacrifice,
  pump,
  pumpSelf,
  scry,
  searchLibrary,
  sequence,
  setBasePT,
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
    enters: { effect: drawCards(2) }, // (evoke omitted — plays as the 5-mana flyer)
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
]
