<script setup lang="ts">
/**
 * Library peek overlay (scry / look / search), driven by store.state.peek.
 * scry & look: drag (HTML5 DnD) or click cards between the "Top (in order)"
 * and "Bottom" lanes, then resolve. search: filter box + per-card destination,
 * resolve moves; cancel warns that a search always shuffles.
 */
import type { CardId, RedactedCard } from '#shared/types/game'
import { useGameStore } from '~/stores/game'

const store = useGameStore()
const ui = useBoardUi()

const peek = computed(() => store.state?.peek ?? null)
const open = computed(() => !!peek.value)

const cardById = computed(() => {
  const map = new Map<CardId, RedactedCard>()
  for (const c of peek.value?.cards ?? []) map.set(c.id, c)
  return map
})

// ---- scry / look lanes ----
const topIds = ref<CardId[]>([])
const bottomIds = ref<CardId[]>([])
// ---- search picks ----
const filter = ref('')
const picks = ref<Map<CardId, 'hand' | 'battlefield' | 'graveyard'>>(new Map())

watch(
  peek,
  (p) => {
    topIds.value = p ? [...p.cardIds] : []
    bottomIds.value = []
    picks.value = new Map()
    filter.value = ''
  },
  { immediate: true },
)

// HTML5 drag between lanes
const draggingId = ref<CardId | null>(null)
function onDragStart(id: CardId, e: DragEvent) {
  draggingId.value = id
  e.dataTransfer?.setData('text/plain', id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function removeEverywhere(id: CardId) {
  topIds.value = topIds.value.filter((x) => x !== id)
  bottomIds.value = bottomIds.value.filter((x) => x !== id)
}
/** Drop on a lane (append) or on a card inside a lane (insert before it). */
function onDrop(lane: 'top' | 'bottom', beforeId: CardId | null) {
  const id = draggingId.value
  draggingId.value = null
  if (!id || id === beforeId) return
  removeEverywhere(id)
  const arr = lane === 'top' ? topIds : bottomIds
  const idx = beforeId ? arr.value.indexOf(beforeId) : -1
  if (idx >= 0) arr.value.splice(idx, 0, id)
  else arr.value.push(id)
}
function sendTo(lane: 'top' | 'bottom', id: CardId) {
  removeEverywhere(id)
  ;(lane === 'top' ? topIds : bottomIds).value.push(id)
}

function resolveScry() {
  ui.send({ type: 'peek.resolve', toTop: topIds.value, toBottom: bottomIds.value, moves: [] })
}

// ---- search ----
const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const cards = peek.value?.cards ?? []
  if (!q) return cards
  return cards.filter((c) => c.display?.name.toLowerCase().includes(q))
})
const DESTS = [
  { value: 'hand', label: 'Hand' },
  { value: 'battlefield', label: 'Battlefield' },
  { value: 'graveyard', label: 'Graveyard' },
] as const
function togglePick(id: CardId, dest: 'hand' | 'battlefield' | 'graveyard') {
  const map = new Map(picks.value)
  if (map.get(id) === dest) map.delete(id)
  else map.set(id, dest)
  picks.value = map
}
function resolveSearch() {
  const moves = [...picks.value.entries()].map(([cardId, kind]) => ({
    cardId,
    to: { zone: { kind, player: ui.you } },
  }))
  ui.send({ type: 'peek.resolve', toTop: [], toBottom: [], moves })
}

async function cancel() {
  if (peek.value?.mode === 'search') {
    const ok = await ui.prompt({
      title: 'Cancel search?',
      kind: 'confirm',
      label: 'Your library gets shuffled either way.',
      confirmLabel: 'Close & shuffle',
    })
    if (!ok) return
  }
  ui.send({ type: 'peek.cancel' })
}

const title = computed(() => {
  const p = peek.value
  if (!p) return ''
  if (p.mode === 'scry') return `Scry ${p.n}`
  if (p.mode === 'look') return `Looking at the top ${p.n}`
  return 'Searching your library'
})
</script>

<template>
  <UModal :open="open" :title="title" :dismissible="false" :close="false" :ui="{ content: 'max-w-4xl' }">
    <template #body>
      <div v-if="peek" class="space-y-4">
        <!-- scry / look: two lanes -->
        <template v-if="peek.mode !== 'search'">
          <div
            class="rounded-lg border border-default p-2"
            @dragover.prevent
            @drop.prevent="onDrop('top', null)"
          >
            <p class="text-xs font-semibold text-dimmed mb-1.5">Top (in order — first card is drawn next)</p>
            <div class="flex gap-2 flex-wrap min-h-24">
              <div
                v-for="id in topIds"
                :key="id"
                draggable="true"
                class="cursor-grab"
                @dragstart="onDragStart(id, $event)"
                @dragover.prevent
                @drop.prevent.stop="onDrop('top', id)"
              >
                <BoardCardView v-if="cardById.get(id)" :card="cardById.get(id)!" :width="80" :show-counters="false" />
                <UButton size="xs" variant="ghost" block class="mt-0.5" @click="sendTo('bottom', id)">↓ bottom</UButton>
              </div>
            </div>
          </div>
          <div
            class="rounded-lg border border-dashed border-default p-2"
            @dragover.prevent
            @drop.prevent="onDrop('bottom', null)"
          >
            <p class="text-xs font-semibold text-dimmed mb-1.5">Bottom of library</p>
            <div class="flex gap-2 flex-wrap min-h-24">
              <p v-if="!bottomIds.length" class="text-xs text-dimmed self-center px-2">Drag cards here (or use the buttons).</p>
              <div
                v-for="id in bottomIds"
                :key="id"
                draggable="true"
                class="cursor-grab"
                @dragstart="onDragStart(id, $event)"
                @dragover.prevent
                @drop.prevent.stop="onDrop('bottom', id)"
              >
                <BoardCardView v-if="cardById.get(id)" :card="cardById.get(id)!" :width="80" :show-counters="false" />
                <UButton size="xs" variant="ghost" block class="mt-0.5" @click="sendTo('top', id)">↑ top</UButton>
              </div>
            </div>
          </div>
        </template>

        <!-- search -->
        <template v-else>
          <UInput v-model="filter" placeholder="Filter by name…" icon="i-lucide-search" autofocus class="w-full" />
          <div class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3 max-h-96 overflow-y-auto pr-1">
            <div v-for="card in filtered" :key="card.id" class="space-y-1">
              <BoardCardView :card="card" :width="96" :show-counters="false" />
              <div class="flex flex-col gap-0.5">
                <UButton
                  v-for="dest in DESTS"
                  :key="dest.value"
                  size="xs"
                  :variant="picks.get(card.id) === dest.value ? 'solid' : 'ghost'"
                  :color="picks.get(card.id) === dest.value ? 'primary' : 'neutral'"
                  block
                  @click="togglePick(card.id, dest.value)"
                >
                  {{ dest.label }}
                </UButton>
              </div>
            </div>
          </div>
          <p class="text-xs text-dimmed">
            {{ picks.size }} card{{ picks.size === 1 ? '' : 's' }} selected — the rest go back and your library is shuffled.
          </p>
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" color="neutral" @click="cancel">
          {{ peek?.mode === 'search' ? 'Cancel (shuffles)' : 'Put back' }}
        </UButton>
        <UButton v-if="peek?.mode === 'search'" @click="resolveSearch">Take {{ picks.size }} & shuffle</UButton>
        <UButton v-else @click="resolveScry">Done</UButton>
      </div>
    </template>
  </UModal>
</template>
