// `npm run pga -- --local|--testnet [--scenario 1|2|3|all] [--preset slow|fast]`
// Sends pre-signed txs with viem and checks the order they landed in against the PGA rules
// (https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga):
//   1  three senders, tips 0.001 / 0.01 / 0.1, sent lowest first        -> land 0.1, 0.01, 0.001
//   2  one sender, nonce N (tip 0.001) and N+1 (tip 0.1), N+1 sent first -> land N, then N+1 (the nonce decides)
//   3  three senders, tips 0 / 0.01 / 0.1, sent lowest first             -> land 0.1, 0.01, 0 (zero tip lands last, but lands)
//   flood  (B3, --local only, needs a running `npm run sim -- --max-txs-per-round 3`) a zero-tip tx among a flood of
//          paying txs: its boosted priority grows by p/(2K) per round and it lands within 2K+1 rounds, ahead of a later
//          arrival that tips p. Not part of `--scenario all`, which runs 1-3 only (flood needs the block cap).
// Exit codes: 0 every scenario passed; 1 a scenario failed (or an error); 3 inconclusive (the txs did not share a
// round, i.e. the same block and pga_round locally; on a testnet the block only: rerun); 2 usage. Tips are taken from the receipts (effectiveGasPrice - block baseFee), never from the bids.
// Scenarios 1 and 3 retry once, after a fresh block start, when the first attempt is inconclusive (different rounds).
// Locally the batch is sent right after the START of a block (round 1), so all its txs land in one round.
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, parseGwei, type Hex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { ANVIL_DEV_KEYS, ConfigError, getPreset, loadDotEnv, type Preset } from '../../shared/config.ts'
import { collectLanded, exitCode, gwei, pendingNonceOf, RECEIPT_TIMEOUT_MS, runWithRetry, sameRound, signTransfer, syncToBlockStart, type Env, type Landed, type Verdict } from './common.ts'
import { floodMain } from './flood.ts'
import { error, note, plain, result, step, verdictOfCode } from '../../shared/narrate.ts'

/** Allowlist: the local simulator and Arbitrum Sepolia. Never mainnet. */
export const ALLOWED_CHAINS: readonly number[] = [31337, 421614]
export interface Judgement {
  verdict: Verdict
  expected: string[]
  observed: string[]
  reason: string
}

const EXPECTED: Record<number, string[]> = {
  1: ['0.1', '0.01', '0.001'],
  2: ['N', 'N+1'],
  3: ['0.1', '0.01', '0'],
}

/** Pure: judge one scenario from where its txs landed. `missing` are labels that got no receipt in time. */
export function judge(id: number, landed: readonly Landed[], missing: readonly string[] = [], lastError = ''): Judgement {
  const expected = EXPECTED[id]!
  const observed = [...landed].sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1)).map((l) => l.label)
  const done = (verdict: Verdict, reason: string): Judgement => ({ verdict, expected, observed, reason })
  if (missing.length > 0) {
    return done('FAIL', `no receipt within ${RECEIPT_TIMEOUT_MS / 1000}s for ${missing.map((m) => `[${m}]`).join(' ')}${id === 3 && missing.includes('0') ? ': the zero tip never landed (starved)' : ''}${lastError ? `; last receipt error: ${lastError}` : ''}`)
  }
  if (!sameRound(landed)) {
    const blocks = new Set(landed.map((l) => l.block))
    const zeroLast = id === 3 && [...landed].sort((a, b) => (a.block === b.block ? (a.pgaRound ?? 0) - (b.pgaRound ?? 0) : a.block < b.block ? -1 : 1)).at(-1)!.label === '0'
    if (landed.some((l) => l.roundUnknown) && blocks.size === 1) {
      return done('INCONCLUSIVE', `the round (pga_round) of ${landed.filter((l) => l.roundUnknown).map((l) => `[${l.label}]`).join(' ')} could not be read from the simulator (sim_boostTrace), so whether the txs shared a round is unknown: the order says nothing about tips. Rerun.`)
    }
    const where = blocks.size > 1 ? `different blocks (${[...blocks].join(', ')})` : `block ${[...blocks][0]} but in different rounds of it (pga_round ${[...new Set(landed.map((l) => l.pgaRound))].join(', ')})`
    return done(
      'INCONCLUSIVE',
      `the txs landed in ${where}, so in different rounds: the order says nothing about tips${zeroLast ? ' (the zero tip did land, one round later)' : ''}. Rerun.`,
    )
  }
  const ok = observed.join('|') === expected.join('|')
  if (id === 1) {
    return ok
      ? done('PASS', 'highest tip first although it was sent last: the tip, not the arrival time, decided (PGA order).')
      : done('FAIL', 'not in tip order: arrival order, or PGA ordering is off (was the simulator started with --fifo?).')
  }
  if (id === 2) {
    return ok
      ? done('PASS', 'nonce N landed before nonce N+1 although N+1 bid 100x the tip and was sent first: nonce N+1 isn\'t valid until nonce N has executed; tips only rank across senders.')
      : done('FAIL', 'nonce N+1 did not land after nonce N: the nonce rule was not applied.')
  }
  return ok
    ? done('PASS', 'zero tip landed last, but landed: the queue empties every round on an uncongested stack.')
    : done('FAIL', 'not in tip order (0.1, 0.01, 0 expected): arrival order, or PGA ordering is off (was the simulator started with --fifo?).')
}

