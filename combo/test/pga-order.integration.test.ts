// B1: three wallets send lowest tip first inside ONE round; the block must hold them highest tip first.
// Slow preset (B=2000ms, K=2 -> round 1000ms), alternate ports, FEED_AUTH=off.
//
// Same-round determinism: the test asks the sequencer `sim_msUntilNextRound` (local test/demo tooling),
// sleeps until just after a round tick, then sends all three txs. The sends take far less than one
// round (1000ms), so they are all in the waiting list of the SAME next round. No luck involved.
// Also asserts the eth_sendTransaction bypass is rejected, and (second stack) that --fifo keeps arrival order.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { parseGwei, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { localPreset } from '../../shared/config.ts'
import { connectFeed, type FeedClient, type FeedMessageJson } from '../../fast-feed/client/client.ts'
import { buildContracts } from '../../sim/build.ts'
import { setInternalVisible } from '../../shared/narrate.ts'
import { jsonRpc } from '../../sim/chain.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // Anvil 0 (0xf39F..)
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // Anvil 1 (0x7099..)
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // Anvil 2 (0x3C44..)
]
const TIPS = ['0.001', '0.01', '0.1'] // sent in this order: lowest tip first
const DEAD = '0x000000000000000000000000000000000000dEaD'
const BASE_ENV = { ...process.env, BLOCK_PUBLISH_DELAY_MS: '100', FEED_AUTH: 'off', SIM_ORDER: 'pga' }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Ctx {
  stack: Stack
  client: FeedClient
  url: string
  messages: FeedMessageJson[]
  rpc: (method: string, params?: unknown[]) => Promise<any>
}

async function startCtx(ports: { rpc: string; feed: string; anvil: string }, extra: Record<string, string> = {}): Promise<Ctx> {
  const env = { ...BASE_ENV, SIM_RPC_PORT: ports.rpc, SIM_FEED_PORT: ports.feed, SIM_ANVIL_PORT: ports.anvil, ...extra }
  const preset = localPreset('slow', env)
  const stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
  const messages: FeedMessageJson[] = []
  const client = connectFeed({ url: preset.feedUrl, onMessage: (m) => void messages.push(m) })
  await client.ready
  const rpc = async (method: string, params: unknown[] = []) => {
    const r = await fetch(preset.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = (await r.json()) as { result?: any; error?: { code: number; message: string } }
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code })
    return body.result
  }
  return { stack, client, url: preset.rpcUrl, messages, rpc }
}

async function stopCtx(c: Ctx | undefined) {
  await c?.client.close()
  await c?.stack.stop()
}

/** Sign and send three txs (lowest tip first) right after a round tick; returns hashes in send order. */
async function sendThree(c: Ctx): Promise<Hex[]> {
  const accounts = KEYS.map((k) => privateKeyToAccount(k))
  const nonces = await Promise.all(accounts.map(async (a) => Number(BigInt(await c.rpc('eth_getTransactionCount', [a.address, 'latest'])))))
  const raws: Hex[] = []
  for (let i = 0; i < 3; i++) {
    raws.push(
      await accounts[i]!.signTransaction({
        type: 'eip1559',
        chainId: 31337,
        to: DEAD,
        value: 0n,
        gas: 21_000n,
        nonce: nonces[i]!,
        maxFeePerGas: parseGwei('1'),
        maxPriorityFeePerGas: parseGwei(TIPS[i]!),
      }),
    )
  }
  // Just after a tick: the whole batch fits in the next round (1000ms) with a wide margin.
  const ms = Number(BigInt(await c.rpc('sim_msUntilNextRound')))
  await sleep(ms + 60)
  const hashes: Hex[] = []
  for (const raw of raws) hashes.push(await c.rpc('eth_sendRawTransaction', [raw]))
  return hashes
}

async function receipts(c: Ctx, hashes: Hex[]) {
  const out: any[] = []
  const deadline = Date.now() + 20_000
  for (const h of hashes) {
    let r = null
    while (!r) {
      if (Date.now() > deadline) throw new Error(`no receipt for ${h}`)
      r = await c.rpc('eth_getTransactionReceipt', [h])
      if (!r) await sleep(100)
    }
    out.push(r)
  }
  return out
}

