<script setup lang="ts">
/**
 * Right sidebar: Log / Chat tabs. Log lines come pre-redacted from the server;
 * everything is rendered as plain text interpolation — never v-html.
 */
import { useGameStore } from '~/stores/game'

const store = useGameStore()
const ui = useBoardUi()

const tab = ref('log')
const tabs = [
  { label: 'Log', value: 'log', icon: 'i-lucide-scroll-text' },
  { label: 'Chat', value: 'chat', icon: 'i-lucide-messages-square' },
]

const chatEntries = computed(() => store.log.filter((l) => l.kind === 'chat.send'))
const shown = computed(() => (tab.value === 'chat' ? chatEntries.value : store.log))

function ts(t: number) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function actorName(actor: string | null) {
  return actor ? (store.state?.players[actor]?.name ?? '?') : null
}

const scroller = ref<HTMLElement | null>(null)
watch(
  () => [store.log.length, tab.value],
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

const draft = ref('')
function sendChat() {
  const text = draft.value.trim()
  if (!text) return
  if (ui.send({ type: 'chat.send', text: text.slice(0, 500) })) draft.value = ''
}

const KIND_ICON: Record<string, string> = {
  'game.roll': '🎲',
  'game.coin': '🪙',
  'deck.revealTop': '👁',
  'hand.reveal': '👁',
  'chat.send': '💬',
}
</script>

<template>
  <div class="flex flex-col min-h-0 bg-elevated/60">
    <UTabs v-model="tab" :items="tabs" :content="false" size="xs" class="p-1 shrink-0" />

    <div ref="scroller" class="flex-1 min-h-0 overflow-y-auto px-2 py-1 space-y-0.5 text-xs">
      <p v-if="!shown.length" class="text-dimmed py-4 text-center">
        {{ tab === 'chat' ? 'No messages yet.' : 'Nothing has happened yet.' }}
      </p>
      <div v-for="entry in shown" :key="`${entry.seq}-${entry.kind}`" class="flex gap-1.5 items-baseline">
        <span class="text-dimmed/60 tabular-nums shrink-0 text-[10px]">{{ ts(entry.ts) }}</span>
        <span
          class="min-w-0 break-words"
          :class="entry.kind === 'chat.send' ? 'text-highlighted' : 'text-muted'"
        >
          <span v-if="KIND_ICON[entry.kind]" class="mr-0.5">{{ KIND_ICON[entry.kind] }}</span>{{ entry.line }}
        </span>
      </div>
    </div>

    <form class="flex gap-1 p-1.5 border-t border-default shrink-0" @submit.prevent="sendChat">
      <UInput
        v-model="draft"
        size="xs"
        class="flex-1"
        placeholder="Say something…"
        maxlength="500"
        @focus="tab = 'chat'"
      />
      <UButton type="submit" size="xs" icon="i-lucide-send" :disabled="!draft.trim()" aria-label="Send" />
    </form>
  </div>
</template>
