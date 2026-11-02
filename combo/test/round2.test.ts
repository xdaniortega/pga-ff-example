// C8/E3: chapter 4's pure parts: the verdict, the story lines, the timing table and the PGA vs FCFS comparison.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGwei, type Address, type Hex } from 'viem'
import type { LiveRow } from '../../fast-feed/client/live.ts'
import {
  blockHeaderLine,
  fmtMs,
  FIFO_FAILURE,
  formatFcfsComparison,
  formatRound2Lesson,
  roundHeaderLine,
  sealedLine,
  SLOWED_NOTE,
  formatTimingTable,
  judgeRound2Injection,
  labelTxs,
  parseArrivals,
  yourTxLine,
  type ArrivalRec,
  type OutLine,
} from '../round2.ts'

const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address
const hash = (n: number) => `0x${n.toString(16).padStart(6, '0')}${'ab'.repeat(29)}` as Hex
const row = (n: number, round: number, txIndex: number, tipGwei: string, o: Partial<LiveRow> = {}): LiveRow => ({
  blockNumber: 17, pgaRound: round, txIndex, hash: hash(n), from: `0x${n.toString(16).padStart(40, '0')}` as Address, to: null, bid: { kind: 'unknown' },
  effectiveTip: parseGwei(tipGwei), gasUsed: 21000n, feePaid: 0n, status: 1, orderedAt: 0, receivedAt: 5000 + txIndex * 10, ...o,
})
const text = (ls: OutLine[]) => ls.map((l) => l.text)
/** Sentences are wrapped to 80 columns: compare them with the line breaks collapsed. */
const flat = (ls: OutLine[]) => text(ls).join(' ').replace(/\s+/g, ' ')
const maxCols = (ls: OutLine[]) => Math.max(...ls.map((l) => [...l.text].length))

// The block used below: round 1 = txs 1..3, round 2 = X (index 3), D (4), E (5).
const X = 99
const round1 = [row(1, 1, 0, '0.07'), row(2, 1, 1, '0.03'), row(3, 1, 2, '0')]
const xRow = row(X, 2, 3, '1', { from: ME })
const round2 = [xRow, row(4, 2, 4, '0.05'), row(5, 2, 5, '0.01')]
const rows = [...round1, ...round2]
const hs = (rs: LiveRow[]) => rs.map((r) => r.hash as string)

const base = { ordering: 'pga' as const, targetBlock: 17, block: 17, round: 2, indexInRound: 0, competitors: 2, leadMs: 90, tipGwei: '1' }

test('judgeRound2Injection: PASS needs a PGA stack, the target block, round 2, a competitor, first in the round and a positive lead', () => {
  const j = judgeRound2Injection(base)
  assert.equal(j.verdict, 'PASS')
  assert.equal(j.observed, true)
  assert.equal(j.failure, undefined)
  assert.equal(j.lines.join(' '), 'PGA put us first in round 2 of block 17 (index 0 of 3 txs in the round). The Fast Feed showed it 90ms before block 17 was visible.')
})

test('judgeRound2Injection: round 1 instead of round 2, or the next block, is INCONCLUSIVE (timing), never credited', () => {
  const r1 = judgeRound2Injection({ ...base, round: 1 })
  assert.deepEqual([r1.verdict, r1.observed], ['INCONCLUSIVE', false])
  assert.match(r1.failure!, /landed in round 1 of block 17, not round 2 of block 17: it was sent before round 1 was ordered/)
  const next = judgeRound2Injection({ ...base, block: 18, round: 1 })
  assert.equal(next.verdict, 'INCONCLUSIVE')
  assert.match(next.failure!, /landed in round 1 of block 18, not in round 2 of block 17/)
  assert.equal(judgeRound2Injection({ ...base, block: 18 }).verdict, 'INCONCLUSIVE', 'round 2 of the NEXT block is still another block')
})