let pga: Ctx | undefined
let fifo: Ctx | undefined
let gap: Ctx | undefined

before(async () => {
  buildContracts()
  pga = await startCtx({ rpc: '38547', feed: '39642', anvil: '38545' })
  fifo = await startCtx({ rpc: '38647', feed: '39742', anvil: '38645' }, { SIM_ORDER: 'fifo' })
  gap = await startCtx({ rpc: '38747', feed: '39842', anvil: '38745' }, { GAP_HOLD_ROUNDS: '2' })
})
after(async () => {
  await stopCtx(pga)
  await stopCtx(fifo)
  await stopCtx(gap)
})

test('PGA: three txs sent lowest tip first land in ONE round (same block, same pga_round), highest effective tip first', async () => {
  const c = pga!
  const hashes = await sendThree(c) // [low, mid, high]
  const rs = await receipts(c, hashes)

  assert.equal(new Set(rs.map((r) => r.blockNumber)).size, 1, 'all three in one block')
  // K = 2 rounds share a block: the same block alone does not prove the same round, so check pga_round too (sim_boostTrace).
  const traces = await Promise.all(hashes.map((h) => c.rpc('sim_boostTrace', [h])))
  const rounds = traces.map((t: any[]) => t.find((e) => e.included)?.pgaRound)
  assert.ok(rounds.every((x) => x === 1 || x === 2), `every tx has a pga_round: ${rounds}`)
  assert.equal(new Set(rounds).size, 1, `all three in one round (same pga_round): ${rounds}`)
  assert.deepEqual(new Set(traces.map((t: any[]) => t.find((e) => e.included)?.block)), new Set([Number(BigInt(rs[0].blockNumber))]), 'the trace names the same block')
  const idx = rs.map((r) => Number(BigInt(r.transactionIndex)))
  // high (sent last) first, low (sent first) last
  assert.deepEqual(idx, [2, 1, 0])
  const block = await c.rpc('eth_getBlockByNumber', [rs[0].blockNumber, false])
  assert.deepEqual(block.transactions, [hashes[2], hashes[1], hashes[0]])

  const baseFee = BigInt(block.baseFeePerGas)
  assert.equal(baseFee, parseGwei('0.01'))
  const tips = rs.map((r) => BigInt(r.effectiveGasPrice) - baseFee)
  assert.deepEqual(tips, TIPS.map((t) => parseGwei(t)))

  // Feed: tx_index matches the sorted order.
  const deadline = Date.now() + 10_000
  while (c.messages.length < 3 && Date.now() < deadline) await sleep(50)
  const byHash = new Map(c.messages.map((m) => [m.transaction.tx_hash.toLowerCase(), m.transaction]))
  const feedIdx = hashes.map((h) => byHash.get(h.toLowerCase())!.tx_index)
  assert.deepEqual(feedIdx, idx)
  assert.deepEqual(feedIdx, [2, 1, 0])
})

test('eth_sendTransaction through the proxy is rejected (it would bypass the queue)', async () => {
  const c = pga!
  for (const method of ['eth_sendTransaction', 'eth_sendUnsignedTransaction']) {
    await assert.rejects(
      c.rpc(method, [{ from: privateKeyToAccount(KEYS[0]!).address, to: DEAD, value: '0x0' }]),
      (e: Error) => /accepts only signed raw transactions/.test(e.message),
    )
  }
})

test('--fifo: the same three txs land in arrival order (proves the switch)', async () => {
  const c = fifo!
  const info = await c.rpc('sim_info')
  assert.equal(info.ordering, 'fifo')
  const hashes = await sendThree(c) // [low, mid, high]
  const rs = await receipts(c, hashes)
  assert.equal(new Set(rs.map((r) => r.blockNumber)).size, 1, 'one block (sent within one round)')
  assert.deepEqual(rs.map((r) => Number(BigInt(r.transactionIndex))), [0, 1, 2])
})

