import { createGameFromLobby } from '../../../game/lifecycle'
import { findDef } from '../../../rules/cards/registry'
import { defIsValidCommander } from '../../../rules/cards/dsl'

type StartErrorCode = 'NO_DECK' | 'NO_COMMANDER' | 'NOT_READY' | 'BAD_COMMANDER'
interface StartError {
  seat: number
  code: StartErrorCode
  message: string
}

export default defineEventHandler(async (event) => {
  const me = await requireUser(event)
  const lobby = await getLobbyByCode(getRouterParam(event, 'code')!)

  if (lobby.hostId !== me.id)
    throw createError({ statusCode: 403, statusMessage: 'Only the host can start the game' })
  if (lobby.status !== 'OPEN')
    throw createError({ statusCode: 409, statusMessage: 'Lobby is not open' })

  const seats = await db.lobbySeat.findMany({
    where: { lobbyId: lobby.id },
    orderBy: { seatIndex: 'asc' },
  })
  if (seats.length < 1)
    throw createError({ statusCode: 422, statusMessage: 'Nobody is seated' })

  const enforced = lobby.mode === 'ENFORCED'
  if (enforced && (seats.length < 2 || seats.length > 4))
    throw createError({
      statusCode: 422,
      statusMessage: 'Enforced Commander needs 2–4 players',
      data: { errors: [{ code: 'NEED_2_TO_4_PLAYERS' }] },
    })

  const deckIds = [...new Set(seats.map((s) => s.deckId).filter((id): id is string => !!id))]
  // commander rows per deck; enforced mode also needs the type line to confirm
  // the commander is a legendary creature (it need NOT be fully implemented —
  // the assisted table runs unimplemented cards manually).
  const commanderRows = deckIds.length
    ? await db.deckCard.findMany({
        where: { deckId: { in: deckIds }, section: 'COMMANDER' },
        select: { deckId: true, card: { select: { name: true, typeLine: true } } },
      })
    : []
  const commandersByDeck = new Map<string, { name: string; typeLine: string }[]>()
  for (const r of commanderRows)
    (commandersByDeck.get(r.deckId) ?? commandersByDeck.set(r.deckId, []).get(r.deckId)!).push(r.card)

  const isLegendaryCreature = (typeLine: string, name: string) => {
    const def = findDef(name)
    if (def && defIsValidCommander(def)) return true
    const t = typeLine.toLowerCase()
    return t.includes('legendary') && t.includes('creature')
  }

  const errors: StartError[] = []
  for (const seat of seats) {
    const s = seat.seatIndex
    if (!seat.deckId) errors.push({ seat: s, code: 'NO_DECK', message: 'Pick a deck.' })
    else {
      const cmds = commandersByDeck.get(seat.deckId) ?? []
      if (cmds.length === 0)
        errors.push({ seat: s, code: 'NO_COMMANDER', message: 'This deck has no commander (add a “Commander” section to the decklist).' })
      else if (enforced) {
        if (cmds.length !== 1)
          errors.push({ seat: s, code: 'BAD_COMMANDER', message: 'Enforced mode allows exactly one commander (no partners yet).' })
        else if (!isLegendaryCreature(cmds[0]!.typeLine, cmds[0]!.name))
          errors.push({
            seat: s,
            code: 'BAD_COMMANDER',
            message: `“${cmds[0]!.name}” isn’t a legendary creature, so it can’t be a commander.`,
          })
      }
    }
    if (!seat.isReady) errors.push({ seat: s, code: 'NOT_READY', message: 'Not ready.' })
  }
  if (errors.length)
    throw createError({ statusCode: 422, statusMessage: 'Lobby is not ready to start', data: { errors } })
  // Unimplemented cards no longer block: the assisted table runs them manually
  // (fallback bodies + manual overrides). Coverage grows over time.

  // Optimistic concurrency guard: only one start wins the OPEN → STARTING flip.
  const flipped = await db.lobby.updateMany({
    where: { id: lobby.id, status: 'OPEN' },
    data: { status: 'STARTING' },
  })
  if (flipped.count === 0)
    throw createError({ statusCode: 409, statusMessage: 'Start already in progress' })

  try {
    const { gameId } = await createGameFromLobby(lobby.id)
    await db.lobby.update({ where: { id: lobby.id }, data: { status: 'IN_GAME' } })
    return { gameId }
  } catch (err) {
    // Roll back so the lobby is joinable/startable again.
    await db.lobby.updateMany({
      where: { id: lobby.id, status: 'STARTING' },
      data: { status: 'OPEN' },
    })
    throw err
  }
})
