// B6b: the sequencer's open-block state machine against a FAKE Anvil (no process, no ports). The sequencer only needs the
// `Anvil` and `FeedServer` interfaces, so each failure path is driven deterministically:
//   revert returns false, a re-mine that throws, a rejected resubmit of a published tx, an empty provisional block,
//   a skipped closing tick, K = 3, the receipt-mismatch counter, and cap / boost / gap hold across the rounds of one block.
// Rounds are run by calling the private `runRound(i)` directly (no timers).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGwei, type Address, type Hex } from 'viem'
import { localParams, type LocalParams } from '../../shared/config.ts'
import type { FeedMessage, FeedServer } from '../../fast-feed/mock/feed.ts'
import type { Anvil } from '../chain.ts'
import { RwGate } from '../blocks.ts'
import { SimClock } from '../clock.ts'
import { setInternalVisible } from '../../shared/narrate.ts'
import { Sequencer, type RoundInfo } from '../sequencer.ts'

// ---------------------------------------------------------------------------
// The fake chain: just enough of Anvil (--no-mining) for the sequencer
// ---------------------------------------------------------------------------

interface FakeTx {
  raw: Hex
  hash: Hex
  from: string
  nonce: number
}
interface FakeBlock {
  number: number
  timestamp: number
  txs: FakeTx[]
}

class FakeAnvil implements Anvil {
  url = 'fake://anvil'
  blocks: FakeBlock[] = [{ number: 0, timestamp: 1_000, txs: [] }]
  pool: FakeTx[] = []
  readonly byRaw = new Map<string, FakeTx>()
  private snapshots = new Map<string, FakeBlock[]>()
  private snapNo = 0
  /** Every call, in order, as `method`. */
  calls: string[] = []
  /** Raw txs `eth_sendRawTransaction` rejects. */
  reject = new Set<string>()
  /** Hashes `evm_mine` leaves in the pool instead of mining (like an unaffordable tx). */
  omit = new Set<string>()
  /** `evm_revert` answers false (and does nothing). */
  revertFalse = false
  /** `evm_revert` throws. */
  revertThrows = false
  /** When set, receipt reads wait for it (to observe the sequencer mid-round). */
  receiptGate?: Promise<void>
  /** Make the n-th (1-based) `evm_mine` throw. */
  failMine?: number
  private mines = 0
  /** Receipt facts that depend on how often the block was mined (to force a feed/chain difference). */
  receiptSalt: (mineNo: number) => number = () => 0
  private mineOfBlock = new Map<number, number>()