test('mid-batch rejection: the unaffordable tx is dropped and logged; the others keep their sorted order in ONE round', async () => {
  const c = pga!
  const funder = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6') // Anvil 3
  const other = privateKeyToAccount(KEYS[1]!)
  const w = privateKeyToAccount(generatePrivateKey())
  const nonceOf = async (a: string) => Number(BigInt(await c.rpc('eth_getTransactionCount', [a, 'latest'])))
  const sign = (a: ReturnType<typeof privateKeyToAccount>, nonce: number, tip: string, to: Hex = DEAD, value = 0n) =>
    a.signTransaction({
      type: 'eip1559', chainId: 31337, to, value, gas: 21_000n, nonce,
      maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei(tip),
    })

  // Fund W with enough for ONE tx (cost 21000 gwei = 2.1e13 wei) but not two.
  const [fundHash] = [await c.rpc('eth_sendRawTransaction', [await sign(funder, await nonceOf(funder.address), '0.001', w.address, 30_000_000_000_000n)])]
  await receipts(c, [fundHash])

  const logs: string[] = []
  const origLog = console.log
  console.log = (...a: unknown[]) => void logs.push(a.join(' '))
  try {
    const raws = [
      await sign(w, 0, '0.5'), //   sorted first, executes
      await sign(other, await nonceOf(other.address), '0.1'), // sorted second
      await sign(w, 1, '0.05'), //  sorted last, cannot pay: dropped
    ]
    await sleep(Number(BigInt(await c.rpc('sim_msUntilNextRound'))) + 60)
    const hashes: Hex[] = []
    for (const raw of raws) hashes.push(await c.rpc('eth_sendRawTransaction', [raw]))
    const [r0, r1] = await receipts(c, hashes.slice(0, 2))
    assert.equal(r0.blockNumber, r1.blockNumber, 'survivors share one block (they were sent within one round)')
    assert.deepEqual([Number(BigInt(r0.transactionIndex)), Number(BigInt(r1.transactionIndex))], [0, 1])
    // The dropped tx never gets a receipt, and the sequencer keeps working (no hang).
    await sleep(2500)
    assert.equal(await c.rpc('eth_getTransactionReceipt', [hashes[2]]), null)
    assert.ok(logs.some((l) => l.includes('dropped') && l.includes(hashes[2]!)), `expected a dropped log, got: ${logs.join(' | ')}`)
    // Fund W so the dropped tx (nonce 1) would now be affordable; it must still never be mined.
    await receipts(c, [await c.rpc('eth_sendRawTransaction', [await sign(funder, await nonceOf(funder.address), '0.001', w.address, 1_000_000_000_000_000n)])])
    await sleep(3500) // a few more rounds
    assert.equal(await c.rpc('eth_getTransactionReceipt', [hashes[2]]), null, 'dropped tx was evicted from the pool, never mined')
    const next = await c.rpc('eth_sendRawTransaction', [await sign(other, await nonceOf(other.address), '0.1')])
    await receipts(c, [next])
  } finally {
    console.log = origLog
  }
})

/** Sign a 21000-gas transfer from `acct` with an explicit nonce and tip (gwei string). */
const mkTx = (acct: ReturnType<typeof privateKeyToAccount>, n: number, tip = '0.1') =>
  acct.signTransaction({ type: 'eip1559', chainId: 31337, to: DEAD, value: 0n, gas: 21_000n, nonce: n, maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei(tip) })

async function captureLogs<T>(fn: (logs: string[]) => Promise<T>): Promise<T> {
  const logs: string[] = []
  const origLog = console.log
  setInternalVisible(true)
  console.log = (...a: unknown[]) => void logs.push(a.join(' '))
  try {
    return await fn(logs)
  } finally {
    console.log = origLog
    setInternalVisible(false)
  }
}

const anvilHead = (c: Ctx) => jsonRpc<Hex>(c.stack.params.anvilUrl, 'eth_blockNumber').then((h) => Number(BigInt(h)))

