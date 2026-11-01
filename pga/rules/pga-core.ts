// PGA model (pure module: no I/O, no clock).
//
// Rules implemented here: effective tip and the per-round ordering (B1); nonce gating and the
// gap hold (B2); the anti-starvation boost and the block-full cap (B3: `runRound`).
// https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
import type { Address, Hex } from 'viem'

export interface QueuedTx {
  hash: Hex
  raw: Hex
  from: Address
  nonce: number
  /** EIP-1559 fields (type 2). */
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  /** Legacy / type-1 fields. */
  gasPrice?: bigint
  /** ms since epoch when the sequencer received it. */
  arrivedAt: number
}

export type TipFields = Pick<QueuedTx, 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasPrice'>

/** The bid as (maxFee, maxPriority), with the legacy gasPrice fallback (see ASSUMPTION below). */
export function bidOf(tx: TipFields): { maxFee: bigint; maxPriority: bigint } {
  return { maxFee: tx.maxFeePerGas ?? tx.gasPrice ?? 0n, maxPriority: tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n }
}

/**
 * Effective tip = min(maxPriorityFeePerGas, maxFeePerGas - baseFee).
 * The "tip" that orders a tx is this standard EIP-1559 priority fee, not the bid.
 * Example (baseFee 0.01 gwei): tip 0.1 / maxFee 1 -> 0.1; tip 0.1 / maxFee 0.05 -> 0.04 (capped).
 * https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
 *
 * ASSUMPTION: legacy and type-1 txs carry one gasPrice; it is treated as both maxFeePerGas and
 * maxPriorityFeePerGas, so the tip is gasPrice - baseFee.
 * ASSUMPTION: a maxFee below the base fee gives a negative difference; we clamp the tip to 0
 * (the docs do not say; such a tx could not pay the base fee and a real node would not include it).
 */
export function effectiveTip(tx: TipFields, baseFee: bigint): bigint {
  const { maxFee, maxPriority } = bidOf(tx)
  const headroom = maxFee - baseFee
  const tip = maxPriority < headroom ? maxPriority : headroom
  return tip > 0n ? tip : 0n
}

/** Lower-case address, the key of every per-sender map. */
export const senderKey = (a: string): string => a.toLowerCase()

type Orderable = TipFields & { arrivedAt: number; from: Address; nonce: number }

export interface RoundSelection<T> {
  /** The drained order: what is submitted to the block, in this order. */
  ordered: T[]
  /** Queue priority (effective tip + boost) of each ordered tx, parallel to `ordered`. Fifo mode: all 0. */
  priorities: bigint[]
  /** Not eligible this round: a nonce gap (its predecessor is not waiting and not yet executed). They stay waiting. */
  held: T[]
  /** Eligible but left out because the block filled (`maxTxs`). They stay waiting. Always empty without a cap. */
  deferred: T[]
}

export interface SelectOptions<T> {
  /** Accumulated boost of a tx, wei (default 0). It changes the ordering key only, never a fee. */
  boostOf?: (tx: T) => bigint
  /**
   * ASSUMPTION (simplification): a tx-COUNT cap stands in for Arbitrum One's block limit (32 Mgas or 95,000 bytes of
   * calldata, whichever comes first). Include at most this many txs (0 or undefined = no cap).
   */
  maxTxs?: number
}

