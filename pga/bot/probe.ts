// `npm run pga:probe -- --local|--testnet [--trials N] [--preset slow|fast]`
//
// Does this chain order a round by tip (PGA) or by arrival (FCFS)? Each trial pre-signs three txs from three wallets with
// tips 0.001 / 0.01 / 0.1 gwei and sends them lowest tip first (right after the start of a block on the local simulator),
// so first-come-first-served and PGA predict opposite orders. Only trials whose three txs landed in ONE round count: locally
// the same block AND the same pga_round (read from sim_boostTrace); on a testnet the same block, the best that is observable. Tips
// are taken from the receipts (effectiveGasPrice - block baseFee), never from the bids.
//
//   PGA-consistent   at least one counted trial and every counted trial is tip-ordered (0.1, 0.01, 0.001)
//   FCFS-consistent  at least one counted trial and every counted trial is arrival-ordered (0.001, 0.01, 0.1)
//   inconclusive     anything else (no counted trial, a mix, or an order that is neither)
// Exit codes: 0 a verdict (PGA-consistent or FCFS-consistent), 3 inconclusive, 1 error or refusal, 2 usage.
//
// --testnet (Arbitrum Sepolia) is guarded exactly like the bot: ALLOW_TESTNET=1, PGA_KEY_1..3 (three distinct wallets) and
// assertAllowedChain; txs go to the preset's sequencer endpoint and are read from the public RPC. On a real chain the
// same block is NOT the same round (K rounds share a block), so a split by round can hide inside one block.
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, parseGwei, type Hex } from 'viem'
import { ConfigError, getPreset, loadDotEnv, type Preset } from '../../shared/config.ts'
import { error, note, plain, result, step } from '../../shared/narrate.ts'
import { assertAllowedChain, walletsFor } from './bot.ts'
import { collectLanded, pendingNonceOf, sameRound, signTransfer, syncToBlockStart, type Env, type Landed } from './common.ts'

/** Tips of one trial in SEND order (lowest first). */
export const PROBE_TIPS = ['0.001', '0.01', '0.1'] as const

export type OrderedBy = 'tip' | 'arrival' | 'other' | 'n/a'

export interface TrialResult {
  trial: number
  /** Tip labels in landing order; txs without a receipt are missing. */
  observed: string[]
  blocks: bigint[]
  /** The PGA round of each tx in landing order (local only; empty when unknown). */
  pgaRounds: number[]
  /** All three landed in one round: one block and, locally, one pga_round. */
  counted: boolean
  orderedBy: OrderedBy
  /** effectiveGasPrice > baseFee for every tx (a tip was charged). */
  tipsCharged: boolean
  missing: string[]
  /** Local only: the pga_round of some tx could not be read, so the trial cannot be counted. */
  roundUnknown: boolean
}

/** Pure: classify one trial from where its txs landed (`landed` carries the tip label). */
export function classifyTrial(trial: number, landed: readonly Landed[], missing: readonly string[] = []): TrialResult {
  const sorted = [...landed].sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1))
  const pgaRounds = sorted.map((l) => l.pgaRound).filter((x): x is number => x !== undefined)
  const observed = sorted.map((l) => l.label)
  const blocks = [...new Set(landed.map((l) => l.block))].sort((a, b) => (a < b ? -1 : 1))
  const counted = missing.length === 0 && landed.length === PROBE_TIPS.length && sameRound(landed)
  const joined = observed.join('|')
  const orderedBy: OrderedBy = !counted ? 'n/a' : joined === [...PROBE_TIPS].reverse().join('|') ? 'tip' : joined === PROBE_TIPS.join('|') ? 'arrival' : 'other'
  return { trial, observed, blocks, pgaRounds, counted, orderedBy, tipsCharged: landed.length > 0 && landed.every((l) => l.tip > 0n), missing: [...missing], roundUnknown: landed.some((l) => l.roundUnknown) }
}

export type ProbeVerdict = 'PGA-consistent' | 'FCFS-consistent' | 'inconclusive'

/** Pure: the verdict over all trials. */
export function probeVerdict(trials: readonly TrialResult[]): ProbeVerdict {
  const counted = trials.filter((t) => t.counted)
  if (counted.length === 0) return 'inconclusive'
  if (counted.every((t) => t.orderedBy === 'tip')) return 'PGA-consistent'
  if (counted.every((t) => t.orderedBy === 'arrival')) return 'FCFS-consistent'
  return 'inconclusive'
}

/** Pure: 0 for a verdict, 3 for inconclusive. */
export function probeExitCode(v: ProbeVerdict): number {
  return v === 'inconclusive' ? 3 : 0
}

