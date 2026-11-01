// Unit tests for the PGA bot's pure parts (pga/bot/bot.ts, tx.ts): the judge, table, exit codes, wallets, flags,
// and the CLI guards that must refuse BEFORE touching any network.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { parseGwei, parseTransaction } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ConfigError } from '../../shared/config.ts'
import { sameRound } from '../bot/common.ts'
import { assertAllowedChain, runScenario, exitCode, formatTable, judge, parseScenarios, walletsFor, type Landed } from '../bot/bot.ts'
import { presign } from '../bot/tx.ts'

const L = (label: string, block: number, index: number, tip = '0', pgaRound?: number): Landed => ({ label, block: BigInt(block), index, tip: parseGwei(tip), ...(pgaRound !== undefined ? { pgaRound } : {}) })

test('sameRound: same block and round, different round, and unknown rounds', () => {
  assert.equal(sameRound([L('a', 5, 0, '0', 1), L('b', 5, 1, '0', 1)]), true)
  assert.equal(sameRound([L('a', 5, 0, '0', 1), L('b', 5, 1, '0', 2)]), false)
  assert.equal(sameRound([L('a', 5, 0), L('b', 5, 1)]), true, 'block-only when no round is known')
  assert.equal(sameRound([L('a', 5, 0, '0', 1), L('b', 5, 1)]), true, 'undefined rounds are ignored')
  assert.equal(sameRound([L('a', 5, 0, '0', 1), L('b', 6, 0, '0', 1)]), false)
})

test('judge: one block but round 1 and round 2 is INCONCLUSIVE (not FAIL), whatever the order', () => {
  const j = judge(1, [L('0.001', 5, 0, '0', 1), L('0.1', 5, 1, '0', 2), L('0.01', 5, 2, '0', 2)])
  assert.equal(j.verdict, 'INCONCLUSIVE')
  assert.match(j.reason, /different rounds/)
})

test('judge scenario 3: zero tip alone in round 2 is INCONCLUSIVE and says it did land one round later', () => {
  const j = judge(3, [L('0.1', 5, 0, '0', 1), L('0.01', 5, 1, '0', 1), L('0', 5, 2, '0', 2)])
  assert.equal(j.verdict, 'INCONCLUSIVE')
  assert.match(j.reason, /\(the zero tip did land, one round later\)/)
})

test('judge: same block and same round gives the normal PASS and FAIL', () => {
  assert.equal(judge(1, [L('0.1', 5, 0, '0', 2), L('0.01', 5, 1, '0', 2), L('0.001', 5, 2, '0', 2)]).verdict, 'PASS')
  assert.equal(judge(1, [L('0.001', 5, 0, '0', 2), L('0.01', 5, 1, '0', 2), L('0.1', 5, 2, '0', 2)]).verdict, 'FAIL')
})

test('judge: a round that could not be read locally is INCONCLUSIVE, saying so', () => {
  const j = judge(1, [{ ...L('0.1', 5, 0), roundUnknown: true }, L('0.01', 5, 1, '0', 1), L('0.001', 5, 2, '0', 1)])
  assert.equal(j.verdict, 'INCONCLUSIVE')
  assert.match(j.reason, /could not be read/)
})

test('judge scenario 1: tip order passes, arrival order fails', () => {
  assert.equal(judge(1, [L('0.001', 5, 0), L('0.01', 5, 1), L('0.1', 5, 2)]).verdict, 'FAIL')
  const j = judge(1, [L('0.1', 5, 0), L('0.01', 5, 1), L('0.001', 5, 2)])
  assert.equal(j.verdict, 'PASS')
  assert.deepEqual(j.observed, j.expected)
})

test('judge scenario 2: N before N+1 passes; N+1 first fails', () => {
  assert.equal(judge(2, [L('N', 5, 0), L('N+1', 5, 1)]).verdict, 'PASS')
  assert.equal(judge(2, [L('N+1', 5, 0), L('N', 5, 1)]).verdict, 'FAIL')
})

test('judge scenario 3: zero tip last passes; zero tip never landing fails', () => {
  assert.equal(judge(3, [L('0.1', 5, 0), L('0.01', 5, 1), L('0', 5, 2)]).verdict, 'PASS')
  const starved = judge(3, [L('0.1', 5, 0), L('0.01', 5, 1)], ['0'])
  assert.equal(starved.verdict, 'FAIL')
  assert.match(starved.reason, /starved/)
})

test('judge: different blocks is INCONCLUSIVE, never PASS or FAIL', () => {
  const j = judge(3, [L('0.1', 5, 0), L('0.01', 5, 1), L('0', 6, 0)])
  assert.equal(j.verdict, 'INCONCLUSIVE')
  assert.match(j.reason, /different blocks/)
  assert.equal(judge(1, [L('0.001', 5, 0), L('0.1', 6, 0), L('0.01', 6, 1)]).verdict, 'INCONCLUSIVE')
})

