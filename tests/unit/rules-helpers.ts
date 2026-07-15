/** Deterministic harness for rules-engine tests: build a duel, then rig zones. */
import { expect } from 'vitest'
import type { ObjId, PlayerId, RulesGameState, Step } from '../../shared/rules/types.ts'
import { buildRulesGame } from '../../server/rules/setup.ts'
import { applyRulesAction } from '../../server/rules/engine.ts'
import type { RulesMsgT } from '../../shared/rules/messages.ts'
import { defKey, getDef, registerFallback } from '../../server/rules/cards/registry.ts'
import { defIsCreature } from '../../server/rules/cards/dsl.ts'
import type { CatalogCardData } from '../../server/rules/cards/fallback.ts'
import { mintCardId } from '../../server/game/rng.ts'

const DECK_CARDS = [
  ...Array(40).fill('Mountain'),
  ...Array(6).fill('Gray Ogre'),
  ...Array(6).fill('Hill Giant'),
  ...Array(6).fill('Shock'),
  ...Array(6).fill('Lightning Bolt'),
  ...Array(4).fill('Grizzly Bears'),
  ...Array(4).fill('Divination'),
]
const COMMANDERS = ['Isamaru, Hound of Konda', 'Jerrard of the Closed Fist', 'Barktooth Warbeard', 'Marhault Elsdragon']

/** Build an N-player enforced Commander game (default 2). Returns players in turn
 *  order. `cards` overrides the shared deck (the leak fuzzer passes a deck that
 *  includes scry/search cards to exercise those re-mint paths). */
export function makeGameN(n = 2, cards: string[] = DECK_CARDS) {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, seat: i, name: `P${i}` }))
  const decks = new Map(
    players.map((p, i) => [p.id, { commander: COMMANDERS[i]!, cards: [...cards] }]),
  )
  const state = buildRulesGame('g_rules_test', players, decks)
  // auto-complete the London mulligan phase (everyone keeps 7) so tests that
  // predate mulligans still begin at turn 1. Mulligan-specific tests build the
  // game and drive r.mulligan/r.keep themselves via makeGameNMulligan.
  for (const pid of state.turnOrder) applyRulesAction(state, pid, { type: 'r.keep', toBottom: [] })
  return { state, players: state.turnOrder }
}

/** Like makeGameN but paused in the mulligan phase (no auto-keep). */
export function makeGameNMulligan(n = 2) {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, seat: i, name: `P${i}` }))
  const decks = new Map(players.map((p, i) => [p.id, { commander: COMMANDERS[i]!, cards: [...DECK_CARDS] }]))
  const state = buildRulesGame('g_rules_mull', players, decks)
  return { state, players: state.turnOrder }
}

/** Two-player convenience: A = active player, B = the other. */
export function makeDuel() {
  const { state } = makeGameN(2)
  const A = state.activePlayer
  const B = state.turnOrder.find((p) => p !== A)!
  return { state, A, B }
}

export interface RigOpts {
  hand?: string[]
  battlefield?: string[]
  libraryTop?: string[]
  /** total library size cap AFTER libraryTop (e.g. 0 = empty library) */
  librarySize?: number
  life?: number
}

/** Deterministically re-deal a player's cards across hand/battlefield/library. */
export function rig(state: RulesGameState, pid: PlayerId, opts: RigOpts) {
  const zones = state.zones.perPlayer[pid]!
  // the commander lives in the command zone and is never re-dealt by rig
  const mine = Object.values(state.objects).filter((o) => o.ownerId === pid && !o.isCommander)
  zones.hand = []
  zones.battlefield = []
  zones.graveyard = []
  zones.library = []
  const unused = [...mine]
  for (const o of mine) {
    o.zone = 'library'
    o.tapped = false
    o.summoningSick = false
    o.damageMarked = 0
    o.attackingDefender = null
    o.blockingAttackerId = null
  }
  const take = (name: string) => {
    const key = defKey(name)
    const i = unused.findIndex((o) => o.defName === key)
    if (i < 0) throw new Error(`rig: no unused "${name}" for ${pid}`)
    return unused.splice(i, 1)[0]!
  }
  for (const name of opts.battlefield ?? []) {
    const o = take(name)
    o.zone = 'battlefield'
    zones.battlefield.push(o.id)
  }
  for (const name of opts.hand ?? []) {
    const o = take(name)
    o.zone = 'hand'
    zones.hand.push(o.id)
  }
  for (const name of opts.libraryTop ?? []) zones.library.push(take(name).id)
  const rest = opts.librarySize != null ? unused.slice(0, Math.max(0, opts.librarySize)) : unused
  for (const o of rest.slice()) zones.library.push(o.id)
  // objects not placed anywhere still exist but sit in "library" zone without an
  // array slot — remove them from the game entirely to keep invariants clean
  if (opts.librarySize != null) {
    for (const o of unused.slice(Math.max(0, opts.librarySize))) delete state.objects[o.id]
  }
  if (opts.life != null) state.players[pid]!.life = opts.life
}

export const act = (state: RulesGameState, actor: PlayerId, msg: RulesMsgT) =>
  applyRulesAction(state, actor, msg)

export const pass = (state: RulesGameState, actor: PlayerId) => act(state, actor, { type: 'r.pass' })

