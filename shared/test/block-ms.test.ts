// B5: `--block-ms` / SIM_BLOCK_MS override B of the preset (K stays 2).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blockMsOverride, ConfigError, localParams, localPreset, MAX_BLOCK_MS, parseBlockMsFlag, slowmoRequested } from '../config.ts'

test('a valid flag value is returned, with = or a separate value', () => {
  assert.equal(blockMsOverride(['--block-ms', '20000'], {}), 20000)
  assert.equal(blockMsOverride(['--block-ms=250'], {}), 250)
  assert.equal(blockMsOverride([], {}), undefined)
})

test('below 250, not an integer, or a missing value: ConfigError', () => {
  for (const bad of ['100', '249', '0', '-5', '2.5', 'abc', '', '1e4']) assert.throws(() => blockMsOverride(['--block-ms', bad], {}), ConfigError, bad)
  assert.throws(() => blockMsOverride(['--block-ms'], {}), /needs a value/)
  assert.throws(() => blockMsOverride(['--block-ms', '--fifo'], {}), /needs a value/)
  assert.equal(parseBlockMsFlag(['--block-ms=']), '')
  assert.throws(() => blockMsOverride(['--block-ms='], {}), ConfigError)
})

test('SIM_BLOCK_MS works, is validated, and the flag beats it', () => {
  assert.equal(blockMsOverride([], { SIM_BLOCK_MS: '6000' }), 6000)
  assert.throws(() => blockMsOverride([], { SIM_BLOCK_MS: '100' }), /SIM_BLOCK_MS/)
  assert.equal(blockMsOverride(['--block-ms', '8000'], { SIM_BLOCK_MS: '6000' }), 8000)
})

test('localParams: B is overridden, K stays 2, round = B/2', () => {
  const p = localParams('slow', { SIM_BLOCK_MS: '20000' })
  assert.equal(p.blockMs, 20000)
  assert.equal(p.k, 2)
  assert.equal(p.roundMs, 10000)
  assert.equal(localPreset('slow', {}).local!.blockMs, 2000)
})

test('B6a: an odd block time is refused (round = B/2 must be a whole ms), so is one above the upper bound', () => {
  for (const bad of ['2001', '251', '600002', String(MAX_BLOCK_MS + 1), '1000000']) assert.throws(() => blockMsOverride(['--block-ms', bad], {}), ConfigError, bad)
  assert.throws(() => blockMsOverride([], { SIM_BLOCK_MS: '2001' }), /SIM_BLOCK_MS.*even/)
  assert.equal(blockMsOverride(['--block-ms', String(MAX_BLOCK_MS)], {}), MAX_BLOCK_MS)
  assert.equal(blockMsOverride(['--block-ms', '250'], {}), 250)
})

test('B6a: --slowmo is B = 25000ms, K = 2, round 12500ms, ', () => {
  assert.equal(slowmoRequested(['--slowmo'], {}), true)
  assert.equal(slowmoRequested([], { SIM_SLOWMO: '1' }), true)
  assert.equal(slowmoRequested([], {}), false)
  const p = localParams('slow', { SIM_SLOWMO: '1' })
  assert.deepEqual([p.blockMs, p.k, p.roundMs, p.slowmo], [25000, 2, 12500, true])
})

test('B6a: --slowmo conflicts with --block-ms and SIM_BLOCK_MS (ConfigError, exit 2 in the CLI)', () => {
  assert.throws(() => slowmoRequested(['--slowmo', '--block-ms', '4000'], {}), /conflicts with --block-ms/)
  assert.throws(() => slowmoRequested(['--slowmo'], { SIM_BLOCK_MS: '4000' }), ConfigError)
  assert.throws(() => localParams('slow', { SIM_SLOWMO: '1', SIM_BLOCK_MS: '4000' }), ConfigError)
})

test('B6b: every preset has K = 2 rounds per block, with or without --block-ms', () => {
  assert.deepEqual([localParams('slow', {}).k, localParams('slow', {}).roundMs], [2, 1000])
  assert.deepEqual([localParams('fast', {}).k, localParams('fast', {}).roundMs], [2, 125])
  const b = localParams('slow', { SIM_BLOCK_MS: '6000' })
  assert.deepEqual([b.k, b.blockMs, b.roundMs], [2, 6000, 3000])
})
