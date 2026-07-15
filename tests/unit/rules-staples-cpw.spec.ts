/**
 * Combat vs planeswalkers: an attacker may be declared against an opponent's
 * planeswalker; unblocked combat damage removes that much loyalty (CR 120.3c), a
 * planeswalker at 0 loyalty dies (SBA), a blocked attacker deals it nothing, and a
 * commander attacking a planeswalker deals loyalty damage (NOT commander damage).
 */
import { describe, expect, it } from 'vitest'
import { act, commanderObj, makeDuel, putCard, until } from './rules-helpers.ts'
import { redactRulesState } from '../../server/rules/redact.ts'

type St = ReturnType<typeof makeDuel>['state']
function putPW(state: St, p: string, name: string, loyalty: number) {
  const id = putCard(state, p, name, 'battlefield')
  state.objects[id]!.loyalty = loyalty
  return id
}
const toAttackers = (state: St, A: string) =>
  until(state, (s) => s.pending?.kind === 'attackers' && s.pending.player === A, 'A declares attackers')
const toPostCombat = (state: St, A: string) =>
  until(state, (s) => s.step === 'main2' && s.priorityPlayer === A && !s.zones.stack.length, 'post-combat main2')

describe('attacking a planeswalker', () => {
  it('unblocked combat damage removes loyalty', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield') // 2/2
    const pw = putPW(state, B, 'Nissa, Voice of Zendikar', 3)
    toAttackers(state, A)
    act(state, A, { type: 'r.attackers', attacks: [{ attackerId: bear, defenderId: pw }] })
    toPostCombat(state, A)
    expect(state.objects[pw]!.loyalty).toBe(1) // 3 − 2
    expect(state.players[B]!.life).toBe(40) // the player took no damage
  })

  it('kills the planeswalker when loyalty reaches 0', () => {
    const { state, A, B } = makeDuel()
    const giant = putCard(state, A, 'Hill Giant', 'battlefield') // 3/3
    const pw = putPW(state, B, 'Nissa, Voice of Zendikar', 3)
    toAttackers(state, A)
    act(state, A, { type: 'r.attackers', attacks: [{ attackerId: giant, defenderId: pw }] })
    toPostCombat(state, A)
    expect(state.objects[pw]!.zone).toBe('graveyard')
  })

  it('deals nothing to the planeswalker when the attacker is blocked', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const blocker = putCard(state, B, 'Gray Ogre', 'battlefield') // 2/2
    const pw = putPW(state, B, 'Nissa, Voice of Zendikar', 3)
    toAttackers(state, A)
    act(state, A, { type: 'r.attackers', attacks: [{ attackerId: bear, defenderId: pw }] })
    until(state, (s) => s.pending?.kind === 'blockers' && s.pending.player === B, 'B declares blockers')
    act(state, B, { type: 'r.blockers', blocks: [{ blockerId: blocker, attackerId: bear }] })
    toPostCombat(state, A)
    expect(state.objects[pw]!.loyalty).toBe(3) // absorbed by the blocker
  })

  // regression (adversarial review): lifelink must not gain life when the attacked
  // planeswalker already left combat (killed by a first-strike attacker this combat)
  it('lifelink gains nothing when the attacked planeswalker died in the first-strike step', () => {
    const { state, A, B } = makeDuel()
    const knight = putCard(state, A, 'Youthful Knight', 'battlefield') // 2/2 first strike
    const hawk = putCard(state, A, 'Vampire Nighthawk', 'battlefield') // 2/3 lifelink, no first strike
    const pw = putPW(state, B, 'Nissa, Voice of Zendikar', 2)
    toAttackers(state, A)
    act(state, A, {
      type: 'r.attackers',
      attacks: [{ attackerId: knight, defenderId: pw }, { attackerId: hawk, defenderId: pw }],
    })
    toPostCombat(state, A)
    expect(state.objects[pw]!.zone).toBe('graveyard') // Knight's first strike killed the L2 PW
    expect(state.players[A]!.life).toBe(40) // Nighthawk's regular damage landed on nothing → no lifelink
  })

  // regression (adversarial review): clients must be able to tell an attack targets a PW
  it('surfaces attackingPwId so an attack on a planeswalker is distinguishable to both viewers', () => {
    const { state, A, B } = makeDuel()
    const bear = putCard(state, A, 'Grizzly Bears', 'battlefield')
    const pw = putPW(state, B, 'Nissa, Voice of Zendikar', 3)
    toAttackers(state, A)
    act(state, A, { type: 'r.attackers', attacks: [{ attackerId: bear, defenderId: pw }] })
    expect(redactRulesState(state, A).cards[bear]!.attackingPwId).toBe(pw)
    expect(redactRulesState(state, B).cards[bear]!.attackingPwId).toBe(pw)
  })

  it('a commander attacking a planeswalker deals loyalty damage, not commander damage', () => {
    const { state, A, B } = makeDuel()
    const cmd = commanderObj(state, A)
    act(state, A, { type: 'r.mMove', objId: cmd, zone: 'battlefield' }) // put the commander onto the field
    state.objects[cmd]!.summoningSick = false
    const pw = putPW(state, B, 'Nissa, Voice of Zendikar', 3)
    toAttackers(state, A)
    act(state, A, { type: 'r.attackers', attacks: [{ attackerId: cmd, defenderId: pw }] })
    toPostCombat(state, A)
    expect(state.objects[pw]!.loyalty).toBeLessThan(3) // loyalty was removed
    expect(state.players[B]!.life).toBe(40) // no life lost
    expect(Object.values(state.players[B]!.commanderDamage).some((d) => d > 0)).toBe(false) // no commander damage
  })
})
