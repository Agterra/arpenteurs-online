<script setup lang="ts">
/**
 * One player's battlefield quadrant: HUD strip + free-position card area.
 * Handles per-card pointer interactions (drag, tap, select, arrows, context
 * menu) and the marquee multi-select on empty space.
 */
import type { PlayerId, RedactedCard } from '#shared/types/game'
import { CARD_H, CARD_W, GRID_COL, GRID_ROW } from '~/composables/useBoardUi'
import { useGameStore } from '~/stores/game'

const props = defineProps<{ playerId: PlayerId }>()
const store = useGameStore()
const ui = useBoardUi()

const areaEl = ref<HTMLElement | null>(null)

interface HostGroup {
  host: RedactedCard
  attachments: RedactedCard[]
}

/** Battlefield ids grouped: hosts positioned by x/y, attachments stacked behind their host. */
const groups = computed<HostGroup[]>(() => {
  const s = store.state!
  const ids = s.zones.perPlayer[props.playerId]?.battlefield ?? []
  const cards = ids.map((id) => s.cards[id]).filter((c): c is RedactedCard => !!c)
  const present = new Set(cards.map((c) => c.id))
  const byHost = new Map<string, RedactedCard[]>()
  for (const c of cards) {
    if (c.attachedTo && present.has(c.attachedTo)) {
      const list = byHost.get(c.attachedTo) ?? []
      list.push(c)
      byHost.set(c.attachedTo, list)
    }
  }
  return cards
    .filter((c) => !(c.attachedTo && present.has(c.attachedTo)))
    .map((host) => ({ host, attachments: byHost.get(host.id) ?? [] }))
})

function hostStyle(card: RedactedCard) {
  return {
    left: `calc(${card.x} * (100% - ${CARD_W}px))`,
    top: `calc(${card.y} * (100% - ${CARD_H}px))`,
    zIndex: ui.drag.value?.cardId === card.id ? 50 : undefined,
  }
}

function isMine(card: RedactedCard) {
  return card.controllerId === ui.you
}

function onCardPointerDown(card: RedactedCard, e: PointerEvent) {
  if (e.button === 2) return // context menu
  if (ui.tryAttachTo(card)) {
    e.stopPropagation()
    return
  }
  if (e.altKey) {
    e.preventDefault()
    e.stopPropagation()
    ui.startArrowDrag(card.id, e)
    return
  }
  if (!isMine(card)) return
  e.stopPropagation()
  if (e.shiftKey) {
    ui.toggleSelect(card.id, true)
    return
  }
  if (!ui.selected.value.has(card.id)) ui.toggleSelect(card.id, false)
  ui.startBattlefieldDrag(card, e)
}

function onCardDblClick(card: RedactedCard) {
  if (!isMine(card)) return
  const multi = ui.selected.value.has(card.id) && ui.selected.value.size > 1
  // Single untapped land → tap for its mana (Arena-fast). Plain tap stays on the
  // right-click menu for the edge cases (attacking creature-lands, don't-want-mana).
  const isLand = (card.display?.typeLine ?? '').toLowerCase().includes('land')
  if (!multi && isLand && !card.tapped && ui.canTapForMana(card)) {
    ui.tapForMana(card)
    return
  }
  const ids = multi ? [...ui.selected.value] : [card.id]
  ui.send({ type: 'card.tap', cardIds: ids, tapped: !card.tapped })
}

function onCounter(card: RedactedCard, name: string, delta: number) {
  if (isMine(card)) ui.send({ type: 'card.counter', cardId: card.id, name, delta })
}

