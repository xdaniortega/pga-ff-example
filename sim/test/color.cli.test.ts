// CLI smoke: piped output (non-TTY) has no ANSI escapes, FORCE_COLOR=1 forces them, NO_COLOR beats FORCE_COLOR.
// The banner, one line of every kind (helpers/print-banner.ts), a usage error of `npm run pga`, and the sim banner's NOTE: rule.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'

const ESC = /\x1b\[/

function run(script: string, args: string[], extra: Record<string, string>): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ENV_FILE: '/nonexistent', ...extra }
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  Object.assign(env, extra)
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', script, ...args], { env, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    )
  })
}

const HELPER = 'sim/test/helpers/print-banner.ts'

test('banner and every printer, piped: no escapes, and every banner line starts with NOTE:', async () => {
  const r = await run(HELPER, [], {})
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, ESC)
  const lines = r.out.split('\n').filter((l) => l !== '')
  const banner = lines.slice(0, lines.indexOf('==> buying 1 ticket'))
  assert.ok(banner.length > 10)
  for (const l of banner) assert.match(l, /^NOTE: /, `banner line without NOTE: ${l}`)
  assert.ok(banner.every((l) => !l.startsWith('NOTE: NOTE:')))
  assert.ok(lines.includes('==> buying 1 ticket'))
  assert.ok(lines.includes('[sequencer] round 2: drained order'))
})

test('FORCE_COLOR=1 forces escapes on a pipe: each kind has its code', async () => {
  const r = await run(HELPER, [], { FORCE_COLOR: '1' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /\x1b\[36m==> buying 1 ticket\x1b\[0m/)
  assert.match(r.out, /\x1b\[33m\x1b\[1mNOTE:\x1b\[0m\x1b\[33m a ticket bought/)
  assert.match(r.out, /\x1b\[1;7mYOUR TX: idx 0 +\x1b\[0m/, 'an important line is padded to a full-width bar when colour is on')
  assert.match(r.out, /\x1b\[35m\[sequencer\] round 2/)
  assert.match(r.out, /\x1b\[1;32mScenario 1: PASS/)
  assert.match(r.out, /\x1b\[1;31mScenario 2: FAIL/)
  assert.match(r.out, /\x1b\[1;33mScenario 3: INCONCLUSIVE/)
  assert.match(r.out, /\x1b\[31m401: no active ticket/)
  assert.match(r.out, /\na table row\n/, 'tables stay in the default colour')
})

test('NO_COLOR beats FORCE_COLOR', async () => {
  const r = await run(HELPER, [], { FORCE_COLOR: '1', NO_COLOR: '1' })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, ESC)
})

test('npm run pga usage error: red on stderr only when forced, plain when piped', async () => {
  const plain = await run('pga/bot/bot.ts', ['--bogus'], {})
  assert.equal(plain.code, 2, plain.out)
  assert.match(plain.out, /Usage: npm run pga/)
  assert.doesNotMatch(plain.out, ESC)
  const forced = await run('pga/bot/bot.ts', ['--bogus'], { FORCE_COLOR: '1' })
  assert.equal(forced.code, 2)
  assert.match(forced.out, /\x1b\[31mUsage: npm run pga/)
})
