<script setup lang="ts">
const route = useRoute()
const links = [
  { to: '/admin', label: 'Dashboard' },
  { to: '/admin/lobbies', label: 'Lobbies' },
  { to: '/admin/games', label: 'Games' },
  { to: '/admin/cards', label: 'Cards' },
]

async function logout() {
  await $fetch('/api/admin/logout', { method: 'POST' })
  await navigateTo('/admin/login')
}
</script>

<template>
  <UContainer class="py-8 max-w-6xl">
    <header class="mb-6 flex flex-wrap items-center gap-3">
      <h1 class="text-xl font-bold">Arpenteurs — Backoffice</h1>
      <nav class="flex grow gap-1">
        <UButton
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          size="sm"
          :variant="route.path === link.to ? 'soft' : 'ghost'"
          color="neutral"
        >
          {{ link.label }}
        </UButton>
      </nav>
      <UButton size="sm" variant="outline" color="neutral" icon="i-lucide-log-out" @click="logout">
        Log out
      </UButton>
    </header>
    <slot />
  </UContainer>
</template>