test('nonce gap (B2): a lone N+1 is HELD, not mined; N arriving within the hold window lands both, in nonce order', async () => {
  const c = pga!
  const acct = privateKeyToAccount(KEYS[2]!)
  const nonce = Number(BigInt(await c.rpc('eth_getTransactionCount', [acct.address, 'latest'])))
  await captureLogs(async (logs) => {
    const headBefore = await anvilHead(c)
    await sleep(Number(BigInt(await c.rpc('sim_msUntilNextRound'))) + 60)
    const gap = await c.rpc('eth_sendRawTransaction', [await mkTx(acct, nonce + 1, '0.5')])
    await sleep(2500) // two rounds run and hold it
    assert.ok(logs.some((l) => l.includes('held:') && l.includes(`nonce ${nonce + 1}: waiting for nonce ${nonce}`)), `got: ${logs.join(' | ')}`)
    assert.ok(!logs.some((l) => l.includes('dropped') && l.includes(gap)), 'held, not dropped')
    assert.equal(await c.rpc('eth_getTransactionReceipt', [gap]), null)
    assert.equal(await anvilHead(c), headBefore, 'nothing was submitted to Anvil and no block was mined')
    // Pending-nonce accounting stays consistent with the held tx: nonce N is still the next free nonce.
    assert.equal(Number(BigInt(await c.rpc('eth_getTransactionCount', [acct.address, 'pending']))), nonce)
    // N arrives within the window: both land, N before N+1 (and N+1 bids 5x the tip).
    const lo = await c.rpc('eth_sendRawTransaction', [await mkTx(acct, nonce, '0.1')])
    const [rLo, rGap] = await receipts(c, [lo, gap])
    assert.equal(rLo.status, '0x1')
    assert.equal(rGap.status, '0x1')
    assert.equal(rLo.blockNumber, rGap.blockNumber, 'one block once N arrived (the same round)')
    assert.ok(Number(BigInt(rLo.transactionIndex)) < Number(BigInt(rGap.transactionIndex)), 'N before N+1')
    assert.ok(logs.some((l) => l.includes('nonce rule: nonce') && l.includes(`${nonce} before nonce ${nonce + 1}`)), 'the nonce rule is narrated')
  })
})

test('nonce gap (B2): dropped with a visible log line after GAP_HOLD_ROUNDS; it never lands even if N arrives later', async () => {
  const c = gap!
  assert.equal((await c.rpc('sim_info')).gapHoldRounds, 2)
  const acct = privateKeyToAccount(KEYS[2]!)
  const nonce = Number(BigInt(await c.rpc('eth_getTransactionCount', [acct.address, 'latest'])))
  await captureLogs(async (logs) => {
    await sleep(Number(BigInt(await c.rpc('sim_msUntilNextRound'))) + 60)
    const g = await c.rpc('eth_sendRawTransaction', [await mkTx(acct, nonce + 1)])
    await sleep(3500) // rounds 1 and 2 hold it, the second reaches the limit
    assert.ok(logs.some((l) => l.includes('dropped') && l.includes(g) && /nonce gap not filled after 2 rounds; resend/.test(l)), `got: ${logs.join(' | ')}`)
    assert.equal(await c.rpc('eth_getTransactionReceipt', [g]), null)
    // The nonce is free again, and N alone lands; the dropped N+1 never does.
    const lo = await c.rpc('eth_sendRawTransaction', [await mkTx(acct, nonce)])
    const [r] = await receipts(c, [lo])
    assert.equal(r.status, '0x1')
    await sleep(2500)
    assert.equal(await c.rpc('eth_getTransactionReceipt', [g]), null)
  })
})

test('eth_fillTransaction: the queue-aware nonce applies ONLY when the caller passed none; an explicit nonce is never bumped', async () => {
  const c = pga!
  const acct = privateKeyToAccount(KEYS[0]!)
  const n = Number(BigInt(await c.rpc('eth_getTransactionCount', [acct.address, 'latest'])))
  await sleep(Number(BigInt(await c.rpc('sim_msUntilNextRound'))) + 60)
  const queued = await c.rpc('eth_sendRawTransaction', [await mkTx(acct, n)]) // nonce n waits in our queue
  const req = { from: acct.address, to: DEAD, value: '0x0', gas: '0x5208' }
  const without = await c.rpc('eth_fillTransaction', [req])
  assert.equal(Number(BigInt(without.tx.nonce)), n + 1, 'no nonce given: the queued tx is counted')
  const explicit = await c.rpc('eth_fillTransaction', [{ ...req, nonce: '0x' + n.toString(16) }])
  assert.equal(Number(BigInt(explicit.tx.nonce)), n, 'explicit nonce is kept')
  await receipts(c, [queued])
})

