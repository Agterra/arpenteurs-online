<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'

interface LobbySeatView {
  seatIndex: number
  userId: string
  username: string
  deckId: string | null
  deckName: string | null
  commanders: string[]
  isReady: boolean
}
type LobbyResponse =
  | {
      member: true
      id: string
      inviteCode: string
      name: string
      hasPassword: boolean
      visibility: 'PUBLIC' | 'UNLISTED'
      mode: 'MANUAL' | 'ENFORCED'
      status: 'OPEN' | 'STARTING' | 'IN_GAME' | 'FINISHED'
      hostId: string
      maxSeats: number
      activeGameId: string | null
      seats: LobbySeatView[]
    }
  | {
      member: false
      name: string
      hasPassword: boolean
      mode: 'MANUAL' | 'ENFORCED'
      status: string
      seatCount: number
      maxSeats: number
    }

const route = useRoute()
const code = route.params.code as string
const requestFetch = useRequestFetch()

const { user, refresh: refreshSession, claim } = useSession()
await useAsyncData('session', async () => {
  await refreshSession()
  return true
})

const { data, error, refresh } = await useAsyncData(`lobby-${code}`, async () => {
  if (!user.value) return null
  return requestFetch<LobbyResponse>(`/api/lobbies/${code}`)
})

const lobby = computed(() => data.value)
const detail = computed(() => (data.value?.member ? data.value : null))
const mySeat = computed(() => detail.value?.seats.find((s) => s.userId === user.value?.id) ?? null)
const isHost = computed(() => !!detail.value && detail.value.hostId === user.value?.id)
const allReady = computed(
  () => !!detail.value && detail.value.seats.length >= 1 && detail.value.seats.every((s) => s.isReady),
)

// ---- polling (v1 lobby transport per plan; ws presence lands with the game engine) ----
if (import.meta.client) {
  useIntervalFn(() => {
    if (user.value && !fatalError.value) refresh()
  }, 2000)
}
const fatalError = computed(() => {
  const status = (error.value as { statusCode?: number } | null)?.statusCode
  return status === 404
})

// member + game running → go to the game
watch(
  detail,
  async (d) => {
    if (d && d.status === 'IN_GAME' && d.activeGameId) await navigateTo(`/game/${d.activeGameId}`)
  },
  { immediate: true },
)

// ---- claim (visiting an invite link without a session) ----
const claimName = ref('')
const claimBusy = ref(false)
const claimError = ref('')
async function onClaim() {
  if (!claimName.value.trim()) return
  claimBusy.value = true
  claimError.value = ''
  try {
    await claim(claimName.value)
    await refresh()
  } catch (err) {
    claimError.value = apiErrorMessage(err)
  } finally {
    claimBusy.value = false
  }
}

// ---- join ----
const password = ref('')
const joinBusy = ref(false)
const joinError = ref('')
async function onJoin() {
  joinBusy.value = true
  joinError.value = ''
  try {
    const res = await $fetch<{ ok?: boolean; rejoin?: boolean; gameId?: string }>(
      `/api/lobbies/${code}/join`,
      { method: 'POST', body: password.value ? { password: password.value } : {} },
    )
    if (res.rejoin && res.gameId) {
      await navigateTo(`/game/${res.gameId}`)
      return
    }
    await refresh()
  } catch (err) {
    joinError.value = apiErrorMessage(err)
  } finally {
    joinBusy.value = false
  }
}

// ---- my controls ----
const { data: decksData } = await useAsyncData('decks-for-lobby', async () => {
  if (!user.value) return { decks: [] }
  return requestFetch<{ decks: { id: string; name: string }[] }>('/api/decks')
})
const deckItems = computed(() =>
  (decksData.value?.decks ?? []).map((d) => ({ label: d.name, value: d.id })),
)
const actionError = ref('')
const selectedDeck = computed({
  get: () => mySeat.value?.deckId ?? undefined,
  set: (deckId: string | undefined) => {
    if (deckId) patchMe({ deckId })
  },
})
async function patchMe(body: { deckId?: string; isReady?: boolean }) {
  actionError.value = ''
  try {
    await $fetch(`/api/lobbies/${code}/me`, { method: 'PATCH', body })
    await refresh()
  } catch (err) {
    actionError.value = apiErrorMessage(err)
  }
}
async function onLeave() {
  actionError.value = ''
  try {
    await $fetch(`/api/lobbies/${code}/leave`, { method: 'POST' })
    await navigateTo('/')
  } catch (err) {
    actionError.value = apiErrorMessage(err)
  }
}

