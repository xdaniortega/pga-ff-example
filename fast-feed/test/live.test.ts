// Unit tests for the live view's pure functions (fast-feed/client/live.ts): no network, no Anvil.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, test } from 'node:test'
import { parseGwei, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ANVIL_DEV_KEY_0 } from '../../shared/config.ts'
import type { FeedMessageJson } from '../client/client.ts'
import {
  decodeLiveRow,
  FOOTER,
  formatHeader,
  formatTable,
  formatTimingLine,
  groupRows,
  LiveRounds,
  myAddresses,
  NONCE_GATED,
  nonceGated,
  OUT_OF_ORDER,
  UNDECODABLE,
  outOfOrder,
  rowFromMessage,
  waitBlockVisible,
  yoursLabel,
  type LiveRow,
} from '../client/live.ts'

const account = privateKeyToAccount(ANVIL_DEV_KEY_0)
const DEAD = '0x000000000000000000000000000000000000dEaD'
const BASE = 10_000_000n // 0.01 gwei

async function message(opts: { tip: bigint; maxFee?: bigint; index?: number; block?: number; round?: number | null; legacy?: boolean; at?: number }): Promise<FeedMessageJson> {
  const maxFee = opts.maxFee ?? parseGwei('1')
  const raw: Hex = opts.legacy
    ? await account.signTransaction({ type: 'legacy', chainId: 31337, to: DEAD, value: 1n, gas: 21_000n, nonce: 0, gasPrice: BASE + opts.tip })
    : await account.signTransaction({ type: 'eip1559', chainId: 31337, to: DEAD, value: 1n, gas: 21_000n, nonce: 0, maxFeePerGas: maxFee, maxPriorityFeePerGas: opts.tip })
  const effective = opts.legacy ? BASE + opts.tip : BASE + (opts.tip < maxFee - BASE ? opts.tip : maxFee - BASE)
  const m: FeedMessageJson = {
    version: 1,
    timestamp_ms: opts.at ?? 1_000,
    transaction: {
      block_number: opts.block ?? 12,
      tx_index: opts.index ?? 0,
      raw_tx: raw,
      tx_hash: '0x' + '11'.repeat(32) as Hex,
      receipt: {
        status: 1,
        gas_used: 21_000,
        gas_used_for_l1: 0,
        cumulative_gas_used: 21_000,
        effective_gas_price: Number(effective),
        base_fee: Number(BASE),
        contract_address: null,
        logs: [],
      },
    },
  }
  if (opts.round !== null) m.pga_round = opts.round ?? 1
  return m
}

const row = async (o: Parameters<typeof message>[0], receivedAt = 1_040): Promise<LiveRow> => decodeLiveRow(await message(o), receivedAt)

test('fee and tip computation: bid from raw_tx, effective tip from the receipt, fee paid in ETH', async () => {
  const r = await row({ tip: parseGwei('0.05'), maxFee: parseGwei('2') })
  assert.deepEqual(r.bid, { kind: 'eip1559', maxPriority: parseGwei('0.05'), maxFee: parseGwei('2') })
  assert.equal(r.effectiveTip, parseGwei('0.05'), 'effective_gas_price - base_fee')
  assert.equal(r.gasUsed, 21_000n)
  assert.equal(r.feePaid, 21_000n * (BASE + parseGwei('0.05')), 'gas_used x effective_gas_price')
  assert.equal(r.from, account.address)
  assert.equal(r.to?.toLowerCase(), DEAD.toLowerCase())
  assert.equal(r.orderedAt, 1_000)
  const [g] = groupRows([r])
  const text = formatTable(g!).join('\n')
  assert.match(text, /0\.05 \/ 2 gwei/, 'bid with unit')
  assert.match(text, /0\.05 gwei/, 'effective tip with unit')
  assert.match(text, /21000 gas/, 'gas with unit')
  assert.match(text, /0\.00000126 ETH/, 'fee paid with unit: 21000 gas x 0.06 gwei')
})

test('a maxFee that caps the tip: the effective tip is below the bid', async () => {
  const r = await row({ tip: parseGwei('0.05'), maxFee: parseGwei('0.05') })
  assert.equal(r.effectiveTip, parseGwei('0.04'))
  assert.match(formatTable(groupRows([r])[0]!).join('\n'), /0\.05 \/ 0\.05 gwei.*0\.04 gwei/)
})

