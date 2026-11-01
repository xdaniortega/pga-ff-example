// B5: the tentative rank narrated when a tx arrives, computed with the same selectRound as the real round.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGwei, type Address, type Hex } from 'viem'
import type { QueuedTx } from '../../pga/rules/pga-core.ts'
import { formatArrival, offsetIntoRound, senderLabel, tentativeRank } from '../sequencer.ts'

const BASE = 10_000_000n
const tx = (n: number, tipGwei: string, at: number, nonce = 0): QueuedTx => ({
  hash: `0x${n.toString(16).padStart(64, '0')}` as Hex,
  raw: '0x',
  from: `0x${n.toString(16).padStart(40, '0')}` as Address,
  nonce,
  maxFeePerGas: parseGwei('1'),
  maxPriorityFeePerGas: parseGwei(tipGwei),
  arrivedAt: at,
})

test('the 4th arrival (0.05 gwei) among 0.001, 0.01, 0.1 is rank 2 of 4', () => {
  const q = [tx(1, '0.001', 1), tx(2, '0.01', 2), tx(3, '0.1', 3)]
  const late = tx(4, '0.05', 4)
  assert.deepEqual(tentativeRank([...q, late], late, BASE, 'pga'), { rank: 2, of: 4 })
  assert.deepEqual(tentativeRank([q[0]!], q[0]!, BASE, 'pga'), { rank: 1, of: 1 })
  assert.deepEqual(tentativeRank(q, q[2]!, BASE, 'pga'), { rank: 1, of: 3 })
})

test('fifo: arrival decides, so the late tx is last', () => {
  const q = [tx(1, '0.001', 1), tx(2, '0.01', 2), tx(3, '0.1', 3), tx(4, '0.05', 4)]
  assert.deepEqual(tentativeRank(q, q[3]!, BASE, 'fifo'), { rank: 4, of: 4 })
})

test('a nonce-gapped tx has no rank; the block cap defers the lowest', () => {
  const a = tx(1, '0.1', 1, 5)
  assert.deepEqual(tentativeRank([a], a, BASE, 'pga', { nextNonce: new Map([[a.from.toLowerCase(), 3]]) }), { of: 1, excluded: 'nonce gap' })
  const q = [tx(1, '0.1', 1), tx(2, '0.2', 2), tx(3, '0.01', 3)]
  assert.deepEqual(tentativeRank(q, q[2]!, BASE, 'pga', { maxTxs: 2 }), { of: 3, excluded: 'block full' })
})

test('offsetIntoRound and the narration line', () => {
  assert.equal(offsetIntoRound(1000 + 3 * 10_000 + 5012, 1000, 10_000), 5012)
  const line = formatArrival({ hash: '0xab12cdef0000', from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', tipWei: parseGwei('0.05'), offsetMs: 5012, rank: { rank: 2, of: 4 } })
  assert.equal(line, 'arrival 0xab12cdef… from account 0 tip 0.05 gwei +5012ms into round → rank 2 of 4')
  assert.equal(senderLabel('0x0000000000000000000000000000000000000001'), undefined)
})
