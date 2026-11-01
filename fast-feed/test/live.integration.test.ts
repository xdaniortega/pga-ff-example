// A4: the live view end to end. Slow preset (B=2000ms, K=2 -> round 1000ms), alternate ports, FEED_AUTH=off,
// background traffic in-process, one injected tx from Anvil account 0 with a 1 gwei tip.
// Asserts ordering and structure only, never absolute durations. Every wait has a deadline.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import { parseGwei, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ANVIL_DEV_KEY_0, localPreset, resolvePreset } from '../../shared/config.ts'
import { connectFeed, type FeedClient } from '../client/client.ts'
import { decodeLiveRow, formatHeader, LiveRounds, myAddresses, outOfOrder, readHeader, type RoundReport } from '../client/live.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'
import { startTraffic, type Traffic } from '../../sim/traffic.ts'

const env: NodeJS.ProcessEnv = { ...process.env, SIM_RPC_PORT: '58547', SIM_FEED_PORT: '59642', SIM_ANVIL_PORT: '58545', FEED_AUTH: 'off' }
delete env.PRIVATE_KEY
delete env.MY_ADDRESSES
const preset = localPreset('slow', env)
const DEAD = '0x000000000000000000000000000000000000dEaD'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms
  while (!(await cond())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`)
    await sleep(50)
  }
}
async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(preset.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  return body.result as T
}

let stack: Stack
let traffic: Traffic
let client: FeedClient
let view: LiveRounds
const reports: RoundReport[] = []
const lines: string[] = []
const acct0 = privateKeyToAccount(ANVIL_DEV_KEY_0)

before(async () => {
  buildContracts()
  stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
  view = new LiveRounds({
    rpcUrl: preset.rpcUrl,
    mine: myAddresses(preset, env),
    out: (l) => lines.push(l),
    onTable: (r) => reports.push(r),
    footerEvery: 0,
  })
  let chain: Promise<void> = Promise.resolve()
  client = connectFeed({
    url: preset.feedUrl,
    onMessage: (msg, at) => {
      chain = chain.then(async () => {
        const row = await decodeLiveRow(msg, at)
        view.push(row)
      })
    },
  })
  await client.ready
  traffic = await startTraffic({ rpcUrl: preset.rpcUrl, chainId: preset.chainId, tps: 3, baseFeeWei: stack.params.baseFeeWei, statsEveryMs: 0 })
}, { timeout: 120_000 })

after(async () => {
  await traffic?.stop()
  await client?.close()
  await stack?.stop()
})

test('live view: rounds are tip-ordered tables, the injected tx is row 0 and "yours", every round has a timing line', { timeout: 120_000 }, async () => {
  // Let a few rounds of background traffic through first.
  await until(() => reports.length >= 3, 30_000, 'three traffic rounds')

  // Inject a 1 gwei tx just after a round tick so it shares its round with the traffic (retry if a round had none).
  let mine: RoundReport | undefined
  let injected: Hex | undefined
  for (let attempt = 0; attempt < 4 && !mine; attempt++) {
    const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [acct0.address, 'latest'])))
    const raw = await acct0.signTransaction({
      type: 'eip1559', chainId: preset.chainId, to: DEAD, value: 1n, gas: 21_000n, nonce,
      maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei('1'),
    })
    await sleep(Number(BigInt(await rpc('sim_msUntilNextRound'))) + 60)
    injected = await rpc<Hex>('eth_sendRawTransaction', [raw])
    await until(() => reports.some((r) => r.group.rows.some((x) => x.hash === injected)), 20_000, 'the round with our tx to print')
    const r = reports.find((x) => x.group.rows.some((row) => row.hash === injected))!
    if (r.group.rows.length > 1) mine = r
  }
  assert.ok(mine, 'our tx landed in a round that also had traffic')

  // More rounds after it. Then stop the traffic, snapshot the rounds printed so far, and wait (with a deadline) until
  // every round in the snapshot has its timing line. Assertions use only that snapshot.
  const have = reports.length
  await until(() => reports.length >= have + 2, 30_000, 'two more rounds')
  await traffic.stop()
  const snapshot = [...reports]
  await until(() => snapshot.every((r) => r.timing), 30_000, 'a timing line for every round in the snapshot')

  for (const r of snapshot) {
    const rows = r.group.rows
    // tx_index counts block-wide: round 2 of a block continues after round 1's txs, so only the ORDER (consecutive) is fixed.
    assert.deepEqual(rows.map((x) => x.txIndex), rows.map((_, i) => rows[0]!.txIndex + i), `block ${r.group.blockNumber}: rows are in tx_index order`)
    rows.forEach((x, i) => {
      assert.ok(!outOfOrder(rows, i), `block ${r.group.blockNumber}: effective tips do not increase down the table (${rows.map((y) => y.effectiveTip)})`)
    })
    assert.ok(r.timing && r.timingLine, `block ${r.group.blockNumber} has a timing line`)
    assert.match(r.timingLine!, /^ordered \(round [12]\) → Fast Feed \+\d+ms → block \d+ visible on RPC \+\d+ms$/)
    assert.ok(r.timing!.visibleMs !== undefined && r.timing!.visibleMs > 0, 'the block became visible after the feed message')
    assert.ok([1, 2].includes(r.group.pgaRound!), 'locally pga_round is 1 or 2 (K = 2 rounds per block)')
  }
  const snapshotLeads = snapshot.flatMap((r) => r.group.rows.map((x) => x.receivedAt - x.orderedAt))
  assert.ok(snapshotLeads.length > 0 && snapshotLeads.every((l) => l > 0), `every message has a positive lead (${snapshotLeads.slice(0, 10)})`)
  assert.ok(snapshot.includes(mine), 'our round is in the snapshot')

  const rows = mine.group.rows
  assert.equal(rows[0]!.hash, injected, 'the injected tx is row 0 of its round')
  assert.equal(rows[0]!.effectiveTip, parseGwei('1'))
  assert.ok(rows.length > 1)
  const myLine = mine.table.find((l) => l.startsWith('>>'))
  assert.ok(myLine, 'the row is highlighted with >>')
  assert.match(myLine!, /yours, tip 1 gwei, index 0 of round [12]/)
  assert.equal(mine.table.filter((l) => l.startsWith('>>')).length, 1, 'only our row is highlighted')
  assert.ok(traffic.stats().sent > 0)
})

test('the header handles feed auth off and on', { timeout: 30_000 }, async () => {
  assert.deepEqual(formatHeader(await readHeader(preset, undefined, false)), ['Fast Feed live view. Feed auth is off; no ticket needed.'])
  const h = await readHeader(await resolvePreset(preset), undefined, true)
  assert.ok(h.auth && !('unavailable' in h), `ticket round read: ${JSON.stringify(h, (_, v) => (typeof v === 'bigint' ? String(v) : v))}`)
  assert.match(formatHeader(h)[0]!, /^Fast Feed live view\. Ticket round \d+: \d+s left/)
})

test('stopping leaves no anvil behind', { timeout: 30_000 }, async () => {
  await traffic.stop()
  await client.close()
  await stack.stop()
  const out = spawnSync('pgrep', ['-f', `anvil.*--port ${env.SIM_ANVIL_PORT}`], { encoding: 'utf8' })
  assert.equal(out.stdout.trim(), '', `no anvil on port ${env.SIM_ANVIL_PORT}`)
})
