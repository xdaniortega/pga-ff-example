// `npm run pga:slot -- --local [--late-after-ms N]`: a late transaction with a bigger tip slots in before the round closes.
// It lives in combo/ (not pga/) because it reads the Fast Feed as well as sending transactions; pga/ must not import
// fast-feed/. Concepts and sample output: pga/README.md#demo-4-a-late-bigger-tip-slots-in.
//
// Exit codes: 0 the four txs share a round in tip order (late tx second); 1 wrong order (e.g. a --fifo stack) or an
// error; 3 the four txs did not share a round, also after one retry; 2 usage, a round shorter than 2s, or --testnet.
import { pathToFileURL } from 'node:url'
import { createPublicClient, formatGwei, http, parseGwei, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ANVIL_ACCOUNT_MAP, anvilDevKey, blockMsOverride, ConfigError, feedApiKey, getPreset, loadDotEnv, resolvePreset } from '../shared/config.ts'
import { connectFeed, FeedRejectedError, rejectionLines, type FeedMessageJson } from '../fast-feed/client/client.ts'
import { generateKey } from '../fast-feed/client/key.ts'
import { error, note, plain, result as printResult, setInternalVisible, step } from '../shared/narrate.ts'
import { DEAD, exitCode, MAX_FEE, runWithRetry, sleep, syncToBlockStart, type Verdict } from '../pga/bot/common.ts'
import { presign } from '../pga/bot/tx.ts'
import { buyTickets, newIdentity, renewTickets, type TicketSession } from './race.ts'

/** The slot demo needs rounds long enough for a person (and a second wallet send) to act inside one. */
export const MIN_ROUND_MS = 2000
/** The three early txs, sent lowest tip first, then the late one. Tips in gwei. */
export const EARLY_TIPS_GWEI = ['0.001', '0.01', '0.1'] as const
export const LATE_TIP_GWEI = '0.05'

export const USAGE = 'Usage: npm run pga:slot -- --local [--late-after-ms N] [--block-ms MS] [--preset slow|fast]   (needs rounds >= 2s: npm run sim -- --block-ms 20000)'
export const TESTNET_REFUSAL = 'Error: pga:slot is local-only: it needs the block-start sync (sim_msUntilNextBlock) and rounds of several seconds, which Arbitrum Sepolia does not have. Use --local.'
export const HONESTY =
  'The Fast Feed publishes a tx only after its round is ordered and executed, so a tx already on the feed is final and can never be overtaken; "in the middle" is possible only while the round is still taking in transactions. On Arbitrum One the same happens within a 125 ms round; the slow block time only makes it visible to a person.'

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in combo/test/slot.test.ts)
// ---------------------------------------------------------------------------

export interface SlotArgs {
  mode: 'local' | 'testnet'
  /** undefined = half the round. */
  lateAfterMs?: number
}

/** `--local` | `--testnet` (exactly one), `--late-after-ms N`, plus `--block-ms` / `--preset` (validated by the config parsers). */
export function parseSlotArgs(argv: readonly string[]): SlotArgs {
  let local = false
  let testnet = false
  let lateAfterMs: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--local') local = true
    else if (a === '--testnet') testnet = true
    else if (a === '--preset' || a === '--block-ms') i++ // values are validated by getPreset / blockMsOverride
    else if (a.startsWith('--preset=') || a.startsWith('--block-ms=')) continue
    else if (a === '--late-after-ms' || a.startsWith('--late-after-ms=')) {
      const v = a === '--late-after-ms' ? argv[++i] : a.slice('--late-after-ms='.length)
      if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1) throw new ConfigError('--late-after-ms needs a positive whole number of milliseconds.')
      lateAfterMs = Number(v)
    } else throw new ConfigError(`Unknown argument "${a}".`)
  }
  if (local && testnet) throw new ConfigError('Pass only one of --local or --testnet, not both.')
  if (!local && !testnet) throw new ConfigError('Missing network flag: pass --local (--testnet is refused: pga:slot needs the tick sync and long rounds).')
  return { mode: local ? 'local' : 'testnet', lateAfterMs }
}

