<script setup lang="ts">
/**
 * SVG overlay for attack/target arrows. Endpoints are resolved live from the
 * DOM ([data-card-id] / [data-player-target]) on an animation-frame loop while
 * arrows exist, so they track card drags. Alt+click one of your own arrows to
 * remove it.
 */
import { SEAT_COLORS } from '~/composables/useBoardUi'
import { useGameStore } from '~/stores/game'

const store = useGameStore()
const ui = useBoardUi()

const rootEl = ref<SVGSVGElement | null>(null)

interface Line {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  mine: boolean
  key: string
  arrow: (typeof store.arrows)[number]
}
const lines = ref<Line[]>([])
const dragLine = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

function center(sel: string, rootRect: DOMRect): { x: number; y: number } | null {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2 - rootRect.left, y: r.top + r.height / 2 - rootRect.top }
}

function recompute() {
  const root = rootEl.value
  if (!root) return
  const rect = root.getBoundingClientRect()
  const out: Line[] = []
  for (const a of store.arrows) {
    const from = center(`[data-card-id="${CSS.escape(a.fromCardId)}"]`, rect)
    const to = a.toCardId
      ? center(`[data-card-id="${CSS.escape(a.toCardId)}"]`, rect)
      : a.toPlayerId
        ? center(`[data-player-target="${CSS.escape(a.toPlayerId)}"]`, rect)
        : null
    if (!from || !to) continue
    const seat = store.state?.players[a.actor]?.seat ?? 0
    out.push({
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      color: SEAT_COLORS[seat % SEAT_COLORS.length]!,
      mine: a.actor === ui.you,
      key: `${a.actor}:${a.fromCardId}:${a.toCardId ?? a.toPlayerId}`,
      arrow: a,
    })
  }
  lines.value = out

  const d = ui.arrowDrag.value
  if (d) {
    const from = center(`[data-card-id="${CSS.escape(d.fromCardId)}"]`, rect)
    dragLine.value = from ? { x1: from.x, y1: from.y, x2: d.pointer.x - rect.left, y2: d.pointer.y - rect.top } : null
  } else {
    dragLine.value = null
  }
}

let raf = 0
function loop() {
  recompute()
  raf = requestAnimationFrame(loop)
}
watch(
  () => store.arrows.length > 0 || !!ui.arrowDrag.value,
  (active) => {
    cancelAnimationFrame(raf)
    if (active) loop()
    else {
      lines.value = []
      dragLine.value = null
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => cancelAnimationFrame(raf))

function onLineClick(line: Line, e: MouseEvent) {
  if (!e.altKey || !line.mine) return
  ui.send({
    type: 'card.arrow',
    fromCardId: line.arrow.fromCardId,
    ...(line.arrow.toCardId ? { toCardId: line.arrow.toCardId } : {}),
    ...(line.arrow.toPlayerId ? { toPlayerId: line.arrow.toPlayerId } : {}),
    on: false,
  })
}
</script>

<template>
  <svg ref="rootEl" class="absolute inset-0 h-full w-full pointer-events-none z-30">
    <defs>
      <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
      </marker>
    </defs>
    <g v-for="line in lines" :key="line.key">
      <!-- fat invisible hit line so Alt+click works -->
      <line
        :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2"
        stroke="transparent" stroke-width="14"
        :class="line.mine ? 'pointer-events-auto cursor-pointer' : ''"
        @click="onLineClick(line, $event)"
      />
      <line
        :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2"
        :stroke="line.color" stroke-width="3" stroke-linecap="round" opacity="0.85"
        marker-end="url(#arrowhead)"
      />
    </g>
    <line
      v-if="dragLine"
      :x1="dragLine.x1" :y1="dragLine.y1" :x2="dragLine.x2" :y2="dragLine.y2"
      stroke="#38bdf8" stroke-width="3" stroke-dasharray="6 4" stroke-linecap="round" opacity="0.9"
      marker-end="url(#arrowhead)"
    />
  </svg>
</template>
