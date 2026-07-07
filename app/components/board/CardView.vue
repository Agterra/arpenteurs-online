<script setup lang="ts">
/**
 * Presentational card. Renders image / card back / text fallback, tap
 * rotation, face-down + transform faces, counter chips and hover preview.
 * All pointer/drag/menu behavior belongs to the parent.
 */
import type { RedactedCard } from '#shared/types/game'

const props = withDefaults(
  defineProps<{
    card: RedactedCard
    width?: number
    /** counter chips clickable (controller only) */
    interactive?: boolean
    selected?: boolean
    showCounters?: boolean
  }>(),
  { width: 84, interactive: false, selected: false, showCounters: true },
)

const emit = defineEmits<{ counter: [name: string, delta: number] }>()

const ui = useBoardUiOptional()

const height = computed(() => Math.round((props.width * 88) / 63))

// what face to show
const showBack = computed(() => props.card.hidden === true || (props.card.faceDown && !props.card.display))
const imgSrc = computed(() => {
  const d = props.card.display
  if (!d) return null
  return props.card.faceIndex === 1 && d.backImageSmall ? d.backImageSmall : d.imageSmall
})
const imgFailed = ref(false)
watch(imgSrc, () => (imgFailed.value = false))

const placeholder = computed(() => {
  const d = props.card.display
  if (d) {
    return {
      name: d.name,
      manaCost: d.manaCost,
      typeLine: d.typeLine,
      pt: d.power != null && d.toughness != null ? `${d.power}/${d.toughness}` : null,
    }
  }
  const t = props.card.tokenSpec
  if (t) return { name: t.name, manaCost: null, typeLine: t.typeLine, pt: t.pt }
  return { name: 'Card', manaCost: null, typeLine: '', pt: null }
})

const counterEntries = computed(() => Object.entries(props.card.counters ?? {}).filter(([, n]) => n !== 0))

// ---- hover preview (≥250 ms) ----
let hoverTimer: ReturnType<typeof setTimeout> | null = null
function onEnter() {
  if (!ui || showBack.value || !props.card.display) return
  hoverTimer = setTimeout(() => ui.showPreview(props.card.display!, props.card.faceIndex), 250)
}
function onLeave() {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = null
  ui?.hidePreview()
}
onBeforeUnmount(onLeave)
</script>

<template>
  <div
    class="relative select-none transition-transform duration-150"
    :style="{
      width: `${width}px`,
      height: `${height}px`,
      transform: card.tapped ? 'rotate(90deg)' : undefined,
    }"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <div
      class="absolute inset-0 overflow-hidden rounded-md ring-offset-0"
      :class="[
        selected ? 'ring-2 ring-sky-400' : 'ring-1 ring-black/40',
        card.faceDown && card.display ? 'opacity-90' : '',
      ]"
    >
      <!-- card back -->
      <div
        v-if="showBack"
        class="h-full w-full flex items-center justify-center bg-gradient-to-br from-amber-900 via-amber-950 to-stone-950"
      >
        <span class="text-amber-500/70 font-serif italic text-lg">A</span>
      </div>

      <!-- image -->
      <img
        v-else-if="imgSrc && !imgFailed"
        :src="imgSrc"
        :alt="placeholder.name"
        class="h-full w-full object-cover"
        draggable="false"
        @error="imgFailed = true"
      >

      <!-- text fallback (custom token or image outage) -->
      <div v-else class="h-full w-full flex flex-col bg-stone-800 text-stone-100 p-1 text-[9px] leading-tight">
        <div class="flex justify-between gap-0.5 font-semibold">
          <span class="truncate">{{ placeholder.name }}</span>
          <span v-if="placeholder.manaCost" class="shrink-0">{{ placeholder.manaCost }}</span>
        </div>
        <div class="text-stone-400 truncate">{{ placeholder.typeLine }}</div>
        <div class="grow" />
        <div v-if="card.tokenSpec?.text" class="text-[8px] text-stone-300 line-clamp-4">{{ card.tokenSpec.text }}</div>
        <div v-if="placeholder.pt" class="text-right font-bold">{{ placeholder.pt }}</div>
      </div>

      <!-- face-down marker for the owner (who still sees the face) -->
      <div v-if="card.faceDown && card.display" class="absolute top-0.5 left-0.5 rounded bg-black/70 px-1 text-[9px] text-amber-300">
        face down
      </div>
      <div v-if="card.isCommander" class="absolute top-0.5 right-0.5 rounded bg-black/60 px-0.5 text-[9px] text-yellow-300" title="Commander">★</div>
    </div>

    <!-- counter chips -->
    <div v-if="showCounters && counterEntries.length" class="absolute -bottom-1 left-0 right-0 flex flex-wrap justify-center gap-0.5 z-10">
      <button
        v-for="[name, n] in counterEntries"
        :key="name"
        class="rounded-full bg-emerald-700 text-white text-[9px] leading-none px-1 py-0.5 shadow ring-1 ring-black/50"
        :class="interactive ? 'cursor-pointer hover:bg-emerald-600' : 'cursor-default'"
        :title="`${name} — click +1, right-click −1`"
        @click.stop="interactive && emit('counter', name, 1)"
        @contextmenu.stop.prevent="interactive && emit('counter', name, -1)"
        @pointerdown.stop
        @dblclick.stop
      >
        {{ name === '+1/+1' ? `+${n}/+${n}` : `${name} ${n}` }}
      </button>
    </div>
  </div>
</template>
