<script setup lang="ts">
/**
 * Enforced Commander board (client root for rules-engine games), 2–4 players.
 * Every affordance is driven by `state.legal` from the server — the client
 * never computes legality, it only collects clicks and sends r.* messages.
 *
 * Multiplayer: all opponents are shown; attackers are each assigned a defender
 * (click attacker → click an opponent panel; auto-assigns when there's only one
 * opponent). Command zones + commander tax + commander damage are rendered.
 */
import type { ManaColor, ObjId, PlayerId, RulesClientCard } from '#shared/rules/types'
import { shouldAutoPassPriority } from '#shared/rules/autopass'
// which picker resolves each targeted spell — shared so a unit test can assert full coverage
import {
  GRAVEYARD_SPELLS,
  MODAL_SPELLS,
  LIFE_X_SPELLS,
  MULTI_TARGET_SPELLS,
  TARGETED_SPELLS,
  type FightSlot,
  type TargetClass,
} from '#shared/rules/clientTargets'
import { parseManaCost, planPayment } from '#shared/utils/manaCost'
import { useGameStore } from '~/stores/game'
import { useRulesGameStore, type RulesCardDisplay } from '~/stores/rulesGame'

const props = defineProps<{ gameId: string }>()

const rules = useRulesGameStore()
const manualStore = useGameStore() // presence rides the shared transport
const { send } = useGameSocket(props.gameId)

onBeforeUnmount(() => rules.reset())

const st = computed(() => rules.state)
const you = computed(() => st.value?.you ?? '')
const me = computed(() => (st.value ? st.value.players[you.value] : null))
const legal = computed(() => st.value?.legal ?? null)
const display = computed(() => rules.display)

/** opponents in turn order starting after you (seating goes clockwise). */
const opponents = computed<PlayerId[]>(() => {
  const s = st.value
  if (!s) return []
  const i = s.turnOrder.indexOf(you.value)
  const rotated = [...s.turnOrder.slice(i + 1), ...s.turnOrder.slice(0, i)]
  return rotated.filter((p) => p !== you.value)
})

const cardOf = (id: ObjId): RulesClientCard | null => st.value?.cards[id] ?? null
const bf = (pid: PlayerId) => st.value?.zones.perPlayer[pid]?.battlefield ?? []
/** Battlefield split into two groups shown side by side: creatures on the left,
 *  everything else (lands, artifacts, enchantments…) on the right. Creature-ness
 *  is server-authoritative (power != null). */
function bfRow(pid: PlayerId, group: 'creature' | 'rest'): ObjId[] {
  return bf(pid).filter((id) => (cardOf(id)?.power != null) === (group === 'creature'))
}
const cmdZone = (pid: PlayerId) => st.value?.zones.perPlayer[pid]?.command ?? []
const myHandIds = computed<ObjId[]>(() => {
  const hand = st.value?.zones.perPlayer[you.value]?.hand
  return Array.isArray(hand) ? hand : []
})
const countOf = (pid: PlayerId, zone: 'hand' | 'library' | 'graveyard'): number => {
  const z = st.value?.zones.perPlayer[pid]
  if (!z) return 0
  if (zone === 'library') return z.library.count
  if (zone === 'hand') return Array.isArray(z.hand) ? z.hand.length : z.hand.count
  return z.graveyard.length
}
const connected = (pid: PlayerId) => manualStore.connectedPlayers.includes(pid)
const isActive = (pid: PlayerId) => st.value?.activePlayer === pid

/** commander-damage entries taken by a player: [{amount, name}] keyed by source commander. */
function cmdDamage(pid: PlayerId): { amount: number; name: string; lethal: boolean }[] {
  const dmg = st.value?.players[pid]?.commanderDamage ?? {}
  return Object.entries(dmg)
    .filter(([, n]) => n > 0)
    .map(([srcId, amount]) => ({
      amount,
      name: display.value[cardOf(srcId)?.defName ?? '']?.name ?? 'commander',
      lethal: amount >= 21,
    }))
}
const cmdTax = (pid: PlayerId) => st.value?.players[pid]?.commanderTax ?? 0

const POOL_COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G', 'C']

// ---------- interaction state ----------

/** which alternative cast is being paid for (extra r.cast flag / other zone / other action) */
type AltKind = 'flashback' | 'retrace' | 'escape' | 'evoke' | 'bestow' | 'adventure' | 'exile' | 'suspend' | 'overload' | 'freeCmd'

const targeting = ref<{ objId: ObjId; spec: TargetClass; mode?: number; alt?: AltKind; altCost?: string } | null>(null)
const attackAssign = ref<{ attackerId: ObjId; defenderId: PlayerId }[]>([])
const pendingAttacker = ref<ObjId | null>(null)
const selDiscard = ref<Set<ObjId>>(new Set())
// Brainstorm's put-back: an ORDERED pick from your own hand (first clicked ends up on top)
const selPutBack = ref<ObjId[]>([])
// equipment being equipped (awaiting a creature-you-control click) → r.equip
const equipping = ref<ObjId | null>(null)
// forced-sacrifice (edict) selection + sacrifice-as-cost (sac outlet) picker
const selSacrifice = ref<Set<ObjId>>(new Set())
const costSac = ref<{ objId: ObjId; abilityIndex: number; count: number } | null>(null)
// cast-time additional cost (Village Rites / Thrill of Possibility): the permanents to sacrifice
// and/or the cards to discard, collected before the mana payment panel opens
const castExtra = ref<{ card: RulesClientCard; targets: (ObjId | PlayerId)[]; sacrifice: number; sacFilter: 'creature' | 'artifactOrCreature'; discard: number; free: boolean } | null>(null)
const castExtraSacPick = ref<Set<ObjId>>(new Set())
const castExtraDiscardPick = ref<Set<ObjId>>(new Set())
const costSacPick = ref<Set<ObjId>>(new Set())
const blockPairs = ref<{ blockerId: ObjId; attackerId: ObjId }[]>([])
const pendingBlocker = ref<ObjId | null>(null)
// what the player is paying for (targets already chosen); no auto-tap. A spell
// cast (abilityIndex null) or an activated ability (abilityIndex set).
const casting = ref<{
  cardId: ObjId
  defName: string
  targets: (ObjId | PlayerId)[]
  abilityIndex: number | null
  costStr: string
  x: number // chosen X (0 when the card has no {X})
  xCount: number // number of {X} pips in the cost
  mode: number | null // chosen mode for a modal spell
  cycling?: boolean // paying a cycling cost (→ r.cycle) rather than casting
  kickerCost?: string // the spell's kicker cost, if it has one (enables the kick toggle)
  kicked?: boolean // whether the player chose to pay the kicker
  // alternative cast being paid for (extra r.cast flag / different zone / different action)
  alt?: AltKind
  escapeCount?: number // escape: how many other graveyard cards to exile as the cost
  lifeX?: boolean // X is paid in LIFE as an additional cost (Toxic Deluge) — stepper, no mana added
  extraPicks?: { sacrifices: ObjId[]; discards: ObjId[] } // cast-time sacrifice / discard picks
  buybackCost?: string // enables the buyback toggle
  buyback?: boolean // whether the player chose to pay buyback
} | null>(null)
// modal "choose one": pick a mode before targeting/payment
const modalPick = ref<{ card: RulesClientCard; modes: { label: string; spec: TargetClass | null }[] } | null>(null)
// planeswalker loyalty-ability picker
const loyaltyPick = ref<{ objId: ObjId; options: { abilityIndex: number; cost: number }[] } | null>(null)
// multi-target casting (fight): collect ordered targets, then pay
const multiTargeting = ref<{ objId: ObjId; slots: FightSlot[]; collected: ObjId[] } | null>(null)
// graveyard recursion (Raise Dead / Regrowth): pick a card from your graveyard, then pay
const graveyardTargeting = ref<{ objId: ObjId; creatureOnly: boolean } | null>(null)

watch(
  () => st.value?.seq,
  () => {
    const l = legal.value
    if (!l) return
    if (!l.needsAttackers) {
      attackAssign.value = []
      pendingAttacker.value = null
    }
    if (!l.needsBlockers) {
      blockPairs.value = []
      pendingBlocker.value = null
    }
    if (!l.needsDiscard) selDiscard.value = new Set()
    if (!l.needsPutBack) selPutBack.value = []
    if (!l.needsSacrifice) selSacrifice.value = new Set()
    if (equipping.value && !l.equippableIds.includes(equipping.value)) equipping.value = null
    // drop a stale cost-sacrifice picker if its ability is no longer available
    if (costSac.value && !l.activations.some((a) => a.objId === costSac.value!.objId && a.abilityIndex === costSac.value!.abilityIndex)) {
      costSac.value = null
      costSacPick.value = new Set()
    }
    if (targeting.value && !l.castableIds.includes(targeting.value.objId)) targeting.value = null
    if (modalPick.value && !l.castableIds.includes(modalPick.value.card.id)) modalPick.value = null
    if (loyaltyPick.value && !l.loyaltyActivations.some((a) => a.objId === loyaltyPick.value!.objId)) loyaltyPick.value = null
    if (multiTargeting.value && !l.castableIds.includes(multiTargeting.value.objId)) multiTargeting.value = null
    if (graveyardTargeting.value && !l.castableIds.includes(graveyardTargeting.value.objId)) graveyardTargeting.value = null
    // drop the payment prompt if the spell/ability is no longer available
    if (casting.value) {
      const c = casting.value
      const ok = c.cycling
        ? l.cyclable.some((cy) => cy.objId === c.cardId)
        : c.alt // alt-casts (flashback/evoke/bestow/…) aren't in castableIds; the server re-validates on confirm
          ? true
          : c.abilityIndex == null
            ? l.castableIds.includes(c.cardId)
            : l.activations.some((a) => a.objId === c.cardId && a.abilityIndex === c.abilityIndex)
      if (!ok) casting.value = null
    }
  },
)

// ---------- casting: explicit manual mana payment ----------
// (state hoisted above; the player taps their own sources, then confirms)

const castCost = computed(() => {
  const c = casting.value
  if (!c) return null
  const cost = parseManaCost(c.costStr)
  cost.generic += (c.x ?? 0) * (c.xCount ?? 0) // {X}: add the chosen X per {X} pip
  if (c.abilityIndex == null && cardOf(c.cardId)?.isCommander) cost.generic += 2 * cmdTax(you.value)
  if (c.kicked && c.kickerCost) {
    // kicker adds its mana to the total the player must pay
    const kc = parseManaCost(c.kickerCost)
    cost.generic += kc.generic
    for (const col of POOL_COLORS) cost.colored[col] += kc.colored[col]
  }
  if (c.buyback && c.buybackCost) {
    const bc = parseManaCost(c.buybackCost)
    cost.generic += bc.generic
    for (const col of POOL_COLORS) cost.colored[col] += bc.colored[col]
  }
  return cost
})
// displayed cost string — append the kicker's pips when the player has chosen to kick
const castManaCostStr = computed(() =>
  casting.value ? casting.value.costStr + (casting.value.kicked && casting.value.kickerCost ? casting.value.kickerCost : '') : '',
)
const castIsAbility = computed(() => casting.value?.abilityIndex != null)
const castCovered = computed(
  () => !!castCost.value && !!me.value && planPayment(castCost.value, me.value.manaPool).covered,
)

