// `npm run pga -- --local --scenario flood` (B3): the anti-starvation boost.
//
// A zero-tip tx arrives first. Paying txs at a constant tip p then keep the block-capped queue full, so it waits.
// At the end of every round each tx still waiting gains p/(2K) of queue priority (the boost moves its position, never
// its fee), so its priority goes 0 -> p/4 -> p/2 -> 3p/4 -> p (K = 2). After 2K rounds it ties a fresh tx that tips p and
// wins on the earlier arrival: it lands in the (2K+1)-th round, ahead of a later arrival that tips p.
// https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
//
// Schedule (deterministic: the txs are pre-signed and each step is sent right after a round tick; K = 2, cap = 3):
//   step 0 (round R)     zero-tip tx, then 3 paying txs   -> the 3 paying txs are included, zero waits (priority 0)
//   step 1..2K-1         3 fresh paying txs per round     -> same; zero waits, priority grows by p/(2K) each round
//   step 2K  (round R+2K) 3 fresh paying txs, then the LATER arrival (tip p) -> zero (priority p, earliest arrival) is
//                         included first; the later arrival is cut by the full block and lands a round after zero.
// Local only: it needs the simulator's block cap (sim_info.maxTxsPerRound) and its sim_boostTrace method.
import { formatGwei, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { BoostTraceEntry } from '../rules/pga-core.ts'
import { ANVIL_ACCOUNT_MAP, ANVIL_DEV_KEYS, anvilDevKey, FLOOD_TIP_WEI, type LocalParams } from '../../shared/config.ts'
import { error, note, plain, result, step, verdictOfCode } from '../../shared/narrate.ts'
import { collectLanded, exitCode, gwei, pendingNonceOf, runWithRetry, signTransfer, syncToTick, type Env, type Landed, type Verdict } from './common.ts'

/** Where one tx landed (receipt) and what its tip was. */
export interface FloodLanded {
  block: bigint
  index: number
  /** effectiveGasPrice - block baseFee, wei. */
  tip: bigint
}

export interface FloodInput {
  /** K: rounds per block. */
  k: number
  /** The paying txs' constant tip p, wei. */
  p: bigint
  zero?: FloodLanded
  later?: FloodLanded
  /** sim_boostTrace of the zero-tip tx and of the later arrival (null: the endpoint has no such method / hash). */
  zeroTrace: BoostTraceEntry[] | null
  laterTrace: BoostTraceEntry[] | null
  /**
   * Every tx of every schedule step (step 0 = the zero-tip tx and its payers, ... the last step ends with the later
   * arrival): the round it arrived in and the round it was included in, from sim_boostTrace. Empty or incomplete = unknown.
   * Step s must arrive in round R+s. A payer of a step before the last must be included in its arrival round.
   */
  steps: { arrival: number; included?: number; mustInclude: boolean }[][]
}

export interface FloodJudgement {
  verdict: Verdict
  reason: string
  /** One line per check, with its outcome. */
  checks: string[]
}

/** The boost after each round for a constant p: i x floor(p / 2K), i = 0, 1, ... (what the zero-tip priority must be). */
export function expectedBoostedPriorities(p: bigint, k: number, rounds: number): bigint[] {
  const b = p / (2n * BigInt(k))
  return Array.from({ length: rounds }, (_, i) => BigInt(i) * b)
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b))

/** "0", "p/4", "p/2", "3p/4", "p" for multiples of p/(2K); the gwei value otherwise. */
export function priorityLabel(priority: bigint, p: bigint, k: number): string {
  const unit = p / (2n * BigInt(k))
  if (priority === 0n) return '0'
  if (unit === 0n || priority % unit !== 0n) return `${formatGwei(priority)} gwei`
  const n = priority / unit
  const d = 2n * BigInt(k)
  const g = gcd(n, d)
  const [num, den] = [n / g, d / g]
  if (den === 1n) return num === 1n ? 'p' : `${num}p`
  return num === 1n ? `p/${den}` : `${num}p/${den}`
}

