import { describe, expect, it } from 'vitest'
import { parseDecklist } from '../../shared/utils/decklistParse.ts'

describe('parseDecklist — line formats', () => {
  it('parses qty variants and defaults to 1', () => {
    const { entries } = parseDecklist('1 Sol Ring\n1x Arcane Signet\n4 Rat Colony\nCommand Tower')
    expect(entries.map((e) => [e.qty, e.name])).toEqual([
      [1, 'Sol Ring'],
      [1, 'Arcane Signet'],
      [4, 'Rat Colony'],
      [1, 'Command Tower'],
    ])
  })

  it('strips set / collector / foil / category / color annotations', () => {
    const { entries } = parseDecklist(
      [
        '1 Sol Ring (C21) 125',
        '1 Sol Ring (c21) 125 *F*',
        '1x Sol Ring (C21) 125 [Ramp]',
        '1 Sol Ring (LTC) 284 *E* [Ramp,Artifact] ^Have,#96d3af^',
        '1 Nazgûl (LTR) 100',
      ].join('\n'),
    )
    expect(entries.map((e) => e.name)).toEqual(['Sol Ring', 'Sol Ring', 'Sol Ring', 'Sol Ring', 'Nazgûl'])
  })

  it('keeps // names intact', () => {
    const { entries } = parseDecklist('1 Fire // Ice\n1 Fire//Ice\n1 Fire / Ice')
    expect(entries.map((e) => e.name)).toEqual(['Fire // Ice', 'Fire//Ice', 'Fire / Ice'])
  })

  it('skips comment lines but not // inside names', () => {
    const { entries, skipped } = parseDecklist('// my deck\n# note\n1 Fire // Ice')
    expect(entries).toHaveLength(1)
    expect(skipped.map((s) => s.reason)).toEqual(['comment', 'comment'])
  })
})

describe('parseDecklist — sections', () => {
  const moxfield = `Commander:
1 Atraxa, Praetors' Voice

Deck:
1 Sol Ring
98 Forest

Sideboard:
1 Swords to Plowshares`

  it('handles Moxfield-style headers', () => {
    const parsed = parseDecklist(moxfield)
    expect(parsed.hasCommanderSection).toBe(true)
    expect(parsed.entries.filter((e) => e.section === 'COMMANDER')).toHaveLength(1)
    expect(parsed.entries.filter((e) => e.section === 'MAIN')).toHaveLength(2)
    expect(parsed.skipped.some((s) => s.reason === 'section_ignored')).toBe(true)
  })

  it('handles MTGA exports with About block', () => {
    const mtga = `About
Name My Atraxa deck

Deck
1 Atraxa, Praetors' Voice (MOC) 93
1 Sol Ring (MOC) 392

Sideboard
1 Negate (MOM) 68`
    const parsed = parseDecklist(mtga)
    expect(parsed.entries.map((e) => e.name)).toEqual(["Atraxa, Praetors' Voice", 'Sol Ring'])
    expect(parsed.skipped.filter((s) => s.reason === 'about_block')).toHaveLength(1)
  })

  it('guesses commander from a headerless 1-line first block', () => {
    const plain = `1 Atraxa, Praetors' Voice

1 Sol Ring
1 Command Tower`
    const parsed = parseDecklist(plain)
    expect(parsed.hasCommanderSection).toBe(false)
    expect(parsed.firstBlockIfHeaderless.map((e) => e.name)).toEqual(["Atraxa, Praetors' Voice"])
  })

  it('does not guess when there is a single block', () => {
    const parsed = parseDecklist('1 Sol Ring\n1 Command Tower')
    expect(parsed.firstBlockIfHeaderless).toEqual([])
  })

  it('does not guess when headers are present', () => {
    const parsed = parseDecklist('Deck\n1 Atraxa, Praetors\' Voice\n\n1 Sol Ring')
    expect(parsed.firstBlockIfHeaderless).toEqual([])
  })

  it('supports partner commanders in the Commander section', () => {
    const parsed = parseDecklist('Commander\n1 Thrasios, Triton Hero\n1 Tymna the Weaver\n\nDeck\n1 Sol Ring')
    expect(parsed.entries.filter((e) => e.section === 'COMMANDER')).toHaveLength(2)
  })
})
