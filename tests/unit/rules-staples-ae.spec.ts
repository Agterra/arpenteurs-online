/**
 * Coverage batch AE: Auras & Equipment (the attach model).
 *  - An Aura (Enchantment — Aura) is a targeted spell that enters ATTACHED to its
 *    target; its `grantsToHost` (P/T + keywords + can't-attack/block) applies to the
 *    host via the layer system; it dies with its host (CR 704.5m).
 *  - Equipment (Artifact — Equipment) enters unattached and attaches via `r.equip`
 *    (sorcery speed, pay equipCost); its grant follows the equipped creature; when
 *    the host leaves, the Equipment stays and unattaches (CR 704.5n).
 * All attach moves are battlefield↔battlefield (public); no hidden-info surface.
 */
import { describe, expect, it } from 'vitest'
import { act, makeDuel, putCard, putFallback, toStep, until } from './rules-helpers.ts'
import { getDef } from '../../server/rules/cards/registry.ts'
import { checkSBA } from '../../server/rules/engine.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = ReturnType<typeof makeDuel>['state']
function tapAllMana(state: St, p: string) {
  for (const id of [...state.zones.perPlayer[p]!.battlefield]) {
    const hasMana = getDef(state.objects[id]!.defName).abilities?.some((a) => a.kind === 'activated' && a.isMana)
    if (hasMana && !state.objects[id]!.tapped) act(state, p, { type: 'r.tapMana', objId: id })
  }
}
const cardOf = (state: St, viewer: string, id: string) => redactRulesState(state, viewer).cards[id]!

describe('Unholy Strength — Aura: +2/+1, dies with its host', () => {
  it('enters attached, boosts the host, and hits the graveyard when the host dies', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const aura = putCard(state, A, 'Unholy Strength', 'hand')
    putCard(state, A, 'Swamp', 'battlefield')
    toStep(state, 'main1')
    tapAllMana(state, A)
    act(state, A, { type: 'r.cast', objId: aura, targets: [bear] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'aura resolves')

    expect(state.objects[aura]!.zone).toBe('battlefield')
    expect(state.objects[aura]!.attachedTo).toBe(bear)
    const bc = cardOf(state, A, bear)
    expect(bc.power).toBe(4) // 2 + 2
    expect(bc.toughness).toBe(3) // 2 + 1

    // host dies → the Aura is put into the graveyard (SBA 704.5m)
    state.objects[bear]!.damageMarked = 99
    checkSBA(state)
    expect(state.objects[bear]!.zone).toBe('graveyard')
    expect(state.objects[aura]!.zone).toBe('graveyard')
  })
})

describe('Angelic Gift — Aura: grants flying + draws on enter', () => {
  it('grants the host flying and draws a card when it enters', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const aura = putCard(state, A, 'Angelic Gift', 'hand')
    putCard(state, A, 'Plains', 'battlefield')
    putCard(state, A, 'Plains', 'battlefield')
    toStep(state, 'main1')
    const handBefore = state.zones.perPlayer[A]!.hand.length
    tapAllMana(state, A)
    act(state, A, { type: 'r.cast', objId: aura, targets: [bear] })
    until(state, (s) => !s.zones.stack.length && s.priorityPlayer === A, 'aura + ETB resolve')

    expect(cardOf(state, A, bear).keywords).toContain('flying')
    // enters-draw fired (hand had the aura removed on cast, then +1 from Angelic Gift)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(handBefore - 1 + 1)
  })
})