  register(tx: FakeTx): FakeTx {
    this.byRaw.set(tx.raw, tx)
    return tx
  }
  get head(): FakeBlock {
    return this.blocks[this.blocks.length - 1]!
  }
  private nonceOf(a: string): number {
    return this.blocks.flatMap((b) => b.txs).filter((t) => t.from === a.toLowerCase()).length
  }
  private find(hash: string): { tx: FakeTx; block: FakeBlock; idx: number } | undefined {
    for (const b of this.blocks) {
      const idx = b.txs.findIndex((t) => t.hash.toLowerCase() === hash.toLowerCase())
      if (idx >= 0) return { tx: b.txs[idx]!, block: b, idx }
    }
    return undefined
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push(method)
    const hex = (n: number | bigint) => '0x' + n.toString(16)
    switch (method) {
      case 'eth_getTransactionCount':
        return hex(this.nonceOf(String(params[0]))) as T
      case 'eth_sendRawTransaction': {
        const raw = String(params[0])
        if (this.reject.has(raw)) throw new Error('fake anvil: transaction rejected')
        const tx = this.byRaw.get(raw)
        if (!tx) throw new Error(`fake anvil: unknown raw ${raw}`)
        if (!this.pool.includes(tx)) this.pool.push(tx)
        return tx.hash as T
      }
      case 'anvil_setNextBlockBaseFeePerGas':
        return null as T
      case 'evm_snapshot': {
        const id = hex(++this.snapNo)
        this.snapshots.set(id, this.blocks.map((b) => ({ ...b, txs: [...b.txs] })))
        return id as T
      }
      case 'evm_revert': {
        if (this.revertThrows) throw new Error('fake anvil: revert failed')
        if (this.revertFalse) return false as T
        const snap = this.snapshots.get(String(params[0]))
        if (!snap) return false as T
        const gone = this.blocks.filter((b) => !snap.some((s) => s.number === b.number))
        this.blocks = snap
        this.pool.push(...gone.flatMap((b) => b.txs)) // Anvil puts the reverted block's txs back in its pool
        return true as T
      }
      case 'anvil_dropAllTransactions':
        this.pool = []
        return null as T
      case 'anvil_dropTransaction':
        this.pool = this.pool.filter((t) => t.hash !== params[0])
        return null as T
      case 'evm_mine': {
        this.mines++
        if (this.failMine === this.mines) throw new Error('fake anvil: mine failed')
        const mined = this.pool.filter((t) => !this.omit.has(t.hash))
        this.pool = this.pool.filter((t) => this.omit.has(t.hash))
        const number = this.head.number + 1
        this.blocks.push({ number, timestamp: Number(params[0] ?? this.head.timestamp + 1), txs: mined })
        this.mineOfBlock.set(number, this.mines)
        return null as T
      }
      case 'eth_blockNumber':
        return hex(this.head.number) as T
      case 'eth_getBlockByNumber': {
        const b = params[0] === 'latest' ? this.head : this.blocks.find((x) => x.number === Number(BigInt(String(params[0]))))
        return (b ? { number: hex(b.number), timestamp: hex(b.timestamp), baseFeePerGas: hex(parseGwei('0.01')), transactions: b.txs.map((t) => t.hash) } : null) as T
      }
      case 'eth_getTransactionReceipt': {
        if (this.receiptGate) await this.receiptGate
        const f = this.find(String(params[0]))
        if (!f) return null as T
        const salt = this.receiptSalt(this.mineOfBlock.get(f.block.number) ?? 0)
        return {
          transactionHash: f.tx.hash,
          transactionIndex: hex(f.idx),
          blockNumber: hex(f.block.number),
          status: '0x1',
          gasUsed: hex(21_000 + salt),
          cumulativeGasUsed: hex(21_000 * (f.idx + 1) + salt),
          effectiveGasPrice: hex(parseGwei('0.011')),
          contractAddress: null,
          logs: [],
        } as T
      }
      case 'eth_getRawTransactionByHash': {
        const f = this.find(String(params[0]))
        return (f ? f.tx.raw : null) as T
      }
      default:
        throw new Error(`fake anvil: unsupported ${method}`)
    }
  }
  async stop(): Promise<void> {}
}

class FakeFeed implements FeedServer {
  messages: FeedMessage[] = []
  publish(m: FeedMessage): void {
    this.messages.push(m)
  }
  clientCount(): number {
    return 0
  }
  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let nextTx = 1
const BASE = parseGwei('0.01')
function mkTx(anvil: FakeAnvil, tipGwei: string, o: { from?: number; nonce?: number } = {}) {
  const n = nextTx++
  const from = `0x${(o.from ?? n).toString(16).padStart(40, '0')}`
  const tx = anvil.register({ raw: `0xraw${n}` as Hex, hash: `0x${n.toString(16).padStart(64, '0')}` as Hex, from, nonce: o.nonce ?? 0 })
  return { fake: tx, q: { hash: tx.hash, raw: tx.raw, from: from as Address, nonce: tx.nonce, maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei(tipGwei) } }
}

function setup(over: Partial<LocalParams> = {}, clock?: SimClock) {
  const anvil = new FakeAnvil()
  const feed = new FakeFeed()
  const gate = new RwGate()
  const rounds: RoundInfo[] = []
  const p: LocalParams = { ...localParams('slow', {}), blockPublishDelayMs: 0, baseFeeWei: BASE, ...over }
  const seq = new Sequencer(p, anvil, feed, (r) => rounds.push(r), 0, gate, clock)
  const run = (i: number) => (seq as unknown as { runRound(i: number): Promise<void> }).runRound(i)
  const add = (t: ReturnType<typeof mkTx>) => seq.enqueue(t.q)
  return { anvil, feed, gate, rounds, seq, run, add, p }
}

/** Collect the console.log lines a callback prints (the sequencer's always-visible lines). */
async function logs<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: Error; lines: string[] }> {
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => void lines.push(a.join(' '))
  try {
    return { result: await fn(), lines }
  } catch (e) {
    return { error: e as Error, lines }
  } finally {
    console.log = orig
  }
}

