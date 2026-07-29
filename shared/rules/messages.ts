/**
 * Enforced-mode wire protocol (client → server). Every field bounded (zod),
 * same discipline as the manual protocol in shared/schemas/messages.ts.
 *
 * Server → client is a full redacted state push per action ({ t: 'rstate' }) —
 * enforced 1v1 states are small, and full-state keeps the client trivially
 * correct (no delta reconciliation).
 */
import { z } from 'zod'
import type { RulesClientState } from './types'

const Id = z.string().min(1).max(64)

export const RulesMsg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('r.pass') }),
  // `back: true` plays the LAND back face of a modal double-faced card instead of casting its front
  z.object({ type: z.literal('r.playLand'), objId: Id, back: z.boolean().optional() }),
  z.object({
    type: z.literal('r.tapMana'),
    objId: Id,
    color: z.enum(['W', 'U', 'B', 'R', 'G', 'C']).optional(),
    // creatures sacrificed to pay a mana ability's "Sacrifice a creature" cost (the Altars)
    sacrifices: z.array(Id).max(20).optional(),
    // filter lands: which colour pays the hybrid cost, and which output pair to add
    payColor: z.enum(['W', 'U', 'B', 'R', 'G', 'C']).optional(),
    pair: z.number().int().min(0).max(9).optional(),
  }),
  z.object({
    type: z.literal('r.activate'),
    objId: Id,
    abilityIndex: z.number().int().min(0).max(15),
    targets: z.array(Id).max(8).default([]),
    // creatures sacrificed to pay a "Sacrifice a creature" cost (sac outlets);
    // optional so the many r.activate call sites without a sac cost need not pass it
    sacrifices: z.array(Id).max(20).optional(),
  }),
  z.object({
    type: z.literal('r.cast'),
    objId: Id,
    targets: z.array(Id).max(8).default([]),
    x: z.number().int().min(0).max(99).optional(), // chosen X for an {X} spell
    mode: z.number().int().min(0).max(9).optional(), // chosen mode for a modal spell
    // chosen modes for a MULTI-mode spell ("choose two" / "one or more"); the server re-validates
    // the count against the card's modeRule and rejects duplicates
    modes: z.array(z.number().int().min(0).max(9)).max(4).optional(),
    kicked: z.boolean().optional(), // whether the optional kicker cost was paid
    adventure: z.boolean().optional(), // cast the Adventure half (CR 715) rather than the creature
    convoke: z.array(Id).max(20).optional(), // creatures tapped to help pay via convoke (CR 702.51)
    retraceLand: Id.optional(), // land discarded as the additional retrace cost (CR 702.81)
    escapeExile: z.array(Id).max(20).optional(), // graveyard cards exiled as the escape cost (CR 702.139)
    buyback: z.boolean().optional(), // pay the buyback cost → return to hand on resolve (CR 702.27)
    bestow: z.boolean().optional(), // cast for the bestow cost as an Aura (CR 702.103)
    evoke: z.boolean().optional(), // cast for the evoke cost → sacrifice on enter (CR 702.74)
    overload: z.boolean().optional(), // cast for the overload cost → untargeted "each" body (CR 702.96)
    free: z.boolean().optional(), // cast without paying its mana cost (the "if you control a commander" cycle)
    // additional costs chosen as the spell is cast: permanents sacrificed / cards discarded
    sacrifices: z.array(Id).max(20).optional(),
    discards: z.array(Id).max(20).optional(),
    faceDown: z.boolean().optional(), // cast face down as a 2/2 for {3} (morph, CR 702.37)
  }),
  z.object({
    type: z.literal('r.attackers'),
    attacks: z.array(z.object({ attackerId: Id, defenderId: Id })).max(50),
  }),
  z.object({
    type: z.literal('r.blockers'),
    blocks: z.array(z.object({ blockerId: Id, attackerId: Id })).max(50),
  }),
  z.object({ type: z.literal('r.discard'), objIds: z.array(Id).max(20) }),
  z.object({ type: z.literal('r.chooseTargets'), targets: z.array(Id).max(8) }),
  z.object({
    type: z.literal('r.scry'),
    toBottom: z.array(Id).max(20),
    // Ponder-style reorder: the peeked cards in the order they go back on top, or a shuffle instead
    order: z.array(Id).max(20).optional(),
    shuffle: z.boolean().optional(),
  }),
  z.object({ type: z.literal('r.search'), cardIds: z.array(Id).max(20) }),
  z.object({ type: z.literal('r.sacrifice'), objIds: z.array(Id).max(20) }),
  z.object({ type: z.literal('r.equip'), equipmentId: Id, creatureId: Id }),
  z.object({ type: z.literal('r.cycle'), objId: Id }),
  // channel (the Kamigawa legendary lands): use the ability from your hand, discarding the card
  z.object({ type: z.literal('r.channel'), objId: Id, targets: z.array(Id).max(8).default([]) }),
  z.object({ type: z.literal('r.suspend'), objId: Id }), // suspend a card from hand (CR 702.62)
  z.object({ type: z.literal('r.madness'), cast: z.boolean(), targets: z.array(Id).max(8).default([]), mode: z.number().int().min(0).max(9).optional() }), // CR 702.35
  z.object({ type: z.literal('r.foretell'), objId: Id }), // foretell a card from hand (CR 702.143)
  z.object({ type: z.literal('r.morph'), objId: Id }), // turn a face-down permanent face up (CR 702.37)
  z.object({ type: z.literal('r.ward'), pay: z.boolean() }),
  // as-enters choice (CR 614.12, shocklands): pay the life, or the permanent enters tapped
  z.object({ type: z.literal('r.entersChoice'), pay: z.boolean() }),
  // "you may put a land card from your hand onto the battlefield" / Chrome Mox's imprint: the chosen
  // cards from your OWN hand (empty = decline, when the choice is optional)
  z.object({ type: z.literal('r.handChoice'), objIds: z.array(Id).max(4).default([]) }),
  // proliferate: any number of permanents and/or players that already have a counter
  z.object({
    type: z.literal('r.proliferate'),
    objIds: z.array(Id).max(64).default([]),
    playerIds: z.array(Id).max(4).default([]),
  }),
  // "As this permanent enters, choose a creature type." — a free-text type name, bounded to a plain
  // word or two (the printed card allows ANY creature type, so this is not a fixed enum)
  // "you may choose new targets for target spell or ability" (Deflecting Swat) — an empty list keeps
  // the current targets
  z.object({ type: z.literal('r.retarget'), targets: z.array(Id).max(8).default([]) }),
  // "…may draw up to two cards" (Arcane Denial)
  z.object({ type: z.literal('r.mayDraw'), count: z.number().int().min(0).max(4) }),
  // "you may reveal it and put it into your hand" (Herald's Horn)
  z.object({ type: z.literal('r.revealTop'), take: z.boolean() }),
  z.object({ type: z.literal('r.chooseType'), creatureType: z.string().trim().min(2).max(30).regex(/^[A-Za-z][A-Za-z' -]*$/) }),
  // "…unless that player pays {N}" (Rhystic Study / Esper Sentinel): pay, or the ability resolves
  z.object({ type: z.literal('r.optionalPay'), pay: z.boolean() }),
  // "put N cards from your hand on top of your library in any order" (Brainstorm) — first id = top
  z.object({ type: z.literal('r.putBack'), objIds: z.array(Id).max(20) }),
  z.object({ type: z.literal('r.cascade'), cast: z.boolean(), targets: z.array(Id).max(8).default([]), mode: z.number().int().min(0).max(9).optional() }),
  z.object({
    type: z.literal('r.loyalty'),
    objId: Id,
    abilityIndex: z.number().int().min(0).max(9),
    targets: z.array(Id).max(8).default([]),
  }),
  z.object({ type: z.literal('r.concede') }),

  // ---- London mulligan (pre-game) ----
  z.object({ type: z.literal('r.mulligan') }),
  z.object({ type: z.literal('r.keep'), toBottom: z.array(Id).max(20) }),

  // ---- manual overrides (assisted table): hand-run effects the engine can't ----
  z.object({
    type: z.literal('r.mMove'),
    objId: Id,
    // a card always moves to its OWNER's zone (battlefield uses the controller's
    // side); there is no "give to another player" move in the assisted table.
    zone: z.enum(['hand', 'battlefield', 'graveyard', 'exile', 'command', 'library']),
    pos: z.enum(['top', 'bottom']).optional(), // library placement
  }),
  z.object({ type: z.literal('r.mLife'), delta: z.number().int().min(-999).max(999) }),
  z.object({
    type: z.literal('r.mMana'),
    color: z.enum(['W', 'U', 'B', 'R', 'G', 'C']),
    delta: z.number().int().min(-99).max(99),
  }),
  z.object({ type: z.literal('r.mTap'), objId: Id, tapped: z.boolean() }),
  z.object({ type: z.literal('r.mDraw'), n: z.number().int().min(1).max(50) }),
  z.object({
    type: z.literal('r.mToken'),
    name: z.string().min(1).max(80),
    power: z.number().int().min(0).max(99).optional(),
    toughness: z.number().int().min(0).max(99).optional(),
    typeLine: z.string().max(120).optional(),
  }),
  z.object({
    type: z.literal('r.mCounter'),
    objId: Id,
    name: z.string().min(1).max(40),
    delta: z.number().int().min(-99).max(99),
  }),
])
export type RulesMsgT = z.infer<typeof RulesMsg>

export interface RulesStateMsg {
  t: 'rstate'
  state: RulesClientState
}
export interface RulesErrorMsg {
  t: 'rerror'
  code: string
  message: string
}
export type RulesServerMsg = RulesStateMsg | RulesErrorMsg