test('judgeRound2Injection: not first fails, no competitors is inconclusive, FIFO fails by name even when everything else looks right', () => {
  const idx = judgeRound2Injection({ ...base, indexInRound: 2 })
  assert.deepEqual([idx.verdict, idx.observed], ['FAIL', false])
  assert.match(idx.failure!, /index 2, not index 0, of round 2/)
  const solo = judgeRound2Injection({ ...base, competitors: 0 })
  assert.deepEqual([solo.verdict, solo.observed], ['INCONCLUSIVE', false])
  assert.match(solo.failure!, /held only our tx/)
  const fifo = judgeRound2Injection({ ...base, ordering: 'fifo' })
  assert.deepEqual([fifo.verdict, fifo.observed, fifo.failure], ['FAIL', false, FIFO_FAILURE])
  assert.match(fifo.lines.join(' '), /orders by arrival \(FIFO\), so index 0 shows arrival, not the tip: PGA was not observed/)
  assert.doesNotMatch(fifo.lines.join(' '), /put us first/)
  const never = judgeRound2Injection({ ...base, leadMs: undefined })
  assert.equal(never.verdict, 'INCONCLUSIVE', 'a missing lead is a measurement problem (retried once), not a PGA failure')
  assert.match(never.failure!, /not visible on the RPC/)
  const zero = judgeRound2Injection({ ...base, leadMs: 0 })
  assert.equal(zero.verdict, 'INCONCLUSIVE')
  assert.match(zero.failure!, /lead was 0ms \(not positive\)/)
  assert.equal(judgeRound2Injection({ ...base, leadMs: -5 }).verdict, 'INCONCLUSIVE')
})

test('yourTxLine: block, round and position', () => {
  assert.equal(yourTxLine({ block: 17, round: 2, indexInRound: 0, inRound: 3, tipGwei: '1' }), 'YOUR TX: block 17, round 2, first in its round (tip 1 gwei)')
  assert.equal(yourTxLine({ block: 17, round: 2, indexInRound: 2, inRound: 3, tipGwei: '1' }), 'YOUR TX: block 17, round 2, position 3 of 3 in its round (tip 1 gwei)')
})

test('labelTxs: A-C for round 1, D-F for round 2, X for ours, never an X letter for anyone else', () => {
  const l = labelTxs(hs(round1), hs(round2), hash(X))
  assert.deepEqual([1, 2, 3, 4, 5, X].map((n) => l.get(hash(n).toLowerCase())), ['A', 'B', 'C', 'D', 'E', 'X'])
  const many = labelTxs(Array.from({ length: 10 }, (_, i) => hash(100 + i)), [], undefined)
  assert.equal(many.size, 3, 'only the first three of round 1 are lettered')
  const r2 = labelTxs([], [hash(1), hash(2), hash(3), hash(4)], hash(X), [], [hash(3), hash(4)])
  assert.deepEqual([3, 4, 1, 2].map((n) => r2.get(hash(n).toLowerCase())), ['A', 'B', undefined, undefined], 'round 2: the competitors first, two letters')
})

const arr = (n: number, at: number, tip: string): ArrivalRec => ({ hash: hash(n), from: ME, arrivedAtMs: at, tipWei: parseGwei(tip), txIndex: 0 })
// Origin (round 1 start) = 1000. Round 2: D arrived first, then E, then X (the demo's own tx).
const arrivals = [arr(1, 1100, '0.07'), arr(2, 1200, '0.03'), arr(3, 1300, '0'), arr(4, 5200, '0.05'), arr(5, 5500, '0.01'), arr(X, 5700, '1')]
const labels = labelTxs(hs(round1), hs(round2), hash(X))
const opts = { originMs: 1000, mine: new Set([ME.toLowerCase()]), labels }

test('formatTimingTable: arrived <= seen on FF <= block finished per row, with FF lead and wait, labelled simulator-only, within 80 columns', () => {
  const visible = 9000
  const t = formatTimingTable(rows, arrivals, visible, opts)
  const s = text(t)
  assert.ok(maxCols(t) <= 80, s.filter((l) => l.length > 80).join('\n'))
  assert.match(s[0]!, /timing of block 17: ms after round 1 started/)
  assert.match(s[1]!, /tx\s+rnd\s+idx\s+arrived\*\s+seen on FF\s+block done\s+FF lead\s+wait/)
  const x = s.find((l) => l.startsWith('>>'))!
  // X: arrived +4700ms (5700-1000), seen on FF 5000+30 -> +4030ms? receivedAt = 5000 + txIndex*10 = 5030
  assert.match(x, new RegExp(`X ${hash(X).slice(0, 8)}\\s+2\\s+3\\s+\\+4700ms\\s+\\+4030ms\\s+\\+8000ms\\s+\\+3970ms\\s+-670ms`), x)
  assert.match(s.join('\n'), /NOTE: \* arrived = simulator-only data \(sim_arrivals\)\./)
  // Rows whose arrival precedes receipt: wait >= 0 for every row received after it arrived.
  const d = s.find((l) => l.includes(hash(4).slice(0, 8)))!
  assert.match(d, /\+4200ms\s+\+4040ms/)
})

