// C7: the demo's TTY panel renderer (redraw in place, cursor restored on every exit path), slow motion for a paused run,
// and when the panel may be drawn. No network: a fake stream and a fake process.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { attachedStackLines, HIDE_CURSOR, panelAllowed, PanelRenderer, SHOW_CURSOR, wantSlowmo } from '../demo.ts'

/** A frame as the renderer draws it on this 24-row fake terminal: padded with blank lines to rows - 1 = 23. */
const padded = (lines: string[]) => [...lines, ...Array<string>(23 - lines.length).fill('')]

function fake() {
  const writes: string[] = []
  const stream = { columns: 80, rows: 24, write: (s: string) => void writes.push(s) }
  let t = 1_000
  const frames: string[][] = [['a', 'b']]
  const proc = new EventEmitter()
  const r = new PanelRenderer({ stream, proc, now: () => t, intervalMs: 100, frame: () => frames[0]! })
  return { writes, r, proc, advance: (ms: number) => (t += ms), setFrame: (f: string[]) => (frames[0] = f) }
}

test('PanelRenderer: hides the cursor, draws, redraws in place (cursor up, clear), at most every 100ms', () => {
  const f = fake()
  f.r.start()
  assert.equal(f.writes[0], HIDE_CURSOR)
  assert.equal(f.writes[1], `${padded(['a', 'b']).join('\n')}\n`, 'first frame: no cursor move, padded to the fixed height')
  f.r.draw() // same instant: throttled
  assert.equal(f.writes.length, 2)
  f.advance(99)
  f.r.draw()
  assert.equal(f.writes.length, 2, 'under 100ms: no frame')
  f.advance(1)
  f.setFrame(['x', 'y', 'z'])
  f.r.draw()
  assert.equal(f.writes[2], `\x1b[23A\r\x1b[J${padded(['x', 'y', 'z']).join('\n')}\n`, 'moves up over the 23 previous lines, clears, redraws')
  f.advance(100)
  f.r.draw()
  assert.ok(f.writes[3]!.startsWith('\x1b[23A\r\x1b[J'), 'the next frame moves up over the same 23 lines')
  f.r.stop()
})

test('PanelRenderer: a normal end draws the last frame and shows the cursor; stop twice is safe', () => {
  const f = fake()
  f.r.start()
  f.advance(500)
  f.setFrame(['final'])
  f.r.stop()
  assert.equal(f.writes.at(-1), SHOW_CURSOR)
  assert.ok(f.writes.at(-2)!.includes('final'), 'the last frame is drawn before the cursor comes back')
  const n = f.writes.length
  f.r.stop()
  f.r.draw(true)
  assert.equal(f.writes.length, n, 'nothing after stop')
  assert.equal(f.r.running, false)
  assert.equal(f.proc.listenerCount('SIGINT') + f.proc.listenerCount('SIGTERM') + f.proc.listenerCount('exit'), 0, 'signal listeners removed')
})

test('PanelRenderer: SIGINT, SIGTERM and process exit restore the cursor (the output ends with the show-cursor sequence)', () => {
  for (const ev of ['SIGINT', 'SIGTERM', 'exit']) {
    const f = fake()
    f.r.start()
    f.advance(200)
    f.proc.emit(ev)
    assert.equal(f.writes.at(-1), SHOW_CURSOR, ev)
    assert.equal(f.writes.at(-1), '\x1b[?25h')
    assert.equal(f.r.running, false)
  }
})

test('PanelRenderer: a frame that throws keeps the previous frame, and stop() still restores the cursor', () => {
  const writes: string[] = []
  let boom = false
  const r = new PanelRenderer({ stream: { write: (s) => void writes.push(s) }, frame: () => { if (boom) throw new Error('boom'); return ['ok'] }, intervalMs: 0 })
  r.start()
  boom = true
  assert.doesNotThrow(() => r.draw(true))
  r.stop()
  assert.equal(writes.at(-1), SHOW_CURSOR)
})

test('PanelRenderer: frame errors are counted and one note line is printed after stop()', () => {
  const logs: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => void logs.push(a.join(' '))
  try {
    const writes: string[] = []
    let boom = false
    const r = new PanelRenderer({ stream: { write: (s) => void writes.push(s) }, frame: () => { if (boom) throw new Error('boom'); return ['ok'] }, intervalMs: 0 })
    r.start()
    boom = true
    r.draw(true)
    r.draw(true)
    assert.equal(logs.length, 0, 'nothing printed while drawing')
    r.stop() // stop() draws once more: a third error
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /3 frame\(s\).*boom/)
    assert.equal(writes.at(-1), SHOW_CURSOR)
  } finally {
    console.log = orig
  }
})

test('panelAllowed: a terminal that is not dumb; NO_COLOR does not matter (cursor movement is not colour)', () => {
  assert.equal(panelAllowed(true, { TERM: 'xterm-256color' }), true)
  assert.equal(panelAllowed(true, { NO_COLOR: '1', TERM: 'xterm' }), true)
  assert.equal(panelAllowed(true, {}), true)
  assert.equal(panelAllowed(true, { TERM: 'dumb' }), false)
  assert.equal(panelAllowed(false, {}), false)
  assert.equal(panelAllowed(undefined, {}), false)
})