// ---- marquee select on empty area ----
const marquee = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
function onAreaPointerDown(e: PointerEvent) {
  if (e.button !== 0 || e.altKey) return
  ui.clearSelection()
  const start = { x: e.clientX, y: e.clientY }
  marquee.value = { x0: start.x, y0: start.y, x1: start.x, y1: start.y }
  const move = (ev: PointerEvent) => {
    marquee.value = { x0: start.x, y0: start.y, x1: ev.clientX, y1: ev.clientY }
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    finishMarquee()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function finishMarquee() {
  const m = marquee.value
  marquee.value = null
  if (!m) return
  const [minX, maxX] = [Math.min(m.x0, m.x1), Math.max(m.x0, m.x1)]
  const [minY, maxY] = [Math.min(m.y0, m.y1), Math.max(m.y0, m.y1)]
  if (maxX - minX < 6 && maxY - minY < 6) return
  const picked = new Set(ui.selected.value)
  for (const g of groups.value) {
    if (!isMine(g.host)) continue
    const el = areaEl.value?.querySelector(`[data-card-id="${g.host.id}"]`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) picked.add(g.host.id)
  }
  ui.selected.value = picked
}

const marqueeStyle = computed(() => {
  const m = marquee.value
  const area = areaEl.value
  if (!m || !area) return null
  const r = area.getBoundingClientRect()
  return {
    left: `${Math.min(m.x0, m.x1) - r.left}px`,
    top: `${Math.min(m.y0, m.y1) - r.top}px`,
    width: `${Math.abs(m.x1 - m.x0)}px`,
    height: `${Math.abs(m.y1 - m.y0)}px`,
  }
})

const highlighted = computed(() => ui.dropHover.value === `${props.playerId}:battlefield`)
const isMyQuadrant = computed(() => props.playerId === store.you)
// Faint grid backdrop on your own play area while snapping is on, so the grid is
// visible. Cell size matches the snap step in GameBoard.battlefieldXY.
const gridStyle = computed(() => ({
  backgroundSize: `${GRID_COL}px ${GRID_ROW}px`,
  backgroundImage:
    'linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px),' +
    'linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)',
}))
</script>

<template>
  <div class="flex flex-col min-h-0 min-w-0 overflow-hidden border border-default/60 rounded-sm bg-default">
    <BoardPlayerHud :player-id="playerId" />
    <div
      ref="areaEl"
      class="relative flex-1 min-h-0"
      :class="highlighted ? 'bg-sky-500/10 ring-2 ring-inset ring-sky-400/70' : 'bg-stone-900/40'"
      :data-drop="`${playerId}:battlefield`"
      @pointerdown="onAreaPointerDown"
    >
      <div
        v-if="isMyQuadrant && ui.snapToGrid.value"
        class="pointer-events-none absolute inset-0"
        :style="gridStyle"
      />
      <div
        v-for="g in groups"
        :key="g.host.id"
        class="absolute"
        :style="hostStyle(g.host)"
      >
        <!-- attachments stacked behind the host -->
        <div
          v-for="(att, i) in g.attachments"
          :key="att.id"
          class="absolute"
          :style="{ left: `${(i + 1) * 16}px`, top: `${-(i + 1) * 14}px`, zIndex: -1 - i }"
          :data-card-id="att.id"
          @pointerdown="onCardPointerDown(att, $event)"
          @dblclick="onCardDblClick(att)"
        >
          <UContextMenu v-if="isMine(att)" :items="ui.cardMenuItems(att, 'battlefield')">
            <BoardCardView
              :card="att"
              :width="CARD_W"
              :interactive="isMine(att)"
              :selected="ui.selected.value.has(att.id)"
              @counter="(n, d) => onCounter(att, n, d)"
            />
          </UContextMenu>
          <BoardCardView v-else :card="att" :width="CARD_W" />
        </div>

        <!-- host -->
        <div
          :data-card-id="g.host.id"
          :class="[
            ui.drag.value?.cardId === g.host.id ? 'pointer-events-none' : '',
            isMine(g.host) ? 'cursor-grab' : '',
            ui.attachSource.value && ui.attachSource.value !== g.host.id ? 'cursor-crosshair' : '',
          ]"
          @pointerdown="onCardPointerDown(g.host, $event)"
          @dblclick="onCardDblClick(g.host)"
        >
          <UContextMenu v-if="isMine(g.host)" :items="ui.cardMenuItems(g.host, 'battlefield')">
            <BoardCardView
              :card="g.host"
              :width="CARD_W"
              :interactive="isMine(g.host)"
              :selected="ui.selected.value.has(g.host.id)"
              @counter="(n, d) => onCounter(g.host, n, d)"
            />
          </UContextMenu>
          <BoardCardView v-else :card="g.host" :width="CARD_W" />
        </div>
      </div>

      <!-- marquee rectangle -->
      <div v-if="marqueeStyle" class="absolute border border-sky-400 bg-sky-400/10 pointer-events-none z-40" :style="marqueeStyle" />
    </div>
  </div>
</template>
