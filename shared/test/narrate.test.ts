// The palette and printers: gating (TTY / NO_COLOR / FORCE_COLOR), each printer's prefix and style, NOTE: never doubled.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  color, colorEnabled, error, feedServer, important, internal, note, noteLines, noteText, warn, warnText, PALETTE, plain, RESET, result, sequencerAlways, setInternalVisible, step, style, verdictKind, verdictOfCode,
} from '../narrate.ts'

test('colorEnabled: TTY and non-TTY with no variables', () => {
  assert.equal(colorEnabled(true, {}), true)
  assert.equal(colorEnabled(false, {}), false)
  assert.equal(colorEnabled(undefined, {}), false)
})

test('colorEnabled: NO_COLOR (any non-empty value) turns colour off, and beats FORCE_COLOR', () => {
  assert.equal(colorEnabled(true, { NO_COLOR: '1' }), false)
  assert.equal(colorEnabled(true, { NO_COLOR: 'anything' }), false)
  assert.equal(colorEnabled(true, { NO_COLOR: '1', FORCE_COLOR: '1' }), false)
  assert.equal(colorEnabled(false, { NO_COLOR: '1', FORCE_COLOR: '1' }), false)
  assert.equal(colorEnabled(true, { NO_COLOR: '' }), true, 'an empty NO_COLOR counts as unset')
})

test('colorEnabled: FORCE_COLOR forces colour on a non-TTY, except "", 0 and false (which also switch it off on a TTY)', () => {
  assert.equal(colorEnabled(false, { FORCE_COLOR: '1' }), true)
  assert.equal(colorEnabled(false, { FORCE_COLOR: 'true' }), true)
  assert.equal(colorEnabled(false, { FORCE_COLOR: '' }), false)
  assert.equal(colorEnabled(false, { FORCE_COLOR: '0' }), false)
  assert.equal(colorEnabled(false, { FORCE_COLOR: 'false' }), false)
  assert.equal(colorEnabled(true, { FORCE_COLOR: '0' }), false, 'FORCE_COLOR=0 / false disable colour even on a TTY')
  assert.equal(colorEnabled(true, { FORCE_COLOR: 'false' }), false)
  assert.equal(colorEnabled(true, { FORCE_COLOR: '1' }), true)
  assert.equal(colorEnabled(true, { FORCE_COLOR: '' }), true, 'empty counts as unset: the TTY decides')
})

