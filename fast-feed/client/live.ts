// The live view behind `npm run feed -- --local|--testnet --live`, and the panel the demo draws on a terminal.
// Line mode: one table per PGA round, rows in tx_index order, then one timing line per round and, once the block is visible
// on the sequencer RPC, one "FF lead" line per row. Panel mode: `formatPanel` (the open block and the previous, closed one).
// Pure functions (decode, group, format) do the work; `LiveRounds` only wires them to a stream of messages.
// Concepts: fast-feed/README.md "Live view".
import { note, plain, style } from '../../shared/narrate.ts'
import { formatEther, formatGwei, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ANVIL_DEV_KEY_0, walletKey, type Preset } from '../../shared/config.ts'
import { toBigInt, type FeedMessageJson } from './client.ts'
import { apiKeyHash } from './key.ts'
import { makeCtx, nowSec, readKeyAccess, readRound } from './tickets.ts'

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** What the sender offered: EIP-1559 (maxPriorityFee / maxFee) or legacy (one gasPrice). */
export type Bid =
  | { kind: 'eip1559'; maxPriority: bigint; maxFee: bigint }
  | { kind: 'legacy'; gasPrice: bigint }
  /** `raw_tx` could not be parsed (e.g. an ArbOS internal tx): only the receipt fields are known. */
  | { kind: 'unknown' }

export interface LiveRow {
  blockNumber: number
  /** The PGA round within the block (docs: optional, starts at 1). */
  pgaRound?: number
  txIndex: number
  hash: Hex
  /** null when `raw_tx` could not be decoded. */
  from: Address | null
  /** The tx's nonce, when `raw_tx` could be decoded. */
  nonce?: number
  to: Address | null
  bid: Bid
  /** effective_gas_price - base_fee, wei. */
  effectiveTip: bigint
  gasUsed: bigint
  /** gas_used x effective_gas_price, wei. */
  feePaid: bigint
  status: number
  /** The sequencer's `timestamp_ms`: when the round was ordered. */
  orderedAt: number
  /** Local clock when the frame arrived. */
  receivedAt: number
}

type Parsed = ReturnType<typeof parseTransaction>

function bidOfParsed(tx: Parsed): Bid {
  // viem parses a zero tip as undefined, so a type-2 tx is recognised by its type or its fee cap.
  if (tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined || tx.type === 'eip1559') {
    return { kind: 'eip1559', maxPriority: tx.maxPriorityFeePerGas ?? 0n, maxFee: tx.maxFeePerGas ?? 0n }
  }
  return { kind: 'legacy', gasPrice: tx.gasPrice ?? 0n }
}

/**
 * Pure: a feed message plus its recovered sender (null if undecodable) becomes a row.
 * A raw_tx that cannot be parsed (e.g. the ArbOS internal tx on Arbitrum) keeps its receipt fields, with
 * `bid.kind === 'unknown'`, no `to`, and the sender shown as "(undecodable tx type)".
 */
export function rowFromMessage(msg: FeedMessageJson, from: Address | null, receivedAt: number): LiveRow {
  const t = msg.transaction
  const r = t.receipt
  const effective = toBigInt(r.effective_gas_price)
  const gasUsed = toBigInt(r.gas_used)
  let parsed: Parsed | undefined
  try {
    parsed = parseTransaction(t.raw_tx)
  } catch {
    parsed = undefined
  }
  return {
    blockNumber: t.block_number,
    pgaRound: msg.pga_round,
    txIndex: t.tx_index,
    hash: t.tx_hash,
    from: parsed ? from : null,
    nonce: parsed?.nonce,
    to: parsed?.to ?? null,
    bid: parsed ? bidOfParsed(parsed) : { kind: 'unknown' },
    effectiveTip: effective - toBigInt(r.base_fee),
    gasUsed,
    feePaid: gasUsed * effective,
    status: Number(toBigInt(r.status)),
    orderedAt: msg.timestamp_ms,
    receivedAt,
  }
}

export async function decodeLiveRow(msg: FeedMessageJson, receivedAt: number): Promise<LiveRow> {
  let from: Address | null = null
  try {
    from = await recoverTransactionAddress({ serializedTransaction: msg.transaction.raw_tx as `0x02${string}` })
  } catch {
    from = null // undecodable: rowFromMessage then shows "(undecodable tx type)"
  }
  return rowFromMessage(msg, from, receivedAt)
}

