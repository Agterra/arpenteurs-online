/**
 * London mulligan in the enforced engine: the game opens in a 'mulligans' phase;
 * each player keeps (bottoming mullCount cards) or mulligans (reshuffle + redraw
 * 7, re-minting the library); turn 1 begins only once everyone has kept.
 */
import { describe, expect, it } from 'vitest'
import { act, makeGameNMulligan } from './rules-helpers.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

describe('London mulligan (enforced)', () => {
  it('starts in the mulligan phase with seven cards each', () => {
    const { state, players } = makeGameNMulligan(2)
    expect(state.status).toBe('mulligans')
    for (const p of players) {
      expect(state.zones.perPlayer[p]!.hand.length).toBe(7)
      expect(state.players[p]!.keptHand).toBe(false)
      expect(state.players[p]!.mullCount).toBe(0)
    }
  })

  it('rejects normal actions until you keep or mulligan', () => {
    const { state, players } = makeGameNMulligan(2)
    expect(() => act(state, players[0]!, { type: 'r.pass' })).toThrow(/mulligan/i)
  })

  it('mulligan reshuffles and redraws seven fresh (re-minted) cards, counting up', () => {
    const { state, players } = makeGameNMulligan(2)
    const A = players[0]!
    const before = new Set(state.zones.perPlayer[A]!.hand)
    act(state, A, { type: 'r.mulligan' })
    expect(state.players[A]!.mullCount).toBe(1)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(7)
    expect([...state.zones.perPlayer[A]!.hand].some((id) => before.has(id))).toBe(false) // ids re-minted
  })

  it('keeping after N mulligans bottoms exactly N and leaves 7-N in hand', () => {
    const { state, players } = makeGameNMulligan(2)
    const A = players[0]!
    act(state, A, { type: 'r.mulligan' })
    act(state, A, { type: 'r.mulligan' }) // mullCount 2
    const hand = state.zones.perPlayer[A]!.hand
    expect(() => act(state, A, { type: 'r.keep', toBottom: [hand[0]!] })).toThrow(/exactly 2/)
    const lib0 = state.zones.perPlayer[A]!.library.length
    act(state, A, { type: 'r.keep', toBottom: [hand[0]!, hand[1]!] })
    expect(state.players[A]!.keptHand).toBe(true)
    expect(state.zones.perPlayer[A]!.hand.length).toBe(5)
    expect(state.zones.perPlayer[A]!.library.length).toBe(lib0 + 2)
  })

  it('the game begins only after every player has kept', () => {
    const { state, players } = makeGameNMulligan(3)
    act(state, players[0]!, { type: 'r.keep', toBottom: [] })
    act(state, players[1]!, { type: 'r.keep', toBottom: [] })
    expect(state.status).toBe('mulligans') // still waiting on the third player
    act(state, players[2]!, { type: 'r.keep', toBottom: [] })
    expect(state.status).toBe('active')
    expect(state.turnNumber).toBe(1)
  })

  it('does not leak hidden info during mulligans', () => {
    const { state, players } = makeGameNMulligan(2)
    const [A, B] = players
    act(state, A!, { type: 'r.mulligan' })
    const view = redactRulesState(state, B!)
    const json = JSON.stringify(view)
    for (const id of state.zones.perPlayer[A!]!.library) expect(json.includes(id)).toBe(false)
    for (const id of state.zones.perPlayer[A!]!.hand) expect(json.includes(id)).toBe(false)
    expect(Array.isArray(view.zones.perPlayer[A!]!.hand)).toBe(false) // opponent hand is count-only
  })
})
