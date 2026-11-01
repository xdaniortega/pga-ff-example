// B3: `npm run pga -- --local --scenario flood` as a real process against an in-process stack (slow preset, K = 2,
// MAX_TXS_PER_ROUND=3, alternate ports, FEED_AUTH=off). PASS asserts the three acceptance criteria through the bot's own
// output: the boost is p/(2K) per round, the zero-tip tx is included within 2K+1 rounds ahead of the later arrival
// tipping p, and its receipt shows effective tip 0. A stack with no cap makes the bot explain and exit non-zero.
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
  if (extra.MAX_TXS_PER_ROUND === undefined) delete env.MAX_TXS_PER_ROUND // a stack without a cap, whatever the caller's shell has
  return env
}

const capEnv = envFor({ rpc: '33547', feed: '33642', anvil: '33545' }, { MAX_TXS_PER_ROUND: '3' })
const noCapEnv = envFor({ rpc: '33647', feed: '33742', anvil: '33645' })
const fifoCapEnv = envFor({ rpc: '33747', feed: '33842', anvil: '33745' }, { MAX_TXS_PER_ROUND: '3', SIM_ORDER: 'fifo' })
const stacks: Stack[] = []

async function start(env: NodeJS.ProcessEnv) {
  const preset = localPreset('slow', env)
  stacks.push(await startOrAttach(preset.local!, preset.chainId, { banner: false, env }))
}

before(async () => {
  buildContracts()
  await start(capEnv)
  await start(noCapEnv)
  await start(fifoCapEnv)
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

test('sim_info serves the block cap', async () => {
  const res = await fetch('http://127.0.0.1:33547', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sim_info', params: [] }) })
  const body = (await res.json()) as { result: { maxTxsPerRound: number; k: number } }
  assert.equal(body.result.maxTxsPerRound, 3)
  assert.equal(body.result.k, 2)
})

test('pga --scenario flood (cap 3): PASS, zero tip lands within 2K+1 rounds, ahead of the later p-tip arrival, effective tip 0', { timeout: 170_000 }, async () => {
  const r = await runBot(capEnv, ['--scenario', 'flood'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^Scenario flood: PASS - /m)
  assert.doesNotMatch(r.out, /FAIL|INCONCLUSIVE/)
  // The boost trace 0 -> p/4 -> p/2 -> 3p/4 -> p, in five consecutive rounds.
  assert.match(r.out, /round \d+: 0  ->  round \d+: p\/4  ->  round \d+: p\/2  ->  round \d+: 3p\/4  ->  round \d+: p \(included\)/)
  // Included within 2K+1 = 5 rounds of its arrival.
  const m = r.out.match(/included in round (\d+) after its arrival \(limit 2K\+1 = 5\): yes/)
  assert.ok(m, r.out)
  assert.ok(Number(m![1]) <= 5)
  // Ahead of the later arrival that tips p, and it paid no tip.
  assert.match(r.out, /landed ahead of the later arrival that tips p .*: yes/)
  assert.match(r.out, /effectiveGasPrice - baseFee = 0 gwei \(expected 0\): yes/)
  assert.match(r.out, /zero-tip tx landed in block \d+ idx \d+; effective tip from its receipt = 0 gwei/)
  assert.match(r.out, /later arrival landed in block \d+ idx \d+; effective tip = 0\.01 gwei/)
})

test('pga --scenario flood against a stack with no block cap: explains how to restart with the cap and exits non-zero', { timeout: 60_000 }, async () => {
  const r = await runBot(noCapEnv, ['--scenario', 'flood'])
  assert.notEqual(r.code, 0, r.out)
  assert.match(r.out, /no block cap/)
  assert.match(r.out, /npm run sim -- --max-txs-per-round 3/)
  assert.doesNotMatch(r.out, /PASS/)
})

test('pga --scenario flood against a capped FIFO stack: refuses (non-zero, no PASS): no boost is ever added', { timeout: 60_000 }, async () => {
  const r = await runBot(fifoCapEnv, ['--scenario', 'flood'])
  assert.notEqual(r.code, 0, r.out)
  assert.match(r.out, /orders by arrival \(FIFO/)
  assert.doesNotMatch(r.out, /PASS/)
})