/** Pure: usage problems that depend on the running stack's round length. Returns an explanation, or undefined when fine. */
export function roundProblem(roundMs: number, lateAfterMs: number | undefined): string | undefined {
  if (roundMs < MIN_ROUND_MS)
    return `the round is ${roundMs}ms (B/K), shorter than ${MIN_ROUND_MS}ms: too short to see a tx slot in. Restart the simulator with \`npm run sim -- --block-ms 20000\` (10s rounds).`
  if (lateAfterMs !== undefined && lateAfterMs >= roundMs) return `--late-after-ms ${lateAfterMs} must be shorter than the round (${roundMs}ms), or the late tx would miss it.`
  return undefined
}

/** One tx we sent. */
export interface SlotSent {
  label: string
  tipWei: bigint
  late: boolean
  hash: Hex
  /** Date.now() just before the tx was handed to the sequencer. */
  sentAt: number
}

/** The parts of a feed message the judge needs. */
export interface SlotFeedRow {
  hash: Hex
  block: number
  index: number
  round: number | undefined
  timestampMs: number
}

export function feedRowOf(m: FeedMessageJson): SlotFeedRow {
  return { hash: m.transaction.tx_hash, block: m.transaction.block_number, index: m.transaction.tx_index, round: m.pga_round, timestampMs: m.timestamp_ms }
}

export interface SlotRow extends SlotSent {
  feed: SlotFeedRow
}

export interface SlotJudgement {
  verdict: Verdict
  reason: string
  /** Our four txs with their feed rows, in send order; undefined when not all four were seen. */
  rows?: SlotRow[]
  /** Other txs (e.g. traffic) that shared our round. */
  others: number
}

const gweiOf = (wei: bigint) => formatGwei(wei)

/**
 * Pure judge. PASS: the four txs share one round (same block, same pga_round) and sit in tip order, i.e. 0.1, late 0.05,
 * 0.01, 0.001, so the late tx is second among ours. FAIL: a --fifo stack, or the same round in another order.
 * INCONCLUSIVE: a tx never appeared on the feed, or the four did not share a round.
 * Other txs in the round (traffic) are allowed: only the relative order of ours is judged, and the position of the late tx
 * is claimed only when nothing else shares the round. The position is the index WITHIN the round (tx_index minus the
 * txs of earlier rounds of the same block); it equals tx_index only in round 1 with nothing before it.
 */
