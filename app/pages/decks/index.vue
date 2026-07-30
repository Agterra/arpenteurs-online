<script setup lang="ts">
import { SAMPLE_DECK_NAME, SAMPLE_DECK_TEXT } from '#shared/data/sampleDeck'

interface DeckListItem {
  id: string
  name: string
  updatedAt: string
  commanders: { id: string; name: string; imageSmall: string | null }[]
}
interface ImportSuggestion {
  cardId: string
  name: string
  score: number
}
interface ImportReport {
  deckId: string | null
  resolved: { line: number; qty: number; cardId: string; name: string; section: 'COMMANDER' | 'MAIN' }[]
  unresolved: { line: number; raw: string; qty: number; suggestions: ImportSuggestion[] }[]
  skipped: { line: number; raw: string; reason: string }[]
  warnings: { code: string; name?: string; count?: number }[]
  commander: { designated: string[]; guess: string[]; required: boolean }
}

const { user, refresh } = useSession()
await useAsyncData('session', async () => {
  await refresh()
  return true
})

// if we arrived from a lobby (?lobby=CODE), return there instead of the home view
const route = useRoute()
const fromLobby = computed(() => (route.query.lobby as string) || null)

const requestFetch = useRequestFetch()
const { data, refresh: refreshDecks } = await useAsyncData('decks', async () => {
  if (!user.value) return { decks: [] as DeckListItem[] }
  return requestFetch<{ decks: DeckListItem[] }>('/api/decks')
})

// ---- import modal ----
const importOpen = ref(false)
const importName = ref('')
const importText = ref('')
const skipUnresolved = ref(false)
const report = ref<ImportReport | null>(null)
const importError = ref('')
const importBusy = ref(false)

function cardName(report: ImportReport, cardId: string): string {
  return report.resolved.find((r) => r.cardId === cardId)?.name ?? cardId
}

function openImport() {
  importName.value = ''
  importText.value = ''
  skipUnresolved.value = false
  report.value = null
  importError.value = ''
  importOpen.value = true
}

/** Pre-fill the import modal with a ready-to-play deck of only-implemented cards
 *  (great for playtesting the enforced engine) and preview the resolution. */
async function loadSample() {
  importName.value = SAMPLE_DECK_NAME
  importText.value = SAMPLE_DECK_TEXT
  skipUnresolved.value = true
  report.value = null
  importError.value = ''
  importOpen.value = true
  await runImport(false) // dry-run preview; user clicks confirm to create
}

async function runImport(commit: boolean) {
  importBusy.value = true
  importError.value = ''
  try {
    const res = await $fetch<ImportReport>('/api/decks/import', {
      method: 'POST',
      body: {
        name: importName.value,
        text: importText.value,
        commit,
        skipUnresolved: skipUnresolved.value,
      },
    })
    report.value = res
    if (commit && res.deckId) {
      importOpen.value = false
      // returning from a lobby → go back to it (the new deck is now selectable there)
      await navigateTo(fromLobby.value ? `/l/${fromLobby.value}` : `/decks/${res.deckId}`)
    } else if (commit) {
      importError.value = 'Deck was not created — resolve the lines below or accept dropping them.'
    }
  } catch (err) {
    importError.value = apiErrorMessage(err)
  } finally {
    importBusy.value = false
  }
}

const canConfirm = computed(
  () => !!report.value && (report.value.unresolved.length === 0 || skipUnresolved.value),
)

function warningLabel(w: { code: string; name?: string; count?: number }): string {
  switch (w.code) {
    case 'CARD_COUNT':
      return `Deck has ${w.count} cards (Commander decks are usually 100 — not enforced)`
    case 'DUPLICATE_NONBASIC':
      return `${w.name} appears ${w.count}× (singleton format)`
    case 'BANNED_IN_COMMANDER':
      return `${w.name} is banned in Commander`
    case 'NOT_LEGAL_IN_COMMANDER':
      return `${w.name} is not legal in Commander`
    case 'NOT_A_COMMANDER':
      return `${w.name} cannot normally be your commander`
    case 'TOO_MANY_COMMANDERS':
      return `${w.count} commanders designated (max is normally 2)`
    case 'COLOR_IDENTITY':
      return `${w.name} is outside your commander's color identity`
    default:
      return w.code
  }
}

// ---- delete ----
const deleteBusy = ref<string | null>(null)
async function onDelete(deck: DeckListItem) {
  if (!window.confirm(`Delete deck "${deck.name}"? This cannot be undone.`)) return
  deleteBusy.value = deck.id
  try {
    await $fetch(`/api/decks/${deck.id}`, { method: 'DELETE' })
    await refreshDecks()
  } catch (err) {
    window.alert(apiErrorMessage(err))
  } finally {
    deleteBusy.value = null
  }
}
</script>

