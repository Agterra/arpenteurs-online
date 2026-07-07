<script setup lang="ts">
interface DeckCardRow {
  qty: number
  section: 'COMMANDER' | 'MAIN'
  card: {
    id: string
    name: string
    manaCost: string | null
    manaValue: number
    typeLine: string
    colorIdentity: string[]
    imageSmall: string | null
    imageNormal: string | null
    canBeCommander: boolean
    commanderLegality: string
  }
}

const route = useRoute()
const deckId = route.params.id as string
const requestFetch = useRequestFetch()

const { data, error, refresh } = await useAsyncData(`deck-${deckId}`, () =>
  requestFetch<{ deck: { id: string; name: string; cards: DeckCardRow[] } }>(`/api/decks/${deckId}`),
)

const commanders = computed(() => data.value?.deck.cards.filter((c) => c.section === 'COMMANDER') ?? [])

/** Group MAIN by the first core word of typeLine (supertypes skipped so
 *  "Legendary Creature" groups under Creature). */
const SUPERTYPES = new Set(['Legendary', 'Basic', 'Snow', 'World', 'Ongoing', 'Elite', 'Token'])
function groupKey(typeLine: string): string {
  const words = typeLine.split(/[\s—]+/).filter(Boolean)
  return words.find((w) => !SUPERTYPES.has(w)) ?? words[0] ?? 'Other'
}
const GROUP_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land']
const mainGroups = computed(() => {
  const groups = new Map<string, DeckCardRow[]>()
  for (const row of data.value?.deck.cards ?? []) {
    if (row.section !== 'MAIN') continue
    const key = groupKey(row.card.typeLine)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({ key, rows, count: rows.reduce((n, r) => n + r.qty, 0) }))
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a.key)
      const bi = GROUP_ORDER.indexOf(b.key)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.key.localeCompare(b.key)
    })
})
const totalCards = computed(() => (data.value?.deck.cards ?? []).reduce((n, r) => n + r.qty, 0))

// ---- rename ----
const renameValue = ref('')
watchEffect(() => {
  if (data.value) renameValue.value = data.value.deck.name
})
const renameBusy = ref(false)
const renameError = ref('')
async function onRename() {
  if (!renameValue.value.trim() || renameValue.value === data.value?.deck.name) return
  renameBusy.value = true
  renameError.value = ''
  try {
    await $fetch(`/api/decks/${deckId}`, { method: 'PATCH', body: { name: renameValue.value } })
    await refresh()
  } catch (err) {
    renameError.value = apiErrorMessage(err)
  } finally {
    renameBusy.value = false
  }
}

// ---- commander picker ----
const pickerOpen = ref(false)
const picked = ref<string[]>([])
const pickerBusy = ref(false)
const pickerError = ref('')
const eligible = computed(() => {
  const seen = new Set<string>()
  return (data.value?.deck.cards ?? []).filter((r) => {
    if (!r.card.canBeCommander || seen.has(r.card.id)) return false
    seen.add(r.card.id)
    return true
  })
})
function openPicker() {
  picked.value = commanders.value.map((c) => c.card.id)
  pickerError.value = ''
  pickerOpen.value = true
}
function togglePick(cardId: string) {
  if (picked.value.includes(cardId)) picked.value = picked.value.filter((id) => id !== cardId)
  else if (picked.value.length < 2) picked.value = [...picked.value, cardId]
}
async function savePick() {
  if (!picked.value.length) return
  pickerBusy.value = true
  pickerError.value = ''
  try {
    await $fetch(`/api/decks/${deckId}/commanders`, { method: 'PUT', body: { cardIds: picked.value } })
    pickerOpen.value = false
    await refresh()
  } catch (err) {
    pickerError.value = apiErrorMessage(err)
  } finally {
    pickerBusy.value = false
  }
}
</script>