/**
 * Order one round's waiting list like the real sequencer: a priority queue, with nonce gating.
 * Returns new arrays (the input is untouched).
 *
 *  1. Within one sender the nonce decides. "Nonce N plus one isn't even valid until nonce N has executed.
 *     So tips only rank transactions across senders." Only a sender's NEXT nonce (`nextNonce`, read from the chain
 *     at round time) is eligible to enter the queue.
 *  2. The eligible txs sit in a priority queue sorted by effective tip, highest first; ties are broken by arrival,
 *     the earlier first. Pop the best; once a sender's nonce N is included, that sender's N+1 (if it is waiting)
 *     becomes eligible and joins the queue at ITS OWN effective tip. So N+1 never precedes N, however high its tip.
 *  3. A tx whose predecessor is neither waiting nor executed (a nonce gap) is `held`: not eligible this round.
 *     (A tx whose nonce is below `nextNonce` is stale and also never eligible; the sequencer drops those first.)
 * https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
 *
 * B3: the queue key is `effectiveTip + boost` (`opts.boostOf`); the boost is an ordering key only, the fee a tx pays
 * is computed by the chain from the tx's own fields. Nonce gating is unchanged: N+1 joins the queue only after N was
 * included, so a boosted N+1 is still never placed before its N. "The transfer ends when the queue empties, the block
 * fills, or the round runs out of time" (the last condition is the round's wall-clock deadline, which this pure
 * module does not model): `opts.maxTxs` is the block-full condition (ASSUMPTION: a tx-count stand-in for the real
 * gas/bytes limit, see sim/README.md); what is left over is `deferred`.
 * https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
 *
 * `nextNonce` is keyed by lower-case sender address. A sender missing from the map falls back to its lowest waiting
 * nonce (no gap can be detected without the chain's nonce). `mode: 'fifo'` ranks every tx at tip 0, so arrival decides
 * (PGA disabled) while the nonce rule still holds.
 */
export function selectRound<T extends Orderable>(
  queue: readonly T[],
  baseFee: bigint,
  nextNonce: ReadonlyMap<string, number> = new Map(),
  mode: 'pga' | 'fifo' = 'pga',
  opts: SelectOptions<T> = {},
): RoundSelection<T> {
  const boostOf = opts.boostOf ?? (() => 0n)
  const cap = opts.maxTxs !== undefined && opts.maxTxs > 0 ? opts.maxTxs : Infinity
  // `tip` is the queue priority: effective tip plus the accumulated boost (fifo ranks everything at 0).
  const entries = queue.map((tx, i) => ({ tx, i, tip: mode === 'fifo' ? 0n : effectiveTip(tx, baseFee) + boostOf(tx) }))
  const bySender = new Map<string, Map<number, (typeof entries)[number]>>()
  for (const e of entries) {
    const k = senderKey(e.tx.from)
    let m = bySender.get(k)
    if (!m) bySender.set(k, (m = new Map()))
    if (!m.has(e.tx.nonce)) m.set(e.tx.nonce, e) // a duplicate (sender, nonce) is never eligible (the proxy refuses them)
  }
  const better = (a: (typeof entries)[number], b: (typeof entries)[number]) =>
    a.tip === b.tip ? a.tx.arrivedAt - b.tx.arrivedAt || a.i - b.i : a.tip > b.tip ? -1 : 1
  const pq: (typeof entries)[number][] = []
  for (const [k, m] of bySender) {
    const next = nextNonce.get(k) ?? Math.min(...m.keys())
    const first = m.get(next)
    if (first) pq.push(first)
  }
  // The contiguous run of each sender that starts at its next nonce: eligible this round or, if the block fills first,
  // the next one. Everything outside the run is behind a nonce gap (held).
  const runnable = new Set<(typeof entries)[number]>()
  for (const [k, m] of bySender) {
    let n = nextNonce.get(k) ?? Math.min(...m.keys())
    for (let e = m.get(n); e; e = m.get(++n)) runnable.add(e)
  }
  const ordered: T[] = []
  const priorities: bigint[] = []
  const included = new Set<(typeof entries)[number]>()
  while (pq.length > 0 && ordered.length < cap) {
    pq.sort(better)
    const e = pq.shift()!
    ordered.push(e.tx)
    priorities.push(e.tip)
    included.add(e)
    const follow = bySender.get(senderKey(e.tx.from))!.get(e.tx.nonce + 1)
    if (follow) pq.push(follow)
  }
  const rest = entries.filter((e) => !included.has(e))
  return {
    ordered,
    priorities,
    held: rest.filter((e) => !runnable.has(e)).map((e) => e.tx),
    deferred: rest.filter((e) => runnable.has(e)).map((e) => e.tx),
  }
}

export interface RoundParams {
  /** K: rounds per block. */
  k: number
  /** Block-full stand-in, a tx count (ASSUMPTION, see SelectOptions.maxTxs; 0 = no cap). */
  maxTxs: number
}

