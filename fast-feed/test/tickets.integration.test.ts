// Ticket flow on the local stack: slow preset, alternate ports, a short ticket round (TICKET_ROUND_SECONDS).
// Asserts ordering only (401 before activation, accepted after), never absolute durations.
// The raw feed key is generated here at runtime, never printed, and the test checks it never reached stdout/stderr.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createWalletClient, http, parseGwei, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { localPreset, resolvePreset } from '../../shared/config.ts'
import { connectFeed, FeedRejectedError, type FeedMessageJson } from '../client/client.ts'
import { apiKeyHash, generateKey } from '../client/key.ts'
import { approve, deposit, formatTicketsError, makeCtx, mintLocal, purchase, readRound, type TicketsCtx } from '../client/tickets.ts'
import { bannerLines } from '../../sim/banner.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

const env: NodeJS.ProcessEnv = {
  ...process.env,
  SIM_RPC_PORT: '28547',
  SIM_FEED_PORT: '29642',
  SIM_ANVIL_PORT: '28545',
  TICKET_ROUND_SECONDS: '12',
  FEED_AUTH: 'on',
}
delete env.PRIVATE_KEY
const preset = localPreset('slow', env)
const DEAD = '0x000000000000000000000000000000000000dEaD'
const KEY2: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // public Anvil dev key, account 1

const KEY = generateKey() // runtime only
const KEY_HASH = apiKeyHash(KEY)
let output = ''
const hook = (stream: NodeJS.WriteStream) => {
  const orig = stream.write.bind(stream) as (...a: unknown[]) => boolean
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    output += String(chunk)
    return orig(chunk, ...rest)
  }) as typeof stream.write
}
hook(process.stdout)
hook(process.stderr)

let stack: Stack
let ctx: TicketsCtx
let purchasedRound: bigint

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Connect; resolve {status, body} when refused, {connected, client} when accepted. */
async function tryConnect(
  apiKey: string | undefined,
  onMessage: (m: FeedMessageJson) => void = () => {},
  onClose?: (code: number, reason: string) => void,
) {
  const client = connectFeed({ url: preset.feedUrl, apiKey, onMessage, onClose })
  try {
    await client.ready
    return { connected: true as const, client }
  } catch (e) {
    assert.ok(e instanceof FeedRejectedError, 'refusal must be an HTTP rejection')
    return { connected: false as const, status: e.status, body: e.body }
  }
}

before(async () => {
  buildContracts() // fresh clones have no out/ or lib/: deploy needs the artifacts
  stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
  ctx = makeCtx(await resolvePreset(preset), env)
}, { timeout: 60_000 })

after(async () => {
  await stack?.stop()
  assert.ok(!output.includes(KEY), 'the raw feed key must never appear in stdout/stderr')
})

test('banner prints the ticket round actually used', () => {
  assert.match(bannerLines(stack.params).join('\n'), /ticket round = 12s \(Arbitrum One: 24h\)/)
  assert.equal(stack.params.tickets.roundSeconds, 12)
})

test('local stack deployed TEST + Tickets and is past the first round (views do not revert)', async () => {
  const r = await readRound(ctx)
  assert.ok(r.round >= 0n)
  assert.equal(r.price, 1_000_000n)
})

