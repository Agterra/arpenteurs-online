<script setup lang="ts">
/**
 * Token creation dialog: manual fields + auto-suggestion chips parsed from a
 * source card's oracle text (parseTokenSuggestions), plus "copy of this card".
 */
import type { ManaColor, RedactedCard, TokenSpec } from '#shared/types/game'
import { parseTokenSuggestions } from '#shared/utils/tokenParse'

const ui = useBoardUi()

const open = ref(false)
const fromCard = ref<RedactedCard | null>(null)
const suggestions = ref<TokenSpec[]>([])

const name = ref('')
const quantity = ref(1)
const pt = ref('')
const colors = ref<ManaColor[]>([])
const typeLine = ref('')
const text = ref('')
const tapped = ref(false)
const zone = ref<'battlefield' | 'stack'>('battlefield')
const fromCatalogId = ref<string | null>(null)

function show(card?: RedactedCard) {
  fromCard.value = card ?? null
  suggestions.value = card?.display?.oracleText ? parseTokenSuggestions(card.display.oracleText) : []
  name.value = ''
  quantity.value = 1
  pt.value = ''
  colors.value = []
  typeLine.value = 'Token Creature —'
  text.value = ''
  tapped.value = false
  zone.value = 'battlefield'
  fromCatalogId.value = null
  if (suggestions.value.length === 1) applySpec(suggestions.value[0]!)
  open.value = true
}
defineExpose({ show })

function applySpec(spec: TokenSpec) {
  name.value = spec.name
  pt.value = spec.pt ?? ''
  colors.value = [...spec.colors]
  typeLine.value = spec.typeLine
  text.value = spec.text
  fromCatalogId.value = spec.fromCatalogId
}

function applyCopy() {
  const c = fromCard.value
  const d = c?.display
  if (!c || !d) return
  applySpec({
    name: d.name,
    pt: d.power != null && d.toughness != null ? `${d.power}/${d.toughness}` : null,
    colors: [],
    typeLine: d.typeLine.startsWith('Token') ? d.typeLine : `Token ${d.typeLine}`,
    text: d.oracleText ?? '',
    fromCatalogId: c.catalogId,
  })
}

const COLORS: { value: ManaColor; label: string; cls: string }[] = [
  { value: 'W', label: 'W', cls: 'bg-amber-100 text-stone-900' },
  { value: 'U', label: 'U', cls: 'bg-sky-600 text-white' },
  { value: 'B', label: 'B', cls: 'bg-stone-950 text-stone-200' },
  { value: 'R', label: 'R', cls: 'bg-red-600 text-white' },
  { value: 'G', label: 'G', cls: 'bg-green-700 text-white' },
]
function toggleColor(c: ManaColor) {
  colors.value = colors.value.includes(c) ? colors.value.filter((x) => x !== c) : [...colors.value, c]
}

const canCreate = computed(() => name.value.trim().length > 0)

function create() {
  if (!canCreate.value) return
  ui.send({
    type: 'token.create',
    spec: {
      name: name.value.trim().slice(0, 100),
      pt: pt.value.trim() || null,
      colors: colors.value,
      typeLine: typeLine.value.trim().slice(0, 120),
      text: text.value.trim().slice(0, 500),
      fromCatalogId: fromCatalogId.value,
    },
    quantity: Math.max(1, Math.min(20, Math.round(quantity.value))),
    zone: zone.value,
    tapped: tapped.value,
  })
  open.value = false
}
</script>

<template>
  <UModal v-model:open="open" title="Create token" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <div class="space-y-3">
        <!-- suggestion chips -->
        <div v-if="suggestions.length || fromCard" class="flex flex-wrap gap-1.5">
          <UButton
            v-for="(spec, i) in suggestions"
            :key="i"
            size="xs"
            variant="soft"
            icon="i-lucide-sparkles"
            @click="applySpec(spec)"
          >
            {{ spec.name }}{{ spec.pt ? ` ${spec.pt}` : '' }}
          </UButton>
          <UButton v-if="fromCard?.display" size="xs" variant="soft" color="neutral" icon="i-lucide-copy" @click="applyCopy">
            Copy of {{ fromCard.display.name }}
          </UButton>
        </div>

        <div class="grid grid-cols-3 gap-2">
          <UFormField label="Name" class="col-span-2">
            <UInput v-model="name" placeholder="Goblin" maxlength="100" class="w-full" />
          </UFormField>
          <UFormField label="Quantity">
            <UInput v-model.number="quantity" type="number" min="1" max="20" class="w-full" />
          </UFormField>
        </div>

        <div class="grid grid-cols-3 gap-2 items-end">
          <UFormField label="Power/Toughness">
            <UInput v-model="pt" placeholder="1/1 (blank = none)" maxlength="16" class="w-full" />
          </UFormField>
          <UFormField label="Colors" class="col-span-2">
            <div class="flex gap-1">
              <button
                v-for="c in COLORS"
                :key="c.value"
                type="button"
                class="h-7 w-7 rounded-full text-xs font-bold"
                :class="[c.cls, colors.includes(c.value) ? 'ring-2 ring-primary' : 'opacity-40 hover:opacity-80']"
                @click="toggleColor(c.value)"
              >
                {{ c.label }}
              </button>
            </div>
          </UFormField>
        </div>

        <UFormField label="Type line">
          <UInput v-model="typeLine" placeholder="Token Creature — Goblin" maxlength="120" class="w-full" />
        </UFormField>
        <UFormField label="Text">
          <UTextarea v-model="text" :rows="2" maxlength="500" placeholder="Haste" class="w-full" />
        </UFormField>

        <div class="flex items-center gap-4">
          <UCheckbox v-model="tapped" label="Enters tapped" />
          <UFormField label="Zone" class="grow">
            <USelect
              v-model="zone"
              :items="[
                { label: 'Battlefield', value: 'battlefield' },
                { label: 'Stack', value: 'stack' },
              ]"
              value-key="value"
              class="w-full"
            />
          </UFormField>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" color="neutral" @click="() => { open = false }">Cancel</UButton>
        <UButton :disabled="!canCreate" @click="create">Create {{ quantity > 1 ? `×${quantity}` : '' }}</UButton>
      </div>
    </template>
  </UModal>
</template>