export interface RoundResult<T> extends RoundSelection<T> {
  /**
   * p: the queue priority (effective tip + accumulated boost) of the last tx this round included, 0 if it included none.
   * ASSUMPTION: "the priority of the last transaction the previous round included" is read as that tx's queue
   * priority, boost included (the docs do not say whether p counts a boost).
   */
  p: bigint
  /** The boost every tx still waiting gains at the end of this round: p / (2K), integer wei (floored). */
  boost: bigint
  /** The txs still waiting after the round: `held` and `deferred`, in the order of the input queue. */
  waiting: T[]
  /** New accumulated boost of each waiting tx (hash -> wei): the old boost plus `boost`. Included txs are not in it. */
  boosts: Map<Hex, bigint>
}

/**
 * One whole round, pure: order the queue (with the boosts carried in), apply the block-full cap, and compute the boosts
 * carried out.
 *
 *  - "At the end of every round in which the priority queue holds transactions, each transaction still waiting gains a
 *    priority boost of p / (2K). Here p is the priority of the last transaction the previous round included, or zero
 *    if that round included none."
 *  - "The boost moves a transaction's position in the queue and nothing else. It never changes the fee the transaction
 *    pays." Only the ordering key changes here; nothing in this module touches a fee.
 *  - "The boost compounds across rounds": `boosts` is returned for the caller to pass back in next round.
 *  - ASSUMPTION (the docs do not say): the boost is added once per round to EVERY tx still waiting at the end of the
 *    round, including txs held for a nonce gap. Simplest consistent rule: waiting = boosted, whatever the reason it
 *    waits. A round that included nothing has p = 0, so it adds 0. Ties still break on the original arrival time.
 *  - Called only for rounds whose waiting list is non-empty (a round with an empty list has no queue and no boost).
 * https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
 *
 * Without a cap the queue always drains, so only gap-held txs carry over (and are boosted by the rule above).
 */
export function runRound<T extends Orderable & { hash: Hex }>(
  queue: readonly T[],
  boosts: ReadonlyMap<Hex, bigint>,
  baseFee: bigint,
  nextNonce: ReadonlyMap<string, number>,
  mode: 'pga' | 'fifo',
  params: RoundParams,
): RoundResult<T> {
  const sel = selectRound(queue, baseFee, nextNonce, mode, { boostOf: (t) => boosts.get(t.hash) ?? 0n, maxTxs: params.maxTxs })
  const p = sel.priorities.length > 0 ? sel.priorities[sel.priorities.length - 1]! : 0n
  const boost = p / (2n * BigInt(params.k))
  const left = new Set<T>([...sel.held, ...sel.deferred])
  const waiting = queue.filter((t) => left.has(t))
  const next = new Map<Hex, bigint>()
  for (const t of waiting) next.set(t.hash, (boosts.get(t.hash) ?? 0n) + boost)
  return { ...sel, p, boost, waiting, boosts: next }
}

/** One round of a tx's life in the queue, as served by `sim_boostTrace`. */
export interface BoostTraceEntry {
  round: number
  /** Queue priority at that round (effective tip + boost before this round's boost), wei as a decimal string. */
  priority: string
  included: boolean
  /** Waiting behind a nonce gap that round (not in the priority queue). */
  held?: boolean
  block?: number
  /** The PGA round (1..K) inside `block` where the tx was included. */
  pgaRound?: number
}

/**
 * ASSUMPTION (gap handling; the docs do not say): a tx held for a nonce gap waits in the waiting list for its
 * predecessor. After GAP_HOLD_ROUNDS rounds of being held it is dropped (the sequencer logs it; the sender resends).
 * `heldRounds` counts the rounds this tx has been held, including the current one.
 */
export function gapExpired(heldRounds: number, limit: number): boolean {
  return heldRounds >= limit
}

/**
 * The first nonce missing from the sender's contiguous run that starts at its `nextNonce` and covers the txs ordered
 * this round. A held tx is waiting for exactly this nonce (e.g. N and N+1 ordered, N+3 held -> N+2).
 */
export function waitingForNonce(nextNonce: number, orderedNonces: Iterable<number>): number {
  const have = new Set(orderedNonces)
  let n = nextNonce
  while (have.has(n)) n++
  return n
}