interface Plan {
  /** Signed raw txs in SEND order, each with its scenario label. */
  txs: { label: string; raw: Hex; hash?: Hex }[]
}

async function plan(env: Env, id: number): Promise<Plan> {
  const sign = (account: PrivateKeyAccount, tip: string, nonce: number) => signTransfer(env, account, parseGwei(tip), nonce)
  if (id === 2) {
    const w = env.wallets[0]!
    const n = await pendingNonceOf(env, w.address)
    const lo = await sign(w, '0.001', n)
    const hi = await sign(w, '0.1', n + 1)
    return { txs: [{ label: 'N+1', raw: hi }, { label: 'N', raw: lo }] } // N+1 (the 100x tip) is sent FIRST
  }
  const tips = id === 1 ? ['0.001', '0.01', '0.1'] : ['0', '0.01', '0.1'] // sent lowest tip first
  const txs: Plan['txs'] = []
  for (let i = 0; i < 3; i++) {
    const w = env.wallets[i]!
    txs.push({ label: tips[i]!, raw: await sign(w, tips[i]!, await pendingNonceOf(env, w.address)) })
  }
  return { txs }
}

async function runScenarioOnce(env: Env, id: number): Promise<Judgement & { tips: string[] }> {
  const p = await plan(env, id) // signed before the tick sync: signing takes no round time
  if (env.preset.mode === 'local') await syncToBlockStart(env.sendUrl) // sim_msUntilNextBlock exists only on the simulator: round 1 of a block
  for (const t of p.txs) t.hash = await env.send.sendRawTransaction({ serializedTransaction: t.raw }) // one after another
  const { landed, missing, lastError: lastReceiptError } = await collectLanded(env, p.txs.map((t) => ({ label: t.label, hash: t.hash! })))
  const j = judge(id, landed, missing, lastReceiptError)
  const tipOf = new Map(landed.map((l) => [l.label, l.tip]))
  return { ...j, tips: j.observed.map((l) => gwei(tipOf.get(l)!)) }
}

/** Scenarios 1 and 3: one retry after a fresh block start when the first attempt was inconclusive (the txs split across rounds). */
export function runScenario(env: Env, id: number, once: (env: Env, id: number) => Promise<Judgement & { tips: string[] }> = runScenarioOnce, say: (m: string) => void = note) {
  return runWithRetry(
    () => once(env, id), // plan() reads fresh nonces and the sync waits for a fresh tick
    id === 1 || id === 3,
    () => say(`scenario ${id}: inconclusive, the txs landed in different rounds; retrying once after a fresh block start`),
  )
}

