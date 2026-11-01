// CLI smoke test: `feed --local --live` as a real process against an in-process stack (FEED_AUTH=off).
// One tx is sent; the table and its timing line must appear; SIGINT must print the footer. Killed on a timer if stuck.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'
import { parseGwei, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ANVIL_DEV_KEY_0, localPreset } from '../../shared/config.ts'
import { FOOTER } from '../client/live.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

const env: NodeJS.ProcessEnv = { ...process.env, SIM_RPC_PORT: '48847', SIM_FEED_PORT: '49842', SIM_ANVIL_PORT: '48845', FEED_AUTH: 'off' }
delete env.PRIVATE_KEY
delete env.FEED_API_KEY
delete env.MY_ADDRESSES
env.ENV_FILE = '/nonexistent-env-file' // never read the repo .env
const preset = localPreset('slow', env)
let stack: Stack

before(async () => {
  buildContracts()
  stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
}, { timeout: 120_000 })
after(async () => {
  await stack?.stop()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('feed --local --live prints the header, a table with our row, its timing line, and the footer on SIGINT', { timeout: 90_000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'fast-feed/client/feed.ts', '--local', '--live'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const exited = new Promise<number | null>((r) => child.once('exit', r))
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 80_000)
  const waitFor = async (re: RegExp, ms: number, what: string) => {
    const end = Date.now() + ms
    while (!re.test(out)) {
      assert.ok(Date.now() < end && child.exitCode === null, `timed out waiting for ${what}. Output:\n${out}`)
      await sleep(100)
    }
  }
  try {
    await waitFor(/==> connected/, 40_000, 'the feed to connect')
    assert.match(out, /Feed auth is off; no ticket needed/)
    assert.match(out, /LOCAL: block = 2000ms/)
    const acct = privateKeyToAccount(ANVIL_DEV_KEY_0)
    const rpc = async (method: string, params: unknown[] = []) => {
      const r = await fetch(preset.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      return ((await r.json()) as { result: any }).result
    }
    const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [acct.address, 'latest'])))
    const raw: Hex = await acct.signTransaction({
      type: 'eip1559', chainId: preset.chainId, to: '0x000000000000000000000000000000000000dEaD', value: 1n, gas: 21_000n, nonce,
      maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei('1'),
    })
    await rpc('eth_sendRawTransaction', [raw])
    await waitFor(/yours, tip 1 gwei, index 0 of round [12]/, 30_000, 'our highlighted row')
    await waitFor(/FF lead  block \d+ round [12]\/2  tx_index/, 30_000, 'the FF lead line with K (round 1/2)')
    await waitFor(/ordered \(round [12]\) → Fast Feed \+\d+ms → block \d+ visible on RPC \+\d+ms/, 30_000, 'the timing line')
    child.kill('SIGINT')
    const code = await Promise.race([exited, sleep(15_000).then(() => 'stuck' as const)])
    assert.equal(code, 0, `exited cleanly after SIGINT. Output:\n${out}`)
    assert.ok(out.includes(FOOTER), 'the footer was printed on exit')
    assert.doesNotMatch(out, /\x1b\[/, 'piped output has no ANSI escapes')
  } finally {
    clearTimeout(killTimer)
    child.kill('SIGKILL')
  }
})
