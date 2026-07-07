<script setup lang="ts">
/**
 * Client-only board root: opens the game socket, provides the BoardUi
 * contract (selection, drag manager, prompts, context-menu builder) and lays
 * out ribbon / quadrants / sidebar / hand / overlays per PLAN §5.
 */
import type { CardId, ManaColor, PlayerId, RedactedCard, ZoneKind } from '#shared/types/game'
import { manaProductionFor } from '#shared/utils/manaAbilities'
import {
  BOARD_UI_KEY,
  CARD_H,
  CARD_W,
  GRID_COL,
  GRID_ROW,
  type ArrowDragState,
  type BoardUi,
  type CardMenuZone,
  type DragState,
  type MenuItem,
  type PreviewState,
  type PromptOptions,
} from '~/composables/useBoardUi'
import { useGameStore } from '~/stores/game'

const props = defineProps<{ gameId: string }>()

const store = useGameStore()
const toast = useToast()
const { send } = useGameSocket(props.gameId)

onBeforeUnmount(() => store.reset())

// ---------- shared UI state ----------
const selected = ref<Set<CardId>>(new Set())
const attachSource = ref<CardId | null>(null)
const drag = ref<DragState | null>(null)
const dropHover = ref<string | null>(null)
const arrowDrag = ref<ArrowDragState | null>(null)
const bottomingActive = ref(false)
const bottoming = ref<Set<CardId>>(new Set())
const preview = ref<PreviewState | null>(null)
const snapToGrid = ref(true)
onMounted(() => {
  if (localStorage.getItem('arp:snapToGrid') === '0') snapToGrid.value = false
})
watch(snapToGrid, (v) => localStorage.setItem('arp:snapToGrid', v ? '1' : '0'))

const promptRef = ref<{ ask: (o: PromptOptions) => Promise<string | number | null> } | null>(null)
const tokenRef = ref<{ show: (card?: RedactedCard) => void } | null>(null)
const browserRef = ref<{ show: (pid: PlayerId, kind: 'graveyard' | 'exile' | 'command') => void } | null>(null)
const castRef = ref<{ show: (card: RedactedCard) => void } | null>(null)

function prompt(opts: PromptOptions) {
  return promptRef.value ? promptRef.value.ask(opts) : Promise.resolve(null)
}

async function pickPlayer(
  title: string,
  opts: { includeAll?: boolean; excludeSelf?: boolean } = {},
): Promise<PlayerId | 'all' | null> {
  const options = store.seatedPlayers
    .filter((p) => !opts.excludeSelf || p.id !== store.you)
    .map((p) => ({ label: p.name, value: p.id }))
  if (opts.includeAll) options.push({ label: 'Everyone', value: 'all' })
  const v = await prompt({ title, kind: 'choice', options })
  return (v as PlayerId | 'all' | null) ?? null
}

// ---------- tap for mana ----------
const COLOR_NAMES: Record<ManaColor, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
  C: 'Colorless',
}
function canTapForMana(card: RedactedCard): boolean {
  return !!card.display && !!manaProductionFor(card.display)
}
async function tapForMana(card: RedactedCard) {
  if (card.controllerId !== store.you) return
  const prod = card.display ? manaProductionFor(card.display) : null
  if (!card.tapped) send({ type: 'card.tap', cardIds: [card.id], tapped: true })
  if (!prod) return
  if (prod.kind === 'fixed') {
    for (const c of prod.pips) send({ type: 'mana.change', color: c, delta: 1 })
    return
  }
  const v = await prompt({
    title: `Add which mana?`,
    kind: 'choice',
    options: prod.options.map((o) => ({ label: COLOR_NAMES[o], value: o })),
  })
  if (typeof v === 'string' && (prod.options as string[]).includes(v)) {
    send({ type: 'mana.change', color: v as ManaColor, delta: 1 })
  }
}

// ---------- selection ----------
function toggleSelect(cardId: CardId, additive: boolean) {
  const next = additive ? new Set(selected.value) : new Set<CardId>()
  if (additive && next.has(cardId)) next.delete(cardId)
  else next.add(cardId)
  selected.value = next
}
function clearSelection() {
  if (selected.value.size) selected.value = new Set()
}

