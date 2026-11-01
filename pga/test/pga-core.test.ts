// Pure PGA rules: effective tip and per-round ordering. No Anvil.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGwei } from 'viem'
import { parseOrdering } from '../../shared/config.ts'
import { effectiveTip, gapExpired, selectRound, waitingForNonce } from '../rules/pga-core.ts'
import type { Address } from 'viem'

const BASE = parseGwei('0.01')
/** A distinct sender per name (nonce 0) unless given; the older tests are about cross-sender ordering. */
const addr = (n: string): Address => `0x${Buffer.from(n).toString('hex').padStart(40, '0')}`
const tx = (name: string, tip: string, maxFee: string, arrivedAt: number, from: string = name, nonce = 0) => ({
  name,
  from: addr(from),
  nonce,
  maxPriorityFeePerGas: parseGwei(tip),
  maxFeePerGas: parseGwei(maxFee),
  arrivedAt,
})

test('effective tip: normal case (tip 0.1, maxFee 1 -> 0.1 gwei)', () => {
  assert.equal(effectiveTip({ maxPriorityFeePerGas: parseGwei('0.1'), maxFeePerGas: parseGwei('1') }, BASE), parseGwei('0.1'))
})

test('effective tip: capped by maxFee - baseFee (tip 0.1, maxFee 0.05 -> exactly 0.04 gwei)', () => {
  const tip = effectiveTip({ maxPriorityFeePerGas: parseGwei('0.1'), maxFeePerGas: parseGwei('0.05') }, BASE)
  assert.equal(tip, parseGwei('0.04'))
  assert.equal(tip, 40_000_000n)
})

test('effective tip: zero tip', () => {
  assert.equal(effectiveTip({ maxPriorityFeePerGas: 0n, maxFeePerGas: parseGwei('1') }, BASE), 0n)
})

test('effective tip: maxFee below baseFee clamps to 0 (ASSUMPTION: docs do not say)', () => {
  assert.equal(effectiveTip({ maxPriorityFeePerGas: parseGwei('0.1'), maxFeePerGas: parseGwei('0.005') }, BASE), 0n)
})

test('effective tip: legacy gasPrice counts as both values (ASSUMPTION)', () => {
  assert.equal(effectiveTip({ gasPrice: parseGwei('1') }, BASE), parseGwei('0.99'))
})

test('selectRound: highest effective tip first', () => {
  const q = [tx('low', '0.001', '1', 1), tx('mid', '0.01', '1', 2), tx('high', '0.1', '1', 3)]
  assert.deepEqual(selectRound(q, BASE).ordered.map((t) => t.name), ['high', 'mid', 'low'])
})

test('selectRound: sorts by the effective tip, not the bid (capped bid loses)', () => {
  const q = [tx('capped', '0.1', '0.05', 1), tx('plain', '0.05', '1', 2)] // 0.04 vs 0.05
  assert.deepEqual(selectRound(q, BASE).ordered.map((t) => t.name), ['plain', 'capped'])
})

test('selectRound: ties are broken by arrival, earlier first', () => {
  const q = [tx('late', '0.01', '1', 30), tx('early', '0.01', '1', 10), tx('top', '0.1', '1', 20), tx('mid', '0.01', '1', 20)]
  assert.deepEqual(selectRound(q, BASE).ordered.map((t) => t.name), ['top', 'early', 'mid', 'late'])
})

test('selectRound: equal tip and equal arrival keep insertion order', () => {
  const q = [tx('a', '0.01', '1', 5), tx('b', '0.01', '1', 5)]
  assert.deepEqual(selectRound(q, BASE).ordered.map((t) => t.name), ['a', 'b'])
})

test('selectRound does not mutate its input', () => {
  const q = [tx('low', '0.001', '1', 1), tx('high', '0.1', '1', 2)]
  const before = [...q]
  const out = selectRound(q, BASE).ordered
  assert.notEqual(out, q)
  assert.deepEqual(q, before)
  assert.equal(q[0]!.name, 'low')
})

