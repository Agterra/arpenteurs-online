<script setup lang="ts">
/**
 * London mulligan bar (status === 'mulligans'): Mulligan / Keep, then
 * "select N cards to bottom" via the hand strip, and a waiting banner once
 * you've kept.
 */
import { useGameStore } from '~/stores/game'

const store = useGameStore()
const ui = useBoardUi()

const me = computed(() => store.state!.players[ui.you]!)
const waitingOn = computed(() =>
  store.seatedPlayers.filter((p) => !p.keptHand && !p.hasConceded).map((p) => p.name),
)
const needed = computed(() => me.value.mullCount)

function startKeep() {
  if (needed.value === 0) {
    ui.send({ type: 'deck.keep', toBottom: [] })
    return
  }
  ui.bottoming.value = new Set()
  ui.bottomingActive.value = true
}
function confirmKeep() {
  ui.send({ type: 'deck.keep', toBottom: [...ui.bottoming.value] })
  ui.bottomingActive.value = false
  ui.bottoming.value = new Set()
}
function cancelKeep() {
  ui.bottomingActive.value = false
  ui.bottoming.value = new Set()
}
</script>

<template>
  <div class="shrink-0 border-t border-warning/40 bg-warning/10 px-3 py-2 flex items-center gap-3 text-sm">
    <template v-if="!me.keptHand">
      <template v-if="!ui.bottomingActive.value">
        <span class="font-semibold text-warning">
          Mulligan phase{{ me.mullCount ? ` — mulligan #${me.mullCount}` : '' }}
        </span>
        <span v-if="needed > 0" class="text-dimmed">Keeping means putting {{ needed }} card{{ needed > 1 ? 's' : '' }} on the bottom.</span>
        <span class="grow" />
        <UButton size="sm" variant="soft" color="warning" icon="i-lucide-refresh-ccw" @click="() => { ui.send({ type: 'deck.mulligan' }) }">
          Mulligan
        </UButton>
        <UButton size="sm" icon="i-lucide-check" @click="startKeep">Keep</UButton>
      </template>
      <template v-else>
        <span class="font-semibold text-warning">
          Select {{ needed }} card{{ needed > 1 ? 's' : '' }} in your hand to put on the bottom
          ({{ ui.bottoming.value.size }}/{{ needed }})
        </span>
        <span class="grow" />
        <UButton size="sm" variant="ghost" color="neutral" @click="cancelKeep">Back</UButton>
        <UButton size="sm" :disabled="ui.bottoming.value.size !== needed" @click="confirmKeep">
          Bottom {{ needed }} & keep
        </UButton>
      </template>
    </template>
    <template v-else>
      <span class="font-semibold text-warning">Hand kept.</span>
      <span class="text-dimmed">Waiting on {{ waitingOn.join(', ') || '…' }}</span>
    </template>
  </div>
</template>
