<script setup lang="ts">
/**
 * Game page: REST bootstrap (membership check + shell data), then the whole
 * board mounts client-only and is painted by the first ws sync.
 */
interface GameBootstrap {
  game: {
    id: string
    status: string
    lobbyId: string
    you: string
    players: { id: string; username: string; seat: number }[]
    wsPath: string
  }
}

const route = useRoute()
const gameId = route.params.id as string
const requestFetch = useRequestFetch()

const { user, refresh: refreshSession } = useSession()
await useAsyncData('session', async () => {
  await refreshSession()
  return true
})

const { data, error } = await useAsyncData(`game-${gameId}`, async () => {
  if (!user.value) return null
  return requestFetch<GameBootstrap>(`/api/games/${gameId}`)
})

const statusCode = computed(() => (error.value as { statusCode?: number } | null)?.statusCode)

useHead(() => ({ title: data.value ? `Game — Arpenteurs` : 'Game' }))
</script>

<template>
  <div>
    <!-- error / access states (SSR-rendered shell) -->
    <UContainer v-if="!user" class="py-16 max-w-md text-center space-y-3">
      <h1 class="text-lg font-semibold">Game table</h1>
      <p class="text-sm text-dimmed">You need a session to join a game.</p>
      <UButton to="/">Go home</UButton>
    </UContainer>

    <UContainer v-else-if="error" class="py-16 max-w-md text-center space-y-3">
      <h1 class="text-lg font-semibold">
        {{ statusCode === 403 ? 'Not your table' : 'Game unavailable' }}
      </h1>
      <p class="text-sm text-dimmed">
        {{ statusCode === 403 ? "You're not a player of this game." : 'This game could not be loaded.' }}
      </p>
      <UButton to="/">Go home</UButton>
    </UContainer>

    <template v-else-if="data">
      <ClientOnly>
        <BoardGameBoard :game-id="gameId" />
        <template #fallback>
          <div class="fixed inset-0 flex items-center justify-center text-dimmed">Loading the table…</div>
        </template>
      </ClientOnly>
    </template>
  </div>
</template>