// ---------------------------------------------------------------------------

test('K = 2: round 1 publishes pga_round 1 at once, round 2 re-mines the same block N and publishes pga_round 2; no mismatch', async () => {
  const { anvil, feed, run, add, seq, gate } = setup()
  const a = mkTx(anvil, '0.1')
  const b = mkTx(anvil, '0.5')
  add(a)
  await run(1)
  assert.deepEqual(feed.messages.map((m) => [m.transaction.block_number, m.pga_round, m.transaction.tx_index]), [[1, 1, 0]])
  assert.equal(seq.revealedHead(Date.now() + 10_000), 0, 'the open block is not revealed before its last round')
  add(b)
  await run(2)
  assert.deepEqual(feed.messages.map((m) => [m.transaction.block_number, m.pga_round, m.transaction.tx_index]), [[1, 1, 0], [1, 2, 1]])
  assert.equal(anvil.head.number, 1, 'one block holds both rounds')
  assert.deepEqual(anvil.head.txs.map((t) => t.hash), [a.fake.hash, b.fake.hash], 'round 2 only adds after round 1')
  assert.equal(seq.receiptMismatches, 0)
  assert.equal(seq.revealedHead(Date.now() + 10_000), 1)
  assert.equal(gate.isClosed, false)
})

test('revert returns false: counted as a mismatch, the round is mined as a new block, the gate is released', async () => {
  const { anvil, feed, run, add, seq, gate } = setup()
  const a = mkTx(anvil, '0.1')
  const b = mkTx(anvil, '0.2')
  add(a)
  await run(1)
  anvil.revertFalse = true
  add(b)
  const { lines } = await logs(() => run(2))
  assert.equal(seq.receiptMismatches, 1)
  assert.ok(lines.some((l) => l.includes('FEED RECEIPT MISMATCH') && l.includes('evm_revert returned false')), lines.join('\n'))
  assert.equal(anvil.head.number, 2, 'a new block after the stale one')
  assert.equal(feed.messages.at(-1)!.transaction.block_number, 2)
  assert.equal(gate.isClosed, false)
})

test('re-mine throws after the revert: the gate is released, the pool is cleaned, the txs are forgotten, lastMined follows the head', async () => {
  const { anvil, feed, run, add, seq, gate } = setup()
  const a = mkTx(anvil, '0.1')
  const b = mkTx(anvil, '0.2')
  add(a)
  await run(1) // evm_mine #1
  anvil.failMine = 2
  add(b)
  const { error, lines } = await logs(() => run(2))
  assert.match(error?.message ?? '', /mine failed/)
  assert.equal(gate.isClosed, false, 'the read gate must be open again')
  assert.deepEqual(anvil.pool, [], "Anvil's pool was cleared, so nothing can be mined later outside our ordering")
  assert.equal(seq.isKnown(a.fake.hash), false, 'the published tx is forgotten')
  assert.equal(seq.isKnown(b.fake.hash), false, 'the ordered tx is forgotten')
  assert.equal(seq.receiptMismatches, 1, 'the one published tx was NOT mined')
  assert.ok(lines.some((l) => l.includes('forgot 2 tx(s)')), lines.join('\n'))
  assert.equal(anvil.head.number, 0, 'the revert removed block 1')
  assert.equal(seq.blockInfo().block, 1, 'lastMined follows the real head (0), so the next block is 1')
  assert.equal(feed.messages.length, 1, 'only round 1 was ever published')
})

test('evm_revert itself throws: the published round-1 txs count as a failure and everything is forgotten and cleaned', async () => {
  const { anvil, feed, run, add, seq, gate } = setup()
  const a = mkTx(anvil, '0.1')
  const b = mkTx(anvil, '0.2')
  add(a)
  await run(1)
  anvil.revertThrows = true
  add(b)
  const { error, lines } = await logs(() => run(2))
  assert.match(error?.message ?? '', /revert failed/)
  assert.equal(gate.isClosed, false)
  assert.equal(seq.receiptMismatches, 1, 'the one published tx is counted')
  assert.deepEqual(anvil.pool, [])
  assert.equal(seq.isKnown(a.fake.hash), false)
  assert.equal(seq.isKnown(b.fake.hash), false)
  assert.ok(lines.some((l) => l.includes('forgot 2 tx(s)')), lines.join('\n'))
  assert.equal(feed.messages.length, 1)
})