describe('Bonesplitter — Equipment: equip / re-equip / unattach on host death', () => {
  it('attaches via r.equip, moves on re-equip, and stays when the host dies', () => {
    const { state, A } = makeDuel()
    const bs = putCard(state, A, 'Bonesplitter', 'battlefield') // enters unattached
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const m1 = putCard(state, A, 'Mountain', 'battlefield')
    const m2 = putCard(state, A, 'Mountain', 'battlefield')
    toStep(state, 'main1')

    act(state, A, { type: 'r.tapMana', objId: m1 })
    act(state, A, { type: 'r.equip', equipmentId: bs, creatureId: bear })
    expect(state.objects[bs]!.attachedTo).toBe(bear)
    expect(cardOf(state, A, bear).power).toBe(4) // 2 + 2

    // re-equip onto a second creature — moves the buff
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    act(state, A, { type: 'r.tapMana', objId: m2 })
    act(state, A, { type: 'r.equip', equipmentId: bs, creatureId: ogre })
    expect(state.objects[bs]!.attachedTo).toBe(ogre)
    expect(cardOf(state, A, bear).power).toBe(2) // back to base
    expect(cardOf(state, A, ogre).power).toBe(4)

    // host dies → Equipment stays on the battlefield, just unattaches (704.5n)
    state.objects[ogre]!.damageMarked = 99
    checkSBA(state)
    expect(state.objects[ogre]!.zone).toBe('graveyard')
    expect(state.objects[bs]!.zone).toBe('battlefield')
    expect(state.objects[bs]!.attachedTo).toBeNull()
  })

  it('rejects equip at instant speed and onto a creature you do not control', () => {
    const { state, A, B } = makeDuel()
    const bs = putCard(state, A, 'Bonesplitter', 'battlefield')
    const myBear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const foe = putCard(state, B, 'Gray Ogre', 'battlefield')
    putCard(state, A, 'Mountain', 'battlefield')
    // at upkeep (not a main phase) → timing rejected
    expect(() => act(state, A, { type: 'r.equip', equipmentId: bs, creatureId: myBear })).toThrow()
    toStep(state, 'main1')
    tapAllMana(state, A)
    // equipping an opponent's creature is illegal
    expect(() => act(state, A, { type: 'r.equip', equipmentId: bs, creatureId: foe })).toThrow()
  })
})

describe('Equipment keyword grants (Loxodon Warhammer, Sword of Vengeance)', () => {
  it('grant their keyword package to the equipped creature', () => {
    const { state, A } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const wh = putCard(state, A, 'Loxodon Warhammer', 'battlefield')
    state.objects[wh]!.attachedTo = bear
    const bc = cardOf(state, A, bear)
    expect(bc.power).toBe(5) // 2 + 3
    expect(bc.keywords).toEqual(expect.arrayContaining(['trample', 'lifelink']))

    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    const sword = putCard(state, A, 'Sword of Vengeance', 'battlefield')
    state.objects[sword]!.attachedTo = ogre
    expect(cardOf(state, A, ogre).keywords).toEqual(
      expect.arrayContaining(['first strike', 'vigilance', 'trample', 'haste']),
    )
  })
})

// --- regression tests for the adversarial-review findings (assisted-table invariant) ---

describe('assisted table: the engine never auto-acts on UNIMPLEMENTED auras/equipment', () => {
  it('does not put an unimplemented (fallback) Aura into the graveyard via SBA', () => {
    const { state, A } = makeDuel()
    // a real Aura not in the implemented set becomes a fallback (unimplemented, no spell)
    const aura = putFallback(state, A, { name: 'Test Curse of Silence', typeLine: 'Enchantment — Aura' }, 'battlefield')
    checkSBA(state)
    // it stays on the battlefield to be hand-run — NOT auto-binned (CLAUDE.md invariant #6)
    expect(state.objects[aura]!.zone).toBe('battlefield')
  })

  it('does not offer or auto-equip unimplemented Equipment (unknown equip cost)', () => {
    const { state, A } = makeDuel()
    const eq = putFallback(state, A, { name: 'Test Batterskull', typeLine: 'Artifact — Equipment' }, 'battlefield')
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    toStep(state, 'main1')
    expect(redactRulesState(state, A).legal.equippableIds).not.toContain(eq)
    // the engine must not auto-run its equip ability at a fabricated {0} cost
    expect(() => act(state, A, { type: 'r.equip', equipmentId: eq, creatureId: bear })).toThrow()
  })

  it('rejects equipping a creature-Equipment onto itself', () => {
    const { state, A } = makeDuel()
    const both = putFallback(
      state,
      A,
      { name: 'Test Living Blade', typeLine: 'Artifact Creature — Equipment', power: '1', toughness: '1' },
      'battlefield',
    )
    toStep(state, 'main1')
    expect(() => act(state, A, { type: 'r.equip', equipmentId: both, creatureId: both })).toThrow()
  })
})

describe('Pacifism — Aura: enchanted creature can\'t attack or block', () => {
  it('removes the host from legal attackers and rejects declaring it', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const ogre = putCard(state, A, 'Gray Ogre', 'battlefield')
    const pac = putCard(state, A, 'Pacifism', 'battlefield')
    state.objects[pac]!.attachedTo = bear // pacify the bear

    until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'A declares attackers')
    const legal = redactRulesState(state, A).legal
    expect(legal.declarableAttackerIds).toContain(ogre)
    expect(legal.declarableAttackerIds).not.toContain(bear)
    expect(() => act(state, A, { type: 'r.attackers', attacks: [{ attackerId: bear, defenderId: B }] })).toThrow()
  })
})