test('two txs with the same sender and nonce: the second is refused at submit (not accepted and silently dropped later)', async () => {
  // Regression for the reported hang: viem sending several txs concurrently from ONE wallet all read the same pending
  // nonce. The proxy used to accept every one, Anvil rejected the extras at round time, and their waiters hung.
  const c = pga!
  const acct = privateKeyToAccount(KEYS[1]!)
  const nonce = Number(BigInt(await c.rpc('eth_getTransactionCount', [acct.address, 'latest'])))
  const mk = (value: bigint, tip: string) =>
    acct.signTransaction({ type: 'eip1559', chainId: 31337, to: DEAD, value, gas: 21_000n, nonce, maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei(tip) })
  await sleep(Number(BigInt(await c.rpc('sim_msUntilNextRound'))) + 60)
  const first = await c.rpc('eth_sendRawTransaction', [await mk(1n, '0.01')])
  await assert.rejects(c.rpc('eth_sendRawTransaction', [await mk(2n, '0.02')]), (e: Error) => /already queued/.test(e.message))
  const [r] = await receipts(c, [first])
  assert.equal(r.status, '0x1')
  // The nonce is free again once the first one is mined.
  const next = await c.rpc('eth_sendRawTransaction', [await acct.signTransaction({ type: 'eip1559', chainId: 31337, to: DEAD, value: 0n, gas: 21_000n, nonce: nonce + 1, maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('0.01') })])
  await receipts(c, [next])
})

test('concurrent sends with the same sender and nonce: exactly one is accepted', async () => {
  const c = pga!
  const acct = privateKeyToAccount(KEYS[2]!)
  const nonce = Number(BigInt(await c.rpc('eth_getTransactionCount', [acct.address, 'latest'])))
  const raws = await Promise.all(
    [1n, 2n, 3n, 4n].map((value, i) =>
      acct.signTransaction({ type: 'eip1559', chainId: 31337, to: DEAD, value, gas: 21_000n, nonce, maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei(String(0.01 * (i + 1))) }),
    ),
  )
  const results = await Promise.allSettled(raws.map((raw) => c.rpc('eth_sendRawTransaction', [raw])))
  const ok = results.filter((r) => r.status === 'fulfilled')
  assert.equal(ok.length, 1, `exactly one accepted: ${results.map((r) => r.status).join(',')}`)
  for (const r of results) if (r.status === 'rejected') assert.match((r.reason as Error).message, /already queued/)
  const [r] = await receipts(c, [(ok[0] as PromiseFulfilledResult<Hex>).value])
  assert.equal(r.status, '0x1')
})

test('the identical raw tx sent twice concurrently returns the same hash both times and lands once', async () => {
  const c = pga!
  const acct = privateKeyToAccount(KEYS[1]!)
  const nonce = Number(BigInt(await c.rpc('eth_getTransactionCount', [acct.address, 'latest'])))
  const raw = await acct.signTransaction({ type: 'eip1559', chainId: 31337, to: DEAD, value: 7n, gas: 21_000n, nonce, maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('0.01') })
  const [a, b] = await Promise.all([c.rpc('eth_sendRawTransaction', [raw]), c.rpc('eth_sendRawTransaction', [raw])])
  assert.equal(a, b)
  const [r] = await receipts(c, [a])
  assert.equal(r.status, '0x1')
  await sleep(2500)
  assert.equal(Number(BigInt(await c.rpc('eth_getTransactionCount', [acct.address, 'latest']))), nonce + 1, 'mined exactly once')
})
