// Slow preset, in-process stack on non-default ports. Asserts the A1 contract:
// (FEED_AUTH=off: the open feed of A1; ticket auth is covered in tickets.integration.test.ts)
// one feed message per tx, documented fields, hash equality, and feed BEFORE block visibility.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createWalletClient, http, keccak256, parseGwei, parseTransaction, createPublicClient, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { localPreset } from '../../shared/config.ts'
import { connectFeed, decodeFeedMessage, type FeedClient, type FeedMessageJson } from '../client/client.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

const env = { ...process.env, SIM_RPC_PORT: '18547', SIM_FEED_PORT: '19642', SIM_ANVIL_PORT: '18545', BLOCK_PUBLISH_DELAY_MS: '300', FEED_AUTH: 'off' } // 300ms margin so the "hidden at arrival" probes cannot race the reveal
const preset = localPreset('slow', env)
const KEY1: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // public Anvil dev key #1
const DEAD = '0x000000000000000000000000000000000000dEaD'

let stack: Stack
let client: FeedClient
const messages: { msg: FeedMessageJson; at: number }[] = []
// Gate probes fired the instant a feed message arrives: block must still be hidden on the proxy.
const gates = new Map<string, Promise<{ head: number; block: unknown }>>()

before(async () => {
  buildContracts() // fresh clones have no out/ or lib/: deploy needs the artifacts
  stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
  client = connectFeed({
    url: preset.feedUrl,
    onMessage: (msg, at) => {
      messages.push({ msg, at })
      const n = msg.transaction.block_number
      gates.set(
        msg.transaction.tx_hash,
        (async () => ({
          head: Number(BigInt(await rpc('eth_blockNumber', []))),
          block: await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false]),
        }))(),
      )
    },
  })
  await client.ready
})
after(async () => {
  await client?.close()
  await stack?.stop()
})

