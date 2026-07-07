<script setup lang="ts">
interface LobbyListItem {
  inviteCode: string
  name: string
  hasPassword: boolean
  seatCount: number
  maxSeats: number
  hostName: string | null
  createdAt: string
}

const { user, refresh, claim, rename } = useSession()
const requestFetch = useRequestFetch()

await useAsyncData('session', async () => {
  await refresh()
  return true
})

// ---- claim ----
const claimName = ref('')
const claimError = ref('')
const claiming = ref(false)
async function onClaim() {
  if (!claimName.value.trim()) return
  claiming.value = true
  claimError.value = ''
  try {
    await claim(claimName.value)
    await refreshLobbies()
  } catch (err) {
    claimError.value = apiErrorMessage(err)
  } finally {
    claiming.value = false
  }
}

// ---- rename ----
const renameName = ref(user.value?.username ?? '')
watch(user, (u) => {
  if (u) renameName.value = u.username
})
const renameError = ref('')
const renaming = ref(false)
async function onRename() {
  if (!renameName.value.trim() || renameName.value === user.value?.username) return
  renaming.value = true
  renameError.value = ''
  try {
    await rename(renameName.value)
  } catch (err) {
    renameError.value = apiErrorMessage(err)
  } finally {
    renaming.value = false
  }
}

// ---- create lobby ----
const visibilityItems = [
  { label: 'Unlisted (invite link only)', value: 'UNLISTED' },
  { label: 'Public (listed below)', value: 'PUBLIC' },
]
const lobbyName = ref('')
const lobbyPassword = ref('')
const lobbyVisibility = ref<'PUBLIC' | 'UNLISTED'>('UNLISTED')
const createError = ref('')
const creating = ref(false)
async function onCreateLobby() {
  if (!lobbyName.value.trim()) return
  creating.value = true
  createError.value = ''
  try {
    const data = await $fetch<{ lobby: { inviteCode: string } }>('/api/lobbies', {
      method: 'POST',
      body: {
        name: lobbyName.value,
        visibility: lobbyVisibility.value,
        ...(lobbyPassword.value ? { password: lobbyPassword.value } : {}),
      },
    })
    await navigateTo(`/l/${data.lobby.inviteCode}`)
  } catch (err) {
    createError.value = apiErrorMessage(err)
  } finally {
    creating.value = false
  }
}

// ---- public lobby list ----
const { data: lobbiesData, refresh: refreshLobbies } = await useAsyncData(
  'public-lobbies',
  async () => {
    if (!user.value) return { lobbies: [] as LobbyListItem[] }
    return requestFetch<{ lobbies: LobbyListItem[] }>('/api/lobbies')
  },
  { watch: [user] },
)
const joinError = ref('')
async function onJoin(lobby: LobbyListItem) {
  joinError.value = ''
  if (lobby.hasPassword) {
    // password is asked for on the lobby page
    await navigateTo(`/l/${lobby.inviteCode}`)
    return
  }
  try {
    await $fetch(`/api/lobbies/${lobby.inviteCode}/join`, { method: 'POST', body: {} })
  } catch (err) {
    joinError.value = `${lobby.name}: ${apiErrorMessage(err)}`
    await refreshLobbies()
    return
  }
  await navigateTo(`/l/${lobby.inviteCode}`)
}
</script>

