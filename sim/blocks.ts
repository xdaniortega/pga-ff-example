// Rounds in a block (B6a): the pure pieces. Round/block arithmetic, the feed-vs-chain receipt comparison, and the read gate.
// Used by sim/sequencer.ts; kept free of I/O so the rules can be unit-tested without Anvil.
import type { Anvil } from './chain.ts'
import type { FeedReceipt } from '../fast-feed/mock/feed.ts'

/** Where tick `round` (1-based; round i ticks at t0 + i x roundMs) sits inside its block. */
export interface RoundPosition {
  /** Block slot j = ceil(i / K): the j-th block-length window since start. */
  slot: number
  /** pga_round, 1..K. */
  pgaRound: number
  /** The block's last round (i is a multiple of K): the block closes at this tick. */
  last: boolean
}

/**
 * Pure. K rounds share a block: `pga_round = ((i-1) mod K) + 1`, `slot = ceil(i/K)`, and the tick with
 * `i mod K == 0` is the slot's last round.
 */
export function roundPosition(round: number, k: number): RoundPosition {
  return { slot: Math.ceil(round / k), pgaRound: ((round - 1) % k) + 1, last: round % k === 0 }
}

/** The round (1-based) that is collecting txs at wall-clock `now` (rounds end at t0 + i x roundMs). */
export function currentRoundIndex(now: number, t0: number, roundMs: number): number {
  return Math.floor((now - t0) / roundMs) + 1
}

/** The part of a block header the receipt check compares. */
export interface BlockFacts {
  number: number
  timestamp: number
  baseFee: bigint
}

/** One difference between what the feed published and what the chain finally holds. */
export interface Mismatch {
  field: string
  feed: string
  chain: string
}

/** What a feed message carries about one tx (the part that must equal the final receipt). */
export interface PublishedFacts {
  hash: string
  txIndex: number
  receipt: FeedReceipt
}

const eq = (field: string, feed: unknown, chain: unknown): Mismatch[] => (String(feed) === String(chain) ? [] : [{ field, feed: String(feed), chain: String(chain) }])
const lc = (v: string | null) => (v === null ? 'null' : v.toLowerCase())

/**
 * Pure. Compare a published feed message with the final mined receipt: tx_hash, tx_index, status, gas_used,
 * cumulative_gas_used, effective_gas_price, base_fee, contract_address, and every log's address, topics and data.
 * Returns every mismatching field (empty = equal). `chain` has the same shape as a feed message's facts.
 */
export function compareReceipts(feed: PublishedFacts, chain: PublishedFacts): Mismatch[] {
  const f = feed.receipt
  const c = chain.receipt
  const out: Mismatch[] = [
    ...eq('tx_hash', lc(feed.hash), lc(chain.hash)),
    ...eq('tx_index', feed.txIndex, chain.txIndex),
    ...eq('status', f.status, c.status),
    ...eq('gas_used', f.gas_used, c.gas_used),
    ...eq('cumulative_gas_used', f.cumulative_gas_used, c.cumulative_gas_used),
    ...eq('effective_gas_price', f.effective_gas_price, c.effective_gas_price),
    ...eq('base_fee', f.base_fee, c.base_fee),
    ...eq('contract_address', lc(f.contract_address), lc(c.contract_address)),
    ...eq('logs.length', f.logs.length, c.logs.length),
  ]
  if (f.logs.length === c.logs.length) {
    f.logs.forEach((l, i) => {
      const o = c.logs[i]!
      out.push(...eq(`logs[${i}].address`, lc(l.address), lc(o.address)))
      out.push(...eq(`logs[${i}].topics`, l.topics.map((t) => t.toLowerCase()).join(','), o.topics.map((t) => t.toLowerCase()).join(',')))
      out.push(...eq(`logs[${i}].data`, l.data.toLowerCase(), o.data.toLowerCase()))
    })
  }
  return out
}

/** Pure. The block facts that must hold at the final mine: the number and timestamp fixed when the block opened, and the pinned base fee. */
export function compareBlock(expected: BlockFacts, actual: BlockFacts): Mismatch[] {
  return [...eq('block.number', expected.number, actual.number), ...eq('block.timestamp', expected.timestamp, actual.timestamp), ...eq('block.baseFee', expected.baseFee, actual.baseFee)]
}

/** One line per mismatch for the always-visible `[sequencer] FEED RECEIPT MISMATCH` log. */
export function formatMismatch(block: number, hash: string, m: Mismatch): string {
  return `[sequencer] FEED RECEIPT MISMATCH block ${block} tx ${hash} ${m.field}: feed=${m.feed} chain=${m.chain}`
}

/**
 * Reader/writer gate for the window between `evm_revert` and the end of the final mine, when Anvil briefly shows a state that
 * never existed on the feed. Every Anvil caller except the sequencer runs through `run`; the sequencer takes the gate with
 * `close()` (waits for calls already in flight, holds new ones) and releases it with `open()`.
 */
export class RwGate {
  private closed = false
  private active = 0
  private waiters: (() => void)[] = []
  private drained: (() => void)[] = []

  /** Run `fn` unless the gate is closed; then wait for `open()`. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.closed) await new Promise<void>((r) => this.waiters.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      if (this.active === 0) for (const d of this.drained.splice(0)) d()
    }
  }

  /** Hold new calls and resolve once every call already running has finished. */
  async close(): Promise<void> {
    this.closed = true
    if (this.active > 0) await new Promise<void>((r) => this.drained.push(r))
  }

  /** Let the held calls through. Safe to call when already open. */
  open(): void {
    this.closed = false
    for (const w of this.waiters.splice(0)) w()
  }

  get isClosed(): boolean {
    return this.closed
  }
}

/** An Anvil client whose calls wait while the gate is closed. The sequencer itself keeps the raw client. */
export function gatedAnvil(anvil: Anvil, gate: RwGate): Anvil {
  return { url: anvil.url, call: (m, p) => gate.run(() => anvil.call(m, p)), stop: () => anvil.stop() }
}