// ---------- attach flow ----------
function tryAttachTo(card: RedactedCard): boolean {
  const src = attachSource.value
  if (!src) return false
  attachSource.value = null
  if (src !== card.id && card.zone.kind === 'battlefield') {
    send({ type: 'card.attach', cardId: src, targetId: card.id })
  }
  return true
}

// ---------- drag manager ----------
let grabDx = 0
let grabDy = 0
let lastPosSent = 0

function findDrop(e: PointerEvent): string | null {
  for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
    const v = (el as HTMLElement).dataset?.drop
    if (v) return v
  }
  return null
}

function attachDragListeners() {
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp)
}
function detachDragListeners() {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp)
}

function startBattlefieldDrag(card: RedactedCard, e: PointerEvent) {
  e.preventDefault()
  const wrapper = (e.currentTarget as HTMLElement | null) ?? null
  const rect = wrapper?.getBoundingClientRect()
  grabDx = rect ? e.clientX - rect.left : CARD_W / 2
  grabDy = rect ? e.clientY - rect.top : CARD_H / 2
  drag.value = { cardId: card.id, card, battlefield: true, pointer: { x: e.clientX, y: e.clientY }, moved: false }
  attachDragListeners()
}

function startGhostDrag(card: RedactedCard, e: PointerEvent) {
  e.preventDefault()
  grabDx = CARD_W / 2
  grabDy = CARD_H / 2
  drag.value = { cardId: card.id, card, battlefield: false, pointer: { x: e.clientX, y: e.clientY }, moved: false }
  attachDragListeners()
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

function battlefieldXY(quadPlayer: PlayerId, e: PointerEvent): { x: number; y: number } | null {
  const area = document.querySelector(`[data-drop="${CSS.escape(quadPlayer)}:battlefield"]`)
  if (!area) return null
  const r = area.getBoundingClientRect()
  let px = e.clientX - grabDx - r.left
  let py = e.clientY - grabDy - r.top
  if (snapToGrid.value) {
    // snap the card's top-left to the grid in pixel space (Cockatrice-style)
    px = Math.round(px / GRID_COL) * GRID_COL
    py = Math.round(py / GRID_ROW) * GRID_ROW
  }
  return {
    x: clamp01(px / Math.max(1, r.width - CARD_W)),
    y: clamp01(py / Math.max(1, r.height - CARD_H)),
  }
}

function onDragMove(e: PointerEvent) {
  const d = drag.value
  if (!d) return
  if (!d.moved && Math.hypot(e.clientX - d.pointer.x, e.clientY - d.pointer.y) > 4) d.moved = true
  d.pointer = { x: e.clientX, y: e.clientY }
  if (!d.moved) return
  dropHover.value = findDrop(e)
  if (d.battlefield) {
    const pos = battlefieldXY(d.card.controllerId, e)
    if (pos) {
      store.setLocalCardPosition(d.cardId, pos.x, pos.y)
      const now = Date.now()
      if (now - lastPosSent > 100 && store.conn === 'open') {
        lastPosSent = now
        send({ type: 'card.position', cardId: d.cardId, x: pos.x, y: pos.y })
      }
    }
  }
}

async function onDragUp(e: PointerEvent) {
  detachDragListeners()
  const d = drag.value
  drag.value = null
  dropHover.value = null
  if (!d || !d.moved) return

  const target = findDrop(e)
  const currentKey = d.card.zone.kind === 'stack' ? 'stack' : `${d.card.zone.player}:${d.card.zone.kind}`

  if (!target || target === currentKey) {
    // battlefield reposition only → flush the final position
    if (d.battlefield && store.conn === 'open') {
      const card = store.state?.cards[d.cardId]
      if (card) send({ type: 'card.position', cardId: d.cardId, x: card.x, y: card.y })
    }
    return
  }

  // Casting: dragging a spell from hand onto the battlefield (or the stack) puts
  // it on the stack and opens the pay-mana dialog. Lands skip the stack (no cost)
  // and just get played. Use right-click → "Play" to force a card straight down.
  const fromHand = d.card.zone.kind === 'hand'
  const isLand = (d.card.display?.typeLine ?? '').toLowerCase().includes('land')

  if (target === 'stack') {
    if (fromHand && !isLand) castRef.value?.show(d.card)
    else send({ type: 'card.move', cardId: d.cardId, to: { zone: { kind: 'stack' } } })
    return
  }
  const sep = target.indexOf(':')
  const pid = target.slice(0, sep)
  const kind = target.slice(sep + 1) as ZoneKind

  if (kind === 'battlefield') {
    if (fromHand && !isLand) {
      castRef.value?.show(d.card) // cast via the stack + pay, then resolve to the battlefield
      return
    }
    const pos = battlefieldXY(pid, e)
    send({
      type: 'card.move',
      cardId: d.cardId,
      to: { zone: { kind: 'battlefield', player: pid } },
      ...(pos ?? {}),
    })
    return
  }
  // cards always go to their owner's hidden/side zones
  const owner = d.card.ownerId
  if (kind === 'library') {
    const v = await prompt({
      title: 'Put the card where?',
      kind: 'choice',
      options: [
        { label: 'Top of library', value: 'top' },
        { label: 'Bottom of library', value: 'bottom' },
      ],
    })
    if (v === 'top' || v === 'bottom') {
      send({ type: 'card.move', cardId: d.cardId, to: { zone: { kind: 'library', player: owner }, index: v } })
    }
    return
  }
  send({ type: 'card.move', cardId: d.cardId, to: { zone: { kind, player: owner } } })
}

// ---------- arrows (Alt+drag) ----------
function startArrowDrag(cardId: CardId, e: PointerEvent) {
  arrowDrag.value = { fromCardId: cardId, pointer: { x: e.clientX, y: e.clientY } }
  window.addEventListener('pointermove', onArrowMove)
  window.addEventListener('pointerup', onArrowUp)
}
function onArrowMove(e: PointerEvent) {
  if (arrowDrag.value) arrowDrag.value = { ...arrowDrag.value, pointer: { x: e.clientX, y: e.clientY } }
}
function onArrowUp(e: PointerEvent) {
  window.removeEventListener('pointermove', onArrowMove)
  window.removeEventListener('pointerup', onArrowUp)
  const d = arrowDrag.value
  arrowDrag.value = null
  if (!d) return
  for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
    const cardId = (el as HTMLElement).dataset?.cardId
    if (cardId && cardId !== d.fromCardId) {
      send({ type: 'card.arrow', fromCardId: d.fromCardId, toCardId: cardId, on: true })
      return
    }
    const playerId = (el as HTMLElement).closest?.('[data-player-target]')
      ? ((el as HTMLElement).closest('[data-player-target]') as HTMLElement).dataset.playerTarget
      : undefined
    if (playerId) {
      send({ type: 'card.arrow', fromCardId: d.fromCardId, toPlayerId: playerId, on: true })
      return
    }
  }
}

