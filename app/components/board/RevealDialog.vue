<script setup lang="ts">
/**
 * Dismissible dialog for 'hand.reveal' (extra.revealedHand) and
 * 'deck.revealTop' (extra.revealed) events — both carry CardDisplay[].
 */
import type { CardDisplay, PlayerId } from '#shared/types/game'
import { useGameStore } from '~/stores/game'

const store = useGameStore()

const open = ref(false)
const cards = ref<CardDisplay[]>([])
const title = ref('')

watch(
  () => store.lastExtra,
  (extra) => {
    if (!extra) return
    const actorName = extra.actor ? (store.state?.players[extra.actor as PlayerId]?.name ?? '?') : '?'
    const revealed =
      extra.type === 'hand.reveal'
        ? (extra.extra.revealedHand as CardDisplay[] | undefined)
        : extra.type === 'deck.revealTop'
          ? (extra.extra.revealed as CardDisplay[] | undefined)
          : undefined
    if (!revealed) return
    cards.value = revealed
    title.value =
      extra.type === 'hand.reveal'
        ? `${actorName} reveals their hand (${revealed.length})`
        : `${actorName} reveals the top ${revealed.length}`
    open.value = true
  },
)

const failed = ref<Set<number>>(new Set())
watch(cards, () => (failed.value = new Set()))
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <p v-if="!cards.length" class="text-sm text-dimmed py-4 text-center">Nothing to reveal.</p>
      <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3 max-h-[26rem] overflow-y-auto pr-1">
        <figure v-for="(card, i) in cards" :key="i" class="space-y-1">
          <img
            v-if="card.imageSmall && !failed.has(i)"
            :src="card.imageSmall"
            :alt="card.name"
            class="rounded-md w-full ring-1 ring-black/40"
            @error="failed.add(i)"
          >
          <div v-else class="aspect-[63/88] rounded-md bg-stone-800 text-stone-100 p-1.5 text-[10px]">
            <p class="font-semibold">{{ card.name }}</p>
            <p class="text-stone-400">{{ card.typeLine }}</p>
          </div>
          <figcaption class="text-[10px] text-dimmed text-center truncate">{{ card.name }}</figcaption>
        </figure>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end w-full">
        <UButton @click="() => { open = false }">Close</UButton>
      </div>
    </template>
  </UModal>
</template>
