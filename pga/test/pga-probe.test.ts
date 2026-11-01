// Pure parts and CLI guards of `npm run pga:probe` (pga/bot/probe.ts). No network: the testnet guards refuse first.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { parseGwei } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { ConfigError } from '../../shared/config.ts'
import type { Landed } from '../bot/bot.ts'
import { classifyTrial, formatProbeTable, parseTrials, probeExitCode, probeVerdict } from '../bot/probe.ts'

const L = (label: string, block: number, index: number, tip = label): Landed => ({ label, block: BigInt(block), index, tip: parseGwei(tip) })
const pga = (b = 5) => [L('0.1', b, 0), L('0.01', b, 1), L('0.001', b, 2)]
const fcfs = (b = 5) => [L('0.001', b, 0), L('0.01', b, 1), L('0.1', b, 2)]

test('classifyTrial: counted only when all three landed in one round; tip vs arrival order', () => {
  assert.deepEqual([classifyTrial(1, pga()).counted, classifyTrial(1, pga()).orderedBy], [true, 'tip'])
  assert.deepEqual([classifyTrial(1, fcfs()).counted, classifyTrial(1, fcfs()).orderedBy], [true, 'arrival'])
  const split = classifyTrial(1, [L('0.1', 5, 0), L('0.01', 6, 0), L('0.001', 6, 1)])
  assert.deepEqual([split.counted, split.orderedBy], [false, 'n/a'])
  const odd = classifyTrial(1, [L('0.01', 5, 0), L('0.1', 5, 1), L('0.001', 5, 2)])
  assert.deepEqual([odd.counted, odd.orderedBy], [true, 'other'])
  assert.equal(classifyTrial(1, pga().slice(0, 2), ['0.001']).counted, false)
  assert.equal(classifyTrial(1, pga()).tipsCharged, true)
  assert.equal(classifyTrial(1, [L('0.1', 5, 0, '0'), L('0.01', 5, 1), L('0.001', 5, 2)]).tipsCharged, false)
})

test('B6b: same block but different pga_round is NOT counted; same block and round is', () => {
  const R = (l: Landed, pgaRound: number): Landed => ({ ...l, pgaRound })
  const split = classifyTrial(1, [R(L('0.1', 5, 0), 1), R(L('0.01', 5, 1), 2), R(L('0.001', 5, 2), 2)])
  assert.deepEqual([split.counted, split.orderedBy, split.blocks], [false, 'n/a', [5n]])
  const one = classifyTrial(1, pga().map((l) => R(l, 2)))
  assert.deepEqual([one.counted, one.orderedBy, one.pgaRounds], [true, 'tip', [2, 2, 2]])
  assert.match(formatProbeTable([one], 'local').table.join('\n'), /5 \(pga_round 2\)/)
})

test('probeVerdict: PGA-consistent, FCFS-consistent, inconclusive; exit 0 for a verdict and 3 for inconclusive', () => {
  const t = (ls: Landed[], n = 1) => classifyTrial(n, ls)
  assert.equal(probeVerdict([t(pga(5)), t(pga(6), 2)]), 'PGA-consistent')
  assert.equal(probeVerdict([t(pga(5)), t([L('0.1', 6, 0), L('0.01', 7, 0), L('0.001', 7, 1)], 2)]), 'PGA-consistent', 'uncounted trials are ignored')
  assert.equal(probeVerdict([t(fcfs(5)), t(fcfs(6), 2)]), 'FCFS-consistent')
  assert.equal(probeVerdict([t(pga(5)), t(fcfs(6), 2)]), 'inconclusive')
  assert.equal(probeVerdict([t([L('0.1', 6, 0), L('0.01', 7, 0), L('0.001', 7, 1)])]), 'inconclusive', 'no counted trial')
  assert.equal(probeVerdict([]), 'inconclusive')
  assert.equal(probeExitCode('PGA-consistent'), 0)
  assert.equal(probeExitCode('FCFS-consistent'), 0)
  assert.equal(probeExitCode('inconclusive'), 3)
})

test('table: one row per trial; on a testnet it says same block is not the same round', () => {
  const rows = [classifyTrial(1, pga()), classifyTrial(2, [L('0.1', 5, 0), L('0.01', 6, 0), L('0.001', 6, 1)])]
  const { table: local, note: localNote } = formatProbeTable(rows, 'local')
  assert.match(local[0]!, /Trial.*Block\(s\).*Same round.*Landing order.*Ordered by.*Tips charged/)
  assert.equal(local.length, 2 + 2)
  assert.match(local[2]!, /yes \(counted\).*tip \(PGA-like\).*yes/)
  assert.match(local[3]!, /no \(not counted\)/)
  assert.match(localNote, /same round = same block and same pga_round locally/i)
  assert.match(formatProbeTable(rows, 'testnet').note, /same block does NOT mean the same round/)
})

test('--trials parsing', () => {
  assert.equal(parseTrials(['--local']), 3)
  assert.equal(parseTrials(['--trials', '5']), 5)
  assert.equal(parseTrials(['--trials=2']), 2)
  assert.throws(() => parseTrials(['--trials', '0']), ConfigError)
  assert.throws(() => parseTrials(['--trials']), ConfigError)
  assert.throws(() => parseTrials(['--trials', 'x']), ConfigError)
})

function run(args: string[], extra: Record<string, string> = {}) {
  const env = { ...process.env, ENV_FILE: '/nonexistent-env-file', ...extra } as NodeJS.ProcessEnv
  for (const k of ['ALLOW_TESTNET', 'PGA_KEY_1', 'PGA_KEY_2', 'PGA_KEY_3']) if (!(k in extra)) delete env[k]
  return new Promise<{ code: number; out: string }>((resolve) =>
    execFile(process.execPath, ['--import', 'tsx', 'pga/bot/probe.ts', ...args], { env, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    ),
  )
}

test('CLI: pga:probe --testnet refuses without ALLOW_TESTNET=1, before any network access', async () => {
  const r = await run(['--testnet'])
  assert.equal(r.code, 1)
  assert.match(r.out, /ALLOW_TESTNET=1/)
})

test('CLI: pga:probe --testnet with ALLOW_TESTNET=1 refuses missing or repeated PGA_KEY_*, offline, without echoing a key', async () => {
  const k = generatePrivateKey()
  const missing = await run(['--testnet'], { ALLOW_TESTNET: '1' })
  assert.equal(missing.code, 1)
  assert.match(missing.out, /PGA_KEY_1 is not set/)
  const same = await run(['--testnet'], { ALLOW_TESTNET: '1', PGA_KEY_1: k, PGA_KEY_2: k, PGA_KEY_3: generatePrivateKey() })
  assert.equal(same.code, 1)
  assert.match(same.out, /three distinct wallets/)
  assert.ok(!same.out.includes(k.slice(2)))
})

test('CLI: usage errors exit 2', async () => {
  assert.equal((await run([])).code, 2)
  assert.equal((await run(['--local', '--trials', '0'])).code, 2)
})

test('classifyTrial: a round that could not be read locally is not counted', () => {
  const t = classifyTrial(1, [{ ...L('0.1', 5, 0), roundUnknown: true }, L('0.01', 5, 1), L('0.001', 5, 2)])
  assert.equal(t.counted, false)
  assert.equal(t.roundUnknown, true)
})
