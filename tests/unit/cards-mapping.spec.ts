import { describe, expect, it } from 'vitest'
import {
  skipReason,
  mapCard,
  mapCommanderLegality,
  buildAliases,
  extractImages,
  preferKey,
  type AtomicFace,
} from '../../scripts/lib/cards.ts'

const oid = (n: string) => `00000000-0000-0000-0000-00000000000${n}`

const solRing: AtomicFace[] = [
  {
    name: 'Sol Ring',
    layout: 'normal',
    manaCost: '{1}',
    manaValue: 1,
    type: 'Artifact',
    text: '{T}: Add {C}{C}.',
    colorIdentity: [],
    legalities: { commander: 'Legal', vintage: 'Restricted' },
    identifiers: { scryfallOracleId: oid('1') },
  },
]

const delver: AtomicFace[] = [
  {
    name: 'Delver of Secrets // Insectile Aberration',
    faceName: 'Delver of Secrets',
    side: 'a',
    layout: 'transform',
    manaCost: '{U}',
    manaValue: 1,
    type: 'Creature — Human Wizard',
    power: '1',
    toughness: '1',
    colors: ['U'],
    colorIdentity: ['U'],
    legalities: { commander: 'Legal' },
    identifiers: { scryfallOracleId: oid('2') },
  },
  {
    name: 'Delver of Secrets // Insectile Aberration',
    faceName: 'Insectile Aberration',
    side: 'b',
    layout: 'transform',
    manaValue: 1,
    faceManaValue: 0,
    type: 'Creature — Human Insect',
    power: '3',
    toughness: '2',
    colors: ['U'],
    colorIdentity: ['U'],
    legalities: { commander: 'Legal' },
    identifiers: { scryfallOracleId: oid('2') },
  },
]

const atraxa: AtomicFace[] = [
  {
    name: "Atraxa, Praetors' Voice",
    layout: 'normal',
    manaCost: '{G}{W}{U}{B}',
    manaValue: 4,
    type: 'Legendary Creature — Phyrexian Angel Horror',
    power: '4',
    toughness: '4',
    colorIdentity: ['B', 'G', 'U', 'W'],
    legalities: { commander: 'Legal' },
    leadershipSkills: { brawl: false, commander: true, oathbreaker: false },
    identifiers: { scryfallOracleId: oid('3') },
  },
]

describe('skipReason', () => {
  it('keeps normal commander-legal cards', () => {
    expect(skipReason('Sol Ring', solRing)).toBeNull()
  })
  it('skips vanguard/planar/scheme layouts', () => {
    for (const layout of ['vanguard', 'planar', 'scheme']) {
      expect(skipReason('X', [{ ...solRing[0]!, layout }])).toBe('layout')
    }
  })
  it('skips Alchemy rebalances by A- prefix', () => {
    expect(skipReason('A-Dragon\'s Rage Channeler', solRing)).toBe('alchemy')
  })
  it('skips reversible duplicate keys (identical halves)', () => {
    expect(
      skipReason('Adrix and Nev, Twincasters // Adrix and Nev, Twincasters', solRing),
    ).toBe('reversible_duplicate')
  })
  it('skips cards without commander legality by default', () => {
    const acorn = [{ ...solRing[0]!, legalities: {} }]
    expect(skipReason('Chicken à la King', acorn)).toBe('no_commander_legality')
  })
  it('keeps acorn cards with --include-acorn', () => {
    const acorn = [{ ...solRing[0]!, legalities: {} }]
    expect(skipReason('Chicken à la King', acorn, { includeAcorn: true })).toBeNull()
  })
  it('keeps banned cards (warn at deck validation, not import)', () => {
    const banned = [{ ...solRing[0]!, legalities: { commander: 'Banned' } }]
    expect(skipReason('Black Lotus', banned)).toBeNull()
  })
  it('skips faceless/oracle-less entries', () => {
    expect(skipReason('Broken', [{ ...solRing[0]!, identifiers: {} }])).toBe('no_oracle_id')
  })
})

describe('mapCommanderLegality', () => {
  it('maps all values', () => {
    expect(mapCommanderLegality({ commander: 'Legal' })).toBe('LEGAL')
    expect(mapCommanderLegality({ commander: 'Banned' })).toBe('BANNED')
    expect(mapCommanderLegality({ commander: 'Restricted' })).toBe('RESTRICTED')
    expect(mapCommanderLegality({})).toBe('NOT_LEGAL')
    expect(mapCommanderLegality(undefined)).toBe('NOT_LEGAL')
  })
})

