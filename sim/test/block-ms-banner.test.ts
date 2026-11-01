// B5: the banner shows an overridden block time next to Arbitrum One's, and says nothing extra for a plain preset.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localParams } from '../../shared/config.ts'
import { bannerLines } from '../banner.ts'

test('banner line for --block-ms / SIM_BLOCK_MS', () => {
  const lines = bannerLines(localParams('slow', { SIM_BLOCK_MS: '20000' }))
  assert.ok(lines.includes("  block = 20000ms, round = 10000ms (Arbitrum One: 250ms, 125ms)   (--block-ms / SIM_BLOCK_MS overrides the slow preset's 2000ms; K stays 2)"))
  assert.ok(!bannerLines(localParams('slow', {})).some((l) => l.includes('overrides')))
})

test('Q1 banner: slow motion is named in the header only under --slowmo', () => {
  assert.equal(bannerLines(localParams('slow', { SIM_SLOWMO: '1' }))[0], 'LOCAL (slow preset, slow motion ×100): values differ from Arbitrum One as follows')
  assert.equal(bannerLines(localParams('slow', {}))[0], 'LOCAL (slow preset): values differ from Arbitrum One as follows')
})

test('B6b banner: slow motion line + NOTE once; every other preset says K = 2 rounds per block', () => {
  const slow = bannerLines(localParams('slow', { SIM_SLOWMO: '1' }))
  const line = slow.filter((l) => l.startsWith('  slow motion'))
  assert.deepEqual(line, ['  slow motion ×100: round 12.5s (Arbitrum One: 125ms), block 25s (Arbitrum One: 250ms), 2 rounds per block'])
  const i = slow.indexOf(line[0]!)
  assert.equal(slow[i + 1], '  transactions published in round 1 are final before round 2 starts; round 2 can only add after them.')
  assert.ok(!slow.some((l) => l.includes('overrides')), 'slowmo is not reported as a --block-ms override')
  const NOTE = '  transactions published in round 1 are final before round 2 starts; round 2 can only add after them.'
  for (const [preset, b, r] of [['slow', 2000, 1000], ['fast', 250, 125]] as const) {
    const l = bannerLines(localParams(preset, {}))
    assert.ok(l.includes(`  block = ${b}ms, K = 2 rounds of B/2 = ${r}ms   (Arbitrum One: 250ms, two 125ms rounds)`), preset)
    assert.equal(l.filter((x) => x === NOTE).length, 1)
    assert.equal(l.filter((x) => /^  block = |round = B\/K/.test(x)).length, 1, 'block/K/round are printed once')
    assert.ok(!l.some((x) => x.includes('slow motion') || x.includes('one round = one') || x.includes('SIM_ROUNDS_IN_BLOCK')))
  }
})

test('banner: ticket round 30s next to 24h, no NOTE; slow motion adapts to 100s with one NOTE; an override below 4 x B warns', () => {
  const plain = bannerLines(localParams('slow', {}))
  assert.ok(plain.some((l) => l.includes('ticket round = 30s (Arbitrum One: 24h)')))
  assert.ok(!plain.some((l) => l.includes('ticket round adapted')))
  assert.ok(!plain.some((l) => l.includes('TICKET_ROUND_SECONDS')))
  const slow = bannerLines(localParams('slow', { SIM_SLOWMO: '1' }))
  assert.ok(slow.some((l) => l.includes('ticket round = 100s (Arbitrum One: 24h)')))
  assert.deepEqual(slow.filter((l) => l.includes('adapted')), ['NOTE: ticket round adapted from 30s to 100s so a purchase or renewal (visible only after its 25s block closes) has time to land in its round'])
  const low = bannerLines(localParams('slow', { SIM_SLOWMO: '1', TICKET_ROUND_SECONDS: '40' }))
  assert.ok(low.some((l) => l.includes('ticket round = 40s')))
  assert.ok(!low.some((l) => l.includes('adapted')))
  assert.ok(low.some((l) => l.startsWith('WARNING: TICKET_ROUND_SECONDS=40s is below 4 x B (100s)')))
  assert.ok(!bannerLines(localParams('slow', { SIM_SLOWMO: '1', TICKET_ROUND_SECONDS: '100' })).some((l) => l.includes('TICKET_ROUND_SECONDS=')))
})