test('exit code: 0 only when every scenario passes; FAIL beats INCONCLUSIVE', () => {
  assert.equal(exitCode(['PASS', 'PASS', 'PASS']), 0)
  assert.equal(exitCode(['PASS', 'INCONCLUSIVE', 'PASS']), 3)
  assert.equal(exitCode(['PASS', 'FAIL', 'PASS']), 1)
  assert.equal(exitCode(['INCONCLUSIVE', 'FAIL']), 1)
})

test('table: one row per scenario with expected, observed, tips and the result', () => {
  const j = { ...judge(1, [L('0.1', 5, 0, '0.1'), L('0.01', 5, 1, '0.01'), L('0.001', 5, 2, '0.001')]), tips: ['0.1', '0.01', '0.001'] }
  const lines = formatTable([{ id: 1, j }])
  assert.equal(lines.length, 3)
  assert.match(lines[0]!, /Scenario.*Expected order.*Observed order.*Tips.*Result/)
  assert.match(lines[2]!, /0\.1, 0\.01, 0\.001.*PASS$/)
})

test('--scenario parsing', () => {
  assert.deepEqual(parseScenarios(['--local']), [1, 2, 3])
  assert.deepEqual(parseScenarios(['--scenario', 'all']), [1, 2, 3])
  assert.deepEqual(parseScenarios(['--scenario', '2']), [2])
  assert.deepEqual(parseScenarios(['--scenario=3']), [3])
  assert.deepEqual(parseScenarios(['--scenario', 'flood']), ['flood'])
  assert.deepEqual(parseScenarios(['--scenario', 'all']), [1, 2, 3], 'all runs 1-3 only: flood needs the block cap')
  assert.throws(() => parseScenarios(['--scenario', '4']), ConfigError)
  assert.throws(() => parseScenarios(['--scenario']), ConfigError)
})

test('wallets: local defaults are the Anvil accounts 0-2; a testnet refuses without PGA_KEY_1..3 and never echoes a key', () => {
  const local = walletsFor(31337, {})
  assert.deepEqual(local.map((a) => a.address), ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'])
  const [k1, k2, k3] = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()]
  assert.deepEqual(walletsFor(31337, { PGA_KEY_1: k1, PGA_KEY_2: k2, PGA_KEY_3: k3 }).map((a) => a.address), local.map((a) => a.address), 'PGA_KEY_* is ignored on 31337')
  assert.throws(() => walletsFor(421614, {}), /PGA_KEY_1 is not set/)
  const secret = generatePrivateKey()
  assert.throws(() => walletsFor(421614, { PGA_KEY_1: secret, PGA_KEY_2: secret }), (e: Error) => /PGA_KEY_3 is not set/.test(e.message) && !e.message.includes(secret.slice(2)))
  assert.throws(() => walletsFor(421614, { PGA_KEY_1: 'nonsense', PGA_KEY_2: secret, PGA_KEY_3: secret }), (e: Error) => !e.message.includes('nonsense'))
  const [s2, s3] = [generatePrivateKey(), generatePrivateKey()]
  assert.equal(walletsFor(421614, { PGA_KEY_1: secret, PGA_KEY_2: s2, PGA_KEY_3: s3 })[0]!.address, privateKeyToAccount(secret).address)
  // Three DISTINCT wallets are required on the testnet; the error never echoes a key.
  for (const env of [{ PGA_KEY_1: secret, PGA_KEY_2: secret, PGA_KEY_3: s3 }, { PGA_KEY_1: secret, PGA_KEY_2: s2, PGA_KEY_3: secret }, { PGA_KEY_1: secret, PGA_KEY_2: secret, PGA_KEY_3: secret }]) {
    assert.throws(() => walletsFor(421614, env), (e: Error) => e instanceof ConfigError && /three distinct wallets/.test(e.message) && !e.message.includes(secret.slice(2)))
  }
  assert.doesNotThrow(() => walletsFor(31337, { PGA_KEY_1: secret, PGA_KEY_2: secret, PGA_KEY_3: secret }), 'local ignores PGA_KEY_*')
})

test('presign: a type-2 tx with exactly the given nonce, gas and fees', async () => {
  const account = privateKeyToAccount(generatePrivateKey())
  const raw = await presign({ to: '0x000000000000000000000000000000000000dEaD', tip: parseGwei('0.1'), maxFee: parseGwei('1'), nonce: 7, gas: 21_000n, account, chain: { id: 31337 } })
  assert.ok(raw.startsWith('0x02'))
  const t = parseTransaction(raw)
  assert.equal(t.nonce, 7)
  assert.equal(t.gas, 21_000n)
  assert.equal(t.maxPriorityFeePerGas, parseGwei('0.1'))
  assert.equal(t.maxFeePerGas, parseGwei('1'))
  assert.equal(t.chainId, 31337)
})

