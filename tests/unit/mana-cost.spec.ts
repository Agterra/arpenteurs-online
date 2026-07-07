import { describe, expect, it } from 'vitest'
import { parseManaCost, planPayment, totalPips, type ManaPool } from '../../shared/utils/manaCost.ts'

const pool = (p: Partial<ManaPool>): ManaPool => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...p })

describe('parseManaCost', () => {
  it('splits generic and coloured pips', () => {
    const c = parseManaCost('{2}{U}{U}')
    expect(c.generic).toBe(2)
    expect(c.colored.U).toBe(2)
    expect(totalPips(c)).toBe(4)
  })
  it('handles colourless {C} as a colour requirement', () => {
    expect(parseManaCost('{C}{C}').colored.C).toBe(2)
  })
  it('flags X and prices the numeric part', () => {
    const c = parseManaCost('{X}{X}{R}')
    expect(c.hasX).toBe(true)
    expect(c.colored.R).toBe(1)
    expect(c.generic).toBe(0)
  })
  it('approximates hybrid/Phyrexian as 1 generic each', () => {
    // {2/W}{W/U}{W/P} → 3 approximate generic (real pips still shown elsewhere)
    expect(parseManaCost('{2/W}{W/U}{W/P}').generic).toBe(3)
  })
  it('prices the front half of split costs', () => {
    const c = parseManaCost('{1}{R} // {1}{U}')
    expect(c.generic).toBe(1)
    expect(c.colored.R).toBe(1)
    expect(c.colored.U).toBe(0)
  })
  it('empty / null → nothing', () => {
    expect(totalPips(parseManaCost(null))).toBe(0)
    expect(totalPips(parseManaCost(''))).toBe(0)
  })
})

describe('planPayment', () => {
  it('covers when the pool is sufficient, deducting 4 total incl. the 2 coloured U', () => {
    const c = parseManaCost('{2}{U}{U}')
    const p = planPayment(c, pool({ U: 3, G: 2 }))
    expect(p.covered).toBe(true)
    expect(p.shortfall).toBe(0)
    expect(p.deduct.U).toBeGreaterThanOrEqual(2) // the coloured requirement
    const total = Object.values(p.deduct).reduce((a, b) => a + b, 0)
    expect(total).toBe(4) // 2 coloured + 2 generic
  })
  it('reports the shortfall when short', () => {
    const c = parseManaCost('{2}{U}{U}')
    const p = planPayment(c, pool({ U: 2 }))
    expect(p.covered).toBe(false)
    expect(p.shortfall).toBe(2) // the two generic can't be paid
    expect(p.deduct.U).toBe(2)
  })
  it('spends colourless on generic before coloured mana', () => {
    const c = parseManaCost('{3}')
    const p = planPayment(c, pool({ C: 2, G: 5 }))
    expect(p.deduct.C).toBe(2)
    expect(p.deduct.G).toBe(1)
    expect(p.covered).toBe(true)
  })
  it('pays a {C} requirement only from colourless mana', () => {
    const c = parseManaCost('{C}')
    expect(planPayment(c, pool({ G: 5 })).covered).toBe(false) // green can't pay {C}
    expect(planPayment(c, pool({ C: 1 })).covered).toBe(true)
  })
})
