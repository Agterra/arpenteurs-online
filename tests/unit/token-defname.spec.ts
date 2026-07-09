import { describe, expect, it } from 'vitest'
import { parseTokenDefName } from '../../shared/utils/tokenDefName.ts'

describe('parseTokenDefName', () => {
  it('parses an engine token defName (itok:) into name + P/T', () => {
    expect(parseTokenDefName('itok:beast:3/3:flying')).toEqual({
      nameNorm: 'beast',
      name: 'Beast',
      power: '3',
      toughness: '3',
    })
  })

  it('parses a manual token defName (tok:)', () => {
    expect(parseTokenDefName('tok:zombie:2/2:token creature — zombie')).toEqual({
      nameNorm: 'zombie',
      name: 'Zombie',
      power: '2',
      toughness: '2',
    })
  })

  it('title-cases multi-word token names', () => {
    expect(parseTokenDefName('itok:elf warrior:1/1:')?.name).toBe('Elf Warrior')
  })

  it('handles noncreature tokens with no P/T', () => {
    expect(parseTokenDefName('itok:treasure::')).toEqual({
      nameNorm: 'treasure',
      name: 'Treasure',
      power: null,
      toughness: null,
    })
  })

  it('returns null for non-token defNames', () => {
    expect(parseTokenDefName('grizzly bears')).toBeNull()
    expect(parseTokenDefName('sol ring')).toBeNull()
  })
})
