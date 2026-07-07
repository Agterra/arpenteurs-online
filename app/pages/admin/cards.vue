<script setup lang="ts">
import { refDebounced } from '@vueuse/core'

interface AdminCard {
  id: string
  name: string
  layout: string
  manaCost: string | null
  typeLine: string
  commanderLegality: string
  canBeCommander: boolean
  edhrecRank: number | null
  imageSmall: string | null
  importedAt: string
}
interface Page {
  page: number
  pageSize: number
  total: number
  cards: AdminCard[]
}

const q = ref('')
const layout = ref('')
const legality = ref('')
const page = ref(1)

const layoutItems = [
  { label: 'All layouts', value: '' },
  ...['normal', 'transform', 'saga', 'adventure', 'modal_dfc', 'split', 'prepare', 'mutate', 'class', 'aftermath', 'leveler', 'meld', 'flip', 'prototype', 'case'].map(
    (l) => ({ label: l, value: l }),
  ),
]
const legalityItems = [
  { label: 'All legalities', value: '' },
  { label: 'Legal', value: 'LEGAL' },
  { label: 'Banned', value: 'BANNED' },
  { label: 'Restricted', value: 'RESTRICTED' },
  { label: 'Not legal', value: 'NOT_LEGAL' },
]

// Filter changes reset to page 1
watch([q, layout, legality], () => {
  page.value = 1
})

const debouncedQ = refDebounced(q, 300)

const { data } = await useAsyncData<Page>(
  'admin-cards',
  () =>
    adminFetch<Page>('/api/admin/cards', {
      query: {
        page: page.value,
        ...(debouncedQ.value.trim() ? { q: debouncedQ.value.trim() } : {}),
        ...(layout.value ? { layout: layout.value } : {}),
        ...(legality.value ? { legality: legality.value } : {}),
      },
    }),
  { server: false, watch: [page, debouncedQ, layout, legality] },
)
const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / (data.value?.pageSize ?? 50))))

const legalityColor: Record<string, string> = {
  LEGAL: 'success',
  BANNED: 'error',
  RESTRICTED: 'warning',
  NOT_LEGAL: 'neutral',
}

function hideBrokenImage(e: Event) {
  ;(e.target as HTMLImageElement).style.display = 'none'
}
</script>

<template>
  <AdminShell>
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <h2 class="font-semibold">
        Catalog <span v-if="data" class="text-dimmed font-normal">({{ data.total.toLocaleString('en-US') }} cards)</span>
      </h2>
      <div class="ml-auto flex items-center gap-2 text-sm">
        <UButton size="xs" variant="outline" color="neutral" :disabled="page <= 1" @click="page--">Prev</UButton>
        <span class="text-dimmed">{{ page }} / {{ totalPages }}</span>
        <UButton size="xs" variant="outline" color="neutral" :disabled="page >= totalPages" @click="page++">Next</UButton>
      </div>
    </div>

    <div class="mb-4 flex flex-wrap gap-3">
      <UInput
        v-model="q"
        placeholder="Search by name…"
        icon="i-lucide-search"
        class="min-w-64 flex-1"
      />
      <USelect v-model="layout" :items="layoutItems" value-key="value" class="w-44" />
      <USelect v-model="legality" :items="legalityItems" value-key="value" class="w-44" />
    </div>

    <div v-if="!data" class="text-dimmed text-sm">Loading…</div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-default text-left text-xs text-dimmed">
            <th class="py-2 pr-3 w-14"></th>
            <th class="py-2 pr-3">Name</th>
            <th class="py-2 pr-3">Cost</th>
            <th class="py-2 pr-3">Type</th>
            <th class="py-2 pr-3">Layout</th>
            <th class="py-2 pr-3">Commander</th>
            <th class="py-2">EDHREC</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="card in data.cards" :key="card.id" class="border-b border-default/50">
            <td class="py-1 pr-3">
              <img
                v-if="card.imageSmall"
                :src="card.imageSmall"
                :alt="card.name"
                loading="lazy"
                class="h-14 w-10 rounded object-cover"
                @error="hideBrokenImage"
              >
            </td>
            <td class="py-2 pr-3 font-medium">
              {{ card.name }}
              <UBadge v-if="card.canBeCommander" size="sm" variant="subtle" color="info" class="ml-1">CMD</UBadge>
            </td>
            <td class="py-2 pr-3 text-xs"><ManaSymbols v-if="card.manaCost" :value="card.manaCost" :size="13" /><span v-else>—</span></td>
            <td class="py-2 pr-3 text-xs">{{ card.typeLine }}</td>
            <td class="py-2 pr-3 text-xs">{{ card.layout }}</td>
            <td class="py-2 pr-3">
              <UBadge size="sm" variant="subtle" :color="legalityColor[card.commanderLegality] ?? 'neutral'">
                {{ card.commanderLegality }}
              </UBadge>
            </td>
            <td class="py-2 text-xs text-dimmed">{{ card.edhrecRank ?? '—' }}</td>
          </tr>
          <tr v-if="!data.cards.length">
            <td colspan="7" class="py-6 text-center text-dimmed">No cards match.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </AdminShell>
</template>
