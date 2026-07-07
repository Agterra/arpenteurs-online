<script setup lang="ts">
/**
 * The stack, as a floating zone at the center of the table — visible to
 * everyone (stack cards are public), rendered large. Newest object is on the
 * right / front and labelled "top". Cards you control get quick resolve
 * buttons (→ battlefield / → graveyard) plus the full move menu; anyone can see
 * what's on the stack while it's being responded to.
 *
 * Keeps data-drop="stack" + data-card-id so the existing drag manager can still
 * drop cards onto the stack and target these cards.
 */
import type { RedactedCard } from '#shared/types/game'
import { SEAT_COLORS } from '~/composables/useBoardUi'
import { useGameStore } from '~/stores/game'

const store = useGameStore()
const ui = useBoardUi()

const cards = computed<RedactedCard[]>(() =>
  (store.state?.zones.stack ?? []).map((id) => store.state!.cards[id]).filter((c): c is RedactedCard => !!c),
)
const controllerName = (c: RedactedCard) => store.state?.players[c.controllerId]?.name ?? '?'
const controllerColor = (c: RedactedCard) => {
  const seat = store.state?.players[c.controllerId]?.seat ?? 0
  return SEAT_COLORS[seat % SEAT_COLORS.length]
}
const mine = (c: RedactedCard) => c.controllerId === store.you

function resolveTo(c: RedactedCard, kind: 'battlefield' | 'graveyard') {
  ui.send({
    type: 'card.move',
    cardId: c.id,
    to: {
      zone:
        kind === 'battlefield'
          ? { kind: 'battlefield', player: store.you! }
          : { kind: 'graveyard', player: c.ownerId },
    },
    ...(kind === 'battlefield' ? { x: 0.45, y: 0.45 } : {}),
  })
}
</script>

<template>
  <div
    v-if="cards.length"
    class="absolute left-1/2 top-14 -translate-x-1/2 z-30 flex flex-col items-center gap-1 rounded-xl bg-elevated/95 border border-default shadow-2xl px-3 py-2 pointer-events-auto"
    data-drop="stack"
  >
    <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">
      The Stack · {{ cards.length }} · resolves top-down →
    </p>
    <div class="flex items-end gap-2">
      <div
        v-for="(card, i) in cards"
        :key="card.id"
        :data-card-id="card.id"
        class="relative flex flex-col items-center gap-1"
      >
        <span
          class="text-[10px] font-semibold rounded px-1 leading-tight"
          :style="{ color: controllerColor(card) }"
        >
          {{ controllerName(card) }}<span v-if="i === cards.length - 1" class="text-dimmed"> · top</span>
        </span>
        <UContextMenu v-if="mine(card)" :items="ui.cardMenuItems(card, 'stack')">
          <BoardCardView :card="card" :width="128" :show-counters="false" class="ring-1 ring-black/40 rounded-md" />
        </UContextMenu>
        <BoardCardView v-else :card="card" :width="128" :show-counters="false" class="ring-1 ring-black/40 rounded-md" />
        <div v-if="mine(card)" class="flex gap-1">
          <UButton size="xs" variant="soft" @click="resolveTo(card, 'battlefield')">Battlefield</UButton>
          <UButton size="xs" variant="soft" color="neutral" @click="resolveTo(card, 'graveyard')">Graveyard</UButton>
        </div>
      </div>
    </div>
  </div>
</template>