test('formatTimingTable: an unknown arrival or visibility prints "?", and many rows keep ours and round 2 but elide the rest', () => {
  const t = text(formatTimingTable(rows, [], undefined, opts)).join('\n')
  assert.match(t, /\?/)
  const big = Array.from({ length: 30 }, (_, i) => row(300 + i, 1, i, '0.01', { receivedAt: 5000 + i }))
  const bigRows = [...big, ...round2.map((r, i) => ({ ...r, txIndex: 30 + i }))]
  const out = formatTimingTable(bigRows, arrivals, 9000, { ...opts, maxRows: 8 })
  const s = text(out).join('\n')
  assert.match(s, /\.\.\. 25 more txs not shown/)
  assert.ok(s.includes(`X ${hash(X).slice(0, 8)}`))
  assert.ok(maxCols(out) <= 80)
})

test('formatFcfsComparison: PGA order next to the arrival order with gaps; yours marked; X is 1st with PGA and 3rd under FCFS', () => {
  const r = formatFcfsComparison(round2, arrivals.slice(3), { ...opts, block: 17, round: 2 })
  const s = text(r.lines)
  assert.ok(maxCols(r.lines) <= 80, s.filter((l) => l.length > 80).join('\n'))
  assert.equal(s[0], 'hypothetical FCFS (local simulator data): round 2 of block 17')
  assert.match(s[1]!, /^real PGA order \(by tip\) +FCFS order \(by arrival; gap to the previous\)$/)
  const first = s[2]!
  assert.match(first, new RegExp(`^1\\. X ${hash(X).slice(0, 8)}  1 gwei <- yours +1\\. D ${hash(4).slice(0, 8)} \\+4200ms \\(first\\)$`), first)
  assert.match(s[3]!, /2\. D .*0\.05 gwei +2\. E .*\+4500ms \(\+300ms\)/)
  assert.match(s[4]!, /3\. E .*0\.01 gwei +3\. X .*\+4700ms \(\+200ms\) <- yours/)
  assert.deepEqual([r.pgaPosition, r.fcfsPosition], [1, 3])
  const all = flat(r.lines)
  assert.match(all, /Your tx: position 1 of 3 with PGA \(the tip decided\); position 3 under FCFS \(it arrived 200ms after the previous tx\)\./)
  assert.match(all, /Under FCFS arrival \(latency\) decides; under PGA the tip does\./)
})

test('formatFcfsComparison: a FIFO stack says "real FIFO order"; rows with no arrival data go last', () => {
  const f = formatFcfsComparison(round2, arrivals.slice(3, 5), { ...opts, ordering: 'fifo' })
  const s = flat(f.lines)
  assert.match(s, /real FIFO order \(by arrival\)/)
  assert.match(s, /in the real FIFO order/)
  assert.match(s, /\(no arrival data\)/)
  assert.equal(f.fcfsPosition, undefined, 'no arrival record for our tx: no FCFS position')
})

