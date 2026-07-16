<script setup lang="ts">
// Unobtrusive but legible "what's deployed" indicator, fixed in the bottom-right
// corner. Shows the human-readable semver from package.json (build-time).
const { version } = useRuntimeConfig().public
const label = `v${version}`
</script>

<template>
  <div
    class="fixed bottom-2 right-2 z-50 select-text rounded-md border border-neutral-200/70 bg-white/70 px-2 py-1 font-mono text-xs text-neutral-500 shadow-sm backdrop-blur-sm transition-opacity hover:opacity-100 opacity-60 dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-400"
    :title="`Arpenteurs ${label}`"
  >
    {{ label }}
  </div>
</template>