// ---------- context menus ----------
function moveChildren(card: RedactedCard): MenuItem[] {
  const owner = card.ownerId
  const mv = (label: string, kind: ZoneKind | 'stack', index?: 'top' | 'bottom') => ({
    label,
    onSelect: () =>
      send({
        type: 'card.move',
        cardId: card.id,
        to: kind === 'stack' ? { zone: { kind: 'stack' } } : { zone: { kind, player: kind === 'battlefield' ? store.you! : owner }, ...(index ? { index } : {}) },
        ...(kind === 'battlefield' ? { x: 0.42, y: 0.45 } : {}),
      }),
  })
  const items: MenuItem[] = []
  if (card.zone.kind !== 'battlefield') items.push(mv('Battlefield', 'battlefield'))
  if (card.zone.kind !== 'hand') items.push(mv('Hand', 'hand'))
  if (card.zone.kind !== 'graveyard') items.push(mv('Graveyard', 'graveyard'))
  if (card.zone.kind !== 'exile') items.push(mv('Exile', 'exile'))
  items.push(mv('Library (top)', 'library', 'top'), mv('Library (bottom)', 'library', 'bottom'))
  if (card.isCommander && card.zone.kind !== 'command') items.push(mv('Command zone', 'command'))
  if (card.zone.kind !== 'stack') items.push(mv('Stack', 'stack'))
  return items
}

