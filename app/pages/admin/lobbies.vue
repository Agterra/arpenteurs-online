<script setup lang="ts">
interface AdminLobby {
  id: string
  inviteCode: string
  name: string
  status: string
  visibility: string
  hasPassword: boolean
  hostName: string | null
  seatCount: number
  maxSeats: number
  seats: { seatIndex: number; username: string; isReady: boolean }[]
  gameCount: number
  createdAt: string
}
interface Page {
  page: number
  pageSize: number
  total: number
  lobbies: AdminLobby[]
}

const page = ref(1)
const { data } = await useAsyncData<Page>(
  'admin-lobbies',
  () => adminFetch<Page>('/api/admin/lobbies', { query: { page: page.value } }),
  { server: false, watch: [page] },
)
const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / (data.value?.pageSize ?? 25))))

const statusColor: Record<string, string> = {
  OPEN: 'success',
  STARTING: 'info',
  IN_GAME: 'warning',
  FINISHED: 'neutral',
}
</script>

<template>
  <AdminShell>
    <div class="mb-4 flex items-center justify-between">
      <h2 class="font-semibold">Lobbies <span v-if="data" class="text-dimmed font-normal">({{ data.total }})</span></h2>
      <div class="flex items-center gap-2 text-sm">
        <UButton size="xs" variant="outline" color="neutral" :disabled="page <= 1" @click="page--">Prev</UButton>
        <span class="text-dimmed">{{ page }} / {{ totalPages }}</span>
        <UButton size="xs" variant="outline" color="neutral" :disabled="page >= totalPages" @click="page++">Next</UButton>
      </div>
    </div>

    <div v-if="!data" class="text-dimmed text-sm">Loading…</div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-default text-left text-xs text-dimmed">
            <th class="py-2 pr-3">Name</th>
            <th class="py-2 pr-3">Status</th>
            <th class="py-2 pr-3">Visibility</th>
            <th class="py-2 pr-3">Password</th>
            <th class="py-2 pr-3">Host</th>
            <th class="py-2 pr-3">Seats</th>
            <th class="py-2 pr-3">Games</th>
            <th class="py-2">Created</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="lobby in data.lobbies" :key="lobby.id" class="border-b border-default/50">
            <td class="py-2 pr-3">
              <p class="font-medium">{{ lobby.name }}</p>
              <code class="text-xs text-dimmed">{{ lobby.inviteCode }}</code>
            </td>
            <td class="py-2 pr-3">
              <UBadge size="sm" variant="subtle" :color="statusColor[lobby.status] ?? 'neutral'">
                {{ lobby.status }}
              </UBadge>
            </td>
            <td class="py-2 pr-3 text-xs">{{ lobby.visibility }}</td>
            <td class="py-2 pr-3">
              <UBadge v-if="lobby.hasPassword" size="sm" variant="subtle" color="warning">yes</UBadge>
              <span v-else class="text-dimmed text-xs">no</span>
            </td>
            <td class="py-2 pr-3">{{ lobby.hostName ?? '—' }}</td>
            <td class="py-2 pr-3">
              <p>{{ lobby.seatCount }}/{{ lobby.maxSeats }}</p>
              <p class="text-xs text-dimmed">{{ lobby.seats.map((s) => s.username).join(', ') || '—' }}</p>
            </td>
            <td class="py-2 pr-3">{{ lobby.gameCount }}</td>
            <td class="py-2 text-xs text-dimmed">{{ new Date(lobby.createdAt).toLocaleString('en-GB') }}</td>
          </tr>
          <tr v-if="!data.lobbies.length">
            <td colspan="8" class="py-6 text-center text-dimmed">No lobbies.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </AdminShell>
</template>
