// B6a/B6b: K = 2 PGA rounds share ONE block.
// B = 6000ms (round 3000ms) so a send window is wide even on a loaded machine; FEED_AUTH=off; alternate ports.
// One stack, one block's two rounds (the scenario), then assertions on the recorded feed and RPC observations:
//   round 1: approve (acct 0, tip 0.001) + a transfer (acct 2, tip 0.002)  -> block N, pga_round 1
//   round 2: transferFrom (acct 1, tip 0.001, needs round 1's approval) + a transfer (acct 3, tip 1 gwei) -> block N, pga_round 2
// Asserts ordering and equality only, never absolute durations.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { encodeFunctionData, parseAbi, parseGwei, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvilDevKey, localPreset } from '../../shared/config.ts'
import { connectFeed, type FeedClient, type FeedMessageJson } from '../../fast-feed/client/client.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

const ENV = {
  ...process.env,
  SIM_BLOCK_MS: '6000',
  BLOCK_PUBLISH_DELAY_MS: '300',
  FEED_AUTH: 'off',
  SIM_ORDER: 'pga',
  SIM_RPC_PORT: '64547',
  SIM_FEED_PORT: '64642',
  SIM_ANVIL_PORT: '64545',
}
const ROUND_MS = 3000
const DEAD = '0x000000000000000000000000000000000000dEaD'
const ERC20 = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256)', 'function transferFrom(address,address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Seen {
  msg: FeedMessageJson
  at: number
  /** eth_getBlockByNumber(N) answered right when the message arrived: null = not visible. */
  blockVisible: Promise<boolean>
}

let stack: Stack | undefined
let client: FeedClient | undefined
let rpcUrl = ''
let token = '' as Hex
const seen: Seen[] = []

async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = (await r.json()) as { result?: any; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}
const hex = (n: number) => '0x' + n.toString(16)

/** Wait until the round collecting txs is `round` (1 or 2), a little way into it and still early, so a whole batch fits. */
async function inRound(round: 1 | 2): Promise<void> {
  const deadline = Date.now() + 4 * ROUND_MS * 2
  for (;;) {
    if (Date.now() > deadline) throw new Error(`never reached an early part of round ${round}`)
    const info = await rpc('sim_blockInfo')
    const left = Number(BigInt(await rpc('sim_msUntilNextRound')))
    // 600ms in: the previous round has finished executing (it may take a few hundred ms on a loaded machine), so the window
    // left is long enough to fit a whole batch in this one round.
    if (info.round === round && left > 1500 && left < ROUND_MS - 600) return
    await sleep(40)
  }
}

async function sign(i: number, o: { to: Hex; data?: Hex; tip: string; gas?: bigint }): Promise<Hex> {
  const a = privateKeyToAccount(anvilDevKey(i))
  const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [a.address, 'latest'])))
  return a.signTransaction({ type: 'eip1559', chainId: 31337, nonce, to: o.to, data: o.data, value: 0n, gas: o.gas ?? 100_000n, maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei(o.tip) })
}
const send = (raw: Hex): Promise<Hex> => rpc('eth_sendRawTransaction', [raw])
async function receiptOf(h: Hex): Promise<any> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const r = await rpc('eth_getTransactionReceipt', [h])
    if (r) return r
    if (Date.now() > deadline) throw new Error(`no receipt for ${h}`)
    await sleep(100)
  }
}

const h = { approve: '' as Hex, t2: '' as Hex, from: '' as Hex, t3: '' as Hex }
let allowanceBetweenRounds = 0n
let blockNInfoRound2 = 0
let blockNAtStartOfRound2: unknown

