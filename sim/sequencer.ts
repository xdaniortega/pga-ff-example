// Mock sequencer: waiting list -> PGA rounds -> Anvil block -> feed messages -> delayed reveal.
//
// Per round (length B/K, see shared/config.ts):
//   1. take the waiting list, order it with pga-core (priority queue by effective tip, then arrival; `--fifo`: arrival;
//      nonce gating either way: a sender's next nonce only. A nonce-gapped tx is HELD in the waiting list, see below)
//   2. submit those raw txs to Anvil ONE BY ONE in that order (awaiting each, so Anvil's
//      `--order fifo` keeps it), mine the block (evm_mine). tx_index therefore equals the sorted order (after earlier rounds' txs).
//   3. read receipts, publish one feed message per tx IMMEDIATELY
//   4. schedule the block's visibility on the mock RPC: when its last round is mined (a block boundary, a multiple of B
//      since stack start) + BLOCK_PUBLISH_DELAY_MS. Step 4 happens after step 3, so the
//      feed message always precedes visibility.
//
// K rounds share one block, like Arbitrum One. Round 1 mines the
// block provisionally and takes an Anvil snapshot right before; the feed publishes round 1's txs (block_number N, pga_round 1)
// at once. At the block's last round the sequencer reverts to the snapshot, drops the pool, resubmits the earlier rounds' txs
// followed by this round's in that order and mines block N again with the SAME timestamp and base fee. Earlier rounds' txs are
// final (a later round only adds after them) and, being deterministic, execute identically, so each published receipt equals the
// final one; this is checked at runtime (receiptMismatches). A read gate (sim/blocks.ts) hides the revert window from every other
// Anvil caller. The block becomes visible on the mock RPC only after the final mine (+ BLOCK_PUBLISH_DELAY_MS).
// ASSUMPTION: a round with an empty waiting list, or where Anvil rejects every tx at submit, mines no block
// (so block numbers are dense and `cast` waits less); a block's earlier round that held txs is still closed at its last round.
// ASSUMPTION (gap handling): a tx whose nonce is above its sender's next nonce, with no predecessor waiting, stays in the
// waiting list (held, not submitted to Anvil) until the predecessor arrives. After GAP_HOLD_ROUNDS rounds it is dropped
// with a log line. Txs that Anvil itself leaves out (e.g. insufficient funds) are still dropped and evicted at once.
// B3 (anti-starvation): the sequencer keeps one accumulated boost per waiting tx hash. A round includes at most
// MAX_TXS_PER_ROUND txs (block-full stand-in); the rest stay waiting, and at the end of every round each tx still
// waiting (carried over by the cap or held for a nonce gap) gains p/(2K) of queue priority, p = the priority of the last
// tx that round included. The boost orders the queue only; fees come from Anvil executing the tx. See pga-core.ts and
// sim/README.md.
// https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
import type { LocalParams } from '../shared/config.ts'
import type { Anvil } from './chain.ts'
import type { FeedMessage, FeedServer } from '../fast-feed/mock/feed.ts'
import { formatGwei, type Address, type Hex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { ANVIL_ACCOUNTS, anvilDevKey } from '../shared/config.ts'
import { internal, sequencerAlways } from '../shared/narrate.ts'
import { bidOf, effectiveTip, gapExpired, runRound, selectRound, senderKey, waitingForNonce, type BoostTraceEntry, type QueuedTx } from '../pga/rules/pga-core.ts'
import { ClockError, SimClock } from './clock.ts'
import { compareBlock, compareReceipts, currentRoundIndex, formatMismatch, RwGate, roundPosition, type Mismatch, type RoundPosition } from './blocks.ts'

interface AnvilReceipt {
  transactionHash: Hex
  transactionIndex: Hex
  blockNumber: Hex
  status: Hex
  gasUsed: Hex
  cumulativeGasUsed: Hex
  effectiveGasPrice: Hex
  contractAddress: Hex | null
  logs: { address: Hex; topics: Hex[]; data: Hex }[]
}
interface AnvilBlock {
  number: Hex
  timestamp: Hex
  baseFeePerGas?: Hex
  transactions: Hex[]
}

/** A block that has had some but not all of its rounds (provisionally mined, snapshot taken before it). */
interface OpenBlock {
  slot: number
  number: number
  /** Block timestamp, seconds: fixed when the block is first mined and reused by every re-mine. */
  timestamp: number
  snapshot: string
  /** Earlier rounds' txs in tx_index order, with the feed message each was published as. Own list: `rawByHash` forgets dropped txs. */
  published: FeedMessage[]
}

/** `sim_arrivals`: when the sequencer received a tx that was ordered in a given (block, round). Local simulator data only. */
export interface ArrivalRecord {
  hash: Hex
  from: Address
  /** Wall-clock ms the sequencer received the tx (the B5 arrival timestamp). Arbitrum does not publish this. */
  arrivedAtMs: number
  /** Effective tip (min(maxPriorityFee, maxFee - baseFee), clamped at 0), as a 0x quantity of wei. */
  tipWei: Hex
  /** tx_index in the block. */
  txIndex: number
}

/** One tx of a round, for narration. */
export interface RoundTx {
  hash: Hex
  from: Address
  nonce: number
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  effectiveTip: bigint
  /** 1-based position in the waiting list (arrival order). */
  arrival: number
  /** Accumulated boost before this round, wei. */
  boost: bigint
  /** Queue priority this round: effective tip + boost. */
  priority: bigint
  /** Wall-clock ms the sequencer received it, and how far into its round that was (ms since the round started). */
  arrivedAt: number
  arrivalOffsetMs: number
}

/** The tentative position of a tx that just arrived, among everything waiting in the still-open round. */
export interface TentativeRank {
  /** 1-based rank if the round closed now; undefined when the tx would not be included (nonce gap or block cap). */
  rank?: number
  /** Number of txs waiting, the new one included. */
  of: number
  /** Why there is no rank. */
  excluded?: 'nonce gap' | 'block full'
}

/**
 * Pure: where `tx` would land if the round closed right now. `waiting` is the waiting list WITH the new tx (last).
 * Uses the same `selectRound` the real round uses, so the preview and the final order cannot disagree on the rules.
 * `nextNonce` may be partial (a sender missing from it falls back to its lowest waiting nonce).
 */
export function tentativeRank(
  waiting: readonly QueuedTx[],
  tx: QueuedTx,
  baseFee: bigint,
  mode: 'pga' | 'fifo',
  opts: { nextNonce?: ReadonlyMap<string, number>; boostOf?: (t: QueuedTx) => bigint; maxTxs?: number } = {},
): TentativeRank {
  const sel = selectRound(waiting, baseFee, opts.nextNonce ?? new Map(), mode, { boostOf: opts.boostOf, maxTxs: opts.maxTxs })
  const i = sel.ordered.indexOf(tx)
  if (i >= 0) return { rank: i + 1, of: waiting.length }
  return { of: waiting.length, excluded: sel.deferred.includes(tx) ? 'block full' : 'nonce gap' }
}

/** Offset of a wall-clock time into its round, ms (rounds start at t0 + i x roundMs). */
export function offsetIntoRound(at: number, t0: number, roundMs: number): number {
  return (((at - t0) % roundMs) + roundMs) % roundMs
}

/** "account N" for the 20 public Anvil dev accounts, undefined for any other sender. */
const ANVIL_LABELS = new Map<string, string>(
  Array.from({ length: ANVIL_ACCOUNTS }, (_, i) => [privateKeyToAddress(anvilDevKey(i)).toLowerCase(), `account ${i}`] as const),
)
export const senderLabel = (a: string): string | undefined => ANVIL_LABELS.get(a.toLowerCase())

/** The narration line printed when a tx arrives. */
export function formatArrival(a: { hash: string; from: string; tipWei: bigint; offsetMs: number; rank: TentativeRank }): string {
  const label = senderLabel(a.from)
  const where = a.rank.rank !== undefined ? `rank ${a.rank.rank} of ${a.rank.of}` : `not in the order yet (${a.rank.excluded}), ${a.rank.of} waiting`
  return `arrival ${a.hash.slice(0, 10)}… from ${label ?? a.from.slice(0, 10) + '..'} tip ${gwei(a.tipWei)} gwei +${a.offsetMs}ms into round → ${where}`
}

/** A tx that stays waiting after the round, with the priority it carries into the next one. */
export interface CarriedTx {
  hash: Hex
  from: Address
  nonce: number
  effectiveTip: bigint
  /** Effective tip + accumulated boost, including this round's boost. */
  boostedPriority: bigint
  /** Why it waits: the block filled, or a nonce gap. */
  reason: 'block full' | 'nonce gap'
}

/** B3 summary of a round. */
export interface BoostInfo {
  k: number
  /** MAX_TXS_PER_ROUND (0 = no cap). */
  cap: number
  queueSize: number
  included: number
  /** Priority of the last included tx (0 if none), wei. */
  p: bigint
  /** p/(2K), wei. */
  boost: bigint
  carried: CarriedTx[]
}

export interface RoundInfo {
  round: number
  ordered: number
  dropped: number
  block?: number
  /** The PGA round (1..K) within the block, how many txs of earlier rounds were re-mined with it, and whether the block stays open. */
  pgaRound?: number
  reMined?: number
  blockOpen?: boolean
  /** The waiting list in arrival order. */
  queue?: RoundTx[]
  /** The drained order (what was submitted to the block). */
  drained?: RoundTx[]
  /** Txs held this round for a nonce gap. */
  held?: HeldTx[]
  /** The queue size, p, the boost and the carried txs (B3). */
  boostInfo?: BoostInfo
}

export interface HeldTx extends RoundTx {
  /** The nonce the sender must still get executed before this tx is eligible. */
  waitingFor: number
  /** Rounds held so far (including this one) and the limit (GAP_HOLD_ROUNDS). */
  heldRounds: number
  limit: number
}

const gwei = (wei: bigint) => formatGwei(wei) // exact decimal string, no exponent
const short = (h: string) => `${h.slice(0, 10)}..`

/** Narration lines for a non-empty round: the waiting list, held txs, the drained order, and any nonce-rule note. */
export function formatRound(r: RoundInfo, ordering: 'pga' | 'fifo'): string[] {
  if (!r.queue || !r.drained) return []
  // Column widths shared by the queue and the drained rows, so tips and bids line up down the log.
  const widths = (txs: readonly RoundTx[]) => {
    const w = (f: (t: RoundTx) => string) => Math.max(0, ...txs.map((t) => f(t).length))
    return { bid: w((t) => `${gwei(t.maxPriorityFeePerGas)}/${gwei(t.maxFeePerGas)} gwei`), tip: w((t) => `${gwei(t.effectiveTip)} gwei`) }
  }
  const qw = widths(r.queue)
  const dw = widths(r.drained)
  const bid = (t: RoundTx) => `${gwei(t.maxPriorityFeePerGas)}/${gwei(t.maxFeePerGas)} gwei`.padStart(qw.bid)
  const queueTip = (t: RoundTx) => `${gwei(t.effectiveTip)} gwei`.padStart(qw.tip)
  const drainedTip = (t: RoundTx) => `${gwei(t.effectiveTip)} gwei`.padStart(dw.tip)
  const row = (t: RoundTx) =>
    `${short(t.hash)} from ${short(t.from)} nonce ${t.nonce} bid ${bid(t)}  effective tip ${queueTip(t)}  arrival #${t.arrival} (+${t.arrivalOffsetMs}ms into its round)${t.boost > 0n ? `  boost +${gwei(t.boost)} -> queue priority ${gwei(t.priority)} gwei` : ''}`
  const lines = [
    `round ${r.round}: waiting list -> ${ordering === 'pga' ? 'priority queue' : 'FIFO queue (PGA disabled)'} (${r.queue.length} tx)`,
    ...r.queue.map((t) => `  queue: ${row(t)}`),
  ]
  for (const h of r.held ?? [])
    lines.push(`  held: ${short(h.hash)} from ${short(h.from)} nonce ${h.nonce}: waiting for nonce ${h.waitingFor} (held ${h.heldRounds} of ${h.limit} rounds)`)
  if (r.drained.length > 0) {
    lines.push(`round ${r.round}: drained order${ordering === 'pga' ? ' (highest effective tip first, ties by arrival; a sender\'s next nonce only)' : ' (arrival order; a sender\'s next nonce only)'}`)
    r.drained.forEach((t, i) => lines.push(`  ${i + 1}. ${short(t.hash)} from ${short(t.from)} nonce ${t.nonce} effective tip ${drainedTip(t)} (arrival #${t.arrival}, +${t.arrivalOffsetMs}ms into its round)`))
    // Nonce rule: a same-sender N+1 placed after its N although it bids a higher tip.
    r.drained.forEach((t, i) => {
      const prev = r.drained!.slice(0, i).find((p) => senderKey(p.from) === senderKey(t.from) && p.nonce === t.nonce - 1)
      if (prev && t.effectiveTip > prev.effectiveTip)
        lines.push(`  nonce rule: nonce ${prev.nonce} before nonce ${t.nonce} for ${short(t.from)} (nonce ${t.nonce} bids a higher tip, but it is not valid until nonce ${prev.nonce} has executed)`)
    })
  }
  lines.push(...formatBoost(r))
  return lines
}

/** Narration of the end-of-round boost (B3): queue size, p, the boost, and the carried txs (top few plus any zero tip). */
export function formatBoost(r: RoundInfo, top = 3): string[] {
  const b = r.boostInfo
  if (!b) return []
  const lines = [
    `round ${r.round}: queue ${b.queueSize} tx, included ${b.included}${b.cap > 0 ? ` (block-full stand-in: at most ${b.cap} per round)` : ''}, p = ${gwei(b.p)} gwei (priority of the last included tx)`,
  ]
  if (b.carried.length === 0) return lines
  const full = b.carried.filter((c) => c.reason === 'block full').length
  if (full > 0) lines.push(`  block full: ${full} tx(s) carried over to the next round`)
  lines.push(`  boost: +p/(2K) = +${gwei(b.boost)} gwei (p ${gwei(b.p)} / (2 x ${b.k})) to ${b.carried.length} waiting txs; the boost moves their queue position only, never the fee`)
  const byPriority = [...b.carried].sort((x, y) => (x.boostedPriority === y.boostedPriority ? 0 : x.boostedPriority > y.boostedPriority ? -1 : 1))
  const cw = {
    tip: Math.max(0, ...b.carried.map((c) => `${gwei(c.effectiveTip)} gwei`.length)),
    prio: Math.max(0, ...b.carried.map((c) => `${gwei(c.boostedPriority)} gwei`.length)),
  }
  const shown = new Set(byPriority.slice(0, top))
  for (const c of b.carried) if (c.effectiveTip === 0n) shown.add(c) // always show a zero-tip tx
  for (const c of byPriority) {
    if (!shown.has(c)) continue
    lines.push(
      `  waiting: ${short(c.hash)} from ${short(c.from)} nonce ${c.nonce} tip ${`${gwei(c.effectiveTip)} gwei`.padStart(cw.tip)} -> boosted priority ${`${gwei(c.boostedPriority)} gwei`.padStart(cw.prio)}${c.effectiveTip === 0n ? '  (zero tip)' : ''} (${c.reason})`,
    )
  }
  if (shown.size < b.carried.length) lines.push(`  ... and ${b.carried.length - shown.size} more waiting`)
  return lines
}

export class Sequencer {
  private queue: QueuedTx[] = []
  private inFlight: QueuedTx[] = []
  private readonly known = new Set<Hex>()
  /** hash -> rounds this tx has been held for a nonce gap. */
  private readonly heldRounds = new Map<Hex, number>()
  /** hash -> accumulated boost, wei (waiting txs only). The boost orders the queue; it never touches a fee. */
  private readonly boosts = new Map<Hex, bigint>()
  /** hash -> the tx's queue priority round by round (`sim_boostTrace`). Bounded: the oldest are evicted. */
  private readonly traces = new Map<Hex, BoostTraceEntry[]>()
  private static readonly TRACE_LIMIT = 5000
  /** block -> pga_round -> arrival records of the txs ordered in that round (`sim_arrivals`). Bounded to the last ARRIVAL_BLOCKS blocks. */
  private readonly arrivalLog = new Map<number, Map<number, ArrivalRecord[]>>()
  static readonly ARRIVAL_BLOCKS = 32
  /** hash -> raw tx for the stack's lifetime, so a tx mined in a later round still has its raw bytes. */
  private readonly rawByHash = new Map<string, Hex>()
  private blocks: { number: number; revealAt: number }[]
  /** The block still collecting rounds, if any. */
  private open: OpenBlock | undefined
  /** Highest block number mined so far (a block still open included). */
  private lastMined: number
  /** The number of the block being mined by the round that is executing right now (undefined between rounds), so `blockInfo` never reports the next number mid-round. */
  private building?: number
  /** Feed receipts (or block facts) that differed from the final chain. Must stay 0; served by `sim_info` / `sim_blockInfo`. */
  receiptMismatches = 0
  private stopped = false
  private wake: (() => void) | undefined
  private loop: Promise<void> | undefined
  /** Start of the round schedule, in SIM time (sim/clock.ts): rounds tick at t0 + i x roundMs of sim time, so a pause freezes them. */
  readonly t0: number
  // E2 pause / skip state (the clock itself is `clock`). LOCAL ONLY.
  private executing = false
  private idleWaiters: (() => void)[] = []
  /** Who owns the pause (or the armed hold), and when the lease runs out (wall ms). */
  private holder: string | undefined
  private armed = false
  private heldAt: { block: number; round: number } | undefined
  private leaseTimer: NodeJS.Timeout | undefined
  private leaseUntil = 0
  private pendingSkipMs: number | undefined
  /** Optional: "ticket round N, Ns left" for the always-visible pause/skip lines (set by the stack; best effort). */
  ticketNote?: () => Promise<string | undefined>
  /** sim time a queued tx arrived at, for the "+Nms into its round" narration (the tx's own `arrivedAt` is wall time). */
  private readonly arrivalSim = new WeakMap<QueuedTx, number>()

  constructor(
    private readonly p: LocalParams,
    private readonly anvil: Anvil,
    private readonly feed: FeedServer,
    private readonly onRound?: (r: RoundInfo) => void,
    /** Blocks mined before the sequencer started (the ticket deployment) are visible immediately. */
    initialHead = 0,
    /** Reader/writer gate shared with the clients handed to the RPC proxy and the feed auth (B6a). */
    private readonly gate: RwGate = new RwGate(),
    /** The simulator clock (E2). Tests inject one with a fake wall clock. */
    readonly clock: SimClock = new SimClock(),
  ) {
    this.blocks = [{ number: initialHead, revealAt: 0 }]
    this.lastMined = initialHead
    this.t0 = this.clock.simNow()
  }

  /** Returns false if this hash is already waiting. */
  enqueue(tx: Omit<QueuedTx, 'arrivedAt'>, senderNonce?: number): boolean {
    if (this.known.has(tx.hash)) return false
    this.known.add(tx.hash)
    this.rawByHash.set(tx.hash.toLowerCase(), tx.raw)
    const queued: QueuedTx = { ...tx, arrivedAt: Date.now() }
    const arrivedSim = this.clock.simNow()
    this.arrivalSim.set(queued, arrivedSim)
    this.queue.push(queued)
    // Narrate the arrival with its tentative rank in the still-open round (`senderNonce`: Anvil's next nonce for the
    // sender, so a nonce-gapped tx is shown as such; other senders use their lowest waiting nonce).
    const rank = tentativeRank(this.queue, queued, this.p.baseFeeWei, this.p.ordering, {
      nextNonce: senderNonce === undefined ? undefined : new Map([[senderKey(tx.from), senderNonce]]),
      boostOf: (t) => this.boosts.get(t.hash) ?? 0n,
      maxTxs: this.p.maxTxsPerRound ?? 0,
    })
    internal(formatArrival({ hash: tx.hash, from: tx.from, tipWei: effectiveTip(queued, this.p.baseFeeWei), offsetMs: offsetIntoRound(arrivedSim, this.t0, this.p.roundMs), rank }))
    return true
  }

  /** The per-round queue priority of a tx (local-only `sim_boostTrace`); undefined for an unknown hash. */
  boostTrace(hash: Hex): BoostTraceEntry[] | undefined {
    return this.traces.get(hash.toLowerCase() as Hex)
  }

  /** `sim_arrivals`: the txs ordered in (block, round) with the time the sequencer received each, in tx_index order; [] when unknown or older than the last 32 blocks. */
  arrivals(block: number, round: number): ArrivalRecord[] {
    return [...(this.arrivalLog.get(block)?.get(round) ?? [])]
  }

  private recordArrivals(block: number, round: number, txs: readonly QueuedTx[], msgs: readonly FeedMessage[]): void {
    const byHash = new Map(txs.map((t) => [t.hash.toLowerCase(), t]))
    const records: ArrivalRecord[] = []
    for (const m of msgs) {
      const t = byHash.get(m.transaction.tx_hash.toLowerCase())
      if (!t) continue
      records.push({
        hash: t.hash,
        from: t.from,
        arrivedAtMs: t.arrivedAt,
        tipWei: ('0x' + effectiveTip(t, this.p.baseFeeWei).toString(16)) as Hex,
        txIndex: m.transaction.tx_index,
      })
    }
    let rounds = this.arrivalLog.get(block)
    if (!rounds) this.arrivalLog.set(block, (rounds = new Map()))
    rounds.set(round, records)
    for (const b of [...this.arrivalLog.keys()]) if (b <= block - Sequencer.ARRIVAL_BLOCKS) this.arrivalLog.delete(b)
  }

  private trace(hash: Hex, e: BoostTraceEntry): BoostTraceEntry {
    const k = hash.toLowerCase() as Hex
    const t = this.traces.get(k)
    if (t) t.push(e)
    else {
      this.traces.set(k, [e])
      if (this.traces.size > Sequencer.TRACE_LIMIT) this.traces.delete(this.traces.keys().next().value!)
    }
    return e
  }

  isKnown(hash: Hex): boolean {
    return this.known.has(hash)
  }

  /** Is a tx from `addr` with this nonce already waiting or in flight? */
  hasNonce(addr: Address, nonce: number): boolean {
    const a = addr.toLowerCase()
    return [...this.queue, ...this.inFlight].some((t) => t.from.toLowerCase() === a && t.nonce === nonce)
  }

  /**
   * Pending nonce = the next nonce a sender can use: starting at Anvil's latest nonce, skip every nonce that is
   * queued or in flight (a contiguous run). A tx HELD for a nonce gap does not count: its predecessor's nonce is still
   * free, so the next tx a wallet builds fills the gap (like a node's pending count, which ignores queued gapped txs).
   */
  pendingNonce(addr: Address, anvilLatest: number): number {
    const a = addr.toLowerCase()
    const have = new Set<number>()
    for (const t of [...this.queue, ...this.inFlight]) if (t.from.toLowerCase() === a) have.add(t.nonce)
    let n = anvilLatest
    while (have.has(n)) n++
    return n
  }

  /**
   * Highest block visible on the mock RPC. Blocks are hidden until their last round is mined
   * (a multiple of B since start) plus BLOCK_PUBLISH_DELAY_MS.
   */
  revealedHead(now = this.clock.simNow()): number {
    let head = 0
    for (const b of this.blocks) if (b.revealAt <= now) head = b.number
    return head
  }

  /** Milliseconds until the next round tick (test/demo tooling, `sim_msUntilNextRound`). */
  msUntilNextRound(now = this.clock.simNow()): number {
    const i = Math.floor((now - this.t0) / this.p.roundMs) + 1
    return this.t0 + i * this.p.roundMs - now
  }

  /** Milliseconds until the next block boundary (t0 + j x B), `sim_msUntilNextBlock`. */
  msUntilNextBlock(now = this.clock.simNow()): number {
    const j = Math.floor((now - this.t0) / this.p.blockMs) + 1
    return this.t0 + j * this.p.blockMs - now
  }

  /**
   * `sim_blockInfo`: the block and round collecting txs right now. `block` is the open block's number, else the next number to be
   * mined, but while a round is executing (`this.building`) it is the executing round's block. `round` and `roundStartMs` are
   * wall-clock (derived from the time), so right after a block-closing tick the answer can briefly be `{block: N, round: 1}`
   * (N = the block still being built, round already 1 of the next one). Times are wall-clock ms.
   */
  blockInfo(now = this.clock.simNow()) {
    const i = currentRoundIndex(now, this.t0, this.p.roundMs)
    const pos = roundPosition(i, this.p.k)
    const open = this.open && this.open.slot === pos.slot ? this.open : undefined
    const w = (simMs: number) => this.clock.toWall(simMs)
    return {
      block: this.building ?? (open ? open.number : this.lastMined + 1),
      round: pos.pgaRound,
      // Wall-clock instants (what a client compares with Date.now()); while paused they keep moving with the wall clock.
      roundStartMs: w(this.t0 + (i - 1) * this.p.roundMs),
      blockStartMs: w(this.t0 + (Math.ceil(i / this.p.k) - 1) * this.p.blockMs),
      /** E2: sim-time ms into the current block, and the sim clock now: a client that has its own pauses removes them from wall times with these. */
      blockElapsedMs: now - (this.t0 + (Math.ceil(i / this.p.k) - 1) * this.p.blockMs),
      /** E2: how much of the current round is left on the SIM clock (frozen while paused): the figure to use instead of roundStartMs + roundMs - Date.now(). */
      roundLeftMs: this.t0 + i * this.p.roundMs - now,
      paused: this.clock.paused,
      heldAt: this.heldAt,
      k: this.p.k,
      roundMs: this.p.roundMs,
      blockMs: this.p.blockMs,
      receiptMismatches: this.receiptMismatches,
    }
  }

  /** `sim_clock` (also in `sim_info`): the pause / skip state. */
  clockInfo() {
    return {
      paused: this.clock.paused,
      holder: this.holder ?? null,
      armed: this.armed,
      heldAt: this.heldAt ?? null,
      leaseLeftMs: this.holder !== undefined ? Math.max(0, this.leaseUntil - Date.now()) : 0,
      pausedTotalMs: this.clock.pausedTotalMs,
      skippedMs: this.clock.skippedMs,
      chainNowMs: this.clock.chainNowMs(),
      pendingSkip: this.pendingSkipMs ?? null,
    }
  }

  private idle(): Promise<void> {
    return this.executing ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve()
  }

  /** Pause / resume / skip lines: `internal()`, so `npm run sim` shows them and a demo that owns the stack does not (its own NOTE says it). */
  private async say(base: string, o: { ticket?: boolean; detail?: string; arrow?: boolean } = {}): Promise<void> {
    let extra: string | undefined
    if (o.ticket !== false && this.ticketNote) extra = await this.ticketNote().catch(() => undefined)
    if (o.arrow) return internal(extra ? `${base} → ${extra}` : base)
    const inner = [o.detail, extra].filter((x) => x).join('; ')
    internal(inner ? `${base} (${inner})` : base)
  }

  private startLease(holder: string, leaseMs: number): void {
    clearTimeout(this.leaseTimer)
    this.holder = holder
    this.leaseUntil = Date.now() + leaseMs
    // Wall-time timer, unref'd: a dead holder (a demo killed with SIGKILL) must never leave the simulator frozen.
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = undefined
      if (this.holder === undefined) return
      const was = this.clock.paused
      sequencerAlways('PAUSE LEASE EXPIRED: resuming')
      this.release(was)
    }, leaseMs)
    this.leaseTimer.unref()
  }

  /** Drop the holder and the hold; resume the clock when it was paused. */
  private release(wasPaused: boolean): { pausedMs: number } {
    clearTimeout(this.leaseTimer)
    this.leaseTimer = undefined
    this.holder = undefined
    this.armed = false
    this.heldAt = undefined
    const pausedMs = wasPaused ? this.clock.resume() : 0
    if (wasPaused) void this.say(`RESUMED after ${(pausedMs / 1000).toFixed(1)}s`, { ticket: false, detail: lagText(this.clock.chainLagMs()) })
    this.applyPendingSkip()
    return { pausedMs }
  }

  /**
   * `sim_pause`: freeze the sim clock (no rounds, no blocks, no reveals, a frozen ticket clock). `at: 'now'` answers once any round that is
   * executing has finished (a round is never interrupted); `'afterRound1'` arms a hold that pauses right after the round-1 publish that
   * opens a block (the answer does not wait; `clockInfo().heldAt` says when it took effect). The same holder again is a heartbeat
   * (extends the lease). Another holder is refused. The lease is wall time: when it runs out the stack resumes by itself.
   */
  async pause(holder: string, at: 'now' | 'afterRound1' = 'now', leaseMs = 15_000, heartbeat = false) {
    const owner = this.holder
    if (owner !== undefined && owner !== holder) throw new ClockError(`paused by ${owner}`)
    const lease = Math.min(60_000, Math.max(1, Math.floor(leaseMs)))
    // A heartbeat only extends the lease of a hold that exists: it never starts a pause or turns an armed hold into one (a late heartbeat after the resume is a no-op).
    if (heartbeat) {
      if (owner === holder) this.startLease(holder, lease)
      return this.clockInfo()
    }
    this.startLease(holder, lease)
    if (at === 'afterRound1') {
      if (!this.clock.paused) this.armed = true
    } else if (!this.clock.paused) {
      this.armed = false
      this.clock.pause()
      this.heldAt = undefined
      await this.idle() // never inside executeRound
      void this.say(`PAUSED by ${holder}`, { detail: 'between rounds' })
    }
    return this.clockInfo()
  }

  /** `sim_resume`: idempotent. A holder that does not own the pause is refused. */
  resume(holder: string) {
    const pausedBefore = this.clock.paused
    if (this.holder === undefined && !pausedBefore) return { resumed: false, pausedMs: 0, chainNowMs: this.clock.chainNowMs() }
    if (this.holder !== undefined && this.holder !== holder) throw new ClockError(`paused by ${this.holder}`)
    const { pausedMs } = this.release(pausedBefore)
    return { resumed: pausedBefore, pausedMs, chainNowMs: this.clock.chainNowMs() }
  }

  /**
   * `sim_skipTo`: move the CHAIN clock forward to `toSec` (never backward; a target already reached is a no-op), at most one ticket round
   * plus 60 s ahead. Applied only when no block is open (a block's rounds share one timestamp); otherwise it stays pending until the
   * open block's last round is mined. Never blocks: the caller polls `sim_clock`.
   */
  skipTo(toSec: number, holder?: string): 'applied' | 'pending' {
    if (this.holder !== undefined && this.holder !== holder) throw new ClockError(`paused by ${this.holder}`)
    const toMs = toSec * 1000
    const max = this.clock.chainNowMs() + this.p.tickets.roundSeconds * 1000 + 60_000
    if (!Number.isFinite(toMs) || toMs > max) throw new ClockError(`sim_skipTo: at most one ticket round + 60s ahead (${this.p.tickets.roundSeconds + 60}s from now)`)
    if (toMs <= this.clock.chainNowMs() && this.pendingSkipMs === undefined) return 'applied' // already reached
    this.pendingSkipMs = Math.max(this.pendingSkipMs ?? 0, toMs)
    this.applyPendingSkip()
    return this.pendingSkipMs === undefined ? 'applied' : 'pending'
  }

  private applyPendingSkip(): void {
    if (this.pendingSkipMs === undefined || this.open || this.executing) return
    const added = this.clock.skipTo(this.pendingSkipMs)
    this.pendingSkipMs = undefined
    if (added > 0) void this.say(`CLOCK SKIP +${Math.round(added / 1000)}s`, { arrow: true })
  }

  /** After a round: honour an armed hold (pause right after the round-1 publish that opened a block). */
  private holdIfArmed(round: number): void {
    if (!this.armed || this.clock.paused || !this.open) return
    if (roundPosition(round, this.p.k).pgaRound !== 1) return
    this.armed = false
    this.heldAt = { block: this.open.number, round: 2 }
    this.clock.pause()
    void this.say(`PAUSED by ${this.holder}`, { detail: `block ${this.open.number} round 2 held` })
  }

  start(): void {
    this.loop = this.run()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.leaseTimer)
    this.wake?.()
    this.clock.release()
    await this.loop
  }

  /** Wait until sim time `t`, or until the clock is paused (a pause must abort the sleep: the caller re-checks). */
  private sleepUntil(t: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      let off: () => void = () => {}
      const done = () => {
        clearTimeout(timer)
        off()
        this.wake = undefined
        resolve()
      }
      const arm = () => {
        const left = t - this.clock.simNow()
        if (left <= 0) return done()
        timer = setTimeout(arm, left) // a timer can fire a ms early: re-check against sim time
      }
      off = this.clock.onPause(done)
      this.wake = done
      arm()
    })
  }

  private async run(): Promise<void> {
    let i = 1
    while (!this.stopped) {
      await this.clock.running() // frozen: no rounds while paused
      if (this.stopped) break
      await this.sleepUntil(this.t0 + i * this.p.roundMs)
      if (this.stopped) break
      if (this.clock.paused) continue // paused during the sleep: wait for the resume, then sleep the rest of the round
      this.executing = true
      try {
        await this.runRound(i)
      } catch (e) {
        // Always visible (not only via internal()): a failed round loses the transactions it took from the queue.
        sequencerAlways(`round ${i} failed: ${(e as Error).message}`)
      } finally {
        this.executing = false
        for (const w of this.idleWaiters.splice(0)) w()
      }
      this.holdIfArmed(i)
      this.applyPendingSkip()
      i++
      while (this.t0 + i * this.p.roundMs < this.clock.simNow()) i++ // skip rounds we were too slow for
    }
  }

  private async runRound(round: number): Promise<void> {
    const pos = roundPosition(round, this.p.k)
    // A closing tick was skipped (we were too slow): close that block first, with no new txs.
    if (this.open && this.open.slot < pos.slot) {
      const stale = this.open
      await this.executeRound(round, [], {}, Date.now(), 0, { slot: stale.slot, pgaRound: this.p.k, last: true }, new Map())
    }
    const waiting = this.queue.splice(0)
    if (waiting.length === 0) {
      // The block's last round has nothing new, but an open block must still be closed (re-mined and revealed).
      if (this.open && pos.last) await this.executeRound(round, [], {}, Date.now(), 0, pos, new Map())
      else this.onRound?.({ round, ordered: 0, dropped: 0 })
      return
    }
    // The spliced txs still count for pending nonces and duplicate checks while we read the chain.
    this.inFlight = waiting
    const baseFee = this.p.baseFeeWei
    let pre = 0 // dropped before anything is submitted (stale nonce, gap hold expired)
    let ordered: QueuedTx[] = []
    let held: QueuedTx[] = []
    const nextNonce = new Map<string, number>()
    try {
      // next nonce per sender in the queue, from Anvil at round time (it advances as rounds are mined).
      await Promise.all(
        [...new Set(waiting.map((t) => senderKey(t.from)))].map(async (a) => {
          nextNonce.set(a, Number(BigInt(await this.anvil.call<Hex>('eth_getTransactionCount', [a, 'latest']))))
        }),
      )
    } catch (e) {
      this.queue.unshift(...waiting) // nothing was lost: try again next round
      this.inFlight = []
      throw e
    }
    const forget = (t: QueuedTx) => {
      this.known.delete(t.hash)
      this.rawByHash.delete(t.hash.toLowerCase())
      this.heldRounds.delete(t.hash)
      this.boosts.delete(t.hash)
    }
    const live: QueuedTx[] = []
    for (const t of waiting) {
      const next = nextNonce.get(senderKey(t.from))!
      if (t.nonce < next) {
        pre++
        forget(t)
        sequencerAlways(`dropped ${t.hash} at round time: nonce ${t.nonce} is already used (the sender's next nonce is ${next})`)
      } else live.push(t)
    }
    // `orderedAt` is the feed messages' timestamp_ms.
    // ASSUMPTION: timestamp_ms = the moment the round was ordered, before Anvil executes it (the docs do not say which
    // moment it marks), so a client's receive time minus timestamp_ms is always > 0 and includes the mock's execution time.
    const orderedAt = Date.now()
    const res = runRound(live, this.boosts, baseFee, nextNonce, this.p.ordering, { k: this.p.k, maxTxs: this.p.maxTxsPerRound ?? 0 })
    ;({ ordered, held } = res)
    const arrivalNo = new Map(waiting.map((t, i) => [t, i + 1]))
    const boostOf = (t: QueuedTx) => this.boosts.get(t.hash) ?? 0n
    const priorityOf = (t: QueuedTx) => (this.p.ordering === 'fifo' ? 0n : effectiveTip(t, baseFee) + boostOf(t))
    const toRow = (t: QueuedTx): RoundTx => {
      const { maxFee, maxPriority } = bidOf(t)
      return {
        boost: boostOf(t),
        priority: priorityOf(t),
        hash: t.hash,
        from: t.from,
        nonce: t.nonce,
        maxPriorityFeePerGas: maxPriority,
        maxFeePerGas: maxFee,
        effectiveTip: effectiveTip(t, baseFee),
        arrival: arrivalNo.get(t)!,
        arrivedAt: t.arrivedAt,
        arrivalOffsetMs: offsetIntoRound(this.arrivalSim.get(t) ?? t.arrivedAt, this.t0, this.p.roundMs),
      }
    }
    // Gap hold: waiting txs stay in the list; after GAP_HOLD_ROUNDS rounds they are dropped.
    const limit = this.p.gapHoldRounds
    const keep = new Set<QueuedTx>(res.deferred) // carried over because the block filled: not a gap, never expires
    const heldRows: HeldTx[] = []
    const runOf = (t: QueuedTx) => [...ordered, ...res.deferred].filter((o) => senderKey(o.from) === senderKey(t.from)).map((o) => o.nonce)
    for (const t of held) {
      const n = (this.heldRounds.get(t.hash) ?? 0) + 1
      if (gapExpired(n, limit)) {
        pre++
        forget(t)
        sequencerAlways(`dropped ${t.hash} (nonce ${t.nonce}): nonce gap not filled after ${limit} rounds; resend`)
      } else {
        this.heldRounds.set(t.hash, n)
        keep.add(t)
        heldRows.push({ ...toRow(t), waitingFor: waitingForNonce(nextNonce.get(senderKey(t.from))!, runOf(t)), heldRounds: n, limit })
      }
    }
    // A tx that stops being held (included, or only deferred by the cap) starts counting from 0 if it is ever held again.
    for (const t of [...ordered, ...res.deferred]) this.heldRounds.delete(t.hash)
    // Rows and the trace use the boosts this round was ordered with; only then are the boosts advanced.
    const queueRows = waiting.map(toRow)
    const drainedRows = ordered.map(toRow)
    const includedSet = new Set(ordered)
    const traced = new Map<string, BoostTraceEntry>()
    for (const t of live) {
      traced.set(t.hash.toLowerCase(), this.trace(t.hash, { round, priority: priorityOf(t).toString(), included: includedSet.has(t), ...(held.includes(t) ? { held: true } : {}) }))
    }
    // End of round: every tx still waiting gains p/(2K) (res.boosts); included and dropped txs lose their entry.
    for (const t of waiting) this.boosts.delete(t.hash)
    const carriedTxs = waiting.filter((t) => keep.has(t))
    for (const t of carriedTxs) this.boosts.set(t.hash, res.boosts.get(t.hash) ?? 0n)
    const carried: CarriedTx[] = carriedTxs.map((t) => ({
      hash: t.hash,
      from: t.from,
      nonce: t.nonce,
      effectiveTip: effectiveTip(t, baseFee),
      boostedPriority: this.p.ordering === 'fifo' ? 0n : effectiveTip(t, baseFee) + (this.boosts.get(t.hash) ?? 0n),
      reason: res.deferred.includes(t) ? 'block full' : 'nonce gap',
    }))
    this.queue.unshift(...carriedTxs) // carried txs keep their place (and arrival time) in the waiting list
    const boostInfo: BoostInfo = { k: this.p.k, cap: this.p.maxTxsPerRound ?? 0, queueSize: live.length, included: ordered.length, p: res.p, boost: res.boost, carried }
    const detail = { queue: queueRows, drained: drainedRows, held: heldRows, boostInfo }
    this.inFlight = ordered
    if (ordered.length === 0 && !(this.open && pos.last)) {
      this.inFlight = []
      this.onRound?.({ round, ordered: 0, dropped: pre, ...detail })
      return
    }
    try {
      await this.executeRound(round, ordered, detail, orderedAt, pre, pos, traced)
    } finally {
      // Even if mining throws, in-flight txs must not inflate pending nonces forever.
      this.inFlight = []
    }
  }

  /** Build the feed message of one receipt. */
  private feedMessage(r: AnvilReceipt, raw: Hex, block: number, baseFee: bigint, orderedAt: number, pgaRound: number): FeedMessage {
    return {
      version: 1,
      timestamp_ms: orderedAt,
      pga_round: pgaRound,
      transaction: {
        block_number: block,
        tx_index: Number(BigInt(r.transactionIndex)),
        raw_tx: raw,
        tx_hash: r.transactionHash,
        receipt: {
          status: Number(BigInt(r.status)),
          gas_used: Number(BigInt(r.gasUsed)),
          gas_used_for_l1: 0,
          cumulative_gas_used: Number(BigInt(r.cumulativeGasUsed)),
          effective_gas_price: Number(BigInt(r.effectiveGasPrice)),
          base_fee: Number(baseFee),
          contract_address: r.contractAddress ?? null,
          logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
        },
      },
    }
  }

  /** Always visible: a published receipt that differs from the final chain is a simulator bug. */
  private mismatch(block: number, hash: string, ms: Mismatch[]): void {
    for (const m of ms) {
      this.receiptMismatches++
      sequencerAlways(formatMismatch(block, hash, m).replace(/^\[sequencer\] /, ''), true)
    }
  }

  /** Best effort: `lastMined` follows Anvil's actual head after a revert or a failed re-mine. */
  private async syncHead(): Promise<void> {
    try {
      this.lastMined = Number(BigInt(await this.anvil.call<Hex>('eth_blockNumber')))
    } catch (e) {
      sequencerAlways(`could not read Anvil's head: ${(e as Error).message}`)
    }
  }

  private forgetTx(tx: QueuedTx): void {
    this.known.delete(tx.hash)
    this.rawByHash.delete(tx.hash.toLowerCase())
  }

  /**
   * Mine this round's block: see the header. An open block
   * is first reverted to its snapshot and re-mined as [round 1's txs, then `ordered`] with the same number's timestamp and base fee.
   */
  private async executeRound(
    round: number,
    ordered: QueuedTx[],
    detail: Pick<RoundInfo, 'queue' | 'drained' | 'held' | 'boostInfo'>,
    orderedAt: number,
    pre: number,
    pos: RoundPosition,
    traced: Map<string, BoostTraceEntry>,
  ): Promise<void> {
    this.building = this.open?.number // a later round of an open block keeps its number while it is reverted and re-mined
    try {
      await this.executeRoundInner(round, ordered, detail, orderedAt, pre, pos, traced)
    } finally {
      this.building = undefined
    }
  }

  private async executeRoundInner(
    round: number,
    ordered: QueuedTx[],
    detail: Pick<RoundInfo, 'queue' | 'drained' | 'held' | 'boostInfo'>,
    orderedAt: number,
    pre: number,
    pos: RoundPosition,
    traced: Map<string, BoostTraceEntry>,
  ): Promise<void> {
    let dropped = 0
    const accepted = new Set<QueuedTx>()
    const open = this.open
    let prior: FeedMessage[] = [] // earlier rounds' txs that are re-mined with this one
    let timestamp = 0
    let snapshot: string | undefined
    let nothing = false
    let revertThrew = false
    if (open) await this.gate.close()
    try {
      if (open) {
        this.open = undefined // consumed whatever happens next
        const ok = await this.anvil.call<boolean>('evm_revert', [open.snapshot]).catch((e) => {
          revertThrew = true // the state of the open block is unknown: its published txs count as lost below
          throw e
        })
        if (ok) {
          prior = open.published
          timestamp = open.timestamp
          await this.anvil.call('anvil_dropAllTransactions') // only the sequencer submits to Anvil: the pool holds just the reverted txs
        } else {
          this.receiptMismatches++
          sequencerAlways(`FEED RECEIPT MISMATCH block ${open.number}: evm_revert returned false, so the txs published in earlier round(s) stay in block ${open.number}; this round is mined as a new block`, true)
        }
      }
      let priorAccepted = 0
      for (const m of prior) {
        try {
          await this.anvil.call('eth_sendRawTransaction', [m.transaction.raw_tx])
          priorAccepted++
        } catch (e) {
          this.mismatch(open!.number, m.transaction.tx_hash, [{ field: 'resubmit', feed: 'published', chain: `rejected: ${(e as Error).message}` }])
        }
      }
      for (const tx of ordered) {
        try {
          await this.anvil.call('eth_sendRawTransaction', [tx.raw])
          accepted.add(tx)
        } catch (e) {
          dropped++
          this.forgetTx(tx)
          // Always visible: the sender was told "accepted" earlier, so say why it vanished.
          sequencerAlways(`dropped ${tx.hash} at round time: ${(e as Error).message}`)
        }
      }
      if (accepted.size + priorAccepted === 0) {
        // Nothing survived: do not mine an empty block (a round with an empty waiting list, or where Anvil rejects every tx at submit, mines no block).
        nothing = true
      } else {
        if (!open) {
          const parent = await this.anvil.call<AnvilBlock>('eth_getBlockByNumber', ['latest', false])
          timestamp = Math.max(Math.floor(this.clock.chainNowMs() / 1000), Number(BigInt(parent.timestamp)))
        } else if (prior.length === 0) {
          // evm_revert failed: a new block after the stale one
          const parent = await this.anvil.call<AnvilBlock>('eth_getBlockByNumber', ['latest', false])
          timestamp = Math.max(Math.floor(this.clock.chainNowMs() / 1000), Number(BigInt(parent.timestamp)))
        }
        if (!pos.last) snapshot = await this.anvil.call<string>('evm_snapshot')
        // Pinned base fee, applied to the block we are about to mine.
        await this.anvil.call('anvil_setNextBlockBaseFeePerGas', ['0x' + this.p.baseFeeWei.toString(16)])
        await this.anvil.call('evm_mine', [timestamp])
        this.inFlight = [] // mined: Anvil's own nonce now covers these
      }
    } catch (e) {
      if (open) {
        // The block was reverted (or the revert itself failed): whatever is left in Anvil's pool must not be mined or published later.
        const published = prior.length > 0 ? prior : revertThrew ? open.published : []
        if (published.length > 0) {
          this.receiptMismatches += published.length
          sequencerAlways(`FEED RECEIPT MISMATCH block ${open.number}: ${revertThrew ? 'evm_revert failed' : 're-mining failed after the revert'} (${(e as Error).message}); ${published.length} tx(s) published on the feed may NOT be in the chain`, true)
        }
        await this.anvil.call('anvil_dropAllTransactions').catch((e2) => {
          sequencerAlways(`could not clear Anvil's pool after the failed re-mine: ${(e2 as Error).message}`)
        })
        const lost = [...published.map((m) => m.transaction.tx_hash), ...ordered.map((t) => t.hash)]
        for (const h of lost) {
          this.known.delete(h as Hex)
          this.rawByHash.delete(h.toLowerCase())
        }
        sequencerAlways(`forgot ${lost.length} tx(s) of block ${open.number} after the failed re-mine; the senders must resend`)
        await this.syncHead()
      }
      throw e
    } finally {
      this.inFlight = []
      if (open) this.gate.open()
    }
    if (nothing) {
      if (open) await this.syncHead() // the reverted block is gone: Anvil's head moved back
      this.onRound?.({ round, ordered: 0, dropped: dropped + pre, ...detail, drained: [] })
      return
    }
    const head = Number(BigInt(await this.anvil.call<Hex>('eth_blockNumber')))
    this.lastMined = head
    this.building = head
    const block = await this.anvil.call<AnvilBlock>('eth_getBlockByNumber', ['0x' + head.toString(16), false])
    // Anvil may accept a tx into its pool and then leave it out of the block (e.g. the balance no longer
    // covers it after earlier txs of the same sender). Say so: the sender was told "accepted" earlier.
    const mined = new Set(block.transactions.map((h) => h.toLowerCase()))
    for (const tx of ordered) {
      if (accepted.has(tx) && !mined.has(tx.hash.toLowerCase())) {
        dropped++
        this.forgetTx(tx)
        // Also evict it from Anvil's pool, or Anvil could mine it later outside our ordering.
        await this.anvil.call('anvil_dropTransaction', [tx.hash]).catch((e) => {
          sequencerAlways(`could not evict ${tx.hash} from Anvil's pool: ${(e as Error).message}`)
        })
        sequencerAlways(`dropped ${tx.hash} at round time: not included in block ${head} (Anvil left it out, e.g. insufficient funds; resend it)`)
      }
    }
    if (!pos.last && block.transactions.length === 0) {
      // A provisional block with nothing in it: undo it, keep no open block.
      await this.anvil.call('evm_revert', [snapshot]).catch((e) => {
        sequencerAlways(`could not undo the empty provisional block ${head}: ${(e as Error).message}`)
      })
      await this.anvil.call('anvil_dropAllTransactions').catch((e) => {
        sequencerAlways(`could not clear Anvil's pool after the empty provisional block: ${(e as Error).message}`)
      })
      await this.syncHead()
      this.onRound?.({ round, ordered: 0, dropped: dropped + pre, pgaRound: pos.pgaRound, reMined: 0, blockOpen: false, ...detail })
      return
    }
    const baseFee = block.baseFeePerGas ? BigInt(block.baseFeePerGas) : this.p.baseFeeWei
    const receipts = await Promise.all(
      block.transactions.map((h) => this.anvil.call<AnvilReceipt>('eth_getTransactionReceipt', [h])),
    )
    // Never emit an empty raw_tx: use the lifetime map, else ask Anvil (e.g. eth_sendTransaction passthrough).
    const rawFor = async (hash: Hex): Promise<Hex> => {
      const known = this.rawByHash.get(hash.toLowerCase())
      if (known) return known
      const fetched = await this.anvil.call<Hex>('eth_getRawTransactionByHash', [hash])
      this.rawByHash.set(hash.toLowerCase(), fetched)
      return fetched
    }
    const priorByHash = new Map(prior.map((m) => [m.transaction.tx_hash.toLowerCase(), m]))
    const fresh = receipts.filter((r) => !priorByHash.has(r.transactionHash.toLowerCase()))
    const rawTxs = await Promise.all(fresh.map((r) => rawFor(r.transactionHash)))
    const pgaRound = pos.pgaRound
    const msgs: FeedMessage[] = fresh.map((r, idx) => this.feedMessage(r, rawTxs[idx]!, head, baseFee, orderedAt, pgaRound))
    {
      // The invariant: every receipt published on the feed equals the final mined receipt, and the block is the one we promised.
      this.mismatch(head, '(header)', compareBlock({ number: open && prior.length > 0 ? open.number : head, timestamp, baseFee: this.p.baseFeeWei }, { number: head, timestamp: Number(BigInt(block.timestamp)), baseFee }))
      const chainByHash = new Map(receipts.map((r) => [r.transactionHash.toLowerCase(), r]))
      for (const m of prior) {
        const r = chainByHash.get(m.transaction.tx_hash.toLowerCase())
        if (!r) {
          this.mismatch(head, m.transaction.tx_hash, [{ field: 'tx', feed: 'published', chain: 'not in the final block' }])
          continue
        }
        const c = this.feedMessage(r, m.transaction.raw_tx, head, baseFee, orderedAt, m.pga_round ?? 1).transaction
        this.mismatch(head, m.transaction.tx_hash, compareReceipts({ hash: m.transaction.tx_hash, txIndex: m.transaction.tx_index, receipt: m.transaction.receipt }, { hash: c.tx_hash, txIndex: c.tx_index, receipt: c.receipt }))
        if (m.transaction.block_number !== head) this.mismatch(head, m.transaction.tx_hash, [{ field: 'block_number', feed: String(m.transaction.block_number), chain: String(head) }])
      }
      for (const m of msgs) {
        const e = traced.get(m.transaction.tx_hash.toLowerCase())
        if (e) {
          e.block = head
          e.pgaRound = pos.pgaRound
        }
      }
    }
    this.recordArrivals(head, pgaRound, ordered, msgs)
    // Publish first (synchronously queued on the sockets), THEN decide when the block is visible.
    for (const m of msgs) this.feed.publish(m)
    if (pos.last) {
      // The block is complete: visible only now (final mine done) + BLOCK_PUBLISH_DELAY_MS, which is at or after the block boundary.
      this.blocks.push({ number: head, revealAt: this.clock.simNow() + this.p.blockPublishDelayMs })
    } else {
      this.open = { slot: pos.slot, number: head, timestamp, snapshot: snapshot!, published: [...prior, ...msgs].sort((a, b) => a.transaction.tx_index - b.transaction.tx_index) }
    }
    this.onRound?.({
      round,
      ordered: ordered.length - dropped,
      dropped: dropped + pre,
      block: head,
      pgaRound: pos.pgaRound,
      reMined: prior.length,
      blockOpen: !pos.last,
      ...detail,
    })
  }
}

/** "chain clock now 12.3s behind wall time" (after a pause) / "chain clock now 4.0s ahead of wall time" (after a clock skip). */
function lagText(lagMs: number): string {
  const s = (Math.abs(lagMs) / 1000).toFixed(1)
  return lagMs >= 0 ? `chain clock now ${s}s behind wall time` : `chain clock now ${s}s ahead of wall time (clock skip)`
}
