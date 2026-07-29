/**
 * Client/server contract guard (regression for the Acidic Slime softlock, batch BR).
 *
 * The enforced client (DuelBoard.vue) resolves a targeted TRIGGERED ability via
 * `isTriggerTargetCard` / `canTargetPlayerForTrigger`, which between them handle exactly
 * the target kinds below. If an implemented card's targeted trigger uses a kind outside
 * this set, the server sets a `pending: 'trigger'` that NO client action can clear → the
 * enforced game softlocks (recoverable only by conceding). Acidic Slime's ETB (kind
 * 'permanent') was the first such case and slipped past the unit suite (engine tests send
 * `r.chooseTargets` directly, bypassing the client's selection logic).
 *
 * This test locks the contract: extend the client's trigger-target handling (and this set)
 * together whenever a new trigger-target kind is introduced.
 */
import { describe, expect, it } from 'vitest'
import { allDefs } from '../../server/rules/cards/registry.ts'
import {
  GRAVEYARD_SPELLS,
  LIFE_X_SPELLS,
  MODAL_SPELLS,
  MULTI_TARGET_SPELLS,
  TARGETED_SPELLS,
} from '../../shared/rules/clientTargets.ts'

// Kinds the client can select for a TRIGGERED ability (isTriggerTargetCard +
// canTargetPlayerForTrigger) and for an ACTIVATED ability (isActivateTargetCard +
// canActivateTargetPlayer). 'spell' targets go through a separate stack-click path
// (onStackTarget), so they're allowed too.
// 'graveyardCard' became selectable in batch CARD38: redact publishes the legal graveyard cards for
// an activated / channel ability and the board renders them as a picker.
const CLIENT_TARGET_KINDS = new Set(['creature', 'permanent', 'player', 'anyTarget', 'spell', 'graveyardCard'])
const TRIGGERS = ['enters', 'dies', 'attacks', 'upkeep'] as const

describe('every implemented targeted trigger uses a client-selectable target kind', () => {
  const cases: { card: string; trigger: string; kind: string }[] = []
  for (const def of allDefs()) {
    if (def.unimplemented) continue // fallbacks don't auto-run triggers
    for (const t of TRIGGERS) {
      for (const spec of def[t]?.targets ?? []) cases.push({ card: def.name, trigger: t, kind: spec.kind })
    }
  }
  it('found at least one targeted trigger to check', () => {
    expect(cases.length).toBeGreaterThan(0)
  })
  for (const c of cases) {
    it(`${c.card} (${c.trigger}) targets '${c.kind}' — client-selectable`, () => {
      // 'spell' is not a legal battlefield trigger target here; 'graveyardCard' became selectable in
      // batch CARD34 (the board renders the legal graveyard cards, with Decline when optional)
      expect(['creature', 'permanent', 'player', 'anyTarget', 'graveyardCard'].includes(c.kind)).toBe(true)
    })
  }
})

describe('every implemented activated ability uses a client-selectable target kind', () => {
  const cases: { card: string; kind: string }[] = []
  for (const def of allDefs()) {
    if (def.unimplemented) continue
    for (const ab of def.abilities ?? []) {
      if (ab.kind !== 'activated' || ab.isMana) continue // mana abilities are tapped, not targeted
      for (const spec of ab.targets ?? []) cases.push({ card: def.name, kind: spec.kind })
    }
  }
  for (const c of cases) {
    it(`${c.card} (activated) targets '${c.kind}' — client-selectable`, () => {
      expect(CLIENT_TARGET_KINDS.has(c.kind)).toBe(true)
    })
  }
})

/**
 * The client's activation menu resolves a card's ability with
 * `legal.activations.find((a) => a.objId === id)` — the FIRST non-mana activated ability of that
 * permanent. A card with two of them would silently offer only one (the other unreachable), so a
 * second one needs an ability picker in DuelBoard.vue first. Mana abilities don't count: they are
 * used via r.tapMana, so Mind Stone / Commander's Sphere / Rogue's Passage (mana + one other) are
 * fine. Extend the client and this guard together.
 */
describe('no implemented card has two non-mana activated abilities (the client offers one)', () => {
  const offenders: string[] = []
  for (const def of allDefs()) {
    if (def.unimplemented) continue
    const nonMana = (def.abilities ?? []).filter((ab) => ab.kind === 'activated' && !ab.isMana)
    if (nonMana.length > 1) offenders.push(`${def.name} (${nonMana.length})`)
  }
  it('every implemented card has at most one client-activatable ability', () => {
    expect(offenders).toEqual([])
  })
})

/**
 * Every implemented spell that needs a TARGET as it is cast must be resolvable by one of the
 * client's target pickers (shared/rules/clientTargets.ts). Without this, `startCast` falls through
 * to the payment panel with zero targets and the server rejects the cast with BAD_TARGETS — the
 * card ships uncastable in the real UI while every engine test (which passes targets directly to
 * r.cast) stays green. This guard was added after finding twelve such cards at once.
 */