before(async () => {
  buildContracts()
  const preset = localPreset('slow', ENV)
  rpcUrl = preset.rpcUrl
  stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
  token = stack.contracts.testToken as Hex
  client = connectFeed({
    url: preset.feedUrl,
    onMessage: (msg) => {
      seen.push({ msg, at: Date.now(), blockVisible: rpc('eth_getBlockByNumber', [hex(msg.transaction.block_number), false]).then((b) => b !== null) })
    },
  })
  await client.ready

  // Setup (any rounds): give account 0 TEST to be pulled later. Wait for the receipt (block visible), then forget these messages.
  const mintHash = await send(await sign(0, { to: token, data: encodeFunctionData({ abi: ERC20, functionName: 'mint', args: [privateKeyToAccount(anvilDevKey(0)).address, 1000n] }), tip: '0.001' }))
  await receiptOf(mintHash)
  await sleep(300)
  seen.length = 0

  const a0 = privateKeyToAccount(anvilDevKey(0)).address
  const a1 = privateKeyToAccount(anvilDevKey(1)).address
  // Pre-sign nothing for round 2 until round 2 starts (nonces come from the pending count).
  await inRound(1)
  const info1 = await rpc('sim_blockInfo')
  h.approve = await send(await sign(0, { to: token, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [a1, 100n] }), tip: '0.001' }))
  const t2 = await send(await sign(2, { to: DEAD, tip: '0.002', gas: 21_000n }))
  h.t2 = t2
  await inRound(2)
  const info2 = await rpc('sim_blockInfo')
  assert.equal(info2.block, info1.block, 'sim_blockInfo: both rounds belong to the same block number')
  blockNInfoRound2 = info2.block
  // Round 2: reads already see round 1 (state at latest), while block N is not visible on RPC.
  allowanceBetweenRounds = BigInt(await rpc('eth_call', [{ to: token, data: encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [a0, a1] }) }, 'latest']))
  blockNAtStartOfRound2 = await rpc('eth_getBlockByNumber', [hex(info2.block), false])
  h.from = await send(await sign(1, { to: token, data: encodeFunctionData({ abi: ERC20, functionName: 'transferFrom', args: [a0, DEAD, 50n] }), tip: '0.001' }))
  h.t3 = await send(await sign(3, { to: DEAD, tip: '1', gas: 21_000n }))
  // Block N becomes visible after round 2: wait for the last receipt.
  await receiptOf(h.t3)
  await sleep(200)
})

after(async () => {
  await client?.close()
  await stack?.stop()
})

const msgOf = (hash: Hex) => seen.find((s) => s.msg.transaction.tx_hash.toLowerCase() === hash.toLowerCase())!

test('two rounds in one block on the feed: pga_round 1 then 2, the same block_number, tx_index continuing', () => {
  const byIndex = (a: Seen, b: Seen) => a.msg.transaction.tx_index - b.msg.transaction.tx_index
  const r1 = [h.approve, h.t2].map(msgOf).sort(byIndex)
  const r2 = [h.from, h.t3].map(msgOf).sort(byIndex)
  for (const s of [...r1, ...r2]) assert.ok(s, 'every tx was published')
  assert.deepEqual(r1.map((s) => s.msg.pga_round), [1, 1])
  assert.deepEqual(r2.map((s) => s.msg.pga_round), [2, 2])
  const n = r1[0]!.msg.transaction.block_number
  assert.equal(n, blockNInfoRound2, 'sim_blockInfo named the block that was then mined')
  for (const s of [...r1, ...r2]) assert.equal(s.msg.transaction.block_number, n)
  // Round 1: the higher tip first. Round 2: index continues after round 1's.
  assert.deepEqual(r1.map((s) => s.msg.transaction.tx_hash.toLowerCase()), [h.t2, h.approve].map((x) => x.toLowerCase()))
  const idx = [...r1, ...r2].map((s) => s.msg.transaction.tx_index)
  assert.deepEqual(idx, [0, 1, 2, 3].map((i) => idx[0]! + i), 'tx_index is contiguous across the block')
  // All of round 1 arrived before any of round 2.
  assert.ok(Math.max(...r1.map((s) => s.at)) < Math.min(...r2.map((s) => s.at)))
})

test('round 1 and round 2 are both on the feed before block N is visible on RPC; it is visible after round 2', async () => {
  const r1 = [h.approve, h.t2].map(msgOf)
  const r2 = [h.from, h.t3].map(msgOf)
  for (const s of [...r1, ...r2]) assert.equal(await s.blockVisible, false, `block ${s.msg.transaction.block_number} was not visible when pga_round ${s.msg.pga_round} arrived`)
  assert.equal(blockNAtStartOfRound2, null, 'block N is still hidden during round 2')
  const b = await rpc('eth_getBlockByNumber', [hex(r1[0]!.msg.transaction.block_number), false])
  assert.ok(b, 'visible after round 2')
  assert.equal(b.transactions.length, 4, 'one block holds both rounds')
})

