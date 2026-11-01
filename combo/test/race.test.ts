// C1 pure parts: the Opened-log filter, the verdict and exit codes, the timeline, the CLI guards, the account map.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pad, parseGwei, toEventSelector, toHex, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ANVIL_ACCOUNT_MAP, anvilDevKey, ANVIL_ACCOUNTS, LOCAL_ADMIN_KEY } from '../../shared/config.ts'
import type { FeedMessageJson } from '../../fast-feed/client/client.ts'
import { CLAIM_GAS_MARGIN, currentRoundEnd, isOpenedFor, localIdentities, newIdentity, OPENED_TOPIC, purchaseLandMs, minRoundLeftS, renewDecision, renewMinToBuyMs, renewTooLate, renewThresholdMs, ticketsUsable } from '../race.ts'
import {
  castCommand, claimRoundLines, formatMatrix, formatTimeline, isTimelineVerdict, visibleBy, wrapText, judgeRace, matrixExitCode, parseRaceArgs, raceExitCode, runTrialWithRetry, strategyOf, summarizeMatrix, whyLines, SCENARIOS, TAKEAWAY,
  type BotResult, type RaceInput, type TrialRecord,
} from '../scenarios.ts'
import { ConfigError } from '../../shared/config.ts'
import { apiKeyHash } from '../../fast-feed/client/key.ts'

const RACE = '0xb19b36b1456E65E3A6D514D3F715f204BD59f431'
const OTHER = '0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35'
const idTopic = (id: bigint) => pad(toHex(id), { size: 32 })
const msg = (logs: { address: string; topics: string[] }[], status: number | string = 1): FeedMessageJson => ({
  version: 1,
  timestamp_ms: 0,
  transaction: {
    block_number: 9, tx_index: 0, raw_tx: '0x', tx_hash: '0x00',
    receipt: { status, gas_used: 1, cumulative_gas_used: 1, effective_gas_price: 1, base_fee: 1, contract_address: null, logs: logs.map((l) => ({ ...l, data: '0x' })) as never },
  },
})

test('Opened topic is keccak("Opened(uint256)")', () => {
  assert.equal(OPENED_TOPIC, toEventSelector('Opened(uint256)'))
})

test('isOpenedFor: matches the Race address, the Opened topic and the id (case-insensitive); nothing else', () => {
  const good = { address: RACE, topics: [OPENED_TOPIC, idTopic(7n)] }
  assert.equal(isOpenedFor(msg([good]), RACE, 7n), true)
  assert.equal(isOpenedFor(msg([{ ...good, address: RACE.toLowerCase() }]), RACE.toUpperCase().replace('0X', '0x'), 7n), true)
  assert.equal(isOpenedFor(msg([good]), RACE, 8n), false, 'another id')
  assert.equal(isOpenedFor(msg([{ ...good, address: OTHER }]), RACE, 7n), false, 'another contract')
  assert.equal(isOpenedFor(msg([{ address: RACE, topics: [toEventSelector('Claimed(uint256,address,uint256)'), idTopic(7n)] }]), RACE, 7n), false, 'another event')
  assert.equal(isOpenedFor(msg([{ address: RACE, topics: [OPENED_TOPIC] }]), RACE, 7n), false, 'no id topic')
  assert.equal(isOpenedFor(msg([]), RACE, 7n), false, 'no logs')
  assert.equal(isOpenedFor(msg([good], 0), RACE, 7n), false, 'a reverted tx')
  assert.equal(isOpenedFor(msg([good], '0x1'), RACE, 7n), true, 'hex status')
  assert.equal(isOpenedFor(msg([{ address: OTHER, topics: [OPENED_TOPIC, idTopic(7n)] }, good]), RACE, 7n), true, 'among other logs')
  assert.equal(isOpenedFor({ version: 1, timestamp_ms: 0 } as never, RACE, 7n), false, 'malformed message')
})

