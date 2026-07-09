<script setup lang="ts">
/**
 * Enforced-mode card: image from the display cache with a text fallback,
 * tapped rotation, damage badge, combat rings, affordance glow.
 */
import type { RulesClientCard } from '#shared/rules/types'
import type { RulesCardDisplay } from '~/stores/rulesGame'

const props = defineProps<{
  card: RulesClientCard
  display?: RulesCardDisplay | null
  /** clickable affordance (playable land / castable spell / selectable) */
  glow?: boolean
  /** currently toggled (attacker/blocker/discard selection) */
  selected?: boolean
  /** valid target while picking targets */
  targetable?: boolean
  /** this card is yours → offer the assisted-table manual-actions menu */
  manual?: boolean
  size?: 'sm' | 'md'
}>()

const emit = defineEmits<{ click: []; menu: [event: MouseEvent]; preview: [display: RulesCardDisplay | null] }>()

// hover-to-zoom: after a short dwell, ask the board to show the big preview
let hoverTimer: ReturnType<typeof setTimeout> | null = null
function onEnter() {
  if (!props.display) return
  hoverTimer = setTimeout(() => emit('preview', props.display ?? null), 450)
}
function onLeave() {
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = null
  emit('preview', null)
}
onBeforeUnmount(onLeave)

const imgFailed = ref(false)
const displayName = computed(() => props.display?.name ?? props.card.defName ?? 'Unknown card')
const src = computed(() => (imgFailed.value ? null : (props.display?.imageSmall ?? null)))
const counters = computed(() => Object.entries(props.card.counters ?? {}).filter(([, n]) => n > 0))

const KW_ABBR: Record<string, string> = {
  flying: 'F',
  reach: 'R',
  vigilance: 'V',
  haste: 'H',
  defender: 'D',
  menace: 'Me',
  trample: 'T',
  deathtouch: 'DT',
  lifelink: 'LL',
  'first strike': 'FS',
  'double strike': 'DS',
  indestructible: 'Ind',
  hexproof: 'Hex',
  flash: 'Fl',
}
// show the effective P/T only when a continuous effect (counter, anthem, pump)
// has changed it from the printed card
const ptBadge = computed(() => {
  const { power, toughness } = props.card
  if (power == null || toughness == null) return null
  const changed = String(power) !== (props.display?.power ?? '') || String(toughness) !== (props.display?.toughness ?? '')
  return changed ? `${power}/${toughness}` : null
})
// green when the effective body is at least the printed one, red when smaller
const buffed = computed(() => {
  const bp = Number(props.display?.power)
  const bt = Number(props.display?.toughness)
  if (Number.isNaN(bp) || Number.isNaN(bt)) return true
  return (props.card.power ?? 0) + (props.card.toughness ?? 0) >= bp + bt
})
const keywords = computed(() => props.card.keywords ?? [])
const kwCodes = computed(() => keywords.value.map((k) => KW_ABBR[k] ?? k))
const titleText = computed(() => {
  const base = props.card.unimplemented
    ? `${displayName.value} — not automated; run its rules with the manual menu`
    : displayName.value
  return keywords.value.length ? `${base} · ${keywords.value.join(', ')}` : base
})

function onMenu(e: MouseEvent) {
  if (!props.manual) return
  e.preventDefault()
  emit('menu', e)
}
</script>

<template>
  <button
    type="button"
    class="relative shrink-0 rounded-md transition-transform duration-150 focus:outline-none"
    :class="[
      size === 'sm' ? 'w-[4.5rem]' : 'w-24',
      card.tapped ? 'rotate-90' : '',
      card.summoningSick ? 'opacity-70' : '',
      glow ? 'ring-2 ring-primary shadow-lg shadow-primary/40 cursor-pointer' : '',
      selected ? 'ring-2 ring-amber-400' : '',
      targetable ? 'ring-2 ring-rose-400 cursor-crosshair' : '',
      !glow && !selected && !targetable && card.attackingDefender ? 'ring-2 ring-red-500' : '',
      !glow && !selected && !targetable && card.blockingAttackerId ? 'ring-2 ring-blue-500' : '',
      manual ? 'group' : '',
    ]"
    :title="titleText"
    @click="$emit('click')"
    @contextmenu="onMenu"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <img
      v-if="src"
      :src="src"
      :alt="displayName"
      class="w-full aspect-5/7 rounded-md object-cover select-none"
      draggable="false"
      @error="imgFailed = true"
    />
    <span
      v-else
      class="flex w-full aspect-5/7 items-center justify-center rounded-md border border-default bg-elevated p-1 text-center text-[10px] leading-tight break-words"
    >
      {{ displayName }}
    </span>

    <!-- unimplemented ("manual") marker: engine won't run this card's rules -->
    <span
      v-if="card.unimplemented"
      class="absolute left-0.5 top-0.5 rounded bg-amber-500/90 px-1 text-[8px] font-bold uppercase leading-tight text-black shadow"
      title="Not automated — run its rules manually"
    >M</span>

    <!-- +1/+1 and other counters -->
    <span
      v-if="counters.length"
      class="absolute -top-1 right-0 flex flex-col items-end gap-0.5"
    >
      <span
        v-for="[cname, n] in counters"
        :key="cname"
        class="rounded bg-emerald-600 px-1 text-[9px] font-bold text-white shadow"
        :title="`${cname} counters`"
      >{{ cname === '+1/+1' ? `+${n}/+${n}` : `${cname}×${n}` }}</span>
    </span>

    <!-- manual-actions trigger (owned cards) -->
    <span
      v-if="manual"
      class="absolute bottom-0.5 left-0.5 hidden size-4 cursor-pointer items-center justify-center rounded bg-black/70 text-white group-hover:flex"
      title="Manual actions"
      @click.stop="emit('menu', $event)"
    >
      <UIcon name="i-lucide-ellipsis" class="size-3" />
    </span>

    <!-- evergreen keyword badges (abbreviated; full names in the tooltip) -->
    <span
      v-if="kwCodes.length"
      class="absolute inset-x-0 bottom-0 flex flex-wrap justify-center gap-0.5 rounded-b-md bg-black/55 px-0.5 text-[7px] font-semibold leading-tight text-white"
    >
      <span v-for="c in kwCodes" :key="c">{{ c }}</span>
    </span>

    <!-- effective power/toughness when counters have changed it -->
    <span
      v-if="ptBadge"
      class="absolute bottom-0 right-0 rounded-tl rounded-br-md px-1 text-[9px] font-bold text-white shadow"
      :class="buffed ? 'bg-emerald-700' : 'bg-rose-700'"
      title="Current power / toughness"
    >{{ ptBadge }}</span>

    <!-- damage marked -->
    <span
      v-if="card.damageMarked > 0"
      class="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white shadow"
    >
      {{ card.damageMarked }}
    </span>

    <!-- combat indicators -->
    <span
      v-if="card.attackingDefender"
      class="absolute -top-1 -left-1 flex size-5 items-center justify-center rounded-full bg-red-600 text-white shadow"
      title="Attacking"
    >
      <UIcon name="i-lucide-swords" class="size-3" />
    </span>
    <span
      v-else-if="card.blockingAttackerId"
      class="absolute -top-1 -left-1 flex size-5 items-center justify-center rounded-full bg-blue-600 text-white shadow"
      title="Blocking"
    >
      <UIcon name="i-lucide-shield" class="size-3" />
    </span>
  </button>
</template>