describe('every implemented targeted spell has a client target picker', () => {
  const missing: string[] = []
  for (const def of allDefs()) {
    if (def.unimplemented || def.isBackFace) continue
    const spellTargets = def.spell?.targets?.length ?? 0
    const modalTargets = def.modes?.some((m) => (m.targets?.length ?? 0) > 0) ?? false
    if (!spellTargets && !modalTargets) continue
    const key = def.name.toLowerCase()
    const known =
      key in TARGETED_SPELLS || key in MODAL_SPELLS || key in MULTI_TARGET_SPELLS || key in GRAVEYARD_SPELLS
    if (!known) missing.push(def.name)
  }
  it('no targeted spell is missing from clientTargets.ts', () => {
    expect(missing).toEqual([])
  })
})

/**
 * The client taps a mana source with r.tapMana, which can express exactly these cost pieces: {T},
 * a mana cost, "pay N life", "sacrifice this permanent" and "sacrifice N creatures" (the last via the
 * picker added for the Altars). A mana ability with any other cost would be untappable in the UI.
 */
describe('every implemented mana ability uses a cost the client can pay', () => {
  const ALLOWED = new Set(['tap', 'mana', 'life', 'sacrificeSelf', 'sacrifice'])
  const offenders: string[] = []
  for (const def of allDefs()) {
    if (def.unimplemented) continue
    for (const ab of def.abilities ?? []) {
      if (ab.kind !== 'activated' || !ab.isMana) continue
      for (const key of Object.keys(ab.cost)) if (!ALLOWED.has(key)) offenders.push(`${def.name}: ${key}`)
    }
  }
  it('no mana ability has an unpayable cost', () => {
    expect(offenders).toEqual([])
  })
})

/**
 * A CHANNEL ability is used from the hand and, when it targets, the board resolves the click with the
 * same coarse kinds as a spell target. redact only publishes creature/permanent/player/anyTarget, so a
 * channel ability with any other target kind would be unusable in the UI.
 */
describe('every implemented channel ability targets a client-selectable kind', () => {
  const offenders: string[] = []
  for (const def of allDefs()) {
    if (def.unimplemented || !def.channel) continue
    for (const spec of def.channel.targets ?? [])
      if (!['creature', 'permanent', 'player', 'anyTarget', 'graveyardCard'].includes(spec.kind))
        offenders.push(`${def.name}: ${spec.kind}`)
  }
  it('no channel ability targets an unsupported kind', () => {
    expect(offenders).toEqual([])
  })
})

/**
 * A spell whose X is paid in LIFE has no {X} in its mana cost, so the client shows its X stepper
 * only for the names listed in LIFE_X_SPELLS. Missing there = the cast is sent with no x and the
 * server rejects it (NEEDS_X) — uncastable in the UI while engine tests, which pass x directly,
 * stay green. Same failure class as the targeted-spell guard above.
 */
describe('every implemented pay-X-life spell is listed for the client X stepper', () => {
  const missing: string[] = []
  for (const def of allDefs()) {
    if (def.unimplemented || def.isBackFace) continue
    if (def.additionalLifeCostX && !(def.name.toLowerCase() in LIFE_X_SPELLS)) missing.push(def.name)
  }
  it('no pay-X-life spell is missing from LIFE_X_SPELLS', () => {
    expect(missing).toEqual([])
  })
})

/**
 * A graveyard-card target needs the dedicated graveyard picker (a battlefield/player click can't
 * express it), so such a spell must be in GRAVEYARD_SPELLS specifically.
 */
describe('graveyardCard-targeting spells use the graveyard picker', () => {
  const wrong: string[] = []
  for (const def of allDefs()) {
    if (def.unimplemented || def.isBackFace) continue
    if (!def.spell?.targets?.some((t) => t.kind === 'graveyardCard')) continue
    if (!(def.name.toLowerCase() in GRAVEYARD_SPELLS)) wrong.push(def.name)
  }
  it('all graveyard-recursion spells are in GRAVEYARD_SPELLS', () => {
    expect(wrong).toEqual([])
  })
})

/**
 * An as-enters choice (shocklands) and an ETB trigger both want `state.pending` as the permanent
 * enters, and there is only one slot: the trigger's pending would be clobbered by the choice (or
 * vice-versa), softlocking the game. A card needing both must wait until the trigger pending is
 * queued like the enters-choices are.
 */
describe('no implemented card has BOTH an as-enters choice and an ETB trigger (one pending slot)', () => {
  const offenders: string[] = []
  for (const def of allDefs()) {
    if (def.unimplemented) continue
    if (def.entersTappedUnlessPayLife && def.enters) offenders.push(def.name)
  }
  it('the as-enters choice never competes with an ETB trigger', () => {
    expect(offenders).toEqual([])
  })
})

describe('no implemented loyalty ability is targeted (the client sends r.loyalty with no targets)', () => {
  const offenders: string[] = []
  for (const def of allDefs()) {
    if (def.unimplemented) continue
    for (const la of def.loyaltyAbilities ?? []) if ((la.targets ?? []).length) offenders.push(def.name)
  }
  it('all loyalty abilities are non-targeted', () => {
    expect(offenders).toEqual([])
  })
})