test('every receipt published on the feed equals the final RPC receipt; the runtime counter is 0', async () => {
  for (const hash of [h.approve, h.t2, h.from, h.t3]) {
    const f = msgOf(hash).msg.transaction
    const c = await rpc('eth_getTransactionReceipt', [hash])
    assert.equal(f.receipt.status, Number(BigInt(c.status)))
    assert.equal(f.receipt.gas_used, Number(BigInt(c.gasUsed)))
    assert.equal(f.receipt.cumulative_gas_used, Number(BigInt(c.cumulativeGasUsed)))
    assert.equal(f.receipt.effective_gas_price, Number(BigInt(c.effectiveGasPrice)))
    assert.equal(f.tx_index, Number(BigInt(c.transactionIndex)))
    assert.equal(f.block_number, Number(BigInt(c.blockNumber)))
    assert.deepEqual(f.receipt.logs.map((l) => [l.address.toLowerCase(), l.topics, l.data]), c.logs.map((l: any) => [l.address.toLowerCase(), l.topics, l.data]))
    const blk = await rpc('eth_getBlockByNumber', [c.blockNumber, false])
    assert.equal(f.receipt.base_fee, Number(BigInt(blk.baseFeePerGas)))
  }
  const info = await rpc('sim_info')
  assert.equal(info.receiptMismatches, 0)
  assert.equal((await rpc('sim_blockInfo')).receiptMismatches, 0)
})

test('a high-tip tx sent in round 2 lands after round 1\'s txs (it cannot overtake published txs)', () => {
  const hi = msgOf(h.t3).msg.transaction
  for (const hash of [h.approve, h.t2]) assert.ok(msgOf(hash).msg.transaction.tx_index < hi.tx_index)
  // Within round 2 the tip order still applies: 1 gwei before 0.001.
  assert.ok(hi.tx_index < msgOf(h.from).msg.transaction.tx_index)
})

test('a state change in round 1 is visible to a dependent read and tx in round 2 (approve, then transferFrom)', async () => {
  assert.equal(allowanceBetweenRounds, 100n, 'eth_call at latest during round 2 sees round 1\'s approve')
  const c = await rpc('eth_getTransactionReceipt', [h.from])
  assert.equal(c.status, '0x1', 'transferFrom succeeded in round 2: it executed after the approve')
  assert.equal(msgOf(h.from).msg.transaction.receipt.status, 1)
})

test('sim_boostTrace tells the block and the pga_round of an included tx; sim_msUntilNextBlock is within one block', async () => {
  const trace = await rpc('sim_boostTrace', [h.t3])
  const inc = trace.find((e: any) => e.included)
  assert.equal(inc.pgaRound, 2)
  assert.equal(inc.block, msgOf(h.t3).msg.transaction.block_number)
  const ms = Number(BigInt(await rpc('sim_msUntilNextBlock')))
  assert.ok(ms > 0 && ms <= 6000)
})

test('round 1 only: an EMPTY round 2 still closes the block (re-mined and revealed), with the same receipt the feed published', async () => {
  await inRound(1)
  const before = await rpc('sim_blockInfo')
  const hash = await send(await sign(4, { to: DEAD, tip: '0.003', gas: 21_000n }))
  const deadline = Date.now() + 10_000
  while (!seen.some((s) => s.msg.transaction.tx_hash.toLowerCase() === hash.toLowerCase())) {
    if (Date.now() > deadline) throw new Error('the round 1 message never arrived')
    await sleep(50)
  }
  const m = msgOf(hash)
  assert.equal(m.msg.pga_round, 1)
  assert.equal(m.msg.transaction.block_number, before.block, 'sim_blockInfo named the block that was then mined')
  assert.equal(await m.blockVisible, false, 'the open block is hidden while round 2 may still add')
  // Round 2 has nothing: the block must still be closed. If it were left open it would never be revealed and this would time out.
  const receipt = await receiptOf(hash)
  assert.equal(Number(BigInt(receipt.blockNumber)), m.msg.transaction.block_number)
  const f = m.msg.transaction
  assert.equal(f.receipt.gas_used, Number(BigInt(receipt.gasUsed)))
  assert.equal(f.receipt.cumulative_gas_used, Number(BigInt(receipt.cumulativeGasUsed)))
  assert.equal(f.tx_index, Number(BigInt(receipt.transactionIndex)))
  assert.equal(seen.filter((s) => s.msg.transaction.block_number === f.block_number && s.msg.pga_round === 2).length, 0, 'round 2 published nothing for this block')
  assert.equal((await rpc('sim_info')).receiptMismatches, 0)
  // The next block starts fresh: the next tx opens a new block number.
  await inRound(1)
  const next = await send(await sign(4, { to: DEAD, tip: '0.003', gas: 21_000n }))
  const r2 = await receiptOf(next)
  assert.ok(Number(BigInt(r2.blockNumber)) > f.block_number)
})
