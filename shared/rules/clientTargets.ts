/**
 * Which client picker resolves each implemented spell's targets, keyed by normalized card name.
 *
 * The enforced board can't derive this from the card definitions (they live server-side, and their
 * effects are functions), so it is curated here — and `tests/unit/rules-client-contract.spec.ts`
 * asserts EVERY implemented targeted spell appears in exactly one of these maps. Without that
 * guard a new targeted card silently ships uncastable: `startCast` would fall through to the
 * payment panel with zero targets and the server would reject the cast with BAD_TARGETS.
 *
 * Kept out of DuelBoard.vue purely so the test can import it; the component is the only consumer.
 */
export type TargetClass = 'any' | 'creature' | 'permanent' | 'spell' | 'player'

/** Single-target spells: one click of the matching class, then the payment panel. */
export const TARGETED_SPELLS: Record<string, TargetClass> = {
  shock: 'any',
  'lightning bolt': 'any',
  char: 'any',
  'lightning helix': 'any',
  'lightning strike': 'any',
  'volcanic hammer': 'any',
  'fiery temper': 'any', // also castable for its madness cost (CR 702.35)
  firebolt: 'any', // and again from the graveyard via flashback
  "raven's crime": 'player', // and again via retrace
  murder: 'creature',
  terminate: 'creature',
  'go for the throat': 'creature',
  pongify: 'creature',
  'rapid hybridization': 'creature',
  disfigure: 'creature',
  'grasp of darkness': 'creature',
  'swords to plowshares': 'creature',
  'path to exile': 'creature',
  'infernal grasp': 'creature',
  'deadly rollick': 'creature', // exile target creature (also castable free)
  'gird for battle': 'creature',
  unsummon: 'creature',
  'flame slash': 'creature',
  'giant growth': 'creature',
  'titanic growth': 'creature',
  ovinize: 'creature',
  damn: 'creature', // overloaded, it destroys each creature (no target — the Overload button)
  counterspell: 'spell',
  cancel: 'spell',
  negate: 'spell',
  "an offer you can't refuse": 'spell',
  'swan song': 'spell', // enchantment / instant / sorcery only (the server enforces the filter)
  'fierce guardianship': 'spell', // noncreature spell (also castable free — see ALT_TARGET_CLASS)
  "dovin's veto": 'spell', // noncreature spell; itself uncounterable
  vindicate: 'permanent',
  'beast within': 'permanent',
  'generous gift': 'permanent',
  naturalize: 'permanent',
  disenchant: 'permanent',
  mortify: 'permanent',
  putrefy: 'permanent',
  'utter end': 'permanent',
  'anguished unmaking': 'permanent',
  "hero's downfall": 'permanent', // creature or planeswalker (server enforces the filter)
  boomerang: 'permanent',
  capsize: 'permanent',
  'feed the swarm': 'permanent', // creature or enchantment an opponent controls
  'chaos warp': 'permanent', // any permanent — its owner shuffles it away
  'cyclonic rift': 'permanent', // nonland permanent you don't control
  'stroke of midnight': 'permanent', // nonland permanent; its controller gets a 1/1 Human
  'withering torment': 'permanent', // creature or enchantment
  "nature's claim": 'permanent', // artifact or enchantment; its controller gains 4 life
  despark: 'permanent', // mana value 4 or greater
  vandalblast: 'permanent', // artifact you don't control
  'diabolic edict': 'player',
  'sign in blood': 'player',
  // Auras enchant a creature (they attach to their target on resolution)
  'unholy strength': 'creature',
  'holy strength': 'creature',
  'angelic gift': 'creature',
  pacifism: 'creature',
  blaze: 'any', // {X} damage to any target
  'burst lightning': 'any', // 2 (or 4 if kicked) damage to any target
  'mind rot': 'player',
  'tome scour': 'player',
  'mind sculpt': 'player',
  'thought scour': 'player',
  'marsh casualties': 'player', // -1/-1 (or -2/-2 if kicked) to a player's creatures
}

/**
 * Spells whose X is paid in LIFE as an additional cost, not in mana (Toxic Deluge). The client must
 * still show its X stepper for these even though the mana cost has no {X}, and send `r.cast.x`;
 * rules-client-contract.spec.ts asserts every implemented `additionalLifeCostX` card is listed.
 */
export const LIFE_X_SPELLS: Record<string, string> = {
  'toxic deluge': 'X life', // all creatures get -X/-X
}

/** Modal ("choose one") spells: per-mode label + the target class that mode needs. */
export const MODAL_SPELLS: Record<string, { label: string; spec: TargetClass | null }[]> = {
  abrade: [
    { label: 'Deal 3 damage to target creature', spec: 'creature' },
    { label: 'Destroy target artifact', spec: 'permanent' },
  ],
  'gods willing': [
    { label: 'Protection from white', spec: 'creature' },
    { label: 'Protection from blue', spec: 'creature' },
    { label: 'Protection from black', spec: 'creature' },
    { label: 'Protection from red', spec: 'creature' },
    { label: 'Protection from green', spec: 'creature' },
  ],
}

/** Multi-target spells (ordered slots) — fight spells: your creature, then theirs. */
export type FightSlot = 'your-creature' | 'opp-creature'
export const MULTI_TARGET_SPELLS: Record<string, FightSlot[]> = {
  pounce: ['your-creature', 'opp-creature'],
  'prey upon': ['your-creature', 'opp-creature'],
}

/**
 * Graveyard-recursion spells → whether the target must be a creature card. LIMITATION: the picker
 * shows only the CASTER's own graveyard, so Reanimate ("target creature card in A graveyard") is
 * offered as your-graveyard-only; the server accepts any graveyard.
 */
export const GRAVEYARD_SPELLS: Record<string, 'creature' | 'any'> = {
  'raise dead': 'creature',
  regrowth: 'any',
  reanimate: 'creature',
}
