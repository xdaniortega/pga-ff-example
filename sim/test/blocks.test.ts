// B6a: round/block arithmetic, the feed-vs-chain receipt comparison, and the read gate (pure, no Anvil).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareBlock, compareReceipts, currentRoundIndex, formatMismatch, gatedAnvil, roundPosition, RwGate, type PublishedFacts } from '../blocks.ts'
import type { Anvil } from '../chain.ts'

test('roundPosition: K = 2 gives pga_round 1,2,1,2 and slots 1,1,2,2; the multiples of K are the last rounds', () => {
  const rows = [1, 2, 3, 4, 5, 6].map((i) => roundPosition(i, 2))
  assert.deepEqual(rows.map((r) => r.pgaRound), [1, 2, 1, 2, 1, 2])
  assert.deepEqual(rows.map((r) => r.slot), [1, 1, 2, 2, 3, 3])
  assert.deepEqual(rows.map((r) => r.last), [false, true, false, true, false, true])
})

test('roundPosition works for any K', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((i) => roundPosition(i, 3).pgaRound), [1, 2, 3, 1, 2, 3, 1])
  assert.deepEqual([1, 2, 3, 4].map((i) => roundPosition(i, 3).slot), [1, 1, 1, 2])
  assert.equal(roundPosition(3, 3).last, true)
  assert.equal(roundPosition(2, 3).last, false)
})

test('currentRoundIndex: the round collecting txs at a wall-clock time (rounds end at t0 + i x roundMs)', () => {
  assert.equal(currentRoundIndex(1000, 1000, 500), 1)
  assert.equal(currentRoundIndex(1499, 1000, 500), 1)
  assert.equal(currentRoundIndex(1500, 1000, 500), 2)
})

const facts = (over: Partial<PublishedFacts['receipt']> = {}, txIndex = 1, hash = '0xAB'): PublishedFacts => ({
  hash,
  txIndex,
  receipt: {
    status: 1,
    gas_used: 21000,
    gas_used_for_l1: 0,
    cumulative_gas_used: 42000,
    effective_gas_price: 10_010_000,
    base_fee: 10_000_000,
    contract_address: null,
    logs: [{ address: '0xAa', topics: ['0x01', '0x02'], data: '0xBEEF' }],
    ...over,
  },
})

test('compareReceipts: equal facts (case-insensitive hex) have no mismatch', () => {
  assert.deepEqual(compareReceipts(facts(), facts({ logs: [{ address: '0xaa', topics: ['0x01', '0x02'], data: '0xbeef' }] }, 1, '0xab')), [])
})

test('compareReceipts reports every mismatching field', () => {
  const cases: [string, PublishedFacts][] = [
    ['tx_hash', facts({}, 1, '0xCD')],
    ['tx_index', facts({}, 2)],
    ['status', facts({ status: 0 })],
    ['gas_used', facts({ gas_used: 21001 })],
    ['cumulative_gas_used', facts({ cumulative_gas_used: 1 })],
    ['effective_gas_price', facts({ effective_gas_price: 1 })],
    ['base_fee', facts({ base_fee: 1 })],
    ['contract_address', facts({ contract_address: '0x1234' })],
    ['logs.length', facts({ logs: [] })],
    ['logs[0].address', facts({ logs: [{ address: '0xbb', topics: ['0x01', '0x02'], data: '0xbeef' }] })],
    ['logs[0].topics', facts({ logs: [{ address: '0xaa', topics: ['0x01'], data: '0xbeef' }] })],
    ['logs[0].data', facts({ logs: [{ address: '0xaa', topics: ['0x01', '0x02'], data: '0xbeee' }] })],
  ]
  for (const [field, other] of cases) {
    const m = compareReceipts(facts(), other)
    assert.deepEqual(m.map((x) => x.field), [field], field)
  }
  const [m] = compareReceipts(facts(), facts({ gas_used: 5 }))
  assert.equal(formatMismatch(7, '0xab', m!), '[sequencer] FEED RECEIPT MISMATCH block 7 tx 0xab gas_used: feed=21000 chain=5')
})

test('compareBlock: number, timestamp and pinned base fee', () => {
  const a = { number: 5, timestamp: 100, baseFee: 10n }
  assert.deepEqual(compareBlock(a, { ...a }), [])
  assert.deepEqual(compareBlock(a, { ...a, number: 6 }).map((m) => m.field), ['block.number'])
  assert.deepEqual(compareBlock(a, { ...a, timestamp: 101 }).map((m) => m.field), ['block.timestamp'])
  assert.deepEqual(compareBlock(a, { ...a, baseFee: 11n }).map((m) => m.field), ['block.baseFee'])
})

const tick = () => new Promise((r) => setTimeout(r, 20))

test('RwGate: reads wait while closed, resume after open, and close waits for reads in flight', async () => {
  const gate = new RwGate()
  assert.equal(await gate.run(async () => 1), 1) // open gate: runs at once
  let release!: () => void
  const slow = gate.run(() => new Promise<string>((r) => (release = () => r('slow'))))
  let closed = false
  const closing = gate.close().then(() => (closed = true))
  await tick()
  assert.equal(closed, false, 'close waits for the read already running')
  let ran = false
  const held = gate.run(async () => ((ran = true), 'held'))
  await tick()
  assert.equal(ran, false, 'new reads are held while closed')
  release()
  assert.equal(await slow, 'slow')
  await closing
  assert.equal(closed, true)
  assert.equal(ran, false)
  gate.open()
  assert.equal(await held, 'held')
  assert.equal(ran, true)
})

test('RwGate: a throwing read does not wedge the gate, and open() in a finally releases the held reads even after an error', async () => {
  const gate = new RwGate()
  await assert.rejects(gate.run(async () => { throw new Error('boom') }), /boom/)
  await gate.close() // no read in flight: resolves at once
  const held = gate.run(async () => 'ok')
  try {
    throw new Error('mine failed')
  } catch {
    /* the sequencer rethrows; the finally below still runs */
  } finally {
    gate.open()
  }
  assert.equal(await held, 'ok')
  assert.equal(gate.isClosed, false)
})

test('gatedAnvil: calls are routed through the gate; stop passes through', async () => {
  const gate = new RwGate()
  const calls: string[] = []
  const raw: Anvil = { url: 'u', call: async (m) => ((calls.push(m), m) as never), stop: async () => void calls.push('stop') }
  const g = gatedAnvil(raw, gate)
  await gate.close()
  const p = g.call('eth_call')
  await tick()
  assert.deepEqual(calls, [])
  gate.open()
  assert.equal(await p, 'eth_call')
  await g.stop()
  assert.deepEqual(calls, ['eth_call', 'stop'])
})
