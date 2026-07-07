<script setup lang="ts">
/**
 * Your own library / graveyard / exile as clear, interactive tiles in the free
 * space beside the hand. (Opponents' equivalents stay as compact read-only
 * chips in their PlayerHud.) Each tile is a drag drop-target:
 *  - Library: dropdown → draw / scry / look / search / shuffle / reveal top
 *  - Graveyard / Exile: click to browse; drop a card to send it there
 */
import type { RedactedCard } from '#shared/types/game'
import { useGameStore } from '~/stores/game'

const store = useGameStore()
const ui = useBoardUi()

const zones = computed(() => store.state?.zones.perPlayer[ui.you])
const libraryCount = computed(() => zones.value?.library.count ?? 0)
const graveIds = computed(() => zones.value?.graveyard ?? [])
const exileIds = computed(() => zones.value?.exile ?? [])
const topCard = (ids: string[]): RedactedCard | undefined =>
  ids.length ? store.state?.cards[ids[ids.length - 1]!] : undefined
const dropRing = (key: string) =>
  ui.dropHover.value === key ? 'ring-2 ring-sky-400' : 'ring-1 ring-white/10'
</script>

<template>
  <div v-if="zones" class="flex items-end gap-2 shrink-0">
    <!-- Library -->
    <div class="flex flex-col items-center gap-0.5">
      <UDropdownMenu :items="ui.libraryMenuItems()">
        <button
          class="h-16 w-11 rounded-md bg-gradient-to-br from-indigo-700 to-indigo-950 text-indigo-100 flex items-center justify-center shadow hover:from-indigo-600"
          :class="dropRing(`${ui.you}:library`)"
          :data-drop="`${ui.you}:library`"
          title="Library — draw, scry, look, search, shuffle, reveal"
        >
          <span class="text-lg font-black tabular-nums">{{ libraryCount }}</span>
        </button>
      </UDropdownMenu>
      <span class="text-[10px] text-dimmed leading-none">Library</span>
    </div>

    <!-- Graveyard -->
    <div class="flex flex-col items-center gap-0.5">
      <button
        class="relative h-16 w-11 rounded-md bg-stone-800/80 flex items-center justify-center overflow-hidden hover:bg-stone-700"
        :class="dropRing(`${ui.you}:graveyard`)"
        :data-drop="`${ui.you}:graveyard`"
        title="Graveyard — click to browse"
        @click="ui.openZoneBrowser(ui.you, 'graveyard')"
      >
        <BoardCardView v-if="topCard(graveIds)" :card="topCard(graveIds)!" :width="44" :show-counters="false" />
        <span v-else class="text-[10px] text-dimmed">empty</span>
        <span
          v-if="graveIds.length"
          class="absolute bottom-0 inset-x-0 bg-black/70 text-center text-[10px] font-bold text-white leading-tight"
        >{{ graveIds.length }}</span>
      </button>
      <span class="text-[10px] text-dimmed leading-none">Graveyard</span>
    </div>

    <!-- Exile -->
    <div class="flex flex-col items-center gap-0.5">
      <button
        class="relative h-16 w-11 rounded-md bg-stone-800/80 flex items-center justify-center overflow-hidden hover:bg-stone-700"
        :class="dropRing(`${ui.you}:exile`)"
        :data-drop="`${ui.you}:exile`"
        title="Exile — click to browse"
        @click="ui.openZoneBrowser(ui.you, 'exile')"
      >
        <BoardCardView v-if="topCard(exileIds)" :card="topCard(exileIds)!" :width="44" :show-counters="false" />
        <span v-else class="text-[10px] text-dimmed">empty</span>
        <span
          v-if="exileIds.length"
          class="absolute bottom-0 inset-x-0 bg-black/70 text-center text-[10px] font-bold text-white leading-tight"
        >{{ exileIds.length }}</span>
      </button>
      <span class="text-[10px] text-dimmed leading-none">Exile</span>
    </div>
  </div>
</template>
