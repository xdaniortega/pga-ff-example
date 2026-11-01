// C3: the pure parts of `npm run demo` (argument parsing, chapters, the honest "why" line, --pause on a non-TTY stdin),
// plus the two refusals of the real entry point, which touch no network.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { parseGwei, type Address } from 'viem'
import { ConfigError } from '../../shared/config.ts'
import {
  CHAPTERS, PanelRenderer, chapterHeader, chapterNeedMs, clock, pauseTicketOutcome, demoExitCode, demoLiveOptions, FIFO_FAILURE, formatPauseTicketLine, rebuyReason, pauseBefore, PAUSE_IGNORED, parseDemoArgs, pgaRecapLine, postPauseTicketAction, takeawayLine, TESTNET_REFUSAL, USAGE, waitEnter, waitEnterKey, chapterDelayMs, demoCloseLines, enterDecision, promptPanelLines, keyLines, ticketSummaryLines, ticketRoundNoteLine, activationWaitLine, estimateActivationMs, pausedOverlapMs, retimeForPause, retimeThrough, SimHold, roundLeft, ticketNeedsRefresh, composeStoryPanel, armHoldAndWait, ACTIVATION_SKIP_OVER_MS, originAfterPauses, shouldFreezeAtPrompt, runPromptHold, type SimClockInfo,
} from '../demo.ts'
import { canSendInRound2, indexWithinRound, judgeRound2Injection, round2Plan } from '../demo.ts'
import { judgeRace, whyLine, type BotResult, type RaceInput } from '../scenarios.ts'

test('args: --local, --pause, --preset; one network flag is required; anything else is a usage error', () => {
  assert.deepEqual(parseDemoArgs(['--local']), { mode: 'local', pause: false })
  assert.deepEqual(parseDemoArgs(['--local', '--pause']), { mode: 'local', pause: true })
  assert.deepEqual(parseDemoArgs(['--pause', '--preset', 'fast', '--local']), { mode: 'local', pause: true })
  assert.deepEqual(parseDemoArgs(['--local', '--preset=slow']), { mode: 'local', pause: false })
  assert.deepEqual(parseDemoArgs(['--testnet']), { mode: 'testnet', pause: false })
  assert.throws(() => parseDemoArgs([]), ConfigError)
  assert.throws(() => parseDemoArgs(['--pause']), /Missing network flag/)
  assert.throws(() => parseDemoArgs(['--local', '--testnet']), /only one/)
  assert.throws(() => parseDemoArgs(['--local', '--bogus']), /Unknown argument "--bogus"/)
  assert.throws(() => parseDemoArgs(['--local', 'extra']), ConfigError)
})

test('the entry point: no network flag is usage (exit 2); --testnet is refused (exit 1) before touching anything', () => {
  // Ports that nothing listens on and no .env: a run that tried to start or reach a stack would fail differently.
  const env = { ...process.env, ENV_FILE: '/nonexistent-env-file', SIM_RPC_PORT: '1', SIM_FEED_PORT: '2', SIM_ANVIL_PORT: '3' }
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'combo/demo.ts', ...args], { env, encoding: 'utf8', timeout: 60_000 })
  const usage = run([])
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /Missing network flag/)
  assert.match(usage.stderr, /Usage: npm run demo -- --local \[--pause\]/)
  const bad = run(['--local', '--nope'])
  assert.equal(bad.status, 2)
  const testnet = run(['--testnet'])
  assert.equal(testnet.status, 1)
  assert.ok(testnet.stderr.includes(TESTNET_REFUSAL), testnet.stderr)
  assert.match(testnet.stderr, /the testnet demo is the testnet stage \(C4\): needs funded wallets, TEST tickets and `race:deploy -- --testnet`/)
  assert.equal(testnet.stdout, '', 'nothing was run')
  assert.match(USAGE, /--pause/)
})

