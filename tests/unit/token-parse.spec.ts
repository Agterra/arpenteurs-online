import { describe, expect, it } from 'vitest'
import { parseTokenSuggestions } from '../../shared/utils/tokenParse.ts'

/** Corpus of real oracle texts (Scryfall wording) → expected TokenSpec extractions. */

describe('no-ops', () => {
  it('Rhystic Study (no create)', () => {
    expect(
      parseTokenSuggestions(
        "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.",
      ),
    ).toEqual([])
  })

  it('Counterspell', () => {
    expect(parseTokenSuggestions('Counter target spell.')).toEqual([])
  })

  it('empty / garbage input', () => {
    expect(parseTokenSuggestions('')).toEqual([])
    expect(parseTokenSuggestions('create create tokens tokens')).toEqual([])
  })

  it('Anointed Procession (token doubler, no concrete token)', () => {
    expect(
      parseTokenSuggestions(
        'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.',
      ),
    ).toEqual([])
  })

  it('Scute Swarm copy sentence is skipped, plain token kept', () => {
    const specs = parseTokenSuggestions(
      "Whenever a land you control enters, create a 1/1 green Insect creature token. If you control six or more lands, create a token that's a copy of Scute Swarm instead.",
    )
    expect(specs).toEqual([
      {
        name: 'Insect',
        pt: '1/1',
        colors: ['G'],
        typeLine: 'Token Creature — Insect',
        text: '',
        fromCatalogId: null,
      },
    ])
  })
})

describe('stage 1 — named artifact tokens', () => {
  it('Smothering Tithe → Treasure', () => {
    const specs = parseTokenSuggestions(
      'Whenever an opponent draws a card, that player may pay {2}. If the player doesn\'t, you create a Treasure token.',
    )
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({
      name: 'Treasure',
      pt: null,
      colors: [],
      typeLine: 'Token Artifact — Treasure',
    })
    expect(specs[0]!.text).toContain('Add one mana of any color')
  })

  it('Dockside Extortionist → Treasure (X quantity)', () => {
    const specs = parseTokenSuggestions(
      'When Dockside Extortionist enters, create X Treasure tokens, where X is the number of artifacts and enchantments your opponents control.',
    )
    expect(specs.map((s) => s.name)).toEqual(['Treasure'])
  })

  it("Old Gnawbone → Treasure ('that many' quantity)", () => {
    const specs = parseTokenSuggestions(
      'Flying\nWhenever a creature you control deals combat damage to a player, create that many Treasure tokens.',
    )
    expect(specs.map((s) => s.name)).toEqual(['Treasure'])
  })

  it('Gilded Goose → Food', () => {
    const specs = parseTokenSuggestions(
      'Flying\nWhen Gilded Goose enters, create a Food token.\n{1}{G}, {T}: Create a Food token.\n{T}, Sacrifice a Food: Add one mana of any color.',
    )
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ name: 'Food', typeLine: 'Token Artifact — Food' })
    expect(specs[0]!.text).toContain('You gain 3 life')
  })

  it('Tireless Tracker → Clue (from reminder text)', () => {
    const specs = parseTokenSuggestions(
      "Whenever a land you control enters, investigate. (Create a Clue token. It's an artifact with \"{2}, Sacrifice this artifact: Draw a card.\")\nWhenever you sacrifice a Clue, put a +1/+1 counter on Tireless Tracker.",
    )
    expect(specs.map((s) => s.name)).toEqual(['Clue'])
    expect(specs[0]!.text).toBe('{2}, Sacrifice this artifact: Draw a card.')
  })

  it('Bloodtithe Harvester → Blood', () => {
    const specs = parseTokenSuggestions(
      'When Bloodtithe Harvester enters, create a Blood token.\n{T}, Sacrifice Bloodtithe Harvester: Target creature gets -X/-X until end of turn, where X is twice the number of Blood tokens you control.',
    )
    expect(specs.map((s) => s.name)).toEqual(['Blood'])
  })

  it('Curse of Opulence → Gold', () => {
    const specs = parseTokenSuggestions(
      'Enchant player\nWhenever enchanted player is attacked, create a Gold token. Each opponent attacking that player does the same.',
    )
    expect(specs.map((s) => s.name)).toEqual(['Gold'])
    expect(specs[0]!.typeLine).toBe('Token Artifact — Gold')
  })

  it('Spyglass Siren → Map', () => {
    const specs = parseTokenSuggestions('Flying\nWhen Spyglass Siren enters, create a Map token.')
    expect(specs.map((s) => s.name)).toEqual(['Map'])
  })

  it('Stern Lesson → tapped Powerstone', () => {
    const specs = parseTokenSuggestions('Draw two cards, then discard a card. Create a tapped Powerstone token.')
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ name: 'Powerstone', typeLine: 'Token Artifact — Powerstone' })
    expect(specs[0]!.text).toContain('{T}: Add {C}')
  })

  it('Sunfall → Incubator (incubate reminder)', () => {
    const specs = parseTokenSuggestions(
      'Exile all creatures, then incubate X, where X is the number of creatures exiled this way. (Create an Incubator token with X +1/+1 counters on it, then transform it.)',
    )
    expect(specs.map((s) => s.name)).toEqual(['Incubator'])
  })

  it('Academy Manufactor → Clue, Food and Treasure from one clause', () => {
    const specs = parseTokenSuggestions(
      'If you would create a Clue, Food, or Treasure token, instead create one of each.',
    )
    expect(specs.map((s) => s.name).sort()).toEqual(['Clue', 'Food', 'Treasure'])
  })
})

