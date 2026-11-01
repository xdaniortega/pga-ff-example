// B5: `npm run pga:slot -- --local` as a real process against an in-process stack with a longer block (B = 6000ms, so rounds
// are 3s and the late tx is sent 1.5s in). Feed auth is OFF to keep it fast (the ticket path is covered by the race and demo
// suites). PGA stack: the late tx lands at index 1 of the same block, exit 0. FIFO stack: it lands at index 3, exit 1.
// Also the usage exits (2). Asserts ordering only, never absolute durations.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'
import { localPreset } from '../../shared/config.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

function envFor(ports: { rpc: string; feed: string; anvil: string }, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, BLOCK_PUBLISH_DELAY_MS: '100', SIM_ORDER: 'pga', FEED_AUTH: 'off', SIM_BLOCK_MS: '6000',
    SIM_RPC_PORT: ports.rpc, SIM_FEED_PORT: ports.feed, SIM_ANVIL_PORT: ports.anvil, ...extra,
    ENV_FILE: '/nonexistent-env-file', // never read the repo .env
  }
  delete env.PRIVATE_KEY
  delete env.FEED_API_KEY
  delete env.MY_ADDRESSES
  return env
}

const pgaEnv = envFor({ rpc: '63547', feed: '63642', anvil: '63545' })
const fifoEnv = envFor({ rpc: '63647', feed: '63742', anvil: '63645' }, { SIM_ORDER: 'fifo' })
const stacks: Stack[] = []

before(async () => {
  buildContracts()
  for (const env of [pgaEnv, fifoEnv]) {
    const preset = localPreset('slow', env)
    stacks.push(await startOrAttach(preset.local!, preset.chainId, { banner: false, env }))
  }
}, { timeout: 120_000 })
after(async () => {
  for (const s of stacks) await s.stop()
})

function runCmd(file: string, args: string[], env: NodeJS.ProcessEnv, killAfterMs = 90_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

const feedLine = (out: string, who: string) => out.match(new RegExp(`feed: block (\\d+) round 1 tx_index (\\d+) .*${who}`))

test('PGA stack: the late 0.05 tx lands at index 1 of the same block as the other three, exit 0', { timeout: 120_000 }, async () => {
  const r = await runCmd('combo/slot.ts', ['--local', '--late-after-ms', '1500'], pgaEnv)
  assert.equal(r.code, 0, r.out)
  const late = feedLine(r.out, 'late')
  const e1 = feedLine(r.out, 'early 1')
  const e2 = feedLine(r.out, 'early 2')
  const e3 = feedLine(r.out, 'early 3')
  assert.ok(late && e1 && e2 && e3, r.out)
  assert.equal(new Set([late[1], e1[1], e2[1], e3[1]]).size, 1, 'one block')
  assert.deepEqual([e3[2], late[2], e2[2], e1[2]], ['0', '1', '2', '3'].map((x) => x), 'tip order 0.1, 0.05, 0.01, 0.001')
  assert.match(r.out, /^PASS: /m)
  assert.doesNotMatch(r.out, /\x1b\[/, 'piped output has no ANSI escapes')
  assert.match(r.out, /Arrival time bought no position: the tip decided\./)
  assert.equal(r.out.split('a tx already on the feed is final').length - 1, 1, 'the honesty sentence is printed once')
})

test('FIFO stack: the late tx lands at index 3, the command reports FAIL and exits 1', { timeout: 120_000 }, async () => {
  const r = await runCmd('combo/slot.ts', ['--local', '--late-after-ms', '1500'], fifoEnv)
  assert.equal(r.code, 1, r.out)
  const late = feedLine(r.out, 'late')
  assert.ok(late, r.out)
  assert.equal(late[2], '3')
  assert.match(r.out, /^FAIL: /m)
  assert.doesNotMatch(r.out, /the tip decided\./)
})

test('usage exits 2: --testnet, a round shorter than 2s, --late-after-ms >= the round, no network flag', { timeout: 60_000 }, async () => {
  const noStack = envFor({ rpc: '63947', feed: '63948', anvil: '63949' }, { SIM_BLOCK_MS: '' })
  const t = await runCmd('combo/slot.ts', ['--testnet'], noStack)
  assert.equal(t.code, 2, t.out)
  assert.match(t.out, /needs the block-start sync/)
  const short = await runCmd('combo/slot.ts', ['--local'], noStack)
  assert.equal(short.code, 2, short.out)
  assert.match(short.out, /npm run sim -- --block-ms 20000/)
  const late = await runCmd('combo/slot.ts', ['--local', '--late-after-ms', '3000'], pgaEnv)
  assert.equal(late.code, 2, late.out)
  const none = await runCmd('combo/slot.ts', [], noStack)
  assert.equal(none.code, 2, none.out)
  assert.match(none.out, /--local/)
})

test('npm run sim --block-ms: invalid values exit 2 with an explanation; nothing is started', { timeout: 60_000 }, async () => {
  const noStack = envFor({ rpc: '63947', feed: '63948', anvil: '63949' }, { SIM_BLOCK_MS: '' })
  for (const args of [['--block-ms', '100'], ['--block-ms', '2.5'], ['--block-ms']]) {
    const r = await runCmd('sim/cli.ts', args, noStack)
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`)
    assert.match(r.out, /--block-ms/)
  }
})
