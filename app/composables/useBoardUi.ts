/**
 * Board-wide UI plumbing shared by every board component (selection, drag
 * state, prompts, dialogs, context-menu builders). Provided by
 * <BoardGameBoard> — the game page's client-only root — and injected
 * everywhere below it.
 */
import type { InjectionKey, Ref } from 'vue'
import type { CardDisplay, CardId, PlayerId, RedactedCard } from '#shared/types/game'
import type { ClientMsgT } from '#shared/schemas/messages'

export const CARD_W = 84
export const CARD_H = 117

// Battlefield snapping grid (Cockatrice-style). Fine cells — one third of a card
// each way (vertical rectangles, 28×39) — so cards align precisely and stack tightly.
export const GRID_COL = Math.round(CARD_W / 3)
export const GRID_ROW = Math.round(CARD_H / 3)

export const SEAT_COLORS = ['#38bdf8', '#f472b6', '#facc15', '#4ade80'] as const

export type CardMenuZone = 'battlefield' | 'hand' | 'browser' | 'stack' | 'command'

export interface DragState {
  cardId: CardId
  card: RedactedCard
  /** true = free reposition inside its controller's quadrant, false = ghost-follow (hand/browser) */
  battlefield: boolean
  pointer: { x: number; y: number }
  moved: boolean
}

export interface ArrowDragState {
  fromCardId: CardId
  pointer: { x: number; y: number }
}

export interface PreviewState {
  display: CardDisplay
  faceIndex: number
}

export interface PromptOptions {
  title: string
  kind: 'number' | 'text' | 'choice' | 'confirm'
  label?: string
  initial?: string | number
  min?: number
  max?: number
  options?: { label: string; value: string }[]
  danger?: boolean
  confirmLabel?: string
}

export interface MenuItem {
  label?: string
  icon?: string
  /** Nuxt UI's colour union — a plain string doesn't satisfy UDropdownMenu's item typing */
  color?: 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'
  disabled?: boolean
  type?: 'separator' | 'label'
  children?: MenuItem[]
  onSelect?: (e?: Event) => void
}

export interface BoardUi {
  you: PlayerId
  send: (m: ClientMsgT) => boolean
  selected: Ref<Set<CardId>>
  attachSource: Ref<CardId | null>
  drag: Ref<DragState | null>
  dropHover: Ref<string | null>
  arrowDrag: Ref<ArrowDragState | null>
  /** mulligan "bottom these" selection state */
  bottomingActive: Ref<boolean>
  bottoming: Ref<Set<CardId>>
  /** Battlefield snap-to-grid toggle (Cockatrice-style). */
  snapToGrid: Ref<boolean>
  preview: Ref<PreviewState | null>
  showPreview: (display: CardDisplay, faceIndex?: number) => void
  hidePreview: () => void
  prompt: (opts: PromptOptions) => Promise<string | number | null>
  pickPlayer: (title: string, opts?: { includeAll?: boolean; excludeSelf?: boolean }) => Promise<PlayerId | 'all' | null>
  openTokenDialog: (fromCard?: RedactedCard) => void
  /** Open the cast-to-stack + pay-mana dialog for a spell in your hand. */
  openCast: (card: RedactedCard) => void
  openZoneBrowser: (playerId: PlayerId, kind: 'graveyard' | 'exile' | 'command') => void
  /** Draw/scry/look/search/shuffle/reveal menu for your own library (shared by HUD + zones panel). */
  libraryMenuItems: () => MenuItem[][]
  /** Convenience: tap a permanent and add its mana (prompting a colour when needed). */
  tapForMana: (card: RedactedCard) => void
  /** True if this card has a detectable mana ability (used to show the affordance). */
  canTapForMana: (card: RedactedCard) => boolean
  cardMenuItems: (card: RedactedCard, zone: CardMenuZone) => MenuItem[][]
  startBattlefieldDrag: (card: RedactedCard, e: PointerEvent) => void
  startGhostDrag: (card: RedactedCard, e: PointerEvent) => void
  startArrowDrag: (cardId: CardId, e: PointerEvent) => void
  toggleSelect: (cardId: CardId, additive: boolean) => void
  clearSelection: () => void
  tryAttachTo: (card: RedactedCard) => boolean
}

export const BOARD_UI_KEY: InjectionKey<BoardUi> = Symbol('board-ui')

export function useBoardUi(): BoardUi {
  const ui = inject(BOARD_UI_KEY, null)
  if (!ui) throw new Error('useBoardUi() must be used inside the game board')
  return ui
}

/** Optional variant for leaf components that can render outside the board (previews off). */
export function useBoardUiOptional(): BoardUi | null {
  return inject(BOARD_UI_KEY, null)
}