// ---------------------------------------------------------------------------
// Groups: one table per (block_number, pga_round); without pga_round, per block
// ---------------------------------------------------------------------------

export const groupKey = (r: Pick<LiveRow, 'blockNumber' | 'pgaRound'>): string => `${r.blockNumber}:${r.pgaRound ?? '-'}`

export interface RoundGroup {
  key: string
  blockNumber: number
  pgaRound?: number
  /** In tx_index order. */
  rows: LiveRow[]
}

export const groupLabel = (g: Pick<RoundGroup, 'blockNumber' | 'pgaRound'>): string =>
  g.pgaRound === undefined ? `block ${g.blockNumber}` : `block ${g.blockNumber} · round ${g.pgaRound}`

/** Group rows by (block_number, pga_round) (block only when pga_round is absent); groups keep first-seen order, rows are sorted by tx_index. */
export function groupRows(rows: readonly LiveRow[]): RoundGroup[] {
  const groups = new Map<string, RoundGroup>()
  for (const r of rows) {
    const key = groupKey(r)
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { key, blockNumber: r.blockNumber, pgaRound: r.pgaRound, rows: [] }))
    g.rows.push(r)
  }
  for (const g of groups.values()) g.rows.sort((a, b) => a.txIndex - b.txIndex)
  return [...groups.values()]
}

// ---------------------------------------------------------------------------
// Formatting (every number carries its unit)
// ---------------------------------------------------------------------------