test('blockInfo reports the open block number while round 1 and round 2 of that block are mid-flight', async () => {
  const { anvil, run, add, seq } = setup()
  const a = mkTx(anvil, '0.1')
  const b = mkTx(anvil, '0.2')
  add(a)
  let release!: () => void
  anvil.receiptGate = new Promise<void>((r) => (release = r))
  const p1 = run(1)
  while (!anvil.calls.includes('eth_getTransactionReceipt')) await new Promise((r) => setTimeout(r, 1))
  assert.equal(seq.blockInfo().block, 1, 'round 1 mined block 1 but has not finished: still block 1, not 2')
  release()
  await p1
  assert.equal(seq.blockInfo().block, 1, 'open block between rounds')
  add(b)
  anvil.receiptGate = new Promise<void>((r) => (release = r))
  anvil.calls.length = 0
  const p2 = run(2)
  while (!anvil.calls.includes('eth_getTransactionReceipt')) await new Promise((r) => setTimeout(r, 1))
  assert.equal(seq.blockInfo().block, 1, 'round 2 re-mined block 1: still block 1 mid-flight')
  release()
  await p2
})

test('a published tx that Anvil rejects on the re-submit is counted, and its absence from the final block too', async () => {
  const { anvil, feed, run, add, seq } = setup()
  const a = mkTx(anvil, '0.1')
  const b = mkTx(anvil, '0.2')
  add(a)
  await run(1)
  add(b)
  anvil.reject.add(a.fake.raw) // the resubmit of A fails (round 1's own submit already succeeded)
  const { lines } = await logs(() => run(2))
  assert.equal(seq.receiptMismatches, 2, 'resubmit rejected + "not in the final block"')
  assert.ok(lines.some((l) => l.includes('resubmit') && l.includes(a.fake.hash)), lines.join('\n'))
  assert.ok(lines.some((l) => l.includes('not in the final block')), lines.join('\n'))
  assert.equal(feed.messages.length, 2)
  assert.deepEqual(anvil.head.txs.map((t) => t.hash), [b.fake.hash])
})

test('an empty provisional block (Anvil leaves the only tx out) is undone: no open block, lastMined back, the tx evicted', async () => {
  const { anvil, feed, rounds, run, add, seq } = setup()
  const a = mkTx(anvil, '0.1')
  anvil.omit.add(a.fake.hash)
  add(a)
  const { lines } = await logs(() => run(1))
  assert.equal(anvil.head.number, 0, 'the provisional block was reverted')
  assert.deepEqual(anvil.pool, [], 'the omitted tx cannot be mined later')
  assert.equal(feed.messages.length, 0)
  assert.equal(seq.blockInfo().block, 1)
  assert.deepEqual([rounds.at(-1)!.ordered, rounds.at(-1)!.dropped, rounds.at(-1)!.blockOpen], [0, 1, false])
  assert.ok(lines.some((l) => l.includes('dropped') && l.includes('not included')), lines.join('\n'))
  // the next round starts a fresh block (there is no open block to revert)
  const b = mkTx(anvil, '0.2')
  add(b)
  await run(2)
  assert.equal(feed.messages[0]!.transaction.block_number, 1)
  assert.equal(feed.messages[0]!.pga_round, 2, 'round 2 of slot 1, block 1 (round 1 had nothing)')
})

test('a skipped closing tick closes the stale block (re-mined, revealed) before the next slot starts', async () => {
  const { anvil, feed, run, add, seq } = setup()
  const a = mkTx(anvil, '0.1')
  const b = mkTx(anvil, '0.2')
  add(a)
  await run(1)
  add(b)
  await run(3) // tick 2 (the closing tick of slot 1) was skipped: round 3 is round 1 of slot 2
  assert.deepEqual(feed.messages.map((m) => [m.transaction.block_number, m.pga_round]), [[1, 1], [2, 1]])
  assert.equal(anvil.blocks[1]!.txs.length, 1, 'block 1 holds A only, final')
  assert.equal(seq.revealedHead(Date.now() + 10_000), 1, 'block 1 is revealed; block 2 is still open')
  assert.equal(seq.receiptMismatches, 0)
})