export function judgeSlot(input: { ordering: 'pga' | 'fifo'; sent: readonly SlotSent[]; feed: readonly SlotFeedRow[] }): SlotJudgement {
  const byHash = new Map(input.feed.map((r) => [r.hash.toLowerCase(), r]))
  const rows: SlotRow[] = []
  for (const s of input.sent) {
    const f = byHash.get(s.hash.toLowerCase())
    if (f) rows.push({ ...s, feed: f })
  }
  if (rows.length < input.sent.length) return { verdict: 'INCONCLUSIVE', reason: `only ${rows.length} of ${input.sent.length} txs appeared on the feed`, others: 0 }
  const key = (r: SlotRow) => `${r.feed.block}/${r.feed.round ?? ''}`
  if (new Set(rows.map(key)).size > 1) {
    const where = rows.map((r) => `${r.label}: block ${r.feed.block} round ${r.feed.round ?? '-'}`).join(', ')
    return { verdict: 'INCONCLUSIVE', reason: `the ${rows.length} txs did not share one round (${where})`, rows, others: 0 }
  }
  const ours = new Set(rows.map((r) => r.hash.toLowerCase()))
  const others = input.feed.filter((r) => r.block === rows[0]!.feed.block && r.round === rows[0]!.feed.round && !ours.has(r.hash.toLowerCase())).length
  const observed = [...rows].sort((a, b) => a.feed.index - b.feed.index)
  const expected = [...rows].sort((a, b) => (a.tipWei === b.tipWei ? 0 : a.tipWei > b.tipWei ? -1 : 1))
  const inTipOrder = observed.every((r, i) => r === expected[i])
  const late = rows.find((r) => r.late)!
  const lateSecond = observed[1] === late
  const order = observed.map((r) => gweiOf(r.tipWei)).join(', ')
  const share = others > 0 ? ` (${others} other tx(s) share the round, so only the relative order is judged, not the index within the round)` : ''
  if (input.ordering === 'fifo') {
    return { verdict: 'FAIL', reason: `the stack is --fifo (PGA disabled): arrival order decides, so the order was ${order} and the late tx came ${ordinal(observed.indexOf(late) + 1)} among ours${share}`, rows, others }
  }
  if (!inTipOrder || !lateSecond) return { verdict: 'FAIL', reason: `same round, but not in tip order: ${order} (expected ${expected.map((r) => gweiOf(r.tipWei)).join(', ')})${share}`, rows, others }
  const inRound = input.feed.filter((r) => r.block === late.feed.block && r.round === late.feed.round && r.index < late.feed.index).length
  const idx = others === 0 ? `, the late tx at index ${inRound} of its round (tx_index ${late.feed.index})` : share
  return { verdict: 'PASS', reason: `one round, tip order ${order}${idx}`, rows, others }
}