function beginPayment(card: RulesClientCard, targets: (ObjId | PlayerId)[], mode: number | null = null, alt?: AltKind, altCost?: string) {
  targeting.value = null
  // alt-cast pays its own cost (flashback/evoke/bestow/suspend/adventure/retrace); else the printed cost
  const costStr = altCost ?? display.value[card.defName ?? '']?.manaCost ?? ''
  casting.value = {
    cardId: card.id,
    defName: card.defName ?? '',
    targets,
    abilityIndex: null,
    costStr,
    x: 0,
    // {X} in the mana cost, or an X paid in LIFE as an additional cost (Toxic Deluge) — either way
    // the stepper is shown and `x` is sent; a life-X adds nothing to the mana cost (see castCost)
    xCount: alt ? 0 : (costStr.match(/\{X\}/g) ?? []).length,
    lifeX: !alt && (card.defName ?? '') in LIFE_X_SPELLS,
    mode,
    // kicker/buyback toggles are only for a normal cast (not alt-casts)
    kickerCost: alt ? undefined : legal.value?.kickable.find((k) => k.objId === card.id)?.cost,
    kicked: false,
    alt,
    buybackCost: alt ? undefined : legal.value?.buybackable.find((b) => b.objId === card.id)?.cost,
    buyback: false,
  }
}
/** toggle whether the current cast pays its kicker (recomputes the required cost). */
function toggleKicker() {
  if (casting.value?.kickerCost) casting.value.kicked = !casting.value.kicked
}
function beginActivatePayment(objId: ObjId, abilityIndex: number, cost: string, targets: (ObjId | PlayerId)[]) {
  activating.value = null
  casting.value = { cardId: objId, defName: cardOf(objId)?.defName ?? '', targets, abilityIndex, costStr: cost, x: 0, xCount: 0, mode: null }
}
function confirmCast() {
  const c = casting.value
  if (!c || !castCovered.value) return
  if (c.cycling) send({ type: 'r.cycle', objId: c.cardId })
  else if (c.alt === 'suspend') send({ type: 'r.suspend', objId: c.cardId })
  else if (c.abilityIndex == null)
    send({
      type: 'r.cast',
      objId: c.cardId,
      targets: c.targets as string[],
      x: c.xCount > 0 || c.lifeX ? c.x : undefined,
      mode: c.mode ?? undefined,
      kicked: c.kicked || undefined,
      buyback: c.buyback || undefined,
      // alt-cast flags the server reads (flashback/retrace/exile are auto-detected by zone,
      // so they need no flag — retrace only needs the land to discard)
      adventure: c.alt === 'adventure' || undefined,
      bestow: c.alt === 'bestow' || undefined,
      evoke: c.alt === 'evoke' || undefined,
      overload: c.alt === 'overload' || undefined,
      free: c.alt === 'freeCmd' || undefined,
      sacrifices: c.extraPicks?.sacrifices.length ? c.extraPicks.sacrifices : undefined,
      discards: c.extraPicks?.discards.length ? c.extraPicks.discards : undefined,
      retraceLand: c.alt === 'retrace' ? firstLandInHand() : undefined,
      escapeExile: c.alt === 'escape' ? firstNOtherInGraveyard(c.cardId, c.escapeCount ?? 0) : undefined,
    })
  else send({ type: 'r.activate', objId: c.cardId, abilityIndex: c.abilityIndex, targets: c.targets as string[] })
  casting.value = null
}
/** first land card in your hand — discarded as the retrace additional cost (CR 702.81). */
function firstLandInHand(): ObjId | undefined {
  const ids = st.value?.zones.perPlayer[you.value]?.hand ?? []
  return ids.find((id) => (display.value[cardOf(id)?.defName ?? '']?.typeLine ?? '').includes('Land'))
}
/** first N cards in your graveyard other than `exclude` — exiled as the escape cost (CR 702.139). */
function firstNOtherInGraveyard(exclude: ObjId, n: number): ObjId[] {
  const ids = (st.value?.zones.perPlayer[you.value]?.graveyard ?? []).filter((id) => id !== exclude)
  return ids.slice(0, n)
}
/** open the mana-payment panel for cycling a hand card (pays cyclingCost → r.cycle). */
function beginCyclePayment(objId: ObjId, cost: string) {
  targeting.value = null
  casting.value = { cardId: objId, defName: cardOf(objId)?.defName ?? '', targets: [], abilityIndex: null, costStr: cost, x: 0, xCount: 0, mode: null, cycling: true }
}
/** the cycling cost for a hand card if it can be cycled right now, else null. */
const cycleCost = (id: ObjId): string | null => legal.value?.cyclable.find((c) => c.objId === id)?.cost ?? null

// alternative-cast target class per card (the redacted client doesn't carry DSL target specs,
// so — like TARGETED_SPELLS — the alt-cast targets are curated by card name)
const ALT_TARGET_CLASS: Record<string, TargetClass> = {
  'fierce guardianship': 'spell', // free cast (commander) → still counters a noncreature spell
  'deadly rollick': 'creature', // free cast (commander) → still exiles a creature
  firebolt: 'any', // flashback → 2 damage to any target
  "raven's crime": 'player', // retrace → target player discards
  'murderous rider': 'creature', // adventure (Swift End) → destroy target creature
  'nyxborn rollicker': 'creature', // bestow → enchant a creature
}
function altTargetClass(kind: AltKind, name: string): TargetClass | null {
  if (kind === 'evoke' || kind === 'exile' || kind === 'suspend' || kind === 'escape') return null // no target
  return ALT_TARGET_CLASS[name.toLowerCase()] ?? null
}
/** begin an alternative cast (flashback / retrace / evoke / bestow / adventure / cast-from-exile /
 *  suspend): collect a target first if the face needs one, else open the payment panel directly. */
function beginAltCast(card: RulesClientCard, kind: AltKind, cost: string, escapeCount?: number) {
  modalPick.value = null
  multiTargeting.value = null
  graveyardTargeting.value = null
  const spec = altTargetClass(kind, card.defName ?? '')
  if (spec) targeting.value = { objId: card.id, spec, alt: kind, altCost: cost }
  else if (!(kind === 'freeCmd' && beginCastExtraCost(card, [], true))) {
    beginPayment(card, [], null, kind, cost)
    if (casting.value) casting.value.escapeCount = escapeCount
  }
}
/** toggle whether the current cast pays its buyback cost (CR 702.27). */
function toggleBuyback() {
  if (casting.value?.buybackCost) casting.value.buyback = !casting.value.buyback
}
/** lookups the board uses to render alt-cast buttons on cards. */
const flashbackCostOf = (id: ObjId): string | null => legal.value?.flashbackable.find((f) => f.objId === id)?.cost ?? null
const retraceCostOf = (id: ObjId): string | null => legal.value?.retraceable.find((f) => f.objId === id)?.cost ?? null
const escapeInfoOf = (id: ObjId) => legal.value?.escapable.find((f) => f.objId === id) ?? null
const evokeCostOf = (id: ObjId): string | null => legal.value?.evokable.find((f) => f.objId === id)?.cost ?? null
const bestowCostOf = (id: ObjId): string | null => legal.value?.bestowable.find((f) => f.objId === id)?.cost ?? null
const suspendCostOf = (id: ObjId): string | null => legal.value?.suspendable.find((f) => f.objId === id)?.cost ?? null
const overloadCostOf = (id: ObjId): string | null => legal.value?.overloadable.find((f) => f.objId === id)?.cost ?? null
const canCastFree = (id: ObjId): boolean => legal.value?.freeCastable.includes(id) ?? false
const adventureOf = (id: ObjId) => legal.value?.adventurable.find((f) => f.objId === id) ?? null
const canCastFromExile = (id: ObjId): boolean => legal.value?.castExileIds.includes(id) ?? false
/** graveyard cards with a flashback or retrace cast available right now (shown in a small strip). */
const gyAltIds = computed<ObjId[]>(() => {
  const fb = legal.value?.flashbackable.map((f) => f.objId) ?? []
  const rt = legal.value?.retraceable.map((f) => f.objId) ?? []
  const es = legal.value?.escapable.map((f) => f.objId) ?? []
  return [...new Set([...fb, ...rt, ...es])]
})
/** exiled adventurer cards whose creature side you can cast from exile right now. */
const exileAltIds = computed<ObjId[]>(() => legal.value?.castExileIds ?? [])
function cancelCast() {
  casting.value = null
}
/** step the chosen X up/down (clamped ≥ 0). */
function setX(delta: number) {
  if (casting.value) casting.value.x = Math.max(0, casting.value.x + delta)
}
const cancelModal = () => {
  modalPick.value = null
}
const cancelMultiTarget = () => {
  multiTargeting.value = null
}

function startCast(card: RulesClientCard) {
  const name = card.defName ?? ''
  const modes = MODAL_SPELLS[name]
  if (modes) return void (modalPick.value = { card, modes }) // pick a mode first
  const slots = MULTI_TARGET_SPELLS[name]
  if (slots) return void (multiTargeting.value = { objId: card.id, slots, collected: [] }) // fight: 2 targets
  const gy = GRAVEYARD_SPELLS[name]
  if (gy) return void (graveyardTargeting.value = { objId: card.id, creatureOnly: gy === 'creature' }) // pick a card from your graveyard
  const spec = TARGETED_SPELLS[name]
  if (spec) targeting.value = { objId: card.id, spec }
  else if (!beginCastExtraCost(card, [])) beginPayment(card, [])
}
/** cards in your own graveyard eligible for the active recursion spell. */
const graveyardTargets = computed<ObjId[]>(() => {
  const gt = graveyardTargeting.value
  if (!gt || !st.value) return []
  const ids = st.value.zones.perPlayer[you.value]?.graveyard ?? []
  if (!gt.creatureOnly) return ids
  return ids.filter((id) => (display.value[cardOf(id)?.defName ?? '']?.typeLine ?? '').includes('Creature'))
})
/** the player picked a graveyard card → move to payment with it as the target. */
function pickGraveyardTarget(id: ObjId) {
  const gt = graveyardTargeting.value
  if (!gt) return
  const card = cardOf(gt.objId)
  graveyardTargeting.value = null
  if (card) beginPayment(card, [id])
}
const cancelGraveyardTarget = () => {
  graveyardTargeting.value = null
}
/** while collecting fight targets, does `id` fit the current slot (your/opponent creature)? */
function matchesFightSlot(id: ObjId, slot: FightSlot | undefined): boolean {
  if (!slot) return false
  const card = cardOf(id)
  if (!card || card.zone !== 'battlefield') return false
  if (!(display.value[card.defName ?? '']?.typeLine ?? '').includes('Creature')) return false
  return slot === 'your-creature' ? card.controllerId === you.value : card.controllerId !== you.value
}
const isFightTarget = (id: ObjId) =>
  !!multiTargeting.value && matchesFightSlot(id, multiTargeting.value.slots[multiTargeting.value.collected.length])
/** modal: the player picked mode `i` → target for that mode (if any), else pay. */
function pickMode(i: number) {
  const mp = modalPick.value
  if (!mp) return
  const m = mp.modes[i]
  const card = mp.card
  modalPick.value = null
  if (m?.spec) targeting.value = { objId: card.id, spec: m.spec, mode: i }
  else beginPayment(card, [], i)
}

// planeswalker loyalty abilities (the current pool has only non-targeted ones)
function startLoyalty(id: ObjId) {
  const opts = legal.value?.loyaltyActivations.filter((l) => l.objId === id) ?? []
  if (opts.length) loyaltyPick.value = { objId: id, options: opts.map((o) => ({ abilityIndex: o.abilityIndex, cost: o.cost })) }
}
function pickLoyalty(abilityIndex: number) {
  const lp = loyaltyPick.value
  if (!lp) return
  send({ type: 'r.loyalty', objId: lp.objId, abilityIndex, targets: [] })
  loyaltyPick.value = null
}
const loyaltyLabel = (cost: number) => (cost >= 0 ? `+${cost}` : `${cost}`)
const cancelLoyalty = () => {
  loyaltyPick.value = null
}

// ---------- click routing ----------

function onHandClick(id: ObjId) {
  // mulligan bottoming: pick which cards go to the bottom of the library
  if (st.value?.status === 'mulligans') {
    if (!bottomingActive.value) return
    const next = new Set(bottoming.value)
    if (next.has(id)) next.delete(id)
    else if (next.size < mullNeed.value) next.add(id)
    bottoming.value = next
    return
  }
  const card = cardOf(id)
  const l = legal.value
  if (!card || !l) return
  if (castExtra.value?.discard) {
    const next = new Set(castExtraDiscardPick.value)
    if (next.has(id)) next.delete(id)
    else if (id !== castExtra.value.card.id && next.size < castExtra.value.discard) next.add(id)
    castExtraDiscardPick.value = next
    return
  }
  if (l.needsPutBack) {
    const i = selPutBack.value.indexOf(id)
    if (i >= 0) selPutBack.value = selPutBack.value.filter((x) => x !== id)
    else if (selPutBack.value.length < l.putBackCount) selPutBack.value = [...selPutBack.value, id]
    return
  }
  if (l.needsDiscard) {
    const next = new Set(selDiscard.value)
    if (next.has(id)) next.delete(id)
    else if (next.size < l.discardCount) next.add(id)
    selDiscard.value = next
    return
  }
  if (targeting.value || casting.value) return
  if (l.playableLandIds.includes(id)) return void send({ type: 'r.playLand', objId: id })
  if (l.castableIds.includes(id)) startCast(card)
}

/** command-zone click: cast your own commander when the server says you can. */
function onCommandClick(id: ObjId) {
  const card = cardOf(id)
  if (card && legal.value?.castableIds.includes(id)) startCast(card)
}