test('K = 3: pga_round 1, 2, 3 in one block, snapshots after rounds 1 and 2, revealed only after round 3', async () => {
  const { anvil, feed, run, add, seq } = setup({ k: 3, roundMs: 666, blockMs: 2000 })
  const [a, b, c] = [mkTx(anvil, '0.1'), mkTx(anvil, '0.3'), mkTx(anvil, '0.2')]
  add(a)
  await run(1)
  add(b)
  await run(2)
  assert.equal(seq.revealedHead(Date.now() + 10_000), 0)
  add(c)
  await run(3)
  assert.deepEqual(feed.messages.map((m) => [m.transaction.block_number, m.pga_round, m.transaction.tx_index]), [[1, 1, 0], [1, 2, 1], [1, 3, 2]])
  assert.deepEqual(anvil.head.txs.map((t) => t.hash), [a.fake.hash, b.fake.hash, c.fake.hash])
  assert.equal(anvil.calls.filter((m) => m === 'evm_snapshot').length, 2)
  assert.equal(seq.revealedHead(Date.now() + 10_000), 1)
  assert.equal(seq.receiptMismatches, 0)
  assert.equal(seq.blockInfo().k, 3)
})

test('the receipt check fires when the final receipts differ from what was published', async () => {
  const { anvil, run, add, seq } = setup()
  anvil.receiptSalt = (mineNo) => (mineNo >= 2 ? 5 : 0) // the re-mine (2nd evm_mine) changes gas_used
  const a = mkTx(anvil, '0.1')
  const b = mkTx(anvil, '0.2')
  add(a)
  await run(1)
  add(b)
  const { lines } = await logs(() => run(2))
  assert.ok(seq.receiptMismatches >= 2, `gas_used and cumulative_gas_used differ: ${seq.receiptMismatches}`)
  assert.ok(lines.some((l) => l.includes('FEED RECEIPT MISMATCH') && l.includes('gas_used')), lines.join('\n'))
  assert.equal(seq.blockInfo().receiptMismatches, seq.receiptMismatches)
})

test('cap, boost and gap hold run per round, across the two rounds of one block', async () => {
  const { anvil, rounds, feed, run, add, seq } = setup({ maxTxsPerRound: 1, gapHoldRounds: 3 })
  const a = mkTx(anvil, '0.8')
  const b = mkTx(anvil, '0.4')
  const c = mkTx(anvil, '0.2')
  const gap = mkTx(anvil, '0.9', { from: 0x99, nonce: 4 }) // nonce 4 while the sender's next nonce is 0: held
  for (const t of [a, b, c, gap]) add(t)
  await run(1)
  // round 1: the cap includes only A; B, C are carried over (block full); gap is held. p = 0.8 gwei, boost = p/(2K) = 0.2 gwei.
  assert.deepEqual(feed.messages.map((m) => [m.transaction.tx_hash, m.pga_round]), [[a.fake.hash, 1]])
  const r1 = rounds.at(-1)!
  assert.equal(r1.boostInfo!.p, parseGwei('0.8'))
  assert.equal(r1.boostInfo!.boost, r1.boostInfo!.p / 4n, 'boost = p/(2K) with K = 2')
  assert.equal(r1.boostInfo!.carried.length, 3, 'B, C (block full) and the gap-held tx all gain the boost')
  await run(2)
  // round 2 (same block): B has 0.4 + 0.2 = 0.6 beats C 0.2 + 0.2 = 0.4; the cap again lets one in
  assert.deepEqual(feed.messages.map((m) => [m.transaction.tx_hash, m.pga_round, m.transaction.block_number]), [[a.fake.hash, 1, 1], [b.fake.hash, 2, 1]])
  assert.deepEqual(anvil.head.txs.map((t) => t.hash), [a.fake.hash, b.fake.hash])
  const trace = seq.boostTrace(c.fake.hash)!
  assert.deepEqual(trace.map((e) => [e.round, e.included]), [[1, false], [2, false]])
  assert.equal(BigInt(trace[1]!.priority), BigInt(trace[0]!.priority) + r1.boostInfo!.boost, 'C gained one boost per round, rounds counted across the block')
  const gapTrace = seq.boostTrace(gap.fake.hash)!
  assert.ok(gapTrace.every((e) => e.held), 'the nonce-gapped tx stays held in both rounds')
  // the held count continues across the rounds of the block: GAP_HOLD_ROUNDS = 3 expires it in the third round (round 1 of the next block)
  await run(3)
  const bTrace = seq.boostTrace(b.fake.hash)!
  assert.deepEqual([bTrace.at(-1)!.block, bTrace.at(-1)!.pgaRound], [1, 2], 'included entries carry block and pgaRound')
  assert.deepEqual([seq.boostTrace(a.fake.hash)!.at(-1)!.block, seq.boostTrace(a.fake.hash)!.at(-1)!.pgaRound], [1, 1])
  assert.equal(seq.isKnown(gap.fake.hash), false, 'the gap hold expired after GAP_HOLD_ROUNDS rounds (counted across blocks)')
})