test('parseOrdering: fifo only for SIM_ORDER=fifo (any case), else pga', () => {
  assert.equal(parseOrdering({}), 'pga')
  assert.equal(parseOrdering({ SIM_ORDER: 'fifo' }), 'fifo')
  assert.equal(parseOrdering({ SIM_ORDER: ' FIFO ' }), 'fifo')
  assert.equal(parseOrdering({ SIM_ORDER: 'pga' }), 'pga')
  assert.equal(parseOrdering({ SIM_ORDER: 'nonsense' }), 'pga')
})

test('selectRound: a legacy gasPrice tx competes with its gasPrice - baseFee', () => {
  const legacy = { name: 'legacy', from: addr('legacy'), nonce: 0, gasPrice: parseGwei('0.05'), arrivedAt: 1 } // tip 0.04
  const typed = tx('typed', '0.03', '1', 2) // tip 0.03
  const typed2 = tx('typed2', '0.05', '1', 3) // tip 0.05
  assert.deepEqual(selectRound([typed, legacy, typed2], BASE).ordered.map((t) => t.name), ['typed2', 'legacy', 'typed'])
})

test('selectRound: tips above 2^53 wei compare exactly (no Number rounding)', () => {
  const big = 2n ** 60n
  const a = { name: 'a', from: addr('a'), nonce: 0, maxPriorityFeePerGas: big, maxFeePerGas: big * 2n, arrivedAt: 1 }
  const b = { name: 'b', from: addr('b'), nonce: 0, maxPriorityFeePerGas: big + 1n, maxFeePerGas: big * 2n, arrivedAt: 2 }
  assert.deepEqual(selectRound([a, b], BASE).ordered.map((t) => t.name), ['b', 'a'])
  assert.equal(effectiveTip(b, BASE), big + 1n)
})

// ---------------------------------------------------------------------------
// B2: nonce gating. https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
// ---------------------------------------------------------------------------
const next = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [addr(k), v] as const))
const names = (r: { name: string }[]) => r.map((t) => t.name)

test('nonce rule: N+1 is never placed before N, even with a 100x tip', () => {
  const q = [tx('hi1', '0.1', '1', 1, 'w', 6), tx('lo0', '0.001', '1', 2, 'w', 5)] // N+1 (100x tip) arrived first
  const r = selectRound(q, BASE, next({ w: 5 }))
  assert.deepEqual(names(r.ordered), ['lo0', 'hi1'])
  assert.deepEqual(r.held, [])
})

test('nonce rule: N+1 becomes eligible after N in the SAME round and is placed by its own tip against the others', () => {
  // w: nonce 5 tip 0.001, nonce 6 tip 0.1. x: tip 0.05. y: tip 0.0005.
  const q = [tx('w5', '0.001', '1', 1, 'w', 5), tx('w6', '0.1', '1', 2, 'w', 6), tx('x', '0.05', '1', 3), tx('y', '0.0005', '1', 4)]
  const r = selectRound(q, BASE, next({ w: 5, x: 0, y: 0 }))
  // x (0.05) first; then w5 (0.001) beats y; w6 joins at 0.1 right after w5 is included and is popped next; y last.
  assert.deepEqual(names(r.ordered), ['x', 'w5', 'w6', 'y'])
  assert.deepEqual(r.held, [])
})

test('nonce rule: an eligible N+1 with a tip below the others waits behind them', () => {
  const q = [tx('w5', '0.1', '1', 1, 'w', 5), tx('w6', '0.001', '1', 2, 'w', 6), tx('x', '0.01', '1', 3)]
  assert.deepEqual(names(selectRound(q, BASE, next({ w: 5, x: 0 })).ordered), ['w5', 'x', 'w6'])
})

test('gap: a tx above the sender next nonce with no predecessor waiting is held, not ordered', () => {
  const q = [tx('gap', '0.1', '1', 1, 'w', 7), tx('other', '0.001', '1', 2)]
  const r = selectRound(q, BASE, next({ w: 5, other: 0 }))
  assert.deepEqual(names(r.ordered), ['other'])
  assert.deepEqual(names(r.held), ['gap'])
})