<template>
  <UContainer class="py-10 max-w-3xl">
    <h1 class="text-3xl font-bold">Arpenteurs</h1>
    <p class="mt-2 text-dimmed">Online Commander table — fast, light, manual rules.</p>

    <!-- No session: claim a username -->
    <UCard v-if="!user" class="mt-8">
      <template #header>
        <h2 class="font-semibold">Pick a username to get started</h2>
      </template>
      <form class="flex gap-2" @submit.prevent="onClaim">
        <UInput
          v-model="claimName"
          placeholder="Username (1–24 characters)"
          maxlength="24"
          class="flex-1"
          autofocus
        />
        <UButton type="submit" :loading="claiming" :disabled="!claimName.trim()">Claim</UButton>
      </form>
      <p v-if="claimError" class="mt-2 text-sm text-error">{{ claimError }}</p>
      <p class="mt-3 text-xs text-dimmed">
        No account needed — your username lives in a browser cookie.
      </p>
    </UCard>

    <template v-else>
      <!-- Session: welcome + rename -->
      <UCard class="mt-8">
        <div class="flex flex-wrap items-center gap-3">
          <p class="grow">
            Welcome, <span class="font-semibold">{{ user.username }}</span>
          </p>
          <form class="flex items-center gap-2" @submit.prevent="onRename">
            <UInput v-model="renameName" size="sm" maxlength="24" placeholder="New name" />
            <UButton
              type="submit"
              size="sm"
              variant="soft"
              :loading="renaming"
              :disabled="!renameName.trim() || renameName === user.username"
            >
              Rename
            </UButton>
          </form>
          <UButton to="/decks" variant="outline">My decks</UButton>
        </div>
        <p v-if="renameError" class="mt-2 text-sm text-error">{{ renameError }}</p>
      </UCard>

      <!-- Create lobby -->
      <UCard class="mt-6">
        <template #header>
          <h2 class="font-semibold">Create a lobby</h2>
        </template>
        <form class="flex flex-col gap-3" @submit.prevent="onCreateLobby">
          <UFormField label="Name" required>
            <UInput v-model="lobbyName" placeholder="Friday pod" maxlength="60" class="w-full" />
          </UFormField>
          <div class="flex flex-wrap gap-3">
            <UFormField label="Password (optional)" class="flex-1 min-w-48">
              <UInput
                v-model="lobbyPassword"
                type="password"
                placeholder="Leave empty for none"
                maxlength="100"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Visibility" class="flex-1 min-w-48">
              <USelect v-model="lobbyVisibility" :items="visibilityItems" value-key="value" class="w-full" />
            </UFormField>
          </div>
          <p v-if="lobbyPassword && lobbyPassword.length < 4" class="text-xs text-warning">
            Password must be at least 4 characters.
          </p>
          <div>
            <UButton
              type="submit"
              :loading="creating"
              :disabled="!lobbyName.trim() || (!!lobbyPassword && lobbyPassword.length < 4)"
            >
              Create lobby
            </UButton>
          </div>
          <p v-if="createError" class="text-sm text-error">{{ createError }}</p>
        </form>
      </UCard>

      <!-- Public lobby list -->
      <UCard class="mt-6">
        <template #header>
          <div class="flex items-center justify-between">
            <h2 class="font-semibold">Open public lobbies</h2>
            <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" @click="refreshLobbies()">
              Refresh
            </UButton>
          </div>
        </template>
        <p v-if="joinError" class="mb-3 text-sm text-error">{{ joinError }}</p>
        <p v-if="!lobbiesData?.lobbies?.length" class="text-sm text-dimmed">
          No public lobby right now — create one, or join through an invite link.
        </p>
        <ul v-else class="divide-y divide-default">
          <li
            v-for="lobby in lobbiesData.lobbies"
            :key="lobby.inviteCode"
            class="flex items-center gap-3 py-3"
          >
            <div class="grow min-w-0">
              <p class="font-medium truncate">{{ lobby.name }}</p>
              <p class="text-xs text-dimmed">
                Host: {{ lobby.hostName ?? '—' }} · {{ lobby.seatCount }}/{{ lobby.maxSeats }} seats
              </p>
            </div>
            <UBadge v-if="lobby.hasPassword" variant="subtle" color="warning">Password</UBadge>
            <UButton size="sm" :disabled="lobby.seatCount >= lobby.maxSeats" @click="onJoin(lobby)">
              {{ lobby.seatCount >= lobby.maxSeats ? 'Full' : 'Join' }}
            </UButton>
          </li>
        </ul>
      </UCard>
    </template>

    <footer class="mt-12 border-t border-default pt-4 text-xs text-dimmed space-y-1">
      <p>
        Arpenteurs is unofficial Fan Content permitted under the Fan Content Policy. Not
        approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the
        Coast. ©Wizards of the Coast LLC.
      </p>
      <p>Card data by MTGJSON · card images by Scryfall.</p>
    </footer>
  </UContainer>
</template>