test('a legacy tx shows its gasPrice as the bid', async () => {
  const r = await row({ tip: parseGwei('0.02'), legacy: true })
  assert.deepEqual(r.bid, { kind: 'legacy', gasPrice: BASE + parseGwei('0.02') })
  assert.match(formatTable(groupRows([r])[0]!).join('\n'), /gasPrice 0\.03 gwei/)
})

test('grouping by (block, pga_round): rows sorted by tx_index, groups in first-seen order', async () => {
  const rows = [
    await row({ tip: 1n, index: 1, block: 5, round: 1 }),
    await row({ tip: 2n, index: 0, block: 5, round: 1 }),
    await row({ tip: 3n, index: 0, block: 5, round: 2 }), // the same block, another round: another table
    await row({ tip: 4n, index: 0, block: 6, round: 1 }),
  ]
  const groups = groupRows(rows)
  assert.deepEqual(groups.map((g) => [g.blockNumber, g.pgaRound, g.rows.map((r) => r.txIndex)]), [
    [5, 1, [0, 1]],
    [5, 2, [0]],
    [6, 1, [0]],
  ])
  assert.match(formatTable(groups[0]!)[0]!, /block 5 · round 1/)
})

test('B6b: a round-2 group whose first tx_index is > 0 labels yours as "index 0 of round 2" (tx_index is block-wide)', async () => {
  const rows = [
    await row({ tip: 1n, index: 0, block: 9, round: 1 }),
    await row({ tip: 1n, index: 1, block: 9, round: 1 }),
    await row({ tip: parseGwei('0.5'), index: 2, block: 9, round: 2 }), // mine, first of round 2, tx_index 2
    await row({ tip: 3n, index: 3, block: 9, round: 2 }),
  ]
  const g2 = groupRows(rows).find((g) => g.pgaRound === 2)!
  const lines = formatTable(g2, { mine: new Set([account.address.toLowerCase()]) })
  assert.match(lines[0]!, /block 9 · round 2 · 2 txs/)
  const mineLine = lines.find((l) => l.startsWith('>> '))!
  assert.match(mineLine, /yours, tip 0\.5 gwei, index 0 of round 2/)
  assert.match(mineLine, /^>> 2 /, 'the tx_index column still shows the block-wide index')
  assert.doesNotMatch(mineLine, /index 2 of round 2/)
})

test('grouping falls back to the block when pga_round is absent', async () => {
  const rows = [
    await row({ tip: 1n, index: 0, block: 7, round: null }),
    await row({ tip: 1n, index: 1, block: 7, round: null }),
    await row({ tip: 1n, index: 0, block: 8, round: null }),
  ]
  const groups = groupRows(rows)
  assert.deepEqual(groups.map((g) => [g.blockNumber, g.pgaRound, g.rows.length]), [[7, undefined, 2], [8, undefined, 1]])
  assert.match(formatTable(groups[0]!)[0]!, /block 7 · 2 txs/)
  assert.doesNotMatch(formatTable(groups[0]!)[0]!, /round/)
  assert.equal(formatTimingLine({ blockNumber: 7, leadMs: 3, visibleMs: 900 }), 'ordered → Fast Feed +3ms → block 7 visible on RPC +900ms')
})

test('out-of-order annotation: a row whose tip is above the row before it', async () => {
  const rows = [await row({ tip: 5n, index: 0 }), await row({ tip: 3n, index: 1 }), await row({ tip: 9n, index: 2 }), await row({ tip: 9n, index: 3 })]
  assert.deepEqual(rows.map((_, i) => outOfOrder(rows, i)), [false, false, true, false], 'equal tips are in order')
  const lines = formatTable(groupRows(rows)[0]!)
  assert.ok(lines.filter((l) => l.includes(OUT_OF_ORDER)).length === 1)
  assert.match(lines.find((l) => l.includes(OUT_OF_ORDER))!, /out of tip order \(nonce-gated \/ boosted\)/)
  const sorted = [await row({ tip: 5n, index: 0 }), await row({ tip: 3n, index: 1 })]
  assert.ok(!formatTable(groupRows(sorted)[0]!).join('\n').includes('out of tip order'))
})