test('gap: a chain whose first nonce is missing is held entirely; a chain that starts at next nonce is not', () => {
  const q = [tx('a6', '0.1', '1', 1, 'w', 6), tx('a7', '0.1', '1', 2, 'w', 7), tx('b5', '0.01', '1', 3, 'v', 5), tx('b6', '0.01', '1', 4, 'v', 6)]
  const r = selectRound(q, BASE, next({ w: 5, v: 5 }))
  assert.deepEqual(names(r.ordered), ['b5', 'b6'])
  assert.deepEqual(names(r.held), ['a6', 'a7'])
})

test('gap hold: dropped after GAP_HOLD_ROUNDS rounds (pure helper)', () => {
  assert.equal(gapExpired(1, 10), false)
  assert.equal(gapExpired(9, 10), false)
  assert.equal(gapExpired(10, 10), true)
  assert.equal(gapExpired(11, 10), true)
})

test('mixed senders: per-sender nonce order, cross-sender tip order', () => {
  const q = [
    tx('a0', '0.002', '1', 1, 'a', 0), tx('a1', '0.5', '1', 2, 'a', 1),
    tx('b0', '0.2', '1', 3, 'b', 0), tx('b1', '0.001', '1', 4, 'b', 1),
    tx('c0', '0.05', '1', 5, 'c', 0),
  ]
  const r = selectRound(q, BASE, next({ a: 0, b: 0, c: 0 }))
  // eligible: a0 .002, b0 .2, c0 .05 -> b0; then b1 joins at .001; c0; then a0 (.002) beats b1 (.001); a1 (.5) right after a0; b1 last
  assert.deepEqual(names(r.ordered), ['b0', 'c0', 'a0', 'a1', 'b1'])
  const pos = (n: string) => names(r.ordered).indexOf(n)
  assert.ok(pos('a0') < pos('a1') && pos('b0') < pos('b1'))
})

test('fifo mode: arrival order across senders, nonce rule still holds', () => {
  const q = [tx('w6', '0.1', '1', 1, 'w', 6), tx('x', '0.001', '1', 2), tx('w5', '0.001', '1', 3, 'w', 5)]
  const r = selectRound(q, BASE, next({ w: 5, x: 0 }), 'fifo')
  assert.deepEqual(names(r.ordered), ['x', 'w5', 'w6'])
})

