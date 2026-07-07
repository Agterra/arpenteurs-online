<script setup lang="ts">
const token = ref('')
const error = ref('')
const submitting = ref(false)

async function onSubmit() {
  if (!token.value.trim()) return
  submitting.value = true
  error.value = ''
  try {
    await $fetch('/api/admin/login', { method: 'POST', body: { token: token.value } })
    await navigateTo('/admin')
  } catch (err) {
    error.value = apiErrorMessage(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UContainer class="py-16 max-w-md">
    <UCard>
      <template #header>
        <h1 class="font-semibold">Backoffice login</h1>
      </template>
      <form class="flex flex-col gap-3" @submit.prevent="onSubmit">
        <UFormField label="Admin token" required>
          <UInput
            v-model="token"
            type="password"
            placeholder="Admin token"
            autofocus
            class="w-full"
          />
        </UFormField>
        <div>
          <UButton type="submit" :loading="submitting" :disabled="!token.trim()">Sign in</UButton>
        </div>
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </form>
    </UCard>
  </UContainer>
</template>
