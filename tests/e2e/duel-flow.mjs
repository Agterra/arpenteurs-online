/**
 * End-to-end smoke for ENFORCED (rules-engine) COMMANDER games, 4 players:
 * claim users → import commander decks (each holds an UNIMPLEMENTED card) →
 * enforced lobby (mode, 4 seats) → BAD_COMMANDER rejection → the assisted table
 * ACCEPTS unimplemented cards (no block) → start → ws rstate protocol (40 life,
 * command zone) → London mulligan (one player mulligans + bottoms, rest keep) →
 * APNAP drive to a main phase → play a land → assisted-table
 * manual overrides over the wire (life/mana/token/counter/move) → rule-800.4a
 * elimination via concede (game continues) → last player wins → lobby reopens.
 * Asserts hidden-information discipline on every payload.
 *
 * Run: node tests/e2e/duel-flow.mjs [baseUrl]   (default http://localhost:3995)
 */
import { WebSocket } from 'ws'

const BASE = process.argv[2] ?? 'http://localhost:3995'
const WS_BASE = BASE.replace(/^http/, 'ws')
let failures = 0

function check(cond, label) {
  if (cond) console.log(`  ✔ ${label}`)
  else {
    console.error(`  ✘ FAIL: ${label}`)
    failures++
  }
}

async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const setCookie = res.headers.get('set-cookie')
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, json, cookie: setCookie ? setCookie.split(';')[0] : cookie }
}

// distinct real legendary creatures, all in the enforced starter pool
const COMMANDERS = [
  'Jerrard of the Closed Fist',
  'Barktooth Warbeard',
  'Marhault Elsdragon',
  'Isamaru, Hound of Konda',
]
// each deck carries one UNIMPLEMENTED card (Sol Ring) — the assisted table must
// still start the game and give it a catalog-derived body run manually.
const deckText = (cmd) =>
  `Commander:\n1 ${cmd}\n\nDeck:\n39 Mountain\n1 Sol Ring\n5 Gray Ogre\n5 Hill Giant\n5 Shock\n5 Lightning Bolt`

async function setupPlayer(name, commander) {
  const claim = await api(null, '/api/auth/claim', { method: 'POST', body: { username: name } })
  check(claim.status === 200 && claim.cookie, `${name}: claimed username`)
  const imp = await api(claim.cookie, '/api/decks/import', {
    method: 'POST',
    body: { name: `${name}'s deck`, text: deckText(commander), commit: true },
  })
  check(imp.status === 200 && imp.json.deckId, `${name}: commander deck imported`)
  return { name, cookie: claim.cookie, deckId: imp.json.deckId }
}