async function addCardCounter(card: RedactedCard) {
  const name = await prompt({ title: 'Add a counter', kind: 'text', label: 'Counter name', initial: '+1/+1' })
  if (typeof name === 'string' && name.trim()) {
    send({ type: 'card.counter', cardId: card.id, name: name.trim(), delta: 1 })
  }
}
async function giveControl(card: RedactedCard) {
  const to = await pickPlayer('Give control to…', { excludeSelf: true })
  if (to && to !== 'all') send({ type: 'card.control', cardId: card.id, controllerId: to })
}
async function revealCard(card: RedactedCard) {
  const to = await pickPlayer('Reveal this card to…', { includeAll: true, excludeSelf: true })
  if (to === null) return
  send({ type: 'card.reveal', cardId: card.id, to: to === 'all' ? 'all' : [to] })
}
function cloneAsToken(card: RedactedCard) {
  const d = card.display
  if (!d) return
  send({
    type: 'token.create',
    spec: {
      name: d.name,
      pt: d.power != null && d.toughness != null ? `${d.power}/${d.toughness}` : null,
      colors: [],
      typeLine: d.typeLine.startsWith('Token') ? d.typeLine : `Token ${d.typeLine}`,
      text: (d.oracleText ?? '').slice(0, 500),
      fromCatalogId: card.catalogId,
    },
    quantity: 1,
    zone: 'battlefield',
    tapped: false,
  })
}

function cardMenuItems(card: RedactedCard, zone: CardMenuZone): MenuItem[][] {
  const groups: MenuItem[][] = []

  if (zone === 'battlefield') {
    const tapGroup: MenuItem[] = [
      {
        label: card.tapped ? 'Untap' : 'Tap',
        icon: 'i-lucide-rotate-cw',
        onSelect: () => send({ type: 'card.tap', cardIds: [card.id], tapped: !card.tapped }),
      },
    ]
    if (!card.tapped && canTapForMana(card)) {
      tapGroup.push({
        label: 'Tap for mana',
        icon: 'i-lucide-gem',
        onSelect: () => tapForMana(card),
      })
    }
    groups.push(tapGroup)
  }
  if (zone === 'hand') {
    groups.push([
      {
        label: 'Cast (use stack)',
        icon: 'i-lucide-sparkles',
        onSelect: () => castRef.value?.show(card),
      },
      {
        label: 'Play',
        icon: 'i-lucide-play',
        onSelect: () =>
          send({ type: 'card.move', cardId: card.id, to: { zone: { kind: 'battlefield', player: store.you! } }, x: 0.42, y: 0.45 }),
      },
      {
        label: 'Play face down',
        onSelect: () =>
          send({
            type: 'card.move',
            cardId: card.id,
            to: { zone: { kind: 'battlefield', player: store.you! } },
            faceDown: true,
            x: 0.42,
            y: 0.45,
          }),
      },
    ])
  }

  groups.push([{ label: 'Move to…', icon: 'i-lucide-move', children: moveChildren(card) }])

  if (zone === 'battlefield') {
    const tools: MenuItem[] = [
      {
        label: card.faceDown ? 'Turn face up' : 'Turn face down',
        icon: 'i-lucide-flip-vertical',
        onSelect: () => send({ type: 'card.face', cardId: card.id, faceDown: !card.faceDown }),
      },
      { label: 'Add counter…', icon: 'i-lucide-circle-plus', onSelect: () => addCardCounter(card) },
      {
        label: 'Attach to…',
        icon: 'i-lucide-link',
        onSelect: () => {
          attachSource.value = card.id
          toast.add({ title: 'Attach', description: 'Click the card to attach to (Esc cancels).', color: 'info' })
        },
      },
    ]
    if (card.display?.backImageSmall) {
      tools.splice(1, 0, {
        label: card.faceIndex === 1 ? 'Transform (front face)' : 'Transform',
        icon: 'i-lucide-refresh-cw',
        onSelect: () => send({ type: 'card.face', cardId: card.id, faceIndex: card.faceIndex === 1 ? 0 : 1 }),
      })
    }
    if (card.attachedTo) {
      tools.push({
        label: 'Unattach',
        icon: 'i-lucide-unlink',
        onSelect: () => send({ type: 'card.attach', cardId: card.id, targetId: null }),
      })
    }
    tools.push(
      { label: 'Give control to…', icon: 'i-lucide-user-check', onSelect: () => giveControl(card) },
      { label: 'Reveal to…', icon: 'i-lucide-eye', onSelect: () => revealCard(card) },
    )
    groups.push(tools)
    groups.push([
      { label: 'Create token from this card…', icon: 'i-lucide-sparkles', onSelect: () => tokenRef.value?.show(card) },
      { label: 'Clone as token', icon: 'i-lucide-copy', disabled: !card.display, onSelect: () => cloneAsToken(card) },
    ])
  } else if (zone === 'hand') {
    groups.push([{ label: 'Reveal to…', icon: 'i-lucide-eye', onSelect: () => revealCard(card) }])
  }

  return groups
}

