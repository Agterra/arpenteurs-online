<script setup lang="ts">
/**
 * Top ribbon: 12 turn steps with the active one highlighted, turn number +
 * active player, Next step / Pass turn buttons (Space / Shift+Space), the game
 * menu (untap all, dice, coin, token, concede, end game) and connection state.
 */
import { STEPS, type Step } from '#shared/types/game'
import { useGameStore } from '~/stores/game'

const store = useGameStore()
const ui = useBoardUi()

const STEP_LABEL: Record<Step, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  main1: 'Main 1',
  combat_begin: 'Combat',
  attackers: 'Attack',
  blockers: 'Block',
  damage: 'Damage',
  combat_end: 'End Cbt',
  main2: 'Main 2',
  end: 'End',
  cleanup: 'Cleanup',
}

const turn = computed(() => store.state!.turn)
const activeName = computed(() => store.state!.players[turn.value.activePlayer]?.name ?? '?')
const isActive = computed(() => store.isMyTurn)

function setStep(step: Step) {
  if (isActive.value) ui.send({ type: 'turn.setStep', step })
}

async function rollDX() {
  const n = await ui.prompt({ title: 'Roll a die', kind: 'number', label: 'Number of sides', initial: 6, min: 2, max: 1000 })
  if (typeof n === 'number') ui.send({ type: 'game.roll', sides: n, count: 1 })
}
async function concede() {
  const ok = await ui.prompt({
    title: 'Concede the game?',
    kind: 'confirm',
    label: 'All your cards leave the game. This cannot be undone.',
    danger: true,
    confirmLabel: 'Concede',
  })
  if (ok) ui.send({ type: 'game.concede' })
}
async function endGame() {
  const options = [
    ...store.seatedPlayers.map((p) => ({ label: `${p.name} wins`, value: String(p.seat) })),
    { label: 'No winner (draw)', value: 'none' },
  ]
  const v = await ui.prompt({ title: 'End the game', kind: 'choice', options })
  if (v === null) return
  ui.send({ type: 'game.finish', winnerSeat: v === 'none' ? null : Number(v) })
}

const gameMenu = computed(() => [
  [{ label: 'Untap all', icon: 'i-lucide-rotate-ccw', onSelect: () => ui.send({ type: 'board.untapAll' }) }],
  [
    { label: 'Roll d6', icon: 'i-lucide-dice-5', onSelect: () => ui.send({ type: 'game.roll', sides: 6, count: 1 }) },
    { label: 'Roll d20', icon: 'i-lucide-dices', onSelect: () => ui.send({ type: 'game.roll', sides: 20, count: 1 }) },
    { label: 'Roll dX…', onSelect: rollDX },
    { label: 'Flip a coin', icon: 'i-lucide-circle-dot', onSelect: () => ui.send({ type: 'game.coin', count: 1 }) },
  ],
  [{ label: 'Create token…', icon: 'i-lucide-plus-square', onSelect: () => ui.openTokenDialog() }],
  [
    { label: 'Concede…', icon: 'i-lucide-flag', color: 'error' as const, onSelect: concede },
    { label: 'End game…', icon: 'i-lucide-power', color: 'error' as const, onSelect: endGame },
  ],
])

const connLabel = computed(
  () =>
    ({ connecting: 'Connecting…', open: '', resyncing: 'Resyncing…', down: 'Reconnecting…' })[store.conn],
)
</script>

<template>
  <div class="flex items-center gap-2 px-2 py-1 bg-elevated border-b border-default text-xs shrink-0">
    <span class="font-bold text-highlighted whitespace-nowrap">Turn {{ turn.turnNumber }}</span>
    <span class="text-dimmed truncate max-w-32" :title="activeName">{{ activeName }}</span>

    <div class="flex items-center gap-px overflow-x-auto">
      <button
        v-for="step in STEPS"
        :key="step"
        class="px-1.5 py-0.5 rounded whitespace-nowrap transition-colors"
        :class="[
          turn.step === step ? 'bg-primary text-inverted font-semibold' : 'text-dimmed hover:text-highlighted',
          isActive ? '' : 'cursor-default',
        ]"
        :disabled="!isActive"
        @click="setStep(step)"
      >
        {{ STEP_LABEL[step] }}
      </button>
    </div>

    <span class="grow" />

    <span v-if="connLabel" class="rounded bg-warning/20 text-warning px-2 py-0.5 animate-pulse whitespace-nowrap">
      {{ connLabel }}
    </span>

    <UTooltip text="Space">
      <UButton size="xs" :disabled="!isActive" @click="() => { ui.send({ type: 'turn.next' }) }">Next step</UButton>
    </UTooltip>
    <UTooltip text="Shift+Space">
      <UButton size="xs" variant="soft" :disabled="!isActive" @click="() => { ui.send({ type: 'turn.pass' }) }">Pass turn</UButton>
    </UTooltip>
    <UDropdownMenu :items="gameMenu">
      <UButton size="xs" variant="ghost" icon="i-lucide-menu" aria-label="Game menu" />
    </UDropdownMenu>
  </div>
</template>
