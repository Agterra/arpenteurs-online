<script setup lang="ts">
/**
 * Enforced-board hover preview: a fixed, normal-size card image with an oracle-
 * text fallback. Fed by DuelBoard, which sets `display` after a short hover on
 * a card (mirrors the manual board's BoardCardPreview).
 */
import type { RulesCardDisplay } from '~/stores/rulesGame'

const props = defineProps<{ display: RulesCardDisplay | null }>()

const imgFailed = ref(false)
watch(
  () => props.display,
  () => (imgFailed.value = false),
)
const img = computed(() => (imgFailed.value ? null : (props.display?.imageNormal ?? null)))
</script>

<template>
  <Transition name="fade">
    <div v-if="display" class="pointer-events-none fixed left-3 top-16 z-50 w-64 space-y-2">
      <img
        v-if="img"
        :src="img"
        :alt="display.name"
        class="w-full rounded-xl shadow-2xl ring-1 ring-black/60"
        @error="imgFailed = true"
      >
      <div v-else class="aspect-[63/88] w-full rounded-xl bg-stone-800 p-3 text-xs text-stone-100 shadow-2xl">
        <p class="font-bold">
          {{ display.name }}
          <ManaSymbols :value="display.manaCost" :size="13" class="float-right" />
        </p>
        <p class="mt-1 text-stone-400">{{ display.typeLine }}</p>
        <p v-if="display.oracleText" class="mt-2 whitespace-pre-line">
          <ManaSymbols :value="display.oracleText" :size="12" />
        </p>
        <p v-if="display.power != null" class="mt-2 text-right font-bold">{{ display.power }}/{{ display.toughness }}</p>
      </div>

      <!-- with an image, still surface the oracle text (esp. for hand-run cards) -->
      <div
        v-if="img && display.oracleText"
        class="max-h-48 overflow-hidden whitespace-pre-line rounded-lg bg-stone-900/95 p-2 text-[11px] leading-snug text-stone-200 shadow-xl ring-1 ring-black/60"
      >
        <ManaSymbols :value="display.oracleText" :size="12" />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 120ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