const anvilRpc = async (method: string, params: unknown[]) => {
  const r = await fetch(preset.local!.anvilUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return ((await r.json()) as { result: any }).result
}

const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(preset.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return ((await r.json()) as { result: any }).result
}

test('feed message arrives before its block is visible; fields are documented and consistent', async () => {
  const account = privateKeyToAccount(KEY1)
  const chain = { id: preset.chainId, name: 'local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [preset.rpcUrl] } } }
  const wallet = createWalletClient({ account, chain, transport: http(preset.rpcUrl) })
  const pub = createPublicClient({ chain, transport: http(preset.rpcUrl) })

  const hash = await wallet.sendTransaction({ to: DEAD, value: 1n, maxPriorityFeePerGas: parseGwei('1'), maxFeePerGas: parseGwei('2') })

  // Queued, not mined yet, or mined but hidden: never visible straight away.
  assert.equal(await rpc('eth_getTransactionReceipt', [hash]), null)

  // Poll until the tx's block is visible (receipt appears). Deadline: a broken sequencer fails, not hangs.
  let visibleAt = 0
  const deadline = Date.now() + 15_000
  while (!visibleAt) {
    assert.ok(Date.now() < deadline, 'block never became visible within 15s')
    if (await rpc('eth_getTransactionReceipt', [hash])) visibleAt = Date.now()
    else await new Promise((r) => setTimeout(r, 10))
  }
  const matching = messages.filter((x) => x.msg.transaction.tx_hash === hash)
  assert.equal(matching.length, 1, 'exactly one feed message for the tx')
  const { msg, at } = matching[0]!
  assert.ok(at < visibleAt, 'feed message must precede block visibility on RPC')
  const gate = await gates.get(hash)!
  assert.equal(gate.block, null, 'eth_getBlockByNumber(block_number) is null when the feed message arrives')
  assert.ok(gate.head < msg.transaction.block_number, 'eth_blockNumber < block_number when the feed message arrives')

  // Documented fields and types.
  assert.equal(msg.version, 1)
  assert.equal(typeof msg.timestamp_ms, 'number')
  assert.equal(typeof msg.pga_round, 'number')
  const t = msg.transaction
  assert.equal(typeof t.block_number, 'number')
  assert.equal(typeof t.tx_index, 'number')
  for (const h of [t.raw_tx, t.tx_hash]) assert.match(h, /^0x[0-9a-f]+$/i)
  const r = t.receipt
  for (const k of ['status', 'gas_used', 'gas_used_for_l1', 'cumulative_gas_used', 'effective_gas_price', 'base_fee'] as const)
    assert.equal(typeof r[k], 'number', k)
  assert.ok(r.contract_address === null || /^0x[0-9a-f]{40}$/i.test(r.contract_address))
  assert.ok(Array.isArray(r.logs))
  assert.ok(!('block_hash' in r))

  // Hash equality.
  assert.equal(keccak256(t.raw_tx), t.tx_hash)
  assert.equal(t.tx_hash, hash)
  assert.equal(parseTransaction(t.raw_tx).to?.toLowerCase(), DEAD.toLowerCase())

  // Decoded view.
  const d = await decodeFeedMessage(msg)
  assert.equal(d.from.toLowerCase(), account.address.toLowerCase())
  assert.equal(d.tip, BigInt(r.effective_gas_price) - BigInt(r.base_fee))

  // Matches the receipt served later by the proxy.
  const receipt = await pub.getTransactionReceipt({ hash })
  assert.equal(Number(receipt.blockNumber), t.block_number)
  assert.equal(receipt.transactionIndex, t.tx_index)
  assert.equal(receipt.status === 'success' ? 1 : 0, r.status)
  assert.equal(Number(receipt.gasUsed), r.gas_used)
  assert.equal(Number(receipt.effectiveGasPrice), r.effective_gas_price)
})

test('rejects synchronously: nonce too low, insufficient funds; pending nonce is consistent', async () => {
  const account = privateKeyToAccount(KEY1)
  const chain = { id: preset.chainId, name: 'local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [preset.rpcUrl] } } }
  const wallet = createWalletClient({ account, chain, transport: http(preset.rpcUrl) })
  const anvilNonce = async () => Number(BigInt(await anvilRpc('eth_getTransactionCount', [account.address, 'latest'])))
  const sendOne = () => wallet.sendTransaction({ to: DEAD, value: 1n, maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: 1n })
  const waitVisible = async (hash: Hex) => {
    const until = Date.now() + 15_000
    while (!(await rpc('eth_getTransactionReceipt', [hash]))) {
      assert.ok(Date.now() < until, 'tx never visible')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  // Self-contained: send and mine a tx first, so its nonce is certainly used up.
  const usedNonce = await anvilNonce()
  const first = await sendOne()
  await waitVisible(first)
  assert.equal(await anvilNonce(), usedNonce + 1)
  const rich = await wallet.signTransaction({ to: DEAD, value: 2n, nonce: usedNonce, gas: 21000n, maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: 1n, chain })
  const r = await fetch(preset.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [rich] }) })
  const body = (await r.json()) as { error?: { message: string } }
  assert.match(body.error?.message ?? '', /nonce too low/)

  // After one queued send, latest and pending both equal Anvil's nonce + 1 (queued txs count for both).
  const base = await anvilNonce()
  const queued = await sendOne()
  for (const tag of ['latest', 'pending']) {
    assert.equal(Number(BigInt(await rpc('eth_getTransactionCount', [account.address, tag]))), base + 1, tag)
  }
  await waitVisible(queued)

  const poor = privateKeyToAccount('0x' + '11'.repeat(32) as Hex)
  const poorSigned = await createWalletClient({ account: poor, chain, transport: http(preset.rpcUrl) }).signTransaction({ to: DEAD, value: 1n, nonce: 0, gas: 21000n, maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: 1n, chain })
  const r2 = await fetch(preset.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [poorSigned] }) })
  assert.match(((await r2.json()) as { error?: { message: string } }).error?.message ?? '', /insufficient funds/)

  // Two back-to-back sends: second must get the next nonce even though the first is only queued.
  const h1 = await wallet.sendTransaction({ to: DEAD, value: 1n, maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: 1n })
  const h2 = await wallet.sendTransaction({ to: DEAD, value: 1n, maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: 1n })
  assert.notEqual(h1, h2)
  const deadline = Date.now() + 15_000
  while (!(await rpc('eth_getTransactionReceipt', [h2]))) {
    assert.ok(Date.now() < deadline, 'second tx never visible')
    await new Promise((r) => setTimeout(r, 20))
  }
  for (const h of [h1, h2]) assert.ok(messages.some((m) => m.msg.transaction.tx_hash === h && m.msg.transaction.raw_tx !== '0x'))
})
