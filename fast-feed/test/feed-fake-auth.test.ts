// Deterministic feed tests with an injected fake FeedAuth: no Anvil, no chain, a "round" that ends a couple of seconds ahead.
// Covers the rollover close (retry after a transient failure, accepts near the boundary, newest-first excess) and the
// 429 reservation (aborted upgrades, concurrent connects).
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { after, test } from 'node:test'
import WebSocket from 'ws'
import { apiKeyHash } from '../client/key.ts'
import { startFeed, type AuthResult, type FeedAuth, type FeedServer } from '../mock/feed.ts'

const HOST = '127.0.0.1'
let nextPort = 29300
const servers: FeedServer[] = []
const sockets: WebSocket[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms
  while (!cond()) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`)
    await sleep(50)
  }
}

async function server(auth: FeedAuth, chainNowMs?: () => number) {
  const port = nextPort++
  const s = await startFeed(HOST, port, auth, chainNowMs ? { chainNowMs } : {})
  servers.push(s)
  return `ws://${HOST}:${port}`
}

type Conn = { ok: true; ws: WebSocket; closed: { code: number; reason: string } | undefined; at: number } | { ok: false; status: number }
function connect(url: string, key: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 8000 })
    sockets.push(ws)
    const c = { ok: true as const, ws, closed: undefined as { code: number; reason: string } | undefined, at: 0 }
    ws.on('close', (code, reason) => {
      c.closed = { code, reason: reason.toString() }
      c.at = Date.now()
    })
    ws.on('open', () => resolve(c))
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      resolve({ ok: false, status: res.statusCode ?? 0 })
    })
    ws.on('error', (e) => reject(e))
  })
}

after(async () => {
  for (const w of sockets) w.terminate()
  for (const s of servers) await s.close()
})

const secs = () => Math.floor(Date.now() / 1000)

test('rollover: a transient failure for the second key is retried, and both expired keys are closed with 1008', { timeout: 30_000 }, async () => {
  const boundary = secs() + 2
  let failedOnce = false
  const hashB = apiKeyHash('key-b')
  const auth: FeedAuth = async (h) => {
    const after = secs() >= boundary
    if (!after) return { ok: true, tickets: 1, round: 1n, roundEnd: boundary }
    if (h === hashB && !failedOnce) {
      failedOnce = true
      return { ok: false, transient: true, reason: 'read failed' }
    }
    return { ok: false, reason: 'ticket expired' }
  }
  const url = await server(auth)
  const a = await connect(url, 'key-a')
  const b = await connect(url, 'key-b')
  assert.ok(a.ok && b.ok)
  if (!a.ok || !b.ok) return
  await until(() => a.closed !== undefined && b.closed !== undefined, 12_000, 'both keys to be closed')
  assert.deepEqual(a.closed, { code: 1008, reason: 'authentication expired' })
  assert.deepEqual(b.closed, { code: 1008, reason: 'authentication expired' })
  assert.ok(failedOnce, 'the transient failure was exercised')
})

test('rollover: an accept right after the boundary does not delay closing the other expired keys', { timeout: 30_000 }, async () => {
  const boundary = secs() + 2
  const newEnd = boundary + 3600
  const auth: FeedAuth = async (h) => {
    if (secs() < boundary) return { ok: true, tickets: 1, round: 1n, roundEnd: boundary }
    // New round: only key-new holds a ticket.
    if (h === apiKeyHash('key-new')) return { ok: true, tickets: 1, round: 2n, roundEnd: newEnd }
    return { ok: false, reason: 'ticket expired' }
  }
  const url = await server(auth)
  const old = await connect(url, 'key-old')
  assert.ok(old.ok)
  if (!old.ok) return
  // Wait until just past the boundary, then connect a key that is valid in the new round (its roundEnd is far ahead).
  await until(() => secs() >= boundary, 5000, 'the boundary')
  const fresh = await connect(url, 'key-new')
  assert.ok(fresh.ok)
  await until(() => old.closed !== undefined, 8000, 'the old key to be closed despite the later accept')
  assert.equal(old.closed!.code, 1008)
  assert.equal(fresh.ok && fresh.closed, undefined, 'the valid key keeps its connection')
})

