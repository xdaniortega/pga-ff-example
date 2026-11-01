// B2: `npm run pga` (pga/bot/bot.ts) as a real process against an in-process stack (slow preset, alternate ports,
// FEED_AUTH=off). PGA stack: --scenario all exits 0 with PASS for all three. FIFO stack: scenario 1 must FAIL
// (non-zero exit): this proves the bot can fail. Tick-synced sends make the same-round batches deterministic.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'
import { localPreset } from '../../shared/config.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

function envFor(ports: { rpc: string; feed: string; anvil: string }, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, BLOCK_PUBLISH_DELAY_MS: '100', FEED_AUTH: 'off', SIM_ORDER: 'pga',
    SIM_RPC_PORT: ports.rpc, SIM_FEED_PORT: ports.feed, SIM_ANVIL_PORT: ports.anvil, ...extra,
    ENV_FILE: '/nonexistent-env-file', // never read the repo .env
  }
  delete env.PRIVATE_KEY
  delete env.PGA_KEY_1
  delete env.PGA_KEY_2
  delete env.PGA_KEY_3
  delete env.MY_ADDRESSES
  return env
}

const pgaEnv = envFor({ rpc: '48547', feed: '49642', anvil: '48545' })
const fifoEnv = envFor({ rpc: '48647', feed: '49742', anvil: '48645' }, { SIM_ORDER: 'fifo' })
const stacks: Stack[] = []

async function start(env: NodeJS.ProcessEnv) {
  const preset = localPreset('slow', env)
  stacks.push(await startOrAttach(preset.local!, preset.chainId, { banner: false, env }))
}

before(async () => {
  buildContracts()
  await start(pgaEnv)
  await start(fifoEnv)
}, { timeout: 120_000 })
after(async () => {
  for (const s of stacks) await s.stop()
})

function runBot(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'pga/bot/bot.ts', '--local', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

test('pga --scenario all against the PGA stack: exit 0 and PASS for all three scenarios', { timeout: 170_000 }, async () => {
  const r = await runBot(pgaEnv, ['--scenario', 'all'])
  assert.equal(r.code, 0, r.out)
  assert.equal(r.out.match(/^Scenario \d: PASS - /gm)?.length, 3, r.out)
  assert.doesNotMatch(r.out, /FAIL|INCONCLUSIVE/)
  assert.doesNotMatch(r.out, /\x1b\[/, 'piped output has no ANSI escapes')
  assert.match(r.out, /^Scenario +Expected order +Observed order +Tips \(gwei, from receipts\) +Result$/m)
  assert.match(r.out, /nonce N\+1 isn't valid until nonce N has executed/)
})

test('pga --scenario 1 against a --fifo stack must FAIL (non-zero exit): the bot can fail', { timeout: 100_000 }, async () => {
  const r = await runBot(fifoEnv, ['--scenario', '1'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /^Scenario 1: FAIL - /m)
  assert.match(r.out, /0\.001, 0\.01, 0\.1/) // observed = arrival order
})
