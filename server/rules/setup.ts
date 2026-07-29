/**
 * Build the initial enforced-mode Commander game (2–4 players): 40 life,
 * commander in the command zone, shuffle, draw 7, run to the first decision
 * point. (No mulligans yet.)
 */
import type { GameObject, PlayerId, RulesGameState } from '#shared/rules/types'
import { emptyPool } from '#shared/rules/types'
import { mintCardId, randomIndex, shuffleInPlace } from '../game/rng'
import { defKey, findDef } from './cards/registry'
import { defIsValidCommander } from './cards/dsl'
import { drawOne, logLine } from './state'

export interface RulesSetupPlayer {
  id: PlayerId
  seat: number
  name: string
}

export interface RulesDeck {
  /** exactly one legendary creature (no partners yet) */
  commander: string
  /** the other cards, quantity-expanded names */
  cards: string[]
}

export function buildRulesGame(
  gameId: string,
  players: RulesSetupPlayer[],
  decks: Map<PlayerId, RulesDeck>,
): RulesGameState {
  if (players.length < 2 || players.length > 4)
    throw new Error('Enforced Commander supports 2–4 players')
  const ordered = [...players].sort((a, b) => a.seat - b.seat)

  const state: RulesGameState = {
    id: gameId,
    mode: 'enforced',
    players: {},
    turnOrder: ordered.map((p) => p.id),
    activePlayer: ordered[randomIndex(ordered.length)]!.id,
    step: 'untap',
    turnNumber: 1,
    priorityPlayer: null,
    passed: [],
    pending: null,
    pendingTrigger: null,
    pendingScry: null,
    pendingSearch: null,
    pendingSacrifice: null,
    pendingDiscard: null,
    pendingWard: null,
    pendingCascade: null,
    pendingMadness: null,
    pendingEntersChoice: null,
    pendingTypeChoice: null,
    pendingHandChoice: null,
    pendingOptionalPay: null,
    pendingPutBack: null,
    entersChoiceQueue: [],
    delayedTriggers: [],
    // CR 103.8a/b: only two-player games skip the first draw
    firstTurnSkipDraw: ordered.length === 2,
    blockOrders: {},
    attackersDeclaredThisCombat: false,
    blockersDone: [],
    pumps: [],
    setPT: [],
    loseAbilities: [],
    protectionGrants: [],
    keywordGrants: [],
    unblockable: [],
    objects: {},
    zones: { perPlayer: {}, stack: [] },
    status: 'mulligans',
    winner: null,
    log: [],
    seq: 0,
  }
  state.turnOrder = [state.activePlayer, ...state.turnOrder.filter((p) => p !== state.activePlayer)]

  const mintObj = (owner: PlayerId, defName: string): GameObject => {
    const obj: GameObject = {
      id: mintCardId(),
      defName,
      ownerId: owner,
      controllerId: owner,
      zone: 'library',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      counters: {},
      isCommander: false,
      attackingDefender: null,
      blockingAttackerId: null,
    }
    state.objects[obj.id] = obj
    return obj
  }

  for (const p of ordered) {
    const deck = decks.get(p.id)
    if (!deck) throw new Error(`No deck for ${p.name}`)
    const cmdDef = findDef(deck.commander)
    if (!cmdDef || !defIsValidCommander(cmdDef))
      throw new Error(`"${deck.commander}" is not a valid commander (legendary creature)`)

    state.players[p.id] = {
      id: p.id,
      seat: p.seat,
      name: p.name,
      life: 40,
      poison: 0,
      manaPool: emptyPool(),
      landsPlayedThisTurn: 0,
      noncreatureSpellsThisTurn: 0,
      extraLandsThisTurn: 0,
      spellsThisTurn: 0,
      hasLost: false,
      commanderId: null,
      commanderTax: 0,
      commanderDamage: {},
      mullCount: 0,
      keptHand: false,
    }
    state.zones.perPlayer[p.id] = { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [] }

    const commander = mintObj(p.id, defKey(cmdDef.name))
    commander.isCommander = true
    commander.zone = 'command'
    state.zones.perPlayer[p.id]!.command.push(commander.id)
    state.players[p.id]!.commanderId = commander.id

    for (const cardName of deck.cards) {
      const def = findDef(cardName)
      if (!def) throw new Error(`No card definition for "${cardName}"`)
      const obj = mintObj(p.id, defKey(def.name))
      state.zones.perPlayer[p.id]!.library.push(obj.id)
    }
    shuffleInPlace(state.zones.perPlayer[p.id]!.library)
    for (let i = 0; i < 7; i++) drawOne(state, p.id)
  }

  logLine(
    state,
    `Enforced Commander — ${ordered.length} players, ${state.players[state.activePlayer]!.name} goes first. Mulligans!`,
  )
  // the game stays in the 'mulligans' phase until every player keeps; the engine
  // calls startGame from finishMulligans at that point.
  return state
}
