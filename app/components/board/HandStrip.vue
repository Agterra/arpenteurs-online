<script setup lang="ts">
/**
 * Your hand: bottom strip of slightly overlapping cards. Drag to play,
 * context menu for the rest. Doubles as the mulligan "bottom these cards"
 * selector when the mulligan bar is in bottoming mode.
 */
import type { RedactedCard } from '#shared/types/game'
import { useGameStore } from '~/stores/game'

const store = useGameStore()
const ui = useBoardUi()

const handCards = computed(() =>
  store.myHandIds.map((id) => store.state!.cards[id]).filter((c): c is RedactedCard => !!c),
)

function onPointerDown(card: RedactedCard, e: PointerEvent) {
  if (e.button !== 0) return
  if (ui.bottomingActive.value) {
    const set = new Set(ui.bottoming.value)
    if (set.has(card.id)) set.delete(card.id)
    else set.add(card.id)
    ui.bottoming.value = set
    return
  }
  ui.startGhostDrag(card, e)
}

async function revealHand() {
  const to = await ui.pickPlayer('Reveal your hand to…', { includeAll: true, excludeSelf: true })
  if (to === null) return
  ui.send({ type: 'hand.reveal', to: to === 'all' ? 'all' : [to] })
}
</script>

<template>
  <div
    class="shrink-0 border-t border-default bg-elevated/95 px-2 py-1.5"
    :class="ui.dropHover.value === `${ui.you}:hand` ? 'ring-2 ring-inset ring-sky-400/70' : ''"
    :data-drop="`${ui.you}:hand`"
  >
    <div class="flex items-end gap-3">
      <div class="flex items-end -space-x-4 min-w-0 overflow-x-auto pt-1 pb-1">
        <p v-if="!handCards.length" class="text-xs text-dimmed px-2 py-6">Your hand is empty.</p>
        <div
          v-for="card in handCards"
          :key="card.id"
          class="relative shrink-0 transition-transform hover:-translate-y-2 hover:z-20"
          :class="[
            ui.drag.value?.cardId === card.id ? 'opacity-40' : '',
            ui.bottoming.value.has(card.id) ? '-translate-y-3' : '',
          ]"
          @pointerdown="onPointerDown(card, $event)"
        >
          <UContextMenu :items="ui.cardMenuItems(card, 'hand')" :disabled="ui.bottomingActive.value">
            <BoardCardView
              :card="card"
              :width="92"
              :selected="ui.bottoming.value.has(card.id)"
              :show-counters="false"
            />
          </UContextMenu>
          <div
            v-if="ui.bottoming.value.has(card.id)"
            class="absolute inset-x-0 top-0 rounded-t-md bg-sky-500/90 text-center text-[10px] text-white font-semibold pointer-events-none"
          >
            to bottom
          </div>
        </div>
      </div>
      <BoardMyZonesPanel class="ml-auto" />
      <div class="flex flex-col items-end gap-1 shrink-0 pl-1 text-xs text-dimmed">
        <span>Hand: {{ handCards.length }}</span>
        <UButton size="xs" variant="soft" icon="i-lucide-eye" @click="revealHand">Reveal…</UButton>
      </div>
    </div>
  </div>
</template>
