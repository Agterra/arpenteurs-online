/**
 * CI-BLOCKING hidden-information property test (PLAN §4).
 * Fuzzes random games and asserts, after EVERY action, for EVERY viewer:
 *  1. the redacted snapshot contains no hidden identity (library/opponent-hand
 *     cards absent; face-down cards identity-stripped)
 *  2. no id currently in a hidden zone appears anywhere in any serialized
 *     payload (event or snapshot) for that viewer
 *  3. history-aware: no id EVER serialized to a viewer is currently hidden —
 *     i.e. re-minting on hidden-zone entry actually prevents tracking
 */
import { describe, expect, it } from 'vitest'
import type { PlayerId, ServerGameState } from '../../shared/types/game.ts'
import type { ClientMsgT } from '../../shared/schemas/messages.ts'
import { applyAction } from '../../server/game/reducer.ts'
import { buildEventFor, snapshotVis } from '../../server/game/events.ts'
import { redactStateFor, visibleTo } from '../../server/game/visibility.ts'
import { assertInvariants, makeGame, mulberry32 } from './engine-helpers.ts'

const PLAYERS: PlayerId[] = ['p0', 'p1', 'p2']

function hiddenIds(state: ServerGameState, viewer: PlayerId): Set<string> {
  const out = new Set<string>()
  for (const [pid, zones] of Object.entries(state.zones.perPlayer)) {
    for (const id of zones.library) out.add(id)
    if (pid !== viewer)
      for (const id of zones.hand) {
        // card.reveal grants persistent visibility (redaction table: revealedTo)
        if (!state.cards[id]?.revealedTo?.includes(viewer)) out.add(id)
      }
  }
  // a viewer's OWN active peek is the sanctioned exception: those library ids
  // are shown to them (and re-minted at resolve/cancel so they stay unusable)
  for (const id of state.peeks[viewer]?.cardIds ?? []) out.delete(id)
  return out
}

function randomAction(state: ServerGameState, actor: PlayerId, rnd: () => number): ClientMsgT | null {
  const zones = state.zones.perPlayer[actor]!
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!
  const myBoardCards = zones.battlefield.filter((id) => state.cards[id]!.controllerId === actor)

  if (state.status === 'mulligans') {
    const p = state.players[actor]!
    if (p.keptHand) return null
    if (rnd() < 0.3 && p.mullCount < 2) return { type: 'deck.mulligan' }
    const bottom = zones.hand.slice(0, Math.floor(rnd() * Math.min(2, zones.hand.length)))
    return { type: 'deck.keep', toBottom: bottom }
  }
  if (state.status === 'ended') return null

  if (state.peeks[actor]) {
    const peek = state.peeks[actor]!
    const inLib = peek.cardIds.filter((id) => state.cards[id]?.zone.kind === 'library')
    if (rnd() < 0.3) return { type: 'peek.cancel' }
    const toTop = inLib.slice(0, Math.floor(rnd() * (inLib.length + 1)))
    const rest = inLib.filter((id) => !toTop.includes(id))
    const moves =
      peek.mode === 'search' && rest.length && rnd() < 0.8
        ? [{ cardId: rest[0]!, to: { zone: { kind: 'hand' as const, player: actor } } }]
        : []
    const toBottom = rest.filter((id) => !moves.some((m) => m.cardId === id)).slice(0, 1)
    return { type: 'peek.resolve', toTop, toBottom, moves }
  }

  const roll = rnd()
  // commanders round-trip through hidden zones too (regression: commanderIds leak)
  if (roll < 0.08 && zones.command.length) {
    const dest = pick([
      { kind: 'hand' as const, player: actor },
      { kind: 'library' as const, player: actor },
      { kind: 'battlefield' as const, player: actor },
    ])
    return { type: 'card.move', cardId: pick(zones.command), to: { zone: dest, index: dest.kind === 'library' ? ('top' as const) : undefined } }
  }
  if (roll < 0.15 && zones.library.length) return { type: 'deck.draw', n: 1 + Math.floor(rnd() * 2) }
  if (roll < 0.25 && zones.hand.length) {
    const cardId = pick(zones.hand)
    const dest = pick([
      { kind: 'battlefield' as const, player: actor },
      { kind: 'graveyard' as const, player: actor },
      { kind: 'exile' as const, player: actor },
      { kind: 'library' as const, player: actor },
    ])
    return {
      type: 'card.move',
      cardId,
      to: { zone: dest, index: dest.kind === 'library' ? (rnd() < 0.5 ? ('top' as const) : ('bottom' as const)) : undefined },
      faceDown: dest.kind === 'exile' ? rnd() < 0.5 : dest.kind === 'battlefield' ? rnd() < 0.2 : undefined,
    }
  }
  if (roll < 0.33 && myBoardCards.length) {
    const cardId = pick(myBoardCards)
    const dest = pick([
      { kind: 'hand' as const, player: actor },
      { kind: 'graveyard' as const, player: actor },
      { kind: 'battlefield' as const, player: pick(PLAYERS) },
    ])
    return { type: 'card.move', cardId, to: { zone: dest } }
  }
  if (roll < 0.4 && myBoardCards.length)
    return { type: 'card.tap', cardIds: [pick(myBoardCards)], tapped: rnd() < 0.5 }
  if (roll < 0.45 && zones.library.length) return { type: 'deck.scry', n: 1 + Math.floor(rnd() * 3) }
  if (roll < 0.5 && zones.library.length) return { type: 'deck.search' }
  if (roll < 0.55) return { type: 'deck.shuffle' }
  if (roll < 0.6 && zones.library.length) return { type: 'deck.revealTop', n: 1 }
  if (roll < 0.63) return { type: 'hand.reveal', to: rnd() < 0.5 ? 'all' : [pick(PLAYERS.filter((p) => p !== actor))] }
  if (roll < 0.68 && zones.hand.length)
    return { type: 'card.reveal', cardId: pick(zones.hand), to: [pick(PLAYERS.filter((p) => p !== actor))] }
  if (roll < 0.75)
    return {
      type: 'token.create',
      spec: { name: 'Soldier', pt: '1/1', colors: ['W'], typeLine: 'Token Creature — Soldier', text: '', fromCatalogId: null },
      quantity: 1 + Math.floor(rnd() * 3),
      zone: rnd() < 0.9 ? 'battlefield' : 'stack',
      tapped: false,
    }
  if (roll < 0.8) return { type: 'player.life', delta: Math.floor(rnd() * 10) - 5 }
  if (roll < 0.85 && myBoardCards.length)
    return { type: 'card.counter', cardId: pick(myBoardCards), name: '+1/+1', delta: 1 }
  if (roll < 0.9 && myBoardCards.length && rnd() < 0.5)
    return { type: 'card.face', cardId: pick(myBoardCards), faceDown: rnd() < 0.5 }
  if (roll < 0.95 && actor === state.turn.activePlayer) return { type: 'turn.next' }
  return { type: 'game.roll', sides: 20, count: 1 }
}

