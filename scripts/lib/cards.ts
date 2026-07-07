/**
 * Pure mapping logic for the card import: MTGJSON AtomicCards face objects
 * joined with Scryfall oracle_cards images → Card rows + aliases.
 * No I/O here — everything is unit-tested in tests/unit/cards-mapping.spec.ts.
 */
import { norm } from '../../shared/utils/norm.ts'

// ---- Input shapes (loose: upstream schemas drift) ----

export interface AtomicFace {
  name: string
  faceName?: string
  side?: string
  layout?: string
  manaCost?: string
  manaValue?: number
  faceManaValue?: number
  type?: string
  text?: string
  power?: string
  toughness?: string
  loyalty?: string
  defense?: string
  colors?: string[]
  colorIdentity?: string[]
  keywords?: string[]
  supertypes?: string[]
  asciiName?: string
  edhrecRank?: number
  isFunny?: boolean
  hasAlternativeDeckLimit?: boolean
  legalities?: Record<string, string>
  leadershipSkills?: Record<string, boolean>
  identifiers?: Record<string, string>
}

export interface ScryfallImages {
  scryfallId: string
  imageSmall: string | null
  imageNormal: string | null
  backImageSmall: string | null
  backImageNormal: string | null
}

export interface CardRow {
  id: string
  scryfallOracleId: string
  scryfallId: string
  name: string
  nameNorm: string
  asciiName: string | null
  faceNames: string[]
  layout: string
  manaCost: string | null
  manaValue: number
  typeLine: string
  oracleText: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
  defense: string | null
  colors: string[]
  colorIdentity: string[]
  keywords: string[]
  supertypes: string[]
  commanderLegality: 'LEGAL' | 'BANNED' | 'RESTRICTED' | 'NOT_LEGAL'
  canBeCommander: boolean
  hasAltDeckLimit: boolean
  isFunny: boolean
  edhrecRank: number | null
  faces: unknown
  imageSmall: string | null
  imageNormal: string | null
  backImageSmall: string | null
  backImageNormal: string | null
}

// Not playable table cards (Vanguard avatars, planes, schemes)
const SKIP_LAYOUTS = new Set(['vanguard', 'planar', 'scheme'])

export type SkipReason =
  | 'layout'
  | 'alchemy'
  | 'reversible_duplicate'
  | 'no_commander_legality'
  | 'no_oracle_id'

/** Decide whether an AtomicCards entry should be excluded from the catalog. */
export function skipReason(
  name: string,
  faces: AtomicFace[],
  opts: { includeAcorn?: boolean } = {},
): SkipReason | null {
  const front = faces[0]
  if (!front) return 'no_oracle_id'
  if (SKIP_LAYOUTS.has(front.layout ?? '')) return 'layout'
  if (name.startsWith('A-')) return 'alchemy'
  if (name.includes(' // ')) {
    const [a, b] = name.split(' // ')
    // reversible_card degenerate keys ("X // X") duplicate the plain "X" entry
    if (a === b) return 'reversible_duplicate'
  }
  if (!front.identifiers?.scryfallOracleId) return 'no_oracle_id'
  if (!opts.includeAcorn && front.legalities?.commander === undefined)
    return 'no_commander_legality'
  return null
}

export function mapCommanderLegality(
  legalities: Record<string, string> | undefined,
): CardRow['commanderLegality'] {
  switch (legalities?.commander) {
    case 'Legal':
      return 'LEGAL'
    case 'Banned':
      return 'BANNED'
    case 'Restricted':
      return 'RESTRICTED'
    default:
      return 'NOT_LEGAL'
  }
}

