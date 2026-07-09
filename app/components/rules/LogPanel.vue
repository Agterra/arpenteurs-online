<script setup lang="ts">
/** Collapsible game-log panel (enforced mode). Text interpolation only. */
const props = defineProps<{ lines: string[] }>()

const open = ref(true)
const scroller = ref<HTMLElement | null>(null)

watch(
  () => props.lines.length,
  async () => {
    await nextTick()
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex h-full flex-col border-l border-default bg-elevated/40" :class="open ? 'w-64' : 'w-9'">
    <button
      type="button"
      class="flex items-center gap-1 border-b border-default px-2 py-1.5 text-xs font-semibold text-dimmed hover:text-highlighted"
      @click="open = !open"
    >
      <UIcon :name="open ? 'i-lucide-panel-right-close' : 'i-lucide-panel-right-open'" class="size-4" />
      <span v-if="open">Log</span>
    </button>
    <div v-if="open" ref="scroller" class="min-h-0 flex-1 overflow-y-auto p-2">
      <p v-for="(line, i) in lines" :key="i" class="py-0.5 text-xs leading-snug text-dimmed">
        {{ line }}
      </p>
    </div>
  </div>
</template>
