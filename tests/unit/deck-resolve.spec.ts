import { describe, expect, it } from 'vitest'
import { parseDecklist } from '../../shared/utils/decklistParse.ts'
import {
  resolveDecklist,
  type CatalogCard,
  type CatalogLookup,
} from '../../server/utils/deckResolve.ts'
import { norm } from '../../shared/utils/norm.ts'

const card = (id: string, name: string, extra: Partial<CatalogCard> = {}): CatalogCard => ({
  id,
  name,
  canBeCommander: false,
  commanderLegality: 'LEGAL',
  colorIdentity: [],
  supertypes: [],
  hasAltDeckLimit: false,
  imageSmall: null,
  ...extra,
})

const CATALOG: CatalogCard[] = [
  card('sol', 'Sol Ring'),
  card('atraxa', "Atraxa, Praetors' Voice", { canBeCommander: true, colorIdentity: ['W', 'U', 'B', 'G'] }),
  card('fireice', 'Fire // Ice', { colorIdentity: ['U', 'R'] }),
  card('delver', 'Delver of Secrets // Insectile Aberration', { colorIdentity: ['U'] }),
  card('lotus', 'Black Lotus', { commanderLegality: 'BANNED' }),
  card('forest', 'Forest', { supertypes: ['Basic'], colorIdentity: ['G'] }),
  card('lightning', 'Lightning Bolt', { colorIdentity: ['R'] }),
]
const ALIASES: Record<string, string> = {
  'delver of secrets': 'delver',
  fire: 'fireice',
}

function fakeLookup(): CatalogLookup {
  const byNorm = new Map(CATALOG.map((c) => [norm(c.name), c]))
  const byId = new Map(CATALOG.map((c) => [c.id, c]))
  return {
    async byNorm(norms) {
      return new Map(norms.filter((n) => byNorm.has(n)).map((n) => [n, byNorm.get(n)!]))
    },
    async byAlias(aliases) {
      return new Map(
        aliases.filter((a) => ALIASES[a]).map((a) => [a, byId.get(ALIASES[a]!)!]),
      )
    },
    async suggest(q) {
      return q === 'solring' ? [{ cardId: 'sol', name: 'Sol Ring', score: 0.72 }] : []
    },
  }
}

const resolve = (text: string) => resolveDecklist(parseDecklist(text), fakeLookup())

describe('resolveDecklist', () => {
  it('resolves exact, alias, and slash-variant names', async () => {
    const r = await resolve('1 Sol Ring\n1 Delver of Secrets\n1 Fire/Ice\n1 fire // ice\n1 Fire')
    expect(r.unresolved).toEqual([])
    const names = r.resolved.map((x) => x.name)
    expect(names).toContain('Sol Ring')
    expect(names).toContain('Delver of Secrets // Insectile Aberration')
    expect(names).toContain('Fire // Ice')
  })

  it('merges duplicate lines and reports unresolved with suggestions', async () => {
    const r = await resolve('1 Sol Ring\n2 Sol Ring\n1 Solring')
    expect(r.resolved).toEqual([expect.objectContaining({ cardId: 'sol', qty: 3 })])
    expect(r.unresolved).toEqual([
      expect.objectContaining({
        raw: 'Solring',
        suggestions: [expect.objectContaining({ name: 'Sol Ring' })],
      }),
    ])
  })

  it('warns on card count, non-basic duplicates, banned cards', async () => {
    const r = await resolve('3 Sol Ring\n10 Forest\n1 Black Lotus')
    const codes = r.warnings.map((w) => w.code)
    expect(codes).toContain('CARD_COUNT')
    expect(r.warnings).toContainEqual({ code: 'DUPLICATE_NONBASIC', name: 'Sol Ring', count: 3 })
    expect(r.warnings).toContainEqual({ code: 'BANNED_IN_COMMANDER', name: 'Black Lotus' })
    expect(codes).not.toContain('COLOR_IDENTITY') // no commander designated
  })

  it('designates commanders from the section and checks color identity', async () => {
    const r = await resolve("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Lightning Bolt\n1 Forest")
    expect(r.commander.designated).toEqual(['atraxa'])
    expect(r.commander.required).toBe(false)
    expect(r.warnings).toContainEqual({ code: 'COLOR_IDENTITY', name: 'Lightning Bolt' })
    expect(r.warnings.filter((w) => w.code === 'COLOR_IDENTITY')).toHaveLength(1) // Forest is fine
  })

  it('warns when a designated commander cannot be one', async () => {
    const r = await resolve('Commander\n1 Sol Ring\n\nDeck\n1 Forest')
    expect(r.warnings).toContainEqual({ code: 'NOT_A_COMMANDER', name: 'Sol Ring' })
  })

  it('guesses a headerless first-block commander', async () => {
    const r = await resolve("1 Atraxa, Praetors' Voice\n\n1 Sol Ring\n1 Forest")
    expect(r.commander.designated).toEqual([])
    expect(r.commander.guess).toEqual(['atraxa'])
    expect(r.commander.required).toBe(true)
  })

  it('does not guess a non-commander first block', async () => {
    const r = await resolve('1 Sol Ring\n\n1 Forest\n1 Lightning Bolt')
    expect(r.commander.guess).toEqual([])
  })
})