test('wantSlowmo: only for --pause on terminals, unless DEMO_SLOWMO=0 or the user already chose a block time', () => {
  const base = { pause: true, stdinTTY: true, stdoutTTY: true, env: {} as NodeJS.ProcessEnv }
  assert.equal(wantSlowmo(base), true)
  assert.equal(wantSlowmo({ ...base, pause: false }), false, 'the hands-off demo keeps the default preset')
  assert.equal(wantSlowmo({ ...base, stdinTTY: false }), false, '--pause ignored: nobody to press Enter')
  assert.equal(wantSlowmo({ ...base, stdoutTTY: false }), false)
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) assert.equal(wantSlowmo({ ...base, env: { DEMO_SLOWMO: v } }), false, `DEMO_SLOWMO=${v}`)
  assert.equal(wantSlowmo({ ...base, env: { DEMO_SLOWMO: '1' } }), true)
  assert.equal(wantSlowmo({ ...base, env: { SIM_BLOCK_MS: '4000' } }), false, 'the user chose B')
  assert.equal(wantSlowmo({ ...base, env: { SIM_SLOWMO: '1' } }), false, 'already slow motion: nothing to add')
})

test('attachedStackLines: its block and round times, plus the slow-motion hint unless it already is slow motion', () => {
  const slow = attachedStackLines({ blockMs: 2000, roundMs: 1000, k: 2, slowmo: false })
  assert.match(slow[0]!, /blocks of 2000ms and PGA rounds of 1000ms \(K = 2/)
  assert.equal(slow[1], 'for the slow-motion view restart the simulator with npm run sim -- --slowmo')
  assert.equal(attachedStackLines({ blockMs: 25_000, roundMs: 12_500, k: 2, slowmo: true }).length, 1)
})

test('Q2 PanelRenderer: the frame height never grows after the first frame (no scrollback debris); the last frame is not padded', () => {
  const f = fake()
  f.r.start()
  const heights: number[] = []
  const lines = (w: string) => w.split('\n').length - 1
  heights.push(lines(f.writes[1]!))
  for (const n of [1, 5, 12, 40, 3]) {
    f.advance(100)
    f.setFrame(Array.from({ length: n }, (_, i) => `l${i}`))
    f.r.draw()
    const w = f.writes.at(-1)!
    heights.push(lines(w))
    assert.ok(w.startsWith('\x1b[23A'), 'always moves up by the same height')
  }
  assert.deepEqual(heights, [23, 23, 23, 23, 23, 23], 'taller frames are cut, shorter ones padded: always 23 lines')
  f.advance(100)
  f.setFrame(['end'])
  f.r.stop()
  assert.equal(f.writes.at(-2), '\x1b[23A\r\x1b[Jend\n', 'the final frame is drawn unpadded')
})

test('E1 review: rows are re-read each frame (a shrunk terminal shrinks the frame); a cut trims the body before the tail (the prompt)', () => {
  const writes: string[] = []
  const stream = { columns: 80, rows: 24, write: (s: string) => void writes.push(s) }
  let t = 0
  const body = Array.from({ length: 30 }, (_, i) => `body${i}`)
  const frame = [...body, '', 'NOTE: block is open', 'PROMPT press Enter']
  const r = new PanelRenderer({ stream, now: () => t, intervalMs: 0, frame: () => frame, tailLines: () => 3 })
  r.start()
  const drawn = (w: string) => w.replace(/^\x1b\[\d+A\r\x1b\[J/, '').split('\n').slice(0, -1)
  assert.equal(drawn(writes[1]!).length, 23)
  assert.equal(drawn(writes[1]!).at(-1), 'PROMPT press Enter', 'the prompt survives the cut')
  stream.rows = 12
  t += 10
  r.draw()
  const small = drawn(writes.at(-1)!)
  assert.equal(small.length, 11, 'height = rows - 1 after the terminal shrank')
  assert.equal(small.at(-1), 'PROMPT press Enter')
  assert.equal(small.at(-3), '', 'the status lines are kept whole')
  assert.equal(small[0], 'body0')
  stream.rows = 40
  t += 10
  r.draw()
  assert.equal(drawn(writes.at(-1)!).length, 11, 'the height never grows back')
  r.stop()
})

test('E3: the block story under the panel (pinned headers, the latest steps, the prompt) survives a short terminal; the body is trimmed first', () => {
  const writes: string[] = []
  const stream = { columns: 80, rows: 16, write: (s: string) => void writes.push(s) }
  const body = Array.from({ length: 20 }, (_, i) => `row${i}`)
  const story = [
    'block 17 — 250 ms on Arbitrum One (here 25 s)',
    'round 1 — 125 ms on Arbitrum One (here 12.5 s) · 4 txs',
    'NOTE: Process slowed down for the demo: inserting a transaction with a bigger',
    '      tip in round 2',
    'Press Enter: insert your 1 gwei tx into round 2 of block 17',
  ]
  const r = new PanelRenderer({ stream, now: () => 0, intervalMs: 0, frame: () => [...body, '', ...story], tailLines: () => story.length + 1 })
  r.start()
  const drawn = writes[1]!.replace(/^\x1b\[\d+A\r\x1b\[J/, '').split('\n').slice(0, -1)
  assert.equal(drawn.length, 15, 'rows - 1')
  assert.deepEqual(drawn.slice(-story.length), story, 'every story line is kept, the prompt last')
  assert.equal(drawn[0], 'row0', 'the body is cut from its end')
  r.stop()
})
