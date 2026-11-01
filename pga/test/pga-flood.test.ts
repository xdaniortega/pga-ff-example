// Pure parts of the flood scenario (pga/bot/flood.ts): the judge, the trace formatting, and the config of the cap.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGwei } from 'viem'
import { ANVIL_ACCOUNT_MAP, anvilDevKey, ConfigError, localParams, maxTxsPerRound, parseMaxTxsFlag } from '../../shared/config.ts'
import { runWithRetry } from '../bot/common.ts'
import { expectedBoostedPriorities, formatBoostTrace, judgeFlood, noCapMessage, priorityLabel, type FloodInput } from '../bot/flood.ts'
import { bannerLines } from '../../sim/banner.ts'
import { formatBoost, type RoundInfo } from '../../sim/sequencer.ts'
import { privateKeyToAccount } from 'viem/accounts'

const P = parseGwei('0.01')
const K = 2
const trace = (priorities: bigint[], r0 = 10) => priorities.map((p, i) => ({ round: r0 + i, priority: p.toString(), included: i === priorities.length - 1 }))
/** 5 steps (K = 2, cap 3): step 0 = zero + 3 payers, steps 1-3 = 3 payers, step 4 = 3 payers + the later arrival. */
function goodSteps(): FloodInput['steps'] {
  return Array.from({ length: 5 }, (_, s) => {
    const row: FloodInput['steps'][number] = []
    if (s === 0) row.push({ arrival: 10, included: 14, mustInclude: false })
    for (let j = 0; j < 3; j++) row.push({ arrival: 10 + s, included: 10 + s, mustInclude: s < 4 })
    if (s === 4) row.push({ arrival: 14, included: 15, mustInclude: false })
    return row
  })
}
const good = (): FloodInput => ({
  k: K,
  p: P,
  zero: { block: 50n, index: 0, tip: 0n },
  later: { block: 51n, index: 1, tip: P },
  zeroTrace: trace(expectedBoostedPriorities(P, K, 5)),
  laterTrace: trace([P, (5n * P) / 4n], 14),
  steps: goodSteps(),
})

test('expected boosted priorities: 0, p/4, p/2, 3p/4, p for K = 2', () => {
  assert.deepEqual(expectedBoostedPriorities(P, 2, 5), [0n, P / 4n, P / 2n, (3n * P) / 4n, P])
  assert.deepEqual(expectedBoostedPriorities(P, 2, 5).map((x) => priorityLabel(x, P, 2)), ['0', 'p/4', 'p/2', '3p/4', 'p'])
  assert.equal(formatBoostTrace(trace(expectedBoostedPriorities(P, 2, 5)), P, 2).includes('round 10: 0  ->  round 11: p/4'), true)
})

test('judgeFlood: PASS when the boost is p/(2K), it lands within 2K+1 rounds, ahead of the later arrival, tip 0', () => {
  const j = judgeFlood(good())
  assert.equal(j.verdict, 'PASS', j.reason)
  assert.equal(j.checks.length, 4)
})

test('judgeFlood: FAIL when the later arrival lands first, the tip is not 0, the boost is wrong, or it took too long', () => {
  assert.equal(judgeFlood({ ...good(), later: { block: 50n, index: 0, tip: P }, zero: { block: 50n, index: 1, tip: 0n } }).verdict, 'FAIL')
  const paid = judgeFlood({ ...good(), zero: { block: 50n, index: 0, tip: 1n } })
  assert.equal(paid.verdict, 'FAIL')
  assert.match(paid.reason, /boost must never change the fee/)
  const wrong = judgeFlood({ ...good(), zeroTrace: trace([0n, P / 2n, P, P, P]) })
  assert.equal(wrong.verdict, 'FAIL')
  assert.match(wrong.reason, /not p\/\(2K\)/)
  const slow = judgeFlood({ ...good(), zeroTrace: trace(expectedBoostedPriorities(P, K, 7)) })
  assert.equal(slow.verdict, 'FAIL')
  assert.match(slow.reason, /within 2K\+1 = 5 rounds/)
  assert.equal(judgeFlood({ ...good(), zero: undefined }).verdict, 'FAIL')
})