test('C8: arrivals(block, round) returns each tx of that round with its arrival time, effective tip and tx_index; unknown or old blocks give []', async () => {
  const { anvil, run, add, seq } = setup()
  const a = mkTx(anvil, '0.1')
  add(a)
  const before = Date.now()
  await run(1)
  const b = mkTx(anvil, '0.5')
  const c = mkTx(anvil, '0.02')
  add(b)
  add(c)
  await run(2)
  const r1 = seq.arrivals(1, 1)
  assert.deepEqual(r1.map((x) => [x.hash, x.from, x.txIndex]), [[a.fake.hash, a.q.from, 0]])
  assert.ok(r1[0]!.arrivedAtMs <= before && r1[0]!.arrivedAtMs > before - 5_000, 'a wall-clock ms stamp from the enqueue')
  assert.equal(BigInt(r1[0]!.tipWei), parseGwei('0.1'))
  const r2 = seq.arrivals(1, 2)
  assert.deepEqual(r2.map((x) => x.hash), [b.fake.hash, c.fake.hash], 'in tx_index order (the order PGA chose), not arrival order')
  assert.deepEqual(r2.map((x) => x.txIndex), [1, 2])
  assert.ok(r2[0]!.arrivedAtMs >= r2[1]!.arrivedAtMs - 1_000 && r2[0]!.arrivedAtMs <= r2[1]!.arrivedAtMs, 'b arrived before c')
  assert.deepEqual(seq.arrivals(1, 3), [])
  assert.deepEqual(seq.arrivals(99, 1), [])
})

test('C8: the arrival history keeps the last 32 blocks', async () => {
  const { anvil, run, add, seq } = setup()
  for (let i = 1; i <= 34; i++) {
    add(mkTx(anvil, '0.1'))
    await run(2 * i - 1)
    add(mkTx(anvil, '0.1'))
    await run(2 * i)
  }
  assert.deepEqual(seq.arrivals(1, 1), [], 'block 1 is older than 32 blocks')
  assert.deepEqual(seq.arrivals(2, 2), [])
  assert.equal(seq.arrivals(34, 1).length, 1)
  assert.equal(seq.arrivals(3, 2).length, 1, 'block 3 is still inside the window (34 - 3 < 32)')
})