// ---------- keyboard ----------
function myBattlefieldSelection(): CardId[] {
  const s = store.state
  if (!s) return []
  return [...selected.value].filter((id) => {
    const c = s.cards[id]
    return c && c.controllerId === s.you && c.zone.kind === 'battlefield'
  })
}
function onKeydown(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if (e.code === 'Space') {
    e.preventDefault()
    if (store.isMyTurn) {
      if (e.shiftKey) send({ type: 'turn.pass' })
      else send({ type: 'turn.next' })
    }
  } else if (e.key === 't' || e.key === 'T' || e.key === 'u' || e.key === 'U') {
    const ids = myBattlefieldSelection()
    if (ids.length) send({ type: 'card.tap', cardIds: ids, tapped: e.key === 't' || e.key === 'T' })
  } else if (e.key === 'g' || e.key === 'G') {
    snapToGrid.value = !snapToGrid.value
    toast.add({ title: `Grid snapping ${snapToGrid.value ? 'on' : 'off'}`, duration: 1200 })
  } else if (e.key === 'Escape') {
    attachSource.value = null
    clearSelection()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  detachDragListeners()
  window.removeEventListener('pointermove', onArrowMove)
  window.removeEventListener('pointerup', onArrowUp)
})

// ---------- dice / coin toasts ----------
watch(
  () => store.lastExtra,
  (extra) => {
    if (!extra || (extra.type !== 'game.roll' && extra.type !== 'game.coin')) return
    const actor = extra.actor ? (store.state?.players[extra.actor]?.name ?? '?') : '?'
    const results = (extra.extra.results as (number | string)[] | undefined) ?? []
    toast.add({
      title: extra.type === 'game.roll' ? `${actor} rolled d${extra.extra.sides}` : `${actor} flipped a coin`,
      description: results.join(', '),
      icon: extra.type === 'game.roll' ? 'i-lucide-dices' : 'i-lucide-circle-dot',
    })
  },
)

// ---------- provide ----------
async function promptN(title: string, run: (n: number) => void) {
  const n = await prompt({ title, kind: 'number', label: 'How many?', initial: 1, min: 1, max: 200 })
  if (typeof n === 'number' && n >= 1) run(n)
}
function libraryMenuItems() {
  return [
    [
      { label: 'Draw 1', icon: 'i-lucide-copy-plus', onSelect: () => send({ type: 'deck.draw', n: 1 }) },
      { label: 'Draw X…', onSelect: () => promptN('Draw how many?', (n) => send({ type: 'deck.draw', n })) },
    ],
    [
      { label: 'Scry X…', onSelect: () => promptN('Scry how many?', (n) => send({ type: 'deck.scry', n })) },
      { label: 'Look at top X…', onSelect: () => promptN('Look at how many?', (n) => send({ type: 'deck.look', n })) },
      { label: 'Search library…', icon: 'i-lucide-search', onSelect: () => send({ type: 'deck.search' }) },
    ],
    [
      { label: 'Shuffle', icon: 'i-lucide-shuffle', onSelect: () => send({ type: 'deck.shuffle' }) },
      { label: 'Reveal top X…', icon: 'i-lucide-eye', onSelect: () => promptN('Reveal how many?', (n) => send({ type: 'deck.revealTop', n })) },
    ],
  ]
}
const boardUi: BoardUi = {
  get you() {
    return store.state?.you ?? ''
  },
  send,
  selected,
  attachSource,
  drag,
  dropHover,
  arrowDrag,
  bottomingActive,
  bottoming,
  snapToGrid,
  preview,
  showPreview: (display, faceIndex = 0) => (preview.value = { display, faceIndex }),
  hidePreview: () => (preview.value = null),
  prompt,
  pickPlayer,
  openTokenDialog: (fromCard?: RedactedCard) => tokenRef.value?.show(fromCard),
  openCast: (card) => castRef.value?.show(card),
  openZoneBrowser: (pid, kind) => browserRef.value?.show(pid, kind),
  libraryMenuItems,
  tapForMana,
  canTapForMana,
  cardMenuItems,
  startBattlefieldDrag,
  startGhostDrag,
  startArrowDrag,
  toggleSelect,
  clearSelection,
  tryAttachTo,
}
provide(BOARD_UI_KEY, boardUi)