function capture(fn: () => void, env: Record<string, string | undefined>): { out: string[]; err: string[] } {
  const saved: Record<string, string | undefined> = {}
  for (const k of ['NO_COLOR', 'FORCE_COLOR']) saved[k] = process.env[k]
  for (const k of ['NO_COLOR', 'FORCE_COLOR']) delete process.env[k]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const errFn = console.error
  console.log = (...a: unknown[]) => void out.push(a.join(' '))
  console.error = (...a: unknown[]) => void err.push(a.join(' '))
  try {
    fn()
  } finally {
    console.log = log
    console.error = errFn
    for (const k of ['NO_COLOR', 'FORCE_COLOR']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
  return { out, err }
}

const ESC = /\x1b\[/

test('style and color: the exact codes, and no codes unless enabled', () => {
  assert.equal(style('step', 'x'), `\x1b[36mx${RESET}`)
  assert.equal(color('step', 'x', false), 'x')
  assert.equal(color('step', 'x', true), `\x1b[36mx${RESET}`)
  assert.equal(color('step', '', true), '', 'an empty line gets no escapes')
  assert.deepEqual(
    { ...PALETTE },
    { internal: '\x1b[35m', step: '\x1b[36m', important: '\x1b[1;7m', note: '\x1b[33m', warn: '\x1b[1;33m', pass: '\x1b[1;32m', fail: '\x1b[1;31m', inconclusive: '\x1b[1;33m', error: '\x1b[31m', bold: '\x1b[1m' },
  )
})

test('printers, colour forced on: prefix and style of each kind', () => {
  setInternalVisible(true)
  const r = capture(() => {
    step('buying 1 ticket')
    note('a ticket bought in round N is active in round N+1 only')
    important('YOUR TX: idx 0')
    internal('round 2: drained order')
    sequencerAlways('FEED RECEIPT MISMATCH block 3', true)
    feedServer('round ended')
    plain('table row')
    result('PASS', 'PASS x')
    result('FAIL', 'FAIL x')
    result('INCONCLUSIVE', 'INCONCLUSIVE x')
    error('401: no active ticket')
  }, { FORCE_COLOR: '1' })
  setInternalVisible(false)
  assert.deepEqual(r.out, [
    `\x1b[36m==> buying 1 ticket${RESET}`,
    `\x1b[33mNOTE: a ticket bought in round N is active in round N+1 only${RESET}`,
    `\x1b[1;7mYOUR TX: idx 0${RESET}`,
    `\x1b[35m[sequencer] round 2: drained order${RESET}`,
    `\x1b[31m[sequencer] FEED RECEIPT MISMATCH block 3${RESET}`,
    `\x1b[35m[feed] round ended${RESET}`,
    'table row',
    `\x1b[1;32mPASS x${RESET}`,
    `\x1b[1;31mFAIL x${RESET}`,
    `\x1b[1;33mINCONCLUSIVE x${RESET}`,
  ])
  assert.deepEqual(r.err, [`\x1b[31m401: no active ticket${RESET}`])
})

test('printers, colour off (non-TTY, or NO_COLOR even with FORCE_COLOR): plain text, same prefixes', () => {
  for (const env of [{}, { NO_COLOR: '1' }, { NO_COLOR: '1', FORCE_COLOR: '1' }]) {
    setInternalVisible(true)
    const r = capture(() => {
      step('a')
      note('b')
      important('c')
      internal('d')
      result('PASS', 'e')
      error('f')
    }, env)
    setInternalVisible(false)
    assert.deepEqual(r.out, ['==> a', 'NOTE: b', 'c', '[sequencer] d', 'e'])
    assert.deepEqual(r.err, ['f'])
    assert.ok(![...r.out, ...r.err].some((l) => ESC.test(l)))
  }
})

test('internal() prints nothing unless the sequencer narration is visible', () => {
  setInternalVisible(false)
  assert.deepEqual(capture(() => internal('hidden'), { FORCE_COLOR: '1' }).out, [])
})

test('warn(): bold yellow WARNING: on stdout, one prefix, plain when colour is off', () => {
  assert.equal(warnText('x'), 'WARNING: x')
  assert.equal(warnText('WARNING: x'), 'WARNING: x')
  assert.equal(warnText('warning:   x'), 'WARNING: x')
  const on = capture(() => warn('careful'), { FORCE_COLOR: '1' })
  assert.deepEqual(on.out, [`\x1b[1;33mWARNING: careful${RESET}`])
  assert.deepEqual(on.err, [])
  assert.deepEqual(capture(() => warn('careful'), {}).out, ['WARNING: careful'])
  assert.deepEqual(capture(() => noteLines(['NOTE: a', '      b']), { FORCE_COLOR: '1' }).out, [`\x1b[33mNOTE: a${RESET}`, `\x1b[33m      b${RESET}`])
})

test('note(): always starts with NOTE:, never doubled', () => {
  assert.equal(noteText('hello'), 'NOTE: hello')
  assert.equal(noteText('NOTE: hello'), 'NOTE: hello')
  assert.equal(noteText('NOTE:   hello'), 'NOTE: hello')
  assert.equal(noteText('  NOTE: hello'), 'NOTE: hello')
  assert.equal(noteText('  block = 2000ms'), 'NOTE:   block = 2000ms', 'indentation after the prefix is kept')
  const r = capture(() => {
    note('NOTE: x')
    note('y')
  }, {})
  assert.deepEqual(r.out, ['NOTE: x', 'NOTE: y'])
})

test('verdict kinds and exit codes', () => {
  assert.equal(verdictKind('PASS'), 'pass')
  assert.equal(verdictKind('FAIL'), 'fail')
  assert.equal(verdictKind('INCONCLUSIVE'), 'inconclusive')
  assert.deepEqual([0, 1, 2, 3].map(verdictOfCode), ['PASS', 'FAIL', 'FAIL', 'INCONCLUSIVE'])
})
