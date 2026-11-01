// E2: the simulator can freeze and skip its clock (local only). Slow preset (B = 2000ms, K = 2), feed auth ON, a 12 s ticket round,
// own ports. Asserts rounds, blocks and ordering, never absolute durations (the pause lengths only have to exceed what they test).
//  1. pause for 1.5 ticket rounds: the ticket round number and time left are unchanged, the feed connection survives the rollover
//  2. hold after round 1 -> send two txs -> resume: the same block, pga_round 2, the higher tip first, the block timestamp unchanged
//  3. sim_skipTo: the next ticket round starts at once, block timestamps stay monotonic
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { parseGwei, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvilDevKey, ANVIL_ACCOUNT_MAP, localPreset, resolvePreset, type Preset } from '../../shared/config.ts'
import { resetChainClock } from '../../shared/clock.ts'
import { connectFeed, type FeedClient } from '../../fast-feed/client/client.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'
import { buyTickets, newIdentity, readTicketRound } from '../race.ts'

const ROUND_S = 12
const env: NodeJS.ProcessEnv = {
  ...process.env,
  SIM_ORDER: 'pga',
  FEED_AUTH: 'on',
  TICKET_ROUND_SECONDS: String(ROUND_S),
  BLOCK_PUBLISH_DELAY_MS: '100',
  SIM_RPC_PORT: '52547',
  SIM_FEED_PORT: '52642',
  SIM_ANVIL_PORT: '52545',
  ENV_FILE: '/nonexistent-env-file',
}
delete env.PRIVATE_KEY
delete env.SIM_BLOCK_MS
delete env.SIM_SLOWMO
const preset0 = localPreset('slow', env)
let stack: Stack | undefined
let preset: Preset
let client: FeedClient | undefined
let closed: number | undefined
const mine = newIdentity('mine', ANVIL_ACCOUNT_MAP.raceMine)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const url = () => `http://127.0.0.1:${env.SIM_RPC_PORT}`
const hex = (n: number) => '0x' + n.toString(16)

