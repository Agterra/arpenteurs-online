<script setup lang="ts">
/**
 * Turn/step ribbon for enforced mode: every step with the current one
 * highlighted, plus turn number, active player and who holds priority
 * (pulsing when it's YOU).
 */
import { STEPS, type Step } from '#shared/rules/types'

const props = defineProps<{
  step: Step
  turnNumber: number
  activeName: string
  priorityName: string | null
  myPriority: boolean
}>()

const STEP_LABELS: Record<Step, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  main1: 'Main 1',
  begin_combat: 'Combat',
  declare_attackers: 'Attackers',
  declare_blockers: 'Blockers',
  combat_damage: 'Damage',
  end_combat: 'End combat',
  main2: 'Main 2',
  end: 'End',
  cleanup: 'Cleanup',
}

const steps = STEPS
const current = computed(() => props.step)
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-default bg-elevated/60 px-3 py-1.5 text-xs">
    <span class="font-semibold">Turn {{ turnNumber }}</span>
    <span class="text-dimmed">Active: {{ activeName }}</span>
    <span
      class="rounded px-1.5 py-0.5 font-medium"
      :class="myPriority ? 'animate-pulse bg-primary/20 text-primary' : 'text-dimmed'"
    >
      {{ priorityName ? `Priority: ${priorityName}${myPriority ? ' (you)' : ''}` : 'Priority: —' }}
    </span>
    <div class="ml-auto flex flex-wrap items-center gap-1">
      <span
        v-for="s in steps"
        :key="s"
        class="rounded px-1.5 py-0.5"
        :class="s === current ? 'bg-primary text-inverted font-semibold' : 'text-dimmed'"
      >
        {{ STEP_LABELS[s] }}
      </span>
    </div>
  </div>
</template>