/** Extract the image URLs we store from a Scryfall oracle_cards object. */
export function extractImages(sf: {
  id: string
  image_uris?: Record<string, string>
  card_faces?: { image_uris?: Record<string, string> }[]
}): ScryfallImages {
  const out: ScryfallImages = {
    scryfallId: sf.id,
    imageSmall: null,
    imageNormal: null,
    backImageSmall: null,
    backImageNormal: null,
  }
  if (sf.image_uris) {
    out.imageSmall = sf.image_uris.small ?? null
    out.imageNormal = sf.image_uris.normal ?? null
  } else if (sf.card_faces?.length) {
    // transform / modal_dfc: per-face images, face 0 = front, face 1 = back
    out.imageSmall = sf.card_faces[0]?.image_uris?.small ?? null
    out.imageNormal = sf.card_faces[0]?.image_uris?.normal ?? null
    out.backImageSmall = sf.card_faces[1]?.image_uris?.small ?? null
    out.backImageNormal = sf.card_faces[1]?.image_uris?.normal ?? null
  }
  return out
}

function joinDistinct(values: (string | undefined)[], sep: string): string | null {
  const present = values.filter((v): v is string => !!v)
  if (!present.length) return null
  return present.join(sep)
}

/** Map one AtomicCards entry (+ joined images) to a Card row. `id` is filled by the caller. */
export function mapCard(
  name: string,
  faces: AtomicFace[],
  images: ScryfallImages | null,
): Omit<CardRow, 'id'> {
  const front = faces[0]!
  return {
    scryfallOracleId: front.identifiers!.scryfallOracleId!,
    scryfallId: images?.scryfallId ?? '00000000-0000-0000-0000-000000000000',
    name,
    nameNorm: norm(name),
    asciiName: front.asciiName ?? null,
    faceNames: faces.map((f) => f.faceName).filter((v): v is string => !!v),
    layout: front.layout ?? 'normal',
    manaCost: joinDistinct(faces.map((f) => f.manaCost), ' // '),
    manaValue: front.manaValue ?? 0,
    typeLine: joinDistinct(faces.map((f) => f.type), ' // ') ?? '',
    oracleText: joinDistinct(faces.map((f) => f.text), '\n//\n'),
    power: front.power ?? null,
    toughness: front.toughness ?? null,
    loyalty: front.loyalty ?? null,
    defense: front.defense ?? null,
    colors: front.colors ?? [],
    colorIdentity: front.colorIdentity ?? [],
    keywords: [...new Set(faces.flatMap((f) => f.keywords ?? []))],
    supertypes: front.supertypes ?? [],
    commanderLegality: mapCommanderLegality(front.legalities),
    canBeCommander: faces.some((f) => f.leadershipSkills?.commander === true),
    hasAltDeckLimit: front.hasAlternativeDeckLimit === true,
    isFunny: front.isFunny === true,
    edhrecRank: front.edhrecRank ?? null,
    faces:
      faces.length > 1
        ? faces.map((f) => ({
            name: f.faceName ?? f.name,
            manaCost: f.manaCost ?? null,
            type: f.type ?? null,
            text: f.text ?? null,
            power: f.power ?? null,
            toughness: f.toughness ?? null,
            loyalty: f.loyalty ?? null,
            defense: f.defense ?? null,
            colors: f.colors ?? [],
          }))
        : null,
    imageSmall: images?.imageSmall ?? null,
    imageNormal: images?.imageNormal ?? null,
    backImageSmall: images?.backImageSmall ?? null,
    backImageNormal: images?.backImageNormal ?? null,
  }
}

/**
 * Aliases for decklist resolution: each faceName, the front half of "A // B"
 * names, and the ascii form. All normalized; the card's own nameNorm is excluded
 * (Card.nameNorm is checked first at lookup time).
 */
export function buildAliases(row: Pick<CardRow, 'name' | 'nameNorm' | 'faceNames' | 'asciiName'>): string[] {
  const out = new Set<string>()
  for (const f of row.faceNames) out.add(norm(f))
  if (row.name.includes(' // ')) out.add(norm(row.name.split(' // ')[0]!))
  if (row.asciiName) out.add(norm(row.asciiName))
  out.delete(row.nameNorm)
  out.delete('')
  return [...out]
}

/**
 * Dedupe AtomicCards entries by oracle id, preferring the plain key over a
 * "X // X"-style or longer multiface key (reversible cards produce both).
 */
export function preferKey(existing: string, incoming: string): string {
  const exSplit = existing.includes(' // ')
  const inSplit = incoming.includes(' // ')
  if (exSplit && !inSplit) return incoming
  return existing
}