describe('hidden-information leak fuzzing (CI-blocking)', () => {
  it('never leaks hidden identities across 3 seeded games × 400 actions', () => {
    for (const seed of [7, 1337, 20260705]) {
      const rnd = mulberry32(seed)
      const state = makeGame(3, 20)
      // history: every instance id ever serialized to each viewer
      const everSerialized = new Map<PlayerId, Set<string>>(PLAYERS.map((p) => [p, new Set()]))
      let applied = 0

      for (let step = 0; step < 400; step++) {
        const actor = PLAYERS[Math.floor(rnd() * PLAYERS.length)]!
        const msg = randomAction(state, actor, rnd)
        if (!msg) continue
        const before = snapshotVis(state)
        let result
        try {
          result = applyAction(state, actor, msg)
        } catch {
          continue // structurally invalid random action — rejection is free
        }
        state.seq++
        applied++
        const after = snapshotVis(state)
        assertInvariants(state)

        for (const viewer of PLAYERS) {
          const event = buildEventFor(viewer, state, actor, msg, result, before, after)
          const sync = redactStateFor(viewer, state)
          const hidden = hiddenIds(state, viewer)

          // (1) snapshot structure: no hidden-zone ids, face-down cards stripped
          for (const [id, card] of Object.entries(sync.cards)) {
            expect(hidden.has(id), `${viewer} snapshot holds hidden-zone id ${id} (seed ${seed} step ${step})`).toBe(false)
            const real = state.cards[id]!
            if (!visibleTo(real, viewer, state)) {
              expect(card.hidden, `${viewer} sees identity of face-down ${id}`).toBe(true)
              expect(card.catalogId).toBeNull()
              expect((card as { display: unknown }).display).toBeNull()
            }
          }
          const oppHands = PLAYERS.filter((p) => p !== viewer)
          for (const opp of oppHands) {
            const hand = sync.zones.perPlayer[opp]!.hand
            expect(Array.isArray(hand), `${viewer} got ${opp}'s hand as an id list`).toBe(false)
          }

          // (2) point-in-time: no currently-hidden id in any serialized payload
          const payload = JSON.stringify(event) + JSON.stringify(sync)
          for (const id of hidden)
            expect(payload.includes(id), `${viewer} payload leaks hidden id ${id} after ${msg.type} (seed ${seed} step ${step})`).toBe(false)

          // record serialized ids for the history check
          const track = everSerialized.get(viewer)!
          for (const m of payload.matchAll(/i_[0-9a-f-]{36}/g)) track.add(m[0])

          // (3) history-aware: nothing this viewer ever saw is now hidden
          for (const id of hidden)
            expect(track.has(id), `${viewer} could track ${id} into a hidden zone after ${msg.type} (seed ${seed} step ${step})`).toBe(false)
        }
      }
      expect(applied).toBeGreaterThan(150) // the fuzzer actually exercised the engine
    }
  }, 60_000)
})
