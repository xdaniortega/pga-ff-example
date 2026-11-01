// Unit tests: the code -> explanation map, the reconnect policy, the backoff schedule and the rejection hints.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { backoffMs, closeLines, explainFeedCode, FEED_CODES, rejectionLines, shouldReconnect } from '../client/client.ts'

test('the explanation map covers all 7 documented codes, each with a cause and a fix', () => {
  assert.deepEqual(
    Object.values(FEED_CODES).filter((c) => !c.local).map((c) => c.code).sort((a, b) => a - b),
    [401, 426, 429, 1003, 1008, 1011, 1013],
  )
  assert.equal(FEED_CODES[503]!.local, true, '503 is a local-simulator code, outside the docs table')
  for (const code of [401, 429, 426, 1008, 1013, 1003, 1011]) {
    const info = explainFeedCode(code)!
    assert.equal(info.code, code)
    assert.ok(info.name.length > 0 && info.cause.length > 10 && info.fix.length > 5, `code ${code}`)
    assert.equal(info.kind, code < 1000 ? 'http' : 'close')
  }
  assert.equal(explainFeedCode(500), undefined)
})

test('shouldReconnect: retry 401, 429, 1008, 1011, 1013 and a lost connection; never 1003 or 426', () => {
  for (const c of [401, 429, 503, 1008, 1011, 1013, 1006, undefined]) assert.equal(shouldReconnect(c), true, String(c))
  for (const c of [1003, 426, 500, 1000]) assert.equal(shouldReconnect(c), false, String(c))
})

test('backoffMs: 1s doubling to a 30s cap; jitter stays between half the step and the step', () => {
  const top = [0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffMs(n, 0.999999))
  assert.deepEqual(top, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  const low = [0, 1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, 0))
  assert.deepEqual(low, [500, 1000, 2000, 4000, 8000, 15000, 15000])
  for (let n = 0; n < 12; n++) {
    const w = backoffMs(n)
    assert.ok(w >= Math.min(30_000, 1000 * 2 ** n) / 2 && w <= 30_000)
  }
})

test('closeLines: 1008 says "closed 1008 (ticket expired). Renew: ..." with the preset network flag', () => {
  const l = closeLines(1008, 'authentication expired', 'npm run tickets:buy -- --local')
  assert.equal(l[0], 'closed 1008 (ticket expired). Renew: npm run tickets:buy -- --local')
  assert.ok(l.some((x) => x.includes('authentication expired')))
  assert.equal(closeLines(1013, 'client lagged', 'x')[0], `closed 1013 (client lagged). ${FEED_CODES[1013]!.fix}`)
  assert.match(closeLines(1011, '', 'x')[0]!, /^closed 1011 \(server shutting down\)\. Reconnect with a short backoff\./)
  assert.match(closeLines(1003, '', 'x')[0]!, /^closed 1003 \(unexpected client message\)/)
  assert.match(closeLines(1006, '', 'x')[0]!, /^closed 1006/)
})

test('rejectionLines: 401/429/426 are explained; simulator hints appear only for --local', () => {
  const unknown = 'no active ticket\nunknown key: no ticket was bought for this key. Buy one with npm run tickets:buy.\n'
  const local = rejectionLines(401, unknown, '--local').join('\n')
  assert.match(local, /^401 Unauthorized: no active ticket/)
  assert.match(local, /npm run sim/)
  assert.match(local, /restarted simulator starts a fresh chain/)
  const testnet = rejectionLines(401, unknown, '--testnet').join('\n')
  assert.doesNotMatch(testnet, /npm run sim|simulator/)
  assert.match(testnet, /tickets:buy -- --testnet/)
  assert.match(rejectionLines(429, 'connections ≥ tickets (1 open, 1 active ticket)\n', '--local').join('\n'), /^429 Too Many Requests: connections ≥ tickets[\s\S]*Close a connection, or buy more tickets/)
  assert.match(rejectionLines(426, 'Upgrade Required', '--local').join('\n'), /Use a WebSocket client/)
  assert.match(rejectionLines(401, 'no active ticket\nticket expired: x\n', '--local').join('\n'), /one round only/)
})

test('the docs error table and FEED_CODES agree: same codes, same cause and fix text', () => {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const rows = md
    .split('\n')
    .map((l) => /^\|\s*(?:HTTP (\d{3})[^|]*|Close (\d{4})[^|]*)\|([^|]+)\|([^|]+)\|\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
  assert.equal(rows.length, 7, 'the table has 7 rows')
  for (const m of rows) {
    const code = Number(m[1] ?? m[2])
    const info = FEED_CODES[code]
    assert.ok(info, `code ${code} is in FEED_CODES`)
    assert.equal(m[3]!.trim(), info.cause, `cause of ${code}`)
    assert.equal(m[4]!.trim(), info.fix, `fix of ${code}`)
  }
})
