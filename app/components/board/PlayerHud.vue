<script setup lang="ts">
/**
 * Compact per-quadrant HUD: identity + presence, BIG life, poison, commander
 * damage matrix, mana pool, named counters, and the zone chips (library menu,
 * graveyard/exile browsers, command zone with tax badges).
 */
import type { PlayerId, RedactedCard } from '#shared/types/game'
import { SEAT_COLORS } from '~/composables/useBoardUi'
import { useGameStore } from '~/stores/game'

const props = defineProps<{ playerId: PlayerId }>()
const store = useGameStore()
const ui = useBoardUi()

const player = computed(() => store.state!.players[props.playerId]!)
const zones = computed(() => store.state!.zones.perPlayer[props.playerId]!)
const isMe = computed(() => props.playerId === ui.you)
const connected = computed(() => store.connectedPlayers.includes(props.playerId))
const seatColor = computed(() => SEAT_COLORS[player.value.seat % SEAT_COLORS.length])
const isMonarch = computed(() => store.state!.markers.monarch === props.playerId)
const hasInitiative = computed(() => store.state!.markers.initiative === props.playerId)

// ---- self-only edits ----
function life(delta: number) {
  if (isMe.value) ui.send({ type: 'player.life', delta })
}
function poison(delta: number) {
  if (isMe.value) ui.send({ type: 'player.poison', delta })
}
function mana(color: 'W' | 'U' | 'B' | 'R' | 'G' | 'C', delta: number) {
  if (isMe.value) ui.send({ type: 'mana.change', color, delta })
}
function counter(name: string, delta: number) {
  if (isMe.value) ui.send({ type: 'player.counter', name, delta })
}
async function addCounter() {
  const name = await ui.prompt({ title: 'Add a counter', kind: 'text', label: 'Counter name', initial: 'energy' })
  if (typeof name === 'string' && name.trim()) ui.send({ type: 'player.counter', name: name.trim(), delta: 1 })
}
function commanderDamage(commanderKey: string, delta: number) {
  if (isMe.value) ui.send({ type: 'player.commanderDamage', commanderKey, delta })
}
function commanderTax(slot: number, delta: number) {
  if (isMe.value) ui.send({ type: 'player.commanderTax', slot, delta })
}
// Cast your commander: move it from the command zone onto your battlefield
// (this also bumps its tax via the reducer). Double-click is the quick path;
// right-click / drag give the full options.
function castCommander(card: RedactedCard) {
  if (!isMe.value) return
  ui.send({
    type: 'card.move',
    cardId: card.id,
    to: { zone: { kind: 'battlefield', player: props.playerId } },
    x: 0.42,
    y: 0.45,
  })
}
function onCommandPointerDown(card: RedactedCard, e: PointerEvent) {
  if (isMe.value && e.button === 0) ui.startGhostDrag(card, e)
}

const MANA_COLORS = ['W', 'U', 'B', 'R', 'G', 'C'] as const
const hasMana = computed(() => MANA_COLORS.some((c) => player.value.manaPool[c] > 0))

const counterEntries = computed(() => Object.entries(player.value.counters).filter(([, n]) => n !== 0))

// ---- commander damage matrix: every commander in the game ----
const allCommanders = computed(() => {
  const rows: { key: string; label: string }[] = []
  for (const p of store.seatedPlayers) {
    p.commanderIds.forEach((cardId, slot) => {
      const name = store.state!.cards[cardId]?.display?.name ?? `${p.name}'s commander ${slot + 1}`
      rows.push({ key: `${p.id}#${slot}`, label: name })
    })
  }
  return rows
})
const totalCommanderDamage = computed(() =>
  Object.values(player.value.commanderDamage).reduce((a, b) => a + b, 0),
)