// ---- host controls ----
async function onKick(seat: LobbySeatView) {
  actionError.value = ''
  try {
    await $fetch(`/api/lobbies/${code}/kick`, { method: 'POST', body: { userId: seat.userId } })
    await refresh()
  } catch (err) {
    actionError.value = apiErrorMessage(err)
  }
}
const startBusy = ref(false)
interface StartError {
  seat?: number
  code: string
  message?: string
  names?: string[]
  count?: number
}
const startErrors = ref<StartError[]>([])
const supportedCommanders = ref<string[]>([])
const unimplementedCards = computed(
  () => startErrors.value.find((e) => e.code === 'UNIMPLEMENTED_CARDS') ?? null,
)
const seatStartErrors = computed(() =>
  startErrors.value.filter((e) => e.code !== 'UNIMPLEMENTED_CARDS' && e.seat !== undefined),
)
async function onStart() {
  startBusy.value = true
  actionError.value = ''
  startErrors.value = []
  try {
    const res = await $fetch<{ gameId: string }>(`/api/lobbies/${code}/start`, { method: 'POST' })
    await navigateTo(`/game/${res.gameId}`)
  } catch (err) {
    const e = err as { data?: { data?: { errors?: StartError[]; supportedCommanders?: string[] } } }
    startErrors.value = e?.data?.data?.errors ?? []
    supportedCommanders.value = e?.data?.data?.supportedCommanders ?? []
    actionError.value = apiErrorMessage(err)
    await refresh()
  } finally {
    startBusy.value = false
  }
}

