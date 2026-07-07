<script setup lang="ts">
/**
 * Fixed hover-preview panel: normal-size image + oracle text (+ back face).
 * Fed by BoardUi.preview (set by CardView after a 250 ms hover).
 */
const ui = useBoardUi()

const preview = computed(() => ui.preview.value)
const imgFailed = ref(false)
watch(preview, () => (imgFailed.value = false))

const mainImg = computed(() => {
  const p = preview.value
  if (!p) return null
  return p.faceIndex === 1 && p.display.backImageNormal ? p.display.backImageNormal : p.display.imageNormal
})
const backImg = computed(() => {
  const p = preview.value
  if (!p?.display.backImageNormal) return null
  return p.faceIndex === 1 ? p.display.imageNormal : p.display.backImageNormal
})
</script>

<template>
  <Transition name="fade">
    <div
      v-if="preview"
      class="fixed left-3 top-14 z-50 w-64 pointer-events-none space-y-2"
    >
      <img
        v-if="mainImg && !imgFailed"
        :src="mainImg"
        :alt="preview.display.name"
        class="w-full rounded-xl shadow-2xl ring-1 ring-black/60"
        @error="imgFailed = true"
      >
      <div v-else class="w-full aspect-[63/88] rounded-xl bg-stone-800 text-stone-100 p-3 text-xs shadow-2xl">
        <p class="font-bold">{{ preview.display.name }} <ManaSymbols :value="preview.display.manaCost" :size="13" class="float-right" /></p>
        <p class="text-stone-400 mt-1">{{ preview.display.typeLine }}</p>
        <p class="mt-2 whitespace-pre-line"><ManaSymbols :value="preview.display.oracleText" :size="12" /></p>
        <p v-if="preview.display.power != null" class="mt-2 text-right font-bold">
          {{ preview.display.power }}/{{ preview.display.toughness }}
        </p>
      </div>

      <div
        v-if="preview.display.oracleText && mainImg && !imgFailed"
        class="rounded-lg bg-stone-900/95 text-stone-200 p-2 text-[11px] leading-snug shadow-xl ring-1 ring-black/60 max-h-48 overflow-hidden whitespace-pre-line"
      >
        <ManaSymbols :value="preview.display.oracleText" :size="12" />
      </div>

      <img
        v-if="backImg"
        :src="backImg"
        alt="Back face"
        class="w-40 rounded-lg shadow-xl ring-1 ring-black/60 opacity-90"
      >
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
