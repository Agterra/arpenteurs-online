<script setup lang="ts">
interface DayPoint {
  day: string
  count: number
}
interface Stats {
  totals: {
    users: number
    decks: number
    cards: number
    lobbiesByStatus: Record<string, number>
    gamesByStatus: Record<string, number>
  }
  perDay: {
    usersCreated: DayPoint[]
    lobbiesCreated: DayPoint[]
    gamesStarted: DayPoint[]
    gamesFinished: DayPoint[]
  }
  gameDuration: {
    finishedCount: number
    avgSeconds: number | null
    p50Seconds: number | null
    p90Seconds: number | null
  }
  avgEventsPerFinishedGame: number | null
  catalog: { cards: number; lastImportedAt: string | null }
  live: {
    rooms: { gameId: string; turnNumber: number; step: string; status: string; connectedPlayers: number }[]
    roomCount: number
    connectedPeers: number
  }
}

const { data: stats, refresh } = await useAsyncData<Stats>(
  'admin-stats',
  () => adminFetch<Stats>('/api/admin/stats'),
  { server: false },
)

function sumValues(rec: Record<string, number> | undefined): number {
  return Object.values(rec ?? {}).reduce((a, b) => a + b, 0)
}

function statusLine(rec: Record<string, number> | undefined): string {
  const entries = Object.entries(rec ?? {})
  if (!entries.length) return 'none'
  return entries.map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  const s = Math.round(seconds)
  const m = Math.floor(s / 60)
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${m}m ${s % 60}s`
}

// ---- last-30-days bar charts (plain divs) ----
function last30Days(): string[] {
  const out: string[] = []
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i))
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

function toBars(points: DayPoint[] | undefined): { day: string; count: number; pct: number }[] {
  const byDay = new Map((points ?? []).map((p) => [p.day, p.count]))
  const days = last30Days().map((day) => ({ day, count: byDay.get(day) ?? 0 }))
  const max = Math.max(1, ...days.map((d) => d.count))
  return days.map((d) => ({ ...d, pct: Math.round((d.count / max) * 100) }))
}

const charts = computed(() => [
  { title: 'Users created', bars: toBars(stats.value?.perDay.usersCreated) },
  { title: 'Lobbies created', bars: toBars(stats.value?.perDay.lobbiesCreated) },
  { title: 'Games started', bars: toBars(stats.value?.perDay.gamesStarted) },
  { title: 'Games finished', bars: toBars(stats.value?.perDay.gamesFinished) },
])

// ---- re-import panel ----
interface ReimportStatus {
  running: boolean
  logTail: string | null
}
const reimport = ref<ReimportStatus | null>(null)
const reimportError = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null

async function refreshReimport() {
  reimport.value = await adminFetch<ReimportStatus>('/api/admin/reimport')
  if (reimport.value.running && !pollTimer) {
    pollTimer = setInterval(refreshReimport, 2000)
  } else if (!reimport.value.running && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
    await refresh() // catalog freshness likely changed
  }
}

async function startReimport() {
  reimportError.value = ''
  try {
    await adminFetch('/api/admin/reimport', { method: 'POST' })
  } catch (err) {
    reimportError.value = apiErrorMessage(err)
  }
  await refreshReimport()
}

onMounted(refreshReimport)
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <AdminShell>
    <div v-if="!stats" class="text-dimmed text-sm">Loading…</div>
    <template v-else>
      <!-- KPI cards -->
      <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <UCard>
          <p class="text-xs text-dimmed">Users</p>
          <p class="text-2xl font-bold">{{ stats.totals.users }}</p>
        </UCard>
        <UCard>
          <p class="text-xs text-dimmed">Decks</p>
          <p class="text-2xl font-bold">{{ stats.totals.decks }}</p>
        </UCard>
        <UCard>
          <p class="text-xs text-dimmed">Cards in catalog</p>
          <p class="text-2xl font-bold">{{ stats.totals.cards.toLocaleString('en-US') }}</p>
        </UCard>
        <UCard>
          <p class="text-xs text-dimmed">Lobbies</p>
          <p class="text-2xl font-bold">{{ sumValues(stats.totals.lobbiesByStatus) }}</p>
          <p class="text-xs text-dimmed">{{ statusLine(stats.totals.lobbiesByStatus) }}</p>
        </UCard>
        <UCard>
          <p class="text-xs text-dimmed">Games</p>
          <p class="text-2xl font-bold">{{ sumValues(stats.totals.gamesByStatus) }}</p>
          <p class="text-xs text-dimmed">{{ statusLine(stats.totals.gamesByStatus) }}</p>
        </UCard>
        <UCard>
          <p class="text-xs text-dimmed">Live now</p>
          <p class="text-2xl font-bold">{{ stats.live.roomCount }}</p>
          <p class="text-xs text-dimmed">rooms · {{ stats.live.connectedPeers }} connected</p>
        </UCard>
      </div>

      <!-- Per-day charts -->
      <div class="mt-6 grid gap-4 md:grid-cols-2">
        <UCard v-for="chart in charts" :key="chart.title">
          <template #header>
            <h2 class="text-sm font-semibold">{{ chart.title }} — last 30 days</h2>
          </template>
          <div class="flex h-24 items-end gap-px">
            <div
              v-for="bar in chart.bars"
              :key="bar.day"
              class="group relative min-w-0 flex-1 rounded-t bg-primary/70"
              :style="{ height: bar.count ? `${Math.max(bar.pct, 4)}%` : '2px' }"
              :class="bar.count ? '' : 'bg-muted'"
              :title="`${bar.day}: ${bar.count}`"
            />
          </div>
          <div class="mt-1 flex justify-between text-[10px] text-dimmed">
            <span>{{ chart.bars[0]?.day }}</span>
            <span>{{ chart.bars[chart.bars.length - 1]?.day }}</span>
          </div>
        </UCard>
      </div>

      <!-- Duration + activity stats -->
      <div class="mt-6 grid gap-4 md:grid-cols-2">
        <UCard>
          <template #header>
            <h2 class="text-sm font-semibold">Game durations ({{ stats.gameDuration.finishedCount }} finished)</h2>
          </template>
          <div class="grid grid-cols-3 gap-3 text-center">
            <div>
              <p class="text-xs text-dimmed">Average</p>
              <p class="text-lg font-bold">{{ formatDuration(stats.gameDuration.avgSeconds) }}</p>
            </div>
            <div>
              <p class="text-xs text-dimmed">Median (p50)</p>
              <p class="text-lg font-bold">{{ formatDuration(stats.gameDuration.p50Seconds) }}</p>
            </div>
            <div>
              <p class="text-xs text-dimmed">p90</p>
              <p class="text-lg font-bold">{{ formatDuration(stats.gameDuration.p90Seconds) }}</p>
            </div>
          </div>
          <p class="mt-3 text-xs text-dimmed">
            Avg actions per finished game:
            <span class="font-semibold text-default">
              {{ stats.avgEventsPerFinishedGame == null ? '—' : Math.round(stats.avgEventsPerFinishedGame) }}
            </span>
          </p>
        </UCard>

        <!-- Live rooms -->
        <UCard>
          <template #header>
            <h2 class="text-sm font-semibold">Live rooms</h2>
          </template>
          <p v-if="!stats.live.rooms.length" class="text-sm text-dimmed">No game room loaded in memory.</p>
          <ul v-else class="divide-y divide-default text-sm">
            <li v-for="room in stats.live.rooms" :key="room.gameId" class="flex items-center gap-2 py-2">
              <code class="text-xs">{{ room.gameId.slice(0, 10) }}…</code>
              <UBadge size="sm" variant="subtle">{{ room.status }}</UBadge>
              <span class="text-dimmed">turn {{ room.turnNumber }} · {{ room.step }}</span>
              <span class="ml-auto">{{ room.connectedPlayers }} connected</span>
            </li>
          </ul>
        </UCard>
      </div>

      <!-- Catalog panel -->
      <UCard class="mt-6">
        <template #header>
          <div class="flex flex-wrap items-center gap-3">
            <h2 class="text-sm font-semibold grow">Card catalog</h2>
            <UButton
              size="sm"
              :loading="reimport?.running ?? false"
              :disabled="reimport?.running ?? false"
              icon="i-lucide-download"
              @click="startReimport"
            >
              {{ reimport?.running ? 'Import running…' : 'Re-import catalog' }}
            </UButton>
          </div>
        </template>
        <p class="text-sm">
          {{ stats.catalog.cards.toLocaleString('en-US') }} cards · last import:
          <span class="font-semibold">
            {{ stats.catalog.lastImportedAt ? new Date(stats.catalog.lastImportedAt).toLocaleString('en-GB') : 'never' }}
          </span>
        </p>
        <p v-if="reimportError" class="mt-2 text-sm text-error">{{ reimportError }}</p>
        <pre
          v-if="reimport?.logTail"
          class="mt-3 max-h-64 overflow-auto rounded bg-elevated p-3 text-xs leading-relaxed"
        >{{ reimport.logTail }}</pre>
      </UCard>
    </template>
  </AdminShell>
</template>
