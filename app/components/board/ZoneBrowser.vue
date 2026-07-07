<script setup lang="ts">
/**
 * Scrollable browser modal for graveyard / exile / command zones. Your own
 * cards get the full context menu (move to any zone, tuck top/bottom…).
 */
import type { PlayerId, RedactedCard } from '#shared/types/game'
import { useGameStore } from '~/stores/game'

const store = useGameStore()
const ui = useBoardUi()

const open = ref(false)
const playerId = ref<PlayerId | null>(null)
const kind = ref<'graveyard' | 'exile' | 'command'>('graveyard')

function show(pid: PlayerId, k: 'graveyard' | 'exile' | 'command') {
  playerId.value = pid
  kind.value = k
  open.value = true
}
defineExpose({ show })

const title = computed(() => {
  if (!playerId.value) return ''
  const name = store.state?.players[playerId.value]?.name ?? '?'
  const label = { graveyard: 'graveyard', exile: 'exile', command: 'command zone' }[kind.value]
  return `${name}'s ${label}`
})

const cards = computed<RedactedCard[]>(() => {
  if (!open.value || !playerId.value || !store.state) return []
  const ids = store.state.zones.perPlayer[playerId.value]?.[kind.value] ?? []
  // last in the array = most recent → show top card first
  return [...ids].reverse().map((id) => store.state!.cards[id]).filter((c): c is RedactedCard => !!c)
})

const mine = computed(() => playerId.value === ui.you)
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <p v-if="!cards.length" class="text-sm text-dimmed py-6 text-center">Empty.</p>
      <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3 max-h-[28rem] overflow-y-auto pr-1">
        <div v-for="card in cards" :key="card.id">
          <UContextMenu v-if="mine" :items="ui.cardMenuItems(card, kind === 'command' ? 'command' : 'browser')">
            <BoardCardView :card="card" :width="96" />
          </UContextMenu>
          <BoardCardView v-else :card="card" :width="96" />
        </div>
      </div>
      <p v-if="mine && cards.length" class="text-xs text-dimmed mt-2">Right-click a card to move it.</p>
    </template>
  </UModal>
</template>
