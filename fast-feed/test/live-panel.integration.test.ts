// C7: the panel's data end to end. Slow preset (B=2000ms, K=2), alternate ports, FEED_AUTH=off, background traffic.
// Asserts structure and ordering only, never absolute durations: both rounds of a block arrive on the feed before the block is
// visible on a direct read of the sequencer RPC, every row's FF lead is positive, and round 1 leads exceed round 2 leads.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { localPreset } from '../../shared/config.ts'
import { connectFeed, type FeedClient } from '../client/client.ts'
import { decodeLiveRow, ffLeadMs, formatPanel, LiveRounds, type BlockView, type LiveRow } from '../client/live.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'
import { startTraffic, type Traffic } from '../../sim/traffic.ts'

const env: NodeJS.ProcessEnv = { ...process.env, SIM_RPC_PORT: '35547', SIM_FEED_PORT: '35642', SIM_ANVIL_PORT: '35545', FEED_AUTH: 'off' }
delete env.PRIVATE_KEY
delete env.MY_ADDRESSES
const preset = localPreset('slow', env)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let stack: Stack
let traffic: Traffic
let client: FeedClient
let view: LiveRounds
const rowsSeen: LiveRow[] = []
const visible: BlockView[] = []

before(async () => {
  buildContracts()
  stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
  view = new LiveRounds({
    rpcUrl: preset.rpcUrl,
    out: () => {},
    footerEvery: 0,
    roundsPerBlock: 2,
    onRow: (r) => rowsSeen.push(r),
    onBlockVisible: (b) => visible.push({ ...b, rows: [...b.rows] }),
  })
  view.setLineOutput(false)
  let chain: Promise<void> = Promise.resolve()
  client = connectFeed({ url: preset.feedUrl, onMessage: (msg, at) => void (chain = chain.then(async () => view.push(await decodeLiveRow(msg, at)))) })
  await client.ready
  traffic = await startTraffic({ rpcUrl: preset.rpcUrl, chainId: preset.chainId, tps: 4, baseFeeWei: stack.params.baseFeeWei, statsEveryMs: 0 })
}, { timeout: 120_000 })

after(async () => {
  await traffic?.stop()
  await client?.close()
  await stack?.stop()
})

test('panel data: both rounds of a block arrive before it is visible on the sequencer RPC; every row leads; round 1 leads more than round 2', { timeout: 120_000 }, async () => {
  const end = Date.now() + 90_000
  // A visible block that has rows from both rounds (the first block seen may have been joined mid-way).
  let full: BlockView | undefined
  while (!full && Date.now() < end) {
    full = visible.find((b) => new Set(b.rows.map((r) => r.pgaRound)).size === 2)
    if (!full) await sleep(200)
  }
  assert.ok(full, `a visible block with rows from round 1 and round 2 (saw ${visible.map((b) => `${b.blockNumber}:${b.rows.map((r) => r.pgaRound).join('')}`)})`)
  const visibleAt = full.visibleAt!
  assert.ok(visibleAt !== undefined && full.complete)
  const r1 = full.rows.filter((r) => r.pgaRound === 1)
  const r2 = full.rows.filter((r) => r.pgaRound === 2)
  assert.ok(r1.length > 0 && r2.length > 0)
  for (const r of [...r1, ...r2]) assert.ok(r.receivedAt < visibleAt, `block ${full.blockNumber} round ${r.pgaRound} row arrived before the block was visible`)
  const lead = (r: LiveRow) => ffLeadMs(r.receivedAt, visibleAt)
  assert.ok([...r1, ...r2].every((r) => lead(r) > 0), `every row's FF lead is positive (${[...r1, ...r2].map(lead)})`)
  assert.ok(Math.min(...r1.map(lead)) > Math.max(...r2.map(lead)), `round 1 leads (${r1.map(lead)}) exceed round 2 leads (${r2.map(lead)})`)
  // The rows are announced one by one (onRow) and the panel for this block shows both rounds under one block header.
  assert.ok(rowsSeen.filter((r) => r.blockNumber === full.blockNumber).length === full.rows.length)
  const panel = formatPanel(full, undefined, visibleAt + 100, { k: 2 })
  assert.equal(panel.filter((l) => l.startsWith('block ')).length, 1)
  assert.ok(panel[0]!.startsWith(`block ${full.blockNumber} [closed]`))
  assert.ok(panel.some((l) => l.includes('round 1/2')) && panel.some((l) => l.includes('round 2/2')))
  assert.ok(panel.every((l) => l.length <= 80))
})