// ---- zones ----
const libraryCount = computed(() => zones.value.library.count)
const graveIds = computed(() => zones.value.graveyard)
const exileIds = computed(() => zones.value.exile)
const commandCards = computed(() =>
  zones.value.command.map((id) => store.state!.cards[id]).filter((c): c is RedactedCard => !!c),
)
const topCard = (ids: string[]) => (ids.length ? store.state!.cards[ids[ids.length - 1]!] : undefined)
</script>

<template>
  <div class="shrink-0 bg-elevated/90 border-b border-default px-2 py-1 text-xs space-y-1" :data-player-target="playerId">
    <!-- row 1: identity + life + pools -->
    <div class="flex items-center gap-2 min-w-0">
      <span class="relative inline-flex h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: seatColor }">
        <span
          class="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-black/60"
          :class="connected ? 'bg-green-400' : 'bg-stone-500'"
          :title="connected ? 'Connected' : 'Disconnected'"
        />
      </span>
      <span class="font-semibold truncate" :class="player.hasConceded ? 'line-through text-dimmed' : ''">{{ player.name }}</span>
      <span v-if="isMe" class="text-dimmed shrink-0">(you)</span>
      <UTooltip v-if="isMonarch" text="The Monarch"><span>👑</span></UTooltip>
      <UTooltip v-if="hasInitiative" text="Has the Initiative"><span>⚔️</span></UTooltip>
      <span v-if="store.state!.turn.activePlayer === playerId" class="rounded bg-primary/20 text-primary px-1 shrink-0">turn</span>
      <span class="grow" />

      <!-- poison -->
      <button
        v-if="player.poison > 0 || isMe"
        class="shrink-0 rounded px-1 py-0.5 bg-lime-950 text-lime-300"
        :class="isMe ? 'hover:bg-lime-900' : 'cursor-default'"
        title="Poison — click +1, right-click −1"
        @click="poison(1)"
        @contextmenu.prevent="poison(-1)"
      >
        ☠ {{ player.poison }}
      </button>

      <!-- commander damage -->
      <UPopover>
        <button class="shrink-0 rounded px-1 py-0.5 bg-muted hover:bg-accented" title="Commander damage">
          🗡 {{ totalCommanderDamage }}
        </button>
        <template #content>
          <div class="p-2 space-y-1 text-xs w-64">
            <p class="font-semibold text-highlighted">Commander damage taken by {{ player.name }}</p>
            <p v-if="!allCommanders.length" class="text-dimmed">No commanders in play.</p>
            <div v-for="row in allCommanders" :key="row.key" class="flex items-center gap-1">
              <span class="truncate grow" :title="row.key">{{ row.label }}</span>
              <UButton v-if="isMe" size="xs" variant="soft" icon="i-lucide-minus" @click="commanderDamage(row.key, -1)" />
              <span class="w-6 text-center font-mono" :class="(player.commanderDamage[row.key] ?? 0) >= 21 ? 'text-error font-bold' : ''">
                {{ player.commanderDamage[row.key] ?? 0 }}
              </span>
              <UButton v-if="isMe" size="xs" variant="soft" icon="i-lucide-plus" @click="commanderDamage(row.key, 1)" />
            </div>
          </div>
        </template>
      </UPopover>

      <!-- life -->
      <button
        class="shrink-0 text-2xl font-black leading-none tabular-nums px-1"
        :class="[player.life <= 10 ? 'text-error' : 'text-highlighted', isMe ? 'hover:text-primary' : 'cursor-default']"
        title="Life — click +1, right-click −1"
        @click="life(1)"
        @contextmenu.prevent="life(-1)"
      >
        {{ player.life }}
      </button>
    </div>

    <!-- row 2: mana + counters + zone chips -->
    <div class="flex items-center gap-1.5 min-w-0">
      <!-- mana pool -->
      <div v-if="isMe || hasMana" class="flex items-center gap-0.5 shrink-0">
        <button
          v-for="c in MANA_COLORS"
          :key="c"
          v-show="isMe || player.manaPool[c] > 0"
          class="h-5 rounded-full pl-0.5 pr-1 inline-flex items-center gap-0.5 bg-black/25 ring-1 ring-white/10"
          :class="[isMe ? 'hover:bg-black/40' : 'cursor-default', player.manaPool[c] === 0 ? 'opacity-40' : '']"
          :title="`${c} mana — click +1, right-click −1`"
          @click="mana(c, 1)"
          @contextmenu.prevent="mana(c, -1)"
        >
          <ManaSymbols :value="`{${c}}`" :size="13" />
          <span class="text-[10px] font-bold leading-none tabular-nums">{{ player.manaPool[c] }}</span>
        </button>
        <button
          v-if="isMe && hasMana"
          class="text-dimmed hover:text-error px-0.5"
          title="Clear mana pool"
          @click="ui.send({ type: 'mana.clear' })"
        >✕</button>
      </div>

      <!-- named counters -->
      <button
        v-for="[name, n] in counterEntries"
        :key="name"
        class="shrink-0 rounded bg-violet-950 text-violet-300 px-1 py-0.5"
        :class="isMe ? 'hover:bg-violet-900' : 'cursor-default'"
        :title="`${name} — click +1, right-click −1`"
        @click="counter(name, 1)"
        @contextmenu.prevent="counter(name, -1)"
      >
        {{ name }} {{ n }}
      </button>
      <button v-if="isMe" class="shrink-0 text-dimmed hover:text-highlighted" title="Add a counter" @click="addCounter">+</button>

      <span class="grow" />

      <!-- command zone -->
      <div v-if="commandCards.length" class="flex items-center gap-1 shrink-0" :data-drop="`${playerId}:command`">
        <div v-for="card in commandCards" :key="card.id" class="relative">
          <UContextMenu v-if="isMe" :items="ui.cardMenuItems(card, 'command')">
            <BoardCardView
              :card="card"
              :width="30"
              :show-counters="false"
              class="cursor-grab"
              title="Double-click to cast · drag to battlefield · right-click for options"
              @pointerdown="onCommandPointerDown(card, $event)"
              @dblclick="castCommander(card)"
            />
          </UContextMenu>
          <BoardCardView v-else :card="card" :width="30" :show-counters="false" />
          <button
            v-if="card.commanderSlot != null"
            class="absolute -top-1.5 -right-1.5 rounded-full bg-amber-600 text-white text-[9px] px-1 leading-tight ring-1 ring-black/50 z-10"
            :class="isMe ? 'hover:bg-amber-500' : 'cursor-default'"
            :title="`Commander tax — click +1, right-click −1`"
            @click="commanderTax(card.commanderSlot!, 1)"
            @contextmenu.prevent="commanderTax(card.commanderSlot!, -1)"
          >
            +{{ 2 * (player.commanderTax[card.commanderSlot!] ?? 0) }}
          </button>
        </div>
      </div>

      <!-- Opponents' library/graveyard/exile are read-only chips here; your own
           zones live in the larger, interactive <BoardMyZonesPanel> by the hand. -->
      <template v-if="!isMe">
        <!-- library -->
        <span class="shrink-0 rounded bg-indigo-950 text-indigo-200 px-1.5 py-0.5" title="Library">🂠 {{ libraryCount }}</span>

        <!-- graveyard -->
        <button
          class="shrink-0 flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 hover:bg-accented"
          title="Graveyard"
          @click="ui.openZoneBrowser(playerId, 'graveyard')"
        >
          <BoardCardView v-if="topCard(graveIds)" :card="topCard(graveIds)!" :width="16" :show-counters="false" />
          <span>GY {{ graveIds.length }}</span>
        </button>

        <!-- exile -->
        <button
          class="shrink-0 flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 hover:bg-accented"
          title="Exile"
          @click="ui.openZoneBrowser(playerId, 'exile')"
        >
          <BoardCardView v-if="topCard(exileIds)" :card="topCard(exileIds)!" :width="16" :show-counters="false" />
          <span>EX {{ exileIds.length }}</span>
        </button>
      </template>
    </div>
  </div>
</template>
