<script setup lang="ts">
/**
 * Stack panel (enforced mode): shown while the stack is non-empty. Top of the
 * stack (last element server-side) is rendered first with a 'top' tag.
 */
import type { PlayerRState, StackItem } from '#shared/rules/types'
import type { RulesCardDisplay } from '~/stores/rulesGame'

const props = defineProps<{
  stack: StackItem[]
  display: Record<string, RulesCardDisplay>
  players: Record<string, PlayerRState>
  /** stack-item ids the viewer may click as a target (e.g. Counterspell) */
  targetableIds?: string[]
}>()
const emit = defineEmits<{ pick: [id: string] }>()

const topFirst = computed(() => [...props.stack].reverse())
const nameOf = (item: StackItem) => props.display[item.defName]?.name ?? item.defName
const isTargetable = (id: string) => props.targetableIds?.includes(id) ?? false
</script>

<template>
  <div class="w-56 rounded-lg border border-default bg-elevated/90 p-2 shadow-xl">
    <p class="mb-1 text-xs font-semibold text-dimmed">Stack</p>
    <ul class="space-y-1.5">
      <li
        v-for="(item, i) in topFirst"
        :key="item.id"
        class="flex items-center gap-2 rounded-md border p-1.5"
        :class="isTargetable(item.id) ? 'cursor-crosshair border-rose-400 ring-2 ring-rose-400' : 'border-default bg-default/60'"
        @click="isTargetable(item.id) && emit('pick', item.id)"
      >
        <img
          v-if="display[item.defName]?.imageSmall"
          :src="display[item.defName]!.imageSmall!"
          :alt="nameOf(item)"
          class="w-8 rounded-sm"
        />
        <div class="min-w-0 grow">
          <p class="truncate text-xs font-medium">{{ nameOf(item) }}</p>
          <p class="truncate text-[10px] text-dimmed">{{ players[item.controllerId]?.name ?? '?' }}</p>
        </div>
        <UBadge v-if="i === 0" size="sm" color="primary" variant="subtle">top</UBadge>
      </li>
    </ul>
  </div>
</template>