function onBattlefieldClick(id: ObjId) {
  const card = cardOf(id)
  const l = legal.value
  if (!card || !l || !st.value) return

  // collecting a cast-time sacrifice (Village Rites / Deadly Dispute) takes precedence
  if (castExtra.value?.sacrifice) return void toggleCastExtraSac(id)

  if (multiTargeting.value) {
    // collect the ordered fight targets; when both are chosen, move to payment
    const mt = multiTargeting.value
    if (isFightTarget(id) && !mt.collected.includes(id)) {
      mt.collected.push(id)
      if (mt.collected.length === mt.slots.length) {
        beginPayment(cardOf(mt.objId)!, [...mt.collected])
        multiTargeting.value = null
      }
    }
    return
  }
  if (equipping.value) {
    // click one of your creatures to attach the equipment to it
    if (isEquipTargetCreature(id)) {
      send({ type: 'r.equip', equipmentId: equipping.value, creatureId: id })
      equipping.value = null
    }
    return
  }
  if (activating.value) {
    if (isActivateTargetCard(id)) sendActivate(id)
    return
  }
  if (l.needsTriggerTargets) {
    if (isTriggerTargetCard(id)) send({ type: 'r.chooseTargets', targets: [id] })
    return
  }
  if (l.needsCascade) {
    // clicking a legal target free-casts the cascade hit at it
    if (isCascadeTargetCard(id)) sendCascade(true, [id])
    return
  }
  if (targeting.value) {
    if (isValidTarget(id)) beginPayment(cardOf(targeting.value.objId)!, [id], targeting.value.mode ?? null, targeting.value.alt, targeting.value.altCost)
    return
  }
  if (l.needsAttackers && l.declarableAttackerIds.includes(id)) {
    const idx = attackAssign.value.findIndex((a) => a.attackerId === id)
    if (idx >= 0) {
      attackAssign.value.splice(idx, 1) // un-declare
      return
    }
    // exactly one opponent and no attackable planeswalkers → auto-assign; otherwise
    // wait for a defender pick (a player HUD or an opponent's planeswalker)
    if (opponents.value.length === 1 && !l.attackablePlaneswalkerIds.length)
      attackAssign.value.push({ attackerId: id, defenderId: opponents.value[0]! })
    else pendingAttacker.value = pendingAttacker.value === id ? null : id
    return
  }
  // assign a pending attacker to an opponent's planeswalker
  if (l.needsAttackers && pendingAttacker.value && l.attackablePlaneswalkerIds.includes(id)) {
    attackAssign.value.push({ attackerId: pendingAttacker.value, defenderId: id })
    pendingAttacker.value = null
    return
  }
  if (l.needsBlockers) {
    if (l.declarableBlockerIds.includes(id)) {
      const idx = blockPairs.value.findIndex((p) => p.blockerId === id)
      if (idx >= 0) blockPairs.value.splice(idx, 1)
      else pendingBlocker.value = pendingBlocker.value === id ? null : id
      return
    }
    if (pendingBlocker.value && card.attackingDefender === you.value) {
      blockPairs.value.push({ blockerId: pendingBlocker.value, attackerId: id })
      pendingBlocker.value = null
      return
    }
    return
  }
  if (l.manaSourceIds.includes(id)) return void tapManaSource(id)
  // click your planeswalker with an available loyalty ability → pick one
  if (l.loyaltyActivations.some((a) => a.objId === id)) return void startLoyalty(id)
  // start equipping: click your Equipment, then a creature you control
  if (l.equippableIds.includes(id)) return void (equipping.value = id)
}

const cancelEquip = () => {
  equipping.value = null
}

/** badge for an attached Aura/Equipment: "→ Host" (so attachments are legible). */
const attachBadge = (id: ObjId): string | null => {
  const c = cardOf(id)
  return c?.attachedTo ? `→ ${nameOf(c.attachedTo)}` : null
}

/** while equipping, is `id` a creature the player controls (a legal attach target)? */
function isEquipTargetCreature(id: ObjId): boolean {
  const card = cardOf(id)
  if (!card || card.zone !== 'battlefield' || card.controllerId !== you.value) return false
  return (display.value[card.defName ?? '']?.typeLine ?? '').includes('Creature')
}

/** clicking an opponent panel: assign a pending attacker's defender, or a spell/trigger target. */
function onOpponentClick(pid: PlayerId) {
  const l = legal.value
  if (l?.needsAttackers && pendingAttacker.value) {
    attackAssign.value.push({ attackerId: pendingAttacker.value, defenderId: pid })
    pendingAttacker.value = null
    return
  }
  if (canActivateTargetPlayer.value) return void sendActivate(pid)
  if (canTargetPlayerForTrigger.value) return void send({ type: 'r.chooseTargets', targets: [pid] })
  if (canCascadeTargetPlayer.value) return void sendCascade(true, [pid])
  if (targetingPlayerOk.value) beginPayment(cardOf(targeting.value!.objId)!, [pid], targeting.value!.mode ?? null, targeting.value!.alt, targeting.value!.altCost)
}

/** clicking a spell on the stack while casting a counter (targeting.spec === 'spell'). */
function onStackTarget(stackId: ObjId) {
  if (targeting.value?.spec === 'spell') beginPayment(cardOf(targeting.value.objId)!, [stackId], targeting.value.mode ?? null, targeting.value.alt, targeting.value.altCost)
}

function onSelfClick() {
  if (canActivateTargetPlayer.value) return void sendActivate(you.value)
  if (canTargetPlayerForTrigger.value) return void send({ type: 'r.chooseTargets', targets: [you.value] })
  if (canCascadeTargetPlayer.value) return void sendCascade(true, [you.value])
  if (targetingPlayerOk.value) beginPayment(cardOf(targeting.value!.objId)!, [you.value], targeting.value!.mode ?? null, targeting.value!.alt, targeting.value!.altCost)
}

function isValidTarget(id: ObjId): boolean {
  if (!targeting.value) return false
  const card = cardOf(id)
  if (!card || card.zone !== 'battlefield') return false
  // 'player' targets are clicked via the HUD, never a card on the battlefield
  if (targeting.value.spec === 'player') return false
  // 'permanent' targets any permanent on the battlefield; 'creature'/'any' need a creature
  if (targeting.value.spec === 'permanent') return true
  return (display.value[card.defName ?? '']?.typeLine ?? '').includes('Creature')
}
/** a player HUD click is a legal spell target ('creature or player' or 'player'). */
const targetingPlayerOk = computed(() => targeting.value?.spec === 'any' || targeting.value?.spec === 'player')

// ---------- triggered-ability target selection ----------
const canTargetPlayerForTrigger = computed(
  () => !!legal.value?.needsTriggerTargets && (legal.value.triggerTargetKind === 'player' || legal.value.triggerTargetKind === 'anyTarget'),
)
function isTriggerTargetCard(id: ObjId): boolean {
  const l = legal.value
  if (!l?.needsTriggerTargets) return false
  const card = cardOf(id)
  if (!card || card.zone !== 'battlefield') return false
  // 'permanent' → any battlefield permanent (server enforces the type filter);
  // 'creature'/'anyTarget' → a creature. (mirrors isValidTarget for spell targets)
  if (l.triggerTargetKind === 'permanent') return true
  if (l.triggerTargetKind !== 'creature' && l.triggerTargetKind !== 'anyTarget') return false
  return (display.value[card.defName ?? '']?.typeLine ?? '').includes('Creature')
}

// ---------- cascade (CR 702.85): cast the revealed hit for free, choosing its target ----------
/** send the cascade decision (cast the free hit with `targets`, or decline). */
function sendCascade(cast: boolean, targets: (ObjId | PlayerId)[] = []) {
  send({ type: 'r.cascade', cast, targets: targets as string[] })
}
/** true if `id` is a legal battlefield target for the cascade hit's single target. */
function isCascadeTargetCard(id: ObjId): boolean {
  const l = legal.value
  if (!l?.needsCascade) return false
  const card = cardOf(id)
  if (!card || card.zone !== 'battlefield') return false
  if (l.cascadeTargetKind === 'permanent') return true
  if (l.cascadeTargetKind !== 'creature' && l.cascadeTargetKind !== 'anyTarget') return false
  return (display.value[card.defName ?? '']?.typeLine ?? '').includes('Creature')
}
/** true if a player-HUD click is a legal target for the cascade hit. */
const canCascadeTargetPlayer = computed(
  () => !!legal.value?.needsCascade && (legal.value.cascadeTargetKind === 'player' || legal.value.cascadeTargetKind === 'anyTarget'),
)

// ---------- activated abilities ----------
type Activation = {
  objId: ObjId
  abilityIndex: number
  targetKind: 'creature' | 'permanent' | 'player' | 'anyTarget' | 'spell' | null
  cost: string
  sacCost: number
  lifeCost: number
}
const activating = ref<Activation | null>(null)
const extraCostOf = (id: ObjId) => legal.value?.castExtraCost.find((c) => c.objId === id) ?? null
/** open the additional-cost picker; returns false when the card needs none */
function beginCastExtraCost(card: RulesClientCard, targets: (ObjId | PlayerId)[], free = false): boolean {
  const ec = extraCostOf(card.id)
  if (!ec || (!ec.sacrifice && !ec.discard)) return false
  castExtra.value = { card, targets, sacrifice: ec.sacrifice, sacFilter: ec.sacFilter, discard: ec.discard, free }
  castExtraSacPick.value = new Set()
  castExtraDiscardPick.value = new Set()
  return true
}
function cancelCastExtra() {
  castExtra.value = null
  castExtraSacPick.value = new Set()
  castExtraDiscardPick.value = new Set()
}
const castExtraReady = computed(
  () =>
    !!castExtra.value &&
    castExtraSacPick.value.size === castExtra.value.sacrifice &&
    castExtraDiscardPick.value.size === castExtra.value.discard,
)
/** picks collected → carry on into the normal payment panel, remembering them */
function confirmCastExtra() {
  const c = castExtra.value
  if (!c || !castExtraReady.value) return
  const picks = { sacrifices: [...castExtraSacPick.value], discards: [...castExtraDiscardPick.value] }
  cancelCastExtra()
  beginPayment(c.card, c.targets, null, c.free ? 'freeCmd' : undefined, c.free ? '' : undefined)
  if (casting.value) casting.value.extraPicks = picks
}

const activationFor = (id: ObjId): Activation | null => legal.value?.activations.find((a) => a.objId === id) ?? null
function startActivate(id: ObjId) {
  const a = activationFor(id)
  if (!a) return
  closeMenu()
  if (a.targetKind) return void (activating.value = a) // pick a target first
  // a "sacrifice a creature" cost: pick which creature(s) to sacrifice, then activate
  if (a.sacCost > 0) return void beginCostSacrifice(id, a.abilityIndex, a.sacCost)
  if (a.cost) beginActivatePayment(id, a.abilityIndex, a.cost, []) // pay the mana cost manually
  else send({ type: 'r.activate', objId: id, abilityIndex: a.abilityIndex, targets: [] })
}
const canActivateTargetPlayer = computed(
  () => !!activating.value && (activating.value.targetKind === 'player' || activating.value.targetKind === 'anyTarget'),
)
function isActivateTargetCard(id: ObjId): boolean {
  const a = activating.value
  if (!a) return false
  const card = cardOf(id)
  if (!card || card.zone !== 'battlefield') return false
  if (a.targetKind === 'permanent') return true // any battlefield permanent (server enforces the filter)
  if (a.targetKind !== 'creature' && a.targetKind !== 'anyTarget') return false
  return (display.value[card.defName ?? '']?.typeLine ?? '').includes('Creature')
}
function sendActivate(target: ObjId | PlayerId) {
  const a = activating.value
  if (!a) return
  if (a.cost) beginActivatePayment(a.objId, a.abilityIndex, a.cost, [target]) // pay first
  else {
    send({ type: 'r.activate', objId: a.objId, abilityIndex: a.abilityIndex, targets: [target] })
    activating.value = null
  }
}

const attackerTargetName = (id: ObjId) => {
  const a = attackAssign.value.find((x) => x.attackerId === id)
  if (!a) return null
  // defender is a player, or an opponent's planeswalker
  return st.value?.players[a.defenderId]?.name ?? nameOf(a.defenderId)
}
/** while declaring attackers with a pending attacker, is `id` a legal planeswalker target? */
const isAttackTargetPw = (id: ObjId) =>
  !!legal.value?.needsAttackers && !!pendingAttacker.value && (legal.value.attackablePlaneswalkerIds?.includes(id) ?? false)

// ---------- confirms ----------

