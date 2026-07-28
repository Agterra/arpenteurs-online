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

// Kinds the client can select for a TRIGGERED ability (isTriggerTargetCard +
// canTargetPlayerForTrigger) and for an ACTIVATED ability (isActivateTargetCard +
// canActivateTargetPlayer). 'spell' targets go through a separate stack-click path
// (onStackTarget), so they're allowed too.
const CLIENT_TARGET_KINDS = new Set(['creature', 'permanent', 'player', 'anyTarget', 'spell'])
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
      // 'spell' is not a legal battlefield trigger target here; only the enumerated card kinds
      expect(['creature', 'permanent', 'player', 'anyTarget'].includes(c.kind)).toBe(true)
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