test('rollover: when tickets drop below the open connections, the excess is closed newest first', { timeout: 30_000 }, async () => {
  const boundary = secs() + 2
  const auth: FeedAuth = async () =>
    secs() < boundary ? { ok: true, tickets: 3, round: 1n, roundEnd: boundary } : { ok: true, tickets: 1, round: 2n, roundEnd: boundary + 3600 }
  const url = await server(auth)
  const c1 = await connect(url, 'key-x')
  const c2 = await connect(url, 'key-x')
  const c3 = await connect(url, 'key-x')
  assert.ok(c1.ok && c2.ok && c3.ok)
  if (!c1.ok || !c2.ok || !c3.ok) return
  await until(() => c2.closed !== undefined && c3.closed !== undefined, 10_000, 'the excess connections to close')
  assert.equal(c1.closed, undefined, 'the oldest connection stays')
  assert.deepEqual(c2.closed, { code: 1008, reason: 'authentication expired' })
  assert.deepEqual(c3.closed, { code: 1008, reason: 'authentication expired' })
  assert.ok(c3.at <= c2.at + 50, 'newest closed first (or together)')
})

test('429 reservation: an upgrade aborted while the auth waits does not leave a slot taken', { timeout: 20_000 }, async () => {
  let delay = 600
  const auth: FeedAuth = async () => {
    await sleep(delay)
    return { ok: true, tickets: 1, round: 1n, roundEnd: secs() + 3600 }
  }
  const url = await server(auth)
  const port = Number(new URL(url).port)
  // A raw upgrade request that is destroyed while the auth is still running.
  await new Promise<void>((resolve) => {
    const req = request({
      host: HOST,
      port,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Authorization: 'Bearer key-abort' },
    })
    req.on('error', () => {})
    req.end()
    setTimeout(() => {
      req.destroy()
      resolve()
    }, 150)
  })
  await sleep(delay + 300) // the auth finished after the client was gone
  delay = 0
  const c = await connect(url, 'key-abort')
  assert.equal(c.ok, true, 'the key can still connect: no leaked reservation')
})

test('429 reservation: two concurrent connects for a one-ticket key: exactly one accepted, one gets 429', { timeout: 20_000 }, async () => {
  const auth: FeedAuth = async () => {
    await sleep(100)
    return { ok: true, tickets: 1, round: 1n, roundEnd: secs() + 3600 }
  }
  const url = await server(auth)
  const results = await Promise.all([connect(url, 'key-race'), connect(url, 'key-race')])
  assert.equal(results.filter((r) => r.ok).length, 1)
  const refused = results.filter((r): r is { ok: false; status: number } => !r.ok)
  assert.equal(refused.length, 1)
  assert.equal(refused[0]!.status, 429)
})

test('a transient auth failure at the upgrade answers 503, not 401', { timeout: 20_000 }, async () => {
  const auth: FeedAuth = async (): Promise<AuthResult> => ({ ok: false, transient: true, reason: 'read failed' })
  const url = await server(auth)
  const r = await connect(url, 'key-t')
  assert.deepEqual(r, { ok: false, status: 503 })
})

test('E2: no 1008 while the chain clock is frozen past the wall-clock round end; 1008 after a skip past it (no renewal)', { timeout: 30_000 }, async () => {
  const boundary = secs() + 2
  let chainMs = Date.now() // the simulator's chain clock: frozen at first, then skipped
  const auth: FeedAuth = async () =>
    Math.floor(chainMs / 1000) < boundary ? { ok: true, tickets: 1, round: 1n, roundEnd: boundary } : { ok: false, reason: 'ticket expired' }
  const url = await server(auth, () => chainMs)
  const c = await connect(url, 'key-paused')
  assert.ok(c.ok)
  if (!c.ok) return
  await sleep(3500) // the WALL clock passes the round end, the chain clock does not: nothing may close
  assert.equal(secs() >= boundary + 1, true, 'the wall clock is past the round end')
  assert.equal(c.closed as unknown, undefined, 'paused: the connection stays')
  chainMs = (boundary + 1) * 1000 // a skip past the round end, the key holds no ticket for the next round
  await until(() => c.closed !== undefined, 5000, 'the 1008 after the skip')
  assert.equal((c.closed as { code: number } | undefined)?.code, 1008)
})
