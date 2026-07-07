/**
 * THE hidden-information keystone. Both the per-event redactor and the full
 * snapshot redactor go through visibleTo() — there is no other path by which
 * card identity reaches a client. See PLAN §4 "Hidden-information redaction".
 *
 * Rules:
 * - library contents/order: NEVER serialized to anyone (count only, owner included)
 * - hand: ids+identity to its owner; count-only to others (no ids at all)
 * - face-down cards in public zones: full to controller, presence-only to others
 * - revealedTo grants extra viewers on a hidden card
 * - peek contents: actor only
 */
import type {
  CardId,
  CardInstance,
  ClientGameState,
  Peek,
  PlayerId,
  RedactedCard,
  ServerGameState,
} from '#shared/types/game'

/** Does `viewer` currently see this card's identity? */
export function visibleTo(card: CardInstance, viewer: PlayerId, _state: ServerGameState): boolean {
  if (card.revealedTo?.includes(viewer)) return true
  switch (card.zone.kind) {
    case 'library':
      return false // never — not even the owner
    case 'hand':
      return card.zone.player === viewer
    case 'battlefield':
    case 'exile':
    case 'stack':
      return card.faceDown ? card.controllerId === viewer : true
    case 'graveyard':
    case 'command':
      return true
  }
}

/**
 * Does the viewer know this card instance EXISTS (gets its id)?
 * Hidden-zone cards are omitted entirely (counts carry the info); face-down
 * cards in public zones are present but identity-stripped.
 */
export function presentFor(card: CardInstance, viewer: PlayerId, state: ServerGameState): boolean {
  if (card.zone.kind === 'library') return false
  if (card.zone.kind === 'hand') return card.zone.player === viewer || visibleTo(card, viewer, state)
  return true
}

export function redactCard(
  card: CardInstance,
  viewer: PlayerId,
  state: ServerGameState,
): RedactedCard | null {
  if (!presentFor(card, viewer, state)) return null
  if (visibleTo(card, viewer, state)) {
    const display =
      (card.catalogId ? state.catalog[card.catalogId] : null) ??
      (card.tokenSpec?.fromCatalogId ? state.catalog[card.tokenSpec.fromCatalogId] : null) ??
      null
    return { ...card, display, hidden: false }
  }
  return {
    id: card.id,
    hidden: true,
    catalogId: null,
    tokenSpec: null,
    display: null,
    ownerId: card.ownerId,
    controllerId: card.controllerId,
    zone: card.zone,
    x: card.x,
    y: card.y,
    tapped: card.tapped,
    faceDown: card.faceDown,
    faceIndex: 0,
    counters: card.counters,
    attachedTo: card.attachedTo,
    isToken: card.isToken,
    isCommander: card.isCommander,
    commanderSlot: card.commanderSlot,
    revealedTo: null,
  }
}

export function redactPeek(
  peek: Peek | undefined,
  viewer: PlayerId,
  actor: PlayerId,
  state: ServerGameState,
): (Peek & { cards: RedactedCard[] }) | null {
  if (!peek || viewer !== actor) return null
  // Peek contents bypass zone rules by design (that's what a peek is) — actor only.
  const cards = peek.cardIds
    .map((id) => state.cards[id])
    .filter((c): c is CardInstance => !!c)
    .map((c) => {
      const display = c.catalogId ? (state.catalog[c.catalogId] ?? null) : null
      return { ...c, display, hidden: false as const }
    })
  return { ...peek, cards }
}

/**
 * PlayerState is public EXCEPT commanderIds: a commander tucked into a hidden
 * zone carries a re-minted id that must not reach other viewers (its slot
 * becomes null for them; commanderKey/tax tracking is slot-based and unaffected).
 */
export function redactPlayer(
  player: ServerGameState['players'][string],
  viewer: PlayerId,
  state: ServerGameState,
) {
  // No owner exemption: a commander in its owner's LIBRARY must not leak its id
  // even to the owner (library ids are never serialized, full stop). Hand ids
  // remain visible to the owner via presentFor.
  if (!player.commanderIds.some((id) => id && state.cards[id] && !presentFor(state.cards[id]!, viewer, state)))
    return player
  return {
    ...player,
    commanderIds: player.commanderIds.map((id) =>
      id && state.cards[id] && presentFor(state.cards[id]!, viewer, state) ? id : null,
    ),
  }
}

/** Full redacted snapshot for one viewer — the `sync` payload. */
export function redactStateFor(viewer: PlayerId, state: ServerGameState): ClientGameState {
  const cards: Record<CardId, RedactedCard> = {}
  for (const card of Object.values(state.cards)) {
    const r = redactCard(card, viewer, state)
    if (r) cards[r.id] = r
  }

  const perPlayer: ClientGameState['zones']['perPlayer'] = {}
  for (const [pid, zones] of Object.entries(state.zones.perPlayer)) {
    perPlayer[pid] = {
      battlefield: zones.battlefield,
      graveyard: zones.graveyard,
      exile: zones.exile,
      command: zones.command,
      hand: pid === viewer ? [...zones.hand] : { count: zones.hand.length },
      library: { count: zones.library.length },
    }
  }

  const players: ClientGameState['players'] = {}
  for (const [pid, p] of Object.entries(state.players)) players[pid] = redactPlayer(p, viewer, state)

  return {
    id: state.id,
    status: state.status,
    you: viewer,
    players,
    cards,
    zones: { perPlayer, stack: state.zones.stack },
    turn: state.turn,
    markers: state.markers,
    peek: redactPeek(state.peeks[viewer], viewer, viewer, state),
    winnerSeat: state.winnerSeat,
    seq: state.seq,
  }
}

/** viewer → set of card ids whose IDENTITY is visible (used for event deltas). */
export function visibilitySnapshot(state: ServerGameState): Map<PlayerId, Set<CardId>> {
  const out = new Map<PlayerId, Set<CardId>>()
  for (const pid of Object.keys(state.players)) {
    const set = new Set<CardId>()
    for (const card of Object.values(state.cards)) {
      if (presentFor(card, pid, state)) set.add(card.id)
    }
    out.set(pid, set)
  }
  return out
}
