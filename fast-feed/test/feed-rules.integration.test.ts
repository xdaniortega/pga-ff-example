// Feed connection rules on the local stack (A3): 429 (one connection per ticket), 1008 at the round rollover,
// `feed --reconnect`, 426, 1003 and 1011. Slow preset, alternate ports, a short ticket round.
// Asserts ORDER of events (401 before connected, 1008 only after the round moved on); the only time limits are
// deadlines on every wait, so a failure is a failure and not a hang.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import WebSocket from 'ws'
import { localPreset, resolvePreset } from '../../shared/config.ts'
import { connectFeed, FeedRejectedError } from '../client/client.ts'
import { apiKeyHash, generateKey } from '../client/key.ts'
import { approve, deposit, makeCtx, mintLocal, purchase, readRound, type TicketsCtx } from '../client/tickets.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

const ROUND_S = 24
const BACKOFF_CAP_MS = 2000 // FEED_BACKOFF_MAX_MS for the reconnect test: a backoff can never overshoot its deadline
const env: NodeJS.ProcessEnv = {
  ...process.env,
  SIM_RPC_PORT: '28247',
  SIM_FEED_PORT: '29242',
  SIM_ANVIL_PORT: '28245',
  TICKET_ROUND_SECONDS: String(ROUND_S),
  FEED_AUTH: 'on',
}
delete env.PRIVATE_KEY
delete env.FEED_API_KEY
const preset = localPreset('slow', env)
const env2: NodeJS.ProcessEnv = { ...env, SIM_RPC_PORT: '28257', SIM_FEED_PORT: '29252', SIM_ANVIL_PORT: '28255', FEED_AUTH: 'off' }
const preset2 = localPreset('slow', env2)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Wait for a WebSocket to open, with a deadline. */
const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WebSocket did not open within 10s')), 10_000)
    ws.once('open', () => (clearTimeout(t), resolve()))
    ws.once('error', (e) => (clearTimeout(t), reject(e)))
  })