/** "round 41: 0  ->  round 42: p/4 -> ..." */
export function formatBoostTrace(trace: readonly BoostTraceEntry[], p: bigint, k: number): string {
  return trace.map((e) => `round ${e.round}: ${priorityLabel(BigInt(e.priority), p, k)}${e.included ? ' (included)' : ''}`).join('  ->  ')
}

/** Pure: judge the flood from where the txs landed and from the sequencer's boost trace. */
export function judgeFlood(i: FloodInput): FloodJudgement {
  const checks: string[] = []
  const done = (verdict: Verdict, reason: string): FloodJudgement => ({ verdict, reason, checks })
  if (!i.zero) return done('FAIL', 'the zero-tip tx never landed (starved).')
  if (!i.later) return done('FAIL', 'the later arrival (tip p) never landed, so the order cannot be judged.')
  if (!i.zeroTrace || !i.laterTrace || i.zeroTrace.length === 0 || i.laterTrace.length === 0) {
    return done('INCONCLUSIVE', 'sim_boostTrace has no trace for the txs (is this the simulator of this repository?).')
  }
  if (i.steps.length === 0 || i.steps.some((st) => st.length === 0)) {
    return done('INCONCLUSIVE', 'could not read the arrival round of every sent tx from sim_boostTrace, so the schedule cannot be checked. Rerun.')
  }
  // The schedule must have held for EVERY tx: step s arrived in round R+s, and each paying tx before the last step was
  // included in the round it arrived in (otherwise the queue was not the steady flood the scenario describes).
  const base = i.steps[0]![0]!.arrival
  const slips: string[] = []
  i.steps.forEach((st, s) =>
    st.forEach((t, j) => {
      if (t.arrival !== base + s) slips.push(`step ${s} tx ${j} arrived in round ${t.arrival} instead of ${base + s}`)
      else if (t.mustInclude && t.included !== t.arrival) slips.push(`step ${s} tx ${j} (a payer) was not included in its arrival round ${t.arrival}`)
    }),
  )
  if (slips.length > 0) return done('INCONCLUSIVE', `the schedule slipped (${slips.slice(0, 3).join('; ')}${slips.length > 3 ? `; ${slips.length - 3} more` : ''}). Rerun.`)
  // 1. The boost is exactly p/(2K) per round. Checked right after the slip check: once the schedule is proven on time,
  // a boost that is too small (so the zero tip never reaches p) is a FAIL, not an inconclusive run.
  const failures: string[] = []
  const unit = i.p / (2n * BigInt(i.k))
  const waited = i.zeroTrace.length
  const want = expectedBoostedPriorities(i.p, i.k, waited)
  const got = i.zeroTrace.map((e) => BigInt(e.priority))
  const exact = got.every((g, n) => g === want[n])
  checks.push(`boost per round = p/(2K) = ${formatGwei(unit)} gwei: ${exact ? 'yes' : 'NO'}`)
  if (!exact) return done('FAIL', `the zero-tip priority per round was ${got.map((x) => formatGwei(x)).join(', ')} gwei, expected ${want.map((x) => formatGwei(x)).join(', ')} gwei (the boost is not p/(2K)).`)

  // Starvation must have happened: otherwise the boost was never exercised and a PASS would be vacuous.
  const rounds = waited
  const reached = BigInt(i.zeroTrace[rounds - 1]!.priority)
  if (rounds < 2 || !i.zeroTrace[rounds - 1]!.included || reached < i.p) {
    return done(
      'INCONCLUSIVE',
      rounds < 2
        ? 'the zero-tip tx was included in its first round, so the boost was never exercised (FIFO ordering or no block cap in effect, or the schedule slipped). Rerun against `npm run sim -- --max-txs-per-round 3`.'
        : `the zero-tip tx was included at priority ${formatGwei(reached)} gwei, below p = ${formatGwei(i.p)} gwei, or never: the scenario did not play out as scheduled. Rerun.`,
    )
  }

  // 2. It lands within 2K+1 rounds of its arrival.
  const last = i.zeroTrace[waited - 1]!
  const limit = 2 * i.k + 1
  const inclusion = last.included ? last.round - i.zeroTrace[0]!.round + 1 : undefined
  checks.push(`zero-tip tx included in round ${inclusion ?? '?'} after its arrival (limit 2K+1 = ${limit}): ${inclusion !== undefined && inclusion <= limit ? 'yes' : 'NO'}`)
  if (inclusion === undefined || inclusion > limit) failures.push(`the zero-tip tx was not included within 2K+1 = ${limit} rounds of its arrival (took ${inclusion ?? 'unknown'})`)

  // 3. It lands ahead of the later arrival that tips p.
  const ahead = i.zero.block < i.later.block || (i.zero.block === i.later.block && i.zero.index < i.later.index)
  checks.push(`zero-tip tx landed ahead of the later arrival that tips p (block ${i.zero.block} idx ${i.zero.index} vs block ${i.later.block} idx ${i.later.index}): ${ahead ? 'yes' : 'NO'}`)
  if (!ahead) failures.push('the later arrival that tips p landed first')

  // 4. Its receipt shows it paid no tip: the boost never changes the fee.
  checks.push(`zero-tip receipt: effectiveGasPrice - baseFee = ${gwei(i.zero.tip)} gwei (expected 0): ${i.zero.tip === 0n ? 'yes' : 'NO'}`)
  if (i.zero.tip !== 0n) failures.push(`the zero-tip tx paid a tip of ${gwei(i.zero.tip)} gwei: the boost must never change the fee`)

  if (failures.length > 0) return done('FAIL', failures.join('; ') + '.')
  return done(
    'PASS',
    `the zero-tip tx climbed 0 -> p by p/(2K) per round, landed in round ${inclusion} (within 2K+1 = ${limit}) ahead of the later arrival tipping p, and paid no tip.`,
  )
}

