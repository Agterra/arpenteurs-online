/**
 * A ready-to-play "sample deck" built ENTIRELY from cards the enforced rules
 * engine implements (server/rules/cards/starter.ts). Loading it and starting an
 * ENFORCED game is the quickest way to exercise the engine end to end — every
 * card runs with full rules (nothing falls back to the assisted table).
 *
 * Not a legal Commander deck (the app treats card-count / colour-identity /
 * singleton violations as warnings, never blockers) — it deliberately spans all
 * five colours so a single game touches every implemented mechanic: ramp/rocks,
 * spot + mass removal, exile, bounce, counters(+1/+1), tokens, anthems/lords,
 * aristocrat drains, ETB value, card draw, and a counterspell.
 */
export const SAMPLE_DECK_NAME = 'Engine Playtest (all implemented cards)'

export const SAMPLE_DECK_TEXT = `Commander
1 Jedit Ojanen

Deck
# Ramp & mana rocks
1 Sol Ring
1 Azorius Signet
1 Golgari Signet
1 Izzet Signet
1 Boros Signet
1 Manalith
1 Worn Powerstone
1 Thran Dynamo
1 Birds of Paradise
1 Llanowar Elves
1 Elvish Mystic
1 Fyndhorn Elves

# Spot removal & exile
1 Swords to Plowshares
1 Murder
1 Vindicate
1 Beast Within
1 Generous Gift
1 Mortify
1 Putrefy
1 Utter End
1 Anguished Unmaking
1 Disfigure
1 Grasp of Darkness
1 Flame Slash
1 Naturalize
1 Disenchant

# Burn
1 Shock
1 Lightning Bolt
1 Lightning Strike
1 Char
1 Lightning Helix

# Sweepers
1 Wrath of God
1 Day of Judgment
1 Pyroclasm

# Counter & bounce
1 Counterspell
1 Unsummon
1 Boomerang
1 Man-o'-War

# Card draw
1 Divination
1 Harmonize
1 Concentrate
1 Night's Whisper
1 Ambition's Cost
1 Mulldrifter
1 Elvish Visionary
1 Wall of Omens
1 Cloudblazer

# Tokens
1 Raise the Alarm
1 Midnight Haunting
1 Dragon Fodder
1 Krenko's Command

# Anthems & lords
1 Glorious Anthem
1 Gaea's Anthem
1 Goblin Chieftain
1 Field Marshal
1 Fervor

# Aristocrats & lifegain
1 Zulaport Cutthroat
1 Cruel Celebrant
1 Bastion of Remembrance
1 Soul Warden
1 Doomed Traveler

# +1/+1 counters
1 Cathars' Crusade
1 Gird for Battle
1 Bond Beetle

# ETB value & utility
1 Flametongue Kavu
1 Ravenous Chupacabra
1 Angel of Mercy
1 Prodigal Sorcerer
1 Impact Tremors
1 Crystal Ball
1 Jayemdae Tome

# Beaters & pump
1 Serra Angel
1 Shivan Dragon
1 Mahamoti Djinn
1 Vampire Nighthawk
1 Colossal Dreadmaw
1 Giant Spider
1 Boggart Brute
1 Air Elemental
1 Giant Growth
1 Titanic Growth

# Lands
5 Plains
4 Island
4 Swamp
4 Mountain
4 Forest
1 Azorius Guildgate
1 Dimir Guildgate
1 Rakdos Guildgate
1 Gruul Guildgate
1 Selesnya Guildgate
1 Golgari Guildgate
1 Izzet Guildgate
1 Boros Guildgate
1 Simic Guildgate
1 Orzhov Guildgate
1 Temple of Enlightenment
1 Temple of Deceit
1 Temple of Malice
1 Temple of Abandon
1 Temple of Plenty
`
