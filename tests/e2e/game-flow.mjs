/**
 * End-to-end smoke: claim users → import decks → lobby → start → WebSocket play.
 * Run: node tests/e2e/game-flow.mjs [baseUrl]   (default http://localhost:3998)
 * Exits 0 on success, 1 on any failed assertion. Requires the dev/prod server
 * up with an imported card catalog.
 */
import { WebSocket } from 'ws'

const BASE = process.argv[2] ?? 'http://localhost:3998'
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

const DECK = (commander) => `Commander:\n1 ${commander}\n\nDeck:\n1 Sol Ring\n1 Arcane Signet\n1 Command Tower\n7 Forest`

async function setupPlayer(name, commander) {
  const claim = await api(null, '/api/auth/claim', { method: 'POST', body: { username: name } })
  check(claim.status === 200 && claim.cookie, `${name}: claimed username`)
  const imp = await api(claim.cookie, '/api/decks/import', {
    method: 'POST',
    body: { name: `${name}'s deck`, text: DECK(commander), commit: true },
  })
  check(imp.status === 200 && imp.json.deckId, `${name}: deck imported (${imp.json.resolved?.length} lines)`)
  return { name, cookie: claim.cookie, deckId: imp.json.deckId }
}

function wsClient(name, cookie, gameId) {
  const ws = new WebSocket(`${WS_BASE}/ws/game?g=${gameId}`, {
    headers: { cookie, origin: BASE },
  })
  const client = { name, ws, sync: null, events: [], errors: [], presence: [], ephemerals: [] }
  ws.on('message', (data) => {
    const text = data.toString()
    if (text === 'pong') return
    const msg = JSON.parse(text)
    if (msg.t === 'sync') client.sync = msg
    else if (msg.t === 'event') client.events.push(msg)
    else if (msg.t === 'error') client.errors.push(msg)
    else if (msg.t === 'presence') client.presence.push(msg)
    else if (msg.t === 'ephemeral') client.ephemerals.push(msg)
  })
  client.send = (obj) => ws.send(JSON.stringify(obj))
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
  console.log('— players & decks —')
  const alice = await setupPlayer('Alice', "Atraxa, Praetors' Voice")
  const bob = await setupPlayer('Bob', 'Omnath, Locus of Creation')

  console.log('— lobby —')
  const create = await api(alice.cookie, '/api/lobbies', {
    method: 'POST',
    body: { name: 'e2e pod', password: 'hunter2', visibility: 'UNLISTED' },
  })
  const code = create.json.lobby?.inviteCode ?? create.json.inviteCode
  check(create.status === 200 && code, 'Alice created a passworded unlisted lobby')

  const list = await api(bob.cookie, '/api/lobbies')
  check(!JSON.stringify(list.json).includes(code), 'unlisted lobby does not leak in the public list')

  const badJoin = await api(bob.cookie, `/api/lobbies/${code}/join`, { method: 'POST', body: { password: 'wrong' } })
  check(badJoin.status === 403, 'wrong password rejected (403)')
  const join = await api(bob.cookie, `/api/lobbies/${code}/join`, { method: 'POST', body: { password: 'hunter2' } })
  check(join.status === 200, 'Bob joined with the right password')

  for (const p of [alice, bob])
    check(
      (await api(p.cookie, `/api/lobbies/${code}/me`, { method: 'PATCH', body: { deckId: p.deckId, isReady: true } })).status === 200,
      `${p.name}: deck picked + ready`,
    )

  const start = await api(alice.cookie, `/api/lobbies/${code}/start`, { method: 'POST', body: {} })
  const gameId = start.json.gameId
  check(start.status === 200 && gameId, `game started: ${gameId}`)

  console.log('— websocket play —')
  const wsA = wsClient('Alice', alice.cookie, gameId)
  const wsB = wsClient('Bob', bob.cookie, gameId)
  await wsA.waitFor((c) => c.sync, 'sync')
  await wsB.waitFor((c) => c.sync, 'sync')
  check(wsA.sync.state.status === 'mulligans', 'game opens in mulligan phase')
  const aHand = wsA.sync.state.zones.perPlayer[wsA.sync.state.you].hand
  check(Array.isArray(aHand) && aHand.length === 7, 'Alice sees her 7-card hand')
  const bView = wsB.sync.state.zones.perPlayer[wsA.sync.state.you]
  check(!Array.isArray(bView.hand) && bView.hand.count === 7, "Bob sees Alice's hand as count only")
  check(bView.library.count === 3, "Bob sees Alice's library count (10-card deck − 7)")
  const bPayload = JSON.stringify(wsB.sync)
  check(!aHand.some((id) => bPayload.includes(id)), "no Alice hand id in Bob's sync")

  wsA.send({ type: 'deck.keep', toBottom: [] })
  wsB.send({ type: 'deck.keep', toBottom: [] })
  await wsA.waitFor((c) => c.events.some((e) => e.status === 'active'), 'mulligans done')

  const active = wsA.events.at(-1)
  const activePlayer = (await wsA.waitFor((c) => c.sync, 'x'), wsA.sync.state.turn.activePlayer)
  const activeClient = activePlayer === wsA.sync.state.you ? wsA : wsB
  const otherClient = activeClient === wsA ? wsB : wsA
  console.log(`  (active player: ${activeClient.name})`)

  const evCountA = wsA.events.length
  activeClient.send({ type: 'deck.draw', n: 2 })
  const drawEvA = await activeClient.waitFor(
    (c) => c.events.find((e) => e.type === 'deck.draw'),
    'draw event (actor)',
  )
  const drawEvB = await otherClient.waitFor(
    (c) => c.events.find((e) => e.type === 'deck.draw'),
    'draw event (opponent)',
  )
  check(drawEvA.cards?.length === 2 && drawEvA.cards.every((c) => c.display?.name), 'actor got drawn card identities')
  check(!drawEvB.cards, 'opponent got NO card identities on draw')
  check(drawEvB.zones?.some((z) => z.count !== undefined), 'opponent got count-only zone patches')
  check(drawEvA.log?.includes('drew 2'), `log line: "${drawEvA.log}"`)

  otherClient.send({ type: 'chat.send', text: 'gg so far' })
  const chat = await activeClient.waitFor((c) => c.events.find((e) => e.type === 'chat.send'), 'chat')
  check(chat.log?.includes('gg so far'), 'chat broadcast')

  activeClient.send({ type: 'turn.next' })
  await activeClient.waitFor((c) => c.events.some((e) => e.turn), 'turn event')
  // Turn control = active player OR host. Alice created the lobby, so she is host.
  // Whether the non-active player is denied depends on whether they're the host.
  const otherIsHost = otherClient === wsA
  otherClient.send({ type: 'turn.next' })
  if (otherIsHost) {
    const drove = await otherClient
      .waitFor((c) => c.events.filter((e) => e.turn).length >= 2, 'host turn drive')
      .catch(() => false)
    check(!!drove, 'host may drive the turn even when not the active player')
  } else {
    const err = await otherClient
      .waitFor((c) => c.errors.find((e) => e.code === 'NOT_ACTIVE'), 'turn denial')
      .catch(() => null)
    check(!!err, 'non-active non-host player cannot drive the turn')
  }

  // reconnect: drop Bob, reopen, expect a fresh sync at current seq
  const seqBefore = wsB.events.at(-1)?.seq ?? wsB.sync.seq
  wsB.ws.close()
  await sleep(200)
  const wsB2 = wsClient('Bob-reconnect', bob.cookie, gameId)
  await wsB2.waitFor((c) => c.sync, 'reconnect sync')
  check(wsB2.sync.seq >= seqBefore, `reconnect sync at seq ${wsB2.sync.seq} (was ${seqBefore})`)
  check(wsB2.sync.log.length > 0, `log tail survives reconnect (${wsB2.sync.log.length} lines)`)

  // ws auth: no cookie → rejected
  const anon = new WebSocket(`${WS_BASE}/ws/game?g=${gameId}`, { headers: { origin: BASE } })
  const anonResult = await new Promise((resolve) => {
    anon.on('unexpected-response', (_r, res) => resolve(`http ${res.statusCode}`))
    anon.on('close', (code) => resolve(`close ${code}`))
    anon.on('error', () => resolve('error'))
    setTimeout(() => resolve('timeout'), 3000)
  })
  check(anonResult !== 'timeout' && anonResult !== 'close 1000', `anonymous ws rejected (${anonResult})`)

  // bad origin → rejected at upgrade
  const evil = new WebSocket(`${WS_BASE}/ws/game?g=${gameId}`, { headers: { cookie: bob.cookie, origin: 'https://evil.example' } })
  const evilResult = await new Promise((resolve) => {
    evil.on('unexpected-response', (_r, res) => resolve(`http ${res.statusCode}`))
    evil.on('close', (code) => resolve(`close ${code}`))
    evil.on('error', () => resolve('error'))
    setTimeout(() => resolve('timeout'), 3000)
  })
  check(evilResult !== 'timeout', `cross-origin ws rejected (${evilResult})`)

  wsA.ws.close()
  wsB2.ws.close()
} catch (err) {
  console.error('✘ E2E crashed:', err.message)
  failures++
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL E2E CHECKS PASSED')
process.exit(failures ? 1 : 0)