<template>
  <UContainer class="py-10 max-w-3xl">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">My decks</h1>
        <UButton :to="fromLobby ? `/l/${fromLobby}` : '/'" variant="link" size="xs" class="px-0">
          ← {{ fromLobby ? 'Back to lobby' : 'Back to lobbies' }}
        </UButton>
      </div>
      <div v-if="user" class="flex items-center gap-2">
        <UButton icon="i-lucide-sparkles" variant="soft" :loading="importBusy" @click="loadSample">
          Load sample deck
        </UButton>
        <UButton icon="i-lucide-clipboard-paste" @click="openImport">Import a decklist</UButton>
      </div>
    </div>

    <UCard v-if="!user" class="mt-8">
      <p class="text-sm">
        You need a username first —
        <NuxtLink to="/" class="text-primary underline">claim one on the home page</NuxtLink>.
      </p>
    </UCard>

    <template v-else>
      <p v-if="!data?.decks?.length" class="mt-8 text-dimmed">
        No decks yet. Paste a decklist to create your first one.
      </p>
      <ul v-else class="mt-6 flex flex-col gap-3">
        <li v-for="deck in data.decks" :key="deck.id">
          <UCard>
            <div class="flex items-center gap-4">
              <div class="flex -space-x-3 shrink-0">
                <img
                  v-for="cmd in deck.commanders"
                  :key="cmd.id"
                  :src="cmd.imageSmall ?? undefined"
                  :alt="cmd.name"
                  :title="cmd.name"
                  class="h-16 w-12 rounded object-cover ring-2 ring-default bg-elevated"
                >
                <div
                  v-if="!deck.commanders.length"
                  class="h-16 w-12 rounded bg-elevated ring-2 ring-default flex items-center justify-center text-xs text-dimmed"
                >
                  ?
                </div>
              </div>
              <div class="grow min-w-0">
                <NuxtLink :to="`/decks/${deck.id}`" class="font-semibold hover:text-primary truncate block">
                  {{ deck.name }}
                </NuxtLink>
                <p class="text-xs text-dimmed truncate">
                  {{ deck.commanders.length ? deck.commanders.map((c) => c.name).join(' / ') : 'No commander set' }}
                </p>
              </div>
              <UButton :to="`/decks/${deck.id}`" size="sm" variant="soft">Open</UButton>
              <UButton
                size="sm"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :loading="deleteBusy === deck.id"
                @click="onDelete(deck)"
              />
            </div>
          </UCard>
        </li>
      </ul>
    </template>

    <!-- Import modal -->
    <UModal v-model:open="importOpen" title="Import a decklist" :ui="{ content: 'max-w-2xl' }">
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField label="Deck name" required>
            <UInput v-model="importName" placeholder="My deck" maxlength="80" class="w-full" />
          </UFormField>
          <UFormField label="Decklist" required hint="Moxfield / Archidekt / MTGA exports work">
            <UTextarea
              v-model="importText"
              :rows="10"
              placeholder="Commander&#10;1 Atraxa, Praetors' Voice&#10;&#10;Deck&#10;1 Sol Ring&#10;..."
              class="w-full font-mono"
            />
          </UFormField>

          <p v-if="importError" class="text-sm text-error">{{ importError }}</p>

          <!-- Dry-run report -->
          <div v-if="report" class="rounded-lg border border-default p-3 text-sm flex flex-col gap-3">
            <p>
              <UBadge variant="subtle" color="success">{{ report.resolved.length }}</UBadge>
              lines resolved
              <span v-if="report.skipped.length" class="text-dimmed">
                · {{ report.skipped.length }} ignored (comments/sideboard)</span>
            </p>

            <div v-if="report.unresolved.length">
              <p class="font-medium text-error">{{ report.unresolved.length }} unresolved line(s):</p>
              <ul class="mt-1 flex flex-col gap-1">
                <li v-for="u in report.unresolved" :key="u.line">
                  <span class="font-mono">line {{ u.line }}: {{ u.raw }}</span>
                  <span v-if="u.suggestions.length" class="text-dimmed">
                    — did you mean {{ u.suggestions.map((s) => s.name).join(', ') }}?
                  </span>
                </li>
              </ul>
              <UCheckbox v-model="skipUnresolved" class="mt-2" label="Import anyway, dropping unresolved lines" />
            </div>

            <div v-if="report.warnings.length">
              <p class="font-medium text-warning">Warnings (never blocking):</p>
              <ul class="mt-1 list-disc pl-5">
                <li v-for="(w, i) in report.warnings" :key="i">{{ warningLabel(w) }}</li>
              </ul>
            </div>

            <p>
              <span class="font-medium">Commander:</span>
              <template v-if="report.commander.designated.length">
                {{ report.commander.designated.map((id) => cardName(report!, id)).join(' / ') }}
              </template>
              <template v-else-if="report.commander.guess.length">
                <span class="text-dimmed">
                  none designated — best guess: {{ report.commander.guess.map((id) => cardName(report!, id)).join(' / ') }}
                  (set it on the deck page)</span>
              </template>
              <template v-else>
                <span class="text-dimmed">none — you'll pick one on the deck page</span>
              </template>
            </p>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" @click="() => { importOpen = false }">Cancel</UButton>
          <UButton
            variant="soft"
            :loading="importBusy"
            :disabled="!importName.trim() || !importText.trim()"
            @click="runImport(false)"
          >
            {{ report ? 'Re-check' : 'Preview import' }}
          </UButton>
          <UButton :disabled="!canConfirm || importBusy" :loading="importBusy" @click="runImport(true)">
            Create deck
          </UButton>
        </div>
      </template>
    </UModal>
  </UContainer>
</template>
