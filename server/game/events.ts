/**
 * Builds per-viewer wire events from an ActionResult + before/after visibility
 * snapshots, and renders hidden-info-safe log lines.
 *
 * Delta rule (PLAN §4): an event carries, per recipient, the full redacted card
 * objects for every card that changed or whose PRESENCE changed; ids that left
 * the viewer's knowable set are listed in `removed`. A card is NAMED in a log
 * line iff its identity is visible to that viewer before or after the action.
 */
import type { CardId, PlayerId, ServerGameState, ZoneKey } from '#shared/types/game'
import type { ClientMsgT, GameEventMsg, ZonePatch } from '#shared/schemas/messages'
import type { ActionResult } from './reducer'
import { presentFor, redactCard, redactPeek, redactPlayer, visibleTo } from './visibility'

export interface VisSnapshots {
  present: Map<PlayerId, Set<CardId>>
  identity: Map<PlayerId, Set<CardId>>
}

export function snapshotVis(state: ServerGameState): VisSnapshots {
  const present = new Map<PlayerId, Set<CardId>>()
  const identity = new Map<PlayerId, Set<CardId>>()
  for (const pid of Object.keys(state.players)) {
    const p = new Set<CardId>()
    const v = new Set<CardId>()
    for (const card of Object.values(state.cards)) {
      if (presentFor(card, pid, state)) p.add(card.id)
      if (visibleTo(card, pid, state)) v.add(card.id)
    }
    present.set(pid, p)
    identity.set(pid, v)
  }
  return { present, identity }
}

function zonePatchesFor(viewer: PlayerId, keys: string[], state: ServerGameState): ZonePatch[] {
  const out: ZonePatch[] = []
  for (const key of new Set(keys)) {
    if (key === 'stack') {
      out.push({ key, ids: state.zones.stack })
      continue
    }
    const [player, kind] = key.split(':') as [PlayerId, string]
    const zones = state.zones.perPlayer[player]
    if (!zones) continue
    if (kind === 'library') out.push({ key, count: zones.library.length })
    else if (kind === 'hand')
      out.push(player === viewer ? { key, ids: zones.hand } : { key, count: zones.hand.length })
    else out.push({ key, ids: zones[kind as 'battlefield' | 'graveyard' | 'exile' | 'command'] })
  }
  return out
}

export function buildEventFor(
  viewer: PlayerId,
  state: ServerGameState,
  actor: PlayerId,
  msg: ClientMsgT,
  result: ActionResult,
  before: VisSnapshots,
  after: VisSnapshots,
): GameEventMsg {
  const presentBefore = before.present.get(viewer) ?? new Set()
  const presentAfter = after.present.get(viewer) ?? new Set()

  const upsertIds = new Set<CardId>()
  for (const id of result.changed) if (presentAfter.has(id)) upsertIds.add(id)
  for (const id of presentAfter) if (!presentBefore.has(id)) upsertIds.add(id)
  const removed = [...presentBefore].filter((id) => !presentAfter.has(id))

  const ev: GameEventMsg = {
    t: 'event',
    seq: state.seq,
    ts: Date.now(),
    type: msg.type,
    actor,
    log: renderLog(viewer, state, actor, msg, result, before, after) ?? undefined,
  }
  if (upsertIds.size)
    ev.cards = [...upsertIds]
      .map((id) => state.cards[id] && redactCard(state.cards[id]!, viewer, state))
      .filter((c): c is NonNullable<typeof c> => !!c)
  if (removed.length) ev.removed = removed
  if (result.zones.length) ev.zones = zonePatchesFor(viewer, result.zones, state)
  if (result.players.length)
    ev.players = result.players.map((id) => ({ ...redactPlayer(state.players[id]!, viewer, state), id }))
  if (result.turn) ev.turn = state.turn
  if (result.markers) ev.markers = state.markers
  if (result.status) {
    ev.status = state.status
    ev.winnerSeat = state.winnerSeat
  }
  if (result.peek && viewer === actor)
    ev.peek = redactPeek(state.peeks[actor], viewer, actor, state)
  if (result.extra) {
    // hand.reveal targeted at specific players: contents only for them (+ the actor)
    const to = (result.extra as { to?: PlayerId[] | null }).to
    if (msg.type === 'hand.reveal' && Array.isArray(to) && viewer !== actor && !to.includes(viewer)) {
      // no contents for this viewer
    } else {
      ev.extra = result.extra
    }
  }
  return ev
}

// ---------- log rendering ----------

