import { describe, expect, it } from 'vitest'
import { norm } from '../../shared/utils/norm.ts'

describe('norm', () => {
  it('lowercases and trims', () => {
    expect(norm('  Sol Ring ')).toBe('sol ring')
  })
  it('collapses internal whitespace', () => {
    expect(norm('Sol   Ring')).toBe('sol ring')
  })
  it('folds Æ ligatures', () => {
    expect(norm('Æther Vial')).toBe('aether vial')
  })
  it('straightens curly apostrophes', () => {
    expect(norm('Urza’s Tower')).toBe("urza's tower")
  })
  it('strips diacritics', () => {
    expect(norm('Lim-Dûl the Necromancer')).toBe('lim-dul the necromancer')
    expect(norm('Márton Stromgald')).toBe('marton stromgald')
    expect(norm('Séance')).toBe('seance')
  })
  it('keeps // separators intact', () => {
    expect(norm('Fire // Ice')).toBe('fire // ice')
  })
  it('is idempotent', () => {
    const once = norm('Æther Vial’s  Test')
    expect(norm(once)).toBe(once)
  })
})