function ordinal(n: number): string {
  return n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : n === 4 ? 'fourth' : `#${n}`
}

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`

/** Pure: the timeline table (<= 80 columns), rows in send order. Offsets are relative to the first send. */
export function formatTimeline(rows: readonly SlotRow[]): string[] {
  const t0 = Math.min(...rows.map((r) => r.sentAt))
  const sent = [...rows].sort((a, b) => a.sentAt - b.sentAt)
  const w = { label: 8, tip: 12, send: 8, ts: 10, wait: 8, idx: 8 }
  const line = (c: string[]) => `${c[0]!.padEnd(w.label)} ${c[1]!.padStart(w.tip)} ${c[2]!.padStart(w.send)} ${c[3]!.padStart(w.ts)} ${c[4]!.padStart(w.wait)} ${c[5]!.padStart(w.idx)}`
  return [
    line(['tx', 'tip (gwei)', 'sent', 'feed ts', 'waited', 'tx_index']),
    line(['-'.repeat(w.label), '-'.repeat(w.tip), '-'.repeat(w.send), '-'.repeat(w.ts), '-'.repeat(w.wait), '-'.repeat(w.idx)]),
    ...sent.map((r) => line([r.label, gweiOf(r.tipWei), `+${secs(r.sentAt - t0)}`, `+${secs(r.feed.timestampMs - t0)}`, secs(r.feed.timestampMs - r.sentAt), String(r.feed.index)])),
    '(times relative to the first send; feed ts = timestamp_ms =',
    ' when the round was ordered; waited = feed ts - sent)',
  ]
}

/**
 * Pure: the closing line. It names the earliest arrival that came last and the late tx that came second, and says the
 * tip decided, only when the feed showed exactly that; otherwise it says what was observed instead.
 */
export function closingLine(rows: readonly SlotRow[]): string {
  const byArrival = [...rows].sort((a, b) => a.sentAt - b.sentAt)
  const byIndex = [...rows].sort((a, b) => a.feed.index - b.feed.index)
  const first = byArrival[0]!
  const late = rows.find((r) => r.late)!
  if (byIndex.at(-1) === first && byIndex[1] === late && first !== late) {
    return `The earliest arrival (${gweiOf(first.tipWei)} gwei) waited ${secs(first.feed.timestampMs - first.sentAt)} and still came last; the late ${gweiOf(late.tipWei)} gwei tx waited ${secs(late.feed.timestampMs - late.sentAt)} and came second. Arrival time bought no position: the tip decided.`
  }
  return `Observed order by tx_index: ${byIndex.map((r) => `${gweiOf(r.tipWei)} gwei`).join(', ')}. That is not the "tip decided" picture, so no such claim is made.`
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** The running stack's round length (sim_info), or undefined when no stack answers. */
async function runningRoundMs(rpcUrl: string): Promise<number | undefined> {
  try {
    const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sim_info', params: [] }) })
    const body = (await res.json()) as { result?: { roundMs?: number } }
    return typeof body.result?.roundMs === 'number' ? body.result.roundMs : undefined
  } catch {
    return undefined
  }
}

async function main(): Promise<number> {
  loadDotEnv()
  const argv = process.argv.slice(2)
  let args: SlotArgs
  let preset
  try {
    args = parseSlotArgs(argv)
    if (args.mode === 'testnet') {
      error(TESTNET_REFUSAL)
      return 2
    }
    const blockMs = blockMsOverride(argv, process.env)
    preset = getPreset(argv, blockMs !== undefined ? { ...process.env, SIM_BLOCK_MS: String(blockMs) } : process.env)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    error(`Error: ${e.message}\n${USAGE}`)
    return 2
  }
  const lp = preset.local!
  const roundMs = (await runningRoundMs(preset.rpcUrl)) ?? lp.roundMs
  const problem = roundProblem(roundMs, args.lateAfterMs)
  if (problem) {
    error(`Error: ${problem}`)
    return 2
  }

  const { startOrAttach } = await import('../sim/index.ts') // sim code is local-only
  const stack = await startOrAttach(lp, preset.chainId, { build: true, signalHandlers: true })
  try {
    if (!stack.attached) setInternalVisible(true) // a stack we started prints its own [sequencer] lines
    preset = await resolvePreset(preset)
    const ordering = stack.params.ordering
    const lateAfterMs = args.lateAfterMs ?? Math.floor(stack.params.roundMs / 2)
    const problem2 = roundProblem(stack.params.roundMs, lateAfterMs)
    if (problem2) {
      error(`Error: ${problem2}`)
      return 2
    }
    return await run(preset, stack.params.roundMs, lateAfterMs, ordering, stack.params.feedAuth)
  } finally {
    await stack.stop()
  }
}

async function run(preset: Awaited<ReturnType<typeof resolvePreset>>, roundMs: number, lateAfterMs: number, ordering: 'pga' | 'fifo', feedAuth: boolean): Promise<number> {
  const senders = ANVIL_ACCOUNT_MAP.slotSenders.map((i) => privateKeyToAccount(anvilDevKey(i)))
  const label = new Map<string, string>() // hash -> label, for the live feed lines
  const feedRows: SlotFeedRow[] = []

  step(`demo 4: three txs early in a ${roundMs / 1000}s round (tips ${EARLY_TIPS_GWEI.join(', ')} gwei, lowest first), then a ${LATE_TIP_GWEI} gwei tx ${lateAfterMs / 1000}s later, in the same round`)
  note(`wallets: Anvil accounts ${ANVIL_ACCOUNT_MAP.slotSenders.join(', ')} (one tx each, so the nonce rule never interferes). Ordering: ${ordering === 'fifo' ? 'FIFO (PGA disabled)' : 'PGA'}.`)
  note(HONESTY)

  // A Fast Feed ticket (skipped when the stack's feed is open).
  const key = feedApiKey() ?? generateKey()
  if (feedAuth) {
    const mine = newIdentity('mine', ANVIL_ACCOUNT_MAP.slotSenders[0], key) // the key stays in memory; only its hash is printed
    step('a Fast Feed ticket for the live feed')
    note('Bought in round N, active in N+1.')
    let session: TicketSession = await buyTickets(preset, [mine])
    const renewed = await renewTickets(preset, [mine], session)
    if (renewed) session = renewed
  } else note('the feed is open (FEED_AUTH=off): no ticket needed')

  const waiters: (() => void)[] = []
  const client = connectFeed({
    url: preset.feedUrl,
    apiKey: feedAuth ? key : undefined,
    onMessage: (m) => {
      const r = feedRowOf(m)
      feedRows.push(r)
      const mark = label.get(r.hash.toLowerCase())
      plain(`    feed: block ${r.block} round ${r.round ?? '-'} tx_index ${r.index}  ${short(r.hash)}${mark ? `  ${mark}` : '  (other tx)'}`)
      for (const w of waiters.splice(0)) w()
    },
    onError: (e) => error(`feed error: ${e.message}`),
  })
  try {
    await client.ready
  } catch (e) {
    if (e instanceof FeedRejectedError) for (const l of rejectionLines(e.status, e.body, '--local')) error(l)
    error(`Error: the Fast Feed refused or dropped the connection: ${(e as Error).message}`)
    return 1
  }

  const read = createPublicClient({ transport: http(preset.rpcUrl) })
  const send = createPublicClient({ transport: http(preset.sendUrl) })
  const chain = { id: preset.chainId }
  const tips = [...EARLY_TIPS_GWEI, LATE_TIP_GWEI]

  async function attempt(): Promise<SlotJudgement> {
    // Fresh nonces every attempt; sign everything BEFORE the tick sync so the sends are back to back.
    const raws: Hex[] = []
    for (let i = 0; i < 4; i++) {
      const nonce = await read.getTransactionCount({ address: senders[i]!.address, blockTag: 'pending' })
      raws.push(await presign({ to: DEAD, tip: parseGwei(tips[i]!), maxFee: MAX_FEE, nonce, gas: 21_000n, account: senders[i]!, chain }))
    }
    step('waiting for the start of a block, so the four txs share its round 1 (K = 2 rounds share a block)')
    await syncToBlockStart(preset.sendUrl)
    const sent: SlotSent[] = []
    const fire = async (i: number) => {
      const sentAt = Date.now()
      const hash = await send.sendRawTransaction({ serializedTransaction: raws[i]! })
      const s: SlotSent = { label: i === 3 ? 'late' : `early ${i + 1}`, tipWei: parseGwei(tips[i]!), late: i === 3, hash, sentAt }
      label.set(hash.toLowerCase(), `${s.label} (${tips[i]} gwei)`)
      sent.push(s)
      step(`sent ${s.label}: tip ${tips[i]} gwei, ${short(hash)}`)
    }
    for (let i = 0; i < 3; i++) await fire(i)
    step(`waiting ${lateAfterMs}ms, still inside the same ${roundMs}ms round (round 1 of the block)...`)
    await sleep(lateAfterMs)
    await fire(3)
    step('waiting for the Fast Feed to deliver the round')
    const have = () => sent.every((s) => feedRows.some((r) => r.hash.toLowerCase() === s.hash.toLowerCase()))
    const deadline = Date.now() + roundMs * 2 + 15_000
    while (!have() && Date.now() < deadline) await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 500) })
    await sleep(300) // the rest of the round's messages (other txs) arrive together
    return judgeSlot({ ordering, sent, feed: feedRows })
  }

  let result: SlotJudgement
  try {
    result = await runWithRetry(attempt, true, (first) => step(`inconclusive (${first.reason}): retrying once with fresh nonces`))
  } catch (e) {
    error(`Error: ${(e as Error).message}`)
    await client.close().catch(() => {})
    return 1
  }
  await client.close().catch(() => {})

  plain()
  if (result.rows) {
    for (const l of formatTimeline(result.rows)) plain(l)
    if (result.verdict === 'PASS') {
      plain()
      note(closingLine(result.rows))
    }
  }
  printResult(result.verdict, `${result.verdict}: ${result.reason}`)
  return exitCode([result.verdict])
}

const short = (h: string) => `${h.slice(0, 10)}…`

// Run only as the entry point (tests import the pure helpers).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      error(`Error: ${(e as Error).message}`)
      process.exit(1)
    },
  )
}