test('fund and buy a ticket; the key gets 401 before activation, unknown/missing keys 401, accepted after', async () => {
  await mintLocal(ctx, 1_000_000n)
  await approve(ctx, 1_000_000n)
  await deposit(ctx, 1_000_000n)

  // Start from a fresh round so the purchase and the 401 probes cannot straddle a round end.
  const freshBy = Date.now() + 40_000
  for (;;) {
    const r = await readRound(ctx)
    if (BigInt(r.now) + 7n <= r.roundEnd && r.roundEnd - BigInt(r.now) <= 12n) break
    assert.ok(Date.now() < freshBy, 'no fresh ticket round within 40s')
    await sleep(200)
  }
  const info = await readRound(ctx, { print: true })
  const bought = await purchase(ctx, info, 1, KEY_HASH)
  purchasedRound = bought.round
  assert.equal(bought.filled, 1n)

  // Not active yet: the purchase round has not ended (ordering, not durations).
  const stillSame = await readRound(ctx)
  assert.equal(stillSame.round, purchasedRound, 'probe must run inside the purchase round')
  const early = await tryConnect(KEY)
  assert.equal(early.connected, false)
  if (!early.connected) {
    assert.equal(early.status, 401)
    assert.match(early.body, /^no active ticket/)
    assert.match(early.body, /access starts when that round ends/)
  }

  const unknown = await tryConnect(generateKey())
  assert.equal(unknown.connected, false)
  if (!unknown.connected) {
    assert.equal(unknown.status, 401)
    assert.match(unknown.body, /unknown key/)
  }

  const missing = await tryConnect(undefined)
  assert.equal(missing.connected, false)
  if (!missing.connected) {
    assert.equal(missing.status, 401)
    assert.match(missing.body, /Authorization: Bearer/)
  }

  // Wait until the purchase round has ended (chain round number moves past it).
  const activeBy = Date.now() + 40_000
  for (;;) {
    const r = await readRound(ctx)
    if (r.round > purchasedRound) break
    assert.ok(Date.now() < activeBy, 'the purchase round never ended within 40s')
    await sleep(250)
  }

  const messages: FeedMessageJson[] = []
  let closedWith: string | undefined
  const ok = await tryConnect(KEY, (m) => messages.push(m), (code, reason) => (closedWith = `${code} ${reason}`))
  assert.equal(ok.connected, true, 'connected after activation')
  if (!ok.connected) return
  try {
    const wallet = createWalletClient({
      account: privateKeyToAccount(KEY2),
      chain: { id: preset.chainId, name: 'local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [preset.rpcUrl] } } },
      transport: http(preset.rpcUrl),
    })
    const hash = await wallet.sendTransaction({ to: DEAD, value: 1n, maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: 1n })
    const until = Date.now() + 15_000
    while (!messages.some((m) => m.transaction.tx_hash === hash)) {
      // A ticket is active for one round only: if the next rollover hit first, say so instead of "no message".
      assert.equal(closedWith, undefined, `the feed closed the connection (${closedWith}) before the tx message arrived: the ticket's round (${purchasedRound + 1n}) ended first`)
      assert.ok(Date.now() < until, 'no feed message for the tx')
      await sleep(50)
    }
  } finally {
    await ok.client.close()
  }
})

test('stale round or wrong price gives a readable error, not a stack trace', async () => {
  const r = await readRound(ctx)
  await assert.rejects(purchase(ctx, { ...r, round: r.round - 1n }, 1, KEY_HASH), (e) => {
    const msg = formatTicketsError(e)
    assert.match(msg, /^Round changed \(expected \d+, now \d+\): the round rolled over between read and purchase; rerun the command\.$/)
    assert.doesNotMatch(msg, /\n\s+at |Error:|Details:/)
    return true
  })
  const r2 = await readRound(ctx)
  await assert.rejects(purchase(ctx, { ...r2, price: r2.price + 1n }, 1, KEY_HASH), (e) => {
    const msg = formatTicketsError(e)
    assert.match(msg, /^Ticket price changed \(expected 1\.000001 TEST, now 1 TEST\)/)
    assert.doesNotMatch(msg, /\n\s+at |Error:|Details:/)
    return true
  })
  // Not enough deposited TEST: everything was spent on the ticket above.
  const r3 = await readRound(ctx)
  await assert.rejects(purchase(ctx, r3, 1, KEY_HASH), (e) => {
    assert.match(formatTicketsError(e), /Not enough deposited TEST \(deposited 0 TEST, needed 1 TEST\)/)
    return true
  })
})

test('FEED_AUTH=off keeps the open feed (separate stack)', async () => {
  const env2 = { ...env, SIM_RPC_PORT: '28647', SIM_FEED_PORT: '29742', SIM_ANVIL_PORT: '28645', FEED_AUTH: 'off' }
  const p2 = localPreset('slow', env2)
  const s2 = await startOrAttach(p2.local!, p2.chainId, { banner: false })
  try {
    assert.equal(s2.params.feedAuth, false)
    const client = connectFeed({ url: p2.feedUrl, onMessage: () => {} })
    await client.ready // no key, no ticket
    await client.close()
  } finally {
    await s2.stop()
  }
})

test('idle stack for more than one ticket round (no blocks mined), then buy: succeeds in the new round, no bogus RoundNumberMismatch', async () => {
  const env3 = { ...env, SIM_RPC_PORT: '28747', SIM_FEED_PORT: '29842', SIM_ANVIL_PORT: '28745', TICKET_ROUND_SECONDS: '8' }
  const p3 = localPreset('slow', env3)
  const s3 = await startOrAttach(p3.local!, p3.chainId, { banner: false })
  try {
    const c3 = makeCtx(await resolvePreset(p3), env3)
    const hash3 = apiKeyHash(generateKey())
    await mintLocal(c3, 1_000_000n)
    await approve(c3, 1_000_000n)
    await deposit(c3, 1_000_000n) // the last block mined: from here nothing mines
    const r0 = await readRound(c3)
    // Stay idle past the end of this round: the latest block's timestamp is now more than a round old.
    const idleBy = Date.now() + 40_000
    for (;;) {
      const r = await readRound(c3)
      if (r.round > r0.round) break
      assert.ok(Date.now() < idleBy, 'round never advanced')
      await sleep(250)
    }
    // Take a fresh round so the (queued, then mined) purchase cannot straddle a real rollover.
    const freshBy = Date.now() + 40_000
    for (;;) {
      const r = await readRound(c3)
      if (r.roundEnd - BigInt(r.now) >= 5n) break
      assert.ok(Date.now() < freshBy, 'no fresh round')
      await sleep(200)
    }
    const info = await readRound(c3)
    assert.ok(info.round > r0.round)
    const bought = await purchase(c3, info, 1, hash3) // estimation (eth_fillTransaction path) must use wall-clock time
    assert.equal(bought.round, info.round)
    assert.equal(bought.filled, 1n)
  } finally {
    await s3.stop()
  }
})
