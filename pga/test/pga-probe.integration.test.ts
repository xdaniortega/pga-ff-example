// B3: `npm run pga:probe -- --local --trials 3` as a real process: a PGA stack gives PGA-consistent, a --fifo stack gives
// FCFS-consistent (slow preset, alternate ports, FEED_AUTH=off, tick-synced sends).
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
  delete env.MAX_TXS_PER_ROUND
  return env
}

const pgaEnv = envFor({ rpc: '34547', feed: '34642', anvil: '34545' })
const fifoEnv = envFor({ rpc: '34647', feed: '34742', anvil: '34645' }, { SIM_ORDER: 'fifo' })
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

function runProbe(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'pga/bot/probe.ts', '--local', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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

test('pga:probe --local --trials 3 on a PGA stack: PGA-consistent, exit 0, tips charged', { timeout: 170_000 }, async () => {
  const r = await runProbe(pgaEnv, ['--trials', '3'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^Verdict: PGA-consistent \(3 of 3 trial\(s\) counted\)/m)
  assert.equal(r.out.match(/tip \(PGA-like\)/g)?.length, 3, r.out)
  assert.match(r.out, /yes \(effectiveGasPrice > baseFee\)/)
  assert.match(r.out, /^NOTE: Same round = same block and same pga_round locally/m)
})

test('pga:probe --local --trials 3 on a --fifo stack: FCFS-consistent, exit 0', { timeout: 170_000 }, async () => {
  const r = await runProbe(fifoEnv, ['--trials', '3'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^Verdict: FCFS-consistent \(3 of 3 trial\(s\) counted\)/m)
  assert.equal(r.out.match(/arrival \(FCFS-like\)/g)?.length, 3, r.out)
})