const NAMES: Record<number, string> = {
  1: 'three senders, tips 0.001/0.01/0.1',
  2: 'same sender, N tip 0.001, N+1 tip 0.1',
  3: 'three senders, tips 0.1/0.01/0',
}

/** Pure: the one table (scenario, expected, observed, tips from receipts, result). */
export function formatTable(rows: { id: number; j: Judgement & { tips: string[] } }[]): string[] {
  const head = ['Scenario', 'Expected order', 'Observed order', 'Tips (gwei, from receipts)', 'Result']
  const body = rows.map(({ id, j }) => [
    `${id}: ${NAMES[id]}`,
    j.expected.join(', '),
    j.observed.join(', '),
    j.tips.join(', '),
    j.verdict,
  ])
  const widths = head.map((h, c) => Math.max(h.length, ...body.map((r) => r[c]!.length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)]
}

/**
 * Wallets. On chainId 31337 ALWAYS the public Anvil accounts 0-2 (PGA_KEY_* is ignored there: those wallets, meant for a
 * testnet, are not funded on the local chain). On any other chain PGA_KEY_1..3 are required. Keys are never printed.
 */
export function walletsFor(chainId: number, env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount[] {
  if (chainId === 31337) return ANVIL_DEV_KEYS.map((k) => privateKeyToAccount(k))
  const keys: `0x${string}`[] = []
  for (let i = 1; i <= 3; i++) {
    const v = env[`PGA_KEY_${i}`]?.trim()
    if (!v) {
      throw new ConfigError(
        `PGA_KEY_${i} is not set. On chainId ${chainId} the bot needs three funded throwaway wallets: PGA_KEY_1, PGA_KEY_2, PGA_KEY_3 (never a wallet with real funds).`,
      )
    }
    keys.push((v.startsWith('0x') ? v : `0x${v}`) as `0x${string}`)
  }
  let accounts: PrivateKeyAccount[]
  try {
    accounts = keys.map((k) => privateKeyToAccount(k))
  } catch {
    throw new ConfigError('One of PGA_KEY_1..3 is not a valid private key.') // never echo the value
  }
  if (new Set(accounts.map((a) => a.address.toLowerCase())).size !== accounts.length) {
    // The scenarios need three senders: with a repeated wallet, the same-sender nonce rule would decide instead of the tips.
    throw new ConfigError('PGA_KEY_1, PGA_KEY_2 and PGA_KEY_3 must be three distinct wallets (two of them are the same key).')
  }
  return accounts
}

/** Pure guard: only chainIds 31337 and 421614 (never mainnet), the chain must match the preset, and Sepolia needs ALLOW_TESTNET=1. */
export function assertAllowedChain(chainId: number, preset: Pick<Preset, 'chainId'>, env: NodeJS.ProcessEnv = process.env): void {
  if (!ALLOWED_CHAINS.includes(chainId)) {
    throw new ConfigError(`unsupported chainId ${chainId}: the bot runs on --local (31337) and Arbitrum Sepolia (421614) only; never mainnet.`)
  }
  if (chainId !== preset.chainId) {
    throw new ConfigError(`chainId ${chainId} does not match the ${preset.chainId === 31337 ? '--local' : '--testnet'} preset (expected ${preset.chainId}): the endpoint is not the network you asked for.`)
  }
  if (chainId === 421614 && env.ALLOW_TESTNET !== '1') {
    throw new ConfigError('--testnet sends real testnet transactions: set ALLOW_TESTNET=1 to confirm (Arbitrum Sepolia only).')
  }
}

export { exitCode, type Landed, type Verdict }

export type ScenarioId = 1 | 2 | 3 | 'flood'

/** `--scenario 1|2|3|flood|all` (default all = 1, 2, 3: flood needs the block cap, so it is always asked for by name). */
export function parseScenarios(argv: readonly string[]): ScenarioId[] {
  const i = argv.indexOf('--scenario')
  const v = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--scenario='))?.slice('--scenario='.length)
  if (i >= 0 && (v === undefined || v.startsWith('--'))) throw new ConfigError('--scenario needs a value: 1, 2, 3, flood or all.')
  if (v === undefined || v === 'all') return [1, 2, 3]
  if (v === '1' || v === '2' || v === '3') return [Number(v) as 1 | 2 | 3]
  if (v === 'flood') return ['flood']
  throw new ConfigError(`Unknown scenario "${v}". Use 1, 2, 3, flood or all.`)
}

async function main(): Promise<number> {
  loadDotEnv()
  const argv = process.argv.slice(2)
  let preset: Preset
  let scenarios: ScenarioId[]
  try {
    preset = getPreset(argv) // throws ConfigError without --local / --testnet
    scenarios = parseScenarios(argv)
  } catch (e) {
    error(`Error: ${(e as Error).message}`)
    error('Usage: npm run pga -- --local|--testnet [--scenario 1|2|3|flood|all] [--preset slow|fast]')
    return 2
  }
  if (scenarios.includes('flood') && preset.mode === 'testnet') {
    // Before any guard or network access: this is a refusal of the scenario itself.
    error(
      'Error: --scenario flood is --local only. It would spam a shared testnet with dozens of transactions, and its point (the sequencer\'s ' +
        'per-round boost and queue) cannot be observed on Arbitrum Sepolia: there is no sim_boostTrace there, and the real sequencer is a black box. ' +
        'Run it with --local after `npm run sim -- --max-txs-per-round 3`.',
    )
    return 1
  }
  assertAllowedChain(preset.chainId, preset, process.env) // before any network access
  // Keys are checked before any network access too (PGA_KEY_1..3 set and distinct on the testnet), never echoed.
  const wallets = scenarios[0] === 'flood' ? [] : walletsFor(preset.chainId)
  let stop = async () => {}
  const sendUrl = preset.sendUrl
  try {
    let running = preset.local
    let selfStarted = false
    if (preset.mode === 'local') {
      const { startOrAttach } = await import('../../sim/index.ts') // sim code is local-only
      const stack = await startOrAttach(preset.local!, preset.chainId, { build: true })
      stop = stack.stop
      selfStarted = !stack.attached
      running = stack.params // the RUNNING stack's parameters (K, the block cap), which may differ from ours
    }
    const read = createPublicClient({ transport: http(preset.rpcUrl) })
    const chainId = await read.getChainId()
    assertAllowedChain(chainId, preset, process.env) // the chain the endpoint really reports
    if (scenarios[0] === 'flood') {
      return await floodMain({ read, send: createPublicClient({ transport: http(sendUrl) }), sendUrl, preset, chainId, wallets: [] }, running!, selfStarted)
    }
    const env: Env = { preset, chainId, read, send: createPublicClient({ transport: http(sendUrl) }), sendUrl, wallets }
    step(`PGA bot on ${preset.name} (chainId ${chainId}): scenarios ${scenarios.join(', ')}`)
    note(`reads from ${preset.rpcUrl}, sends to ${sendUrl}; txs are signed first and sent right after the start of a block, so they share round 1 (local simulator)`)
    const rows: { id: number; j: Judgement & { tips: string[] } }[] = []
    for (const id of scenarios as (1 | 2 | 3)[]) {
      step(`scenario ${id}: ${NAMES[id]}`)
      rows.push({ id, j: await runScenario(env, id) })
    }
    plain()
    for (const l of formatTable(rows)) plain(l)
    plain()
    for (const { id, j } of rows) result(j.verdict, `Scenario ${id}: ${j.verdict} - ${j.reason}`)
    const code = exitCode(rows.map((r) => r.j.verdict))
    plain()
    result(verdictOfCode(code), code === 0 ? 'All scenarios PASS.' : code === 3 ? 'Inconclusive (exit 3): rerun.' : 'FAIL (exit 1).')
    return code
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
