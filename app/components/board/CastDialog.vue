<script setup lang="ts">
/**
 * Cast a spell onto the stack and pay for it. Shows the card + its mana cost,
 * your current mana pool, and your untapped mana sources — click a source to
 * tap it for mana right now (so you can cover a cost the pool can't yet).
 * "Cast & pay" moves the card to the stack and deducts the cost from the pool.
 *
 * Convenience, not enforcement: you can always "Cast (no payment)", and the
 * deduction is a best-effort plan (see planPayment).
 */
import type { ManaColor, RedactedCard } from '#shared/types/game'
import { manaProductionFor } from '#shared/utils/manaAbilities'
import { parseManaCost, planPayment, totalPips } from '#shared/utils/manaCost'

const store = useGameStore()
const ui = useBoardUi()

const open = ref(false)
const card = ref<RedactedCard | null>(null)

function show(c: RedactedCard) {
  card.value = c
  open.value = true
}
defineExpose({ show })

const COLORS: { c: ManaColor; cls: string }[] = [
  { c: 'W', cls: 'bg-amber-100 text-stone-900' },
  { c: 'U', cls: 'bg-sky-600 text-white' },
  { c: 'B', cls: 'bg-stone-950 text-stone-200 ring-1 ring-stone-600' },
  { c: 'R', cls: 'bg-red-600 text-white' },
  { c: 'G', cls: 'bg-green-700 text-white' },
  { c: 'C', cls: 'bg-stone-400 text-stone-900' },
]

const pool = computed(
  () => store.state?.players[store.you!]?.manaPool ?? { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
)
const cost = computed(() => parseManaCost(card.value?.display?.manaCost))
const payment = computed(() => planPayment(cost.value, pool.value))
const hasCost = computed(() => totalPips(cost.value) > 0 || cost.value.hasX)

// your untapped permanents that can make mana
const sources = computed<RedactedCard[]>(() =>
  (store.state?.zones.perPlayer[store.you!]?.battlefield ?? [])
    .map((id) => store.state!.cards[id])
    .filter((c): c is RedactedCard => !!c && c.controllerId === store.you && !c.tapped && !!c.display && !!manaProductionFor(c.display)),
)

function tapSource(c: RedactedCard) {
  ui.tapForMana(c) // taps + adds mana; pool below updates live via the event stream
}

function toStack() {
  const c = card.value
  if (c) ui.send({ type: 'card.move', cardId: c.id, to: { zone: { kind: 'stack' } } })
}
function castAndPay() {
  if (!card.value) return
  toStack()
  const d = payment.value.deduct
  for (const { c } of COLORS) if (d[c] > 0) ui.send({ type: 'mana.change', color: c, delta: -d[c] })
  open.value = false
}
function castNoPay() {
  toStack()
  open.value = false
}
</script>

<template>
  <UModal v-model:open="open" title="Cast spell" :ui="{ content: 'max-w-md' }">
    <template #body>
      <div v-if="card" class="flex gap-3">
        <BoardCardView :card="card" :width="120" :show-counters="false" class="shrink-0 rounded-md" />
        <div class="min-w-0 flex-1 space-y-3">
          <div>
            <p class="font-semibold truncate">{{ card.display?.name ?? 'Spell' }}</p>
            <p class="text-sm flex items-center gap-1">
              Cost: <ManaSymbols v-if="hasCost" :value="card.display?.manaCost" :size="15" /><span v-else class="text-dimmed">—</span>
            </p>
          </div>

          <!-- current pool -->
          <div>
            <p class="text-[11px] text-dimmed mb-1">Your mana pool</p>
            <div class="flex gap-1">
              <span
                v-for="m in COLORS"
                :key="m.c"
                class="h-6 min-w-6 px-1 rounded-full inline-flex items-center gap-0.5 text-[11px] font-bold"
                :class="[m.cls, pool[m.c] === 0 ? 'opacity-30' : '']"
              >
                <ManaSymbols :value="`{${m.c}}`" :size="12" />{{ pool[m.c] }}
              </span>
            </div>
          </div>

          <!-- coverage -->
          <p v-if="hasCost" class="text-sm font-medium" :class="payment.covered ? 'text-success' : 'text-warning'">
            <template v-if="payment.covered">✓ Pool covers the cost</template>
            <template v-else>Still need {{ payment.shortfall }} more mana{{ cost.hasX ? ' (+ X)' : '' }}</template>
          </p>

          <!-- tap sources -->
          <div v-if="sources.length">
            <p class="text-[11px] text-dimmed mb-1">Tap for mana ({{ sources.length }} untapped)</p>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="s in sources"
                :key="s.id"
                class="text-[11px] rounded bg-muted hover:bg-accented px-1.5 py-0.5 max-w-32 truncate"
                :title="s.display?.name ?? ''"
                @click="tapSource(s)"
              >
                {{ s.display?.name ?? 'Source' }}
              </button>
            </div>
          </div>
          <p v-else class="text-[11px] text-dimmed">No untapped mana sources.</p>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" color="neutral" @click="() => { open = false }">Cancel</UButton>
        <UButton variant="soft" color="neutral" @click="castNoPay">Cast (no payment)</UButton>
        <UButton :color="payment.covered || !hasCost ? 'primary' : 'warning'" @click="castAndPay">
          Cast &amp; pay
        </UButton>
      </div>
    </template>
  </UModal>
</template>