function confirmAttackers() {
  send({ type: 'r.attackers', attacks: [...attackAssign.value] })
}
function confirmBlockers() {
  send({ type: 'r.blockers', blocks: [...blockPairs.value] })
}
function confirmDiscard() {
  send({ type: 'r.discard', objIds: [...selDiscard.value] })
}

const confirmingConcede = ref(false)
let concedeTimer: ReturnType<typeof setTimeout> | null = null
function onConcede() {
  if (!confirmingConcede.value) {
    confirmingConcede.value = true
    concedeTimer = setTimeout(() => (confirmingConcede.value = false), 4000)
    return
  }
  if (concedeTimer) clearTimeout(concedeTimer)
  confirmingConcede.value = false
  send({ type: 'r.concede' })
}

const passLabel = computed(() => (st.value && st.value.zones.stack.length > 0 ? 'Pass (resolve stack)' : 'Pass'))
const nameOf = (id: ObjId) => display.value[cardOf(id)?.defName ?? '']?.name ?? '?'
const winnerName = computed(() => (st.value?.winner ? (st.value.players[st.value.winner]?.name ?? '?') : null))
const myCommanderId = computed(() => me.value?.commanderId ?? null)

// ---------- assisted-table manual overrides ----------
// Cockatrice-style manual controls for effects the engine doesn't automate.
// The server accepts these any time the game is active and only on your OWN
// objects; the client just collects intent and sends r.m* messages.
type ManualZone = 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command' | 'library'
const MENU_ZONES: { label: string; zone: ManualZone; pos?: 'top' | 'bottom' }[] = [
  { label: 'Battlefield', zone: 'battlefield' },
  { label: 'Hand', zone: 'hand' },
  { label: 'Graveyard', zone: 'graveyard' },
  { label: 'Exile', zone: 'exile' },
  { label: 'Command zone', zone: 'command' },
  { label: 'Library (top)', zone: 'library', pos: 'top' },
  { label: 'Library (bottom)', zone: 'library', pos: 'bottom' },
]

const isMine = (id: ObjId): boolean => {
  const c = cardOf(id)
  return !!c && (c.ownerId === you.value || c.controllerId === you.value)
}

// hover-to-zoom preview (set by any card after a short dwell)
const hoverDisplay = ref<RulesCardDisplay | null>(null)

// ---------- mulligan phase (London) ----------
const bottoming = ref<Set<ObjId>>(new Set())
const bottomingActive = ref(false)
const mullNeed = computed(() => me.value?.mullCount ?? 0)
function doMulligan() {
  send({ type: 'r.mulligan' })
  bottomingActive.value = false
  bottoming.value = new Set()
}
function startKeep() {
  if (mullNeed.value === 0) return void send({ type: 'r.keep', toBottom: [] })
  bottoming.value = new Set()
  bottomingActive.value = true
}
function confirmKeep() {
  send({ type: 'r.keep', toBottom: [...bottoming.value] })
  bottomingActive.value = false
  bottoming.value = new Set()
}

/** ward (CR 702.21): pay the ward cost to save your spell/ability, or decline (it's countered). */
function sendWard(pay: boolean) {
  send({ type: 'r.ward', pay })
}
function sendOptionalPay(pay: boolean) {
  send({ type: 'r.optionalPay', pay })
}
function sendEntersChoice(pay: boolean) {
  send({ type: 'r.entersChoice', pay })
}

const menu = ref<{ x: number; y: number; id: ObjId } | null>(null)
const menuCard = computed(() => (menu.value ? cardOf(menu.value.id) : null))
function openMenu(e: MouseEvent, id: ObjId) {
  if (!isMine(id)) return
  // keep the menu on-screen-ish (it's small); clamp to the viewport width
  menu.value = { x: Math.min(e.clientX, window.innerWidth - 176), y: e.clientY, id }
}
const closeMenu = () => (menu.value = null)
function moveMenuCard(zone: ManualZone, pos?: 'top' | 'bottom') {
  if (menu.value) send(pos ? { type: 'r.mMove', objId: menu.value.id, zone, pos } : { type: 'r.mMove', objId: menu.value.id, zone })
  closeMenu()
}
function toggleTapMenuCard() {
  if (menuCard.value && menu.value) send({ type: 'r.mTap', objId: menu.value.id, tapped: !menuCard.value.tapped })
  closeMenu()
}
function counterMenuCard(delta: number) {
  if (menu.value) send({ type: 'r.mCounter', objId: menu.value.id, name: '+1/+1', delta })
  closeMenu()
}

// scry: pick which of the peeked top-N cards go to the bottom
const scryBottom = ref<Set<ObjId>>(new Set())
function toggleScry(id: ObjId) {
  const next = new Set(scryBottom.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  scryBottom.value = next
}
function confirmScry() {
  send({ type: 'r.scry', toBottom: [...scryBottom.value] })
  scryBottom.value = new Set()
}
watch(
  () => st.value?.scry,
  (s) => {
    if (!s) scryBottom.value = new Set()
  },
)

// library search (tutor / ramp): pick up to `count` of the revealed matches
const searchPick = ref<Set<ObjId>>(new Set())
function toggleSearch(id: ObjId) {
  const next = new Set(searchPick.value)
  if (next.has(id)) next.delete(id)
  else if (next.size < (st.value?.search?.count ?? 1)) next.add(id)
  searchPick.value = next
}
function confirmSearch() {
  send({ type: 'r.search', cardIds: [...searchPick.value] })
  searchPick.value = new Set()
}
watch(
  () => st.value?.search,
  (s) => {
    if (!s) searchPick.value = new Set()
  },
)

// forced sacrifice (edict): pick creatures you control to sacrifice
function toggleSacrifice(id: ObjId) {
  const next = new Set(selSacrifice.value)
  if (next.has(id)) next.delete(id)
  else if (next.size < (legal.value?.sacrificeCount ?? 1)) next.add(id)
  selSacrifice.value = next
}
function confirmSacrifice() {
  if (selSacrifice.value.size !== (legal.value?.sacrificeCount ?? 0)) return
  send({ type: 'r.sacrifice', objIds: [...selSacrifice.value] })
  selSacrifice.value = new Set()
}

// sacrifice-as-cost (aristocrat sac outlets): pick creatures to pay, then activate
function beginCostSacrifice(objId: ObjId, abilityIndex: number, count: number) {
  costSac.value = { objId, abilityIndex, count }
  costSacPick.value = new Set()
}
function toggleCastExtraSac(id: ObjId) {
  const c = castExtra.value
  if (!c?.sacrifice) return
  const card = cardOf(id)
  if (!card || card.zone !== 'battlefield' || card.controllerId !== you.value) return
  const line = display.value[card.defName ?? '']?.typeLine ?? ''
  const ok = c.sacFilter === 'creature' ? line.includes('Creature') : line.includes('Creature') || line.includes('Artifact')
  if (!ok) return
  const next = new Set(castExtraSacPick.value)
  if (next.has(id)) next.delete(id)
  else if (next.size < c.sacrifice) next.add(id)
  castExtraSacPick.value = next
}
function toggleCostSac(id: ObjId) {
  const next = new Set(costSacPick.value)
  if (next.has(id)) next.delete(id)
  else if (next.size < (costSac.value?.count ?? 1)) next.add(id)
  costSacPick.value = next
}
function confirmCostSacrifice() {
  const c = costSac.value
  if (!c || costSacPick.value.size !== c.count) return
  send({ type: 'r.activate', objId: c.objId, abilityIndex: c.abilityIndex, targets: [], sacrifices: [...costSacPick.value] })
  costSac.value = null
  costSacPick.value = new Set()
}
function cancelCostSacrifice() {
  costSac.value = null
  costSacPick.value = new Set()
}
/** creatures the player controls, for the sac pickers (candidate list is public). */
const myCreatureIds = computed(() =>
  (st.value ? st.value.zones.perPlayer[you.value]?.battlefield ?? [] : []).filter((id) => {
    const c = st.value?.cards[id]
    return !!c && (display.value[c.defName ?? '']?.typeLine ?? '').includes('Creature')
  }),
)

// dual-land colour picker (multi-colour mana sources)
const manaPick = ref<{ objId: ObjId; colors: ManaColor[] } | null>(null)
function tapManaSource(id: ObjId) {
  const colors = legal.value?.manaSourceColors[id] ?? []
  if (colors.length > 1) manaPick.value = { objId: id, colors }
  else send({ type: 'r.tapMana', objId: id })
}
function pickMana(color: ManaColor) {
  if (manaPick.value) send({ type: 'r.tapMana', objId: manaPick.value.objId, color })
  manaPick.value = null
}

const manualOpen = ref(false)
const life = (delta: number) => {
  send({ type: 'r.mLife', delta })
}
const mana = (color: ManaColor, delta: number) => {
  send({ type: 'r.mMana', color, delta })
}
const drawN = ref(1)
const draw = () => {
  send({ type: 'r.mDraw', n: Math.max(1, Math.min(50, Math.floor(drawN.value) || 1)) })
}
const drawOne = () => {
  send({ type: 'r.mDraw', n: 1 })
}
const toggleManual = () => {
  manualOpen.value = !manualOpen.value
}
const token = ref({ name: '', power: 1, toughness: 1, typeLine: '' })
function makeToken() {
  const t = token.value
  if (!t.name.trim()) return
  send({
    type: 'r.mToken',
    name: t.name.trim().slice(0, 80),
    power: Math.max(0, Math.min(99, Math.floor(t.power) || 0)),
    toughness: Math.max(0, Math.min(99, Math.floor(t.toughness) || 0)),
    typeLine: t.typeLine.trim() ? t.typeLine.trim().slice(0, 120) : undefined,
  })
  token.value = { name: '', power: 1, toughness: 1, typeLine: '' }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu()
}

// ---------- auto-pass priority (during other players' turns) ----------
// On by default (persisted). On another player's turn, passes priority for you
// so you don't click through every step — but stops if you hold an instant you
// could cast in response. On your OWN turn it never fires: you stay in control.
const autoPass = ref(true)
let autoPassTimer: ReturnType<typeof setTimeout> | null = null
const clearAutoPassTimer = () => {
  if (autoPassTimer) clearTimeout(autoPassTimer)
  autoPassTimer = null
}
function shouldAutoPass(): boolean {
  const s = st.value
  return shouldAutoPassPriority({
    enabled: autoPass.value,
    active: s?.status === 'active',
    legal: legal.value,
    activePlayer: s?.activePlayer ?? '',
    you: you.value,
    targeting: !!targeting.value,
  })
}
function scheduleAutoPass() {
  clearAutoPassTimer()
  if (!shouldAutoPass()) return
  autoPassTimer = setTimeout(() => {
    autoPassTimer = null
    if (shouldAutoPass()) send({ type: 'r.pass' }) // re-check: state may have moved on
  }, 300)
}
// re-evaluate on every server state push and whenever the toggle flips
watch(() => st.value?.seq, scheduleAutoPass, { flush: 'post' })
watch(autoPass, (v) => {
  if (import.meta.client) localStorage.setItem('arpenteurs:autoPass', v ? '1' : '0')
  scheduleAutoPass()
})

// "Pass turn": blow through the rest of YOUR turn — auto-declares no attacks/
// blocks and passes every priority window, step by step, until the turn actually
// moves to the next player. Stays engaged while waiting for opponents' priority
// (auto-pass-others advances them). Stops and hands control back only for a
// forced choice it can't make for you: discard-to-hand-size, a trigger target,
// or an open scry.
const yieldTurn = ref(false)
let yieldTimer: ReturnType<typeof setTimeout> | null = null
function scheduleYield() {
  if (yieldTimer) {
    clearTimeout(yieldTimer)
    yieldTimer = null
  }
  if (!yieldTurn.value) return
  const s = st.value
  const l = legal.value
  if (!s || s.status !== 'active' || !l) return void (yieldTurn.value = false)
  if (s.activePlayer !== you.value) return void (yieldTurn.value = false) // turn has moved on → done
  // forced choices we can't safely auto-make → hand control back to the player
  if (targeting.value || casting.value || costSac.value || equipping.value || modalPick.value || loyaltyPick.value || multiTargeting.value || graveyardTargeting.value || l.needsDiscard || l.needsPutBack || l.needsSacrifice || l.needsWard || l.needsOptionalPay || l.needsEntersChoice || l.needsCascade || l.needsTriggerTargets || s.scry || s.search)
    return void (yieldTurn.value = false)
  yieldTimer = setTimeout(() => {
    yieldTimer = null
    if (!yieldTurn.value) return
    const ll = legal.value
    const ss = st.value
    if (!ll || !ss || ss.activePlayer !== you.value) return void (yieldTurn.value = false)
    if (ll.needsAttackers) send({ type: 'r.attackers', attacks: [] }) // skip your combat
    else if (ll.needsBlockers) send({ type: 'r.blockers', blocks: [] })
    else if (ll.hasPriority && ll.canPass) send({ type: 'r.pass' })
    // otherwise: waiting on opponents' priority — stay engaged; the next state re-runs this
  }, 120)
}
function passTurn() {
  yieldTurn.value = true
  scheduleYield()
}
const togglePassTurn = () => void (yieldTurn.value ? (yieldTurn.value = false) : passTurn())
watch(() => st.value?.seq, scheduleYield, { flush: 'post' })

// ---------- combat & targeting arrows ----------
// SVG overlay drawing attacker→defender (red) and blocker→attacker (blue) arrows,
// plus dashed arrows for in-progress declarations and the live targeting line.
// Endpoints are resolved from [data-arrow] elements' screen rects, recomputed on
// every state push / resize / scroll.
const boardEl = ref<HTMLElement | null>(null)
const arrowTick = ref(0)
const bumpArrows = () => arrowTick.value++
const hoverTargetId = ref<ObjId | PlayerId | null>(null)
const setHover = (t: ObjId | PlayerId) => void (hoverTargetId.value = t)
const clearHover = () => void (hoverTargetId.value = null)

interface ArrowSpec {
  from: string
  to: string
  color: string
  dashed?: boolean
}
const arrowSpecs = computed<ArrowSpec[]>(() => {
  const s = st.value
  if (!s) return []
  const out: ArrowSpec[] = []
  for (const c of Object.values(s.cards)) {
    // an attack on a planeswalker points at the PW card, not the defending player
    if (c.attackingPwId) out.push({ from: `card:${c.id}`, to: `card:${c.attackingPwId}`, color: '#f43f5e' })
    else if (c.attackingDefender) out.push({ from: `card:${c.id}`, to: `player:${c.attackingDefender}`, color: '#f43f5e' })
    if (c.blockingAttackerId) out.push({ from: `card:${c.id}`, to: `card:${c.blockingAttackerId}`, color: '#3b82f6' })
  }
  for (const a of attackAssign.value) {
    // defenderId is a player id or an opponent's planeswalker (a card)
    const to = st.value?.players[a.defenderId] ? `player:${a.defenderId}` : `card:${a.defenderId}`
    out.push({ from: `card:${a.attackerId}`, to, color: '#f43f5e', dashed: true })
  }
  for (const p of blockPairs.value) out.push({ from: `card:${p.blockerId}`, to: `card:${p.attackerId}`, color: '#3b82f6', dashed: true })
  // live targeting line from the source spell/ability to the hovered target
  const src = targeting.value?.objId ?? activating.value?.objId ?? null
  if (src && hoverTargetId.value) {
    const toKey = st.value?.players[hoverTargetId.value as PlayerId] ? `player:${hoverTargetId.value}` : `card:${hoverTargetId.value}`
    out.push({ from: `card:${src}`, to: toKey, color: '#f59e0b', dashed: true })
  }
  return out
})
const arrowGeom = computed(() => {
  void arrowTick.value // dependency: recompute after layout changes
  const root = boardEl.value
  const empty: { x1: number; y1: number; x2: number; y2: number; color: string; dashed: boolean }[] = []
  if (!root) return empty
  const o = root.getBoundingClientRect()
  const center = (sel: string) => {
    const el = root.querySelector(`[data-arrow="${sel}"]`) as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2 - o.left, y: r.top + r.height / 2 - o.top }
  }
  const out = empty
  for (const spec of arrowSpecs.value) {
    const a = center(spec.from)
    const b = center(spec.to)
    if (a && b && (a.x !== b.x || a.y !== b.y)) out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: spec.color, dashed: !!spec.dashed })
  }
  return out
})
watch([() => st.value?.seq, arrowSpecs], () => nextTick(bumpArrows), { flush: 'post' })
let boardResizeObs: ResizeObserver | null = null

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', bumpArrows)
  window.addEventListener('scroll', bumpArrows, true) // capture: catches inner scroll containers
  if (boardEl.value) {
    boardResizeObs = new ResizeObserver(bumpArrows)
    boardResizeObs.observe(boardEl.value)
  }
  nextTick(bumpArrows)
  const saved = localStorage.getItem('arpenteurs:autoPass')
  if (saved != null) autoPass.value = saved === '1'
  scheduleAutoPass()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', bumpArrows)
  window.removeEventListener('scroll', bumpArrows, true)
  boardResizeObs?.disconnect()
  clearAutoPassTimer()
  if (yieldTimer) clearTimeout(yieldTimer)
})
</script>