// ---- invite link ----
const copied = ref(false)
async function copyInvite() {
  await navigator.clipboard.writeText(window.location.href)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <UContainer class="py-10 max-w-2xl">
    <UButton to="/" variant="link" size="xs" class="px-0">← Home</UButton>

    <!-- No session: claim first -->
    <UCard v-if="!user" class="mt-4">
      <template #header>
        <h1 class="font-semibold">You've been invited to a lobby</h1>
      </template>
      <p class="text-sm text-dimmed mb-3">Pick a username to continue.</p>
      <form class="flex gap-2" @submit.prevent="onClaim">
        <UInput v-model="claimName" placeholder="Username (1–24 characters)" maxlength="24" class="flex-1" />
        <UButton type="submit" :loading="claimBusy" :disabled="!claimName.trim()">Claim</UButton>
      </form>
      <p v-if="claimError" class="mt-2 text-sm text-error">{{ claimError }}</p>
    </UCard>

    <UCard v-else-if="fatalError" class="mt-4">
      <p class="text-sm text-error">Lobby not found — the invite link may be wrong or expired.</p>
    </UCard>

    <template v-else-if="lobby">
      <!-- Non-member preview + join -->
      <UCard v-if="!lobby.member" class="mt-4">
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <h1 class="font-semibold">{{ lobby.name }}</h1>
            <div class="flex items-center gap-2">
              <UBadge v-if="lobby.mode === 'ENFORCED'" variant="subtle" color="info">Enforced Commander (beta)</UBadge>
              <UBadge variant="subtle">{{ lobby.status }}</UBadge>
            </div>
          </div>
        </template>
        <p class="text-sm text-dimmed">{{ lobby.seatCount }}/{{ lobby.maxSeats }} seats taken</p>
        <form class="mt-4 flex flex-wrap items-center gap-2" @submit.prevent="onJoin">
          <UInput
            v-if="lobby.hasPassword"
            v-model="password"
            type="password"
            placeholder="Lobby password"
            maxlength="100"
            class="flex-1 min-w-40"
          />
          <UButton type="submit" :loading="joinBusy">Join lobby</UButton>
        </form>
        <p v-if="joinError" class="mt-2 text-sm text-error">{{ joinError }}</p>
      </UCard>

      <!-- Member view -->
      <template v-else>
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <h1 class="text-2xl font-bold grow">{{ lobby.name }}</h1>
          <UBadge
            v-if="lobby.mode === 'ENFORCED'"
            variant="subtle"
            color="info"
            title="Full rules enforcement — 2–4 players, 40 life, command zone, small card pool"
          >
            Enforced Commander (beta)
          </UBadge>
          <UBadge variant="subtle">{{ lobby.status }}</UBadge>
          <UBadge v-if="lobby.visibility === 'UNLISTED'" variant="subtle" color="neutral">Unlisted</UBadge>
          <UButton size="xs" variant="soft" icon="i-lucide-link" @click="copyInvite">
            {{ copied ? 'Copied!' : 'Copy invite link' }}
          </UButton>
        </div>

        <!-- Seats -->
        <UCard class="mt-4">
          <template #header>
            <h2 class="font-semibold">Players ({{ lobby.seats.length }}/{{ lobby.maxSeats }})</h2>
          </template>
          <ul class="divide-y divide-default">
            <li v-for="seat in lobby.seats" :key="seat.seatIndex" class="flex items-center gap-3 py-3">
              <span class="text-xs text-dimmed w-5">#{{ seat.seatIndex + 1 }}</span>
              <div class="grow min-w-0">
                <p class="font-medium truncate">
                  {{ seat.username }}
                  <span v-if="seat.userId === lobby.hostId" title="Host">👑</span>
                  <span v-if="seat.userId === user.id" class="text-xs text-dimmed">(you)</span>
                </p>
                <p class="text-xs text-dimmed truncate">
                  <template v-if="seat.deckName">
                    {{ seat.deckName }}
                    <template v-if="seat.commanders.length"> — {{ seat.commanders.join(' / ') }}</template>
                  </template>
                  <template v-else>No deck selected</template>
                </p>
              </div>
              <UBadge :color="seat.isReady ? 'success' : 'neutral'" variant="subtle">
                {{ seat.isReady ? 'Ready' : 'Not ready' }}
              </UBadge>
              <UButton
                v-if="isHost && seat.userId !== user.id && lobby.status === 'OPEN'"
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-user-x"
                title="Kick"
                @click="onKick(seat)"
              />
            </li>
          </ul>
        </UCard>

        <!-- My controls -->
        <UCard v-if="mySeat && lobby.status === 'OPEN'" class="mt-4">
          <template #header>
            <h2 class="font-semibold">Your seat</h2>
          </template>
          <div class="flex flex-wrap items-end gap-3">
            <UFormField label="Deck" class="flex-1 min-w-52">
              <USelect
                v-model="selectedDeck"
                :items="deckItems"
                value-key="value"
                placeholder="Select a deck"
                class="w-full"
              />
            </UFormField>
            <UButton
              :color="mySeat.isReady ? 'neutral' : 'success'"
              :variant="mySeat.isReady ? 'soft' : 'solid'"
              @click="patchMe({ isReady: !mySeat.isReady })"
            >
              {{ mySeat.isReady ? 'Unready' : 'Ready up' }}
            </UButton>
            <UButton color="error" variant="soft" @click="onLeave">Leave</UButton>
          </div>
          <p v-if="!deckItems.length" class="mt-2 text-xs text-dimmed">
            You have no decks yet — <NuxtLink :to="`/decks?lobby=${code}`" class="text-primary underline">import one</NuxtLink>.
          </p>
          <p v-else class="mt-2 text-xs text-dimmed">
            <NuxtLink :to="`/decks?lobby=${code}`" class="text-primary underline">Manage or import decks →</NuxtLink>
          </p>
        </UCard>

        <!-- Host: start -->
        <UCard v-if="isHost && lobby.status === 'OPEN'" class="mt-4">
          <div class="flex items-center gap-3">
            <UButton :disabled="!allReady" :loading="startBusy" size="lg" @click="onStart">
              Start game
            </UButton>
            <p v-if="!allReady" class="text-sm text-dimmed">Waiting for everyone to be ready…</p>
          </div>
          <div v-if="unimplementedCards" class="mt-3 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
            <p class="font-medium">These cards aren't supported in enforced mode yet:</p>
            <p class="mt-1 text-dimmed">
              {{ (unimplementedCards.names ?? []).join(', ') }}
              <template v-if="(unimplementedCards.count ?? 0) > (unimplementedCards.names?.length ?? 0)">
                … and {{ (unimplementedCards.count ?? 0) - (unimplementedCards.names?.length ?? 0) }} more
              </template>
            </p>
            <p class="mt-1 text-xs text-dimmed">
              Swap them out, or play this deck in a manual lobby instead.
            </p>
          </div>
          <ul v-if="seatStartErrors.length" class="mt-2 text-sm text-error list-disc pl-5">
            <li v-for="(e, i) in seatStartErrors" :key="i">
              Seat {{ (e.seat ?? 0) + 1 }}: {{ e.message ?? e.code }}
            </li>
          </ul>
          <div v-if="supportedCommanders.length" class="mt-2 rounded-md bg-elevated/60 p-2 text-xs">
            <p class="font-medium">Commanders enforced mode supports right now (beta pool):</p>
            <p class="mt-0.5 text-dimmed">{{ supportedCommanders.join(' · ') }}</p>
            <p class="mt-1 text-dimmed">Any other deck plays fine in a <span class="font-medium">Manual</span> lobby.</p>
          </div>
          <p
            v-if="startErrors.some((e) => e.code === 'NEED_TWO_PLAYERS' || e.code === 'NEED_2_TO_4_PLAYERS')"
            class="mt-2 text-sm text-error"
          >
            Enforced Commander needs 2–4 players.
          </p>
        </UCard>

        <p v-if="actionError" class="mt-3 text-sm text-error">{{ actionError }}</p>
      </template>
    </template>
  </UContainer>
</template>