const STEP_LABEL: Record<string, string> = {
  untap: 'untap',
  upkeep: 'upkeep',
  draw: 'draw',
  main1: 'first main',
  combat_begin: 'begin combat',
  attackers: 'declare attackers',
  blockers: 'declare blockers',
  damage: 'combat damage',
  combat_end: 'end combat',
  main2: 'second main',
  end: 'end step',
  cleanup: 'cleanup',
}

function commanderName(state: ServerGameState, key: string): string {
  const [ownerId, slotStr] = key.split('#') as [PlayerId, string]
  const owner = state.players[ownerId]
  const cardId = owner?.commanderIds[Number(slotStr)]
  const card = cardId ? state.cards[cardId] : undefined
  const display = card?.catalogId ? state.catalog[card.catalogId] : undefined
  return display?.name ?? `${owner?.name ?? '?'}'s commander`
}

/**
 * Render the log line for one viewer. `null` viewer semantics are provided by
 * renderPublicLog below (public identities only) for DB persistence.
 */
export function renderLog(
  viewer: PlayerId | null,
  state: ServerGameState,
  actor: PlayerId,
  msg: ClientMsgT,
  result: ActionResult,
  before: VisSnapshots,
  after: VisSnapshots,
): string | null {
  const A = state.players[actor]?.name ?? 'Someone'
  const d = (result.log ?? {}) as Record<string, any>
  const knowsIdentity = (cardId: CardId | null): boolean => {
    if (!cardId || viewer === null) return false
    return (before.identity.get(viewer)?.has(cardId) ?? false) || (after.identity.get(viewer)?.has(cardId) ?? false)
  }

  switch (msg.type) {
    case 'game.concede':
      return `${A} conceded — their cards leave the game.`
    case 'game.finish':
      return d.winner ? `Game over — ${d.winner} wins!` : 'Game over.'
    case 'turn.next':
    case 'turn.setStep': {
      // a turn.next that wrapped into a new turn reads as a turn change, not a step
      if (msg.type === 'turn.next' && state.turn.step === 'untap')
        return `Turn ${state.turn.turnNumber} — ${state.players[state.turn.activePlayer]?.name}'s turn.`
      if (d.drew) return `${A} draws for the turn.`
      return `${A} — ${STEP_LABEL[state.turn.step] ?? state.turn.step}.`
    }
    case 'turn.pass':
      return `Turn ${state.turn.turnNumber} — ${state.players[state.turn.activePlayer]?.name}'s turn.`
    case 'player.life':
      return `${A} ${d.delta >= 0 ? 'gains' : 'loses'} ${Math.abs(d.delta)} life (${d.life}).`
    case 'player.poison':
      return `${A}'s poison: ${d.poison}.`
    case 'player.counter':
      return `${A}'s ${d.name} counters: ${d.delta >= 0 ? '+' : ''}${d.delta}.`
    case 'player.commanderDamage':
      return `${A} has taken ${d.total} damage from ${commanderName(state, d.commanderKey)}.`
    case 'player.commanderTax':
      return `${A}'s commander tax is now +${d.total * 2} mana.`
    case 'player.marker':
      return d.value === null
        ? `${A} cleared the ${d.marker} marker.`
        : `${A} set ${d.marker} → ${state.players[d.value as PlayerId]?.name ?? d.value}.`
    case 'mana.change':
    case 'mana.clear':
      return null // too noisy for the log; the mana pool widget shows it
    case 'deck.draw':
      return `${A} drew ${d.n} card${d.n > 1 ? 's' : ''}.`
    case 'deck.shuffle':
      return `${A} shuffled their library.`
    case 'deck.mulligan':
      return `${A} mulligans (mulligan #${d.mull}).`
    case 'deck.keep':
      return `${A} keeps ${d.kept}${d.bottomed ? `, bottoms ${d.bottomed}` : ''}.`
    case 'deck.scry':
      return `${A} is scrying ${d.n}…`
    case 'deck.look':
      return `${A} looks at the top ${d.n} card${d.n > 1 ? 's' : ''}…`
    case 'deck.search':
      return `${A} is searching their library…`
    case 'peek.resolve':
      if (d.mode === 'search') return `${A} took ${d.moved} card${d.moved === 1 ? '' : 's'} and shuffled.`
      if (d.mode === 'scry') return `${A} scried (${d.toTop} on top, ${d.toBottom} on the bottom${d.moved ? `, ${d.moved} moved out` : ''}).`
      return `${A} put the cards back${d.moved ? ` (${d.moved} moved out)` : ''}.`
    case 'peek.cancel':
      return d.shuffled ? `${A} closed the search and shuffled.` : `${A} put the cards back.`
    case 'deck.revealTop':
      return `${A} revealed the top ${d.n}: ${(d.names as string[]).join(', ')}.`
    case 'hand.reveal': {
      const to = d.to as PlayerId[] | null
      const targeted = to && viewer !== null && viewer !== actor && !to.includes(viewer)
      if (targeted || (to && viewer === null))
        return `${A} revealed their hand to ${to!.map((p) => state.players[p]?.name ?? '?').join(', ')}.`
      return `${A} revealed their hand: ${(d.names as string[]).join(', ')}.`
    }
    case 'card.move': {
      const name = knowsIdentity(d.cardId) || (d.deleted && d.name) ? d.name : null
      const what = name ?? 'a card'
      const toPlace = d.toPlayer && d.toPlayer !== actor ? `${state.players[d.toPlayer]?.name}'s ${d.to}` : d.to
      if (d.commanderTax != null)
        return `${A} casts ${d.name ?? 'their commander'} from the command zone (tax now +${d.commanderTax * 2}).`
      if (d.deleted) return `${A}'s ${d.name ?? 'token'} ceased to exist.`
      if (d.from === 'hand' && d.to === 'battlefield') return `${A} played ${what}.`
      if (d.to === 'library') return `${A} put ${what} ${d.index === 0 || d.index === 'top' ? 'on top of' : d.index === 'bottom' ? 'on the bottom of' : 'into'} their library.`
      return `${A} moved ${what} from ${d.from} to ${toPlace}.`
    }
    case 'card.tap':
      return `${A} ${d.tapped ? 'tapped' : 'untapped'} ${d.n} card${d.n > 1 ? 's' : ''}.`
    case 'board.untapAll':
      return `${A} untapped everything (${d.n}).`
    case 'card.face':
      if (d.faceDown) return `${A} turned a card face down.`
      return d.name ? `${A} turned ${d.name} face up.` : `${A} flipped a card.`
    case 'card.counter': {
      const name = d.name && knowsIdentity(result.changed[0] ?? null) ? d.name : d.name ?? 'a card'
      return `${A} ${d.delta >= 0 ? 'added' : 'removed'} ${Math.abs(d.delta)} ${d.counter} counter${Math.abs(d.delta) > 1 ? 's' : ''} ${d.delta >= 0 ? 'to' : 'from'} ${name} (${d.total}).`
    }
    case 'card.attach':
      return d.attached ? `${A} attached a card.` : `${A} unattached a card.`
    case 'card.control':
      return `${A} gave control of ${d.name ?? 'a card'} to ${state.players[d.toPlayer]?.name ?? '?'}.`
    case 'card.reveal': {
      const to = d.to as PlayerId[] | null
      if (to && viewer !== null && viewer !== actor && !to.includes(viewer))
        return `${A} revealed a card to ${to.map((p) => state.players[p]?.name ?? '?').join(', ')}.`
      if (to && viewer === null) return `${A} revealed a card to ${to.map((p) => state.players[p]?.name ?? '?').join(', ')}.`
      return `${A} revealed ${d.name ?? 'a card'}.`
    }
    case 'token.create':
      return `${A} created ${d.n} ${d.name}${d.pt ? ` (${d.pt})` : ''} token${d.n > 1 ? 's' : ''}${d.zone === 'stack' ? ' on the stack' : ''}.`
    case 'chat.send':
      return `${A}: ${d.text}`
    case 'game.roll':
      return `${A} rolled d${d.sides}: ${(d.results as number[]).join(', ')}.`
    case 'game.coin':
      return `${A} flipped: ${(d.results as string[]).join(', ')}.`
    default:
      return null
  }
}

/** Public (spectator-grade) line for DB persistence + per-seat private lines when they differ. */
export function renderPersistedLog(
  state: ServerGameState,
  actor: PlayerId,
  msg: ClientMsgT,
  result: ActionResult,
  before: VisSnapshots,
  after: VisSnapshots,
): { publicLine: string | null; privateLines: Record<number, string> | null } {
  const publicLine = renderLog(null, state, actor, msg, result, before, after)
  const privateLines: Record<number, string> = {}
  for (const p of Object.values(state.players)) {
    const line = renderLog(p.id, state, actor, msg, result, before, after)
    if (line !== publicLine && line !== null) privateLines[p.seat] = line
  }
  return { publicLine, privateLines: Object.keys(privateLines).length ? privateLines : null }
}
