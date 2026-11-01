import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, getPreset, localParams, parseMode, parseSimPreset, ticketRoundSeconds } from '../config.ts'

test('--local selects local', () => assert.equal(parseMode(['--local']), 'local'))
test('--testnet selects testnet', () => assert.equal(parseMode(['--testnet', '--raw']), 'testnet'))

test('neither flag: error mentions both', () => {
  assert.throws(() => parseMode([]), (e: Error) => e instanceof ConfigError && e.message.includes('--local') && e.message.includes('--testnet'))
})

test('both flags: error', () => {
  assert.throws(() => parseMode(['--local', '--testnet']), ConfigError)
})

test('testnet preset values', () => {
  const p = getPreset(['--testnet'], {})
  assert.equal(p.chainId, 421614)
  assert.equal(p.feedUrl, 'wss://sepolia-rollup-txfeed.arbitrum.io')
  assert.equal(p.sendUrl, 'https://sepolia-rollup-sequencer.arbitrum.io/rpc')
})

test('local presets: slow default, fast, round = B/K', () => {
  assert.equal(parseSimPreset([], {}), 'slow')
  assert.equal(parseSimPreset(['--preset', 'fast'], {}), 'fast')
  assert.equal(parseSimPreset([], { SIM_PRESET: 'fast' }), 'fast')
  assert.throws(() => parseSimPreset(['--preset', 'warp'], {}), ConfigError)
  const slow = localParams('slow', {})
  assert.equal(slow.blockMs, 2000)
  assert.equal(slow.roundMs, 1000)
  const fast = localParams('fast', {})
  assert.equal(fast.blockMs, 250)
  assert.equal(fast.roundMs, 125)
  assert.equal(getPreset(['--local'], {}).chainId, 31337)
})

test('env overrides', () => {
  const p = localParams('slow', { SIM_RPC_PORT: '18547', BLOCK_PUBLISH_DELAY_MS: '7' })
  assert.equal(p.rpcPort, 18547)
  assert.equal(p.blockPublishDelayMs, 7)
})

test('--preset with missing or unknown value errors', () => {
  assert.throws(() => parseSimPreset(['--preset'], {}), ConfigError)
  assert.throws(() => parseSimPreset(['--preset', '--raw'], {}), ConfigError)
  assert.throws(() => parseSimPreset(['--preset='], {}), ConfigError)
  assert.throws(() => parseSimPreset(['--preset=warp'], {}), ConfigError)
})

test('GAP_HOLD_ROUNDS: default 10, a positive integer is used, 0 is rejected (never silently replaced)', () => {
  assert.equal(localParams('slow', {}).gapHoldRounds, 10)
  assert.equal(localParams('slow', { GAP_HOLD_ROUNDS: '3' }).gapHoldRounds, 3)
  assert.throws(() => localParams('slow', { GAP_HOLD_ROUNDS: '0' }), (e: Error) => e instanceof ConfigError && /GAP_HOLD_ROUNDS/.test(e.message))
  assert.throws(() => localParams('slow', { GAP_HOLD_ROUNDS: 'x' }), ConfigError)
})

test('the banner shows the gap hold as a simulator assumption', async () => {
  const { bannerLines } = await import('../../sim/banner.ts')
  assert.ok(bannerLines(localParams('slow', { GAP_HOLD_ROUNDS: '4' })).some((l) => /nonce gap hold = 4 rounds.*simulator assumption/.test(l)))
})

test('local ticket round: default 30s; max(30s, 4 x B); TICKET_ROUND_SECONDS wins, warning only below 4 x B', () => {
  assert.equal(localParams('slow', {}).tickets.roundSeconds, 30)
  assert.equal(localParams('slow', { TICKET_ROUND_SECONDS: '12' }).tickets.roundSeconds, 12)
  assert.deepEqual(ticketRoundSeconds(2000, {}), { seconds: 30, adapted: false })
  assert.deepEqual(ticketRoundSeconds(250, {}), { seconds: 30, adapted: false })
  assert.deepEqual(ticketRoundSeconds(7500, {}), { seconds: 30, adapted: false }, '4 x B = 30s exactly: not adapted')
  assert.deepEqual(ticketRoundSeconds(25_000, {}), { seconds: 100, adapted: true })
  assert.equal(ticketRoundSeconds(8000, {}).seconds, 32)
  const low = ticketRoundSeconds(25_000, { TICKET_ROUND_SECONDS: '40' })
  assert.equal(low.seconds, 40)
  assert.equal(low.adapted, false)
  assert.match(low.warning ?? '', /TICKET_ROUND_SECONDS=40s is below 4 x B \(100s\)/)
  assert.equal(ticketRoundSeconds(25_000, { TICKET_ROUND_SECONDS: '100' }).warning, undefined)
  assert.equal(ticketRoundSeconds(25_000, { TICKET_ROUND_SECONDS: '200' }).warning, undefined)
  assert.equal(ticketRoundSeconds(2000, { TICKET_ROUND_SECONDS: '9' }).warning, undefined, '9s >= 4 x 2s')
  const slowmo = localParams('slow', { SIM_SLOWMO: '1' })
  assert.equal(slowmo.tickets.roundSeconds, 100)
  assert.equal(slowmo.tickets.roundAdapted, true)
})