// ---------- layout ----------
const quadrants = computed(() => {
  const s = store.state
  if (!s) return { style: {}, cells: [] as { playerId: PlayerId; area: string }[] }
  const players = Object.values(s.players).sort((a, b) => a.seat - b.seat)
  const meIdx = Math.max(0, players.findIndex((p) => p.id === s.you))
  const ordered = [...players.slice(meIdx), ...players.slice(0, meIdx)]
  const n = ordered.length
  let areas = '"a"'
  if (n === 2) areas = '"b" "a"'
  else if (n === 3) areas = '"b c" "a a"'
  else if (n >= 4) areas = '"b c" "a d"'
  const names = ['a', 'b', 'c', 'd']
  return {
    style: {
      display: 'grid',
      gridTemplateAreas: areas,
      gridTemplateColumns: n >= 3 ? '1fr 1fr' : '1fr',
      gridTemplateRows: n >= 2 ? '1fr 1fr' : '1fr',
      gap: '4px',
    },
    cells: ordered.slice(0, 4).map((p, i) => ({ playerId: p.id, area: names[i]! })),
  }
})


const winnerName = computed(() => {
  const s = store.state
  if (!s || s.winnerSeat === null) return null
  return Object.values(s.players).find((p) => p.seat === s.winnerSeat)?.name ?? null
})
const gameOverDismissed = ref(false)
</script>

<template>
  <div class="fixed inset-0 flex flex-col bg-default text-default overflow-hidden" :class="attachSource ? 'cursor-crosshair' : ''">
    <!-- pre-sync splash -->
    <div v-if="!store.state" class="flex-1 flex flex-col items-center justify-center gap-3 text-dimmed">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-8" />
      <p>{{ store.conn === 'down' ? 'Reconnecting to the game…' : 'Joining the table…' }}</p>
    </div>

    <template v-else>
      <BoardPhaseRibbon />

      <div class="flex flex-1 min-h-0">
        <!-- board area -->
        <div class="relative flex-1 min-w-0 p-1" :style="quadrants.style">
          <BoardBattlefieldQuadrant
            v-for="cell in quadrants.cells"
            :key="cell.playerId"
            :player-id="cell.playerId"
            :style="{ gridArea: cell.area }"
          />

          <!-- the stack — central floating zone, visible to all -->
          <BoardStackOverlay />

          <BoardArrowsOverlay />
        </div>

        <BoardSidePanel class="w-72 shrink-0 border-l border-default" />
      </div>

      <BoardMulliganBar v-if="store.state.status === 'mulligans'" />
      <BoardHandStrip />

      <!-- ghost card while dragging from hand/browser -->
      <div
        v-if="drag && !drag.battlefield && drag.moved"
        class="fixed z-50 pointer-events-none opacity-80"
        :style="{ left: `${drag.pointer.x - 42}px`, top: `${drag.pointer.y - 58}px` }"
      >
        <BoardCardView :card="drag.card" :width="84" :show-counters="false" />
      </div>

      <!-- overlays -->
      <BoardCardPreview />
      <BoardPeekOverlay />
      <BoardTokenDialog ref="tokenRef" />
      <BoardCastDialog ref="castRef" />
      <BoardZoneBrowser ref="browserRef" />
      <BoardRevealDialog />

      <!-- game over -->
      <div
        v-if="store.state.status === 'ended' && !gameOverDismissed"
        class="absolute inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center"
      >
        <div class="rounded-2xl bg-elevated border border-default p-8 text-center space-y-4 max-w-sm">
          <p class="text-3xl">🏆</p>
          <h2 class="text-xl font-bold text-highlighted">
            {{ winnerName ? `${winnerName} wins!` : 'Game over' }}
          </h2>
          <p class="text-sm text-dimmed">Thanks for playing — head back to the lobby to rematch.</p>
          <div class="flex justify-center gap-2">
            <UButton variant="soft" color="neutral" @click="() => { gameOverDismissed = true }">View final board</UButton>
            <UButton to="/">Back home</UButton>
          </div>
        </div>
      </div>
    </template>

    <BoardPromptDialog ref="promptRef" />
  </div>
</template>