export const gwei = (wei: bigint): string => formatGwei(wei) // exact decimal, no exponent
export const fmtGwei = (wei: bigint): string => `${gwei(wei)} gwei`
export const fmtEth = (wei: bigint): string => `${formatEther(wei)} ETH`
export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`

export function fmtBid(b: Bid): string {
  if (b.kind === 'unknown') return '-'
  return b.kind === 'eip1559' ? `${gwei(b.maxPriority)} / ${gwei(b.maxFee)} gwei` : `gasPrice ${fmtGwei(b.gasPrice)}`
}

export const UNDECODABLE = '(undecodable tx type)'
export const OUT_OF_ORDER = 'out of tip order (nonce-gated / boosted)'
export const NONCE_GATED = 'out of tip order (nonce-gated)'

/**
 * "yours, tip 1 gwei, index 0 of round 1" (the round is `pga_round`; block-only streams say "of block N"). With rounds sharing
 * a block, `tx_index` counts block-wide, so "of round R" uses `indexInRound` (the row's position in its round) when given.
 */
export function yoursLabel(r: Pick<LiveRow, 'effectiveTip' | 'txIndex' | 'pgaRound' | 'blockNumber'>, indexInRound?: number): string {
  const idx = r.pgaRound === undefined ? r.txIndex : (indexInRound ?? r.txIndex)
  return `yours, tip ${fmtGwei(r.effectiveTip)}, index ${idx} of ${r.pgaRound === undefined ? `block ${r.blockNumber}` : `round ${r.pgaRound}`}`
}

/** True for a row whose effective tip is higher than the row above it (never for the first row). */
export function outOfOrder(rows: readonly LiveRow[], i: number): boolean {
  return i > 0 && rows[i]!.effectiveTip > rows[i - 1]!.effectiveTip
}

/** True when row i's sender also appears EARLIER in the round with a lower nonce: it waited for that nonce (the nonce rule). */
export function nonceGated(rows: readonly LiveRow[], i: number): boolean {
  const r = rows[i]!
  if (r.from === null || r.nonce === undefined) return false
  return rows.slice(0, i).some((p) => p.from?.toLowerCase() === r.from!.toLowerCase() && p.nonce !== undefined && p.nonce < r.nonce!)
}

export interface TableOptions {
  /** Lower-case addresses that are "mine". */
  mine?: ReadonlySet<string>
  /** Wrap highlighted rows in ANSI bold (callers pass `colorEnabled(process.stdout.isTTY)`). The `>>` marker never depends on it. */
  bold?: boolean
}

export function formatTable(g: RoundGroup, opts: TableOptions = {}): string[] {
  const mine = opts.mine ?? new Set<string>()
  const head = ['tx_index', 'from', 'to', 'bid (maxPriorityFee / maxFee)', 'effective tip', 'gas used', 'fee paid']
  const body = g.rows.map((r) => [
    String(r.txIndex),
    r.from ? shortAddr(r.from) : UNDECODABLE,
    r.to ? shortAddr(r.to) : r.bid.kind === 'unknown' ? '-' : '(create)',
    fmtBid(r.bid),
    fmtGwei(r.effectiveTip),
    `${r.gasUsed} gas`,
    fmtEth(r.feePaid),
  ])
  const widths = head.map((h, c) => Math.max(h.length, ...body.map((row) => row[c]!.length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
  const out = [`── ${groupLabel(g)} · ${g.rows.length} tx${g.rows.length === 1 ? '' : 's'} ──`, `   ${line(head)}`]
  g.rows.forEach((r, i) => {
    const notes: string[] = []
    const isMine = r.from !== null && mine.has(r.from.toLowerCase())
    if (isMine) notes.push(yoursLabel(r, i))
    if (outOfOrder(g.rows, i)) notes.push(nonceGated(g.rows, i) ? NONCE_GATED : OUT_OF_ORDER)
    if (r.status !== 1) notes.push('reverted')
    const text = `${isMine ? '>> ' : '   '}${line(body[i]!)}${notes.length ? `  <- ${notes.join('; ')}` : ''}`
    out.push(isMine && opts.bold ? style('bold', text) : text)
  })
  return out
}

/** Feed lead: how long after the sequencer ordered the round the message reached us (includes clock skew on a testnet). */
export const leadMs = (r: Pick<LiveRow, 'orderedAt' | 'receivedAt'>): number => r.receivedAt - r.orderedAt

export interface Timing {
  pgaRound?: number
  blockNumber: number
  /** Feed receipt minus `timestamp_ms`. */
  leadMs: number
  /** Time from feed receipt until the block was visible on the RPC; undefined = not seen before the deadline. */
  visibleMs?: number
}

/** `ordered (round R) → Fast Feed +Xms → block N visible on RPC +Yms` */
export function formatTimingLine(t: Timing): string {
  const round = t.pgaRound === undefined ? 'ordered' : `ordered (round ${t.pgaRound})`
  const vis = t.visibleMs === undefined ? `block ${t.blockNumber} not visible on RPC yet` : `block ${t.blockNumber} visible on RPC +${t.visibleMs}ms`
  const skew = t.leadMs <= 0 ? ' (lead <= 0: the feed server clock and ours disagree)' : ''
  return `${round} → Fast Feed +${t.leadMs}ms → ${vis}${skew}`
}

export const FOOTER =
  "NOTE: within each round, rows are sorted by tip. That's PGA. You saw them before the block existed. That's the Fast Feed."

// ---------------------------------------------------------------------------
// "Mine": addresses to highlight
// ---------------------------------------------------------------------------

/** Lower-case addresses: the address of PRIVATE_KEY, Anvil dev account 0 locally (always: it is the CLI default wallet), plus MY_ADDRESSES (comma-separated). */
export function myAddresses(preset: Pick<Preset, 'mode'>, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>()
  if (preset.mode === 'local') out.add(privateKeyToAccount(ANVIL_DEV_KEY_0).address.toLowerCase())
  try {
    out.add(privateKeyToAccount(walletKey(preset as Preset, env)).address.toLowerCase())
  } catch {
    // testnet without PRIVATE_KEY: only MY_ADDRESSES
  }
  for (const a of (env.MY_ADDRESSES ?? '').split(',')) {
    const t = a.trim()
    if (/^0x[0-9a-fA-F]{40}$/.test(t)) out.add(t.toLowerCase())
  }
  return out
}

// ---------------------------------------------------------------------------
// Header: the ticket round this key is active in
// ---------------------------------------------------------------------------

export type HeaderInfo =
  | { auth: false }
  | { auth: true; round: bigint; roundEnd: number; now: number; active: bigint }
  | { auth: true; unavailable: string }

export function formatHeader(h: HeaderInfo): string[] {
  if (!h.auth) return ['Fast Feed live view. Feed auth is off; no ticket needed.']
  if ('unavailable' in h) return ['Fast Feed live view. Ticket round: unavailable (' + h.unavailable + ').']
  const left = Math.max(0, h.roundEnd - h.now)
  const lines = [`Fast Feed live view. Ticket round ${h.round}: ${left}s left (ends ${new Date(h.roundEnd * 1000).toISOString()}).`]
  lines.push(
    h.active > 0n
      ? `  Your key holds ${h.active} active ticket(s) in round ${h.round}. Without a renewal bought before the round ends, the feed closes with 1008.`
      : `  Your key holds no active ticket in round ${h.round}.`,
  )
  return lines
}

/** Read the ticket round and the key's active tickets (reusing the ticket steps). Never throws: a failure becomes `unavailable`. */
export async function readHeader(preset: Preset, apiKey: string | undefined, feedAuthOn: boolean): Promise<HeaderInfo> {
  if (!feedAuthOn) return { auth: false }
  try {
    const ctx = makeCtx(preset)
    const info = await readRound(ctx)
    let active = 0n
    if (apiKey) {
      const { access } = await readKeyAccess(ctx, apiKeyHash(apiKey), info.round)
      if (access.active) active = access.tickets
    }
    return { auth: true, round: info.round, roundEnd: Number(info.roundEnd), now: nowSec(), active }
  } catch (e) {
    return { auth: true, unavailable: (e as Error).message.split('\n')[0]! }
  }
}

// ---------------------------------------------------------------------------
// Block visibility
// ---------------------------------------------------------------------------

export async function blockVisible(rpcUrl: string, n: number): Promise<boolean> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), false] }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = (await res.json()) as { result?: unknown }
  return body.result != null
}

/**
 * Poll until block n exists on the RPC. Resolves with the wall-clock time it was first seen, or undefined at the
 * deadline (`paused`: time while it answers true does not count). The poll interval starts at 20ms and backs off to `maxDelayMs` (200ms), to spare public RPCs; a caller that compares the time with another observer's passes a smaller cap.
 */
export async function waitBlockVisible(rpcUrl: string, n: number, deadlineMs = 60_000, maxDelayMs = 200, paused?: () => boolean): Promise<number | undefined> {
  let end = Date.now() + deadlineMs
  let delay = 20
  let last = Date.now()
  while (Date.now() < end) {
    // E2: a paused local simulator reveals nothing, so the time spent paused does not count against the deadline.
    const now = Date.now()
    if (paused?.()) end += now - last
    last = now
    try {
      if (await blockVisible(rpcUrl, n)) return Date.now()
    } catch {
      /* RPC hiccup: retry */
    }
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(maxDelayMs, Math.round(delay * 1.5))
  }
  return undefined
}


// ---------------------------------------------------------------------------
// Blocks and "FF lead"
// ---------------------------------------------------------------------------

/**
 * FF lead of one row: `blockVisibleAt - feedReceivedAt`, ms. It is how much earlier the Fast Feed showed this tx than a direct read
 * of the sequencer RPC (`eth_getBlockByNumber`) would have shown the finalized block. Never negative: a block that was already
 * visible when the row arrived (or a clock step) means the feed was not earlier, so the lead is 0, not a negative number.
 */
export const ffLeadMs = (receivedAt: number, blockVisibleAt: number): number => Math.max(0, blockVisibleAt - receivedAt)

/** `+1.25s`: a lead, seconds with two decimals. */
export const fmtLead = (ms: number): string => `+${(ms / 1000).toFixed(2)}s`

/** The rows of one block as the live view knows them (all of its rounds), plus when its block became visible on the RPC. */
export interface BlockView {
  blockNumber: number
  /** Every row seen for this block, in tx_index order (rounds interleave by index: round 1 first). */
  rows: LiveRow[]
  /** Local clock when the block's first row arrived: the block-visible probe starts then. */
  firstReceivedAt: number
  /** Local clock when a direct read of the sequencer RPC first returned the block. Undefined until then. */
  visibleAt?: number
  /** The probe reached its deadline without seeing the block. */
  gaveUp?: boolean
  /** Complete: the block is visible, or a later block's row has arrived (the sequencer is past it). */
  complete: boolean
}

/** Rounds of a block in round order (block-only streams have one group). */
export const blockRounds = (b: Pick<BlockView, 'rows'>): RoundGroup[] => groupRows(b.rows).sort((a, c) => (a.pgaRound ?? 0) - (c.pgaRound ?? 0))

/** `round 1/2` (K known) or `round 1`. */
export const roundLabel = (round: number | undefined, k?: number): string => (round === undefined ? 'block' : k !== undefined ? `round ${round}/${k}` : `round ${round}`)

/**
 * Line-based form of the FF lead, one line per row, printed after the round's timing line once the block is visible:
 * `FF lead  block 7 round 1/2  tx_index 3  +1.25s` (`>>` marks "yours").
 */
export function formatLeadLines(g: RoundGroup, leadOf: (r: LiveRow) => number, o: { mine?: ReadonlySet<string>; k?: number; bold?: boolean } = {}): string[] {
  return g.rows.map((r) => {
    const isMine = r.from !== null && (o.mine?.has(r.from.toLowerCase()) ?? false)
    const text = `${isMine ? '>> ' : '   '}FF lead  block ${g.blockNumber} ${roundLabel(g.pgaRound, o.k)}  tx_index ${r.txIndex}  ${fmtLead(leadOf(r))}`
    return isMine && o.bold ? style('bold', text) : text
  })
}

// ---------------------------------------------------------------------------
// The panel (TTY): the open block and the previous, closed block, nothing more
// ---------------------------------------------------------------------------

export const PANEL_WIDTH = 80

export interface PanelOptions {
  /** Lower-case addresses that are "mine" (bold, `<- yours`). */
  mine?: ReadonlySet<string>
  /** Colour on: status lines in the palette, "yours" rows bold. Off: plain text (the `>>` marker never depends on it). */
  color?: boolean
  /** PGA rounds per block (local: 2), so rounds are labelled `round 1/2` and a missing one is shown as such. */
  k?: number
  /** Columns available (default and maximum 80). */
  width?: number
  /** Most lines the panel may take (rows are elided with `... N more` to fit; "yours" rows are kept). */
  maxLines?: number
}

/** Pure: the one status line of a block. `kind` picks its colour. */
export function blockStatus(b: BlockView, nowMs: number): { text: string; kind: 'open' | 'closed' | 'gaveUp' } {
  const since = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`
  if (b.visibleAt !== undefined) {
    return { kind: 'closed', text: `block ${b.blockNumber} [closed]: visible on the sequencer RPC, +${since(b.visibleAt - b.firstReceivedAt)} after its first feed row` }
  }
  if (b.gaveUp) return { kind: 'gaveUp', text: `block ${b.blockNumber}: never visible on the sequencer RPC within the wait` }
  return { kind: 'open', text: `block ${b.blockNumber}: not visible on the sequencer RPC yet, +${since(nowMs - b.firstReceivedAt)}` }
}

