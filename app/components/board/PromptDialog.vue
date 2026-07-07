<script setup lang="ts">
/**
 * One shared modal for every small prompt on the board: number ("Scry X"),
 * text (counter name), choice (player picker, top/bottom) and confirm.
 * Driven imperatively via ask() → Promise, exposed to the board root.
 */
import type { PromptOptions } from '~/composables/useBoardUi'

const open = ref(false)
const opts = ref<PromptOptions | null>(null)
const numberValue = ref<number>(1)
const textValue = ref('')
let resolver: ((v: string | number | null) => void) | null = null

function ask(options: PromptOptions): Promise<string | number | null> {
  // settle any prompt already showing
  resolver?.(null)
  opts.value = options
  numberValue.value = typeof options.initial === 'number' ? options.initial : 1
  textValue.value = typeof options.initial === 'string' ? options.initial : ''
  open.value = true
  return new Promise((resolve) => {
    resolver = resolve
  })
}

function settle(v: string | number | null) {
  open.value = false
  const r = resolver
  resolver = null
  r?.(v)
}

function submit() {
  if (!opts.value) return
  if (opts.value.kind === 'number') {
    const n = Math.round(numberValue.value)
    const min = opts.value.min ?? 1
    const max = opts.value.max ?? 500
    settle(Math.max(min, Math.min(max, n)))
  } else if (opts.value.kind === 'text') {
    settle(textValue.value.trim() || null)
  } else if (opts.value.kind === 'confirm') {
    settle('yes')
  }
}

watch(open, (o) => {
  if (!o && resolver) settle(null) // dismissed via overlay/escape
})

defineExpose({ ask })
</script>

<template>
  <UModal v-model:open="open" :title="opts?.title" :ui="{ content: 'max-w-sm' }">
    <template #body>
      <form v-if="opts" class="space-y-3" @submit.prevent="submit">
        <p v-if="opts.label && (opts.kind === 'confirm' || opts.kind === 'choice')" class="text-sm text-dimmed">
          {{ opts.label }}
        </p>

        <UFormField v-if="opts.kind === 'number'" :label="opts.label">
          <UInput
            v-model.number="numberValue"
            type="number"
            :min="opts.min ?? 1"
            :max="opts.max ?? 500"
            autofocus
            class="w-full"
          />
        </UFormField>
        <UFormField v-else-if="opts.kind === 'text'" :label="opts.label">
          <UInput v-model="textValue" autofocus maxlength="40" class="w-full" />
        </UFormField>

        <div v-if="opts.kind === 'choice'" class="flex flex-col gap-1.5">
          <UButton
            v-for="option in opts.options ?? []"
            :key="option.value"
            variant="soft"
            block
            @click="settle(option.value)"
          >
            {{ option.label }}
          </UButton>
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <UButton variant="ghost" color="neutral" @click="settle(null)">Cancel</UButton>
          <UButton
            v-if="opts.kind !== 'choice'"
            type="submit"
            :color="opts.danger ? 'error' : 'primary'"
          >
            {{ opts.confirmLabel ?? 'OK' }}
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