test('chapters: six, numbered 1..6 in order, each header names its number, title and one doc section', () => {
  assert.deepEqual(CHAPTERS.map((c) => c.n), [1, 2, 3, 4, 5, 6])
  assert.match(CHAPTERS[0]!.title, /accelerated/)
  assert.match(CHAPTERS[3]!.title, /One block, two rounds: your tip goes first/)
  assert.match(CHAPTERS[4]!.title, /race/i)
  assert.match(CHAPTERS[5]!.title, /Recap/)
  for (const c of CHAPTERS) {
    const h = chapterHeader(c)
    assert.ok(h.some((l) => l === `▶ CHAPTER ${c.n}/6: ${c.title}`), h.join('|'))
    assert.ok(h.some((l) => l.includes(`Read more: ${c.doc}`)))
    assert.match(c.doc, /^((sim|fast-feed|pga|combo)\/README\.md|docs\/[\w-]+\.md|README\.md)(#[\w-]+)?$/)
  }
})

const bot = (name: 'mine' | 'rival', over: Partial<BotResult> = {}): BotResult => ({
  name,
  address: (name === 'mine' ? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' : '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC') as Address,
  via: name === 'rival' ? 'poll' : 'feed',
  seenAt: name === 'mine' ? 1000 : 3100,
  sentAt: name === 'mine' ? 1002 : 3102,
  landed: name === 'mine' ? { block: 17n, index: 0, tip: parseGwei('0.2') } : { block: 18n, index: 0, tip: parseGwei('0.1') },
  rank: name === 'mine' ? 1 : 2,
  ...over,
})
const s3 = (over: Partial<RaceInput> = {}, mine: Partial<BotResult> = {}, rival: Partial<BotResult> = {}): RaceInput => ({
  scenario: 's3', ordering: 'pga', id: 7n, expectedWinner: 'mine', mine: bot('mine', mine), rival: bot('rival', rival),
  winner: bot('mine').address, openBlock: 16, visibleAt: 3000, pollMs: 250, ...over,
})

test('whyLine S3 both: information got us into the earlier round AND our higher tip also won', () => {
  const i = s3()
  const j = judgeRace(i)
  assert.equal(j.effect, 'both')
  assert.equal(
    whyLine(i, j),
    "Mine: rank 1. Why: Fast Feed got us into block 17 (rival polled, arrived in block 18); our tip 0.2 also beat the rival's 0.1 (we'd also win a same-round tie).",
  )
})

test('whyLine S3 information only: it never credits a tip that was not observed to count', () => {
  const fifo = s3({ ordering: 'fifo' })
  const jf = judgeRace(fifo)
  assert.equal(jf.effect, 'information')
  const lf = whyLine(fifo, jf)
  assert.match(lf, /^Mine: rank 1\. Why: Fast Feed got us into block 17 \(rival polled, arrived in block 18\); this stack orders by arrival \(FIFO\), so a tip would not have counted\.$/)
  assert.doesNotMatch(lf, /same-round tie|also beat/)
  // PGA stack, but mine did not out-tip the rival: only information.
  const low = s3({}, { landed: { block: 17n, index: 0, tip: parseGwei('0.05') } })
  const jl = judgeRace(low)
  assert.equal(jl.effect, 'information')
  const ll = whyLine(low, jl)
  assert.match(ll, /our tip 0\.05 did not beat the rival's 0\.1, so information alone decided/)
  assert.doesNotMatch(ll, /same-round tie/)
})

test('whyLine S3 same round (tip only): says the tip decided and that information did not', () => {
  const i = s3({}, {}, { landed: { block: 17n, index: 1, tip: parseGwei('0.1') }, rank: 2 })
  const j = judgeRace(i)
  assert.equal(j.effect, 'tip')
  assert.equal(whyLine(i, j), "Mine: rank 1. Why: both claims landed in block 17, so our tip 0.2 beat the rival's 0.1; information did not decide.")
})

test('whyLine inconclusive / failed / missing: states what is not established, never a win', () => {
  const fifoSame = s3({ ordering: 'fifo' }, {}, { landed: { block: 17n, index: 1, tip: parseGwei('0.1') }, rank: 2 })
  const ji = judgeRace(fifoSame)
  assert.equal(ji.verdict, 'INCONCLUSIVE')
  const li = whyLine(fifoSame, ji)
  assert.match(li, /^Mine: rank 1\. Why: not established \(inconclusive\): /)
  assert.doesNotMatch(li, /got us into|beat the rival/)
  const lost = s3({ winner: bot('rival').address }, { rank: 2, landed: { block: 18n, index: 1, tip: parseGwei('0.2') } }, { rank: 1, landed: { block: 18n, index: 0, tip: parseGwei('0.1') } })
  const jl = judgeRace(lost)
  assert.equal(jl.verdict, 'FAIL')
  assert.match(whyLine(lost, jl), /^Mine: rank 2\. Why: FAIL: /)
  assert.match(whyLine(undefined, undefined), /^Mine: no result\. Why: the race did not complete/)
})

test('exit codes: 1 when any chapter failed, 3 when only the race was inconclusive, else 0', () => {
  assert.equal(demoExitCode([], 'PASS'), 0)
  assert.equal(demoExitCode([], 'INCONCLUSIVE'), 3)
  assert.equal(demoExitCode([{ chapter: 4, what: 'x' }], 'PASS'), 1, 'a failed block story (old chapter 5 semantics)')
  assert.equal(demoExitCode([{ chapter: 4, what: 'x' }], 'INCONCLUSIVE'), 1, 'a failure outranks an inconclusive race')
  assert.equal(demoExitCode([{ chapter: 5, what: 'x' }], 'FAIL'), 1)
})

test('--pause waits for Enter on a terminal, and never on a non-TTY stdin (it must not hang)', async () => {
  const said: string[] = []
  let waits = 0
  const o = (pause: boolean, isTTY: boolean) => ({ pause, isTTY, waitEnter: async () => void waits++, say: (l: string) => void said.push(l) })
  assert.equal(await pauseBefore(o(true, true), CHAPTERS[1]!), true)
  assert.equal(waits, 1)
  assert.match(said[0]!, /press Enter for chapter 2\/6/)
  assert.equal(await pauseBefore(o(true, false), CHAPTERS[2]!), false, 'not a TTY: no wait')
  assert.equal(await pauseBefore(o(false, true), CHAPTERS[2]!), false, 'no --pause: no wait')
  assert.equal(waits, 1)
  // A waitEnter that never resolves would hang the test if the non-TTY path called it.
  const never = { pause: true, isTTY: false, waitEnter: () => new Promise<void>(() => {}), say: () => {} }
  assert.equal(await pauseBefore(never, CHAPTERS[3]!), false)
  assert.match(PAUSE_IGNORED, /stdin is not a terminal/)
})

test('waitEnter: a line resolves it, and so does the end of the input (a closed stdin never hangs)', async () => {
  const withLine = new PassThrough()
  const p1 = waitEnter(withLine)
  withLine.write('\n')
  await p1
  const closed = new PassThrough()
  const p2 = waitEnter(closed)
  closed.end()
  await p2
})

test('whyLine: information is credited only when mine was in the earlier block and the rival learned of Opened later', () => {
  const late = s3({}, { seenAt: 5000 }) // mine saw it AFTER the rival: no information credit
  const j = judgeRace(late)
  const l = whyLine(late, j)
  assert.doesNotMatch(l, /got us into|same-round tie/)
  assert.match(l, /^Mine: rank 1\. Why: /)
})

test('postPauseTicketAction: ok while covered, renew near the end of the last round, rebuy when expired or too late', () => {
  const roundMs = 20_000
  const session = { activeFrom: 100_000, activeUntil: 140_000 } // two ticket rounds
  const act = (nowMs: number, s: typeof session | undefined = session, needMs = 15_000) => postPauseTicketAction({ session: s, nowMs, roundMs, needMs })
  assert.equal(act(101_000), 'ok', 'round 1, the next round is already covered')
  assert.equal(act(125_000), 'ok', 'round 2 with exactly the 15s threshold left')
  assert.equal(act(130_000), 'renew', 'round 2, 10s left: not enough for the next chapter, but time to renew')
  assert.equal(act(138_500), 'rebuy', 'under 3s left: a purchase would land too late')
  assert.equal(act(141_000), 'rebuy', 'the tickets ran out while paused')
  assert.equal(postPauseTicketAction({ session: undefined, nowMs: 110_000, roundMs, needMs: 15_000 }), 'rebuy', 'no session')
  assert.equal(act(130_000, { activeFrom: 100_000, activeUntil: 160_000 }), 'ok', 'a longer cover is not renewed')
})

test('demoLiveOptions: the live view\'s periodic PGA footer is off (the demo prints its own, only on a PGA stack)', () => {
  const o = demoLiveOptions({ rpcUrl: 'http://127.0.0.1:1', mine: new Set(), bold: false })
  assert.equal(o.footerEvery, 0)
  assert.equal(o.rpcUrl, 'http://127.0.0.1:1')
})

test('pgaRecapLine: credits PGA only when observed; FIFO and a failed chapter 4 each say why not', () => {
  const base = { tipGwei: '1', trafficTipMax: '0.05' }
  const ok = pgaRecapLine({ ...base, observed: true, ordering: 'pga' })
  assert.match(ok, /^It sorted round 2 by tip: our 1 gwei transaction, sent after we saw round 1, was first in round 2 of its block, ahead of the lower-tip competitors \(up to 0\.05 gwei\) that arrived before it\./)
  const fifo = pgaRecapLine({ ...base, observed: false, ordering: 'fifo', failure: 'ignored' })
  assert.match(fifo, /^Not observed: this stack orders by arrival \(FIFO\)/)
  assert.doesNotMatch(fifo, /sorted/)
  const idx = judgeRound2Injection({ ordering: 'pga', targetBlock: 14, block: 14, round: 2, indexInRound: 3, competitors: 4, leadMs: 5, tipGwei: '1' })
  const li = pgaRecapLine({ ...base, observed: idx.observed, ordering: 'pga', failure: idx.failure })
  assert.match(li, /^Not observed in this run: our 1 gwei transaction is at index 3, not index 0/)
  assert.match(pgaRecapLine({ ...base, observed: false, ordering: 'pga' }), /^Not observed in this run: chapter 4 did not complete/)
})

test('takeawayLine: an observation only when it was observed; otherwise labelled as the idea', () => {
  assert.match(takeawayLine(true), /^Information gets you into the round; the tip wins the round\. Docs: /)
  assert.match(takeawayLine(false), /^The idea \(not fully observed in this run\): Information gets you into the round; the tip wins the round\. Docs: /)
})

test('B6b: whyLine names block AND pga_round, and information is credited by (block, round), not by block alone', () => {
  const L = (block: bigint, pgaRound: number, index: number, tip: string) => ({ block, pgaRound, index, tip: parseGwei(tip) })
  const bot = (name: 'mine' | 'rival', over: Record<string, unknown>) => ({ name, address: '0x0000000000000000000000000000000000000001', seenAt: name === 'mine' ? 1000 : 3000, sentAt: 1001, rank: name === 'mine' ? 1 : 2, ...over }) as never
  const base = { scenario: 's3', ordering: 'pga', id: 1n, expectedWinner: 'mine', winner: '0x0000000000000000000000000000000000000001' } as const
  // mine in round 2 of block 17, the rival polled and arrived in round 1 of block 18
  const i = { ...base, mine: bot('mine', { landed: L(17n, 2, 1, '0.2') }), rival: bot('rival', { via: 'poll', landed: L(18n, 1, 0, '0.1') }) } as never
  assert.equal(
    whyLine(i, { verdict: 'PASS', reason: 'x', effect: 'both' }),
    "Mine: rank 1. Why: Fast Feed got us into block 17 round 2 (rival polled, arrived in block 18 round 1); our tip 0.2 also beat the rival's 0.1 (we'd also win a same-round tie).",
  )
  // same block, different rounds: mine in round 1, the rival in round 2 of the SAME block is still "earlier"
  const same = { ...base, mine: bot('mine', { landed: L(17n, 1, 0, '0.2') }), rival: bot('rival', { via: 'poll', landed: L(17n, 2, 1, '0.1') }) } as never
  assert.match(whyLine(same, { verdict: 'PASS', reason: 'x', effect: 'information' }), /got us into block 17 round 1 \(rival polled, arrived in block 17 round 2\)/)
})

test('B6b: chapter 4 judges the position within the round, not the block-wide tx_index', () => {
  const round2 = [{ txIndex: 3 }, { txIndex: 4 }, { txIndex: 5 }] // round 1 of the block held tx_index 0..2
  assert.equal(indexWithinRound(round2, round2[0]!), 0)
  assert.equal(indexWithinRound(round2, round2[2]!), 2)
})

test('formatPauseTicketLine: time left in the ticket round, then kept / renewed / rebought (with why)', () => {
  const f = (outcome: Parameters<typeof formatPauseTicketLine>[0]['outcome'], leftMs = 11_200) => formatPauseTicketLine({ round: 7, leftMs, outcome })
  assert.equal(f({ kind: 'kept' }), 'ticket round 7: 12s left · ticket kept')
  assert.equal(f({ kind: 'renewed', nextRound: 8 }), 'ticket round 7: 12s left · ticket renewed for round 8')
  assert.equal(f({ kind: 'rebought', why: 'expired' }), 'ticket round 7: 12s left · ticket rebought (expired during the pause)')
  assert.match(f({ kind: 'rebought', why: 'too-late' }), /too little of the round was left to renew/)
  assert.match(f({ kind: 'rebought', why: 'renewal-missed' }), /renewal did not land/)
  assert.match(f({ kind: 'none' }, -5), /^ticket round 7: 0s left · no ticket yet/)
  assert.match(f({ kind: 'expired' }), /expired \(not needed again\)/)
})

test('rebuyReason and postPauseTicketAction with the 30s local ticket round', () => {
  const roundMs = 30_000
  const s = { activeFrom: 100_000, activeUntil: 130_000 } // one round
  assert.equal(rebuyReason(undefined, 110_000), 'no-ticket')
  assert.equal(rebuyReason(s, 131_000), 'expired')
  assert.equal(rebuyReason(s, 128_500), 'too-late')
  const act = (nowMs: number, needMs = 25_000) => postPauseTicketAction({ session: s, nowMs, roundMs, needMs })
  assert.equal(act(101_000, 15_000), 'ok', '29s left covers a 15s need')
  assert.equal(act(106_000), 'renew', '24s left < the 25s chapter 4 needs')
  assert.equal(act(128_000), 'rebuy', '2s left: a purchase would land too late')
  assert.equal(act(131_000), 'rebuy', 'expired during the pause')
})

test('C5/E3: chapterNeedMs is 25/15s (block story, race) at B = 2000 and scales with B, capped at one ticket round; the recap needs none', () => {
  assert.deepEqual([4, 5, 6].map((c) => chapterNeedMs(c, 2000, 30_000)), [25_000, 15_000, 0])
  assert.deepEqual([4, 5, 6].map((c) => chapterNeedMs(c, 250, 30_000)), [25_000, 15_000, 0])
  assert.equal(chapterNeedMs(4, 2000, 20_000), 20_000, 'capped at the round')
  assert.deepEqual([4, 5].map((c) => chapterNeedMs(c, 8000, 32_000)), [32_000, 32_000])
  assert.equal(chapterNeedMs(5, 8000, 100_000), 60_000)
  assert.equal(chapterNeedMs(2, 8000, 32_000), 0)
})

test('C5: postPauseTicketAction with B = 8000 (32s round): rebuy when a renewal cannot land (under 12s), renew before that', () => {
  const roundMs = 32_000
  const s = { activeFrom: 100_000, activeUntil: 132_000 }
  const act = (nowMs: number) => postPauseTicketAction({ session: s, nowMs, roundMs, needMs: chapterNeedMs(5, 8000, roundMs), blockMs: 8000 })
  assert.equal(act(105_000), 'renew', '27s left < the 32s a chapter needs')
  assert.equal(act(119_000), 'renew', '13s left: a 12s purchase still fits')
  assert.equal(act(121_000), 'rebuy', '11s left: it would land in the wrong round')
  // At B = 2000 the same call gives the old answer (3s limit).
  assert.equal(postPauseTicketAction({ session: { activeFrom: 100_000, activeUntil: 130_000 }, nowMs: 128_000, roundMs: 30_000, needMs: 25_000, blockMs: 2000 }), 'rebuy')
  assert.equal(postPauseTicketAction({ session: { activeFrom: 100_000, activeUntil: 130_000 }, nowMs: 125_000, roundMs: 30_000, needMs: 25_000, blockMs: 2000 }), 'renew')
})

test('C5: pauseTicketOutcome maps the action taken to the outcome line', () => {
  const o = (action: 'ok' | 'renew' | 'rebuy', renewed: boolean, why: 'expired' | 'too-late' | 'no-ticket' = 'expired') => pauseTicketOutcome({ action, renewed, why, nextRound: 8 })
  assert.deepEqual(o('ok', false), { kind: 'kept' })
  assert.deepEqual(o('renew', true), { kind: 'renewed', nextRound: 8 })
  assert.deepEqual(o('renew', false), { kind: 'rebought', why: 'renewal-missed' }, 'renewal tried and missed, then rebought')
  assert.deepEqual(o('rebuy', false, 'too-late'), { kind: 'rebought', why: 'too-late' })
  assert.deepEqual(o('rebuy', false, 'expired'), { kind: 'rebought', why: 'expired' })
  assert.deepEqual(o('rebuy', false, 'no-ticket'), { kind: 'rebought', why: 'no-ticket' })
})

test('C5: clock prints UTC like fmtWhen and the live header', () => {
  assert.equal(clock(Date.UTC(2026, 9, 28, 14, 9, 29, 500)), '14:09:29Z')
  assert.equal(clock(0), '00:00:00Z')
})

test('formatPauseTicketLine: a hands-off delay never says the user paused', () => {
  const o = { kind: 'rebought' as const, why: 'expired' as const }
  assert.match(formatPauseTicketLine({ round: 1, leftMs: 5000, outcome: o }), /expired during the pause/)
  assert.match(formatPauseTicketLine({ round: 1, leftMs: 5000, outcome: o, realPause: false }), /expired since the last chapter/)
})

test('chapterDelayMs: 3s on a TTY without --pause (or --pause with a non-TTY stdin), 0 on a non-TTY or with --pause on a TTY stdin, DEMO_CHAPTER_DELAY_MS overrides', () => {
  assert.equal(chapterDelayMs(true, false, {}), 3000)
  assert.equal(chapterDelayMs(false, false, {}), 0, 'never on a non-TTY: tests and CI stay fast')
  assert.equal(chapterDelayMs(true, true, {}), 0, '--pause on a TTY stdin: Enter is the pause')
  assert.equal(chapterDelayMs(true, true, {}, true), 0)
  assert.equal(chapterDelayMs(true, true, {}, false), 3000, '--pause but stdin is not a TTY and stdout is: the timed delay')
  assert.equal(chapterDelayMs(false, true, {}, false), 0, 'nothing on a non-TTY stdout')
  assert.equal(chapterDelayMs(false, true, {}), 0)
  assert.equal(chapterDelayMs(true, false, { DEMO_CHAPTER_DELAY_MS: '500' }), 500)
  assert.equal(chapterDelayMs(true, false, { DEMO_CHAPTER_DELAY_MS: '0' }), 0, '0 disables')
  assert.equal(chapterDelayMs(false, false, { DEMO_CHAPTER_DELAY_MS: '1200' }), 1200, 'the override also applies off a TTY')
  assert.equal(chapterDelayMs(true, true, { DEMO_CHAPTER_DELAY_MS: '700' }), 700)
  assert.equal(chapterDelayMs(true, false, { DEMO_CHAPTER_DELAY_MS: '' }), 3000, 'empty counts as unset')
  for (const bad of ['abc', '-1', '1.5', '3s']) assert.throws(() => chapterDelayMs(true, false, { DEMO_CHAPTER_DELAY_MS: bad }), /DEMO_CHAPTER_DELAY_MS/, bad)
})

test('C8: round2Plan scales the gap and the needed time with the round; canSendInRound2 needs the same block, round 2 and enough time', () => {
  assert.deepEqual(round2Plan(1000), { competitors: 2, gapMs: 83, needMs: 416 })
  assert.deepEqual(round2Plan(12_500), { competitors: 3, gapMs: 400, needMs: 1500 })
  const info = { block: 7, round: 2, roundStartMs: 10_000, roundMs: 1000 }
  assert.equal(canSendInRound2(info, 7, 10_300, 416), true)
  assert.equal(canSendInRound2(info, 7, 10_700, 416), false, 'too little of round 2 is left')
  assert.equal(canSendInRound2(info, 8, 10_300, 416), false, 'another block')
  assert.equal(canSendInRound2({ ...info, round: 1 }, 7, 10_300, 416), false, 'round 1')
})

/** A fake TTY: a PassThrough with `isTTY` and a `setRawMode` spy. */
function fakeTty(withRaw = true) {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & { raw: boolean[] }
  input.raw = []
  ;(input as { isTTY: boolean }).isTTY = true
  if (withRaw) (input as { setRawMode: unknown }).setRawMode = (m: boolean) => (input.raw.push(m), input)
  return input
}

test('waitEnterKey: Enter restores raw mode and resolves; no signal is raised', async () => {
  const input = fakeTty()
  const signals: string[] = []
  const p = waitEnterKey(input, (s) => void signals.push(s))
  assert.deepEqual(input.raw, [true])
  input.write('\r')
  await p
  assert.deepEqual(input.raw, [true, false])
  assert.deepEqual(signals, [])
  assert.equal(input.listenerCount('data'), 0)
})

test('waitEnterKey: Ctrl-C and Ctrl-D restore raw mode and raise SIGINT; the promise stays pending', async () => {
  for (const key of ['\x03', '\x04']) {
    const input = fakeTty()
    const signals: string[] = []
    let settled = false
    void waitEnterKey(input, (s) => void signals.push(s)).then(() => (settled = true))
    input.write(key)
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(input.raw, [true, false])
    assert.deepEqual(signals, ['SIGINT'])
    assert.equal(settled, false)
  }
})

test('waitEnterKey: a non-TTY (or no setRawMode) falls back to the line wait and never touches raw mode', async () => {
  const input = fakeTty()
  ;(input as { isTTY: boolean }).isTTY = false
  const p = waitEnterKey(input, () => assert.fail('no signal'))
  input.write('\n')
  await p
  assert.deepEqual(input.raw, [])
  const noRaw = fakeTty(false)
  const q = waitEnterKey(noRaw, () => assert.fail('no signal'))
  noRaw.end() // EOF resolves the line wait
  await q
})

test('Q1 demoCloseLines: 1008 is explained in demo terms (no tickets:buy), other codes as the CLI does', () => {
  const l = demoCloseLines(1008, 'authentication expired')
  assert.equal(l.length, 1)
  assert.match(l[0]!, /^NOTE: .*ticket expired.*buys a new ticket and reconnects by itself/)
  assert.ok(!l.join('\n').includes('tickets:buy'))
  assert.match(demoCloseLines(1011, 'bye')[0]!, /^closed 1011/)
})

test('Q2 enterDecision: send at once when round 2 of the target has time left, else wait for the next target (never "too late")', () => {
  const info = { block: 7, round: 2, roundStartMs: 10_000, roundMs: 12_500 } // slow motion
  assert.equal(enterDecision(info, 7, 11_000, 1_000), 'send')
  assert.equal(enterDecision(info, 7, 22_000, 1_000), 'next', 'round 2 nearly over')
  assert.equal(enterDecision({ ...info, round: 1 }, 7, 11_000, 1_000), 'next', 'still round 1')
  assert.equal(enterDecision({ ...info, block: 8 }, 7, 11_000, 1_000), 'next', 'the target block has closed')
  assert.equal(enterDecision({ block: 7, round: 2, roundStartMs: 10_000, roundMs: 1000 }, 7, 10_900, 500), 'next', 'a 1 s round: Enter after ~1 s')
})

test('Q3 promptPanelLines: short rounds name no block; slow rounds name the current target', () => {
  assert.deepEqual(promptPanelLines('Press Enter', undefined).map((l) => l.kind), ['important'])
  const l = promptPanelLines('Press Enter', 14)
  assert.equal(l[0]!.text, 'NOTE: block 14 is open; the Fast Feed already shows its round 1.')
  assert.equal(l[1]!.text, 'Press Enter')
})

test('E1: chapter 2 has no key:new note and never shows the raw key; chapter 3 summarises the ticket without tx or block lines', () => {
  const hash = '0x' + 'ab'.repeat(32)
  const key = keyLines(false, hash).join('\n')
  assert.doesNotMatch(key, /key:new|\.env/)
  assert.ok(key.includes(hash))
  const sum = ticketSummaryLines({ keyHash: hash, round: 3, renewed: true, activeFrom: 1_000_000, activeUntil: 1_030_000 })
  const text = sum.join('\n')
  assert.doesNotMatch(text, /mined in block|==> tx 0x|approve the Tickets|mint 12/)
  assert.ok(sum.length <= 2 && sum[0]!.startsWith('==> ticket bought for our key hash ' + hash + ' in ticket round 3'))
  assert.match(ticketSummaryLines({ keyHash: hash, round: 3, renewed: false, activeFrom: 1, activeUntil: 2 })[1]!, /renewal did not land/)
})

test('E1: chapter 3 explains the ticket round against 24h and prints a waiting line only above 20 s', () => {
  const n = ticketRoundNoteLine(30)
  assert.match(n, /^NOTE: LOCAL: a ticket round is 30s here instead of 24h on Arbitrum One/)
  assert.equal(activationWaitLine(20_000), undefined)
  assert.equal(activationWaitLine(5_000), undefined)
  assert.equal(activationWaitLine(20_001), '==> waiting ~21s for the ticket to activate')
})

test('E1 review: the ticket-round NOTE is relative to 24h and never calls a long wait short', () => {
  for (const n of [30, 100]) {
    const l = ticketRoundNoteLine(n)
    assert.ok(l.includes(`${n}s here instead of 24h`) && !/short/.test(l), l)
  }
})

test('E1 review: waiting estimate lands in the next round when too little of this one is left; upper-bound wording before the purchase lands', () => {
  const round = 100_000
  const block = 25_000
  // 90 s left, buying starts after 3 blocks (75 s), 15 s left < minRoundLeftS: the purchase lands in the NEXT round.
  assert.equal(estimateActivationMs(190_000, 100_000, round, block), 290_000)
  // plenty left: this round's end
  assert.equal(estimateActivationMs(300_000, 100_000, round, 2000), 300_000)
  assert.equal(activationWaitLine(60_000, true), '==> waiting for the ticket purchase to land and activate (up to ~60s)')
  assert.equal(activationWaitLine(10_000, true), undefined)
})

test('E1 review: the failure after 4 attempts names the last rejection and keeps it as cause', async () => {
  const { buyFailure } = await import('../race.ts')
  const reason = new Error('boom: purchase rejected')
  const e = buyFailure(reason)
  assert.match(e.message, /after 4 attempts\. Last error: .*boom/)
  assert.equal(e.cause, reason)
  assert.doesNotMatch(buyFailure(undefined).message, /Last error/)
  // E2 review (iii): a reason that already ends with "." is not followed by another one
  const dotted = buyFailure(new Error('the round ended.'))
  assert.doesNotMatch(dotted.message, /\.\./)
  assert.match(dotted.message, /Last error: .*\. Rerun/)
})

// ---------------------------------------------------------------------------
// E2: pausing the simulator at the Enter prompts
// ---------------------------------------------------------------------------

test('E2 pausedOverlapMs: spans are clipped to the window; an open span runs to the window end', () => {
  const spans = [{ from: 100, to: 200 }, { from: 300, to: 400 }, { from: 500 }]
  assert.equal(pausedOverlapMs(spans, 0, 1000), 100 + 100 + 500)
  assert.equal(pausedOverlapMs(spans, 150, 350), 50 + 50)
  assert.equal(pausedOverlapMs(spans, 0, 50), 0)
  assert.equal(pausedOverlapMs(spans, 450, 600), 100, 'an open span counts up to the window end')
})

test('E2 retime: a time before a pause moves later by what is left of it; a time after is unchanged; a time inside collapses to the end', () => {
  const f = retimeForPause({ from: 1000, to: 1600 })
  assert.equal(f(900), 1500)
  assert.equal(f(1000), 1600)
  assert.equal(f(1200), 1600)
  assert.equal(f(1700), 1700)
  const spans = [{ from: 1000, to: 1600 }, { from: 5000, to: 5300 }]
  assert.equal(retimeThrough(spans, 900), 900 + 600 + 300, 'seen through both pauses')
  assert.equal(retimeThrough(spans, 2000), 2300)
  assert.equal(retimeThrough(spans, 6000), 6000)
  // a row received before a 600 ms pause and a block seen after it: the lead no longer contains the pause
  assert.equal(2000 - retimeThrough([{ from: 1000, to: 1600 }], 900), 500)
})

test('E2 roundLeft / canSendInRound2: the simulator\'s own figure wins (it stands still while paused); the wall-clock estimate is the fallback', () => {
  const base = { block: 5, round: 2, roundStartMs: 1000, roundMs: 12_500 }
  assert.equal(roundLeft({ ...base }, 1000 + 2500), 10_000)
  assert.equal(roundLeft({ ...base, roundLeftMs: 7000 }, 1000 + 2500), 7000)
  // a long pause makes the wall-clock estimate negative; the sim figure still says there is time
  assert.equal(canSendInRound2({ ...base }, 5, 1000 + 600_000, 500), false)
  assert.equal(canSendInRound2({ ...base, roundLeftMs: 7000 }, 5, 1000 + 600_000, 500), true)
  assert.equal(enterDecision({ ...base, roundLeftMs: 7000 }, 5, 1000 + 600_000, 500), 'send')
})

test('E2 SimHold: pauses with a heartbeat, resumes with the same holder, and reports a refused or missing pause instead of throwing', async () => {
  const calls: { method: string; params: unknown[] }[] = []
  const info = { paused: true, holder: 'demo-1', chainNowMs: 123 } as unknown as SimClockInfo
  const ok = new SimHold(async <T,>(method: string, params: unknown[] = []) => {
    calls.push({ method, params })
    return (method === 'sim_resume' ? { resumed: true, pausedMs: 42, chainNowMs: 124 } : info) as T
  }, 'demo-1', 60)
  const got = await ok.acquire()
  assert.equal(got.state, 'paused')
  assert.deepEqual(calls[0], { method: 'sim_pause', params: [{ holder: 'demo-1', at: 'now', leaseMs: 60 }] })
  await new Promise((r) => setTimeout(r, 130))
  assert.ok(calls.filter((c) => c.method === 'sim_pause').length >= 3, 'a heartbeat every lease/3')
  const r = await ok.release()
  assert.equal(r?.chainNowMs, 124)
  assert.deepEqual(calls.at(-1), { method: 'sim_resume', params: [{ holder: 'demo-1' }] })
  const n = calls.length
  await new Promise((r2) => setTimeout(r2, 100))
  assert.equal(calls.length, n, 'no heartbeat after the release')
  assert.equal(await ok.release(), undefined, 'releasing twice sends nothing')

  const refused = await new SimHold(async () => { throw new Error('sim_pause: paused by demo-99') }, 'demo-1').acquire()
  assert.equal(refused.state, 'refused')
  const missing = await new SimHold(async () => { throw new Error('sim_pause: the method sim_pause does not exist') }, 'demo-1').acquire()
  assert.equal(missing.state, 'unsupported')
})

test('E2 ticketNeedsRefresh: chapters 4-5 refresh when the ticket is about to run out, whatever the pause state; other chapters never', () => {
  const roundMs = 30_000
  const blockMs = 2000
  const session = { activeFrom: 0, activeUntil: 30_000 }
  assert.equal(ticketNeedsRefresh({ session, nowMs: 6_000, roundMs, blockMs, chapter: 4 }), true, '24s left needs more than the ticket holds')
  assert.equal(ticketNeedsRefresh({ session: { activeFrom: 0, activeUntil: 90_000 }, nowMs: 5_000, roundMs, blockMs, chapter: 4 }), false, 'already renewed for the next round')
  assert.equal(ticketNeedsRefresh({ session, nowMs: 5_000, roundMs, blockMs, chapter: 6 }), false)
  assert.equal(ticketNeedsRefresh({ session, nowMs: 5_000, roundMs, blockMs, chapter: 3 }), false)
  assert.equal(ticketNeedsRefresh({ session: undefined, nowMs: 5_000, roundMs, blockMs, chapter: 5 }), true)
})

test('E2: chapter 3 skips the clock only above 20 s of activation wait', () => {
  assert.equal(ACTIVATION_SKIP_OVER_MS, 20_000)
})

test('E2 originAfterPauses: a pause that ended before the measurement leaves the origin alone; one after it moves the origin with the retimed rows', () => {
  const origin = 100_000 // measured at 101_000, block started 1 s earlier
  assert.equal(originAfterPauses(origin, 101_000, [{ from: 50_000, to: 90_000 }]), origin, 'the pause ended before the block started: nothing to correct')
  assert.equal(originAfterPauses(origin, 101_000, [{ from: 102_000, to: 104_500 }]), origin + 2_500, 'a pause inside the block (after the measurement) moves the origin by its length')
  // a row received at 100_500 (before that pause) is retimed to 103_000: its offset from the origin stays 500 ms
  const row = retimeThrough([{ from: 102_000, to: 104_500 }], 100_500)
  assert.equal(row - originAfterPauses(origin, 101_000, [{ from: 102_000, to: 104_500 }]), 500 + 0, 'offset of a pre-pause row is unchanged')
  assert.equal(originAfterPauses(origin, 101_000, [{ from: 50_000, to: 90_000 }, { from: 102_000, to: 103_000 }, { from: 110_000, to: 111_000 }]), origin + 2_000, 'only the pauses after the measurement count')
})

test('E2 shouldFreezeAtPrompt: a prompt never freezes the simulator while the background ticket purchase is in flight', () => {
  assert.equal(shouldFreezeAtPrompt({ hasBackgroundTicket: true, backgroundSettled: false }), false)
  assert.equal(shouldFreezeAtPrompt({ hasBackgroundTicket: true, backgroundSettled: true }), true)
  assert.equal(shouldFreezeAtPrompt({ hasBackgroundTicket: false, backgroundSettled: false }), true, 'nothing in flight')
})

test('E2 SimHold: heartbeats are lease-only (heartbeat flag, no `at`), and release waits for a heartbeat in flight before it resumes', async () => {
  const order: string[] = []
  let releaseBeat!: () => void
  const slowBeat = new Promise<void>((r) => (releaseBeat = r))
  const hold = new SimHold(async <T,>(method: string, params: unknown[] = []) => {
    const a = params[0] as { heartbeat?: boolean; at?: string }
    if (method === 'sim_pause' && a.heartbeat) {
      assert.equal(a.at, undefined, 'a heartbeat never carries `at`: it cannot start a pause or turn afterRound1 into one')
      order.push('beat-start')
      await slowBeat
      order.push('beat-end')
    } else order.push(method)
    return ({ resumed: true, pausedMs: 1, chainNowMs: 1 }) as T
  }, 'h', 30)
  await hold.acquire()
  await new Promise((r) => setTimeout(r, 40)) // a heartbeat is now in flight (blocked)
  const rel = hold.release()
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(!order.includes('sim_resume'), 'the resume waits for the heartbeat')
  releaseBeat()
  await rel
  assert.deepEqual(order.filter((o) => o !== 'sim_pause').slice(0, 3), ['beat-start', 'beat-end', 'sim_resume'])
})

test('E2 runPromptHold: a prompt that opens while the purchase is in flight acquires the hold when it settles, and releases it after Enter', async () => {
  const log: string[] = []
  let settle!: () => void
  const settled = new Promise<void>((r) => (settle = r))
  let enter!: () => void
  const prompt = new Promise<void>((r) => (enter = r))
  const run = runPromptHold({
    inFlight: true,
    settled,
    onKeepRunning: () => log.push('keep-running'),
    acquire: async () => void log.push('acquire'),
    release: async () => void log.push('release'),
    fn: async () => {
      log.push('prompt-open')
      await prompt
      log.push('enter')
      return 'done'
    },
  })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(log, ['keep-running', 'prompt-open'], 'unfrozen while in flight')
  settle()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(log, ['keep-running', 'prompt-open', 'acquire'], 'frozen once it settled, prompt still waiting')
  enter()
  assert.equal(await run, 'done')
  assert.deepEqual(log, ['keep-running', 'prompt-open', 'acquire', 'enter', 'release'])
})

test('E2 runPromptHold: Enter before the purchase settles never acquires; already settled acquires at once; an acquire under way at Enter is released', async () => {
  const early: string[] = []
  await runPromptHold({ inFlight: true, settled: new Promise(() => {}), onKeepRunning: () => {}, acquire: async () => void early.push('acquire'), release: async () => void early.push('release'), fn: async () => {} })
  assert.deepEqual(early, ['release'], 'release is idempotent in the caller; nothing was acquired')
  const now: string[] = []
  await runPromptHold({ inFlight: false, onKeepRunning: () => now.push('keep'), acquire: async () => void now.push('acquire'), release: async () => void now.push('release'), fn: async () => void now.push('prompt') })
  assert.deepEqual(now, ['acquire', 'prompt', 'release'])
  const race: string[] = []
  let finishAcquire!: () => void
  await runPromptHold({
    inFlight: true,
    settled: Promise.resolve(),
    onKeepRunning: () => {},
    acquire: () => new Promise<void>((r) => { race.push('acquire-start'); finishAcquire = () => { race.push('acquire-end'); r() } }),
    release: async () => void race.push('release'),
    fn: async () => {
      await new Promise((r) => setTimeout(r, 10)) // Enter while the acquire is under way
      setTimeout(() => finishAcquire(), 20)
    },
  })
  assert.deepEqual(race, ['acquire-start', 'acquire-end', 'release'])
})

test('E3 SimHold.acquire("afterRound1") arms the hold with the same lease and heartbeat (a heartbeat carries no `at`)', async () => {
  const calls: { method: string; params: unknown[] }[] = []
  const hold = new SimHold(async <T,>(method: string, params: unknown[] = []) => {
    calls.push({ method, params })
    return ({ paused: false, armed: true, holder: 'demo-1', heldAt: null, chainNowMs: 1 }) as unknown as T
  }, 'demo-1', 60)
  assert.equal((await hold.acquire('afterRound1')).state, 'paused', 'the hold object is live: it has a lease to keep alive')
  assert.deepEqual(calls[0], { method: 'sim_pause', params: [{ holder: 'demo-1', at: 'afterRound1', leaseMs: 60 }] })
  await new Promise((r) => setTimeout(r, 90))
  const beats = calls.slice(1).filter((c) => c.method === 'sim_pause')
  assert.ok(beats.length >= 1)
  for (const b of beats) assert.deepEqual(b.params, [{ holder: 'demo-1', heartbeat: true, leaseMs: 60 }])
  await hold.release()
  assert.deepEqual(calls.at(-1), { method: 'sim_resume', params: [{ holder: 'demo-1' }] }, 'releasing an armed hold resumes (and disarms) it')
})

test('E3 runPromptHold: an acquire that rejects is never an unhandled rejection; the prompt still runs and releases', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => void unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    const log: string[] = []
    await runPromptHold({
      inFlight: true,
      settled: Promise.resolve(),
      onKeepRunning: () => {},
      acquire: () => Promise.reject(new Error('pause refused')),
      release: async () => void log.push('release'),
      fn: async () => {
        await new Promise((r) => setTimeout(r, 30)) // the rejection happens while the prompt waits
        log.push('enter')
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(log, ['enter', 'release'])
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('E3 retimeThrough: the whole hold is removed from earlier times; arrivals during the send phase land after the resume in order, keeping their gaps', () => {
  // Hold from 1000 to 5000 (resume); the sends start at 3700 (the presenter talked until then).
  const hold = { from: 1000, to: 5000, sendsFrom: 3700 }
  assert.equal(retimeThrough([hold], 900), 4900, 'before the hold: moved by the whole hold (1000 -> 5000)')
  assert.equal(retimeThrough([hold], 1000), 5000)
  const sends = [3700, 3790, 3900, 4150].map((t) => retimeThrough([hold], t))
  assert.deepEqual(sends, [5000, 5090, 5200, 5450], 'order and real gaps kept, anchored at the resume')
  assert.equal(retimeThrough([hold], 2500), 5000, 'the presenter talking before the sends collapses to the resume')
  assert.equal(retimeThrough([hold], 5200), 5200, 'after the resume: unchanged')
  // Without sendsFrom the old behaviour holds (a plain prompt pause).
  assert.equal(retimeThrough([{ from: 1000, to: 5000 }], 3800), 5000)
  // A tx that arrived before the hold still sorts before every send.
  assert.ok(retimeThrough([hold], 990) < sends[0]!)
})

const panelBody = [
  'block 11 [closed]: visible on the sequencer RPC, +1.4s after its first feed row',
  '   index  from         effective tip     FF lead',
  '  round 1/2 · 2 txs',
  '       0  0x2546…Ec30  0.09 gwei  +1.36s',
  '       1  0xcd3B…ce71  0.05 gwei  +1.36s',
  '  round 2/2 · 2 txs',
  '>>     2  0xf39F…2266  1 gwei     +0.13s  <- yours',
  '       3  0x90F7…b906  0.05 gwei  +0.13s',
]
const composeParts = (over: Partial<Parameters<typeof composeStoryPanel>[1]> = {}, body = panelBody) =>
  composeStoryPanel(body, { block: 11, blockMs: 2000, roundMs: 1000, k: 2, columns: 120, color: false, slowed: ['NOTE: Process slowed down for the demo: inserting a transaction with a bigger', '      tip in round 2'], ...over })
const compose = (over: Partial<Parameters<typeof composeStoryPanel>[1]> = {}, body = panelBody) => {
  const c = composeParts(over, body)
  return [...c.lines, ...c.tail]
}

test('E3 composeStoryPanel: reads top-down like the story: block header, round 1 header, column header, rows, NOTE, prompt, round 2 header, rows (ours first), sealed', () => {
  const out = compose({ prompt: 'Press Enter: insert your 1 gwei tx into round 2 of block 11', sealed: 'block 11 ordered and executed by the sequencer (sealed, visible on the RPC)' })
  const at = (re: RegExp) => out.findIndex((l) => re.test(l))
  const order = [/^block 11 — 250 ms on Arbitrum One \(here 2 s\)$/, /^round 1 — 125 ms on Arbitrum One \(here 1 s\) · 2 txs$/, /index {2}from/, /0x2546/, /0xcd3B/, /^NOTE: Process slowed down/, /^Press Enter/, /^round 2 — 125 ms on Arbitrum One \(here 1 s\) · 2 txs$/, /<- yours/, /0x90F7/, /ordered and executed by the sequencer/].map(at)
  assert.ok(order.every((i) => i >= 0), out.join('\n'))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in story order')
  assert.equal(order[0], 0, 'the block header is first')
  assert.equal(order.at(-1), out.length - 1, 'the sealed line is last')
  assert.ok(!out.some((l) => /\[closed\]|round \d\/2/.test(l)), 'the status line and the "round R/K" labels are replaced')
  assert.ok(order[8]! < order[9]!, 'ours is the first row of round 2')
})

test('E3 composeStoryPanel: before round 2 is ordered the NOTE and prompt come last; no sealed line, no prompt after resume; colour never cuts an escape in half', () => {
  const held = compose({ prompt: 'Press Enter' }, [...panelBody.slice(0, 5), '  round 2/2: not ordered yet'])
  const i = held.findIndex((l) => l.startsWith('NOTE:'))
  assert.ok(i > 0 && held[i + 2] === 'Press Enter' && i + 3 === held.length, held.join('\n'))
  assert.ok(!held.some((l) => l.startsWith('round 2')), 'round 2 has not run: no empty header, the NOTE and the prompt end the story')
  assert.deepEqual(composeParts({ prompt: 'Press Enter' }, [...panelBody.slice(0, 5), '  round 2/2: not ordered yet']).tail, held.slice(i), 'the NOTE and the prompt are the protected tail')
  const afterResume = composeParts({ sealed: 'SEALED' })
  assert.deepEqual(afterResume.tail, ['SEALED'], 'after the resume the sealed line is the tail')
  assert.ok(afterResume.lines.some((l) => l.startsWith('NOTE: Process slowed')), 'and the NOTE stays between the rounds')
  const done = compose({})
  assert.ok(!done.some((l) => l.startsWith('Press Enter') || l.includes('sealed')))
  const coloured = compose({ color: true, columns: 30, sealed: 'block 11 ordered and executed by the sequencer' })
  for (const l of coloured) assert.equal((l.match(/\x1b\[/g) ?? []).length % 2, 0, JSON.stringify(l)) // every opened style is closed
})

test('E3 armHoldAndWait: success reports the held block and adopts the hold; refused and missing pauses fall back; a timeout releases the hold first', async () => {
  const mk = (clock: () => Partial<SimClockInfo>, calls: string[], failPause?: string) => async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    calls.push(`${method}${method === 'sim_pause' ? ':' + JSON.stringify((params[0] as { at?: string; heartbeat?: boolean }).at ?? 'hb') : ''}`)
    if (method === 'sim_pause' && failPause) throw new Error(failPause)
    if (method === 'sim_clock') return clock() as T
    return { paused: false, armed: true, resumed: true, pausedMs: 1, chainNowMs: 5 } as unknown as T
  }
  // success: the hold takes effect on the third poll
  const calls: string[] = []
  let polls = 0
  const events: string[] = []
  const ok = await armHoldAndWait({
    rpc: mk(() => (++polls < 3 ? { paused: false, heldAt: null } : { paused: true, heldAt: { block: 42, round: 2 }, chainNowMs: 777 }), calls),
    holder: 'demo-1', timeoutMs: 5_000, pollMs: 1,
    onArmed: () => events.push('armed'), onHeld: (_h, c) => events.push(`held@${c}`), onTimeout: async () => void events.push('timeout'),
  })
  assert.deepEqual(ok, { ok: true, block: 42 })
  assert.deepEqual(events, ['armed', 'held@777'])
  assert.equal(calls[0], 'sim_pause:"afterRound1"')
  // refused / missing
  for (const [msg, re] of [['sim_pause: paused by demo-99', /paused by/], ['sim_pause: the method sim_pause does not exist', /does not exist/]] as const) {
    const ev: string[] = []
    const r = await armHoldAndWait({ rpc: mk(() => ({}), [], msg), holder: 'demo-1', timeoutMs: 100, onArmed: () => ev.push('armed'), onHeld: () => ev.push('held'), onTimeout: async () => void ev.push('timeout') })
    assert.equal(r.ok, false)
    assert.match((r as { reason: string }).reason, re)
    assert.deepEqual(ev, [], 'nothing was armed')
  }
  // timeout: released, then the fallback signal
  const tcalls: string[] = []
  const tev: string[] = []
  const t = await armHoldAndWait({ rpc: mk(() => ({ paused: false, heldAt: null }), tcalls), holder: 'demo-1', timeoutMs: 30, pollMs: 5, onArmed: () => tev.push('armed'), onHeld: () => tev.push('held'), onTimeout: async () => void tev.push('timeout') })
  assert.equal(t.ok, false)
  assert.match((t as { reason: string }).reason, /no block with transactions opened within/)
  assert.deepEqual(tev, ['armed', 'timeout'])
  assert.ok(tcalls.includes('sim_resume'), 'the armed hold was released')
})

test('E3 story panel on a short terminal (14 rows): the prompt is kept while held and the sealed line after the resume; the rows are trimmed first', () => {
  const draw = (c: { lines: string[]; tail: string[] }, many: string[]) => {
    const writes: string[] = []
    const stream = { columns: 120, rows: 14, write: (x: string) => void writes.push(x) }
    const r = new PanelRenderer({ stream, now: () => 0, intervalMs: 0, frame: () => [...c.lines.slice(0, 3), ...many, ...c.lines.slice(3), ...c.tail], tailLines: () => c.tail.length })
    r.start()
    const drawn = writes[1]!.replace(/^\x1b\[\d+A\r\x1b\[J/, '').split('\n').slice(0, -1)
    r.stop()
    return drawn
  }
  const rows = Array.from({ length: 20 }, (_, i) => `   row${i}`)
  const held = draw(composeParts({ prompt: 'Press Enter' }, [...panelBody.slice(0, 5), '  round 2/2: not ordered yet']), rows)
  assert.equal(held.length, 13)
  assert.equal(held.at(-1), 'Press Enter', 'the prompt survives the cut')
  assert.ok(held.some((l) => l.startsWith('NOTE: Process slowed')))
  assert.ok(held[0]!.startsWith('block 11 —'))
  const done = draw(composeParts({ sealed: 'SEALED' }), rows)
  assert.equal(done.at(-1), 'SEALED', 'the sealed line survives the cut')
})
