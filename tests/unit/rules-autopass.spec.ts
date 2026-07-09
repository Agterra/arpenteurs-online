import { describe, expect, it } from 'vitest'
import { shouldAutoPassPriority, type AutoPassInput } from '../../shared/rules/autopass.ts'
import type { LegalActions } from '../../shared/rules/types.ts'

const legal = (over: Partial<LegalActions> = {}): LegalActions => ({
  hasPriority: true,
  canPass: true,
  playableLandIds: [],
  castableIds: [],
  manaSourceIds: [],
  declarableAttackerIds: [],
  declarableBlockerIds: [],
  attackablePlayerIds: [],
  incomingAttackerIds: [],
  needsAttackers: false,
  needsBlockers: false,
  needsDiscard: false,
  discardCount: 0,
  ...over,
})

const base = (over: Partial<AutoPassInput> = {}): AutoPassInput => ({
  enabled: true,
  active: true,
  legal: legal(),
  activePlayer: 'opp', // someone else's turn by default
  you: 'me',
  targeting: false,
  ...over,
})

describe('auto-pass priority decision (others’ turns)', () => {
  it('passes on another player’s turn when you have nothing to cast', () => {
    expect(shouldAutoPassPriority(base())).toBe(true)
  })

  it('never fires on your OWN turn, even with nothing to do', () => {
    expect(shouldAutoPassPriority(base({ activePlayer: 'me' }))).toBe(false)
  })

  it('stops on an opponent’s turn when you hold an instant you could cast', () => {
    expect(shouldAutoPassPriority(base({ legal: legal({ castableIds: ['bolt1'] }) }))).toBe(false)
  })

  it('is off when the toggle is disabled', () => {
    expect(shouldAutoPassPriority(base({ enabled: false }))).toBe(false)
  })

  it('is off when the game is not active', () => {
    expect(shouldAutoPassPriority(base({ active: false }))).toBe(false)
  })

  it('is off with no legal actions yet (state not loaded)', () => {
    expect(shouldAutoPassPriority(base({ legal: null }))).toBe(false)
  })

  it('does not fire without a real priority window (pending decision)', () => {
    // a pending blockers/discard has hasPriority:false, canPass:false
    expect(shouldAutoPassPriority(base({ legal: legal({ hasPriority: false, canPass: false, needsBlockers: true }) }))).toBe(false)
  })

  it('does not fire while you are mid-cast selecting a target', () => {
    expect(shouldAutoPassPriority(base({ targeting: true }))).toBe(false)
  })
})