test('judgeFlood: a boost that is too small, on a schedule proven on time, is FAIL (not INCONCLUSIVE)', () => {
  // Half the boost: 0, p/8, p/4, 3p/8, p/2 - the zero tip never reaches p, which used to read as INCONCLUSIVE.
  const small = judgeFlood({ ...good(), zeroTrace: trace([0n, P / 8n, P / 4n, (3n * P) / 8n, P / 2n]) })
  assert.equal(small.verdict, 'FAIL')
  assert.match(small.reason, /the boost is not p\/\(2K\)/)
  // A slipped schedule still wins: it is INCONCLUSIVE even with a wrong boost.
  const late = goodSteps()
  late[2]![0]!.arrival = 13
  assert.equal(judgeFlood({ ...good(), steps: late, zeroTrace: trace([0n, P / 8n]) }).verdict, 'INCONCLUSIVE')
})

test('judgeFlood: INCONCLUSIVE when the schedule slipped (any tx of any step) or there is no trace', () => {
  const late = goodSteps()
  late[2]![0]!.arrival = 13 // the first payer of step 2 arrived a round late
  assert.equal(judgeFlood({ ...good(), steps: late }).verdict, 'INCONCLUSIVE')
  const lastPayer = goodSteps()
  lastPayer[1]![2]!.arrival = 12 // not the first tx of its step
  const j = judgeFlood({ ...good(), steps: lastPayer })
  assert.equal(j.verdict, 'INCONCLUSIVE')
  assert.match(j.reason, /step 1 tx 2 arrived in round 12 instead of 11/)
  const cut = goodSteps()
  cut[0]![2]!.included = 11 // a step-0 payer slipped to the next round
  assert.equal(judgeFlood({ ...good(), steps: cut }).verdict, 'INCONCLUSIVE')
  const empty = judgeFlood({ ...good(), steps: [] })
  assert.equal(empty.verdict, 'INCONCLUSIVE')
  assert.doesNotMatch(empty.reason, /rounds\s*instead|rounds ,|\(\)/) // never an empty round list
  assert.equal(judgeFlood({ ...good(), zeroTrace: null }).verdict, 'INCONCLUSIVE')
})

test('judgeFlood: a zero tip that never waited is not a PASS (FIFO or a slipped step 0): trace [0] is INCONCLUSIVE', () => {
  const j = judgeFlood({ ...good(), zeroTrace: trace([0n]) })
  assert.equal(j.verdict, 'INCONCLUSIVE')
  assert.match(j.reason, /included in its first round, so the boost was never exercised/)
  // It waited but reached less than p at inclusion: also not a PASS.
  assert.equal(judgeFlood({ ...good(), zeroTrace: trace([0n, P / 4n]) }).verdict, 'INCONCLUSIVE')
})

test('runWithRetry: retries once on INCONCLUSIVE (and says so), never on PASS/FAIL, only when allowed', async () => {
  const mk = (verdicts: ('PASS' | 'FAIL' | 'INCONCLUSIVE')[]) => {
    let n = 0
    return async () => ({ verdict: verdicts[Math.min(n++, verdicts.length - 1)]!, reason: `try ${n}` })
  }
  const said: string[] = []
  const r = await runWithRetry(mk(['INCONCLUSIVE', 'PASS']), true, () => said.push('retry'))
  assert.equal(r.verdict, 'PASS')
  assert.equal(said.length, 1)
  assert.match(r.reason, /after 1 retry/)
  const twice = await runWithRetry(mk(['INCONCLUSIVE', 'INCONCLUSIVE']), true, () => said.push('retry'))
  assert.equal(twice.verdict, 'INCONCLUSIVE')
  assert.equal(said.length, 2, 'only one retry')
  const noRetry = await runWithRetry(mk(['INCONCLUSIVE', 'PASS']), false, () => said.push('x'))
  assert.equal(noRetry.verdict, 'INCONCLUSIVE')
  const fail = await runWithRetry(mk(['FAIL', 'PASS']), true, () => said.push('x'))
  assert.equal(fail.verdict, 'FAIL')
  assert.equal(said.length, 2)
})