const bot = (name: 'mine' | 'rival', over: Partial<BotResult> = {}): BotResult => ({
  name,
  address: (name === 'mine' ? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' : '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC') as Address,
  seenAt: 1000,
  sentAt: name === 'rival' ? 1002 : 1054,
  landed: { block: 10n, index: name === 'mine' ? 0 : 1, tip: name === 'mine' ? parseGwei('0.1') : parseGwei('0.001') },
  rank: name === 'mine' ? 1 : 2,
  ...over,
})
const input = (over: Partial<RaceInput> = {}): RaceInput => ({
  scenario: 's1', ordering: 'pga', id: 7n, expectedWinner: 'mine', mine: bot('mine'), rival: bot('rival'), winner: bot('mine').address, openBlock: 9, ...over,
})

test('judgeRace: PASS when mine is rank 1 in the same block; the reason names the tip', () => {
  const j = judgeRace(input())
  assert.equal(j.verdict, 'PASS')
  assert.match(j.reason, /the TIP decided/)
  assert.equal(raceExitCode(j.verdict), 0)
})

test('judgeRace: FAIL (exit 1) when the rival ranks first (FIFO-like), and the reason says why', () => {
  const j = judgeRace(input({
    mine: bot('mine', { rank: 2, landed: { block: 10n, index: 1, tip: parseGwei('0.1') } }),
    rival: bot('rival', { rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.001') } }),
    winner: bot('rival').address,
  }))
  assert.equal(j.verdict, 'FAIL')
  assert.match(j.reason, /rival ranks first/)
  assert.match(j.reason, /--fifo/)
  assert.equal(raceExitCode(j.verdict), 1)
})

test('judgeRace: INCONCLUSIVE (exit 3) in different rounds, or when mine did not fire after the rival', () => {
  // (ranks as the contract would record them: the earlier block's claim is rank 1)
  const split = judgeRace(input({ mine: bot('mine', { rank: 2, landed: { block: 11n, index: 0, tip: parseGwei('0.1') } }), rival: bot('rival', { rank: 1 }), winner: bot('rival').address }))
  assert.equal(split.verdict, 'INCONCLUSIVE')
  assert.match(split.reason, /different rounds \(rival block 10, mine block 11\)/)
  assert.equal(raceExitCode(split.verdict), 3)
  // B6b: the same BLOCK is not the same ROUND. Same block, different pga_round -> INCONCLUSIVE for S1 (the earlier round wins whatever the tips).
  const L = (pgaRound: number, index: number, tip: string) => ({ block: 10n, index, tip: parseGwei(tip), pgaRound })
  const sameBlockOtherRound = judgeRace(input({ mine: bot('mine', { landed: L(2, 0, '0.1') }), rival: bot('rival', { landed: L(1, 1, '0.001') }) }))
  assert.equal(sameBlockOtherRound.verdict, 'INCONCLUSIVE')
  assert.match(sameBlockOtherRound.reason, /different rounds \(rival block 10 round 1, mine block 10 round 2\)/)
  // ... and the same block AND the same pga_round passes as before.
  const sameRound = judgeRace(input({ mine: bot('mine', { landed: L(2, 0, '0.1') }), rival: bot('rival', { landed: L(2, 1, '0.001') }) }))
  assert.equal(sameRound.verdict, 'PASS')
  assert.match(sameRound.reason, /same round/)
  const order = judgeRace(input({ mine: bot('mine', { sentAt: 1000 }) }))
  assert.equal(order.verdict, 'INCONCLUSIVE')
})

test('judgeRace: FAIL on a missing receipt, an unrecorded claim, ranks that disagree with the block, or a wrong winner()', () => {
  assert.equal(judgeRace(input({ mine: bot('mine', { landed: undefined }) })).verdict, 'FAIL')
  assert.equal(judgeRace(input({ rival: bot('rival', { rank: 0 }) })).verdict, 'FAIL')
  const swapped = judgeRace(input({ mine: bot('mine', { rank: 2 }), rival: bot('rival', { rank: 1 }) }))
  assert.equal(swapped.verdict, 'FAIL')
  assert.match(swapped.reason, /disagree with the block order/)
  const w = judgeRace(input({ winner: bot('rival').address }))
  assert.equal(w.verdict, 'FAIL')
  assert.match(w.reason, /winner\(id\)/)
})

test('formatTimeline: the shape of the demo, ending with the deciding effect', () => {
  const lines = formatTimeline({ id: 7n, t0: 1000, openBlock: 9, mine: bot('mine'), rival: bot('rival') })
  assert.match(lines[0]!, /^feed saw Opened\(7\) at t0 \(the message for block 9/)
  assert.equal(lines[1], 'rival sent at t0+2ms (tip 0.001 gwei)')
  assert.equal(lines[2], 'mine sent at t0+54ms (tip 0.1 gwei)')
  assert.equal(lines[3], 'block 10: mine idx 0 (rank 1), rival idx 1 (rank 2)')
  assert.equal(lines[4], 'same round → higher tip wins')
})

test('formatTimeline: FIFO order and split rounds are not narrated as a tip win', () => {
  const fifo = formatTimeline({
    id: 7n, t0: 1000, mine: bot('mine', { rank: 2, landed: { block: 10n, index: 1, tip: parseGwei('0.1') } }),
    rival: bot('rival', { rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.001') } }),
  })
  assert.match(fifo.at(-1)!, /not tip order/)
  const split = formatTimeline({ id: 7n, t0: 1000, mine: bot('mine', { landed: { block: 11n, index: 0, tip: parseGwei('0.1') } }), rival: bot('rival') })
  assert.match(split.at(-1)!, /different rounds/)
})

test('judgeRace S1 honesty: FIFO with mine first by arrival is INCONCLUSIVE, never a tip win; a winner that did not out-tip is INCONCLUSIVE', () => {
  const fifo = judgeRace(input({ ordering: 'fifo' }))
  assert.equal(fifo.verdict, 'INCONCLUSIVE')
  assert.match(fifo.reason, /FIFO: arrival decided, not the tip/)
  assert.equal(raceExitCode(fifo.verdict), 3)
  const flat = judgeRace(input({ mine: bot('mine', { landed: { block: 10n, index: 0, tip: parseGwei('0.001') } }) }))
  assert.equal(flat.verdict, 'INCONCLUSIVE')
  assert.doesNotMatch(flat.reason, /TIP decided/)
  // FIFO with the rival first (the C1 negative check) is a FAIL, as before.
  const rivalFirst = judgeRace(input({
    ordering: 'fifo',
    mine: bot('mine', { rank: 2, landed: { block: 10n, index: 1, tip: parseGwei('0.1') } }),
    rival: bot('rival', { rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.001') } }),
    winner: bot('rival').address,
  }))
  assert.equal(rivalFirst.verdict, 'FAIL')
  assert.equal(judgeRace(input()).effect, 'tip')
})

// S2/S3: mine on the Fast Feed (sent at once), the rival polling (sent a poll interval after the block became visible).
const s2bot = (name: 'mine' | 'rival', over: Partial<BotResult> = {}): BotResult =>
  bot(name, name === 'mine'
    ? { via: 'feed', seenAt: 1000, sentAt: 1002, rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.001') } }
    : { via: 'poll', seenAt: 2300, sentAt: 2302, rank: 2, landed: { block: 12n, index: 0, tip: parseGwei('0.1') } })
const withBots = (scenario: 's2' | 's3', mineO: Partial<BotResult> = {}, rivalO: Partial<BotResult> = {}, over: Partial<RaceInput> = {}): RaceInput =>
  input({ scenario, mine: { ...s2bot('mine'), ...(scenario === 's3' ? { landed: { block: 10n, index: 0, tip: parseGwei('0.2') } } : {}), ...mineO }, rival: { ...s2bot('rival'), ...rivalO }, pollMs: 250, visibleAt: 2100, ...over })

test('judgeRace S2: PASS (information) when mine ranks first and the rival landed in a LATER round, even with the higher tip', () => {
  const j = judgeRace(withBots('s2'))
  assert.equal(j.verdict, 'PASS')
  assert.equal(j.effect, 'information')
  assert.match(j.reason, /LATER round, block 12/)
  assert.match(j.reason, /a tip cannot buy a round you are not in/)
  assert.match(j.reason, /information decided/)
  assert.equal(raceExitCode(j.verdict), 0)
  // Information decides even on a FIFO stack: the rounds differ.
  assert.equal(judgeRace(withBots('s2', {}, {}, { ordering: 'fifo' })).verdict, 'PASS')
})

test('judgeRace S2: the rival in the SAME block is INCONCLUSIVE with an explanation; the rival ranking first is a FAIL', () => {
  const same = judgeRace(withBots('s2', {}, { landed: { block: 10n, index: 1, tip: parseGwei('0.1') }, rank: 2 }))
  assert.equal(same.verdict, 'INCONCLUSIVE')
  assert.match(same.reason, /made it into mine's round/)
  assert.match(same.reason, /--poll-ms/)
  assert.equal(raceExitCode(same.verdict), 3)
  const lost = judgeRace(withBots('s2', { rank: 2, landed: { block: 12n, index: 0, tip: parseGwei('0.001') } }, { rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.1') } }, { winner: bot('rival').address }))
  assert.equal(lost.verdict, 'FAIL')
  assert.equal(raceExitCode(lost.verdict), 1)
})

test('judgeRace S3: PASS when mine ranks first; "both" only when mine was in an earlier round AND tipped more; tip alone in one block; FIFO is INCONCLUSIVE', () => {
  const both = judgeRace(withBots('s3'))
  assert.equal(both.verdict, 'PASS')
  assert.equal(both.effect, 'both')
  assert.match(both.reason, /both/)
  // Earlier round, but mine did not out-tip: information only (and the text does not claim a tip win).
  const infoOnly = judgeRace(withBots('s3', { landed: { block: 10n, index: 0, tip: parseGwei('0.05') } }))
  assert.equal(infoOnly.effect, 'information')
  assert.doesNotMatch(infoOnly.reason, /same-round tie/)
  const sameBlock = (over: Partial<RaceInput> = {}) => withBots('s3', {}, { landed: { block: 10n, index: 1, tip: parseGwei('0.1') } }, over)
  const tip = judgeRace(sameBlock())
  assert.equal(tip.verdict, 'PASS')
  assert.equal(tip.effect, 'tip')
  const fifo = judgeRace(sameBlock({ ordering: 'fifo' }))
  assert.equal(fifo.verdict, 'INCONCLUSIVE')
  assert.match(fifo.reason, /FIFO: arrival decided, not the tip/)
  const lost = judgeRace(withBots('s3', { rank: 2, landed: { block: 12n, index: 0, tip: parseGwei('0.2') } }, { rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.1') } }, { winner: bot('rival').address }))
  assert.equal(lost.verdict, 'FAIL')
})

test('formatTimeline for S2 shows the measured block visibility, the poll sighting and both landing blocks', () => {
  const t = formatTimeline({ id: 7n, t0: 1000, openBlock: 9, visibleAt: 2100, mine: s2bot('mine'), rival: s2bot('rival') })
  assert.match(t[0]!, /^feed saw Opened\(7\) at t0 \(the message for block 9, visible on RPC by t0\+1100ms \(probe every 25ms\)\)  \[mine t0\+0ms, rival \(poll\) t0\+1300ms\]$/)
  assert.ok(t.some((l) => /open in block 9; mine landed in block 10, rival in block 12/.test(l)), t.join('\n'))
  assert.equal(t.at(-1), 'different rounds → the earlier round wins, whatever the tips')
  assert.match(formatTimeline({ id: 7n, t0: 1000, openBlock: 9, mine: bot('mine'), rival: bot('rival') })[0]!, /not seen on the RPC within the wait/)
})

test('whyLines: S2 says why the rival saw Opened later; "the NEXT round" only when both claims share a block', () => {
  const i = withBots('s2')
  const why = whyLines(i, judgeRace(i)).join('\n')
  assert.doesNotMatch(why, /NEXT round/)
  assert.match(why, /next block boundary plus the publish delay \(visible by t0\+1100ms\)/)
  assert.match(why, /poll \(every 250ms\) then added at least 200ms/)
  assert.match(why, /Information got mine into the earlier round/)
  const s3 = withBots('s3')
  assert.match(whyLines(s3, judgeRace(s3)).join('\n'), /earlier round \(information\) and it tipped more/)
})

test('whyLines name the feed limit and the tip; claimRoundLines summarise the sequencer round', () => {
  const j = judgeRace(input())
  const why = whyLines(input(), j).join('\n')
  assert.match(why, /cannot jump a transaction that is already ordered/)
  assert.match(why, /NEXT round \(block 10\)/)
  assert.match(why, /the tip won the round/)
  const q = claimRoundLines(
    [{ name: 'rival', priority: parseGwei('0.001'), arrivalRound: 61, drained: 2 }, { name: 'mine', priority: parseGwei('0.1'), arrivalRound: 61, drained: 1 }],
    ['rival', 'mine'],
  )
  assert.equal(q[0], 'round 61: waiting list, in arrival order: rival (queue priority 0.001 gwei), mine (queue priority 0.1 gwei)')
  assert.match(q[1]!, /drained, 1\. mine, 2\. rival/)
})

test('castCommand has the real values; parseRaceArgs: scenario and delay validation', () => {
  assert.equal(castCommand(RACE, 7n, 'http://127.0.0.1:8547'), `cast call ${RACE} "winner(uint256)" 7 --rpc-url http://127.0.0.1:8547`)
  assert.equal(parseRaceArgs(['--local']).scenario, 's1')
  assert.equal(parseRaceArgs(['--local', '--scenario', 's1', '--mine-delay-ms', '80']).mineDelayMs, 80)
  assert.equal(parseRaceArgs(['--scenario=S1']).scenario, 's1')
  assert.throws(() => parseRaceArgs(['--scenario', 's9']), ConfigError)
  assert.throws(() => parseRaceArgs(['--scenario']), ConfigError)
  assert.throws(() => parseRaceArgs(['--mine-delay-ms', '0']), ConfigError)
  assert.throws(() => parseRaceArgs(['--mine-delay-ms', 'x']), ConfigError)
  assert.equal(SCENARIOS.s1.mineDelayMs, 50)
  assert.ok(SCENARIOS.s1.mineTip > SCENARIOS.s1.rivalTip)
})

test('scenario definitions: S2 (feed, low tip vs poll, high tip) and S3 (feed, higher tip vs poll); args for the matrix', () => {
  assert.equal(SCENARIOS.s2.rivalVia, 'poll')
  assert.equal(SCENARIOS.s2.rivalTip, parseGwei('0.1'))
  assert.equal(SCENARIOS.s2.mineTip, parseGwei('0.001'))
  assert.equal(SCENARIOS.s3.mineTip, parseGwei('0.2'))
  assert.equal(SCENARIOS.s3.rivalTip, parseGwei('0.1'))
  assert.equal(SCENARIOS.s1.rivalVia, 'feed')
  for (const id of ['s1', 's2', 's3'] as const) assert.equal(SCENARIOS[id].expectedWinner, 'mine')
  const a = parseRaceArgs(['--local', '--scenario', 'matrix', '--trials', '5'])
  assert.deepEqual([a.scenario, a.trials, a.pollMs], ['matrix', 5, 250])
  assert.equal(parseRaceArgs(['--scenario', 's2', '--poll-ms', '400']).pollMs, 400)
  assert.throws(() => parseRaceArgs(['--scenario', 's2', '--trials', '3']), ConfigError)
  assert.throws(() => parseRaceArgs(['--scenario', 'matrix', '--trials', '0']), ConfigError)
  assert.throws(() => parseRaceArgs(['--scenario', 'matrix', '--poll-ms', 'x']), ConfigError)
  assert.equal(strategyOf(SCENARIOS.s2, 'rival', { pollMs: 250 }), 'poll 250ms, tip 0.1')
  assert.equal(strategyOf(SCENARIOS.s1, 'mine'), 'feed +50ms, tip 0.1')
})

const rec = (scenario: 's1' | 's2' | 's3', verdict: TrialRecord['verdict'], effect?: TrialRecord['effect']): TrialRecord => ({ scenario, verdict, effect, reason: `${scenario} ${verdict} reason` })
const allWins = (n: number): TrialRecord[] => [
  ...Array.from({ length: n }, () => rec('s1', 'PASS', 'tip')),
  ...Array.from({ length: n }, () => rec('s2', 'PASS', 'information')),
  ...Array.from({ length: n }, () => rec('s3', 'PASS', 'both')),
]

test('buyTickets minimum is B-aware (5s floor, then one purchase landing time) and renewTickets compares the ticket\'s own activeUntil', () => {
  // buyTickets / renewTickets themselves read the chain through viem clients built inside them (no injection point), so their
  // wiring is covered by the integration tests; the two decisions they make are pure and tested here.
  assert.equal(minRoundLeftS(2000), 5, 'B = 2000: the 5s floor')
  assert.equal(minRoundLeftS(200), 5)
  assert.equal(minRoundLeftS(10_000), 15, 'B = 10s: 1.5 x B')
  assert.equal(renewTooLate(100_000, 100_000 - purchaseLandMs(2000) - 1, 2000), false, 'enough of the ticket left')
  assert.equal(renewTooLate(100_000, 100_000 - purchaseLandMs(2000) + 1, 2000), true, 'less than one purchase left')
  assert.equal(renewTooLate(100_000, 100_000 - 9_000, 10_000), true, 'slow blocks: 9s is too little at B = 10s')
  assert.equal(renewTooLate(100_000, 100_000 - 9_000, 2000), false, 'the same 9s is enough at B = 2s')
})

test('matrix: one table with the three scenarios, wins/trials, the deciding effect, the S3 row says both, the takeaway; at most 80 columns', () => {
  const records = allWins(5)
  const rows = summarizeMatrix(records, { pollMs: 250 })
  assert.deepEqual(rows.map((r) => [r.scenario, r.wins, r.trials]), [['s1', 5, 5], ['s2', 5, 5], ['s3', 5, 5]])
  const m = formatMatrix(rows, records)
  const table = m.table
  assert.equal(table.length, 5)
  assert.match(table[0]!, /^Scen +Mine +Rival +Wins +Deciding effect$/)
  assert.match(table[2]!, /^S1 +feed \+50ms, tip 0\.1 +feed, tip 0\.001 +5\/5 +tip$/)
  assert.match(table[3]!, /^S2 +feed, tip 0\.001 +poll 250ms, tip 0\.1 +5\/5 +information$/)
  assert.match(table[4]!, /^S3 +feed, tip 0\.2 +poll 250ms, tip 0\.1 +5\/5 +both$/)
  assert.equal(m.notes.at(-1)?.startsWith('NOTE: Takeaway: '), true)
  assert.match(m.notes.join(' '), new RegExp(`Takeaway: ${TAKEAWAY}\\.`))
  assert.equal(TAKEAWAY, 'information gets you into the round; the tip wins the round')
  assert.equal(table.filter((l) => /^Scen/.test(l)).length, 1, 'ONE table')
  assert.ok(m.notes.every((l) => /^(NOTE: |      )/.test(l)), 'every explanation line is a NOTE: line or its continuation')
  assert.ok(!m.table.some((l) => /NOTE:|feed = Fast Feed/.test(l)), 'no prose in the table')
  assert.equal(m.notes.filter((l) => l.startsWith('NOTE:')).length, 3, 'legend x2 and takeaway')
  assert.equal(matrixExitCode(rows), 0)
  for (const l of table) assert.ok(l.length <= 80, `${l.length} columns: ${l}`)
  // A slow poll and a long delay still fit.
  const wide = formatMatrix(summarizeMatrix(allWins(10), { pollMs: 60_000, mineDelayMs: 5000 }))
  for (const l of [...wide.table, ...wide.notes]) assert.ok(l.length <= 80, `${l.length} columns: ${l}`)
})

test('matrix: inconclusive trials are counted apart (exit 3); any failed trial makes exit 1 and its row and reason are shown', () => {
  const inc = [...allWins(2), rec('s2', 'INCONCLUSIVE')]
  const rowsInc = summarizeMatrix(inc)
  assert.equal(rowsInc[1]!.wins, 2)
  assert.equal(rowsInc[1]!.trials, 3)
  assert.equal(rowsInc[1]!.inconclusive, 1)
  assert.equal(matrixExitCode(rowsInc), 3)
  assert.match(formatMatrix(rowsInc, inc).notes.join('\n'), /inconclusive \(not counted as wins\): S2 1/)
  const bad = [...allWins(2), rec('s3', 'FAIL'), rec('s2', 'INCONCLUSIVE')]
  const rowsBad = summarizeMatrix(bad)
  assert.equal(matrixExitCode(rowsBad), 1)
  const mx = formatMatrix(rowsBad, bad)
  const out = [...mx.table, ...mx.notes].join('\n')
  assert.match(out, /NOTE: S3 FAIL: s3 FAIL reason/)
  assert.match(out, /S3 +feed, tip 0\.2 +poll 250ms, tip 0\.1 +2\/3/)
})

test('renewDecision: renew when less than 15s (or a trial length) of the round remains, once; too late below 3s', () => {
  const base = { roundEndMs: 100_000, coveredUntilMs: 100_000, trialMs: 8_000 }
  assert.equal(renewDecision({ ...base, nowMs: 60_000 }), 'no', '40s left')
  assert.equal(renewDecision({ ...base, nowMs: 84_000 }), 'no', '16s left')
  assert.equal(renewDecision({ ...base, nowMs: 86_000 }), 'renew', '14s left')
  assert.equal(renewDecision({ ...base, nowMs: 96_500 }), 'renew', '3.5s left')
  assert.equal(renewDecision({ ...base, nowMs: 97_500 }), 'too-late', '2.5s left: the purchase cannot land');
  assert.equal(renewDecision({ ...base, nowMs: 99_999 }), 'too-late')
  assert.equal(renewDecision({ ...base, trialMs: 25_000, nowMs: 80_000 }), 'renew', 'a trial longer than the time left must not meet the rollover unrenewed')
  assert.equal(renewDecision({ ...base, coveredUntilMs: 120_000, nowMs: 90_000 }), 'no', 'next round already bought: renew once per round')
})

test('currentRoundEnd: the end of the ticket round running at `now`, also after the session was renewed', () => {
  const s = { activeFrom: 1000, activeUntil: 21_000 }
  assert.equal(currentRoundEnd(s, 1000, 20_000), 21_000)
  assert.equal(currentRoundEnd(s, 20_999, 20_000), 21_000)
  assert.equal(currentRoundEnd(s, 21_000, 20_000), 41_000)
  assert.equal(currentRoundEnd({ activeFrom: 1000, activeUntil: 41_000 }, 5000, 20_000), 21_000, 'renewed: still the current round, not the covered one')
})

test('tickets: usable only inside their active window with enough time left; the gas margin covers the storage writes', () => {
  const s = { activeFrom: 1000, activeUntil: 21_000 }
  assert.equal(ticketsUsable(undefined, 5000, 0), false)
  assert.equal(ticketsUsable(s, 999, 0), false)
  assert.equal(ticketsUsable(s, 5000, 15_000), true)
  assert.equal(ticketsUsable(s, 10_000, 15_000), false)
  assert.ok(CLAIM_GAS_MARGIN >= 80_000n)
  // The forge test (contracts/test/combo/Race.t.sol) mirrors the margin: the two numbers must not drift apart.
  const forge = readFileSync(new URL('../../contracts/test/combo/Race.t.sol', import.meta.url), 'utf8')
  const m = forge.match(/claimGasMargin\s*=\s*([\d_]+)/)
  assert.ok(m, 'Race.t.sol declares claimGasMargin')
  assert.equal(BigInt(m[1]!.replaceAll('_', '')), CLAIM_GAS_MARGIN)
  assert.equal(CLAIM_GAS_MARGIN, 100_000n)
})

test('account map: race roles reuse idle accounts (operator = Tickets admin 9, mine 0, rival 2), all inside the 20 accounts', () => {
  assert.equal(ANVIL_ACCOUNT_MAP.raceOperator, ANVIL_ACCOUNT_MAP.admin)
  assert.equal(ANVIL_ACCOUNT_MAP.raceMine, 0)
  assert.equal(ANVIL_ACCOUNT_MAP.raceRival, 2)
  assert.notEqual(ANVIL_ACCOUNT_MAP.raceMine, ANVIL_ACCOUNT_MAP.raceRival)
  for (const i of [ANVIL_ACCOUNT_MAP.raceOperator, ANVIL_ACCOUNT_MAP.raceMine, ANVIL_ACCOUNT_MAP.raceRival]) assert.ok(i < ANVIL_ACCOUNTS)
  assert.equal(privateKeyToAccount(anvilDevKey(9)).address, privateKeyToAccount(LOCAL_ADMIN_KEY).address)
  const { mine, rival } = localIdentities()
  assert.equal(mine.account.address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
  assert.equal(rival.account.address, '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC')
  assert.notEqual(mine.key, rival.key, 'each bot has its own feed key')
  assert.match(mine.keyHash, /^0x[0-9a-f]{64}$/)
})

function race(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'combo/scenarios.ts', ...args], { env: { ...process.env, ENV_FILE: '/nonexistent-env-file' }, encoding: 'utf8', timeout: 60_000 })
}

test('CLI: --testnet is refused with an explanation (non-zero, nothing run); usage errors exit 2', () => {
  const t = race(['--testnet', '--scenario', 's1'])
  assert.equal(t.status, 1)
  assert.match(t.stderr, /testnet race comes in a later stage.*race:deploy -- --testnet/s)
  assert.equal(race(['--scenario', 's1']).status, 2, 'no network flag')
  const bad = race(['--local', '--scenario', 'nope'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /Unknown scenario "nope"/)
})

test('judgeRace S3 on FIFO with different blocks: information only, no "both" and no same-round tie claim', () => {
  const i = withBots('s3', {}, {}, { ordering: 'fifo' })
  const j = judgeRace(i)
  assert.equal(j.verdict, 'PASS')
  assert.equal(j.effect, 'information')
  assert.doesNotMatch(j.reason, /\(both\)|same-round tie as well/)
  assert.match(j.reason, /on a FIFO sequencer the tip would not have counted/)
  assert.doesNotMatch(whyLines(i, j).join('\n'), /twice over|same-round tie\)\. /)
  assert.match(whyLines(i, j).join('\n'), /FIFO stack the tip would not have counted/)
})

test('formatTimeline: a same-block FIFO result never says "higher tip wins"', () => {
  const fifoRun = { id: 7n, t0: 1000, ordering: 'fifo' as const, mine: bot('mine', { rank: 2, landed: { block: 10n, index: 1, tip: parseGwei('0.1') } }), rival: bot('rival', { rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.001') } }) }
  assert.doesNotMatch(formatTimeline(fifoRun).join('\n'), /higher tip wins/)
  // The higher tip first by arrival on FIFO: still not a tip win.
  const arrival = formatTimeline({ ...fifoRun, mine: bot('mine'), rival: bot('rival') })
  assert.doesNotMatch(arrival.join('\n'), /higher tip wins/)
  assert.match(arrival.at(-1)!, /FIFO/)
  assert.match(formatTimeline({ ...fifoRun, ordering: 'pga', mine: bot('mine'), rival: bot('rival') }).at(-1)!, /higher tip wins/)
})

test('whyLines: when the rival landed in the EARLIER block, nothing says the rival was late', () => {
  const i = withBots('s2', { rank: 2, landed: { block: 12n, index: 0, tip: parseGwei('0.001') } }, { rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.1') } }, { winner: bot('rival').address })
  const j = judgeRace(i)
  assert.equal(j.verdict, 'FAIL')
  const why = whyLines(i, j).join('\n')
  assert.doesNotMatch(why, /joined the next round|saw Opened later|a later round/)
  // And even without a verdict, the "later" lines need mine to be earlier.
  assert.doesNotMatch(whyLines(i, { verdict: 'PASS', reason: '' }).join('\n'), /saw Opened later/)
})

test('visibleBy: a polling rival that saw the log proves the block was visible by then (never after the sighting)', () => {
  assert.equal(visibleBy(2092, { via: 'poll', seenAt: 2062 }), 2062, 'the probe is only an upper bound')
  assert.equal(visibleBy(2040, { via: 'poll', seenAt: 2062 }), 2040)
  assert.equal(visibleBy(2092, { via: 'feed', seenAt: 1000 }), 2092, 'a feed sighting says nothing about the RPC')
  assert.equal(visibleBy(undefined, { via: 'poll', seenAt: 2062 }), 2062)
  assert.equal(visibleBy(undefined, { via: 'feed', seenAt: 1000 }), undefined)
  const i = withBots('s2', {}, {}, { visibleAt: visibleBy(2092, { via: 'poll', seenAt: 2300 }) })
  const why = whyLines(i, judgeRace(i)).join('\n')
  assert.match(why, /then added at least 208ms/)
  assert.doesNotMatch(why, /added -/)
})

test('S2 in the same block is INCONCLUSIVE even when the rival then ranks first (the specific explanation wins)', () => {
  const j = judgeRace(withBots('s2', { rank: 2, landed: { block: 10n, index: 1, tip: parseGwei('0.001') } }, { rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.1') } }, { winner: bot('rival').address }))
  assert.equal(j.verdict, 'INCONCLUSIVE')
  assert.match(j.reason, /made it into mine's round.*information did not decide/)
})

test('matrix: every output line fits 80 columns (with the 2-space indent), wrapped reasons included; an empty matrix is never a pass', () => {
  const long = { scenario: 's2' as const, verdict: 'FAIL' as const, reason: 'x '.repeat(120) }
  const recs = [...allWins(5), long, rec('s3', 'INCONCLUSIVE')]
  const lm = formatMatrix(summarizeMatrix(recs, { pollMs: 250 }), recs)
  for (const l of lm.table) assert.ok(l.length + 2 <= 80, `${l.length + 2} columns: ${l}`)
  for (const l of lm.notes) assert.ok(l.length <= 80, `${l.length} columns: ${l}`)
  assert.deepEqual(wrapText('aaa bbb ccc', 7, '  '), ['aaa bbb', '  ccc'])
  assert.equal(matrixExitCode([]), 2)
  assert.equal(matrixExitCode(summarizeMatrix([])), 2)
})

test('args: --mine-delay-ms is S1 / matrix only; --poll-ms is remembered', () => {
  assert.throws(() => parseRaceArgs(['--scenario', 's2', '--mine-delay-ms', '5']), /S1/)
  assert.throws(() => parseRaceArgs(['--scenario', 's3', '--mine-delay-ms', '5']), ConfigError)
  assert.equal(parseRaceArgs(['--scenario', 'matrix', '--mine-delay-ms', '5']).mineDelayMs, 5)
  assert.equal(parseRaceArgs(['--scenario', 's1', '--poll-ms', '300']).pollMsGiven, true)
  assert.equal(parseRaceArgs(['--scenario', 's1']).pollMsGiven, false)
})

test('whyLines: a same-block S2/S3 result (the rival polls, no feed) never says the feed bought both bots the next round', () => {
  const sameBlockRival = { landed: { block: 10n, index: 1, tip: parseGwei('0.1') }, rank: 2 }
  const s2 = withBots('s2', {}, sameBlockRival)
  const j2 = judgeRace(s2)
  assert.equal(j2.verdict, 'INCONCLUSIVE')
  const w2 = whyLines(s2, j2).join('\n')
  assert.doesNotMatch(w2, /What the feed bought both bots/)
  assert.match(w2, /the poller's sighting was still in time for mine's round, so both claims were in the same round \(block 10\)/)
  const s3 = withBots('s3', {}, sameBlockRival)
  const j3 = judgeRace(s3)
  assert.deepEqual([j3.verdict, j3.effect], ['PASS', 'tip'])
  const w3 = whyLines(s3, j3).join('\n')
  assert.doesNotMatch(w3, /What the feed bought both bots/)
  assert.match(w3, /the poller's sighting was still in time/)
  // S1 (both on the feed) keeps the sentence.
  assert.match(whyLines(input(), judgeRace(input())).join('\n'), /What the feed bought both bots is the NEXT round \(block 10\)/)
})

test('whyLines: the poll delay is "at least" when the probe is the bound; "saw later" needs the rival to have seen it after mine', () => {
  const probe = withBots('s2', {}, {}, { visibleAt: 2100 })
  assert.match(whyLines(probe, judgeRace(probe)).join('\n'), /then added at least 200ms/)
  const bound = withBots('s2', {}, {}, { visibleAt: 2300 })
  assert.match(whyLines(bound, judgeRace(bound)).join('\n'), /then added no measurable time/)
  const early = withBots('s2', {}, { seenAt: 900 }, {})
  assert.doesNotMatch(whyLines(early, judgeRace(early)).join('\n'), /saw Opened later/)
})

test('timeline offsets are not clamped (an impossible order would show); --scenario constructor is a usage error; wrapText breaks long tokens', () => {
  const t = formatTimeline({ id: 7n, t0: 1000, openBlock: 9, visibleAt: 900, mine: bot('mine'), rival: bot('rival') })
  assert.match(t[0]!, /visible on RPC by t0\+-100ms/)
  assert.throws(() => parseRaceArgs(['--scenario', 'constructor']), ConfigError)
  assert.throws(() => parseRaceArgs(['--scenario', '__proto__']), ConfigError)
  const r = race(['--local', '--scenario', 'constructor'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Unknown scenario "constructor"/)
  const lines = wrapText(`ab ${'x'.repeat(25)} cd`, 10, '  ')
  assert.ok(lines.every((l) => l.length <= 10), lines.join('|'))
  assert.equal(lines.join('').replaceAll(' ', ''), `ab${'x'.repeat(25)}cd`)
})

test('matrix: a retried inconclusive trial counts once and is shown; a FAIL is shown, not retried', () => {
  const recs: TrialRecord[] = [...allWins(2).filter((r) => r.scenario !== 's2'), { ...rec('s2', 'PASS', 'information'), retried: true }, rec('s2', 'PASS', 'information')]
  const rows = summarizeMatrix(recs)
  assert.deepEqual([rows[1]!.wins, rows[1]!.trials], [2, 2])
  const mr = formatMatrix(rows, recs)
  const out = mr.notes.join('\n')
  assert.match(out, /retried once .*: S2 1/s)
  assert.doesNotMatch(formatMatrix(summarizeMatrix(allWins(2)), allWins(2)).notes.join('\n'), /retried/)
})

test('runTrialWithRetry: retries only an INCONCLUSIVE trial, at most once, never a PASS or a FAIL', async () => {
  const seq = (...verdicts: ('PASS' | 'FAIL' | 'INCONCLUSIVE')[]) => {
    let calls = 0
    const once = async () => ({ judgement: { verdict: verdicts[Math.min(calls++, verdicts.length - 1)]!, reason: `attempt ${calls}: why` } })
    return { once, calls: () => calls }
  }
  const retries: string[] = []
  const onRetry = (r: string) => retries.push(r)

  const pass = seq('PASS')
  assert.equal((await runTrialWithRetry(pass.once, onRetry)).retried, false)
  assert.equal(pass.calls(), 1)

  const fail = seq('FAIL', 'PASS')
  const f = await runTrialWithRetry(fail.once, onRetry)
  assert.deepEqual([fail.calls(), f.verdict, f.retried], [1, 'FAIL', false], 'a FAIL is never retried')
  assert.deepEqual(retries, [])

  const recovers = seq('INCONCLUSIVE', 'PASS')
  const r = await runTrialWithRetry(recovers.once, onRetry)
  assert.deepEqual([recovers.calls(), r.verdict, r.retried], [2, 'PASS', true])
  assert.deepEqual(retries, ['attempt 1: why'], 'onRetry gets the first attempt\'s reason')
  assert.match(r.reason, /after 1 retry/)

  const stuck = seq('INCONCLUSIVE', 'INCONCLUSIVE', 'PASS')
  const s = await runTrialWithRetry(stuck.once, onRetry)
  assert.deepEqual([stuck.calls(), s.verdict, s.retried], [2, 'INCONCLUSIVE', true], 'at most one retry')

  const failsAfter = seq('INCONCLUSIVE', 'FAIL')
  assert.equal((await runTrialWithRetry(failsAfter.once, onRetry)).verdict, 'FAIL')
})

test('wrapText: continuation lines never exceed the width, even for a token between width - indent and width', () => {
  // "ccccccc" (7) fits the width (10) but not after a 4-column indent: it must be split, not overflow.
  const lines = wrapText('aaaa bbbb ccccccc', 10, '    ')
  assert.ok(lines.every((l) => l.length <= 10), lines.join('|'))
  assert.equal(lines.join('').replaceAll(' ', ''), 'aaaabbbbccccccc')
  const long = wrapText(`${'y'.repeat(9)} ${'z'.repeat(30)}`, 12, '      ')
  assert.ok(long.every((l) => l.length <= 12), long.join('|'))
})

test('newIdentity: a given key is kept and hashed; the default key is random', () => {
  const given = newIdentity('mine', 0, 'abc'.repeat(21) + 'd')
  assert.equal(given.key, 'abc'.repeat(21) + 'd')
  assert.equal(given.keyHash, apiKeyHash(given.key))
  assert.notEqual(newIdentity('mine', 0).key, newIdentity('mine', 0).key)
})

test('judgeRace: a claim whose round could not be read (roundUnknown) is INCONCLUSIVE in every scenario, never a pass', () => {
  for (const scenario of ['s1', 's2', 's3'] as const) {
    const j = judgeRace(input({ scenario, mine: bot('mine', { landed: { block: 10n, index: 0, tip: parseGwei('0.1'), roundUnknown: true } }) }))
    assert.equal(j.verdict, 'INCONCLUSIVE', scenario)
    assert.match(j.reason, /round \(pga_round\) of the claim of mine could not be read .* rerun/)
  }
})

test('renewDecision with a 30s ticket round: renews inside the 25s a chapter needs, no sooner', () => {
  const roundEndMs = 130_000
  const base = { roundEndMs, coveredUntilMs: roundEndMs, trialMs: 25_000 }
  assert.equal(renewDecision({ ...base, nowMs: 100_500 }), 'no', '29.5s left')
  assert.equal(renewDecision({ ...base, nowMs: 106_000 }), 'renew', '24s left')
  assert.equal(renewDecision({ ...base, nowMs: 128_000 }), 'too-late', '2s left')
})

test('C5: B-aware renewal limits: identical to the constants at B = 2000, scaled with B when blocks are slow', () => {
  assert.equal(renewMinToBuyMs(2000), 3000)
  assert.equal(renewThresholdMs(2000), 15_000)
  assert.equal(renewMinToBuyMs(250), 3000)
  assert.equal(purchaseLandMs(2000, 4), 9000, 'a top-up (mint, approve, deposit, purchase) is 4 txs')
  // B = 2000 with blockMs given: the same decisions as without it.
  const base = { roundEndMs: 100_000, coveredUntilMs: 100_000, trialMs: 8_000, blockMs: 2000 }
  for (const [now, want] of [[60_000, 'no'], [84_000, 'no'], [86_000, 'renew'], [96_500, 'renew'], [97_500, 'too-late'], [99_999, 'too-late']] as const) {
    assert.equal(renewDecision({ ...base, nowMs: now }), want, `B=2000 now=${now}`)
    assert.equal(renewDecision({ ...base, blockMs: undefined, nowMs: now }), want)
  }
  // B = 8000 (32s round): a purchase needs 12s, and renewing starts with 32s left (4 x B).
  const b8 = { roundEndMs: 132_000, coveredUntilMs: 132_000, trialMs: 8_000, blockMs: 8000 }
  assert.equal(renewThresholdMs(8000), 32_000)
  assert.equal(renewDecision({ ...b8, nowMs: 110_000 }), 'renew', '22s left')
  assert.equal(renewDecision({ ...b8, nowMs: 119_000 }), 'renew', '13s left: still fits')
  assert.equal(renewDecision({ ...b8, nowMs: 121_000 }), 'too-late', '11s left: under 1.5 x B, rebuy for the next round')
  assert.equal(renewDecision({ ...b8, nowMs: 100_500 }), 'renew', '31.5s left: renew now')
  assert.equal(renewDecision({ ...b8, nowMs: 99_000 }), 'no', 'more than 4 x B left')
  assert.equal(renewDecision({ ...b8, coveredUntilMs: 164_000, nowMs: 125_000 }), 'no')
  // B = 25000 (100s round): 37.5s to land.
  const b25 = { roundEndMs: 200_000, coveredUntilMs: 200_000, trialMs: 12_000, blockMs: 25_000 }
  assert.equal(renewMinToBuyMs(25_000), 37_500)
  assert.equal(renewDecision({ ...b25, nowMs: 150_000 }), 'renew', '50s left')
  assert.equal(renewDecision({ ...b25, nowMs: 165_000 }), 'too-late', '35s left')
})

test('C5: judgeRace reports a real FAIL (rank mismatch, wrong winner) even when a claim\'s round is unknown', () => {
  const unk = { block: 10n, index: 1, tip: parseGwei('0.1'), roundUnknown: true }
  const j = judgeRace(input({ mine: bot('mine', { rank: 2, landed: unk }), rival: bot('rival', { rank: 1, landed: { block: 10n, index: 0, tip: parseGwei('0.001') } }) }))
  assert.equal(j.verdict, 'FAIL', 'winner(id) names mine, but rival has rank 1')
  assert.match(j.reason, /winner\(id\)/)
  const w = judgeRace(input({ mine: bot('mine', { landed: { block: 10n, index: 0, tip: parseGwei('0.1'), roundUnknown: true } }), winner: bot('rival').address }))
  assert.equal(w.verdict, 'FAIL', 'winner(id) disagrees with the ranks')
  assert.match(w.reason, /winner\(id\)/)
})

test('isTimelineVerdict: all three sibling verdict sentences (and only they) are NOTEs', () => {
  assert.ok(isTimelineVerdict('different rounds → the earlier round wins, whatever the tips'))
  assert.ok(isTimelineVerdict('same round → higher tip wins'))
  assert.ok(isTimelineVerdict('same round, but the stack orders by arrival (FIFO): the higher tip (mine) ranked first by arrival, the tip did not count'))
  assert.ok(isTimelineVerdict('same round, equal tips: arrival order decided'))
  assert.ok(!isTimelineVerdict('block 10: mine idx 0 (rank 1), rival idx 1 (rank 2)'))
  assert.ok(!isTimelineVerdict('rival sent at t0+2ms (tip 0.001 gwei)'))
})