/** Cut a line to `width` columns (the last one becomes an ellipsis). */
export const fit = (s: string, width: number): string => (s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`)

/** Pure: at most `cap` rows, "yours" rows first in priority, order kept. */
function pickRows(rows: readonly LiveRow[], isMine: (r: LiveRow) => boolean, cap: number): { shown: LiveRow[]; hidden: number } {
  if (rows.length <= cap) return { shown: [...rows], hidden: 0 }
  const keep = new Set<LiveRow>(rows.filter(isMine).slice(0, cap))
  for (const r of rows) if (keep.size < cap) keep.add(r)
  const shown = rows.filter((r) => keep.has(r))
  return { shown, hidden: rows.length - shown.length }
}

/**
 * Pure: the panel, as lines of at most 80 columns: the previous block (closed, or still waiting for its RPC visibility) above
 * the open one. Each block: a status line, then its rounds (`round 1/2`, `round 2/2`) with a row per tx and a final `FF lead`
 * column, filled once the block is visible on a direct read of the sequencer RPC. Only these two blocks are drawn.
 */
export function formatPanel(open: BlockView | undefined, previous: BlockView | undefined, nowMs: number, opts: PanelOptions = {}): string[] {
  const width = Math.min(opts.width ?? PANEL_WIDTH, PANEL_WIDTH)
  const mine = opts.mine ?? new Set<string>()
  const color = opts.color === true
  const k = opts.k
  const isMine = (r: LiveRow) => r.from !== null && mine.has(r.from.toLowerCase())
  const blocks = [previous, open].filter((b): b is BlockView => b !== undefined)
  if (blocks.length === 0) return [fit('waiting for the first Fast Feed message...', width)]

  // The rounds each block shows: with K known, every round 1..K (a missing one says so); otherwise the rounds seen.
  const plan = blocks.map((b) => {
    const groups = blockRounds(b)
    const slots: { round: number | undefined; group?: RoundGroup }[] =
      k !== undefined && groups.every((g) => g.pgaRound !== undefined)
        ? Array.from({ length: Math.max(k, ...groups.map((g) => g.pgaRound!)) }, (_, i) => ({ round: i + 1, group: groups.find((g) => g.pgaRound === i + 1) }))
        : groups.map((g) => ({ round: g.pgaRound, group: g }))
    return { b, slots }
  })
  // Fixed lines per block: status + column header + one per round; the rest is the row budget.
  const nSlots = plan.reduce((n, p) => n + Math.max(1, p.slots.length), 0)
  const fixed = plan.length * 2 + nSlots
  const totalRows = blocks.reduce((n, b) => n + b.rows.length, 0)
  const groups = Math.max(1, plan.reduce((n, p) => n + p.slots.filter((s) => s.group).length, 0))
  let cap = Infinity
  if (opts.maxLines !== undefined && fixed + totalRows > opts.maxLines) cap = Math.max(1, Math.floor((opts.maxLines - fixed - groups) / groups))

  const out: string[] = []
  const sections: number[] = []
  for (const { b, slots } of plan) {
    sections.push(out.length)
    const st = blockStatus(b, nowMs)
    const statusText = fit(st.text, width)
    out.push(!color ? statusText : style(st.kind === 'closed' ? 'step' : st.kind === 'gaveUp' ? 'warn' : 'note', statusText))
    const lines: { text: string; mine?: boolean }[] = []
    const cells: { r: LiveRow; c: string[] }[] = []
    const picked = slots.map((s) => (s.group ? pickRows(s.group.rows, isMine, cap) : undefined))
    for (const p of picked) for (const r of p?.shown ?? []) cells.push({ r, c: [String(r.txIndex), r.from ? shortAddr(r.from) : '(undecodable)', fmtGwei(r.effectiveTip), b.visibleAt !== undefined ? fmtLead(ffLeadMs(r.receivedAt, b.visibleAt)) : '-'] })
    const head = ['index', 'from', 'effective tip', 'FF lead']
    const widths = head.map((h, i) => Math.max(h.length, ...cells.map((x) => x.c[i]!.length)))
    const cols = (c: string[]) => c.map((x, i) => (i === 0 ? x.padStart(widths[i]!) : x.padEnd(widths[i]!))).join('  ').trimEnd()
    lines.push({ text: `   ${cols(head)}` })
    slots.forEach((s, si) => {
      const label = roundLabel(s.round, k)
      if (!s.group) {
        const why = b.visibleAt === undefined && !b.complete ? 'not ordered yet' : 'no transactions seen'
        lines.push({ text: `  ${label}: ${why}` })
        return
      }
      lines.push({ text: `  ${label} · ${s.group.rows.length} tx${s.group.rows.length === 1 ? '' : 's'}` })
      const p = picked[si]!
      for (const r of p.shown) {
        const c = cells.find((x) => x.r === r)!.c
        const notes: string[] = []
        if (isMine(r)) notes.push('<- yours')
        if (r.status !== 1) notes.push('reverted')
        lines.push({ text: `${isMine(r) ? '>> ' : '   '}${cols(c)}${notes.length ? `  ${notes.join(' ')}` : ''}`, mine: isMine(r) })
      }
      if (p.hidden > 0) lines.push({ text: `   ... ${p.hidden} more tx${p.hidden === 1 ? '' : 's'} (the terminal is too short)` })
    })
    for (const l of lines) {
      const t = fit(l.text, width)
      out.push(l.mine && color ? style('bold', t) : t)
    }
  }
  if (opts.maxLines === undefined) return out
  const max = Math.max(1, opts.maxLines)
  if (out.length <= max) return out
  // Still too tall: the open block is kept whole (header and status first); the previous block is cut first, then the open
  // block's oldest lines, so its header, status line and newest rows stay.
  const openStart = sections[sections.length - 1]!
  const openLines = out.slice(openStart)
  if (openLines.length >= max) {
    const head = openLines.slice(0, Math.min(2, max))
    return [...head, ...openLines.slice(head.length).slice(-(max - head.length))].slice(0, max)
  }
  return [...out.slice(0, openStart).slice(0, max - openLines.length), ...openLines]
}

// ---------------------------------------------------------------------------
// The stream: messages in, one table and one timing line per round out
// ---------------------------------------------------------------------------

export interface RoundReport {
  group: RoundGroup
  table: string[]
  /** Set once the timing is measured; `timingLine` is its text. */
  timing?: Timing
  timingLine?: string
  /** Set with the timing when the block was visible: each row's FF lead (ms). */
  leads?: { row: LiveRow; leadMs: number }[]
}

export interface LiveOptions {
  rpcUrl: string
  mine?: ReadonlySet<string>
  bold?: boolean
  /** Where lines go (default console.log). */
  out?: (line: string) => void
  /** A round is complete when a message of another (block, round) arrives, or after this much silence. */
  quietMs?: number
  /** Print the footer every this many rounds (0 = never). */
  footerEvery?: number
  /** Give up on block visibility after this long. */
  visibilityDeadlineMs?: number
  /** E2: true while the local simulator is paused; the block-visible probe's deadline does not run then. */
  isPaused?: () => boolean
  /** PGA rounds per block, for the `round 1/2` labels. */
  roundsPerBlock?: number
  /** Event API: called when a round's table is printed, and again once its timing line is known. */
  onTable?: (r: RoundReport) => void
  onTiming?: (r: RoundReport) => void
  /** Called for every row as it arrives, with the block it belongs to. */
  onRow?: (row: LiveRow, block: BlockView) => void
  /** Called when a block's visibility is known: `block.visibleAt` is set, or `block.gaveUp` after the deadline. */
  onBlockVisible?: (block: BlockView) => void
}

interface BlockState extends BlockView {
  probe: Promise<number | undefined>
}

/** Blocks kept; the panel needs two, the rest wait for their probe. */
const KEEP_BLOCKS = 6

/**
 * Round completion: the sequencer publishes a round's messages together, so a round is complete as soon as a
 * message for a different (block, round) arrives, or after `quietMs` without a message, whichever is first. A block is
 * complete when it is visible on the RPC (the pending round of that block is then flushed at once, without waiting for the
 * quiet period) or when a row of a later block arrives.
 * The table is printed at that moment; the timing line follows as soon as the block is visible on the RPC
 * (one probe per block, started with the block's first feed message), so a timing line can appear after the next table. It names
 * its block, so it is never ambiguous. In line mode the FF lead of every row follows the timing line, one line per row.
 */
export class LiveRounds {
  private pending: LiveRow[] = []
  private timer: NodeJS.Timeout | undefined
  private readonly measuring = new Set<Promise<void>>()
  private readonly blockStates = new Map<number, BlockState>()
  private blocksCount = 0
  private rounds = 0
  private lineOutput = true
  private readonly out: (line: string) => void
  private readonly footer: () => void
  private readonly quietMs: number
  private readonly footerEvery: number

  constructor(private readonly o: LiveOptions) {
    this.out = o.out ?? plain
    // The footer is a NOTE: coloured through note() unless the caller captures lines with its own `out`.
    this.footer = o.out ? () => o.out!(FOOTER) : () => note(FOOTER)
    this.quietMs = o.quietMs ?? 300
    this.footerEvery = o.footerEvery ?? 10
  }

  /** Line output on (default): tables, timing lines and FF lead lines go to `out`. Off (a panel draws instead): events only. Rounds flushed while off never print lines later. */
  setLineOutput(on: boolean): void {
    this.lineOutput = on
  }

  /** How many different blocks have had a row so far. */
  blocksSeen(): number {
    return this.blocksCount
  }

  /** The two newest blocks: the open one and the one before it. */
  panelBlocks(): { open?: BlockView; previous?: BlockView } {
    const sorted = [...this.blockStates.values()].sort((a, b) => b.blockNumber - a.blockNumber)
    return { open: sorted[0], previous: sorted[1] }
  }

  /** The block's state, if still kept. */
  block(n: number): BlockView | undefined {
    return this.blockStates.get(n)
  }

  push(row: LiveRow): void {
    let b = this.blockStates.get(row.blockNumber)
    if (!b) {
      const created: BlockState = { blockNumber: row.blockNumber, rows: [], firstReceivedAt: row.receivedAt, complete: false, probe: Promise.resolve(undefined) }
      for (const o of this.blockStates.values()) if (o.blockNumber < row.blockNumber) o.complete = true // the sequencer is past them
      // The probe starts with the block's first row, not at flush time, so Y is not clamped to the quiet period.
      created.probe = waitBlockVisible(this.o.rpcUrl, row.blockNumber, this.o.visibilityDeadlineMs ?? 60_000, 200, this.o.isPaused).then((seenAt) => {
        this.blockResolved(created, seenAt)
        return seenAt
      })
      this.blockStates.set(row.blockNumber, created)
      this.blocksCount++
      this.prune()
      b = created
    }
    if (this.pending.length > 0 && groupKey(this.pending[0]!) !== groupKey(row)) this.flush()
    b.rows.push(row)
    b.rows.sort((x, y) => x.txIndex - y.txIndex)
    this.o.onRow?.(row, b)
    this.pending.push(row)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.quietMs)
  }

  private prune(): void {
    const sorted = [...this.blockStates.values()].sort((a, b) => b.blockNumber - a.blockNumber)
    for (const old of sorted.slice(KEEP_BLOCKS)) if (old.visibleAt !== undefined || old.gaveUp) this.blockStates.delete(old.blockNumber)
  }

  private blockResolved(b: BlockState, seenAt: number | undefined): void {
    b.complete = true
    if (seenAt === undefined) {
      if (b.visibleAt === undefined) b.gaveUp = true
    } else b.visibleAt = b.visibleAt === undefined ? seenAt : Math.min(b.visibleAt, seenAt) // `markVisible` may have seen it earlier
    // Block-aware completion: a visible block needs no more waiting for quiet; its pending round is flushed now.
    if (this.pending.length > 0 && this.pending[0]!.blockNumber === b.blockNumber) this.flush()
    this.o.onBlockVisible?.(b)
  }

  /**
   * A caller's own, earlier sighting of the block on the RPC (the demo's 25 ms probe): the view keeps the earlier of the two times, so the
   * panel's FF lead column and the caller's own table show the same figure. Unknown blocks are ignored.
   */
  markVisible(blockNumber: number, atMs: number): void {
    const b = this.blockStates.get(blockNumber)
    if (!b || (b.visibleAt !== undefined && b.visibleAt <= atMs)) return
    b.visibleAt = atMs
    b.gaveUp = false
    b.complete = true
  }

  /** Print the pending round now (if any). Its timing line follows once the (already running) probe has an answer. */
  flush(): void {
    clearTimeout(this.timer)
    if (this.pending.length === 0) return
    const [group] = groupRows(this.pending)
    const block = this.blockStates.get(this.pending[0]!.blockNumber)
    this.pending = []
    if (!group || !block) return
    const printed = this.lineOutput
    const probe = block.probe
    const report: RoundReport = { group, table: formatTable(group, { mine: this.o.mine, bold: this.o.bold }) }
    if (printed) for (const l of report.table) this.out(l)
    this.o.onTable?.(report)
    this.rounds++
    if (printed && this.footerEvery > 0 && this.rounds % this.footerEvery === 0) this.footer()
    const first = group.rows[0]!
    // Attached after the table was printed: even a probe that finished first prints its line after the table.
    const p = probe.then((seenAt) => {
      report.timing = {
        pgaRound: group.pgaRound,
        blockNumber: group.blockNumber,
        leadMs: leadMs(first),
        visibleMs: seenAt === undefined ? undefined : seenAt - first.receivedAt,
      }
      report.timingLine = formatTimingLine(report.timing)
      if (printed) this.out(report.timingLine)
      if (seenAt !== undefined) {
        report.leads = group.rows.map((row) => ({ row, leadMs: ffLeadMs(row.receivedAt, seenAt) }))
        if (printed) {
          const byHash = new Map(report.leads.map((x) => [x.row.hash + x.row.txIndex, x.leadMs]))
          for (const l of formatLeadLines(group, (r) => byHash.get(r.hash + r.txIndex) ?? 0, { mine: this.o.mine, k: this.o.roundsPerBlock, bold: this.o.bold })) this.out(l)
        }
      }
      this.o.onTiming?.(report)
    })
    this.measuring.add(p)
    void p.finally(() => this.measuring.delete(p))
  }

  /**
   * E2: move every timestamp the view holds (a row's `receivedAt`, a block's `firstReceivedAt`) through `f`. The demo calls it after a
   * simulator pause with "a pause of N ms ended now": rows received before it are moved N ms later, so that `visible - receivedAt`
   * (the FF lead) never contains time the simulator stood still. Rows are mutated in place (the demo's own list shares them).
   */
  retime(f: (t: number) => number): void {
    const seen = new Set<LiveRow>()
    const one = (r: LiveRow) => {
      if (seen.has(r)) return
      seen.add(r)
      r.receivedAt = f(r.receivedAt)
    }
    for (const b of this.blockStates.values()) {
      b.firstReceivedAt = f(b.firstReceivedAt)
      b.rows.forEach(one)
    }
    this.pending.forEach(one)
  }

  /** Flush, then wait for the timing lines still being measured. */
  async drain(): Promise<void> {
    this.flush()
    await Promise.all([...this.measuring])
  }

  /** The exit message: flush the pending round, give its timing line up to `waitMs` to arrive, then print the footer. */
  async finish(waitMs = 3000): Promise<void> {
    this.flush()
    const t = new Promise<void>((r) => setTimeout(r, waitMs).unref())
    await Promise.race([this.drain(), t])
    this.footer()
  }
}