test('out-of-order annotation says "nonce-gated" when the sender also appears earlier in the round with a lower nonce', async () => {
  const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d').address
  const rows = [
    { ...(await row({ tip: 1n, index: 0 })), nonce: 4 }, // sender A nonce 4, low tip
    { ...(await row({ tip: 3n, index: 1 })), nonce: 5 }, // sender A nonce 5, higher tip: waited for nonce 4
    { ...(await row({ tip: 2n, index: 2 })), nonce: 0, from: other }, // different sender
    { ...(await row({ tip: 9n, index: 3 })), nonce: 0, from: other }, // higher tip, but no lower nonce of its sender above
  ]
  assert.deepEqual(rows.map((_, i) => nonceGated(rows, i)), [false, true, false, false])
  const lines = formatTable(groupRows(rows)[0]!)
  assert.equal(lines.filter((l) => l.includes(NONCE_GATED)).length, 1)
  assert.equal(lines.filter((l) => l.includes(OUT_OF_ORDER)).length, 1, 'the plain annotation stays for the other row')
})

test('"yours": label text, and a >> marker that does not depend on color', async () => {
  const r = await row({ tip: parseGwei('1'), maxFee: parseGwei('2'), index: 0, block: 12, round: 1 })
  assert.equal(yoursLabel(r), 'yours, tip 1 gwei, index 0 of round 1')
  const other = await row({ tip: 1n, index: 1, block: 12, round: 1 })
  const mine = new Set([account.address.toLowerCase()])
  const lines = formatTable(groupRows([r, { ...other, from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }])[0]!, { mine })
  assert.match(lines[2]!, /^>> .*yours, tip 1 gwei, index 0 of round 1/)
  assert.ok(!lines[3]!.startsWith('>>') && !lines[3]!.includes('yours'))
  assert.ok(!lines.join('').includes('\x1b'), 'no ANSI unless asked')
  const bold = formatTable(groupRows([r])[0]!, { mine, bold: true })
  assert.ok(bold[2]!.includes('\x1b[1m') && bold[2]!.includes('>> '), 'bold on a TTY, marker still there')
})

test('myAddresses: PRIVATE_KEY, else Anvil account 0 locally, plus MY_ADDRESSES', () => {
  const a0 = account.address.toLowerCase()
  assert.deepEqual([...myAddresses({ mode: 'local' }, {})], [a0])
  const other = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
  assert.deepEqual([...myAddresses({ mode: 'local' }, { MY_ADDRESSES: ` ${other}, not-an-address ` })].sort(), [a0, other.toLowerCase()].sort())
  assert.deepEqual([...myAddresses({ mode: 'testnet' }, {})], [], 'no default wallet on a testnet')
  const pk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  assert.deepEqual(
    [...myAddresses({ mode: 'local' }, { PRIVATE_KEY: pk })].sort(),
    [a0, privateKeyToAccount(pk).address.toLowerCase()].sort(),
    'locally Anvil account 0 is always included, even with PRIVATE_KEY set',
  )
  assert.deepEqual([...myAddresses({ mode: 'testnet' }, { PRIVATE_KEY: pk })], [privateKeyToAccount(pk).address.toLowerCase()])
})

test('timing line: ordered (round R) → Fast Feed +Xms → block N visible on RPC +Yms', () => {
  assert.equal(formatTimingLine({ pgaRound: 1, blockNumber: 12, leadMs: 40, visibleMs: 1850 }), 'ordered (round 1) → Fast Feed +40ms → block 12 visible on RPC +1850ms')
  assert.match(formatTimingLine({ pgaRound: 1, blockNumber: 12, leadMs: 40 }), /block 12 not visible on RPC yet/)
  assert.match(formatTimingLine({ pgaRound: 1, blockNumber: 12, leadMs: -30, visibleMs: 5 }), /clock/, 'a negative lead (testnet clock skew) is flagged')
})

