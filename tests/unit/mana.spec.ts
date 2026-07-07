import { describe, expect, it } from 'vitest'
import { parseMana, symbolCode, symbolSvgUrl, hasManaSymbols } from '../../shared/utils/mana.ts'

const codes = (s: string) =>
  parseMana(s)
    .filter((t) => t.type === 'symbol')
    .map((t) => (t as { code: string }).code)

describe('symbolCode', () => {
  it('passes plain colors and generic numbers through, uppercased', () => {
    expect(symbolCode('W')).toBe('W')
    expect(symbolCode('2')).toBe('2')
    expect(symbolCode('100')).toBe('100')
    expect(symbolCode('1000000')).toBe('1000000')
    expect(symbolCode('x')).toBe('X')
  })
  it('strips slashes for hybrid / monohybrid / Phyrexian', () => {
    expect(symbolCode('W/U')).toBe('WU')
    expect(symbolCode('2/W')).toBe('2W')
    expect(symbolCode('W/P')).toBe('WP')
    expect(symbolCode('G/U/P')).toBe('GUP')
  })
  it('handles tap/untap/snow/energy and named specials', () => {
    expect(symbolCode('T')).toBe('T')
    expect(symbolCode('Q')).toBe('Q')
    expect(symbolCode('S')).toBe('S')
    expect(symbolCode('E')).toBe('E')
    expect(symbolCode('HW')).toBe('HW')
    expect(symbolCode('∞')).toBe('INFINITY')
    expect(symbolCode('½')).toBe('HALF')
  })
})

describe('symbolSvgUrl', () => {
  it('builds the Scryfall card-symbol URL', () => {
    expect(symbolSvgUrl('W')).toBe('https://svgs.scryfall.io/card-symbols/W.svg')
    expect(symbolSvgUrl('2W')).toBe('https://svgs.scryfall.io/card-symbols/2W.svg')
  })
})

describe('parseMana', () => {
  it('returns [] for empty / null / undefined', () => {
    expect(parseMana('')).toEqual([])
    expect(parseMana(null)).toEqual([])
    expect(parseMana(undefined)).toEqual([])
  })

  it('tokenizes a pure mana cost', () => {
    expect(codes('{2}{R}{R}')).toEqual(['2', 'R', 'R'])
    expect(parseMana('{2}{R}{R}').every((t) => t.type === 'symbol')).toBe(true)
  })

  it('tokenizes hybrid and Phyrexian costs', () => {
    expect(codes('{W/U}{2/W}{W/P}')).toEqual(['WU', '2W', 'WP'])
  })

  it('interleaves symbols with surrounding oracle text, preserving spacing', () => {
    const toks = parseMana('{T}: Add {G}{G}.')
    expect(toks).toEqual([
      { type: 'symbol', raw: '{T}', code: 'T' },
      { type: 'text', text: ': Add ' },
      { type: 'symbol', raw: '{G}', code: 'G' },
      { type: 'symbol', raw: '{G}', code: 'G' },
      { type: 'text', text: '.' },
    ])
  })

  it('preserves newlines in oracle text as text tokens', () => {
    const toks = parseMana('First line\n{R}: Deal 1 damage.')
    expect(toks[0]).toEqual({ type: 'text', text: 'First line\n' })
    expect(toks[1]).toEqual({ type: 'symbol', raw: '{R}', code: 'R' })
  })

  it('treats a plain string with no symbols as one text token', () => {
    expect(parseMana('Flying, vigilance')).toEqual([{ type: 'text', text: 'Flying, vigilance' }])
  })

  it('leaves an unclosed brace as literal text (no false symbol)', () => {
    expect(parseMana('{unclosed cost')).toEqual([{ type: 'text', text: '{unclosed cost' }])
  })

  it('handles special glyph symbols', () => {
    expect(codes('{∞}')).toEqual(['INFINITY'])
    expect(codes('{½}')).toEqual(['HALF'])
  })
})

describe('hasManaSymbols', () => {
  it('detects presence of any symbol', () => {
    expect(hasManaSymbols('{W}')).toBe(true)
    expect(hasManaSymbols('Draw a card.')).toBe(false)
    expect(hasManaSymbols(null)).toBe(false)
    expect(hasManaSymbols('{}')).toBe(false)
  })
})