async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`)
    await sleep(100)
  }
}

let stack: Stack
let stack2: Stack
let ctx: TicketsCtx
const dir = mkdtempSync(join(tmpdir(), 'feed-rules-'))
const open: { close(): Promise<void> }[] = []

/** Connect with a key. Accepted: the live client plus a promise of how it closes. Refused: the HTTP status and body. */
async function connect(key: string) {
  let resolveClosed!: (v: { code: number; reason: string }) => void
  const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r))
  let isClosed = false
  const client = connectFeed({
    url: preset.feedUrl,
    apiKey: key,
    onMessage: () => {},
    onClose: (code, reason) => {
      isClosed = true
      resolveClosed({ code, reason })
    },
  })
  let rejectSlow!: (e: Error) => void
  const slow = new Promise<never>((_, rej) => (rejectSlow = rej))
  const timer = setTimeout(() => rejectSlow(new Error('no upgrade response within 10s')), 10_000)
  timer.unref()
  try {
    await Promise.race([client.ready, slow])
  } catch (e) {
    if (!(e instanceof FeedRejectedError)) await client.close()
    assert.ok(e instanceof FeedRejectedError, 'refusals are HTTP rejections')
    return { ok: false as const, status: e.status, body: e.body }
  } finally {
    clearTimeout(timer)
  }
  open.push(client)
  return { ok: true as const, client, closed, isClosed: () => isClosed }
}

/** Connect, retrying while the server still counts a connection we just closed (429), until it is accepted. */
async function connectWhenFree(key: string) {
  let last: Awaited<ReturnType<typeof connect>> | undefined
  await until(async () => {
    last = await connect(key)
    return last.ok
  }, 10_000, 'a free connection slot')
  const r = last!
  assert.ok(r.ok)
  return r
}

async function waitRound(atLeast: bigint, ms = 3 * ROUND_S * 1000): Promise<void> {
  await until(async () => (await readRound(ctx)).round >= atLeast, ms, `round ${atLeast}`)
}

/** Wait for a round with at least `secs` left, so a purchase cannot straddle the round end. */
async function freshRound(secs: number): Promise<void> {
  await until(async () => {
    const r = await readRound(ctx)
    return r.roundEnd - BigInt(r.now) >= BigInt(secs)
  }, 3 * ROUND_S * 1000, `a round with ${secs}s left`)
}

const keys = { b: generateKey(), c: generateKey(), d: generateKey(), e: generateKey() }
let M: bigint // the round in which b, c, d were bought

before(async () => {
  buildContracts()
  stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
  stack2 = await startOrAttach(preset2.local!, preset2.chainId, { banner: false })
  ctx = makeCtx(await resolvePreset(preset), env)
  await mintLocal(ctx, 30_000_000n)
  await approve(ctx, 30_000_000n)
  await deposit(ctx, 30_000_000n)
  // Three purchases take ~3s each (one local block each), so start with plenty of the round left.
  await freshRound(16)
  const info = await readRound(ctx)
  M = info.round
  for (const [n, k] of [[1, keys.c], [2, keys.b], [1, keys.d]] as const) {
    const p = await purchase(ctx, info, n, apiKeyHash(k))
    assert.equal(p.round, M, 'all purchases landed in the same round')
  }
  await waitRound(M + 1n) // tickets bought in M are active in M + 1
}, { timeout: 180_000 })

after(async () => {
  for (const c of open) await c.close().catch(() => {})
  await stack?.stop()
  await stack2?.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('one ticket: the first connection is accepted and the second gets 429; two tickets: two accepted, the third gets 429', { timeout: 120000 }, async () => {
  const c1 = await connect(keys.c)
  assert.equal(c1.ok, true)
  const c2 = await connect(keys.c)
  assert.equal(c2.ok, false)
  if (!c2.ok) {
    assert.equal(c2.status, 429)
    assert.match(c2.body, /^connections ≥ tickets \(1 open, 1 active ticket\)/)
  }
  // Closing a connection frees the slot.
  if (c1.ok) {
    await c1.client.close()
    const again = await connectWhenFree(keys.c) // the server notices the closed socket a moment later
    await again.client.close()
  }

  const b1 = await connect(keys.b)
  const b2 = await connect(keys.b)
  const b3 = await connect(keys.b)
  assert.equal(b1.ok && b2.ok, true, 'two tickets, two connections')
  assert.equal(b3.ok, false)
  if (!b3.ok) {
    assert.equal(b3.status, 429)
    assert.match(b3.body, /\(2 open, 2 active tickets\)/)
  }
  for (const c of [b1, b2]) if (c.ok) await c.client.close()
})

test('a key that did not renew (c) is closed with 1008 authentication expired after the round ends; a renewed key keeps its connection', { timeout: 120000 }, async () => {
  const cc = await connectWhenFree(keys.c)
  const dd = await connect(keys.d)
  assert.ok(dd.ok, 'key d is active in round M + 1')
  if (!dd.ok) return
  const now = await readRound(ctx)
  assert.equal(now.round, M + 1n, 'still inside the round where the tickets are active')
  const roundEndMs = Number(now.roundEnd) * 1000

  // d renews for M + 2 (inside M + 1); c does not.
  await purchase(ctx, now, 1, apiKeyHash(keys.d))
  assert.equal((await readRound(ctx)).round, M + 1n, 'the renewal landed in M + 1')

  let closedAt = 0
  const closed = await Promise.race([cc.closed.then((v) => ((closedAt = Date.now()), v)), sleep(roundEndMs - Date.now() + ROUND_S * 1000).then(() => undefined)])
  assert.ok(closed, 'closed within one round of roundEnd')
  assert.equal(closed.code, 1008)
  assert.equal(closed.reason, 'authentication expired')
  assert.ok((await readRound(ctx)).round >= M + 2n, 'the close came after the round rolled over, not before')
  assert.equal(dd.isClosed(), false, 'the renewed key kept its connection across the rollover')
  assert.ok(closedAt >= roundEndMs - 1000, 'the 1008 came at or after roundEnd, not before it')
  assert.ok(closedAt < roundEndMs + ROUND_S * 1000, 'the 1008 came before roundEnd plus one ticket round')

  // The expired key now gets 401 (no ticket in M + 2), with the expiry explanation.
  const again = await connect(keys.c)
  assert.equal(again.ok, false)
  if (!again.ok) {
    assert.equal(again.status, 401)
    assert.match(again.body, /ticket expired/)
  }
  await dd.client.close()
})

test('feed --local --reconnect: 401 while the new ticket is not active, then connected after activation', { timeout: 220000 }, async () => {
  const envFile = join(dir, 'env')
  writeFileSync(envFile, `FEED_API_KEY=${keys.e}\n`)
  await freshRound(12)
  const info = await readRound(ctx)
  await purchase(ctx, info, 1, apiKeyHash(keys.e))
  const child = spawn(process.execPath, ['--import', 'tsx', 'fast-feed/client/feed.ts', '--local', '--reconnect'], {
    env: { ...env, ENV_FILE: envFile, FEED_BACKOFF_MAX_MS: String(BACKOFF_CAP_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Worst case: the ticket activates one round after the purchase, the last backoff is at most the cap, plus startup and load.
  const deadlineMs = (ROUND_S + 30) * 1000 + BACKOFF_CAP_MS
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const killTimer = setTimeout(() => child.kill('SIGKILL'), deadlineMs)
  try {
    await until(() => /connected/.test(out) || child.exitCode !== null, deadlineMs, 'the reconnecting feed to connect')
    assert.match(out, /connected/)
    const first401 = out.indexOf('401 Unauthorized')
    assert.ok(first401 >= 0, 'it was refused with 401 first')
    assert.ok(out.indexOf('reconnecting in') > first401, 'it waited with a backoff after the 401')
    assert.ok(out.lastIndexOf('==> connected') > first401, 'order: 401, backoff, connected')
    assert.ok(!out.includes(keys.e), 'the raw key is never printed')
  } finally {
    clearTimeout(killTimer)
    child.kill('SIGKILL')
  }
})

test('426 for a plain HTTP GET; 1003 after a client data frame', { timeout: 30000 }, async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: preset2.local!.host, port: preset2.local!.feedPort, path: '/', method: 'GET' }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.setTimeout(5000, () => req.destroy(new Error('no HTTP response within 5s')))
    req.once('error', reject)
    req.end()
  })
  assert.equal(status, 426)

  const ws = new WebSocket(preset2.feedUrl)
  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    ws.once('error', reject)
    setTimeout(() => reject(new Error('no close within 10s')), 10_000).unref()
  })
  await opened(ws)
  ws.send('hello') // a data frame: the feed is one-way
  assert.deepEqual(await closed, { code: 1003, reason: 'unexpected client message' })
})

test('1011 server shutting down when the stack stops', { timeout: 60000 }, async () => {
  const p3 = localPreset('slow', { ...env2, SIM_RPC_PORT: '28267', SIM_FEED_PORT: '29262', SIM_ANVIL_PORT: '28265' })
  const s3 = await startOrAttach(p3.local!, p3.chainId, { banner: false })
  let stopped = false
  try {
    const ws = new WebSocket(p3.feedUrl)
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      ws.once('error', reject)
      setTimeout(() => reject(new Error('no close within 20s')), 20_000).unref()
    })
    await opened(ws)
    const stopping = s3.stop()
    stopped = true
    assert.deepEqual(await closed, { code: 1011, reason: 'server shutting down' })
    await stopping
  } finally {
    if (!stopped) await s3.stop()
  }
})
