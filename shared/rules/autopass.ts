/**
 * Pure decision for the enforced-board "auto-pass priority" toggle. Kept out of
 * the Vue component so it can be unit-tested directly (the ws e2e drives
 * priority by hand and never exercises the client auto-pass path).
 */
import type { LegalActions, PlayerId } from './types'

export interface AutoPassInput {
  /** the toggle (on by default) */
  enabled: boolean
  /** game status is 'active' */
  active: boolean
  /** the viewer's legal actions from the last server state */
  legal: LegalActions | null
  /** whose turn it is */
  activePlayer: PlayerId
  you: PlayerId
  /** the viewer is mid-cast, choosing a target */
  targeting: boolean
}

/**
 * True only when auto-pass is on and it's ANOTHER player's turn where you hold a
 * real priority window (not a pending blockers/discard decision), you're not
 * mid-cast, and you have nothing to cast in response. On your OWN turn it's
 * always false — you stay in full control. On others' turns it still stops if
 * you hold an instant-speed play, so a genuine response is never skipped.
 */
export function shouldAutoPassPriority(i: AutoPassInput): boolean {
  if (!i.enabled || !i.active || !i.legal) return false
  if (!i.legal.hasPriority || !i.legal.canPass) return false // pending decision, not a priority window
  if (i.targeting) return false // mid-cast target selection
  if (i.activePlayer === i.you) return false // your own turn: never auto-pass
  return i.legal.castableIds.length === 0 // another player's turn: pass unless you can respond
}