test('formatFcfsComparison: our tx without an arrival record prints NOTE: arrival data unavailable and never claims an FCFS position', () => {
  const f = formatFcfsComparison(round2, arrivals.slice(3, 5), { ...opts })
  const s = flat(f.lines)
  assert.match(s, /Your tx: position 1 of 3 with PGA \(the tip decided\)\./)
  assert.match(s, /arrival data was unavailable for your tx/)
  assert.doesNotMatch(s, /same position under FCFS|position \d+ under FCFS/)
  assert.ok(text(f.lines).some((l) => l.startsWith('NOTE: ')))
  assert.match(text(f.lines).join('\n'), /\(no arrival data\)/)
  assert.deepEqual([f.pgaPosition, f.fcfsPosition], [1, undefined])
  assert.ok(maxCols(f.lines) <= 80)
  const none = formatFcfsComparison(round2, [], { ...opts })
  assert.doesNotMatch(flat(none.lines), /under FCFS \(|same position/)
})

test('wrapping: an over-long token is split so no line exceeds 80 columns', () => {
  const t = formatTimingTable(rows, [], undefined, { originMs: 0 })
  assert.ok(maxCols(t) <= 80)
  const long = formatTimingTable(rows, [], undefined, { originMs: 0 }).concat(formatFcfsComparison([row(1, 2, 0, '0', { from: ME })], [], { originMs: 0, mine: new Set([ME.toLowerCase()]), labels: new Map([[hash(1).toLowerCase(), 'X' + 'y'.repeat(120)]]) }).lines)
  assert.ok(maxCols(long) <= 80, text(long).filter((l) => l.length > 80).join('\n'))
})

test('parseArrivals: reads the sim_arrivals JSON (tipWei as a 0x quantity) and skips malformed entries', () => {
  const r = parseArrivals([{ hash: hash(1), from: ME, arrivedAtMs: 123, tipWei: '0x2faf080', txIndex: 4 }, { hash: 5 }, null])
  assert.deepEqual(r, [{ hash: hash(1), from: ME, arrivedAtMs: 123, tipWei: 50_000_000n, txIndex: 4 }])
  assert.deepEqual(parseArrivals(undefined), [])
})

test('competitor txs are marked (c) in both tables (the timing table has the legend), and the tables stay within 80 columns', () => {
  const competitors = new Set([hash(4).toLowerCase(), hash(5).toLowerCase()])
  const f = formatFcfsComparison(round2, arrivals.slice(3), { ...opts, competitors })
  const t = formatTimingTable(rows, arrivals, 9000, { ...opts, competitors })
  for (const out of [f.lines, t]) {
    assert.ok(maxCols(out) <= 80, text(out).filter((l) => l.length > 80).join('\n'))
    assert.match(text(out).join('\n'), new RegExp(`D ${hash(4).slice(0, 8)} \\(c\\)`))
  }
  assert.match(flat(t), /\(c\) = competitor sent just before X\./)
})

test('slow-motion sized numbers (5-digit ms offsets, a competitor and a letter) still fit in 80 columns without being cut', () => {
  const big = [...round1, ...round2].map((r, i) => ({ ...r, receivedAt: 1000 + 25_000 + i }))
  const bigArr = arrivals.map((a) => ({ ...a, arrivedAtMs: a.arrivedAtMs + 17_000 }))
  const competitors = new Set([hash(4).toLowerCase(), hash(5).toLowerCase()])
  const t = formatTimingTable(big, bigArr, 1000 + 25_200, { ...opts, competitors })
  const f = formatFcfsComparison(big.slice(3), bigArr.slice(3), { ...opts, competitors })
  for (const out of [t, f.lines]) {
    assert.ok(maxCols(out) <= 80)
    assert.ok(!text(out).some((l) => l.endsWith('…')), 'a line was cut:\n' + text(out).join('\n'))
  }
  assert.match(text(t).join('\n'), /\+25000ms/)
  assert.match(text(t).join('\n'), /wait\n.*\+7900ms\n/, 'the last column is intact')
})

test('E3 story lines: block and round headers give Arbitrum One next to the local value, taken from the running config', () => {
  assert.equal(blockHeaderLine(17, 2000), 'block 17 — 250 ms on Arbitrum One (here 2 s)')
  assert.equal(roundHeaderLine(1, 2, 1000), 'round 1 — 125 ms on Arbitrum One (here 1 s)')
  assert.equal(roundHeaderLine(2, 2, 1000), 'round 2 — 125 ms on Arbitrum One (here 1 s)')
  assert.equal(blockHeaderLine(9, 25_000), 'block 9 — 250 ms on Arbitrum One (here 25 s)', 'slow motion x100')
  assert.equal(roundHeaderLine(1, 2, 12_500), 'round 1 — 125 ms on Arbitrum One (here 12.5 s)')
  assert.equal(blockHeaderLine(3, 500), 'block 3 — 250 ms on Arbitrum One (here 500 ms)', 'a --block-ms override')
  assert.equal(blockHeaderLine(3, 250), 'block 3 — 250 ms on Arbitrum One (here: the same)', 'real speed: nothing to compare')
  assert.equal(roundHeaderLine(1, 2, 125), 'round 1 — 125 ms on Arbitrum One (here: the same)')
  assert.equal(fmtMs(250), '250 ms')
  assert.equal(fmtMs(1000), '1 s')
})

test('E3 story lines: the slowed-down NOTE is the presenter sentence and the sealed line says ordered and executed by the sequencer', () => {
  assert.equal(SLOWED_NOTE, 'Process slowed down for the demo: inserting a transaction with a bigger tip in round 2')
  assert.equal(sealedLine(17), 'block 17 ordered and executed by the sequencer (sealed, visible on the RPC)')
  for (const l of [blockHeaderLine(123456, 25_000), roundHeaderLine(1, 2, 12_500), sealedLine(123456)]) assert.ok(l.length <= 80, l)
})

test('E3 formatRound2Lesson: at most two sentences, only for X observed in round 2; FIFO never says the tip ranked anything', () => {
  const lesson = formatRound2Lesson({ ordering: 'pga', inRound2: true, round1: ['A', 'B', 'C'], round1Total: 3, round2: ['D', 'E'], round2Total: 2 })
  assert.ok(lesson.length <= 4 && lesson.every((l) => l.kind === 'important') && maxCols(lesson) <= 80)
  const f = flat(lesson)
  assert.match(f, /A, B and C were already final when you sent X: nothing you send goes before them\./)
  assert.match(f, /In round 2 you competed blind: X was ranked by tip against D and E\./)
  const fifo = flat(formatRound2Lesson({ ordering: 'fifo', inRound2: true, round1: ['A'], round1Total: 1, round2: ['D'], round2Total: 1 }))
  assert.match(fifo, /ordered by arrival among D, not by tip \(FIFO\)/)
  assert.doesNotMatch(fifo, /ranked|by tip against/)
  assert.deepEqual(formatRound2Lesson({ ordering: 'pga', inRound2: false, round1: ['A'], round1Total: 1, round2: [], round2Total: 0 }), [], 'no claim when X did not land in round 2')
  assert.match(flat(formatRound2Lesson({ ordering: 'pga', inRound2: true, round1: [], round1Total: 0, round2: [], round2Total: 0 })), /no competitors in round 2/)
})

test('E3 terse tables: one short note each, a row cap with "more", the position note still never claims FCFS without data', () => {
  const t = formatTimingTable(rows, arrivals, 9000, { ...opts, maxRows: 6, competitors: new Set([hash(4).toLowerCase()]) })
  const s = text(t)
  assert.ok(maxCols(t) <= 80)
  assert.ok(s.length <= 12, `${s.length} lines`)
  assert.match(flat(t), /NOTE: \* arrived = simulator-only data \(sim_arrivals\)\./)
  assert.match(flat(t), /\(c\) = competitor sent just before X\./)
  assert.doesNotMatch(s.join('\n'), /Arbitrum does not publish it/)
  const f = formatFcfsComparison(round2, arrivals.slice(3), { ...opts, block: 17, round: 2, maxRows: 2 })
  const fs = text(f.lines)
  assert.ok(fs.some((l) => /\.\.\. 1 more tx not shown/.test(l)))
  assert.deepEqual([f.pgaPosition, f.fcfsPosition], [1, 3], 'positions use every row, not only the shown ones')
  assert.match(flat(f.lines), /Under FCFS arrival \(latency\) decides; under PGA the tip does\./)
  assert.ok(f.lines.length <= 9)
  const noData = formatFcfsComparison(round2, [], { ...opts, block: 17, round: 2 })
  assert.match(flat(noData.lines), /FCFS position is not shown/)
  assert.equal(noData.fcfsPosition, undefined)
})

// F1/F3: the race block with and without Fast Feed.
import { formatBlockComparison, comparisonSkipNote, fmtGain, FF_HEADING, NO_FF_HEADING, SEQUENCER_LATENCY_MS, type BlockComparisonInput } from '../round2.ts'

const RIVAL = '0x0000000000000000000000000000000000000004' as Address
const mRows = [row(21, 1, 0, '0.1', { blockNumber: 18, from: RIVAL, receivedAt: 25_000 }), row(22, 1, 1, '0.02', { blockNumber: 18, receivedAt: 25_010 })]
const cmpInput = (o: Partial<BlockComparisonInput> = {}): BlockComparisonInput => ({
  rows: [...rows, ...mRows], visibleAt: 20_000, block: 17, rivalBlock: 18, blockMs: 2000, k: 2, roundMs: 1000, mine: new Set([ME.toLowerCase()]), rival: new Set([RIVAL]), columns: undefined, ...o,
})
const split = (t: string[]) => {
  const i = t.indexOf(NO_FF_HEADING)
  return { left: t.slice(0, i), right: t.slice(i) }
}

test('F3 fmtGain: simulated gain plus theoretical Arbitrum One ms (250/B), never positive, never -0.00s', () => {
  assert.equal(fmtGain(12_570, 25_000), '-12.57s (-126 ms)')
  assert.equal(fmtGain(14_970, 2000), '-14.97s (-1871 ms)')
  assert.equal(fmtGain(0, 2000), '0.00s (0 ms)')
  assert.equal(fmtGain(-500, 2000), '0.00s (0 ms)')
  assert.equal(fmtGain(4, 2000), '0.00s (0 ms)')
  assert.doesNotMatch(fmtGain(4, 2000), /-0\.00s/)
  assert.equal(fmtGain(12_570, 25_000).startsWith('-'), true)
})

test('F3 stacked: left = block N only with latency (vs no FF); right = block N then block M, +60ms, no rounds', () => {
  const out = formatBlockComparison(cmpInput())
  const t = text(out)
  assert.ok(t.indexOf(FF_HEADING) >= 0 && t.indexOf(FF_HEADING) < t.indexOf(NO_FF_HEADING))
  assert.ok(maxCols(out) <= 80)
  const { left, right } = split(t)
  const L = left.join('\n'), R = right.join('\n')
  assert.ok(left.some((l) => l.startsWith('round 1 — ')) && left.some((l) => l.startsWith('round 2 — ')))
  assert.match(L, /· 3 txs/)
  assert.match(L, /latency \(vs no FF\)/)
  assert.equal(left.filter((l) => l.startsWith('block ')).length, 1, 'no block M on the left')
  assert.ok(!L.includes('block 18'))
  assert.match(left.find((l) => l.includes('<- yours'))!, /-14\.97s \(-1871 ms\)/) // visible 20000 - received 5030
  for (const l of left) assert.doesNotMatch(l, /\+\d+/)
  // right
  assert.deepEqual(right.filter((l) => l.startsWith('block ')).map((l) => l.slice(0, 9)), ['block 17 ', 'block 18 '])
  assert.ok(right.findIndex((l) => l.startsWith('block 17')) < right.findIndex((l) => l.startsWith('block 18')))
  assert.match(right.find((l) => l.trim().startsWith('idx'))!, /^ {3}idx +from +tip +latency$/)
  const dataRows = right.filter((l) => /^ {3}\d+ /.test(l))
  assert.equal(dataRows.length, 8)
  for (const l of dataRows) assert.match(l, new RegExp(`\\+${SEQUENCER_LATENCY_MS}ms`))
  assert.equal(SEQUENCER_LATENCY_MS, 60)
  assert.ok(right.some((l) => l.includes('<- yours')))
  assert.ok(right.slice(right.findIndex((l) => l.startsWith('block 18'))).some((l) => l.includes('<- rival')))
  assert.ok(!/vs no FF|round|-\d+\.\d\ds/.test(R))
})

test('F3 rival in the same block or without rows: right shows only block N', () => {
  for (const o of [{ rivalBlock: 17 }, { rivalBlock: undefined }, { rivalBlock: 19 }]) {
    const { right } = split(text(formatBlockComparison(cmpInput(o))))
    assert.equal(right.filter((l) => l.startsWith('block ')).length, 1)
    assert.equal(right.filter((l) => /^ {3}\d+ /.test(l)).length, 6)
  }
  const none = formatBlockComparison(cmpInput({ rivalBlock: 19 }))
  assert.ok(none.every((l) => l.kind !== 'note'))
})

test('F3 160-column side by side and 159 stacked', () => {
  const rv = [...rows.map((r) => (r.txIndex === 4 ? { ...r, from: RIVAL } : r)), ...mRows]
  const out = formatBlockComparison(cmpInput({ rows: rv, columns: 160 }))
  assert.ok(maxCols(out) <= 160)
  assert.ok(text(out)[0]!.includes(FF_HEADING) && text(out)[0]!.includes(NO_FF_HEADING))
  const col = text(out)[0]!.indexOf(NO_FF_HEADING)
  assert.equal(col, 80)
  assert.ok(text(out).some((l) => l.includes('<- rival') && l.indexOf('<- rival') > col), 'rival marked on the right')
  assert.ok(text(out).some((l) => l.slice(0, col).includes('<- yours')))
  assert.ok(text(out).some((l) => l.slice(col).includes('<- yours')))
  assert.ok(text(out).some((l) => l.slice(col).startsWith('block 18')))
  const stacked = formatBlockComparison(cmpInput({ rows: rv, columns: 159 }))
  assert.ok(text(stacked)[0] === FF_HEADING && maxCols(stacked) <= 80)
})

test('F1 missing data gives one skip NOTE', () => {
  const none = formatBlockComparison(cmpInput({ rows: [] }))
  assert.ok(none.every((l) => l.kind === 'note') && text(none)[0]!.startsWith('NOTE:'))
  const unseen = formatBlockComparison(cmpInput({ visibleAt: undefined }))
  assert.ok(unseen.every((l) => l.kind === 'note') && maxCols(unseen) <= 80)
  assert.deepEqual(text(comparisonSkipNote('x')), ['NOTE: Comparison with and without Fast Feed skipped: x.'])
})

// F5: the comparison in three stages and the sequencer summary.
import { formatComparisonStage, formatSequencerSummary } from '../round2.ts'

test('F5 stage 1: only round 1 on the left, the gain pending, no right side; stage 3 of formatBlockComparison is the unstaged output', () => {
  const t = text(formatComparisonStage(cmpInput(), 1))
  assert.equal(t[0], FF_HEADING)
  assert.ok(t.some((l) => l.startsWith('round 1 — ')))
  assert.ok(!t.some((l) => l.startsWith('round 2 — ')), 'no round 2 yet')
  assert.ok(!t.includes(NO_FF_HEADING) && !t.some((l) => l.includes('+60ms')), 'no right side')
  assert.ok(t.some((l) => /latency \(vs no FF\)/.test(l)) && t.some((l) => l.includes('pending')))
  assert.ok(!t.some((l) => l.includes('<- yours')), 'mine is in round 2')
  assert.ok(maxCols(formatComparisonStage(cmpInput({ columns: 200 }), 1)) <= 80, 'stacked even on a wide terminal')
  assert.deepEqual(text(formatBlockComparison(cmpInput())), text(formatBlockComparison(cmpInput(), 3)))
})

test('F5 stage 2: round 2 on the left (gain measured) and the whole block N on the right; stage 3 adds block M on the right only', () => {
  const s2 = formatComparisonStage(cmpInput(), 2)
  const t = text(s2)
  assert.match(t[0]!, /^NOTE: round 1 again/)
  assert.ok(t.some((l) => l.startsWith('round 2 — ')))
  const iRight = t.indexOf(NO_FF_HEADING)
  assert.ok(iRight > 0)
  const left = t.slice(0, iRight).join('\n'), right = t.slice(iRight)
  assert.match(left, /-\d+\.\d\ds \(-\d+ ms\)/)
  assert.ok(!left.includes('pending'))
  assert.equal(right.filter((l) => /^ {3}\d+ /.test(l)).length, 6, 'the whole block N, no rounds')
  assert.ok(right.every((l) => !/round \d/.test(l)) && right.some((l) => l.includes('<- yours')))
  assert.ok(!right.some((l) => l.startsWith('block 18')), 'no block M yet')
  assert.ok(maxCols(s2) <= 80)
  const s3 = formatComparisonStage(cmpInput(), 3)
  const t3 = text(s3)
  assert.ok(!t3.includes(FF_HEADING) && !t3.includes(NO_FF_HEADING) && !t3.some((l) => l.startsWith('round ')), 'right side only, nothing on the left')
  assert.ok(t3.some((l) => l.startsWith('block 18 — ')) && t3.some((l) => l.includes('<- rival')))
  assert.ok(!t3.some((l) => l.startsWith('block 17')))
  assert.ok(maxCols(s3) <= 80)
  assert.ok(t3.every((l) => !/-\d+\.\d\ds/.test(l)), 'no gain on the right')
})

test('F5 stages: cumulative side by side from 160 columns; stage 3 says nothing when block M is the same or has no rows; skip NOTE unchanged', () => {
  const one = formatBlockComparison(cmpInput({ columns: 160 }), 1)
  assert.ok(text(one).every((l) => !l.includes(NO_FF_HEADING)))
  const two = formatBlockComparison(cmpInput({ columns: 160 }), 2)
  assert.ok(maxCols(two) <= 160 && text(two)[0]!.includes(NO_FF_HEADING) && !text(two).some((l) => l.includes('block 18')))
  assert.ok(text(formatBlockComparison(cmpInput({ columns: 160 }), 3)).some((l) => l.slice(80).startsWith('block 18')))
  for (const o of [{ rivalBlock: 17 }, { rivalBlock: undefined }, { rivalBlock: 19 }]) assert.deepEqual(formatComparisonStage(cmpInput(o), 3), [])
  const noRows = formatComparisonStage(cmpInput({ rows: [] }), 1)
  assert.deepEqual(text(noRows), text(comparisonSkipNote('the Fast Feed connection saw no transactions of block 17')))
  assert.ok(formatComparisonStage(cmpInput({ visibleAt: undefined }), 2).every((l) => l.kind === 'note'))
  assert.ok(formatComparisonStage(cmpInput({ visibleAt: undefined }), 1).some((l) => l.text.includes('pending')), 'stage 1 needs no visible time')
})

test('F5 sequencer summary: at most 3 NOTE lines within 80 columns, from observed rows only', () => {
  const OP = '0x00000000000000000000000000000000000000a0' as Address
  const r1 = [row(30, 1, 0, '0.05', { blockNumber: 12 }), row(31, 1, 1, '0.01', { blockNumber: 12, from: OP })]
  const mine = row(32, 2, 2, '0.2', { blockNumber: 12, from: ME })
  const extras = [row(33, 2, 3, '0.045', { blockNumber: 12 }), row(34, 2, 4, '0.015', { blockNumber: 12 })]
  const rival = row(35, 1, 0, '0.1', { blockNumber: 13, from: RIVAL })
  const input = { block: 12, rows: [...r1, mine, ...extras, rival], operator: new Set([OP]), mine: new Set([ME.toLowerCase()]), rival: new Set([RIVAL]), rivalSawAfterSealed: true }
  const out = formatSequencerSummary(input)
  assert.equal(out.length, 3)
  for (const l of out) assert.ok(l.kind === 'note' && l.text.startsWith('NOTE: ') && l.text.indexOf('NOTE:', 1) === -1 && [...l.text].length <= 80, l.text)
  assert.equal(text(out)[0], 'NOTE: round 1 of block 12: open at position 2 of 2 (1 before, 0 after).')
  // open first: "then"; open in the middle: before / after counts, never "then"
  const first = text(formatSequencerSummary({ ...input, rows: [row(40, 1, 0, '0.5', { blockNumber: 12, from: OP }), row(41, 1, 1, '0.05', { blockNumber: 12 }), row(42, 1, 2, '0.01', { blockNumber: 12 })] }))
  assert.equal(first[0], 'NOTE: round 1 of block 12: open first, then 2 txs (0.05-0.01 gwei).')
  const mid = text(formatSequencerSummary({ ...input, rows: [row(43, 1, 0, '0.05', { blockNumber: 12 }), row(44, 1, 1, '0.01', { blockNumber: 12, from: OP }), row(45, 1, 2, '0.01', { blockNumber: 12 })] }))
  assert.equal(mid[0], 'NOTE: round 1 of block 12: open at position 2 of 3 (1 before, 1 after).')
  assert.ok(!mid[0]!.includes('then') && mid[0]!.length <= 80)
  assert.equal(text(out)[1], 'NOTE: round 2: mine (0.2 gwei) first, then 2 txs at lower tips (0.045-0.015).')
  assert.equal(text(out)[2], 'NOTE: rival (polling) saw open only after block 12 sealed: block 13 round 1.')
  // not claimed when not observed
  assert.match(text(formatSequencerSummary({ ...input, rivalSawAfterSealed: undefined }))[2]!, /^NOTE: rival \(polling\) landed in block 13 round 1\.$/)
  // same block: said as such, never "after sealed"
  const same = text(formatSequencerSummary({ ...input, rows: [...r1, mine, ...extras, row(36, 2, 5, '0.1', { blockNumber: 12, from: RIVAL })] }))
  assert.match(same[2]!, /^NOTE: the rival landed in the same block 12: block 12 round 2, tx_index 5\.$/)
  assert.ok(!same.join('\n').includes('sealed'))
  // mine not first / missing data: lines left out
  const behind = text(formatSequencerSummary({ ...input, rows: [row(37, 2, 2, '0.5', { blockNumber: 12 }), { ...mine, txIndex: 3 }], rival: new Set(), operator: new Set() }))
  assert.deepEqual(behind, ['NOTE: round 2: mine (0.2 gwei) at position 2 of 2.'])
  assert.deepEqual(formatSequencerSummary({ ...input, rows: [] }), [])
})

test('F6 formatComparisonStage flags the table rows shown for the first time: stage 1 round 1, stage 2 only the later rounds; text is unchanged', () => {
  const s1 = formatComparisonStage(cmpInput(), 1)
  const rows1 = s1.filter((l) => l.row)
  assert.equal(rows1.length, 3, 'round 1 has 3 rows')
  assert.ok(s1.indexOf(rows1[0]!) === 4 && s1.slice(4).every((l) => l.row), 'rows follow FF heading, block header, round header, column header')
  const s2 = formatComparisonStage(cmpInput(), 2)
  const flagged = s2.filter((l) => l.row)
  assert.equal(flagged.length, 3, 'round 2 rows only: the round 1 reprint and the right side are not paced')
  assert.ok(flagged.every((l) => l.text.length > 0))
  const i2 = s2.findIndex((l) => l.text.startsWith('round 2 — '))
  assert.ok(s2[i2 + 1]!.row !== true && s2[i2 + 2]!.row === true, 'header and column header are not rows')
  assert.ok(!formatComparisonStage(cmpInput(), 3).some((l) => l.row), 'stage 3 is not paced')
})