<template>
  <UContainer class="py-10 max-w-3xl">
    <UButton to="/decks" variant="link" size="xs" class="px-0">← My decks</UButton>

    <UCard v-if="error" class="mt-4">
      <p class="text-sm text-error">{{ apiErrorMessage(error) }}</p>
    </UCard>

    <template v-else-if="data">
      <div class="mt-2 flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-bold grow">{{ data.deck.name }}</h1>
        <form class="flex items-center gap-2" @submit.prevent="onRename">
          <UInput v-model="renameValue" size="sm" maxlength="80" placeholder="Rename deck" />
          <UButton
            type="submit"
            size="sm"
            variant="soft"
            :loading="renameBusy"
            :disabled="!renameValue.trim() || renameValue === data.deck.name"
          >
            Rename
          </UButton>
        </form>
      </div>
      <p v-if="renameError" class="mt-1 text-sm text-error">{{ renameError }}</p>
      <p class="mt-1 text-sm text-dimmed">{{ totalCards }} cards</p>

      <!-- Commanders -->
      <UCard class="mt-6">
        <template #header>
          <div class="flex items-center justify-between">
            <h2 class="font-semibold">Commander{{ commanders.length > 1 ? 's' : '' }}</h2>
            <UButton size="sm" variant="soft" @click="openPicker">Set commander(s)</UButton>
          </div>
        </template>
        <p v-if="!commanders.length" class="text-sm text-dimmed">
          No commander set — the lobby ready-check requires one.
        </p>
        <div v-else class="flex gap-4">
          <figure v-for="row in commanders" :key="row.card.id" class="w-36">
            <img
              :src="row.card.imageSmall ?? undefined"
              :alt="row.card.name"
              class="w-36 rounded-lg bg-elevated"
            >
            <figcaption class="mt-1 text-xs text-center">{{ row.card.name }}</figcaption>
          </figure>
        </div>
      </UCard>

      <!-- Main deck grouped by primary type -->
      <UCard v-for="group in mainGroups" :key="group.key" class="mt-4">
        <template #header>
          <h3 class="font-semibold">{{ group.key }} <span class="text-dimmed font-normal">({{ group.count }})</span></h3>
        </template>
        <ul class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <li v-for="row in group.rows" :key="row.card.id" class="flex items-baseline gap-2">
            <span class="text-dimmed w-6 text-right shrink-0">{{ row.qty }}</span>
            <span class="truncate" :title="row.card.typeLine">{{ row.card.name }}</span>
            <ManaSymbols :value="row.card.manaCost" :size="13" class="ml-auto shrink-0" />
          </li>
        </ul>
      </UCard>

      <!-- Commander picker -->
      <UModal v-model:open="pickerOpen" title="Set commander(s)" :ui="{ content: 'max-w-xl' }">
        <template #body>
          <p class="text-sm text-dimmed mb-3">Pick 1 or 2 eligible cards from this deck.</p>
          <p v-if="!eligible.length" class="text-sm text-warning">
            No card in this deck can be a commander.
          </p>
          <ul v-else class="flex flex-col gap-1 max-h-96 overflow-y-auto">
            <li v-for="row in eligible" :key="row.card.id">
              <button
                type="button"
                class="w-full flex items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-elevated"
                :class="picked.includes(row.card.id) ? 'bg-primary/10 ring-1 ring-primary' : ''"
                @click="togglePick(row.card.id)"
              >
                <img
                  :src="row.card.imageSmall ?? undefined"
                  :alt="row.card.name"
                  class="h-12 w-9 rounded object-cover bg-elevated shrink-0"
                >
                <span class="grow truncate">{{ row.card.name }}</span>
                <span class="text-xs text-dimmed truncate">{{ row.card.typeLine }}</span>
                <UBadge v-if="picked.includes(row.card.id)" size="sm" variant="subtle">Picked</UBadge>
              </button>
            </li>
          </ul>
          <p v-if="pickerError" class="mt-2 text-sm text-error">{{ pickerError }}</p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton variant="ghost" @click="pickerOpen = false">Cancel</UButton>
            <UButton :disabled="!picked.length" :loading="pickerBusy" @click="savePick">
              Save ({{ picked.length }}/2)
            </UButton>
          </div>
        </template>
      </UModal>
    </template>
  </UContainer>
</template>