async function simRpc<T>(url: string, method: string, params: unknown[]): Promise<T | null> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  return body.error ? null : (body.result ?? null)
}

const FLOODERS = ANVIL_ACCOUNT_MAP.flooders.length

/** The no-cap explanation (and the exit-1 refusal). `selfStarted`: this command started the stack itself. */
export function noCapMessage(k: number, selfStarted = false): string[] {
  return [
    'The running simulator has no block cap (sim_info.maxTxsPerRound is 0), so every round drains the whole queue and nothing is ever carried over: there is nothing to boost.',
    selfStarted
      ? 'This stack was started by this command without a cap, and it stops when the command exits. Start one with a cap in another terminal and rerun:'
      : 'Stop it and restart it with a cap:',
    '    npm run sim -- --max-txs-per-round 3        (or MAX_TXS_PER_ROUND=3 npm run sim)',
    `then ${selfStarted ? '' : 'rerun '}\`npm run pga -- --local --scenario flood\`${selfStarted ? ' (it attaches to that simulator)' : ''}. The scenario needs a cap of 1 to ${FLOODERS}; 3 is the one the docs use (K = ${k}).`,
  ]
}

/** One attempt's outcome for the retry wrapper. */
type Attempt = FloodJudgement & { lines: string[] }

/** `--scenario flood` against a running local stack. Returns the exit code. */
export async function floodMain(env: Env, params: LocalParams, selfStarted = false): Promise<number> {
  const cap = params.maxTxsPerRound ?? 0
  const k = params.k
  if (env.preset.mode !== 'local' || env.chainId !== 31337) {
    error('Error: --scenario flood is --local only.')
    return 1
  }
  step(`PGA bot, scenario flood on ${env.preset.name} (chainId ${env.chainId})`)
  if (cap < 1) {
    result('FAIL', `Scenario flood: FAIL - no block cap.`)
    for (const l of noCapMessage(k, selfStarted)) note(l)
    return 1
  }
  if (params.ordering === 'fifo') {
    result('FAIL', 'Scenario flood: FAIL - the running simulator orders by arrival (FIFO, sim_info.ordering = fifo).')
    note('With FIFO ordering no boost is ever added (p = 0), so there is nothing to show. Restart it without --fifo:')
    plain('    npm run sim -- --max-txs-per-round 3')
    return 1
  }
  if (cap > FLOODERS) {
    result('FAIL', `Scenario flood: FAIL - the block cap is ${cap}, more than the ${FLOODERS} flooder wallets (Anvil accounts ${ANVIL_ACCOUNT_MAP.flooders[0]}-${ANVIL_ACCOUNT_MAP.flooders.at(-1)}).`)
    note(`Restart the simulator with a cap of 1 to ${FLOODERS}: npm run sim -- --max-txs-per-round 3`)
    return 1
  }
  const p = FLOOD_TIP_WEI
  const steps = 2 * k + 1
  note(`block-full stand-in: ${cap} txs per round. K = ${k}, so the boost is p/(2K) = p/${2 * k} per round; p = ${gwei(p)} gwei (the flooders' constant tip).`)
  note(`plan: ${steps} steps, one per round. Step 0: a zero-tip tx, then ${cap} paying txs. Steps 1-${steps - 1}: ${cap} fresh paying txs each. The last step ends with a later arrival that tips exactly p.`)
  note(`wallets (Anvil dev accounts): zero-tip = ${ANVIL_ACCOUNT_MAP.floodZeroTip}, later arrival = ${ANVIL_ACCOUNT_MAP.floodLaterArrival}, flooders = ${ANVIL_ACCOUNT_MAP.flooders[0]}-${ANVIL_ACCOUNT_MAP.flooders.at(-1)}`)
  const j = await runWithRetry(
    () => floodAttempt(env, k, cap, p, steps),
    true,
    () => step('flood: inconclusive; retrying once after a fresh round tick'),
  )
  plain()
  for (const l of j.lines) note(l)
  plain()
  for (const c of j.checks) plain(`  ${c}`)
  plain()
  result(j.verdict, `Scenario flood: ${j.verdict} - ${j.reason}`)
  const code = exitCode([j.verdict])
  result(verdictOfCode(code), code === 0 ? 'Flood scenario PASS.' : code === 3 ? 'Inconclusive (exit 3): rerun.' : 'FAIL (exit 1).')
  return code
}