async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = (await r.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
}
async function until(cond: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms
  while (!(await cond())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`)
    await sleep(50)
  }
}
async function send(i: number, tip: string): Promise<Hex> {
  const a = privateKeyToAccount(anvilDevKey(i))
  const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [a.address, 'latest'])))
  const raw = await a.signTransaction({ type: 'eip1559', chainId: 31337, nonce, to: '0x000000000000000000000000000000000000dEaD', value: 0n, gas: 21_000n, maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei(tip) })
  return rpc<Hex>('eth_sendRawTransaction', [raw])
}
async function mined(hash: Hex): Promise<void> {
  await until(async () => (await rpc('eth_getTransactionReceipt', [hash])) !== null, 30_000, `receipt of ${hash.slice(0, 10)}`)
}

before(async () => {
  buildContracts()
  resetChainClock()
  stack = await startOrAttach(preset0.local!, preset0.chainId, { banner: false })
  preset = await resolvePreset(preset0)
}, { timeout: 120_000 })

after(async () => {
  try {
    await rpc('sim_resume', [{ holder: 'e2-test' }])
  } catch {
    /* the stack is going away */
  }
  client?.close()
  await stack?.stop()
  resetChainClock()
})

test('pause for 1.5 ticket rounds: the ticket round and time left are unchanged and the feed connection survives', { timeout: 120_000 }, async () => {
  const session = await buyTickets(preset, [mine]) // returns once the ticket is active
  client = connectFeed({ url: preset.feedUrl, apiKey: mine.key, onMessage: () => {}, onClose: (code) => (closed = code) })
  await client.ready
  const before = await readTicketRound(preset, mine)
  const left0 = before.roundEndMs - (await rpc('sim_clock')).chainNowMs
  assert.ok(left0 > 0 && session.activeUntil >= before.roundEndMs, 'inside the active ticket round')

  const paused = await rpc('sim_pause', [{ holder: 'e2-test', at: 'now', leaseMs: 60_000 }])
  assert.equal(paused.paused, true)
  const frozen = (await rpc('sim_clock')).chainNowMs
  const info0 = await rpc('sim_blockInfo')
  assert.equal(info0.paused, true)
  await sleep(1.5 * ROUND_S * 1000 + 500) // longer than one ticket round: without the freeze the key would be renewed or expired
  const during = await readTicketRound(preset, mine)
  assert.equal(during.round, before.round, 'the ticket round number did not move')
  assert.equal(during.roundEndMs, before.roundEndMs)
  const clk = await rpc('sim_clock')
  assert.equal(clk.chainNowMs, frozen, 'the chain clock stood still')
  assert.equal((await rpc('sim_blockInfo')).roundLeftMs, info0.roundLeftMs, 'no round moved')
  assert.equal(closed, undefined, 'the feed connection is still open: no 1008 at a rollover that never came')

  const r = await rpc('sim_resume', [{ holder: 'e2-test' }])
  assert.equal(r.resumed, true)
  assert.ok(r.pausedMs >= 1.5 * ROUND_S * 1000, `paused ${r.pausedMs}ms`)
  const after = await readTicketRound(preset, mine)
  assert.equal(after.round, before.round, 'the same ticket round after the resume')
  const left1 = after.roundEndMs - r.chainNowMs
  assert.ok(Math.abs(left1 - left0) < 2500, `the same time left: ${left0}ms before, ${left1}ms after`)
  await sleep(1500)
  assert.equal(closed, undefined, 'still connected after the resume')
  assert.equal((await rpc('sim_resume', [{ holder: 'e2-test' }])).resumed, false, 'resume is idempotent')
})

test('hold after round 1: a tx sent while held lands first in round 2 of the SAME block, whose timestamp did not change', { timeout: 120_000 }, async () => {
  assert.equal((await rpc('sim_pause', [{ holder: 'e2-test', at: 'afterRound1', leaseMs: 60_000 }])).armed, true)
  // Send A early in a round 1 so the round-1 tick publishes it and opens the block; the hold then takes effect.
  await until(async () => {
    const i = await rpc('sim_blockInfo')
    return i.round === 1 && i.roundLeftMs > 400
  }, 20_000, 'round 1 of a block with time left')
  const a = await send(0, '0.01')
  await until(async () => (await rpc('sim_clock')).paused, 20_000, 'the hold after round 1')
  const held = await rpc('sim_clock')
  assert.equal(held.heldAt.round, 2)
  const block = held.heldAt.block as number
  const heldChainSec = Math.floor(held.chainNowMs / 1000)
  const roundLeft = (await rpc('sim_blockInfo')).roundLeftMs
  // Queue two more while it stands still: the competitor first, then ours with the higher tip.
  const c = await send(2, '0.05')
  const b = await send(1, '1')
  await sleep(6000) // nothing may happen: more than three rounds
  const info = await rpc('sim_blockInfo')
  assert.equal(info.paused, true)
  assert.equal(info.roundLeftMs, roundLeft, 'round 2 did not move while held')
  assert.equal(await rpc('eth_getTransactionReceipt', [a]), null, 'the open block is not visible')
  const r = await rpc('sim_resume', [{ holder: 'e2-test' }])
  assert.ok(r.pausedMs >= 6000)
  await Promise.all([a, b, c].map(mined))
  const [ta, tb, tc] = await Promise.all([a, b, c].map((h) => rpc('sim_boostTrace', [h])))
  const incl = (t: any[]) => t.find((e) => e.included)
  assert.equal(incl(ta).block, block)
  assert.equal(incl(ta).pgaRound, 1)
  assert.equal(incl(tb).block, block, 'the same block')
  assert.equal(incl(tb).pgaRound, 2)
  assert.equal(incl(tc).block, block)
  const arrivals2 = await rpc('sim_arrivals', [block, 2])
  assert.deepEqual(arrivals2.map((x: any) => x.hash), [b, c], 'PGA: the higher tip is first in round 2')
  assert.deepEqual(arrivals2.map((x: any) => x.txIndex), [1, 2])
  const head = await rpc('eth_getBlockByNumber', [hex(block), false])
  assert.ok(Math.abs(Number(BigInt(head.timestamp)) - heldChainSec) <= 2, `the block timestamp ${Number(BigInt(head.timestamp))} is the chain time at the hold (${heldChainSec}), not the wall time after the pause`)
  assert.equal((await rpc('sim_info')).receiptMismatches, 0)
})

test('sim_skipTo: the next ticket round starts at once; block timestamps stay monotonic', { timeout: 120_000 }, async () => {
  const before = await readTicketRound(preset, mine)
  const toSec = Math.ceil(before.roundEndMs / 1000) + 1
  const r = await rpc('sim_skipTo', [{ toSec, holder: 'e2-test' }])
  assert.ok(['applied', 'pending'].includes(r.status))
  await until(async () => (await rpc('sim_clock')).pendingSkip === null, 20_000, 'the skip to be applied')
  const clk = await rpc('sim_clock')
  assert.ok(clk.chainNowMs >= toSec * 1000, 'the chain clock reached the target')
  assert.ok(clk.skippedMs > 0)
  const after = await readTicketRound(preset, mine)
  assert.equal(after.round, before.round + 1, 'the next ticket round')
  // A target already reached is a no-op; a target beyond one round + 60s is refused.
  assert.equal((await rpc('sim_skipTo', [{ toSec, holder: 'e2-test' }])).status, 'applied')
  assert.equal((await rpc('sim_clock')).skippedMs, clk.skippedMs)
  await assert.rejects(rpc('sim_skipTo', [{ toSec: toSec + ROUND_S + 120, holder: 'e2-test' }]), /at most one ticket round/)
  // A block mined after the skip carries the skipped time, and every block is at or after its parent.
  const h = await send(3, '0.01')
  await mined(h)
  const head = Number(BigInt(await rpc('eth_blockNumber')))
  let prev = 0
  for (let n = 0; n <= head; n++) {
    const ts = Number(BigInt((await rpc('eth_getBlockByNumber', [hex(n), false])).timestamp))
    assert.ok(ts >= prev, `block ${n} timestamp ${ts} is before its parent's ${prev}`)
    prev = ts
  }
  assert.ok(prev >= toSec, `the newest block (${prev}) carries the skipped chain time (>= ${toSec})`)
  // The feed key (bought for the old round) is now expired: the rollover closes it with 1008 (proof the feed follows the chain clock).
  await until(() => closed !== undefined, 10_000, 'the 1008 after the skip past the ticket round')
  assert.equal(closed, 1008)
})