function wsClient(name, cookie, gameId) {
  const ws = new WebSocket(`${WS_BASE}/ws/game?g=${gameId}`, { headers: { cookie, origin: BASE } })
  const client = { name, ws, states: [], raws: [], rerrors: [] }
  ws.on('message', (data) => {
    const text = data.toString()
    if (text === 'pong') return
    const msg = JSON.parse(text)
    if (msg.t === 'rstate') {
      client.states.push(msg.state)
      client.raws.push(text)
    } else if (msg.t === 'rerror') client.rerrors.push(msg)
  })
  client.send = (obj) => ws.send(JSON.stringify(obj))
  client.latest = () => client.states.at(-1)
  client.waitFor = (pred, label, ms = 5000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        const hit = pred(client)
        if (hit) {
          clearInterval(iv)
          resolve(hit)
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv)
          reject(new Error(`${name}: timeout waiting for ${label}`))
        }
      }, 25)
    })
  return client
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  console.log('— players & commander decks —')
  const players = []
  for (let i = 0; i < 4; i++) players.push(await setupPlayer(`Cmd${i}`, COMMANDERS[i]))
  const [host] = players

  console.log('— enforced lobby (2–4 players) —')
  const create = await api(host.cookie, '/api/lobbies', {
    method: 'POST',
    body: { name: 'e2e commander', visibility: 'UNLISTED', mode: 'ENFORCED' },
  })
  const lobby = create.json.lobby
  const code = lobby?.inviteCode
  check(create.status === 200 && code, 'host created an enforced lobby')
  check(lobby?.mode === 'ENFORCED', `lobby carries mode (${lobby?.mode})`)
  check(lobby?.maxSeats === 4, `enforced Commander allows 4 seats (${lobby?.maxSeats})`)

  for (const p of players.slice(1)) {
    const join = await api(p.cookie, `/api/lobbies/${code}/join`, { method: 'POST', body: {} })
    check(join.status === 200, `${p.name} joined`)
  }
  for (const p of players) {
    const ready = await api(p.cookie, `/api/lobbies/${code}/me`, {
      method: 'PATCH',
      body: { deckId: p.deckId, isReady: true },
    })
    check(ready.status === 200, `${p.name}: readied with a commander deck`)
  }

  console.log('— start-gate rejections —')
  // BAD_COMMANDER: a deck whose commander is not a legendary creature
  const badCmd = await api(host.cookie, '/api/decks/import', {
    method: 'POST',
    body: { name: 'bad commander', text: 'Commander:\n1 Grizzly Bears\n\nDeck:\n40 Mountain', commit: true },
  })
  await api(host.cookie, `/api/lobbies/${code}/me`, {
    method: 'PATCH',
    body: { deckId: badCmd.json.deckId, isReady: true },
  })
  const badCmdStart = await api(host.cookie, `/api/lobbies/${code}/start`, { method: 'POST', body: {} })
  check(
    badCmdStart.status === 422 && badCmdStart.json?.data?.errors?.some((e) => e.code === 'BAD_COMMANDER'),
    `non-legendary commander blocked with BAD_COMMANDER (${badCmdStart.status})`,
  )
  check(
    !badCmdStart.json?.data?.errors?.some((e) => e.code === 'UNIMPLEMENTED_CARDS'),
    'assisted table no longer rejects unimplemented cards (UNIMPLEMENTED_CARDS gone)',
  )
  // restore the host's real (assisted-table) deck — it contains a Sol Ring, which
  // must NOT block the start
  await api(host.cookie, `/api/lobbies/${code}/me`, {
    method: 'PATCH',
    body: { deckId: host.deckId, isReady: true },
  })

  console.log('— start —')
  const start = await api(host.cookie, `/api/lobbies/${code}/start`, { method: 'POST', body: {} })
  const gameId = start.json?.gameId
  check(start.status === 200 && gameId, `enforced Commander game started: ${gameId}`)

  console.log('— websocket: rstate for 4 players —')
  const clients = players.map((p) => wsClient(p.name, p.cookie, gameId))
  for (const c of clients) await c.waitFor((x) => x.states.length > 0, `${c.name} first rstate`)

  console.log('— London mulligan phase —')
  const m0 = clients[0].latest()
  check(m0.status === 'mulligans', `game opens in the mulligan phase (${m0.status})`)
  for (const c of clients) {
    const s = c.latest()
    check(s.players[s.you].life === 40, `${c.name}: 40 starting life`)
    const myHand = s.zones.perPlayer[s.you].hand
    check(Array.isArray(myHand) && myHand.length === 7, `${c.name}: own 7-card hand as ids`)
    check(s.zones.perPlayer[s.you].command.length === 1, `${c.name}: a commander in the command zone`)
    const others = s.turnOrder.filter((p) => p !== s.you)
    check(
      others.every((p) => !Array.isArray(s.zones.perPlayer[p].hand)),
      `${c.name}: every opponent hand is count-only`,
    )
  }
  // one player mulligans once (then bottoms 1), the rest keep 7
  const muller = clients[0]
  const before = muller.latest().seq
  muller.send({ type: 'r.mulligan' })
  await muller.waitFor((c) => c.latest().seq > before && c.latest().players[c.latest().you].mullCount === 1, 'mulliganed')
  check(muller.latest().zones.perPlayer[muller.latest().you].hand.length === 7, 'mulligan redraws seven')
  const mHand = muller.latest().zones.perPlayer[muller.latest().you].hand
  muller.send({ type: 'r.keep', toBottom: [mHand[0]] }) // bottom exactly mullCount (1)
  for (const c of clients.slice(1)) c.send({ type: 'r.keep', toBottom: [] })
  for (const c of clients) await c.waitFor((x) => x.latest().status === 'active', `${c.name} sees active`)
  check(muller.latest().zones.perPlayer[muller.latest().you].hand.length === 6, 'muller kept six after one mulligan')

  const s0 = clients[0].latest()
  check(s0.status === 'active', 'game active after everyone keeps')
  check(s0.turnOrder.length === 4, `4 players in turn order (${s0.turnOrder.length})`)

  console.log('— APNAP drive to a land play —')
  const clientFor = (pid) => clients.find((c) => c.latest().you === pid)
  let landed = false
  for (let i = 0; i < 80 && !landed; i++) {
    const s = clients[0].latest()
    if (s.status !== 'active') break
    const holder = s.priorityPlayer ? clientFor(s.priorityPlayer) : null
    if (!holder) {
      // a pending declaration (unlikely this early) — auto-empty it
      const pend = clients.find((c) => c.latest().legal.needsAttackers || c.latest().legal.needsBlockers)
      if (pend?.latest().legal.needsAttackers) pend.send({ type: 'r.attackers', attacks: [] })
      else if (pend?.latest().legal.needsBlockers) pend.send({ type: 'r.blockers', blocks: [] })
      await sleep(40)
      continue
    }
    const hs = holder.latest()
    if (hs.legal.playableLandIds.length) {
      const activeId = hs.you
      const landId = hs.legal.playableLandIds[0]
      const seq = hs.seq
      holder.send({ type: 'r.playLand', objId: landId })
      await holder.waitFor((c) => c.latest().seq > seq, 'land played')
      // visible to every player (public zone)
      for (const c of clients)
        await c.waitFor((x) => x.latest().zones.perPlayer[activeId].battlefield.includes(landId), `${c.name} sees land`)
      check(true, `active player ${holder.name} played a land, visible to all 4`)
      landed = true
      break
    }
    const seq = hs.seq
    holder.send({ type: 'r.pass' })
    await holder.waitFor((c) => c.latest().seq > seq, 'pass applied').catch(() => {})
  }
  check(landed, 'reached a main phase and played a land')

  if (landed) {
    console.log('— assisted-table manual overrides over the wire —')
    // the player who just played a land is still at priority in their main phase
    const actorId = clients[0].latest().activePlayer
    const actor = clientFor(actorId)
    const seq0 = actor.latest().seq
    const life0 = actor.latest().players[actorId].life

    actor.send({ type: 'r.mLife', delta: 2 })
    await actor.waitFor((c) => c.latest().players[actorId].life === life0 + 2, 'manual life change')
    check(actor.latest().players[actorId].life === life0 + 2, 'r.mLife adjusted your own life')

    actor.send({ type: 'r.mMana', color: 'C', delta: 3 })
    await actor.waitFor((c) => c.latest().players[actorId].manaPool.C >= 3, 'manual mana')
    check(actor.latest().players[actorId].manaPool.C >= 3, 'r.mMana added colorless to your pool')

    const bfBefore = actor.latest().zones.perPlayer[actorId].battlefield.length
    actor.send({ type: 'r.mToken', name: 'Zombie', power: 2, toughness: 2, typeLine: 'Token Creature — Zombie' })
    await actor.waitFor(
      (c) => c.latest().zones.perPlayer[actorId].battlefield.length === bfBefore + 1,
      'token created',
    )
    const tokenId = actor.latest().zones.perPlayer[actorId].battlefield.at(-1)
    check(actor.latest().cards[tokenId]?.unimplemented === true, 'r.mToken made an unimplemented (manual) token')
    for (const c of clients) await c.waitFor((x) => !!x.latest().cards[tokenId], `${c.name} sees the token`)
    check(clients.every((c) => !!c.latest().cards[tokenId]), 'token is public (visible to all 4 players)')

    actor.send({ type: 'r.mCounter', objId: tokenId, name: '+1/+1', delta: 2 })
    await actor.waitFor((c) => c.latest().cards[tokenId]?.counters?.['+1/+1'] === 2, 'counter added')
    check(actor.latest().cards[tokenId]?.counters?.['+1/+1'] === 2, 'r.mCounter placed +1/+1 counters')

    actor.send({ type: 'r.mMove', objId: tokenId, zone: 'graveyard' })
    await actor.waitFor(
      (c) => !c.latest().zones.perPlayer[actorId].battlefield.includes(tokenId),
      'token moved off the battlefield',
    )
    check(
      !actor.latest().zones.perPlayer[actorId].battlefield.includes(tokenId),
      'r.mMove relocated your permanent',
    )
    check(actor.latest().seq > seq0, 'each manual override advanced the state seq')
  }

  console.log('— rule 800.4a: concede eliminates, game continues —')
  const alive = () => clients[0].latest().turnOrder.filter((p) => !clients[0].latest().players[p].hasLost)
  // first player to concede: the active player
  const firstToGo = clients[0].latest().activePlayer
  const firstClient = clientFor(firstToGo)
  const ownedBefore = Object.values(clients[0].latest().cards).some((c) => c.ownerId === firstToGo)
  firstClient.send({ type: 'r.concede' })
  await clients[0].waitFor((c) => c.latest().players[firstToGo].hasLost, 'first player eliminated')
  check(clients[0].latest().status === 'active', 'game continues after one elimination (3 remain)')
  check(alive().length === 3, `3 players remain (${alive().length})`)
  check(ownedBefore, 'eliminated player owned cards before leaving')
  const afterState = clients[0].latest()
  check(
    !Object.values(afterState.cards).some((c) => c.ownerId === firstToGo),
    "eliminated player's cards left the game (800.4a)",
  )

  // two more concede → one winner
  for (const pid of alive().slice(1)) clientFor(pid).send({ type: 'r.concede' })
  await clients[0].waitFor((c) => c.latest().status === 'ended', 'game ended', 8000)
  const end = clients[0].latest()
  check(end.status === 'ended' && end.winner, `game ended with a winner (${end.players[end.winner]?.name})`)

  let lobbyOpen = false
  for (let i = 0; i < 30; i++) {
    const l = await api(host.cookie, `/api/lobbies/${code}`)
    if (l.json?.status === 'OPEN') {
      lobbyOpen = true
      break
    }
    await sleep(200)
  }
  check(lobbyOpen, 'lobby returned to OPEN after the game')

  console.log('— hidden-information discipline (4 viewers) —')
  let libLeak = false
  let handLeak = null
  for (const viewer of clients) {
    // build every hidden library/hand id of every OTHER player
    const hidden = new Set()
    for (const other of clients) {
      if (other === viewer) continue
      for (const s of other.states) {
        const oh = s.zones.perPlayer[s.you]?.hand
        if (Array.isArray(oh)) for (const id of oh) hidden.add(id)
      }
    }
    // any player's library must serialize as {count} in the viewer's payloads
    for (const s of viewer.states)
      for (const pid of s.turnOrder) {
        const lib = s.zones.perPlayer[pid]?.library
        if (Array.isArray(lib) || typeof lib?.count !== 'number') libLeak = true
      }
    for (let i = 0; i < viewer.states.length; i++) {
      const st = viewer.states[i]
      for (const id of hidden) if (viewer.raws[i].includes(id) && !st.cards[id]) handLeak = id
    }
  }
  check(!libLeak, 'every library serializes as { count } for every viewer')
  check(!handLeak, 'no hidden hand/library id of any player reached another player')

  for (const c of clients) c.ws.close()
} catch (err) {
  console.error('✘ E2E crashed:', err.message)
  failures++
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL COMMANDER E2E CHECKS PASSED')
process.exit(failures ? 1 : 0)