test('header: ticket round and time left, or "feed auth is off"', () => {
  assert.deepEqual(formatHeader({ auth: false }), ['Fast Feed live view. Feed auth is off; no ticket needed.'])
  const h = formatHeader({ auth: true, round: 3n, roundEnd: 1_000_042, now: 1_000_000, active: 2n })
  assert.match(h[0]!, /Ticket round 3: 42s left/)
  assert.match(h[1]!, /2 active ticket\(s\)/)
  assert.match(formatHeader({ auth: true, round: 3n, roundEnd: 1, now: 5, active: 0n })[1]!, /no active ticket/)
})

test('LiveRounds: a round prints when another (block, round) arrives or after the quiet period; the footer repeats every N rounds', async () => {
  const lines: string[] = []
  const tables: number[][] = []
  const v = new LiveRounds({
    rpcUrl: 'http://127.0.0.1:1', // never reachable: the timing line is not needed here
    out: (l) => lines.push(l),
    quietMs: 60,
    footerEvery: 2,
    visibilityDeadlineMs: 50,
    onTable: (r) => tables.push(r.group.rows.map((x) => x.txIndex)),
  })
  v.push(await row({ tip: 2n, index: 0, block: 1 }))
  v.push(await row({ tip: 1n, index: 1, block: 1 }))
  assert.deepEqual(tables, [], 'still collecting')
  v.push(await row({ tip: 1n, index: 0, block: 2 })) // another block: block 1 is complete
  assert.deepEqual(tables, [[0, 1]])
  await new Promise((r) => setTimeout(r, 150)) // quiet period: block 2 is complete
  assert.deepEqual(tables, [[0, 1], [0]])
  await v.drain()
  assert.equal(lines.filter((l) => l === FOOTER).length, 1, 'footer after 2 rounds')
  assert.equal(lines.filter((l) => l.startsWith('ordered (round 1)')).length, 2, 'one timing line per round')
  await v.finish(10)
  assert.equal(lines.at(-1), FOOTER)
})

test('rowFromMessage is pure: same input, same row', async () => {
  const m = await message({ tip: 7n })
  assert.deepEqual(rowFromMessage(m, account.address, 5), rowFromMessage(m, account.address, 5))
})

test('a zero tip: viem parses it as undefined, the bid still shows 0 / maxFee', async () => {
  const r = await row({ tip: 0n, maxFee: parseGwei('1') })
  assert.deepEqual(r.bid, { kind: 'eip1559', maxPriority: 0n, maxFee: parseGwei('1') })
  assert.equal(r.effectiveTip, 0n)
  assert.match(formatTable(groupRows([r])[0]!).join('\n'), /0 \/ 1 gwei +0 gwei/)
})

test('an undecodable raw_tx (e.g. the ArbOS internal tx) is shown with its receipt fields, not dropped', async () => {
  const m = await message({ tip: 1n, index: 0 })
  m.transaction.raw_tx = '0x6a' + 'ab'.repeat(20) as Hex // an unknown tx type
  const r = await decodeLiveRow(m, 1_040)
  assert.equal(r.from, null)
  assert.deepEqual(r.bid, { kind: 'unknown' })
  assert.equal(r.gasUsed, 21_000n)
  assert.equal(r.txIndex, 0)
  const lines = formatTable(groupRows([r])[0]!, { mine: new Set([account.address.toLowerCase()]) })
  assert.match(lines[2]!, new RegExp(UNDECODABLE.replace(/[()]/g, '\\$&')))
  assert.match(lines[2]!, /21000 gas/)
  assert.ok(!lines[2]!.startsWith('>>'))
})

// --- block-visibility probe: a fake JSON-RPC server that reveals block 12 after a delay -------------------------------
const servers: Server[] = []
after(() => void servers.forEach((s) => s.close()))
async function fakeRpc(revealAfterMs: number | null): Promise<{ url: string; startedAt: () => number }> {
  let t0 = 0
  const srv = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (!t0) t0 = Date.now()
      const visible = revealAfterMs !== null && Date.now() - t0 >= revealAfterMs
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: visible ? { number: '0xc' } : null }))
    })
  })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, startedAt: () => t0 }
}