describe('stage 2 — creature/land token grammar', () => {
  it('Krenko, Mob Boss (X quantity)', () => {
    const specs = parseTokenSuggestions(
      '{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.',
    )
    expect(specs).toEqual([
      { name: 'Goblin', pt: '1/1', colors: ['R'], typeLine: 'Token Creature — Goblin', text: '', fromCatalogId: null },
    ])
  })

  it('Avenger of Zendikar (for-each tail is not an ability)', () => {
    const specs = parseTokenSuggestions(
      'When Avenger of Zendikar enters, create a 0/1 green Plant creature token for each land you control.\nLandfall — Whenever a land you control enters, you may put a +1/+1 counter on each Plant creature you control.',
    )
    expect(specs).toEqual([
      { name: 'Plant', pt: '0/1', colors: ['G'], typeLine: 'Token Creature — Plant', text: '', fromCatalogId: null },
    ])
  })

  it('Lingering Souls (word quantity + with-ability)', () => {
    const specs = parseTokenSuggestions(
      'Create two 1/1 white Spirit creature tokens with flying.\nFlashback {1}{B}',
    )
    expect(specs).toEqual([
      { name: 'Spirit', pt: '1/1', colors: ['W'], typeLine: 'Token Creature — Spirit', text: 'Flying', fromCatalogId: null },
    ])
  })

  it('Spectral Procession', () => {
    const specs = parseTokenSuggestions('Create three 1/1 white Spirit creature tokens with flying.')
    expect(specs[0]).toMatchObject({ name: 'Spirit', pt: '1/1', colors: ['W'], text: 'Flying' })
  })

  it('Grave Titan', () => {
    const specs = parseTokenSuggestions(
      'Deathtouch\nWhenever Grave Titan enters or attacks, create two 2/2 black Zombie creature tokens.',
    )
    expect(specs).toEqual([
      { name: 'Zombie', pt: '2/2', colors: ['B'], typeLine: 'Token Creature — Zombie', text: '', fromCatalogId: null },
    ])
  })

  it('Bitterblossom (two-word subtype)', () => {
    const specs = parseTokenSuggestions(
      'At the beginning of your upkeep, you lose 1 life and create a 1/1 black Faerie Rogue creature token with flying.',
    )
    expect(specs).toEqual([
      {
        name: 'Faerie Rogue',
        pt: '1/1',
        colors: ['B'],
        typeLine: 'Token Creature — Faerie Rogue',
        text: 'Flying',
        fromCatalogId: null,
      },
    ])
  })

  it('Secure the Wastes (X quantity)', () => {
    const specs = parseTokenSuggestions('Create X 1/1 white Warrior creature tokens.')
    expect(specs).toEqual([
      { name: 'Warrior', pt: '1/1', colors: ['W'], typeLine: 'Token Creature — Warrior', text: '', fromCatalogId: null },
    ])
  })

  it("Cadira, Caller of the Small ('that many' quantity)", () => {
    const specs = parseTokenSuggestions(
      'Whenever Cadira, Caller of the Small deals combat damage to a player, create that many 1/1 white Rabbit creature tokens.',
    )
    expect(specs).toEqual([
      { name: 'Rabbit', pt: '1/1', colors: ['W'], typeLine: 'Token Creature — Rabbit', text: '', fromCatalogId: null },
    ])
  })

  it('Assemble the Legion (multicolor + tail cut at "for each")', () => {
    const specs = parseTokenSuggestions(
      'At the beginning of your upkeep, put a muster counter on Assemble the Legion. Then create a 1/1 red and white Soldier creature token with haste for each muster counter on it.',
    )
    expect(specs).toEqual([
      {
        name: 'Soldier',
        pt: '1/1',
        colors: ['W', 'R'],
        typeLine: 'Token Creature — Soldier',
        text: 'Haste',
        fromCatalogId: null,
      },
    ])
  })

  it('Godsire (three comma-separated colors)', () => {
    const specs = parseTokenSuggestions(
      'Vigilance\n{T}: Create an 8/8 red, green, and white Beast creature token.',
    )
    expect(specs).toEqual([
      { name: 'Beast', pt: '8/8', colors: ['W', 'R', 'G'], typeLine: 'Token Creature — Beast', text: '', fromCatalogId: null },
    ])
  })

  it('Brood Monitor (colorless + two-word subtype)', () => {
    const specs = parseTokenSuggestions(
      'When Brood Monitor enters, create three 1/1 colorless Eldrazi Scion creature tokens.',
    )
    expect(specs).toEqual([
      {
        name: 'Eldrazi Scion',
        pt: '1/1',
        colors: [],
        typeLine: 'Token Creature — Eldrazi Scion',
        text: '',
        fromCatalogId: null,
      },
    ])
  })

  it('Awaken the Woods (tapped land tokens, X quantity)', () => {
    const specs = parseTokenSuggestions('Create X tapped Forest land tokens.')
    expect(specs).toEqual([
      { name: 'Forest', pt: null, colors: [], typeLine: 'Token Land — Forest', text: '', fromCatalogId: null },
    ])
  })

  it('Hornet Queen (multi-ability with-tail)', () => {
    const specs = parseTokenSuggestions(
      'Flying, deathtouch\nWhen Hornet Queen enters, create four 1/1 green Insect creature tokens with flying and deathtouch.',
    )
    expect(specs).toEqual([
      {
        name: 'Insect',
        pt: '1/1',
        colors: ['G'],
        typeLine: 'Token Creature — Insect',
        text: 'Flying and deathtouch',
        fromCatalogId: null,
      },
    ])
  })

  it('Wingmate Roc (raid clause)', () => {
    const specs = parseTokenSuggestions(
      'Flying\nRaid — When Wingmate Roc enters, if you attacked this turn, create a 3/4 white Bird creature token with flying.',
    )
    expect(specs).toEqual([
      { name: 'Bird', pt: '3/4', colors: ['W'], typeLine: 'Token Creature — Bird', text: 'Flying', fromCatalogId: null },
    ])
  })

  it('Master of the Wild Hunt', () => {
    const specs = parseTokenSuggestions(
      'At the beginning of your upkeep, create a 2/2 green Wolf creature token.',
    )
    expect(specs[0]).toMatchObject({ name: 'Wolf', pt: '2/2', colors: ['G'] })
  })

  it('Tendershoot Dryad (ascend text around it)', () => {
    const specs = parseTokenSuggestions(
      'Ascend\nAt the beginning of each upkeep, create a 1/1 green Saproling creature token.\nSaprolings you control get +2/+2 as long as you have the city\'s blessing.',
    )
    expect(specs).toEqual([
      { name: 'Saproling', pt: '1/1', colors: ['G'], typeLine: 'Token Creature — Saproling', text: '', fromCatalogId: null },
    ])
  })

  it("Master of Waves ('a number of' phrasing)", () => {
    const specs = parseTokenSuggestions(
      'Protection from red\nElemental creatures you control get +1/+1.\nWhen Master of Waves enters, create a number of 1/0 blue Elemental creature tokens equal to your devotion to blue.',
    )
    expect(specs).toEqual([
      { name: 'Elemental', pt: '1/0', colors: ['U'], typeLine: 'Token Creature — Elemental', text: '', fromCatalogId: null },
    ])
  })

  it('Precursor Golem (artifact creature type line)', () => {
    const specs = parseTokenSuggestions(
      'When Precursor Golem enters, create two 3/3 colorless Golem artifact creature tokens.',
    )
    expect(specs).toEqual([
      {
        name: 'Golem',
        pt: '3/3',
        colors: [],
        typeLine: 'Token Artifact Creature — Golem',
        text: '',
        fromCatalogId: null,
      },
    ])
  })

  it('Wurmcoil Engine (two tokens in one sentence)', () => {
    const specs = parseTokenSuggestions(
      'Deathtouch, lifelink\nWhen Wurmcoil Engine dies, create a 3/3 colorless Phyrexian Wurm artifact creature token with deathtouch and a 3/3 colorless Phyrexian Wurm artifact creature token with lifelink.',
    )
    expect(specs).toEqual([
      {
        name: 'Phyrexian Wurm',
        pt: '3/3',
        colors: [],
        typeLine: 'Token Artifact Creature — Phyrexian Wurm',
        text: 'Deathtouch',
        fromCatalogId: null,
      },
      {
        name: 'Phyrexian Wurm',
        pt: '3/3',
        colors: [],
        typeLine: 'Token Artifact Creature — Phyrexian Wurm',
        text: 'Lifelink',
        fromCatalogId: null,
      },
    ])
  })

  it('Skrelv\'s Hive (quoted granted ability kept in text)', () => {
    const specs = parseTokenSuggestions(
      "At the beginning of your upkeep, you lose 1 life and create a 1/1 colorless Phyrexian Mite artifact creature token with toxic 1 and \"This creature can't block.\"",
    )
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({
      name: 'Phyrexian Mite',
      pt: '1/1',
      colors: [],
      typeLine: 'Token Artifact Creature — Phyrexian Mite',
    })
    expect(specs[0]!.text.toLowerCase()).toContain('toxic 1')
  })

  it('digit quantities are accepted', () => {
    const specs = parseTokenSuggestions('Create 30 1/1 white Cat creature tokens.')
    expect(specs[0]).toMatchObject({ name: 'Cat', pt: '1/1', colors: ['W'] })
  })

  it('*/* power/toughness', () => {
    const specs = parseTokenSuggestions(
      "Create a */* green Ooze creature token, where its power and toughness are each equal to the number of creature cards in your graveyard.",
    )
    expect(specs[0]).toMatchObject({ name: 'Ooze', pt: '*/*', colors: ['G'] })
  })

  it('deduplicates identical specs across sentences', () => {
    const specs = parseTokenSuggestions(
      'When this enters, create a 1/1 white Soldier creature token. At the beginning of your upkeep, create a 1/1 white Soldier creature token.',
    )
    expect(specs).toHaveLength(1)
  })
})