/** Pass/auto-answer until `pred` holds (auto: empty attack/block declarations). */
export function until(state: RulesGameState, pred: (s: RulesGameState) => boolean, label = 'condition') {
  for (let i = 0; i < 300; i++) {
    if (pred(state)) return
    if (state.status === 'ended') throw new Error(`game ended before ${label}`)
    if (state.pending?.kind === 'attackers')
      act(state, state.pending.player, { type: 'r.attackers', attacks: [] })
    else if (state.pending?.kind === 'blockers')
      act(state, state.pending.player, { type: 'r.blockers', blocks: [] })
    else if (state.pending?.kind === 'discard') {
      const p = state.pending.player
      const hand = state.zones.perPlayer[p]!.hand
      // forced discard (Mind Rot / each-player) uses its own count; cleanup uses hand−7
      const need = state.pendingDiscard ? Math.min(state.pendingDiscard.count, hand.length) : hand.length - 7
      act(state, p, { type: 'r.discard', objIds: hand.slice(0, need) })
    } else if (state.pending?.kind === 'trigger') {
      // auto-choose a legal target based on the trigger's own target spec (player
      // targets need a player, not a creature — e.g. Ravenous Rats' opponent ETB)
      const p = state.pending.player
      const pt = state.pendingTrigger
      const def = pt ? getDef(pt.defName) : undefined
      const ab = def && pt
        ? pt.trigger === 'dies' ? def.dies : pt.trigger === 'attacks' ? def.attacks : pt.trigger === 'upkeep' ? def.upkeep : def.enters
        : undefined
      const spec = ab?.targets?.[0]
      let target: string
      if (spec?.kind === 'player') {
        target = spec.filter?.controller === 'you' ? p : (state.turnOrder.find((x) => x !== p && !state.players[x]!.hasLost) ?? p)
      } else {
        const creature = Object.values(state.objects).find((o) => o.zone === 'battlefield' && defIsCreature(getDef(o.defName)))
        const perm = Object.values(state.objects).find((o) => o.zone === 'battlefield')
        target = spec?.kind === 'permanent' ? (perm ? perm.id : p) : creature ? creature.id : p
      }
      act(state, p, { type: 'r.chooseTargets', targets: [target] })
    } else if (state.pending?.kind === 'scry') {
      act(state, state.pending.player, { type: 'r.scry', toBottom: [] }) // keep everything on top
    } else if (state.priorityPlayer) pass(state, state.priorityPlayer)
    else throw new Error(`engine stalled before ${label} (step ${state.step})`)
  }
  throw new Error(`never reached ${label} (step ${state.step}, turn ${state.turnNumber})`)
}

export const toStep = (state: RulesGameState, step: Step) =>
  until(state, (s) => s.step === step && s.priorityPlayer === s.activePlayer && !s.zones.stack.length, `step ${step}`)

export function handObj(state: RulesGameState, pid: PlayerId, name: string): ObjId {
  const key = defKey(name)
  const id = state.zones.perPlayer[pid]!.hand.find((i) => state.objects[i]!.defName === key)
  expect(id, `${name} in ${pid} hand`).toBeTruthy()
  return id!
}

export function fieldObj(state: RulesGameState, pid: PlayerId, name: string): ObjId {
  const key = defKey(name)
  const id = state.zones.perPlayer[pid]!.battlefield.find((i) => state.objects[i]!.defName === key)
  expect(id, `${name} on ${pid} battlefield`).toBeTruthy()
  return id!
}

/** Declare attackers all aimed at one defender (test convenience). */
export function attack(state: RulesGameState, actor: PlayerId, defender: PlayerId, attackerIds: ObjId[]) {
  act(state, actor, {
    type: 'r.attackers',
    attacks: attackerIds.map((attackerId) => ({ attackerId, defenderId: defender })),
  })
}

export function commanderObj(state: RulesGameState, pid: PlayerId): ObjId {
  return state.players[pid]!.commanderId!
}

/** Mint an instance of an already-registered (implemented) card into a zone. */
export function putCard(
  state: RulesGameState,
  pid: PlayerId,
  name: string,
  zone: 'hand' | 'battlefield' | 'graveyard' | 'library' | 'command' = 'battlefield',
): ObjId {
  const id = mintCardId()
  state.objects[id] = {
    id,
    defName: defKey(name),
    ownerId: pid,
    controllerId: pid,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    counters: {},
    isCommander: false,
    attackingDefender: null,
    blockingAttackerId: null,
  }
  state.zones.perPlayer[pid]![zone].push(id)
  return id
}

/** Register an assisted-table fallback and mint an instance into a zone (for tests). */
export function putFallback(
  state: RulesGameState,
  pid: PlayerId,
  catalog: CatalogCardData,
  zone: 'hand' | 'battlefield' | 'graveyard' | 'library' | 'command' = 'battlefield',
): ObjId {
  registerFallback(catalog)
  const id = mintCardId()
  state.objects[id] = {
    id,
    defName: defKey(catalog.name),
    ownerId: pid,
    controllerId: pid,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    counters: {},
    isCommander: false,
    attackingDefender: null,
    blockingAttackerId: null,
  }
  state.zones.perPlayer[pid]![zone].push(id)
  return id
}

/** Play a land and tap N mountains for mana (test convenience). */
export function playLandAndTap(state: RulesGameState, pid: PlayerId, tapCount: number) {
  const landId = handObj(state, pid, 'Mountain')
  act(state, pid, { type: 'r.playLand', objId: landId })
  const untapped = state.zones.perPlayer[pid]!.battlefield.filter(
    (i) => state.objects[i]!.defName === defKey('Mountain') && !state.objects[i]!.tapped,
  )
  for (const id of untapped.slice(0, tapCount)) act(state, pid, { type: 'r.tapMana', objId: id })
}