test('selectRound with nonce gating does not mutate its inputs', () => {
  const q = [tx('w6', '0.1', '1', 1, 'w', 6), tx('w5', '0.001', '1', 2, 'w', 5), tx('gap', '0.1', '1', 3, 'g', 9)]
  const snapshot = JSON.stringify(q, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
  const nn = next({ w: 5, g: 0 })
  const nnBefore = [...nn]
  const r = selectRound(q, BASE, nn)
  assert.equal(JSON.stringify(q, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), snapshot)
  assert.deepEqual([...nn], nnBefore)
  assert.notEqual(r.ordered, q)
  assert.deepEqual(q.map((t) => t.name), ['w6', 'w5', 'gap'])
})

test('duplicate (sender, nonce): the second copy is held and never included', () => {
  const q = [tx('first', '0.001', '1', 1, 'w', 5), tx('dup', '0.5', '1', 2, 'w', 5)]
  const r = selectRound(q, BASE, next({ w: 5 }))
  assert.deepEqual(names(r.ordered), ['first'])
  assert.deepEqual(names(r.held), ['dup'])
})

test('stale nonce below nextNonce: never ordered (held for the caller to drop)', () => {
  const q = [tx('stale', '0.5', '1', 1, 'w', 3), tx('ok', '0.001', '1', 2, 'w', 5)]
  const r = selectRound(q, BASE, next({ w: 5 }))
  assert.deepEqual(names(r.ordered), ['ok'])
  assert.deepEqual(names(r.held), ['stale'])
})

test('a sender missing from nextNonce: its lowest waiting nonce starts a multi-nonce chain', () => {
  const q = [tx('c7', '0.9', '1', 1, 'w', 7), tx('c5', '0.001', '1', 2, 'w', 5), tx('c6', '0.5', '1', 3, 'w', 6), tx('x', '0.01', '1', 4)]
  const r = selectRound(q, BASE, next({ x: 0 }))
  assert.deepEqual(names(r.ordered), ['x', 'c5', 'c6', 'c7'])
  assert.deepEqual(r.held, [])
})

test('mixed-case and checksummed from addresses are the same sender', () => {
  const lower = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address
  const checksum = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address
  const q = [
    { ...tx('hi1', '0.5', '1', 1), from: checksum, nonce: 6 },
    { ...tx('lo0', '0.001', '1', 2), from: lower, nonce: 5 },
  ]
  const r = selectRound(q, BASE, new Map([[lower, 5]]))
  assert.deepEqual(names(r.ordered), ['lo0', 'hi1'])
})

test('waitingForNonce: the first nonce missing from the contiguous run starting at nextNonce', () => {
  assert.equal(waitingForNonce(5, []), 5)
  assert.equal(waitingForNonce(5, [5, 6]), 7) // N, N+1 ordered, N+3 held -> waiting for N+2
  assert.equal(waitingForNonce(5, [6, 7]), 5)
})

// ---------------------------------------------------------------------------
// B3: boost per round and the block-full cap. https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
// ---------------------------------------------------------------------------
import { runRound } from '../rules/pga-core.ts'
import type { Hex } from 'viem'

const P = parseGwei('0.01') // the marginal paying tip p
const h = (n: string): Hex => `0x${Buffer.from(n).toString('hex').padStart(64, '0')}`
const htx = (name: string, tip: string, arrivedAt: number, from: string = name, nonce = 0) => ({ ...tx(name, tip, '1', arrivedAt, from, nonce), hash: h(name) })
type HTx = ReturnType<typeof htx>

/** Run `rounds` rounds with a fresh paying tx per round at tip p (cap 1), carrying the waiting list and boosts across rounds. */
function simulate(k: number, rounds: number, extra: HTx[], cap = 1) {
  let queue: HTx[] = [...extra]
  let boosts = new Map<Hex, bigint>()
  const log: { priorityOf: Map<string, bigint>; included: string[]; p: bigint; boost: bigint }[] = []
  for (let r = 0; r < rounds; r++) {
    for (let j = 0; j < cap; j++) queue.push(htx(`f${r}_${j}`, '0.01', 1000 + r * 10 + j))
    const priorityOf = new Map(queue.map((t) => [t.name, effectiveTip(t, BASE) + (boosts.get(t.hash) ?? 0n)]))
    const res = runRound(queue, boosts, BASE, new Map(), 'pga', { k, maxTxs: cap })
    log.push({ priorityOf, included: res.ordered.map((t) => t.name), p: res.p, boost: res.boost })
    queue = res.waiting
    boosts = res.boosts
  }
  return log
}

test('boost: K=2, constant p: a zero-tip tx goes 0, p/4, p/2, 3p/4, p, ties a fresh tx tipping p and wins on arrival', () => {
  const zero = htx('zero', '0', 1) // arrives first (arrivedAt 1 < 1000)
  const log = simulate(2, 5, [zero])
  assert.deepEqual(log.map((l) => l.priorityOf.get('zero')), [0n, P / 4n, P / 2n, (3n * P) / 4n, P])
  assert.deepEqual(log.map((l) => l.boost), [P / 4n, P / 4n, P / 4n, P / 4n, P / 4n]) // p stays flat, so p/(2K) = p/4 every round
  // Rounds 0-3 include a fresh paying tx; round 4 (priority p, tie with the fresh tx) includes zero first: earlier arrival.
  assert.deepEqual(log.map((l) => l.included[0]), ['f0_0', 'f1_0', 'f2_0', 'f3_0', 'zero'])
  assert.equal(log[4]!.priorityOf.get('f4_0'), P) // the fresh tx it tied with
})

test('boost: exactly p/(2K) per round for K = 2 and K = 4', () => {
  for (const k of [2, 4]) {
    const log = simulate(k, 2 * k + 1, [htx('zero', '0', 1)])
    assert.equal(log[0]!.boost, P / BigInt(2 * k))
    const prio = log.map((l) => l.priorityOf.get('zero')!)
    assert.deepEqual(prio.slice(0, 2 * k + 1), Array.from({ length: 2 * k + 1 }, (_, i) => (BigInt(i) * P) / BigInt(2 * k)))
    assert.equal(prio[2 * k], P, `K=${k}: after 2K rounds the priority is p`)
    assert.equal(log[2 * k]!.included[0], 'zero')
  }
})

test('boost: p = 0 when the round included nothing, so nothing is added', () => {
  // Only a gap-held tx waits: nothing is included, p = 0, boost 0.
  const gap = htx('gap', '0', 1, 'w', 9)
  const res = runRound([gap], new Map(), BASE, new Map([[addr('w'), 5]]), 'pga', { k: 2, maxTxs: 3 })
  assert.equal(res.ordered.length, 0)
  assert.equal(res.p, 0n)
  assert.equal(res.boost, 0n)
  assert.equal(res.boosts.get(gap.hash), 0n)
})

test('boost: p is the priority (tip + boost) of the LAST tx included', () => {
  const low = htx('low', '0.002', 1)
  const high = htx('high', '0.01', 2)
  const boosts = new Map<Hex, bigint>([[low.hash, parseGwei('0.001')]])
  const res = runRound([low, high], boosts, BASE, new Map(), 'pga', { k: 2, maxTxs: 0 })
  assert.deepEqual(res.ordered.map((t) => t.name), ['high', 'low'])
  assert.equal(res.p, parseGwei('0.003')) // low: 0.002 tip + 0.001 boost, included last
  assert.equal(res.boost, parseGwei('0.003') / 4n)
})

test('boost never changes the effective tip used for fees (it only changes the ordering key)', () => {
  const zero = htx('zero', '0', 1)
  const before = effectiveTip(zero, BASE)
  const res = runRound([zero, htx('a', '0.01', 2)], new Map([[zero.hash, parseGwei('0.5')]]), BASE, new Map(), 'pga', { k: 2, maxTxs: 0 })
  assert.equal(res.ordered[0]!.name, 'zero') // a huge boost wins the position ...
  assert.equal(effectiveTip(res.ordered[0]!, BASE), before) // ... but the tx's tip, the only input to a fee, is untouched
  assert.equal(before, 0n)
  assert.equal(res.ordered[0]!.maxPriorityFeePerGas, 0n)
  assert.equal(res.priorities[0], parseGwei('0.5'))
})

test('cap: at most maxTxs per round, the rest are carried over (deferred) in order, with boosts', () => {
  const q = [htx('a', '0.05', 1), htx('b', '0.04', 2), htx('c', '0.03', 3), htx('d', '0.02', 4), htx('e', '0', 5)]
  const res = runRound(q, new Map(), BASE, new Map(), 'pga', { k: 2, maxTxs: 3 })
  assert.deepEqual(names(res.ordered), ['a', 'b', 'c'])
  assert.deepEqual(names(res.deferred), ['d', 'e'])
  assert.deepEqual(res.held, [])
  assert.deepEqual(names(res.waiting), ['d', 'e'])
  assert.equal(res.p, parseGwei('0.03'))
  assert.equal(res.boosts.get(h('d')), parseGwei('0.03') / 4n)
  assert.equal(res.boosts.has(h('a')), false, 'included txs carry no boost')
  const none = runRound(q, new Map(), BASE, new Map(), 'pga', { k: 2, maxTxs: 0 })
  assert.equal(none.ordered.length, 5, 'no cap: everything is included')
  assert.deepEqual(none.waiting, [], 'no cap and no gap: nothing is carried over, so nothing is boosted')
  assert.equal(none.boosts.size, 0)
})

test('nonce gating still holds with boosted txs: a boosted N+1 is never placed before its N', () => {
  const n5 = htx('n5', '0', 1, 'w', 5)
  const n6 = htx('n6', '0', 2, 'w', 6)
  const other = htx('x', '0.01', 3)
  // N+1 carries a big boost, N a small one: a plain priority sort would put N+1 first.
  const boosts = new Map<Hex, bigint>([[n6.hash, parseGwei('1')], [n5.hash, parseGwei('0.001')]])
  const res = runRound([n6, n5, other], boosts, BASE, new Map([[addr('w'), 5], [addr('x'), 0]]), 'pga', { k: 2, maxTxs: 0 })
  assert.deepEqual(names(res.ordered), ['x', 'n5', 'n6']) // x (0.01) beats n5 (0.001 boost); n6 joins only after n5
  assert.ok(names(res.ordered).indexOf('n5') < names(res.ordered).indexOf('n6'))
})

test('nonce gating with the cap: a sender\'s N+1 stays behind N and is deferred, not held; a gap tx is held and boosted too', () => {
  const q = [htx('a5', '0.05', 1, 'a', 5), htx('a6', '0.05', 2, 'a', 6), htx('b0', '0.01', 3), htx('gap', '0.9', 4, 'g', 9)]
  const res = runRound(q, new Map(), BASE, new Map([[addr('a'), 5], [addr('b'), 0], [addr('g'), 0]]), 'pga', { k: 2, maxTxs: 1 })
  assert.deepEqual(names(res.ordered), ['a5'])
  assert.deepEqual(names(res.deferred), ['a6', 'b0']) // behind the full block, eligible next round
  assert.deepEqual(names(res.held), ['gap']) // behind a nonce gap
  // ASSUMPTION (sim/README.md): a gap-held tx is "still waiting", so it is boosted too.
  assert.equal(res.boosts.get(h('gap')), res.boost)
  assert.equal(res.boosts.get(h('a6')), res.boost)
})

test('fifo mode: boosts do not reorder (everything ranks at 0) and p = 0', () => {
  const a = htx('a', '0.5', 1)
  const b = htx('b', '0', 2)
  const res = runRound([a, b], new Map([[b.hash, parseGwei('9')]]), BASE, new Map(), 'fifo', { k: 2, maxTxs: 1 })
  assert.deepEqual(names(res.ordered), ['a'])
  assert.equal(res.p, 0n)
  assert.equal(res.boost, 0n)
})

test('runRound is pure: inputs are untouched and the same inputs give the same result', () => {
  const q: HTx[] = [htx('a', '0.05', 1), htx('b', '0', 2), htx('c', '0.01', 3, 'w', 4)]
  const boosts = new Map<Hex, bigint>([[q[1]!.hash, 5n]])
  const nn = new Map([[addr('w'), 0]])
  const snap = JSON.stringify([q, [...boosts], [...nn]], (_, v) => (typeof v === 'bigint' ? v.toString() : v))
  const r1 = runRound(q, boosts, BASE, nn, 'pga', { k: 2, maxTxs: 1 })
  const r2 = runRound(q, boosts, BASE, nn, 'pga', { k: 2, maxTxs: 1 })
  assert.equal(JSON.stringify([q, [...boosts], [...nn]], (_, v) => (typeof v === 'bigint' ? v.toString() : v)), snap)
  assert.deepEqual(r1, r2)
  assert.notEqual(r1.boosts, boosts)
})

test('boost flooring: p = 10 wei, K = 2 gives 2 wei per round and the floors accumulate (2, 4, 6, ...)', () => {
  const zero = htx('zero', '0', 1)
  let boosts = new Map<Hex, bigint>()
  let queue: HTx[] = [zero]
  const seen: bigint[] = []
  for (let r = 0; r < 4; r++) {
    // a payer whose tip is exactly 10 wei, fresh each round, cap 1: the zero tip waits
    const payer = { ...htx(`p${r}`, '0', 100 + r), maxPriorityFeePerGas: 10n, maxFeePerGas: parseGwei('1') }
    queue = [...queue, payer]
    const res = runRound(queue, boosts, BASE, new Map(), 'pga', { k: 2, maxTxs: 1 })
    assert.equal(res.p, 10n)
    assert.equal(res.boost, 2n) // 10 / (2 x 2) = 2.5 -> floored to 2
    queue = res.waiting
    boosts = res.boosts
    seen.push(boosts.get(zero.hash)!)
  }
  assert.deepEqual(seen, [2n, 4n, 6n, 8n])
})