test('the no-cap message differs when this command started the stack itself', () => {
  assert.match(noCapMessage(2, true).join('\n'), /started by this command without a cap.*another terminal/s)
  assert.doesNotMatch(noCapMessage(2, true).join('\n'), /Stop it and restart/)
  assert.match(noCapMessage(2, false).join('\n'), /Stop it and restart it with a cap/)
})

test('MAX_TXS_PER_ROUND and --max-txs-per-round parse; default is no cap', () => {
  assert.equal(maxTxsPerRound({}), 0)
  assert.equal(maxTxsPerRound({ MAX_TXS_PER_ROUND: '3' }), 3)
  assert.throws(() => maxTxsPerRound({ MAX_TXS_PER_ROUND: '-1' }), ConfigError)
  assert.throws(() => maxTxsPerRound({ MAX_TXS_PER_ROUND: 'x' }), ConfigError)
  assert.equal(localParams('slow', {}).maxTxsPerRound, 0)
  assert.equal(localParams('slow', { MAX_TXS_PER_ROUND: '3' }).maxTxsPerRound, 3)
  assert.equal(parseMaxTxsFlag(['--max-txs-per-round', '3']), '3')
  assert.equal(parseMaxTxsFlag(['--max-txs-per-round=4']), '4')
  assert.equal(parseMaxTxsFlag(['--preset', 'slow']), undefined)
  assert.throws(() => parseMaxTxsFlag(['--max-txs-per-round']), ConfigError)
})

test('banner: prints the block-full stand-in as a LOCAL line when the cap is set, and says there is none otherwise', () => {
  assert.ok(!bannerLines(localParams('slow', {})).some((l) => /block-full stand-in/.test(l)))
  assert.ok(bannerLines(localParams('slow', {})).some((l) => l.includes('LOCAL: no block-full limit (Arbitrum One: 32 Mgas / 95 kB calldata per block)')), 'R8: never silent')
  assert.ok(bannerLines(localParams('slow', { MAX_TXS_PER_ROUND: '3' })).some((l) => l.includes('LOCAL: block-full stand-in = 3 txs per round (Arbitrum One: 32 Mgas / 95 kB calldata per block)')))
})

test('account map: flooders are Anvil accounts 3-8, with the known public addresses, disjoint from users, admin and traffic', () => {
  const all = [...ANVIL_ACCOUNT_MAP.users, ANVIL_ACCOUNT_MAP.admin, ...ANVIL_ACCOUNT_MAP.traffic]
  for (const f of ANVIL_ACCOUNT_MAP.flooders) assert.ok(!all.includes(f as never))
  assert.equal(privateKeyToAccount(anvilDevKey(3)).address, '0x90F79bf6EB2c4f870365E785982E1f101E93b906')
  assert.equal(privateKeyToAccount(anvilDevKey(0)).address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
})

test('the no-cap explanation names the restart command', () => {
  assert.ok(noCapMessage(2).join('\n').includes('npm run sim -- --max-txs-per-round 3'))
})

test('sequencer narration: queue size, included, p, the boost line and the zero-tip tx boosted priority', () => {
  const r: RoundInfo = {
    round: 7,
    ordered: 3,
    dropped: 0,
    boostInfo: {
      k: 2, cap: 3, queueSize: 7, included: 3, p: P, boost: P / 4n,
      carried: [{ hash: `0x${'ab'.repeat(32)}`, from: '0x0000000000000000000000000000000000000001', nonce: 0, effectiveTip: 0n, boostedPriority: P / 2n, reason: 'block full' }],
    },
  }
  const text = formatBoost(r).join('\n')
  assert.match(text, /queue 7 tx, included 3 .*at most 3 per round.*p = 0\.01 gwei/)
  assert.match(text, /boost: \+p\/\(2K\) = \+0\.0025 gwei .* to 1 waiting txs/)
  assert.match(text, /tip 0 gwei -> boosted priority 0\.005 gwei  \(zero tip\)/)
})