test('the visibility probe starts with the first row, not at flush: Y stays near the real delay although the quiet period is longer (and the visible block flushes its round)', async () => {
  const DELAY = 150
  const QUIET = 500
  const fake = await fakeRpc(DELAY)
  const lines: string[] = []
  const v = new LiveRounds({ rpcUrl: fake.url, out: (l) => lines.push(l), quietMs: QUIET, footerEvery: 0 })
  v.push(await row({ tip: 1n, index: 0, block: 12 }, Date.now()))
  await new Promise((r) => setTimeout(r, 300)) // the block is visible by now (block-aware completion flushed the round; the quiet period is 500ms)
  assert.ok(lines.some((l) => l.startsWith('──')), 'C7: a visible block completes its round at once, without waiting for the quiet period')
  await v.drain() // A probe started at flush time would only see the block later
  const timing = lines.find((l) => l.startsWith('ordered'))!
  const y = Number(/visible on RPC \+(\d+)ms/.exec(timing)![1])
  assert.ok(y >= DELAY - 20 && y < 300, `Y (${y}ms) is near ${DELAY}ms (a flush-time probe would give >= 450ms)`)
})

test('the timing line is printed after its table, even when the probe resolved before the flush', async () => {
  const QUIET = 200
  const fake = await fakeRpc(0) // visible on the first request
  const lines: string[] = []
  const v = new LiveRounds({ rpcUrl: fake.url, out: (l) => lines.push(l), quietMs: QUIET, footerEvery: 0 })
  v.push(await row({ tip: 1n, index: 0, block: 12 }, Date.now()))
  const end = Date.now() + 5000
  while (!lines.some((l) => l.startsWith('ordered')) && Date.now() < end) await new Promise((r) => setTimeout(r, 20)) // no drain(): the quiet timer flushes
  const t = lines.findIndex((l) => l.startsWith('ordered'))
  assert.ok(t >= 0, 'a timing line was printed')
  assert.ok(lines.findIndex((l) => l.startsWith('──')) >= 0 && lines.findIndex((l) => l.startsWith('──')) < t, `the table comes before the timing line: ${JSON.stringify(lines)}`)
  assert.ok(Number(/visible on RPC \+(\d+)ms/.exec(lines[t]!)![1]) < 100, 'Y is small: the block was visible at once')
})

test('a block that is never revealed: the timing says "not visible", with no positive Y', async () => {
  const fake = await fakeRpc(null)
  const lines: string[] = []
  const timings: (number | undefined)[] = []
  const v = new LiveRounds({
    rpcUrl: fake.url,
    out: (l) => lines.push(l),
    quietMs: 30,
    footerEvery: 0,
    visibilityDeadlineMs: 250,
    onTiming: (rep) => timings.push(rep.timing!.visibleMs),
  })
  v.push(await row({ tip: 1n, index: 0, block: 12 }, Date.now()))
  await v.drain()
  assert.deepEqual(timings, [undefined])
  assert.match(lines.find((l) => l.startsWith('ordered'))!, /block 12 not visible on RPC yet/)
  assert.ok(!lines.some((l) => /visible on RPC \+/.test(l)))
})

test('E2: retime moves the received times of rows and blocks (a pause is taken out of "visible minus received")', async () => {
  const fake = await fakeRpc(null)
  const v = new LiveRounds({ rpcUrl: fake.url, out: () => {}, quietMs: 60_000, footerEvery: 0, visibilityDeadlineMs: 100 })
  const r1 = await row({ tip: 1n, index: 0, block: 7 }, 1_000)
  const r2 = await row({ tip: 1n, index: 1, block: 7 }, 1_500)
  v.push(r1)
  v.push(r2)
  v.retime((t) => t + 10_000)
  assert.equal(r1.receivedAt, 11_000)
  assert.equal(r2.receivedAt, 11_500)
  assert.equal(v.block(7)!.firstReceivedAt, 11_000)
  assert.equal(v.block(7)!.rows[1]!.receivedAt, 11_500, 'the shared row object is moved exactly once')
  await v.drain()
})

test('E2: the block-visible probe does not run its deadline while paused', async () => {
  const fake = await fakeRpc(null) // never visible
  let paused = true
  const p = waitBlockVisible(fake.url, 5, 150, 20, () => paused)
  let settled = false
  void p.then(() => (settled = true))
  await new Promise((r) => setTimeout(r, 500)) // well past the 150ms deadline
  assert.equal(settled, false, 'paused: still waiting')
  paused = false
  assert.equal(await p, undefined, 'the deadline runs again after the resume')
})
