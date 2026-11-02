// E1: the demo's chapter 1 prints ONE compact table of every differing local value plus at most 5 NOTE lines.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localParams } from '../../shared/config.ts'
import { compactBanner, COMPACT_BANNER_MAX_COLS } from '../banner.ts'

const envs = [{}, { SIM_SLOWMO: '1' }, { TICKET_ROUND_SECONDS: '5' }, { SIM_ORDER: 'fifo', MAX_TXS_PER_ROUND: '4', FEED_AUTH: 'off' }] as const

test('compact banner: every differing local value is in the table, next to its Arbitrum One value', () => {
  const p = localParams('slow', {})
  const t = compactBanner(p).table.join('\n')
  for (const needle of [
    '2s', '250ms', '1s', '125ms', '0.01 gwei pinned', String(p.chainId), '42161', `${p.tickets.roundSeconds}s`, '24h', 'grandfather', '~0.5',
    '100 / 200', '1 USDGTest', '$17', 'price update fraction', '144', 'USDGTest', 'USDG', '50ms', 'Fast Feed auth', 'ON (ticket needed)',
    '10 rounds', 'none', '32 Mgas / 95 kB', `http://${p.host}:${p.rpcPort}`, `ws://${p.host}:${p.feedPort}`, p.anvilUrl,
  ]) assert.ok(t.includes(needle), `missing ${needle}:\n${t}`)
  assert.match(t, /^parameter +local +Arbitrum One$/m)
})

test('compact banner: slow motion, adaptation, cap and FIFO show up; at most 5 NOTE lines; table at most 100 columns', () => {
  for (const env of envs) {
    const c = compactBanner(localParams('slow', { ...env }))
    assert.ok(c.notes.length >= 1 && c.notes.length <= 4, `${JSON.stringify(env)}: ${c.notes.length} notes`)
    assert.ok(c.table.every((l) => l.length <= COMPACT_BANNER_MAX_COLS), c.table.join('\n'))
    assert.ok(c.notes.some((n) => n.includes('none is accelerated silently')))
    assert.ok(!c.notes.some((n) => /Every value/.test(n)), 'the note must not claim equal rows differ')
  }
  const slow = compactBanner(localParams('slow', { SIM_SLOWMO: '1' }))
  assert.match(slow.table.join('\n'), /25s \(slow motion ×100\) +250ms/)
  assert.match(slow.table.join('\n'), /\(adapted from 30s\)/)
  assert.ok(slow.notes.some((n) => n.startsWith('Slow motion ×100')))
  assert.ok(slow.notes.length <= 4)
  const fifo = compactBanner(localParams('slow', { SIM_ORDER: 'fifo', MAX_TXS_PER_ROUND: '4' }))
  assert.match(fifo.table.join('\n'), /FIFO \(PGA disabled\)/)
  assert.match(fifo.table.join('\n'), /4 txs per round/)
  const warn = compactBanner(localParams('slow', { SIM_SLOWMO: '1', TICKET_ROUND_SECONDS: '5' }))
  assert.ok(warn.notes.some((n) => n.startsWith('WARNING:')), 'a too-short explicit ticket round still warns')
  assert.ok(warn.notes.length <= 4)
})

test('E1 r1: no "Read more" note here (the chapter header has it); --pause folds its slow-motion hint into the one slow-motion note', () => {
  for (const env of envs) assert.ok(!compactBanner(localParams('slow', { ...env })).notes.some((n) => /Read more/.test(n)))
  const p = localParams('slow', { SIM_SLOWMO: '1' })
  const plain = compactBanner(p).notes.filter((n) => n.startsWith('Slow motion'))
  const paused = compactBanner(p, { pauseSlowmo: true }).notes.filter((n) => n.startsWith('Slow motion'))
  assert.equal(plain.length, 1)
  assert.equal(paused.length, 1)
  assert.match(paused[0]!, /--pause starts the simulator in slow motion; DEMO_SLOWMO=0/)
  assert.equal(compactBanner(p, { pauseSlowmo: true }).notes.length, compactBanner(p).notes.length)
})
