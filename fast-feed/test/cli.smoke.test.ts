// Spawn-based smoke tests: run the REAL entry points (key:new, tickets:*, feed) against an in-process stack,
// capture stdout and stderr, and assert the runtime-generated raw key never appears.
// ENV_FILE points the commands at a temp env file, so the repo .env is never read or written.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { localPreset, resolvePreset } from '../../shared/config.ts'
import { apiKeyHash, generateKey } from '../client/key.ts'
import { approve, deposit, makeCtx, mintLocal, readRound, type TicketsCtx } from '../client/tickets.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

const env: NodeJS.ProcessEnv = {
  ...process.env,
  SIM_RPC_PORT: '28947',
  SIM_FEED_PORT: '29942',
  SIM_ANVIL_PORT: '28945',
  TICKET_ROUND_SECONDS: '40',
  FEED_AUTH: 'on',
}
delete env.PRIVATE_KEY
delete env.FEED_API_KEY
const preset = localPreset('slow', env)
const dir = mkdtempSync(join(tmpdir(), 'cli-smoke-'))
const envFile = join(dir, 'env')
const envFile2 = join(dir, 'env2')

let stack: Stack
let ctx: TicketsCtx
const seen: string[] = [] // every byte the child processes printed

const RUN_LIMIT_MS = 30_000 // a command that has not finished by then is killed and the test fails
const LINGER_MS = 3_000 // a feed that printed 401, 429 or `connected` gets this long to exit by itself, then is killed

function run(
  script: string,
  args: string[],
  file = envFile,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      env: { ...env, ...extraEnv, ENV_FILE: file },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let lingering = false
    const limit = setTimeout(() => {
      child.kill('SIGKILL')
      seen.push(out)
      reject(new Error(`${script} ${args.join(' ')} did not finish within ${RUN_LIMIT_MS}ms. Output so far:\n${out}`))
    }, RUN_LIMIT_MS)
    const onData = (d: Buffer) => {
      out += d
      // A feed child must never outlive its test: once it reached a verdict (401, 429 or connected) it is killed.
      if (script === FEED_CLI && !lingering && /\b(401|429) |==> connected/.test(out)) {
        lingering = true
        setTimeout(() => child.kill('SIGKILL'), LINGER_MS).unref()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', (e) => {
      clearTimeout(limit)
      reject(e)
    })
    child.once('close', (code) => {
      clearTimeout(limit)
      seen.push(out)
      resolve({ code, out })
    })
  })
}
const KEY_CLI = 'fast-feed/client/key.ts'
const TICKETS_CLI = 'fast-feed/client/tickets-cli.ts'
const FEED_CLI = 'fast-feed/client/feed.ts'
const keyFromFile = (f: string) => /^FEED_API_KEY=(.+)$/m.exec(readFileSync(f, 'utf8'))![1]!

before(async () => {
  buildContracts()
  stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
  ctx = makeCtx(await resolvePreset(preset), env)
}, { timeout: 60_000 })

after(async () => {
  await stack?.stop()
  rmSync(dir, { recursive: true, force: true }) // the temp env files hold a throwaway key; remove them
})

test('key:new writes the temp env file (0600), prints only the hash; a second run needs --force', async () => {
  const a = await run(KEY_CLI, [])
  assert.equal(a.code, 0)
  const key = keyFromFile(envFile)
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.ok(a.out.includes(apiKeyHash(key)), 'prints keccak256(key)')
  assert.ok(!a.out.includes(key), 'never prints the raw key')
  assert.equal(statSync(envFile).mode & 0o777, 0o600)
  const b = await run(KEY_CLI, [])
  assert.equal(b.code, 1)
  assert.match(b.out, /--force/)
  const c = await run(KEY_CLI, ['--force'])
  assert.equal(c.code, 0)
  assert.notEqual(keyFromFile(envFile), key)
  assert.ok(!c.out.includes(keyFromFile(envFile)))
})

test('tickets:buy, feed 401 (not active yet / unknown key), tickets:status, partial and full tickets:withdraw', async () => {
  const key = keyFromFile(envFile)
  // Extra deposit so there is something left to withdraw after the purchase.
  await mintLocal(ctx, 3_000_000n)
  await approve(ctx, 3_000_000n)
  await deposit(ctx, 3_000_000n)

  // Fresh-round guard: the early feed spawn below must run inside the purchase round, so buy only with >= 20s left.
  const freshBy = Date.now() + 60_000
  for (;;) {
    const r = await readRound(ctx)
    if (r.roundEnd - BigInt(r.now) >= 20n) break
    assert.ok(Date.now() < freshBy, 'no fresh ticket round within 60s')
    await new Promise((res) => setTimeout(res, 250))
  }
  const buy = await run(TICKETS_CLI, ['buy', '--local', '--tickets', '1'])
  assert.equal(buy.code, 0, buy.out)
  assert.match(buy.out, /LOCAL: ticket round = 40s \(Arbitrum One: 24h\)/)
  assert.match(buy.out, /access starts at/)

  // Before activation (same round): 401 with a reason that fits.
  const early = await run(FEED_CLI, ['--local'])
  assert.notEqual(early.code, 0)
  assert.match(early.out, /401 Unauthorized: no active ticket/)
  assert.match(early.out, /not active yet/)
  assert.match(early.out, /Access starts when the purchase round ends/)

  // Unknown key: the hint must not claim "access starts when the round ends".
  writeFileSync(envFile2, `FEED_API_KEY=${generateKey()}\n`)
  const unknown = await run(FEED_CLI, ['--local'], envFile2)
  assert.notEqual(unknown.code, 0)
  assert.match(unknown.out, /401 Unauthorized: no active ticket/)
  assert.match(unknown.out, /unknown key/)
  assert.doesNotMatch(unknown.out, /Access starts when the purchase round ends/)
  assert.match(unknown.out, /npm run tickets:buy/)

  const st = await run(TICKETS_CLI, ['status', '--local'])
  assert.equal(st.code, 0, st.out)
  assert.match(st.out, /wallet USDGTest balance/)
  assert.match(st.out, /1 bought this round[\s\S]*NOTE: They are NOT active yet: access starts at/)
  assert.match(st.out, /deposited balance:\s+2 USDGTest/)
  assert.ok(st.out.includes(apiKeyHash(key).slice(0, 10)))

  const part = await run(TICKETS_CLI, ['withdraw', '--local', '--amount', '0.5'])
  assert.equal(part.code, 0, part.out)
  assert.match(part.out, /withdrew 0.5 USDGTest; deposited balance now 1.5 USDGTest/)
  const all = await run(TICKETS_CLI, ['withdraw', '--local'])
  assert.equal(all.code, 0, all.out)
  assert.match(all.out, /withdrew 1.5 USDGTest; deposited balance now 0 USDGTest/)
  const tooMuch = await run(TICKETS_CLI, ['withdraw', '--local', '--amount', '5'])
  assert.equal(tooMuch.code, 1)
  assert.match(tooMuch.out, /You only have 0 USDGTest deposited/)
  assert.doesNotMatch(tooMuch.out, /\n\s+at /)

  for (const o of seen) assert.ok(!o.includes(key), 'the raw key must not appear in any command output')
  assert.ok(!seen.join('').includes(keyFromFile(envFile2)))
})

test('tickets:status --local without a running simulator exits 1 and says to start one (attach-only)', async () => {
  const free = await new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
  const r = await run(TICKETS_CLI, ['status', '--local'], envFile, { SIM_RPC_PORT: String(free) })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /No local simulator is running/)
  assert.match(r.out, /npm run sim/)
})