describe('mapCard', () => {
  it('maps a normal card', () => {
    const row = mapCard('Sol Ring', solRing, {
      scryfallId: 'aaaaaaaa-0000-0000-0000-000000000000',
      imageSmall: 'https://cards.scryfall.io/small/front/a/a/aa.jpg?123',
      imageNormal: 'https://cards.scryfall.io/normal/front/a/a/aa.jpg?123',
      backImageSmall: null,
      backImageNormal: null,
    })
    expect(row.nameNorm).toBe('sol ring')
    expect(row.commanderLegality).toBe('LEGAL')
    expect(row.canBeCommander).toBe(false)
    expect(row.faces).toBeNull()
    expect(row.imageSmall).toContain('?123')
  })

  it('maps a transform card: joined type line, per-face json, faceNames', () => {
    const row = mapCard('Delver of Secrets // Insectile Aberration', delver, null)
    expect(row.faceNames).toEqual(['Delver of Secrets', 'Insectile Aberration'])
    expect(row.typeLine).toBe('Creature — Human Wizard // Creature — Human Insect')
    expect(row.manaCost).toBe('{U}') // back face has no cost
    expect(row.faces).toHaveLength(2)
    expect((row.faces as any[])[1].power).toBe('3')
    expect(row.imageSmall).toBeNull() // join miss tolerated
  })

  it('flags commanders via leadershipSkills', () => {
    expect(mapCard("Atraxa, Praetors' Voice", atraxa, null).canBeCommander).toBe(true)
  })
})

describe('buildAliases', () => {
  it('adds face names and front half for multiface cards', () => {
    const row = mapCard('Delver of Secrets // Insectile Aberration', delver, null)
    const aliases = buildAliases(row)
    expect(aliases).toContain('delver of secrets')
    expect(aliases).toContain('insectile aberration')
    expect(aliases).not.toContain(row.nameNorm)
  })

  it('covers the meld gotcha: pair entry aliases its front face', () => {
    const bruna: AtomicFace[] = [
      {
        name: 'Bruna, the Fading Light // Brisela, Voice of Nightmares',
        faceName: 'Bruna, the Fading Light',
        side: 'a',
        layout: 'meld',
        manaCost: '{5}{W}{W}',
        manaValue: 7,
        type: 'Legendary Creature — Angel Horror',
        legalities: { commander: 'Legal' },
        identifiers: { scryfallOracleId: oid('4') },
      },
    ]
    const row = mapCard('Bruna, the Fading Light // Brisela, Voice of Nightmares', bruna, null)
    expect(buildAliases(row)).toContain('bruna, the fading light')
  })

  it('adds normalized asciiName', () => {
    const row = mapCard(
      'Lim-Dûl the Necromancer',
      [{ ...solRing[0]!, name: 'Lim-Dûl the Necromancer', asciiName: 'Lim-Dul the Necromancer', identifiers: { scryfallOracleId: oid('5') } }],
      null,
    )
    // ascii form normalizes to the same as the diacritic form → excluded as own nameNorm
    expect(buildAliases(row)).not.toContain(row.nameNorm)
  })
})

describe('extractImages', () => {
  it('uses top-level image_uris when present (normal/split/adventure/meld)', () => {
    const out = extractImages({
      id: 'x',
      image_uris: { small: 's.jpg', normal: 'n.jpg' },
      card_faces: [{}, {}],
    })
    expect(out).toMatchObject({ imageSmall: 's.jpg', imageNormal: 'n.jpg', backImageSmall: null })
  })
  it('uses per-face images for transform/modal_dfc', () => {
    const out = extractImages({
      id: 'x',
      card_faces: [
        { image_uris: { small: 'f-s.jpg', normal: 'f-n.jpg' } },
        { image_uris: { small: 'b-s.jpg', normal: 'b-n.jpg' } },
      ],
    })
    expect(out).toMatchObject({
      imageSmall: 'f-s.jpg',
      backImageSmall: 'b-s.jpg',
      backImageNormal: 'b-n.jpg',
    })
  })
})

describe('preferKey', () => {
  it('prefers the plain key over the // duplicate', () => {
    expect(preferKey('Adrix and Nev // Adrix and Nev', 'Adrix and Nev')).toBe('Adrix and Nev')
    expect(preferKey('Adrix and Nev', 'Adrix and Nev // Adrix and Nev')).toBe('Adrix and Nev')
  })
})
