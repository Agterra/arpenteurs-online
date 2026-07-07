import { describe, expect, it } from 'vitest'
import { manaProductionFor } from '../../shared/utils/manaAbilities.ts'

describe('manaProductionFor', () => {
  it('basic lands → their single colour', () => {
    expect(manaProductionFor({ typeLine: 'Basic Land — Forest', oracleText: '({T}: Add {G}.)' })).toEqual({
      kind: 'fixed',
      pips: ['G'],
    })
    expect(manaProductionFor({ typeLine: 'Basic Land — Island' })).toEqual({ kind: 'fixed', pips: ['U'] })
    expect(manaProductionFor({ typeLine: 'Basic Land — Wastes' })).toEqual({ kind: 'fixed', pips: ['C'] })
  })

  it('typed dual lands → choice among their basic types', () => {
    const p = manaProductionFor({ typeLine: 'Land — Mountain Forest', oracleText: '({T}: Add {R} or {G}.)' })
    expect(p?.kind).toBe('choice')
    expect((p as { options: string[] }).options.sort()).toEqual(['G', 'R'])
  })

  it('mana rocks with a fixed amount → those pips', () => {
    expect(manaProductionFor({ typeLine: 'Artifact', oracleText: '{T}: Add {C}{C}.' })).toEqual({
      kind: 'fixed',
      pips: ['C', 'C'],
    })
    expect(manaProductionFor({ typeLine: 'Artifact', oracleText: '{T}: Add {G}.' })).toEqual({
      kind: 'fixed',
      pips: ['G'],
    })
  })

  it('"any color" sources → choose among WUBRG', () => {
    expect(
      manaProductionFor({ typeLine: 'Creature — Bird', oracleText: '{T}: Add one mana of any color.' }),
    ).toEqual({ kind: 'choice', options: ['W', 'U', 'B', 'R', 'G'] })
    expect(
      manaProductionFor({ typeLine: 'Artifact', oracleText: '{T}: Add one mana of any color.' })?.kind,
    ).toBe('choice')
  })

  it('"Add {W} or {U}" style → choice among the listed colours', () => {
    const p = manaProductionFor({ typeLine: 'Land', oracleText: '{T}: Add {W} or {U}.' })
    expect(p).toEqual({ kind: 'choice', options: ['W', 'U'] })
  })

  it('dork with a single explicit colour → fixed', () => {
    expect(manaProductionFor({ typeLine: 'Creature — Elf Druid', oracleText: '{T}: Add {G}.' })).toEqual({
      kind: 'fixed',
      pips: ['G'],
    })
  })

  it('non-mana cards → null (falls back to plain tap)', () => {
    expect(manaProductionFor({ typeLine: 'Creature — Human', oracleText: 'Vigilance' })).toBeNull()
    expect(manaProductionFor({ typeLine: 'Instant', oracleText: 'Draw two cards.' })).toBeNull()
    expect(manaProductionFor({ typeLine: '', oracleText: '' })).toBeNull()
    expect(manaProductionFor({})).toBeNull()
  })

  it('does not treat non-mana "add" text as mana', () => {
    // "Add a +1/+1 counter" has no mana symbols in the Add clause → null
    expect(manaProductionFor({ typeLine: 'Enchantment', oracleText: 'At the beginning of your upkeep, add a +1/+1 counter on target creature.' })).toBeNull()
  })
})
