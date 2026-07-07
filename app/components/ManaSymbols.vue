<script setup lang="ts">
/**
 * Renders a mana cost or a chunk of oracle text, turning {W}/{2}/{W/U}/{T}…
 * into Scryfall symbol pips while leaving surrounding text (and newlines)
 * intact. If a symbol SVG fails to load (Scryfall outage / unknown symbol)
 * it falls back to the raw `{X}` text, so the game never blanks out —
 * same graceful-degradation stance as card images.
 *
 * Put `white-space: pre-line` on an ancestor to keep oracle-text line breaks.
 */
import { parseMana, symbolSvgUrl, type ManaToken } from '#shared/utils/mana'

const props = withDefaults(defineProps<{ value?: string | null; size?: number }>(), {
  value: '',
  size: 14,
})

const tokens = computed<ManaToken[]>(() => parseMana(props.value))
const failed = reactive(new Set<string>())
</script>

<template><span class="mana-symbols"><template
      v-for="(t, i) in tokens"
      :key="i"
    ><img
        v-if="t.type === 'symbol' && !failed.has(t.code)"
        :src="symbolSvgUrl(t.code)"
        :alt="t.raw"
        :title="t.raw"
        :style="{ height: `${size}px`, width: `${size}px` }"
        class="inline-block align-text-bottom"
        loading="lazy"
        decoding="async"
        @error="failed.add(t.code)"
      ><span v-else-if="t.type === 'symbol'" class="opacity-70">{{ t.raw }}</span><span
        v-else
      >{{ t.text }}</span></template></span></template>
