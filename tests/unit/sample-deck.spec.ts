/**
 * The bundled "Engine Playtest" sample deck must (a) parse cleanly, (b) name a
 * legendary commander, and (c) consist ENTIRELY of cards the rules engine
 * implements — so loading it and starting an enforced game exercises every card
 * with full rules (nothing falls back to the assisted table). If a future edit
 * adds an unimplemented card to the list, this fails.
 */
import { describe, expect, it } from 'vitest'
import { SAMPLE_DECK_NAME, SAMPLE_DECK_TEXT } from '../../shared/data/sampleDeck.ts'
import { parseDecklist } from '../../shared/utils/decklistParse.ts'
import { unimplementedNames } from '../../server/rules/cards/registry.ts'

describe('bundled sample deck', () => {
  const parsed = parseDecklist(SAMPLE_DECK_TEXT)

  it('parses with no unparseable lines', () => {
    expect(SAMPLE_DECK_NAME.length).toBeGreaterThan(0)
    const bad = parsed.skipped.filter((s) => s.reason === 'unparseable')
    expect(bad, `unparseable lines: ${bad.map((b) => b.raw).join(', ')}`).toHaveLength(0)
    expect(parsed.entries.length).toBeGreaterThan(60)
  })

  it('designates Jedit Ojanen as the commander', () => {
    expect(parsed.hasCommanderSection).toBe(true)
    const cmd = parsed.entries.filter((e) => e.section === 'COMMANDER')
    expect(cmd).toHaveLength(1)
    expect(cmd[0]!.name).toBe('Jedit Ojanen')
  })

  it('contains ONLY cards the rules engine implements (no fallbacks)', () => {
    const names = parsed.entries.map((e) => e.name)
    const missing = unimplementedNames(names)
    expect(missing, `not implemented: ${missing.join(', ')}`).toHaveLength(0)
  })
})
