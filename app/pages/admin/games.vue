<script setup lang="ts">
interface AdminGame {
  id: string
  lobbyName: string
  inviteCode: string
  status: string
  players: { seatIndex: number; username: string }[]
  startedAt: string
  endedAt: string | null
  durationSeconds: number | null
  snapshotSeq: number
  eventCount: number
  winnerSeat: number | null
  live: { connectedPlayers: number; turnNumber: number; step: string; status: string; seq: number } | null
}
interface Page {
  page: number
  pageSize: number
  total: number
  games: AdminGame[]
}

const page = ref(1)
const { data } = await useAsyncData<Page>(
  'admin-games',
  () => adminFetch<Page>('/api/admin/games', { query: { page: page.value } }),
  { server: false, watch: [page] },
)
const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / (data.value?.pageSize ?? 25))))

type BadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'
const statusColor: Record<string, BadgeColor> = {
  ACTIVE: 'success',
  FINISHED: 'neutral',
  ABANDONED: 'error',
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—'
  const m = Math.floor(seconds / 60)
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${m}m ${seconds % 60}s`
}
</script>

<template>
  <AdminShell>
    <div class="mb-4 flex items-center justify-between">
      <h2 class="font-semibold">Games <span v-if="data" class="text-dimmed font-normal">({{ data.total }})</span></h2>
      <div class="flex items-center gap-2 text-sm">
        <UButton size="xs" variant="outline" color="neutral" :disabled="page <= 1" @click="() => { page-- }">Prev</UButton>
        <span class="text-dimmed">{{ page }} / {{ totalPages }}</span>
        <UButton size="xs" variant="outline" color="neutral" :disabled="page >= totalPages" @click="() => { page++ }">Next</UButton>
      </div>
    </div>

    <div v-if="!data" class="text-dimmed text-sm">Loading…</div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-default text-left text-xs text-dimmed">
            <th class="py-2 pr-3">Lobby</th>
            <th class="py-2 pr-3">Status</th>
            <th class="py-2 pr-3">Players</th>
            <th class="py-2 pr-3">Started</th>
            <th class="py-2 pr-3">Duration</th>
            <th class="py-2 pr-3">Seq</th>
            <th class="py-2 pr-3">Events</th>
            <th class="py-2 pr-3">Winner</th>
            <th class="py-2">Live</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="game in data.games" :key="game.id" class="border-b border-default/50">
            <td class="py-2 pr-3">
              <p class="font-medium">{{ game.lobbyName }}</p>
              <code class="text-xs text-dimmed">{{ game.id.slice(0, 10) }}…</code>
            </td>
            <td class="py-2 pr-3">
              <UBadge size="sm" variant="subtle" :color="statusColor[game.status] ?? 'neutral'">
                {{ game.status }}
              </UBadge>
            </td>
            <td class="py-2 pr-3 text-xs">
              <span v-for="(p, i) in game.players" :key="p.seatIndex">
                <span v-if="i > 0">, </span>{{ p.username }} <span class="text-dimmed">(s{{ p.seatIndex }})</span>
              </span>
            </td>
            <td class="py-2 pr-3 text-xs text-dimmed">{{ new Date(game.startedAt).toLocaleString('en-GB') }}</td>
            <td class="py-2 pr-3">{{ formatDuration(game.durationSeconds) }}</td>
            <td class="py-2 pr-3">{{ game.snapshotSeq }}</td>
            <td class="py-2 pr-3">{{ game.eventCount }}</td>
            <td class="py-2 pr-3">{{ game.winnerSeat == null ? '—' : `seat ${game.winnerSeat}` }}</td>
            <td class="py-2 text-xs">
              <template v-if="game.live">
                <UBadge size="sm" variant="subtle" color="success">
                  {{ game.live.connectedPlayers }} online
                </UBadge>
                <p class="mt-1 text-dimmed">turn {{ game.live.turnNumber }} · {{ game.live.step }}</p>
              </template>
              <span v-else class="text-dimmed">not loaded</span>
            </td>
          </tr>
          <tr v-if="!data.games.length">
            <td colspan="9" class="py-6 text-center text-dimmed">No games.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </AdminShell>
</template>