<template>
  <div class="fixed inset-0 flex flex-col bg-default text-sm">
    <div v-if="!st || !me" class="flex flex-1 items-center justify-center text-dimmed">
      Connecting to the game…
    </div>

    <template v-else>
      <RulesPhaseRibbon
        :step="st.step"
        :turn-number="st.turnNumber"
        :active-name="st.players[st.activePlayer]?.name ?? '?'"
        :priority-name="st.priorityPlayer ? (st.players[st.priorityPlayer]?.name ?? null) : null"
        :my-priority="st.priorityPlayer === you"
      />

      <div class="flex min-h-0 flex-1">
        <div ref="boardEl" class="relative flex min-w-0 flex-1 flex-col">
          <!-- combat / targeting arrows overlay -->
          <svg class="pointer-events-none absolute inset-0 z-30 h-full w-full overflow-visible">
            <defs>
              <marker id="arrowHead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto-start-reverse">
                <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
              </marker>
            </defs>
            <line
              v-for="(l, i) in arrowGeom"
              :key="i"
              :x1="l.x1"
              :y1="l.y1"
              :x2="l.x2"
              :y2="l.y2"
              :stroke="l.color"
              stroke-width="2.5"
              :stroke-dasharray="l.dashed ? '7 5' : ''"
              marker-end="url(#arrowHead)"
              opacity="0.9"
            />
          </svg>
          <!-- opponents -->
          <div class="flex flex-wrap items-stretch gap-2 border-b border-default bg-elevated/30 px-3 py-2">
            <div
              v-for="pid in opponents"
              :key="pid"
              class="flex min-w-0 flex-1 basis-64 flex-col rounded-lg border p-2"
              :class="[
                isActive(pid) ? 'border-primary/60 bg-primary/5' : 'border-default',
                st.players[pid].hasLost ? 'opacity-40 grayscale' : '',
              ]"
            >
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="flex items-center gap-2 rounded px-1"
                  :data-arrow="`player:${pid}`"
                  :class="(legal?.needsAttackers && pendingAttacker) || targetingPlayerOk || canTargetPlayerForTrigger || canCascadeTargetPlayer || canActivateTargetPlayer
                    ? 'ring-2 ring-rose-400 cursor-crosshair'
                    : 'cursor-default'"
                  @click="onOpponentClick(pid)"
                  @mouseenter="setHover(pid)"
                  @mouseleave="clearHover()"
                >
                  <span class="text-2xl font-bold tabular-nums">{{ st.players[pid].life }}</span>
                  <span v-if="st.players[pid].poison" class="text-xs font-semibold text-green-500" title="Poison counters (10 = loss)">☠ {{ st.players[pid].poison }}</span>
                  <span class="flex items-center gap-1 text-xs text-dimmed">
                    {{ st.players[pid].name }}
                    <span
                      class="inline-block size-1.5 rounded-full"
                      :class="connected(pid) ? 'bg-success' : 'bg-neutral-500'"
                    />
                  </span>
                </button>
                <div class="ml-auto flex gap-2 text-[11px] text-dimmed">
                  <span title="Hand">✋ {{ countOf(pid, 'hand') }}</span>
                  <span title="Library">📚 {{ countOf(pid, 'library') }}</span>
                  <span title="Graveyard">⚰ {{ countOf(pid, 'graveyard') }}</span>
                </div>
              </div>
              <!-- commander damage taken -->
              <div v-if="cmdDamage(pid).length" class="mt-0.5 flex flex-wrap gap-1 text-[10px]">
                <span
                  v-for="(d, i) in cmdDamage(pid)"
                  :key="i"
                  class="rounded px-1"
                  :class="d.lethal ? 'bg-error/20 text-error font-bold' : 'bg-elevated text-dimmed'"
                  :title="`commander damage from ${d.name}`"
                >⚔ {{ d.amount }}</span>
              </div>
              <!-- command zone + battlefield: commander | creatures | rest, side by side -->
              <div class="mt-1 flex flex-wrap items-start gap-x-5 gap-y-1">
                <div v-if="cmdZone(pid).length" class="flex flex-wrap gap-1">
                  <RulesCard
                    v-for="id in cmdZone(pid)"
                    :key="id"
                    :card="st.cards[id]!"
                    :display="display[st.cards[id]!.defName ?? '']"
                    size="sm"
                    class="ring-1 ring-amber-500/50 rounded"
                    :title="`${st.players[pid].name}'s commander · tax +${2 * cmdTax(pid)}`"
                    @preview="hoverDisplay = $event"
                  />
                </div>
                <template v-for="grp in (['creature', 'rest'] as const)" :key="grp">
                  <div v-if="bfRow(pid, grp).length" class="flex flex-wrap gap-1">
                    <RulesCard
                      v-for="id in bfRow(pid, grp)"
                      :key="id"
                      :card="st.cards[id]!"
                      :display="display[st.cards[id]!.defName ?? '']"
                      :targetable="(!!targeting && isValidTarget(id)) || isTriggerTargetCard(id) || isCascadeTargetCard(id) || isActivateTargetCard(id) || isAttackTargetPw(id) || isFightTarget(id)"
                      :data-arrow="`card:${id}`"
                      size="sm"
                      @click="onBattlefieldClick(id)"
                      @preview="hoverDisplay = $event"
                      @mouseenter="setHover(id)"
                      @mouseleave="clearHover()"
                    />
                  </div>
                </template>
              </div>
            </div>
          </div>

          <!-- center: banners + stack -->
          <div class="relative flex flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-4 py-2">
            <div v-if="st.status === 'mulligans'" class="rounded-lg border border-amber-400 bg-amber-500/10 px-3 py-1.5 text-sm font-medium">
              <template v-if="me.keptHand">Hand kept — waiting for the other players…</template>
              <template v-else>Mulligan phase — keep your opening hand or mulligan for a new seven.</template>
            </div>
            <div v-if="multiTargeting" class="rounded-lg border border-rose-400 bg-rose-500/10 px-3 py-1.5 text-xs font-medium">
              Casting {{ nameOf(multiTargeting.objId) }} —
              {{ multiTargeting.slots[multiTargeting.collected.length] === 'your-creature' ? 'pick YOUR creature' : "pick an OPPONENT's creature" }}
              ({{ multiTargeting.collected.length }}/{{ multiTargeting.slots.length }})
              <UButton size="xs" variant="ghost" color="neutral" class="ml-2" @click="cancelMultiTarget">Cancel</UButton>
            </div>
            <div v-if="targeting" class="rounded-lg border border-rose-400 bg-rose-500/10 px-3 py-1.5 text-xs font-medium">
              Casting {{ nameOf(targeting.objId) }} — select a target
              ({{ targeting.spec === 'any' ? 'creature or player' : targeting.spec === 'player' ? 'a player' : targeting.spec === 'spell' ? 'a spell on the stack' : targeting.spec === 'permanent' ? 'any permanent' : 'creature' }})
              <UButton size="xs" variant="ghost" color="neutral" class="ml-2" @click="targeting = null">Cancel</UButton>
            </div>
            <!-- mana payment: tap your own sources to pay, then Cast -->
            <div v-if="casting" class="flex flex-wrap items-center gap-2 rounded-lg border border-primary bg-primary/10 px-3 py-1.5 text-xs font-medium">
              <span class="flex items-center gap-1">
                Paying for <b>{{ nameOf(casting.cardId) }}</b>
                <ManaSymbols v-if="castManaCostStr" :value="castManaCostStr" :size="13" />
                <span v-else>(free)</span>
                — tap your mana sources.
              </span>
              <span class="flex items-center gap-1">
                pool:
                <template v-for="c in POOL_COLORS" :key="c">
                  <span v-if="(me?.manaPool[c] ?? 0) > 0" class="flex items-center gap-0.5 rounded-full border border-default bg-elevated px-1.5 py-0.5">
                    <ManaSymbols :value="`{${c}}`" :size="12" />×{{ me?.manaPool[c] }}
                  </span>
                </template>
                <span v-if="POOL_COLORS.every((c) => (me?.manaPool[c] ?? 0) === 0)" class="text-dimmed">empty</span>
              </span>
              <span v-if="casting.xCount > 0 || casting.lifeX" class="flex items-center gap-1">
                {{ casting.lifeX ? 'X life =' : 'X =' }}
                <UButton size="xs" variant="soft" icon="i-lucide-minus" :disabled="casting.x <= 0" @click="setX(-1)" />
                <b class="tabular-nums">{{ casting.x }}</b>
                <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="setX(1)" />
              </span>
              <UButton
                v-if="casting.kickerCost"
                size="xs"
                :variant="casting.kicked ? 'solid' : 'soft'"
                :color="casting.kicked ? 'primary' : 'neutral'"
                icon="i-lucide-zap"
                @click="toggleKicker"
              >
                <span class="flex items-center gap-0.5">Kicker <ManaSymbols :value="casting.kickerCost" :size="12" /></span>
              </UButton>
              <UButton
                v-if="casting.buybackCost"
                size="xs"
                :variant="casting.buyback ? 'solid' : 'soft'"
                :color="casting.buyback ? 'primary' : 'neutral'"
                icon="i-lucide-rotate-ccw"
                @click="toggleBuyback"
              >
                <span class="flex items-center gap-0.5">Buyback <ManaSymbols :value="casting.buybackCost" :size="12" /></span>
              </UButton>
              <UButton size="xs" icon="i-lucide-sparkles" :disabled="!castCovered" @click="confirmCast">{{ casting.cycling ? 'Cycle' : casting.alt === 'suspend' ? 'Suspend' : castIsAbility ? 'Activate' : 'Cast' }}</UButton>
              <UButton size="xs" variant="ghost" color="neutral" @click="cancelCast">Cancel</UButton>
            </div>
            <div v-if="legal?.needsAttackers" class="rounded-lg border border-red-400 bg-red-500/10 px-3 py-1.5 text-xs font-medium">
              Declare attackers — click a creature{{ opponents.length > 1 ? ', then an opponent to attack' : '' }}
              <span v-if="pendingAttacker"> · {{ nameOf(pendingAttacker) }} → pick a target…</span>
              <span v-for="(a, i) in attackAssign" :key="i" class="ml-2 text-dimmed">
                {{ nameOf(a.attackerId) }} → {{ st.players[a.defenderId]?.name }}
              </span>
            </div>
            <div v-if="legal?.needsTriggerTargets" class="rounded-lg border border-fuchsia-400 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium">
              {{ legal.triggerSourceName }} — choose a target
              ({{ legal.triggerTargetKind === 'creature' ? 'creature' : legal.triggerTargetKind === 'permanent' ? 'permanent' : legal.triggerTargetKind === 'player' ? 'player' : 'creature or player' }})
            </div>
            <div v-if="legal?.needsCascade" class="flex items-center gap-2 rounded-lg border border-violet-400 bg-violet-500/10 px-3 py-1.5 text-xs font-medium">
              <span>Cascade — cast <b>{{ legal.cascadeHitId ? nameOf(legal.cascadeHitId) : '' }}</b> for free?</span>
              <span v-if="legal.cascadeTargetKind" class="text-dimmed">click a {{ legal.cascadeTargetKind === 'permanent' ? 'permanent' : legal.cascadeTargetKind === 'player' ? 'player' : 'creature or player' }} target</span>
              <UButton v-else-if="legal.cascadeCanFreeCast" size="xs" icon="i-lucide-sparkles" @click="sendCascade(true)">Cast free</UButton>
              <span v-else class="text-dimmed">(can't free-cast this here — decline)</span>
              <UButton size="xs" variant="ghost" color="neutral" @click="sendCascade(false)">Decline</UButton>
            </div>
            <div v-if="activating" class="rounded-lg border border-rose-400 bg-rose-500/10 px-3 py-1.5 text-xs font-medium">
              Activating {{ nameOf(activating.objId) }} — choose a target
              ({{ activating.targetKind === 'creature' ? 'creature' : activating.targetKind === 'permanent' ? 'permanent' : activating.targetKind === 'player' ? 'player' : 'creature or player' }})
              <UButton size="xs" variant="ghost" color="neutral" class="ml-2" @click="activating = null">Cancel</UButton>
            </div>
            <div v-if="equipping" class="rounded-lg border border-amber-400 bg-amber-500/10 px-3 py-1.5 text-xs font-medium">
              Equipping {{ nameOf(equipping) }} — click one of your creatures
              <UButton size="xs" variant="ghost" color="neutral" class="ml-2" @click="cancelEquip">Cancel</UButton>
            </div>
            <div v-if="legal?.needsBlockers" class="rounded-lg border border-blue-400 bg-blue-500/10 px-3 py-1.5 text-xs font-medium">
              Declare blockers — click a blocker, then the attacker it blocks
              <span v-if="pendingBlocker"> · {{ nameOf(pendingBlocker) }} blocks…</span>
              <span v-for="(p, i) in blockPairs" :key="i" class="ml-2 text-dimmed">{{ nameOf(p.blockerId) }} → {{ nameOf(p.attackerId) }}</span>
            </div>
            <div v-if="legal?.needsDiscard" class="rounded-lg border border-amber-400 bg-amber-500/10 px-3 py-1.5 text-xs font-medium">
              Discard down to 7 — select {{ legal.discardCount }} ({{ selDiscard.size }}/{{ legal.discardCount }})
            </div>
            <div v-if="legal?.needsSacrifice" class="rounded-lg border border-rose-400 bg-rose-500/10 px-3 py-1.5 text-xs font-medium">
              You must sacrifice {{ legal.sacrificeCount }} creature{{ legal.sacrificeCount === 1 ? '' : 's' }} — choose in the panel.
            </div>
            <RulesStackPanel
              v-if="st.zones.stack.length"
              :stack="st.zones.stack"
              :display="display"
              :players="st.players"
              :targetable-ids="targeting?.spec === 'spell' ? st.zones.stack.filter((s) => s.kind === 'spell').map((s) => s.id) : []"
              @pick="onStackTarget"
            />
          </div>

          <!-- my row -->
          <div class="border-t border-default bg-elevated/30 px-4 py-2">
            <div class="flex items-center gap-4">
              <button
                type="button"
                class="flex flex-col items-center rounded-lg px-3 py-1"
                :data-arrow="`player:${you}`"
                :class="targetingPlayerOk || canTargetPlayerForTrigger || canCascadeTargetPlayer || canActivateTargetPlayer ? 'ring-2 ring-rose-400 cursor-crosshair' : 'cursor-default'"
                @click="onSelfClick"
                @mouseenter="setHover(you)"
                @mouseleave="clearHover()"
              >
                <span class="text-3xl font-bold tabular-nums">{{ me.life }}</span>
                <span v-if="me.poison" class="text-xs font-semibold text-green-500" title="Poison counters (10 = loss)">☠ {{ me.poison }}</span>
                <span class="text-xs text-dimmed">{{ me.name }} (you)</span>
                <div v-if="cmdDamage(you).length" class="flex gap-1 text-[10px]">
                  <span
                    v-for="(d, i) in cmdDamage(you)"
                    :key="i"
                    class="rounded px-1"
                    :class="d.lethal ? 'bg-error/20 text-error font-bold' : 'bg-elevated text-dimmed'"
                    :title="`commander damage from ${d.name}`"
                  >⚔ {{ d.amount }}</span>
                </div>
              </button>
              <div class="flex gap-3 text-xs text-dimmed">
                <span title="Library">📚 {{ countOf(you, 'library') }}</span>
                <span title="Graveyard">⚰ {{ countOf(you, 'graveyard') }}</span>
              </div>
              <!-- your command zone -->
              <div v-if="cmdZone(you).length" class="flex gap-1">
                <RulesCard
                  v-for="id in cmdZone(you)"
                  :key="id"
                  :card="st.cards[id]!"
                  :display="display[st.cards[id]!.defName ?? '']"
                  :glow="false"
                  manual
                  size="sm"
                  class="ring-1 ring-amber-500/60 rounded"
                  :title="`Your commander · tax +${2 * cmdTax(you)}`"
                  @click="onCommandClick(id)"
                  @menu="openMenu($event, id)"
                  @preview="hoverDisplay = $event"
                />
              </div>
              <!-- mana pool -->
              <div class="flex items-center gap-1 text-xs">
                <template v-for="c in POOL_COLORS" :key="c">
                  <span v-if="me.manaPool[c] > 0" class="flex items-center gap-0.5 rounded-full border border-default bg-elevated px-1.5 py-0.5 font-semibold">
                    <ManaSymbols :value="`{${c}}`" :size="13" />×{{ me.manaPool[c] }}
                  </span>
                </template>
              </div>
              <!-- your battlefield: creatures | rest, side by side -->
              <div class="flex min-w-0 flex-1 flex-wrap items-start gap-x-5 gap-y-1 py-1">
                <template v-for="grp in (['creature', 'rest'] as const)" :key="grp">
                  <div v-if="bfRow(you, grp).length" class="flex flex-wrap gap-1">
                    <RulesCard
                      v-for="id in bfRow(you, grp)"
                      :key="id"
                      :card="st.cards[id]!"
                      :display="display[st.cards[id]!.defName ?? '']"
                      :glow="!targeting && !equipping && !!legal && (legal.declarableAttackerIds.includes(id) || legal.declarableBlockerIds.includes(id) || legal.equippableIds.includes(id) || legal.loyaltyActivations.some((a) => a.objId === id))"
                      :selected="attackAssign.some((a) => a.attackerId === id) || pendingAttacker === id || pendingBlocker === id || blockPairs.some((p) => p.blockerId === id)"
                      :targetable="(!!targeting && isValidTarget(id)) || isTriggerTargetCard(id) || isCascadeTargetCard(id) || isActivateTargetCard(id) || (!!equipping && isEquipTargetCreature(id)) || isFightTarget(id)"
                      :badge="attackerTargetName(id) ?? attachBadge(id)"
                      :data-arrow="`card:${id}`"
                      manual
                      size="sm"
                      @click="onBattlefieldClick(id)"
                      @menu="openMenu($event, id)"
                      @mouseenter="setHover(id)"
                      @mouseleave="clearHover()"
                      @preview="hoverDisplay = $event"
                    />
                  </div>
                </template>
                <span v-if="!bf(you).length" class="text-xs text-dimmed">No permanents</span>
              </div>
            </div>

            <!-- casts available from your graveyard / exile (flashback, retrace, adventure creature) -->
            <div v-if="gyAltIds.length || exileAltIds.length" class="mt-2 flex flex-wrap items-end gap-2">
              <span class="self-center text-[10px] uppercase tracking-wide text-dimmed">From graveyard / exile</span>
              <div v-for="id in gyAltIds" :key="`gy${id}`" class="flex flex-col items-center gap-1">
                <RulesCard :card="st.cards[id]!" :display="display[st.cards[id]!.defName ?? '']" size="sm" @preview="hoverDisplay = $event" />
                <UButton
                  v-if="flashbackCostOf(id)"
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  @click.stop="beginAltCast(cardOf(id)!, 'flashback', flashbackCostOf(id)!)"
                >Flashback {{ flashbackCostOf(id) }}</UButton>
                <UButton
                  v-if="retraceCostOf(id)"
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  @click.stop="beginAltCast(cardOf(id)!, 'retrace', retraceCostOf(id)!)"
                >Retrace {{ retraceCostOf(id) }}</UButton>
                <UButton
                  v-if="escapeInfoOf(id)"
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  @click.stop="beginAltCast(cardOf(id)!, 'escape', escapeInfoOf(id)!.cost, escapeInfoOf(id)!.exileCount)"
                >Escape {{ escapeInfoOf(id)!.cost }}</UButton>
              </div>
              <div v-for="id in exileAltIds" :key="`ex${id}`" class="flex flex-col items-center gap-1">
                <RulesCard :card="st.cards[id]!" :display="display[st.cards[id]!.defName ?? '']" size="sm" @preview="hoverDisplay = $event" />
                <UButton
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  @click.stop="beginAltCast(cardOf(id)!, 'exile', display[cardOf(id)?.defName ?? '']?.manaCost ?? '')"
                >Cast {{ display[cardOf(id)?.defName ?? '']?.manaCost }}</UButton>
              </div>
            </div>

            <div class="mt-2 flex flex-wrap gap-2">
              <div v-for="id in myHandIds" :key="id" class="flex flex-col items-center gap-1">
                <RulesCard
                  :card="st.cards[id]!"
                  :display="display[st.cards[id]!.defName ?? '']"
                  :glow="bottomingActive || (!!legal && (legal.needsDiscard || legal.needsPutBack))"
                  :selected="selDiscard.has(id) || bottoming.has(id) || selPutBack.includes(id) || castExtraDiscardPick.has(id)"
                  manual
                  @click="onHandClick(id)"
                  @menu="openMenu($event, id)"
                  @preview="hoverDisplay = $event"
                />
                <UButton
                  v-if="cycleCost(id)"
                  size="xs"
                  variant="soft"
                  color="neutral"
                  class="px-1.5 py-0 text-[10px]"
                  icon="i-lucide-recycle"
                  @click.stop="beginCyclePayment(id, cycleCost(id)!)"
                >
                  Cycle {{ cycleCost(id) }}
                </UButton>
                <!-- alternative casts (evoke / bestow / suspend / adventure) — the server offers these -->
                <UButton
                  v-if="evokeCostOf(id)"
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  @click.stop="beginAltCast(cardOf(id)!, 'evoke', evokeCostOf(id)!)"
                >Evoke {{ evokeCostOf(id) }}</UButton>
                <UButton
                  v-if="bestowCostOf(id)"
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  @click.stop="beginAltCast(cardOf(id)!, 'bestow', bestowCostOf(id)!)"
                >Bestow {{ bestowCostOf(id) }}</UButton>
                <UButton
                  v-if="canCastFree(id)"
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  icon="i-lucide-crown"
                  @click.stop="beginAltCast(cardOf(id)!, 'freeCmd', '')"
                >Cast free</UButton>
                <UButton
                  v-if="overloadCostOf(id)"
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  icon="i-lucide-waves"
                  @click.stop="beginAltCast(cardOf(id)!, 'overload', overloadCostOf(id)!)"
                >Overload {{ overloadCostOf(id) }}</UButton>
                <UButton
                  v-if="suspendCostOf(id)"
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  icon="i-lucide-hourglass"
                  @click.stop="beginAltCast(cardOf(id)!, 'suspend', suspendCostOf(id)!)"
                >Suspend {{ suspendCostOf(id) }}</UButton>
                <UButton
                  v-if="adventureOf(id)"
                  size="xs" variant="soft" color="neutral" class="px-1.5 py-0 text-[10px]"
                  @click.stop="beginAltCast(cardOf(id)!, 'adventure', adventureOf(id)!.cost)"
                >{{ adventureOf(id)!.name }} {{ adventureOf(id)!.cost }}</UButton>
              </div>
              <span v-if="!myHandIds.length" class="self-center text-xs text-dimmed">Empty hand</span>
            </div>
          </div>

          <!-- assisted-table manual controls (life / mana / draw / token) -->
          <div v-if="manualOpen" class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-default bg-elevated/40 px-4 py-2 text-xs">
            <div class="flex items-center gap-1">
              <span class="font-semibold text-dimmed">Life</span>
              <UButton size="xs" variant="soft" color="error" @click="life(-5)">−5</UButton>
              <UButton size="xs" variant="soft" color="error" @click="life(-1)">−1</UButton>
              <UButton size="xs" variant="soft" color="success" @click="life(1)">+1</UButton>
              <UButton size="xs" variant="soft" color="success" @click="life(5)">+5</UButton>
            </div>
            <div class="flex items-center gap-2">
              <span class="font-semibold text-dimmed">Mana</span>
              <div v-for="c in POOL_COLORS" :key="c" class="flex items-center gap-0.5">
                <button type="button" class="rounded bg-elevated px-1 leading-none hover:bg-elevated/60" @click="mana(c, -1)">−</button>
                <span class="w-3 text-center font-semibold">{{ c }}</span>
                <button type="button" class="rounded bg-elevated px-1 leading-none hover:bg-elevated/60" @click="mana(c, 1)">+</button>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <span class="font-semibold text-dimmed">Draw</span>
              <UButton size="xs" variant="soft" @click="drawOne">1</UButton>
              <input v-model.number="drawN" type="number" min="1" max="50" class="w-12 rounded border border-default bg-default px-1 py-0.5" >
              <UButton size="xs" variant="soft" @click="draw">Draw N</UButton>
            </div>
            <div class="flex items-center gap-1">
              <span class="font-semibold text-dimmed">Token</span>
              <input v-model="token.name" placeholder="name" class="w-24 rounded border border-default bg-default px-1 py-0.5" >
              <input v-model.number="token.power" type="number" class="w-9 rounded border border-default bg-default px-1 py-0.5" title="power" >
              <span>/</span>
              <input v-model.number="token.toughness" type="number" class="w-9 rounded border border-default bg-default px-1 py-0.5" title="toughness" >
              <input v-model="token.typeLine" placeholder="type line (optional)" class="w-40 rounded border border-default bg-default px-1 py-0.5" >
              <UButton size="xs" variant="soft" :disabled="!token.name.trim()" @click="makeToken">Create</UButton>
            </div>
            <span class="ml-auto text-[10px] text-dimmed">Right-click your cards to move / tap / add counters</span>
          </div>

          <!-- action bar -->
          <div class="flex items-center gap-2 border-t border-default bg-elevated/60 px-4 py-2">
            <!-- mulligan controls -->
            <template v-if="st.status === 'mulligans'">
              <template v-if="me.keptHand">
                <span class="text-sm font-medium text-warning">Hand kept — waiting for the other players…</span>
              </template>
              <template v-else-if="bottomingActive">
                <span class="text-xs font-medium">
                  Select {{ mullNeed }} card{{ mullNeed > 1 ? 's' : '' }} to put on the bottom ({{ bottoming.size }}/{{ mullNeed }})
                </span>
                <UButton size="sm" variant="ghost" color="neutral" @click="bottomingActive = false">Back</UButton>
                <UButton size="sm" :disabled="bottoming.size !== mullNeed" icon="i-lucide-check" @click="confirmKeep">
                  Bottom {{ mullNeed }} &amp; keep
                </UButton>
              </template>
              <template v-else>
                <span class="text-sm font-medium text-warning">Mulligan phase{{ me.mullCount ? ` — mulligan #${me.mullCount}` : '' }}</span>
                <UButton size="sm" variant="soft" color="warning" icon="i-lucide-refresh-ccw" @click="doMulligan">Mulligan</UButton>
                <UButton size="sm" icon="i-lucide-check" @click="startKeep">
                  Keep{{ me.mullCount ? ` (bottom ${me.mullCount})` : '' }}
                </UButton>
              </template>
            </template>

            <!-- normal turn controls -->
            <template v-else>
              <UButton v-if="legal?.needsAttackers" color="error" icon="i-lucide-swords" @click="confirmAttackers">
                {{ attackAssign.length ? `Attack with ${attackAssign.length}` : 'No attacks' }}
              </UButton>
              <UButton v-else-if="legal?.needsBlockers" color="info" icon="i-lucide-shield" @click="confirmBlockers">
                {{ blockPairs.length ? `Confirm ${blockPairs.length} block${blockPairs.length > 1 ? 's' : ''}` : 'No blocks' }}
              </UButton>
              <UButton
                v-else-if="legal?.needsPutBack"
                color="primary"
                :disabled="selPutBack.length !== legal.putBackCount"
                @click="send({ type: 'r.putBack', objIds: selPutBack })"
              >
                Put back {{ selPutBack.length }}/{{ legal.putBackCount }} (first = top)
              </UButton>
              <UButton v-else-if="legal?.needsDiscard" color="warning" :disabled="selDiscard.size !== legal.discardCount" @click="confirmDiscard">
                Discard {{ selDiscard.size }}/{{ legal.discardCount }}
              </UButton>
              <UButton v-else :disabled="!legal?.canPass" :color="st.priorityPlayer === you ? 'primary' : 'neutral'" @click="send({ type: 'r.pass' })">
                {{ passLabel }}
              </UButton>

              <!-- blow through the rest of your turn; click again to stop -->
              <UButton
                v-if="st.activePlayer === you && (yieldTurn || (legal?.canPass && st.priorityPlayer === you && !legal.needsDiscard))"
                variant="soft"
                :color="yieldTurn ? 'warning' : 'neutral'"
                icon="i-lucide-chevrons-right"
                @click="togglePassTurn"
              >
                {{ yieldTurn ? 'Passing…' : 'Pass turn' }}
              </UButton>

              <span v-if="st.priorityPlayer === you" class="animate-pulse text-xs font-medium text-primary">Your priority</span>
              <span v-else-if="st.priorityPlayer" class="text-xs text-dimmed">Waiting for {{ st.players[st.priorityPlayer]?.name ?? '…' }}…</span>

              <label
                class="flex cursor-pointer select-none items-center gap-1.5 text-xs text-dimmed"
                title="On other players' turns, pass priority automatically — but stop if you hold an instant you could cast. Never fires on your own turn."
              >
                <input v-model="autoPass" type="checkbox" class="size-3.5 accent-primary" >
                Auto-pass others' turns
              </label>
            </template>

            <div class="ml-auto flex items-center gap-2">
              <UButton
                v-if="st.status === 'active'"
                size="sm"
                :color="manualOpen ? 'primary' : 'neutral'"
                :variant="manualOpen ? 'solid' : 'soft'"
                icon="i-lucide-wrench"
                title="Manual controls for effects the engine doesn't automate"
                @click="toggleManual"
              >
                Manual
              </UButton>
              <UButton
                size="sm"
                :color="confirmingConcede ? 'error' : 'neutral'"
                :variant="confirmingConcede ? 'solid' : 'soft'"
                icon="i-lucide-flag"
                @click="onConcede"
              >
                {{ confirmingConcede ? 'Click again to concede' : 'Concede' }}
              </UButton>
            </div>
          </div>
        </div>

        <RulesLogPanel :lines="st.log" class="hidden sm:flex" />
      </div>

      <RulesCardPreview :display="hoverDisplay" />

      <!-- modal "choose one": pick a mode before targeting/payment -->
      <div v-if="modalPick" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click="cancelModal">
        <div class="rounded-lg border border-primary bg-default p-4 shadow-xl" @click.stop>
          <p class="mb-2 text-sm font-semibold">{{ nameOf(modalPick.card.id) }} — choose one</p>
          <div class="flex flex-col gap-2">
            <UButton
              v-for="(m, i) in modalPick.modes"
              :key="i"
              size="sm"
              variant="soft"
              class="justify-start"
              @click="pickMode(i)"
            >
              {{ m.label }}
            </UButton>
          </div>
          <div class="mt-3 flex justify-end">
            <UButton size="xs" variant="ghost" color="neutral" @click="cancelModal">Cancel</UButton>
          </div>
        </div>
      </div>

      <!-- planeswalker loyalty ability picker -->
      <div v-if="loyaltyPick" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click="cancelLoyalty">
        <div class="rounded-lg border border-indigo-400 bg-default p-4 shadow-xl" @click.stop>
          <p class="mb-2 text-sm font-semibold">{{ nameOf(loyaltyPick.objId) }} — loyalty ability</p>
          <div class="flex flex-col gap-2">
            <UButton
              v-for="opt in loyaltyPick.options"
              :key="opt.abilityIndex"
              size="sm"
              variant="soft"
              class="justify-start"
              @click="pickLoyalty(opt.abilityIndex)"
            >
              ◆ {{ loyaltyLabel(opt.cost) }}
            </UButton>
          </div>
          <div class="mt-3 flex justify-end">
            <UButton size="xs" variant="ghost" color="neutral" @click="cancelLoyalty">Cancel</UButton>
          </div>
        </div>
      </div>

      <!-- scry: peek at the top-N and choose which to bottom -->
      <div v-if="st.scry" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div class="rounded-lg border border-default bg-default p-4 shadow-xl">
          <p class="mb-2 text-sm font-semibold">Scry — click a card to put it on the bottom (the rest stay on top)</p>
          <div class="flex gap-3">
            <div v-for="id in st.scry.cardIds" :key="id" class="flex flex-col items-center gap-1">
              <RulesCard
                :card="st.cards[id]!"
                :display="display[st.cards[id]!.defName ?? '']"
                :selected="scryBottom.has(id)"
                @click="toggleScry(id)"
              />
              <span class="text-[10px]" :class="scryBottom.has(id) ? 'text-error font-semibold' : 'text-dimmed'">
                {{ scryBottom.has(id) ? 'to bottom' : 'keep on top' }}
              </span>
            </div>
          </div>
          <div class="mt-3 flex justify-end">
            <UButton size="sm" icon="i-lucide-check" @click="confirmScry">
              Done ({{ scryBottom.size }} to bottom)
            </UButton>
          </div>
        </div>
      </div>

      <!-- library search (tutor / ramp): pick up to `count` of the matches -->
      <div v-if="st.search" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="flex max-h-[85vh] flex-col rounded-lg border border-default bg-default p-4 shadow-xl">
          <p class="mb-2 text-sm font-semibold">
            Search your library — pick up to {{ st.search.count }}
            ({{ st.search.dest === 'hand' ? 'to your hand' : 'onto the battlefield' }})
          </p>
          <div class="flex flex-wrap gap-2 overflow-y-auto">
            <RulesCard
              v-for="id in st.search.matchIds"
              :key="id"
              :card="st.cards[id]!"
              :display="display[st.cards[id]!.defName ?? '']"
              :selected="searchPick.has(id)"
              size="sm"
              @click="toggleSearch(id)"
              @preview="hoverDisplay = $event"
            />
          </div>
          <div class="mt-3 flex justify-end gap-2">
            <UButton size="sm" variant="ghost" color="neutral" @click="confirmSearch">Take none</UButton>
            <UButton size="sm" icon="i-lucide-check" :disabled="!searchPick.size" @click="confirmSearch">
              Take {{ searchPick.size }}
            </UButton>
          </div>
        </div>
      </div>

      <!-- graveyard recursion (Raise Dead / Regrowth): pick a card from your graveyard to return -->
      <div v-if="graveyardTargeting" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="flex max-h-[85vh] flex-col rounded-lg border border-default bg-default p-4 shadow-xl">
          <p class="mb-2 text-sm font-semibold">
            Casting {{ nameOf(graveyardTargeting.objId) }} — pick a
            {{ graveyardTargeting.creatureOnly ? 'creature card' : 'card' }} from your graveyard to return
          </p>
          <div v-if="graveyardTargets.length" class="flex flex-wrap gap-2 overflow-y-auto">
            <RulesCard
              v-for="id in graveyardTargets"
              :key="id"
              :card="st.cards[id]!"
              :display="display[st.cards[id]!.defName ?? '']"
              size="sm"
              @click="pickGraveyardTarget(id)"
              @preview="hoverDisplay = $event"
            />
          </div>
          <p v-else class="text-xs text-dimmed">No eligible cards in your graveyard.</p>
          <div class="mt-3 flex justify-end">
            <UButton size="sm" variant="ghost" color="neutral" @click="cancelGraveyardTarget">Cancel</UButton>
          </div>
        </div>
      </div>

      <!-- ward (CR 702.21): pay the ward cost from your pool, or let your spell/ability be countered -->
      <div v-if="legal?.needsWard" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="flex max-w-sm flex-col rounded-lg border border-sky-400 bg-default p-4 shadow-xl">
          <p class="mb-1 flex items-center gap-1 text-sm font-semibold">
            Ward — pay <ManaSymbols :value="legal.wardCost" :size="13" /> or your spell/ability is countered
          </p>
          <p class="mb-3 text-xs text-dimmed">
            {{ legal.wardAffordable ? 'You have the mana in your pool.' : 'You cannot pay from your current pool — declining will counter it.' }}
          </p>
          <div class="flex justify-end gap-2">
            <UButton size="sm" variant="ghost" color="neutral" @click="sendWard(false)">Decline (counter)</UButton>
            <UButton size="sm" icon="i-lucide-shield-check" :disabled="!legal.wardAffordable" @click="sendWard(true)">
              Pay ward
            </UButton>
          </div>
        </div>
      </div>

      <!-- cast-time additional cost: sacrifice and/or discard, then on to the mana payment -->
      <div v-if="castExtra" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="flex max-w-md flex-col rounded-lg border border-rose-400 bg-default p-4 shadow-xl">
          <p class="mb-1 text-sm font-semibold">
            {{ display[castExtra.card.defName ?? '']?.name ?? 'Spell' }} — additional cost
          </p>
          <p class="mb-3 text-xs text-dimmed">
            <span v-if="castExtra.sacrifice">
              Click {{ castExtra.sacrifice }}
              {{ castExtra.sacFilter === 'creature' ? 'creature' : 'artifact or creature' }} you control
              ({{ castExtraSacPick.size }}/{{ castExtra.sacrifice }}).
            </span>
            <span v-if="castExtra.discard">
              Click {{ castExtra.discard }} card{{ castExtra.discard === 1 ? '' : 's' }} in your hand to discard
              ({{ castExtraDiscardPick.size }}/{{ castExtra.discard }}).
            </span>
          </p>
          <div class="flex justify-end gap-2">
            <UButton size="sm" variant="ghost" color="neutral" @click="cancelCastExtra">Cancel</UButton>
            <UButton size="sm" :disabled="!castExtraReady" @click="confirmCastExtra">Pay and continue</UButton>
          </div>
        </div>
      </div>

      <!-- "…unless that player pays {N}" (Rhystic Study / Esper Sentinel) -->
      <div v-if="legal?.needsOptionalPay" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="flex max-w-sm flex-col rounded-lg border border-indigo-400 bg-default p-4 shadow-xl">
          <p class="mb-1 flex items-center gap-1 text-sm font-semibold">
            {{ legal.optionalPaySourceName }} — pay <ManaSymbols :value="legal.optionalPayCost" :size="13" /> ?
          </p>
          <p class="mb-3 text-xs text-dimmed">
            {{ legal.optionalPayAffordable ? "If you don't, its ability happens." : 'You cannot pay from your current pool — its ability will happen.' }}
          </p>
          <div class="flex justify-end gap-2">
            <UButton size="sm" variant="ghost" color="neutral" @click="sendOptionalPay(false)">Don't pay</UButton>
            <UButton size="sm" icon="i-lucide-coins" :disabled="!legal.optionalPayAffordable" @click="sendOptionalPay(true)">
              Pay {{ legal.optionalPayCost }}
            </UButton>
          </div>
        </div>
      </div>

      <!-- as-enters choice (CR 614.12, shocklands): pay the life or it enters tapped -->
      <div v-if="legal?.needsEntersChoice" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="flex max-w-sm flex-col rounded-lg border border-amber-400 bg-default p-4 shadow-xl">
          <p class="mb-1 text-sm font-semibold">
            {{ legal.entersChoiceName }} — pay {{ legal.entersChoiceLife }} life to have it enter untapped?
          </p>
          <p class="mb-3 text-xs text-dimmed">
            {{ legal.entersChoiceAffordable ? "If you don't, it enters tapped." : 'Your life total is too low to pay — it will enter tapped.' }}
          </p>
          <div class="flex justify-end gap-2">
            <UButton size="sm" variant="ghost" color="neutral" @click="sendEntersChoice(false)">Enter tapped</UButton>
            <UButton size="sm" icon="i-lucide-droplet" :disabled="!legal.entersChoiceAffordable" @click="sendEntersChoice(true)">
              Pay {{ legal.entersChoiceLife }} life
            </UButton>
          </div>
        </div>
      </div>

      <!-- forced sacrifice (edict): choose which of your creatures to sacrifice -->
      <div v-if="legal?.needsSacrifice" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="flex max-h-[85vh] flex-col rounded-lg border border-rose-400 bg-default p-4 shadow-xl">
          <p class="mb-2 text-sm font-semibold">
            Sacrifice {{ legal.sacrificeCount }} creature{{ legal.sacrificeCount === 1 ? '' : 's' }}
            ({{ selSacrifice.size }}/{{ legal.sacrificeCount }})
          </p>
          <div class="flex flex-wrap gap-2 overflow-y-auto">
            <RulesCard
              v-for="id in legal.sacrificeableIds"
              :key="id"
              :card="st.cards[id]!"
              :display="display[st.cards[id]!.defName ?? '']"
              :selected="selSacrifice.has(id)"
              size="sm"
              @click="toggleSacrifice(id)"
              @preview="hoverDisplay = $event"
            />
          </div>
          <div class="mt-3 flex justify-end">
            <UButton size="sm" color="error" icon="i-lucide-skull" :disabled="selSacrifice.size !== legal.sacrificeCount" @click="confirmSacrifice">
              Sacrifice {{ selSacrifice.size }}/{{ legal.sacrificeCount }}
            </UButton>
          </div>
        </div>
      </div>

      <!-- sacrifice-as-cost (sac outlet): pick the creature(s) to pay the cost -->
      <div v-if="costSac" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div class="flex max-h-[85vh] flex-col rounded-lg border border-rose-400 bg-default p-4 shadow-xl">
          <p class="mb-2 text-sm font-semibold">
            {{ nameOf(costSac.objId) }} — sacrifice {{ costSac.count }} creature{{ costSac.count === 1 ? '' : 's' }} as a cost
            ({{ costSacPick.size }}/{{ costSac.count }})
          </p>
          <div class="flex flex-wrap gap-2 overflow-y-auto">
            <RulesCard
              v-for="id in myCreatureIds"
              :key="id"
              :card="st.cards[id]!"
              :display="display[st.cards[id]!.defName ?? '']"
              :selected="costSacPick.has(id)"
              size="sm"
              @click="toggleCostSac(id)"
              @preview="hoverDisplay = $event"
            />
          </div>
          <div class="mt-3 flex justify-end gap-2">
            <UButton size="sm" variant="ghost" color="neutral" @click="cancelCostSacrifice">Cancel</UButton>
            <UButton size="sm" color="error" icon="i-lucide-skull" :disabled="costSacPick.size !== costSac.count" @click="confirmCostSacrifice">
              Sacrifice &amp; activate
            </UButton>
          </div>
        </div>
      </div>

      <!-- dual-land colour picker -->
      <div v-if="manaPick" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30" @click="manaPick = null">
        <div class="rounded-lg border border-default bg-default p-3 shadow-xl" @click.stop>
          <p class="mb-2 text-xs font-semibold text-dimmed">Add which colour?</p>
          <div class="flex gap-2">
            <UButton v-for="c in manaPick.colors" :key="c" size="sm" variant="soft" @click="pickMana(c)">
              <ManaSymbols :value="`{${c}}`" :size="18" />
            </UButton>
          </div>
        </div>
      </div>

      <!-- per-card manual-actions context menu (your cards) -->
      <div v-if="menu" class="fixed inset-0 z-50" @click="closeMenu" @contextmenu.prevent="closeMenu">
        <div
          class="absolute min-w-44 rounded-lg border border-default bg-default p-1 text-xs shadow-xl"
          :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
          @click.stop
        >
          <div class="truncate px-2 py-1 font-semibold text-dimmed">{{ nameOf(menu.id) }}</div>
          <template v-if="activationFor(menu.id)">
            <button type="button" class="menu-item font-semibold text-primary" @click="startActivate(menu.id)">
              ⚡ Activate ability{{ activationFor(menu.id)!.lifeCost ? ` (pay ${activationFor(menu.id)!.lifeCost} life)` : ''
              }}{{ activationFor(menu.id)?.targetKind ? ' (choose a target)' : '' }}
            </button>
            <div class="my-1 border-t border-default" />
          </template>
          <template v-if="menuCard?.zone === 'battlefield'">
            <button type="button" class="menu-item" @click="toggleTapMenuCard">{{ menuCard?.tapped ? 'Untap' : 'Tap' }}</button>
            <button type="button" class="menu-item" @click="counterMenuCard(1)">Add +1/+1 counter</button>
            <button type="button" class="menu-item" @click="counterMenuCard(-1)">Remove +1/+1 counter</button>
            <div class="my-1 border-t border-default" />
          </template>
          <div class="px-2 py-0.5 text-[10px] uppercase tracking-wide text-dimmed">Move to</div>
          <button
            v-for="z in MENU_ZONES.filter((m) => !(m.zone === menuCard?.zone && !m.pos))"
            :key="z.label"
            type="button"
            class="menu-item"
            @click="moveMenuCard(z.zone, z.pos)"
          >{{ z.label }}</button>
        </div>
      </div>

      <div v-if="st.status === 'ended'" class="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-default/90 backdrop-blur-sm">
        <UIcon name="i-lucide-trophy" class="size-12 text-primary" />
        <h2 class="text-2xl font-bold">{{ winnerName ? `${winnerName} wins!` : 'The game ends in a draw.' }}</h2>
        <p v-if="winnerName && st.winner === you" class="text-dimmed">Well played.</p>
        <UButton to="/" size="lg">Back home</UButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
}
.menu-item:hover {
  background: rgb(127 127 127 / 0.18);
}
</style>