/** Pure: the per-trial table. `mode` decides what "same round" means in the note under it. */
export function formatProbeTable(trials: readonly TrialResult[], mode: 'local' | 'testnet'): { table: string[]; note: string } {
  const head = ['Trial', 'Block(s)', 'Same round', 'Landing order (tip, gwei)', 'Ordered by', 'Tips charged']
  const body = trials.map((t) => [
    String(t.trial),
    t.blocks.length === 0 ? '-' : t.blocks.join(',') + (t.pgaRounds.length > 0 ? ` (pga_round ${[...new Set(t.pgaRounds)].join(',')})` : ''),
    t.counted ? 'yes (counted)' : 'no (not counted)',
    t.observed.length === 0 ? '-' : t.observed.join(', ') + (t.missing.length > 0 ? ` (no receipt: ${t.missing.join(', ')})` : ''),
    t.orderedBy === 'tip' ? 'tip (PGA-like)' : t.orderedBy === 'arrival' ? 'arrival (FCFS-like)' : t.orderedBy === 'other' ? 'neither' : '-',
    t.observed.length === 0 ? '-' : t.tipsCharged ? 'yes (effectiveGasPrice > baseFee)' : 'no',
  ])
  const widths = head.map((h, c) => Math.max(h.length, ...body.map((r) => r[c]!.length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
  const explanation =
    mode === 'local'
      ? 'Same round = same block and same pga_round locally (K = 2 rounds share a block), so a counted trial really shared a round.'
      : 'On Arbitrum K = 2 rounds share a block, so the same block does NOT mean the same round: a trial can look arrival-ordered because the txs were split across rounds inside one block.'
  return { table: [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)], note: explanation }
}

/** `--trials N` (default 3): a positive integer. */
export function parseTrials(argv: readonly string[]): number {
  const i = argv.indexOf('--trials')
  const v = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--trials='))?.slice('--trials='.length)
  if (i >= 0 && (v === undefined || v.startsWith('--'))) throw new ConfigError('--trials needs a value: a positive integer.')
  if (v === undefined) return 3
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`--trials must be a positive integer, got "${v}".`)
  return n
}

async function runTrial(env: Env, trial: number): Promise<TrialResult> {
  // Pre-sign (nonces and gas read now), so nothing but sending happens in the round.
  const raws: { label: string; raw: Hex }[] = []
  for (let w = 0; w < PROBE_TIPS.length; w++) {
    const account = env.wallets[w]!
    raws.push({ label: PROBE_TIPS[w]!, raw: await signTransfer(env, account, parseGwei(PROBE_TIPS[w]!), await pendingNonceOf(env, account.address)) })
  }
  if (env.preset.mode === 'local') await syncToBlockStart(env.sendUrl) // send right after a block starts: round 1
  const sent: { label: string; hash: Hex }[] = []
  for (const t of raws) sent.push({ label: t.label, hash: await env.send.sendRawTransaction({ serializedTransaction: t.raw }) }) // lowest tip first
  const { landed, missing } = await collectLanded(env, sent)
  return classifyTrial(trial, landed, missing)
}

async function main(): Promise<number> {
  loadDotEnv()
  const argv = process.argv.slice(2)
  let preset: Preset
  let trials: number
  try {
    preset = getPreset(argv)
    trials = parseTrials(argv)
  } catch (e) {
    error(`Error: ${(e as Error).message}`)
    error('Usage: npm run pga:probe -- --local|--testnet [--trials N] [--preset slow|fast]')
    return 2
  }
  assertAllowedChain(preset.chainId, preset, process.env) // before any network access (ALLOW_TESTNET=1 on Sepolia)
  const wallets = walletsFor(preset.chainId) // Anvil 0-2 locally; PGA_KEY_1..3 (three distinct wallets) on the testnet, checked before any network access
  let stop = async () => {}
  try {
    if (preset.mode === 'local') {
      const { startOrAttach } = await import('../../sim/index.ts') // sim code is local-only
      const stack = await startOrAttach(preset.local!, preset.chainId, { build: true })
      stop = stack.stop
    }
    const read = createPublicClient({ transport: http(preset.rpcUrl) })
    const chainId = await read.getChainId()
    assertAllowedChain(chainId, preset, process.env) // the chain the endpoint really reports
    const env: Env = { preset, chainId, read, send: createPublicClient({ transport: http(preset.sendUrl) }), sendUrl: preset.sendUrl, wallets }
    step(`PGA probe on ${preset.name} (chainId ${chainId}): ${trials} trial(s)`)
    note(`each trial sends three txs, tips ${PROBE_TIPS.join(' / ')} gwei, lowest first: FCFS predicts that order, PGA the opposite`)
    note(`reads from ${preset.rpcUrl}, sends to ${preset.sendUrl}${preset.mode === 'local' ? '; right after the start of a block (round 1)' : ''}`)
    const results: TrialResult[] = []
    for (let t = 1; t <= trials; t++) {
      const r = await runTrial(env, t)
      results.push(r)
      step(`trial ${t}: ${r.counted ? `one round (block ${r.blocks[0]}${r.pgaRounds.length > 0 ? `, pga_round ${r.pgaRounds[0]}` : ''}), ordered by ${r.orderedBy}: ${r.observed.join(', ')}` : `not counted (${r.blocks.length > 1 ? `different blocks ${r.blocks.join(', ')}` : r.roundUnknown ? 'the round (pga_round) could not be read from the simulator' : r.missing.length === 0 && r.observed.length === PROBE_TIPS.length ? `different rounds of block ${r.blocks[0]}` : r.missing.length > 0 ? `no receipt for ${r.missing.join(', ')}` : 'incomplete'})`}`)
    }
    plain()
    const formatted = formatProbeTable(results, preset.mode)
    for (const l of formatted.table) plain(l)
    plain()
    note(formatted.note)
    const verdict = probeVerdict(results)
    const counted = results.filter((r) => r.counted).length
    plain()
    result(verdict === 'inconclusive' ? 'INCONCLUSIVE' : 'PASS', `Verdict: ${verdict} (${counted} of ${results.length} trial(s) counted)`)
    if (verdict === 'inconclusive' && counted === 0) note('No trial had all three txs in one round: rerun (more --trials helps).')
    note('(tips charged = effectiveGasPrice - baseFee > 0, from the receipts)')
    return probeExitCode(verdict)
  } finally {
    await stop()
  }
}

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
