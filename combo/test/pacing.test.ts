// F6: the display-only pacing of the Fast Feed tables: the plan, the env switch, the pacer with a fake clock, abort and the one NOTE.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { noteBlock } from '../scenarios.ts'
import { PACING_NOTE, RowPacer, ROW_PACE_FIRST, ROW_PACE_FIRST_GAP_MS, ROW_PACE_REST_GAP_MS, abortableSleep, revealPlan, rowPacingEnabled } from '../pacing.ts'

test('F6 constants: 3 rows, 1000 ms, 500 ms', () => {
  assert.deepEqual([ROW_PACE_FIRST, ROW_PACE_FIRST_GAP_MS, ROW_PACE_REST_GAP_MS], [3, 1000, 500])
})

test('F6 revealPlan: 0, 1, 3 at once; 4 = 3 then 1 after 1 s; 5 = 3, 1, 1; 10 = 3 + 1 + 6', () => {
  assert.deepEqual(revealPlan(0), [])
  assert.deepEqual(revealPlan(1), [{ count: 1, delayMs: 0 }])
  assert.deepEqual(revealPlan(3), [{ count: 3, delayMs: 0 }])
  assert.deepEqual(revealPlan(4), [{ count: 3, delayMs: 0 }, { count: 1, delayMs: 1000 }])
  assert.deepEqual(revealPlan(5), [{ count: 3, delayMs: 0 }, { count: 1, delayMs: 1000 }, { count: 1, delayMs: 500 }])
  assert.deepEqual(revealPlan(10), [{ count: 3, delayMs: 0 }, { count: 1, delayMs: 1000 }, { count: 6, delayMs: 500 }])
  for (const n of [0, 1, 2, 3, 4, 5, 9, 10, 40]) assert.equal(revealPlan(n).reduce((a, g) => a + g.count, 0), n)
})

test('F6 rowPacingEnabled: only on a TTY, DEMO_ROW_PACING=0 turns it off, any other value is on, never an error', () => {
  assert.equal(rowPacingEnabled(true, {}), true)
  assert.equal(rowPacingEnabled(false, {}), false)
  assert.equal(rowPacingEnabled(undefined, {}), false)
  assert.equal(rowPacingEnabled(true, { DEMO_ROW_PACING: '0' }), false)
  assert.equal(rowPacingEnabled(true, { DEMO_ROW_PACING: ' 0 ' }), false)
  for (const v of ['1', 'yes', 'off', 'banana', '']) assert.equal(rowPacingEnabled(true, { DEMO_ROW_PACING: v }), true, v)
  assert.equal(rowPacingEnabled(false, { DEMO_ROW_PACING: '1' }), false, 'a pipe is never paced')
})

const fakeSleep = (log: string[]) => async (ms: number) => void log.push(`sleep:${ms}`)

test('F6 RowPacer.reveal: groups in order with delays 1000 then 500; disabled or <= 3 rows: one call, no wait', async () => {
  const log: string[] = []
  const p = new RowPacer({ enabled: true, sleep: fakeSleep(log) })
  await p.reveal(10, (n) => void log.push(`show:${n}`))
  assert.deepEqual(log, ['show:3', 'sleep:1000', 'show:4', 'sleep:500', 'show:10'])
  log.length = 0
  await p.reveal(3, (n) => void log.push(`show:${n}`))
  assert.deepEqual(log, ['show:3'])
  log.length = 0
  await new RowPacer({ enabled: false, sleep: fakeSleep(log) }).reveal(10, (n) => void log.push(`show:${n}`))
  assert.deepEqual(log, ['show:10'])
})

test('F6 RowPacer.printLines: header first, rows in groups, text identical to the unpaced print, the line after the table last', async () => {
  const log: string[] = []
  const input = [{ text: 'FF' }, { text: 'round hdr' }, { text: 'col hdr' }, ...Array.from({ length: 10 }, (_, i) => ({ text: `row${i}`, row: true as const })), { text: 'right' }]
  const paced = new RowPacer({ enabled: true, sleep: fakeSleep(log) })
  await paced.printLines(input, (l) => void log.push(l.text), () => log.push('NOTE'))
  assert.deepEqual(log, ['FF', 'NOTE', 'round hdr', 'col hdr', 'row0', 'row1', 'row2', 'sleep:1000', 'row3', 'sleep:500', 'row4', 'row5', 'row6', 'row7', 'row8', 'row9', 'right'])
  const off: string[] = []
  await new RowPacer({ enabled: false, sleep: fakeSleep(off) }).printLines(input, (l) => void off.push(l.text), () => off.push('NOTE'))
  assert.deepEqual(off, input.map((l) => l.text), 'pacing off: the same lines, at once, no NOTE')
})

test('F6 the NOTE is announced once, only when pacing is on and a table really is paced', () => {
  const log: string[] = []
  const p = new RowPacer({ enabled: true, sleep: fakeSleep(log) })
  p.announce(3, () => log.push('n'))
  assert.equal(log.length, 0, 'a table of 3 rows is not paced')
  p.announce(4, () => log.push('n'))
  p.announce(10, () => log.push('n'))
  assert.deepEqual(log, ['n'])
  const off = new RowPacer({ enabled: false })
  off.announce(10, () => log.push('x'))
  assert.deepEqual(log, ['n'])
  assert.match(PACING_NOTE, /^Rows appear with exaggerated pacing/)
  const wrapped = noteBlock(PACING_NOTE)
  assert.equal(wrapped.filter((l) => l.startsWith('NOTE:')).length, 1, 'exactly one NOTE prefix')
  assert.ok(wrapped.every((l) => l.length <= 80))
})

test('F6 abort: a pending reveal resolves promptly with no further rows; nothing after the table prints', async () => {
  const ac = new AbortController()
  const shown: number[] = []
  const p = new RowPacer({ enabled: true, signal: ac.signal }) // the real abortable sleep
  const t0 = Date.now()
  const done = p.reveal(10, (n) => void shown.push(n))
  await new Promise((r) => setTimeout(r, 50))
  ac.abort()
  await done
  assert.ok(Date.now() - t0 < 500, 'did not wait out the 1 s delay')
  assert.deepEqual(shown, [3])
  const out: string[] = []
  const ac2 = new AbortController()
  const p2 = new RowPacer({ enabled: true, signal: ac2.signal })
  const run = p2.printLines([{ text: 'a' }, { text: 'b' }, { text: 'c' }, ...Array.from({ length: 6 }, (_, i) => ({ text: `r${i}`, row: true as const })), { text: 'after' }], (l) => void out.push(l.text), () => {})
  await new Promise((r) => setTimeout(r, 50))
  ac2.abort()
  await run
  assert.deepEqual(out, ['a', 'b', 'c', 'r0', 'r1', 'r2'])
  // already aborted: sleeping returns at once
  const t1 = Date.now()
  await abortableSleep(5000, ac.signal)
  assert.ok(Date.now() - t1 < 100)
})

test('F6 RowPacer.when: the unheld flow never paces (no sleeps, no NOTE), the held flow keeps the pacer', async () => {
  const log: string[] = []
  const p = new RowPacer({ enabled: true, sleep: fakeSleep(log) })
  assert.equal(p.when(true), p)
  const off = p.when(false)
  assert.equal(off.enabled, false)
  off.announce(10, () => log.push('note'))
  await off.reveal(10, (n) => void log.push(`show:${n}`))
  assert.deepEqual(log, ['show:10'])
  assert.equal(p.when(true).enabled, true, 'the original pacer is untouched')
  assert.equal(new RowPacer({ enabled: false }).when(true).enabled, false)
})
