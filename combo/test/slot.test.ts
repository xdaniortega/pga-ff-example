// B5: pure parts of `npm run pga:slot`: arguments, round checks, the judge and the timeline.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGwei, type Hex } from 'viem'
import { ConfigError } from '../../shared/config.ts'
import { closingLine, formatTimeline, judgeSlot, parseSlotArgs, roundProblem, type SlotFeedRow, type SlotSent } from '../slot.ts'

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const T0 = 1_000_000
// send order: 0.001, 0.01, 0.1, then the late 0.05 five seconds after
const sent: SlotSent[] = [
  { label: 'early 1', tipWei: parseGwei('0.001'), late: false, hash: h(1), sentAt: T0 },
  { label: 'early 2', tipWei: parseGwei('0.01'), late: false, hash: h(2), sentAt: T0 + 20 },
  { label: 'early 3', tipWei: parseGwei('0.1'), late: false, hash: h(3), sentAt: T0 + 40 },
  { label: 'late', tipWei: parseGwei('0.05'), late: true, hash: h(4), sentAt: T0 + 5000 },
]
const row = (n: number, index: number, block = 7, round: number | undefined = 1): SlotFeedRow => ({ hash: h(n), block, index, round, timestampMs: T0 + 10_000 })
const pgaFeed = [row(3, 0), row(4, 1), row(2, 2), row(1, 3)]

test('args: --local, --late-after-ms, errors', () => {
  assert.deepEqual(parseSlotArgs(['--local']), { mode: 'local', lateAfterMs: undefined })
  assert.equal(parseSlotArgs(['--local', '--late-after-ms', '1500']).lateAfterMs, 1500)
  assert.equal(parseSlotArgs(['--testnet']).mode, 'testnet')
  assert.throws(() => parseSlotArgs([]), ConfigError)
  assert.throws(() => parseSlotArgs(['--local', '--testnet']), ConfigError)
  assert.throws(() => parseSlotArgs(['--local', '--late-after-ms', 'x']), ConfigError)
  assert.throws(() => parseSlotArgs(['--local', '--bogus']), ConfigError)
})

test('round checks: shorter than 2s, late-after not shorter than the round', () => {
  assert.match(roundProblem(1000, undefined)!, /npm run sim -- --block-ms 20000/)
  assert.match(roundProblem(3000, 3000)!, /shorter than the round/)
  assert.equal(roundProblem(10_000, 5000), undefined)
})

test('judge PASS: one round, 0.1, 0.05, 0.01, 0.001, late tx at tx_index 1', () => {
  const j = judgeSlot({ ordering: 'pga', sent, feed: pgaFeed })
  assert.equal(j.verdict, 'PASS')
  assert.match(j.reason, /at index 1 of its round \(tx_index 1\)/)
  assert.equal(j.others, 0)
})

test('judge: late tx not at index 1 -> FAIL; FIFO stack -> FAIL', () => {
  const wrong = judgeSlot({ ordering: 'pga', sent, feed: [row(3, 0), row(2, 1), row(4, 2), row(1, 3)] })
  assert.equal(wrong.verdict, 'FAIL')
  const fifo = judgeSlot({ ordering: 'fifo', sent, feed: [row(1, 0), row(2, 1), row(3, 2), row(4, 3)] })
  assert.equal(fifo.verdict, 'FAIL')
  assert.match(fifo.reason, /fifo/)
})

test('judge: split rounds or a missing tx -> INCONCLUSIVE', () => {
  const split = judgeSlot({ ordering: 'pga', sent, feed: [row(3, 0, 7), row(2, 1, 7), row(1, 2, 7), row(4, 0, 8)] })
  assert.equal(split.verdict, 'INCONCLUSIVE')
  assert.match(split.reason, /did not share one round/)
  assert.equal(judgeSlot({ ordering: 'pga', sent, feed: [row(3, 0), row(4, 1)] }).verdict, 'INCONCLUSIVE')
})

test('judge: traffic in the round -> relative order only, no tx_index claim', () => {
  const traffic: SlotFeedRow = { hash: h(99), block: 7, index: 0, round: 1, timestampMs: T0 + 10_000 }
  const j = judgeSlot({ ordering: 'pga', sent, feed: [traffic, row(3, 1), row(4, 2), row(2, 3), row(1, 4)] })
  assert.equal(j.verdict, 'PASS')
  assert.equal(j.others, 1)
  assert.match(j.reason, /relative order/)
  assert.doesNotMatch(j.reason, /at index 1 of its round/)
})

test('B6b: in round 2 of a block the late tx\'s position is the index WITHIN the round, not tx_index', () => {
  const earlier = (n: number): SlotFeedRow => ({ hash: h(90 + n), block: 7, index: n, round: 1, timestampMs: T0 })
  const r2 = (n: number, index: number): SlotFeedRow => ({ ...row(n, index), round: 2 })
  const j = judgeSlot({ ordering: 'pga', sent, feed: [earlier(0), earlier(1), r2(3, 2), r2(4, 3), r2(2, 4), r2(1, 5)] })
  assert.equal(j.verdict, 'PASS')
  assert.equal(j.others, 0, 'other rounds of the block do not share OUR round')
  assert.match(j.reason, /at index 1 of its round \(tx_index 3\)/)
})

test('timeline fits 80 columns and shows send, feed ts, wait and tx_index', () => {
  const j = judgeSlot({ ordering: 'pga', sent, feed: pgaFeed })
  const lines = formatTimeline(j.rows!)
  for (const l of lines) assert.ok(l.length <= 80, `${l.length}: ${l}`)
  const first = lines.find((l) => l.startsWith('early 1'))!
  assert.match(first, /0\.001 +\+0\.00s +\+10\.00s +10\.00s +3$/)
  const late = lines.find((l) => l.startsWith('late'))!
  assert.match(late, /0\.05 +\+5\.00s +\+10\.00s +5\.00s +1$/)
})

test('closing line names the earliest arrival that came last and the late tx second; otherwise makes no claim', () => {
  const ok = closingLine(judgeSlot({ ordering: 'pga', sent, feed: pgaFeed }).rows!)
  assert.match(ok, /earliest arrival \(0\.001 gwei\) waited 10\.00s and still came last; the late 0\.05 gwei tx waited 5\.00s and came second.*the tip decided/)
  const fifo = closingLine(judgeSlot({ ordering: 'fifo', sent, feed: [row(1, 0), row(2, 1), row(3, 2), row(4, 3)] }).rows!)
  assert.doesNotMatch(fifo, /tip decided\./)
})