// ---------------------------------------------------------------------------
// E2: pause / resume / skip
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms
  while (!cond()) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`)
    await sleep(10)
  }
}
/** A wall clock that runs in real time plus a jump the test can add (a long pause the test does not want to wait for). */
function jumpy() {
  let jump = 0
  return { clock: new SimClock(() => Date.now() + jump), jump: (ms: number) => void (jump += ms) }
}

test('E2: hold after round 1: nothing runs while paused (no Anvil calls, gate open, reveal frozen, txs queue); after a long wall jump the resume keeps the block, its timestamp and the rounds', async () => {
  const w = jumpy()
  const { anvil, feed, seq, gate, rounds, add } = setup({ roundMs: 150, blockMs: 300 }, w.clock)
  const a = mkTx(anvil, '0.01')
  const b = mkTx(anvil, '1')
  seq.start()
  try {
    await seq.pause('holder', 'afterRound1', 30_000) // armed: nothing is paused yet
    assert.equal(seq.clockInfo().paused, false)
    assert.equal(seq.clockInfo().armed, true)
    // Send `a` while round 1 of a block collects, so the round-1 tick publishes it and opens the block.
    await until(() => seq.blockInfo().round === 1, 2000, 'a round 1 to collect')
    add(a)
    await until(() => seq.clockInfo().paused, 3000, 'the hold after round 1')
    const info = seq.clockInfo()
    assert.deepEqual(info.heldAt, { block: 1, round: 2 })
    assert.equal(info.holder, 'holder')
    assert.equal(feed.messages.length, 1, 'round 1 was published')
    const stamp = anvil.head.timestamp
    const callsAtHold = anvil.calls.length
    const roundsAtHold = rounds.length
    // Frozen: a wall jump of ten minutes changes neither sim time nor anything the sequencer does.
    const simBefore = w.clock.simNow()
    w.jump(600_000)
    add(b) // the proxy keeps accepting txs while paused
    await sleep(500) // more than three round lengths
    assert.equal(anvil.calls.length, callsAtHold, 'no Anvil call while paused')
    assert.equal(rounds.length, roundsAtHold, 'no round ran while paused')
    assert.equal(gate.isClosed, false, 'the read gate stays open')
    assert.equal(w.clock.simNow(), simBefore)
    assert.equal(seq.revealedHead(), 0, 'the open block is not revealed')
    assert.equal(seq.blockInfo().paused, true)
    assert.deepEqual(seq.blockInfo().heldAt, { block: 1, round: 2 })
    const left = seq.blockInfo().roundLeftMs
    assert.ok(left > 0 && left <= 150, `round left stays within one round: ${left}`)
    const r = seq.resume('holder')
    assert.equal(r.resumed, true)
    assert.ok(r.pausedMs >= 600_000, 'the pause is the jump')
    await until(() => feed.messages.length >= 2, 3000, 'round 2 after the resume')
    const m = feed.messages[1]!
    assert.equal(m.transaction.block_number, 1, 'the same block')
    assert.equal(m.pga_round, 2)
    assert.equal(m.transaction.tx_hash, b.fake.hash, 'the tx queued while paused is the first of round 2')
    assert.equal(m.transaction.tx_index, 1, 'right after round 1 (index 0 of the round)')
    assert.equal(anvil.head.number, 1)
    assert.equal(anvil.head.timestamp, stamp, 'the re-mine reuses the block timestamp')
    assert.equal(seq.receiptMismatches, 0)
    // No skipped or stale round: round numbers run on without gaps across the pause.
    const nums = rounds.map((x) => x.round)
    nums.forEach((n, i) => assert.equal(n, nums[0]! + i, `rounds ${nums.join(',')}`))
    await until(() => seq.revealedHead() === 1, 2000, 'the block revealed after its last round')
  } finally {
    await seq.stop()
  }
})

test('E2: the reveal of a closed block is frozen while paused and continues from the same point after the resume', async () => {
  const w = jumpy()
  const { anvil, run, add, seq } = setup({ blockPublishDelayMs: 400 }, w.clock)
  add(mkTx(anvil, '0.1'))
  await run(1)
  await run(2) // closes block 1: revealed at simNow + 400ms
  assert.equal(seq.revealedHead(), 0)
  await seq.pause('h')
  w.jump(600_000)
  await sleep(500)
  assert.equal(seq.revealedHead(), 0, 'frozen: the delay does not run while paused')
  seq.resume('h')
  await until(() => seq.revealedHead() === 1, 2000, 'the reveal after the resume')
})

test('E2: pause is idempotent for its holder, refused for another, resume by another holder is refused, resume is idempotent', async () => {
  const { seq } = setup()
  const first = await seq.pause('a')
  assert.equal(first.paused, true)
  assert.equal(first.holder, 'a')
  assert.equal((await seq.pause('a')).paused, true, 'the same holder again: a heartbeat')
  await assert.rejects(seq.pause('b'), /paused by a/)
  assert.throws(() => seq.resume('b'), /paused by a/)
  assert.throws(() => seq.skipTo(Math.floor(seq.clock.chainNowMs() / 1000) + 5, 'b'), /paused by a/)
  assert.equal(seq.clockInfo().paused, true, 'the refused calls changed nothing')
  assert.equal(seq.resume('a').resumed, true)
  assert.equal(seq.resume('a').resumed, false)
  assert.equal(seq.resume('b').resumed, false, 'not paused: nothing to refuse')
  assert.equal(seq.clockInfo().holder, null)
})

test('E2: the lease: a dead holder is resumed by the lease (logged); a heartbeat extends it', async () => {
  const { seq } = setup()
  setInternalVisible(true) // PAUSED / RESUMED are internal() lines: `npm run sim` shows them, a demo does not
  const { lines } = await logs(async () => {
    await seq.pause('hb', 'now', 120)
    for (let i = 0; i < 4; i++) {
      await sleep(60)
      await seq.pause('hb', 'now', 120) // heartbeat
    }
    assert.equal(seq.clockInfo().paused, true, 'kept alive by heartbeats for 240ms with a 120ms lease')
    await until(() => !seq.clockInfo().paused, 1500, 'the lease to run out')
  })
  assert.ok(lines.some((l) => l.includes('PAUSE LEASE EXPIRED: resuming')), lines.join('\n'))
  assert.ok(lines.some((l) => l.includes('RESUMED after') && l.includes('chain clock now') && l.includes('behind wall time')), lines.join('\n'))
  setInternalVisible(false)
  const hidden = await logs(async () => {
    await seq.pause('q')
    seq.resume('q')
  })
  assert.deepEqual(hidden.lines.filter((l) => /PAUSED|RESUMED/.test(l)), [], 'hidden unless the owner shows internals (the demo does not)')
  assert.equal(seq.clockInfo().holder, null)
  const l = await seq.pause('x', 'now', 1_000_000)
  assert.ok(l.leaseLeftMs <= 60_000, 'the lease is capped at 60s')
  seq.resume('x')
})

test('E2: sim_skipTo is forward only, bounded to one ticket round + 60s, and waits while a block is open', async () => {
  const { anvil, run, add, seq, p } = setup()
  const now = Math.floor(seq.clock.chainNowMs() / 1000)
  assert.throws(() => seq.skipTo(now + p.tickets.roundSeconds + 61), /at most one ticket round/)
  assert.equal(seq.skipTo(now - 100), 'applied', 'a target already reached is a no-op')
  assert.equal(seq.clock.skippedMs, 0)
  // A block is open (round 1 published): the skip waits.
  add(mkTx(anvil, '0.1'))
  await run(1)
  assert.equal(seq.skipTo(now + 20), 'pending')
  assert.equal(seq.clock.skippedMs, 0)
  assert.equal(seq.clockInfo().pendingSkip, (now + 20) * 1000)
  await run(2) // the block closes
  ;(seq as unknown as { applyPendingSkip(): void }).applyPendingSkip()
  assert.ok(seq.clock.skippedMs >= 19_000, 'applied once the block closed')
  assert.equal(seq.clockInfo().pendingSkip, null)
  // The next block takes the skipped chain time as its timestamp.
  add(mkTx(anvil, '0.1'))
  await run(3)
  await run(4)
  assert.ok(anvil.head.timestamp >= now + 20, `block timestamp ${anvil.head.timestamp} follows the chain clock`)
})

test('E2: a heartbeat only extends a lease: after the resume it is a no-op, and it never turns an armed afterRound1 hold into a pause', async () => {
  const { seq } = setup()
  await seq.pause('h', 'now', 5000)
  seq.resume('h')
  const late = await seq.pause('h', 'now', 5000, true) // a heartbeat that arrives after the resume
  assert.equal(late.paused, false, 'no re-freeze')
  assert.equal(seq.clockInfo().holder, null)
  await seq.pause('h', 'afterRound1', 5000)
  assert.equal(seq.clockInfo().armed, true)
  const beat = await seq.pause('h', 'now', 5000, true)
  assert.equal(beat.paused, false, 'the armed hold was not turned into an immediate pause')
  assert.equal(beat.armed, true)
  assert.ok(beat.leaseLeftMs > 4000, 'but its lease was extended')
  await assert.rejects(seq.pause('other', 'now', 5000, true), /paused by h/)
  seq.resume('h')
})