test('CLI: --testnet refuses without ALLOW_TESTNET=1, before any network access', async () => {
  const env = { ...process.env, ENV_FILE: '/nonexistent-env-file' } as NodeJS.ProcessEnv
  delete env.ALLOW_TESTNET
  const r = await new Promise<{ code: number; out: string }>((resolve) =>
    execFile(process.execPath, ['--import', 'tsx', 'pga/bot/bot.ts', '--testnet', '--scenario', '1'], { env, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    ),
  )
  assert.equal(r.code, 1)
  assert.match(r.out, /ALLOW_TESTNET=1/)
})

test('CLI: without a network flag it exits 2 with usage', async () => {
  const env = { ...process.env, ENV_FILE: '/nonexistent-env-file' } as NodeJS.ProcessEnv
  const r = await new Promise<{ code: number; out: string }>((resolve) =>
    execFile(process.execPath, ['--import', 'tsx', 'pga/bot/bot.ts'], { env, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    ),
  )
  assert.equal(r.code, 2)
  assert.match(r.out, /Usage: npm run pga/)
})

test('assertAllowedChain: 31337 and 421614 only, the chain must match the preset, Sepolia needs ALLOW_TESTNET=1', () => {
  const local = { chainId: 31337 }
  const sepolia = { chainId: 421614 }
  assertAllowedChain(31337, local, {})
  assertAllowedChain(421614, sepolia, { ALLOW_TESTNET: '1' })
  assert.throws(() => assertAllowedChain(421614, sepolia, {}), /ALLOW_TESTNET=1/)
  assert.throws(() => assertAllowedChain(421614, sepolia, { ALLOW_TESTNET: '0' }), /ALLOW_TESTNET=1/)
  assert.throws(() => assertAllowedChain(42161, { chainId: 42161 }, { ALLOW_TESTNET: '1' }), /unsupported chainId 42161.*never mainnet/)
  assert.throws(() => assertAllowedChain(1, local, {}), /unsupported chainId 1/)
  // An allowed chain that is not the preset's is a mismatch, not "unsupported".
  assert.throws(() => assertAllowedChain(421614, local, { ALLOW_TESTNET: '1' }), /chainId 421614 does not match the --local preset \(expected 31337\)/)
  assert.throws(() => assertAllowedChain(31337, sepolia, { ALLOW_TESTNET: '1' }), /chainId 31337 does not match the --testnet preset \(expected 421614\)/)
  assert.throws(() => assertAllowedChain(421614, local, {}), (e: Error) => !/unsupported/.test(e.message))
})

test('judge: a FAIL for a missing receipt appends the last receipt error', () => {
  const j = judge(1, [L('0.1', 5, 0)], ['0.01'], 'receipt could not be found')
  assert.equal(j.verdict, 'FAIL')
  assert.match(j.reason, /last receipt error: receipt could not be found/)
})

test('CLI: --testnet --scenario flood is refused (local only) before any guard or network access, exit 1', async () => {
  const env = { ...process.env, ENV_FILE: '/nonexistent-env-file' } as NodeJS.ProcessEnv
  delete env.ALLOW_TESTNET
  const r = await new Promise<{ code: number; out: string }>((resolve) =>
    execFile(process.execPath, ['--import', 'tsx', 'pga/bot/bot.ts', '--testnet', '--scenario', 'flood'], { env, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    ),
  )
  assert.equal(r.code, 1)
  assert.match(r.out, /--scenario flood is --local only/)
  assert.match(r.out, /spam a shared testnet/)
})

test('bot scenarios 1 and 3 retry once after INCONCLUSIVE and say so; scenario 2 does not retry', async () => {
  const j = (verdict: 'PASS' | 'INCONCLUSIVE') => ({ verdict, expected: [], observed: [], reason: 'r', tips: [] })
  for (const id of [1, 3]) {
    const calls: number[] = []
    const said: string[] = []
    const out = await runScenario({} as never, id, async () => (calls.push(id), j(calls.length === 1 ? 'INCONCLUSIVE' : 'PASS')), (m) => said.push(m))
    assert.equal(calls.length, 2)
    assert.equal(out.verdict, 'PASS')
    assert.match(said.join('\n'), /retrying once after a fresh block start/)
    assert.match(out.reason, /after 1 retry/)
  }
  let n = 0
  const out = await runScenario({} as never, 2, async () => (n++, j('INCONCLUSIVE')), () => assert.fail('no retry message for scenario 2'))
  assert.equal(n, 1)
  assert.equal(out.verdict, 'INCONCLUSIVE')
})