/** One run of the schedule: sign, send step by step after round ticks, wait, read the trace, judge. */
async function floodAttempt(env: Env, k: number, cap: number, p: bigint, steps: number): Promise<Attempt> {
  // Sign everything first: nothing is signed or estimated while a round is running.
  const zeroAcct = privateKeyToAccount(ANVIL_DEV_KEYS[ANVIL_ACCOUNT_MAP.floodZeroTip]!)
  const laterAcct = privateKeyToAccount(ANVIL_DEV_KEYS[ANVIL_ACCOUNT_MAP.floodLaterArrival]!)
  const flooders = ANVIL_ACCOUNT_MAP.flooders.map((i) => privateKeyToAccount(anvilDevKey(i)))
  const gas = ((await env.read.estimateGas({ account: zeroAcct.address, to: '0x000000000000000000000000000000000000dEaD', value: 0n })) * 11n) / 10n
  const nonces = new Map<string, number>()
  for (const a of [zeroAcct, laterAcct, ...flooders]) nonces.set(a.address, await pendingNonceOf(env, a.address))
  const nextNonce = (a: { address: string }) => {
    const n = nonces.get(a.address)!
    nonces.set(a.address, n + 1)
    return n
  }
  const zeroRaw = await signTransfer(env, zeroAcct, 0n, nextNonce(zeroAcct), gas)
  const laterRaw = await signTransfer(env, laterAcct, p, nextNonce(laterAcct), gas)
  const plan: Hex[][] = []
  let n = 0
  for (let s = 0; s < steps; s++) {
    const raws: Hex[] = []
    for (let j = 0; j < cap; j++) {
      const f = flooders[n++ % FLOODERS]!
      raws.push(await signTransfer(env, f, p, nextNonce(f), gas))
    }
    plan.push(raws)
  }

  // Send: each step right after a round tick, so it arrives in its own round. `sentSteps[s]` = every hash of step s.
  const sent = async (raw: Hex) => env.send.sendRawTransaction({ serializedTransaction: raw })
  const sentSteps: { hash: Hex; payer: boolean }[][] = []
  let zeroHash!: Hex
  let laterHash!: Hex
  for (let s = 0; s < steps; s++) {
    await syncToTick(env.sendUrl)
    const row: { hash: Hex; payer: boolean }[] = []
    if (s === 0) {
      zeroHash = await sent(zeroRaw)
      row.push({ hash: zeroHash, payer: false })
      step(`step 0: sent the zero-tip tx ${zeroHash.slice(0, 10)}.. (tip 0) first`)
    }
    for (const raw of plan[s]!) row.push({ hash: await sent(raw), payer: s < steps - 1 })
    step(`step ${s}: sent ${plan[s]!.length} paying txs (tip ${gwei(p)} gwei)`)
    if (s === steps - 1) {
      laterHash = await sent(laterRaw)
      row.push({ hash: laterHash, payer: false })
      step(`step ${s}: then the later arrival ${laterHash.slice(0, 10)}.. (tip exactly p = ${gwei(p)} gwei)`)
    }
    sentSteps.push(row)
  }

  step('waiting for the zero-tip tx and the later arrival to land')
  const { landed, missing } = await collectLanded(env, [
    { label: 'zero', hash: zeroHash },
    { label: 'later', hash: laterHash },
  ])
  const by = (label: string): Landed | undefined => landed.find((l) => l.label === label)
  const trace = (h: Hex) => simRpc<BoostTraceEntry[]>(env.sendUrl, 'sim_boostTrace', [h])
  const zeroTrace = await trace(zeroHash)
  const laterTrace = await trace(laterHash)
  const stepInfo: FloodInput['steps'] = []
  for (const row of sentSteps) {
    const out: FloodInput['steps'][number] = []
    for (const t of row) {
      const tr = await trace(t.hash)
      if (!tr || tr.length === 0) continue // unknown: the judge sees an incomplete step
      const inc = tr.find((e) => e.included)
      out.push({ arrival: tr[0]!.round, included: inc?.round, mustInclude: t.payer })
    }
    stepInfo.push(out.length === row.length ? out : [])
  }
  const lines: string[] = []
  if (zeroTrace && zeroTrace.length > 0) {
    lines.push(`zero-tip tx, boosted priority per round (p = ${gwei(p)} gwei, boost = p/(2K) = ${gwei(p / BigInt(2 * k))} gwei):`)
    lines.push(`  ${formatBoostTrace(zeroTrace, p, k)}`)
  }
  if (laterTrace && laterTrace.length > 0) lines.push(`later arrival (tip p): ${formatBoostTrace(laterTrace, p, k)}`)
  if (missing.length > 0) lines.push(`no receipt in time for: ${missing.join(', ')}`)
  const z = by('zero')
  if (z) lines.push(`zero-tip tx landed in block ${z.block} idx ${z.index}; effective tip from its receipt = ${gwei(z.tip)} gwei`)
  const l = by('later')
  if (l) lines.push(`later arrival landed in block ${l.block} idx ${l.index}; effective tip = ${gwei(l.tip)} gwei`)
  const j = judgeFlood({ k, p, zero: z, later: l, zeroTrace, laterTrace, steps: stepInfo.some((x) => x.length === 0) ? [] : stepInfo })
  return { ...j, lines }
}
