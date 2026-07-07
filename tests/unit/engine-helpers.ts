import type { CardDisplay, PlayerId, ServerGameState } from '../../shared/types/game.ts'
import { zoneKey } from '../../shared/types/game.ts'
import { buildInitialState, type SetupDeckCard } from '../../server/game/setup.ts'
import { applyAction } from '../../server/game/reducer.ts'
import type { ClientMsgT } from '../../shared/schemas/messages.ts'
import { expect } from 'vitest'

export const display = (name: string): CardDisplay => ({
  name,
  manaCost: '{1}',
  typeLine: 'Artifact',
  oracleText: null,
  power: null,
  toughness: null,
  loyalty: null,
  imageSmall: null,
  imageNormal: null,
  backImageSmall: null,
  backImageNormal: null,
  faces: null,
  canBeCommander: false,
})

/** n players, each with 1 commander + deckSize distinct singleton cards. */
export function makeGame(nPlayers = 2, deckSize = 20): ServerGameState {
  const players = Array.from({ length: nPlayers }, (_, i) => ({
    id: `p${i}`,
    seat: i,
    name: `Player${i}`,
  }))
  const decks = new Map<PlayerId, SetupDeckCard[]>()
  for (const p of players) {
    const cards: SetupDeckCard[] = [
      {
        catalogId: `cat_${p.id}_cmd`,
        quantity: 1,
        isCommander: true,
        display: { ...display(`Commander ${p.id}`), canBeCommander: true },
      },
    ]
    for (let k = 0; k < deckSize; k++)
      cards.push({
        catalogId: `cat_${p.id}_${k}`,
        quantity: 1,
        isCommander: false,
        display: display(`Card ${p.id}#${k}`),
      })
    decks.set(p.id, cards)
  }
  return buildInitialState('g_test', players, decks)
}

export function act(state: ServerGameState, actor: PlayerId, msg: ClientMsgT) {
  const result = applyAction(state, actor, msg)
  state.seq++
  return result
}

/** Structural invariant: every card sits in exactly one zone array, matching card.zone. */
export function assertInvariants(state: ServerGameState) {
  const seen = new Map<string, string>()
  const collect = (key: string, ids: string[]) => {
    for (const id of ids) {
      expect(seen.has(id), `card ${id} in two zones: ${seen.get(id)} and ${key}`).toBe(false)
      seen.set(id, key)
      expect(state.cards[id], `zone ${key} references missing card ${id}`).toBeTruthy()
      expect(zoneKey(state.cards[id]!.zone), `card ${id} zone mismatch`).toBe(key)
    }
  }
  for (const [pid, zones] of Object.entries(state.zones.perPlayer)) {
    for (const kind of ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'] as const)
      collect(`${pid}:${kind}`, zones[kind])
  }
  collect('stack', state.zones.stack)
  expect(Object.keys(state.cards).length, 'orphan cards outside all zones').toBe(seen.size)
  // commander slots point at live commander instances
  for (const p of Object.values(state.players)) {
    for (const id of p.commanderIds) {
      if (id) expect(state.cards[id]?.isCommander, `commanderIds points at ${id}`).toBe(true)
    }
  }
}

/** Deterministic PRNG for fuzzing (Math.random is banned in engine code). */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
