// C8/E3: chapter 4 of the demo, pure parts. A tx sent after seeing round 1 of an open block lands in round 2 of the SAME block, in the
// middle of it (E3: the simulator holds the block's round 2 open while the demo sends). Everything here is a pure function of what the demo observed (feed rows, `sim_arrivals`, probe times):
//   judgeRound2Injection   the chapter's verdict (PASS only on the observed effect)
//   formatRound2Lesson   the two highlighted sentences after the block
//   formatTimingTable      arrived at the sequencer (simulator-only) / seen on the Fast Feed / block finished, per tx
//   formatFcfsComparison   the real PGA order of round 2 next to a hypothetical first-come-first-served order
// Every line is at most 80 columns. Docs: combo/README.md "Chapter 4", pga/README.md "K rounds per block".
import { formatGwei, type Address, type Hex } from 'viem'
import { fmtGwei, shortAddr, type LiveRow } from '../fast-feed/client/live.ts'
import type { Verdict } from '../shared/narrate.ts'
import { wrapText } from './scenarios.ts'

export const WIDTH = 80

/** A printed line and its palette kind: `note` lines start with `NOTE:`, `important` lines are highlighted, `plain` is data. */
export interface OutLine {
  text: string
  kind: 'plain' | 'note' | 'important'
}

/** `sim_arrivals` record: when the sequencer received a tx (local simulator data, Arbitrum does not publish it). */
export interface ArrivalRec {
  hash: Hex
  from: Address
  arrivedAtMs: number
  tipWei: bigint
  txIndex: number
}

/** Pure: parse the `sim_arrivals` JSON (tipWei is a 0x quantity). Malformed entries are skipped. */
export function parseArrivals(raw: unknown): ArrivalRec[] {
  if (!Array.isArray(raw)) return []
  const out: ArrivalRec[] = []
  for (const e of raw as Record<string, unknown>[]) {
    if (typeof e?.hash !== 'string' || typeof e.from !== 'string' || typeof e.arrivedAtMs !== 'number' || typeof e.tipWei !== 'string') continue
    out.push({ hash: e.hash as Hex, from: e.from as Address, arrivedAtMs: e.arrivedAtMs, tipWei: BigInt(e.tipWei), txIndex: Number(e.txIndex ?? 0) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const lc = (s: string) => s.toLowerCase()
/** `0x1a2b3c`: the 0x prefix and the first 6 hex digits. */
export const shortHash = (h: string): string => h.slice(0, 8)

/** Pure: `+12ms` / `-3ms` (an offset). */
export const fmtOff = (ms: number): string => `${ms < 0 ? '-' : '+'}${Math.abs(Math.round(ms))}ms`

const fit = (s: string, width = WIDTH): string => (s.length <= width ? s : `${s.slice(0, width - 1)}…`)

// ---------------------------------------------------------------------------
// E3: the story lines of chapter 4 (block header, round header, the slowed-down NOTE, the sealed line)
// ---------------------------------------------------------------------------

/** Arbitrum One's block time (its round time is this over K: 125 ms with two PGA rounds per block). */
export const ARBITRUM_BLOCK_MS = 250

/** Pure: a duration with a space before the unit: `250 ms`, `2 s`, `12.5 s`. */
export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(2))} s` : `${Number(ms.toFixed(1))} ms`
}

const here = (localMs: number, arbitrumMs: number): string => (localMs === arbitrumMs ? 'here: the same' : `here ${fmtMs(localMs)}`)

/** Pure: `block 17 — 250 ms on Arbitrum One (here 2 s)`. The local value comes from the running config. */
export function blockHeaderLine(block: number, blockMs: number): string {
  return `block ${block} — ${fmtMs(ARBITRUM_BLOCK_MS)} on Arbitrum One (${here(blockMs, ARBITRUM_BLOCK_MS)})`
}

/** Pure: `round 1 — 125 ms on Arbitrum One (here 1 s)`; Arbitrum One's round is its block time over K. */
export function roundHeaderLine(round: number, k: number, roundMs: number): string {
  return `round ${round} — ${fmtMs(ARBITRUM_BLOCK_MS / k)} on Arbitrum One (${here(roundMs, ARBITRUM_BLOCK_MS / k)})`
}

/** The presenter's sentence at the hold (printed as a NOTE). */
export const SLOWED_NOTE = 'Process slowed down for the demo: inserting a transaction with a bigger tip in round 2'

/** Pure: the line printed when the block is visible on the RPC (it was ordered and executed by the sequencer before that). */
export function sealedLine(block: number): string {
  return `block ${block} ordered and executed by the sequencer (sealed, visible on the RPC)`
}

const noteOf = (text: string): OutLine[] => wrapText(`NOTE: ${text.replace(/^\s*NOTE:\s*/, '')}`, WIDTH, '      ').map((t) => ({ text: t, kind: 'note' as const }))
const importantOf = (text: string): OutLine[] => wrapText(text, WIDTH).map((t) => ({ text: t, kind: 'important' as const }))

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWYZ' // no X: X is always "your tx"

/** How many txs per group get a letter: round 1 A-C, round 2 D-E, the round X really landed in (a third group) the next two. */
const GROUP_LETTERS = [3, 2, 2] as const

/**
 * Pure: the letters of the txs the explainer and the tables name. Round 1's first three txs get A, B, C; round 2's first two
 * others the next letters (D, E); then the first two others of the round X really landed in, when that is a third group. In round 2
 * and the third group the demo's own `competitors` come first, so D and E are the competitors the audience was told about.
 * X is always `X`. Txs with no letter are shown by hash only.
 */
export function labelTxs(round1: readonly string[], round2: readonly string[], xHash: string | undefined, xRound: readonly string[] = [], competitors: readonly string[] = []): Map<string, string> {
  const labels = new Map<string, string>()
  if (xHash !== undefined) labels.set(lc(xHash), 'X')
  const comp = new Set(competitors.map(lc))
  let n = 0
  ;[round1, round2, xRound].forEach((group, gi) => {
    const ordered = gi === 0 ? group : [...group.filter((h) => comp.has(lc(h))), ...group.filter((h) => !comp.has(lc(h)))]
    let shown = 0
    for (const h of ordered) {
      if (labels.has(lc(h))) continue
      if (shown >= GROUP_LETTERS[gi]! || n >= LETTERS.length) break
      labels.set(lc(h), LETTERS[n++]!)
      shown++
    }
  })
  return labels
}

/** `A 0x1a2b3c`, or just the hash for an unlettered tx; ` (c)` marks a competitor the demo sent just before X. */
const labelOf = (labels: ReadonlyMap<string, string>, hash: string, competitors?: ReadonlySet<string>): string => {
  const l = labels.get(lc(hash))
  return `${l ? `${l} ${shortHash(hash)}` : shortHash(hash)}${competitors?.has(lc(hash)) ? ' (c)' : ''}`
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export const FIFO_FAILURE = 'the running simulator orders by arrival (FIFO); restart without --fifo to see PGA'

/** Pure: a row's position WITHIN its round (0-based). `tx_index` counts block-wide, so in round 2 it is not the position in the round. */
export function indexWithinRound(rows: readonly { txIndex: number }[], row: { txIndex: number }): number {
  return rows.filter((x) => x.txIndex < row.txIndex).length
}

export interface Round2Input {
  ordering: 'pga' | 'fifo'
  /** The block whose round 1 the presenter saw: the tx was aimed at round 2 of this block. */
  targetBlock: number
  /** Where the tx landed. */
  block: number
  round?: number
  /** Position within its round (0 = first) and how many OTHER txs were in that round. */
  indexInRound: number
  competitors: number
  /** Block visible on the RPC minus feed receipt of our tx, ms (undefined = never seen). */
  leadMs?: number
  tipGwei: string
}

export interface Round2Judgement {
  verdict: Verdict
  /** PGA was observed putting us first in round 2 of the target block (a PGA stack, competitors present, index 0). */
  observed: boolean
  lines: string[]
  /** Why the chapter did not pass (also for INCONCLUSIVE: the reason, retried once by the caller). */
  failure?: string
}

/** Pure: "block 17, round 2, first in its round (tip 1 gwei)": the highlighted line. */
export function yourTxLine(i: { block: number; round?: number; indexInRound: number; inRound: number; tipGwei: string }): string {
  const pos = i.indexInRound === 0 ? 'first in its round' : `position ${i.indexInRound + 1} of ${i.inRound} in its round`
  return `YOUR TX: block ${i.block}, round ${i.round ?? '?'}, ${pos} (tip ${i.tipGwei} gwei)`
}

/**
 * Pure: chapter 4's verdict. PASS needs: a PGA stack, the same block as the observed round 1, round 2, at least one competitor
 * in round 2, first in the round, and a positive feed lead. FIFO fails by name. A tx that landed in another round or block
 * (timing) is INCONCLUSIVE (the caller retries once); first-in-round missing is a FAIL.
 */
export function judgeRound2Injection(i: Round2Input): Round2Judgement {
  const where = `round ${i.round ?? '?'} of block ${i.block}`
  if (i.ordering === 'fifo') {
    return {
      verdict: 'FAIL',
      observed: false,
      lines: [`This stack orders by arrival (FIFO), so index ${i.indexInRound} shows arrival, not the tip: PGA was not observed.`],
      failure: FIFO_FAILURE,
    }
  }
  if (i.block !== i.targetBlock || i.round !== 2) {
    const reason =
      i.block === i.targetBlock
        ? `our tx landed in ${where}, not round 2 of block ${i.targetBlock}: it was sent before round 1 was ordered`
        : `our tx landed in ${where}, not in round 2 of block ${i.targetBlock} (the block whose round 1 we saw): it missed the round by timing`
    return { verdict: 'INCONCLUSIVE', observed: false, lines: [], failure: reason }
  }
  if (i.competitors === 0) {
    return { verdict: 'INCONCLUSIVE', observed: false, lines: [], failure: `round 2 of block ${i.block} held only our tx, so the tip competed with nothing` }
  }
  if (i.indexInRound !== 0) {
    return { verdict: 'FAIL', observed: false, lines: [], failure: `our ${i.tipGwei} gwei transaction is at index ${i.indexInRound}, not index 0, of round 2: PGA did not put it first (see the table above)` }
  }
  const lines = [`PGA put us first in round 2 of block ${i.block} (index 0 of ${i.competitors + 1} txs in the round).`]
  if (i.leadMs === undefined) return { verdict: 'INCONCLUSIVE', observed: true, lines, failure: `block ${i.block} was not visible on the RPC within the wait, so the feed lead could not be measured` }
  if (i.leadMs <= 0) return { verdict: 'INCONCLUSIVE', observed: true, lines, failure: `the measured feed lead was ${i.leadMs}ms (not positive): the feed did not show the round before its block was visible` }
  lines.push(`The Fast Feed showed it ${i.leadMs}ms before block ${i.block} was visible.`)
  return { verdict: 'PASS', observed: true, lines }
}

/** Pure: `A`, `A and B`, `A, B and C`, `A, B, C and 4 more`: `names` are the shown ones, `total` the real count. */
function nameList(names: readonly string[], total: number): string {
  const more = total - names.length
  if (names.length === 0) return 'nothing'
  const head = names.length === 1 ? names[0]! : more > 0 ? names.join(', ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return more > 0 ? `${head} and ${more} more` : head
}

// ---------------------------------------------------------------------------
// The timing table
// ---------------------------------------------------------------------------

export interface TableOpts {
  /** The round 1 start of the block, wall-clock ms: every time is printed as an offset from it. */
  originMs: number
  /** Lower-case addresses that are "yours". */
  mine?: ReadonlySet<string>
  labels?: ReadonlyMap<string, string>
  /** Lower-case hashes of the competitor txs the demo sent just before X: marked `(c)`. */
  competitors?: ReadonlySet<string>
  /** Most rows printed (yours and every round-2 row are kept; the rest of round 1 is elided). */
  maxRows?: number
}

const isMineRow = (r: LiveRow, mine?: ReadonlySet<string>) => r.from !== null && (mine?.has(lc(r.from)) ?? false)

/** Pure: when there are more than `max` rows: every row that `keep` wants (yours, the lettered ones), then the first others, in original order. */
function pickKeep<T>(rows: readonly T[], keep: (r: T) => boolean, max: number): { shown: T[]; hidden: number } {
  if (rows.length <= max) return { shown: [...rows], hidden: 0 }
  const chosen = new Set<T>(rows.filter(keep).slice(0, max))
  for (const r of rows) if (chosen.size < max) chosen.add(r)
  const shown = rows.filter((r) => chosen.has(r))
  return { shown, hidden: rows.length - shown.length }
}

/** Pure: a plain table with right-aligned numbers: two spaces between columns, one when that is what keeps it within `WIDTH`. */
function table(head: string[], body: string[][], prefixes: string[]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)))
  const build = (gap: number) => {
    const line = (cells: string[], prefix: string) => `${prefix}${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join(' '.repeat(gap))}`.trimEnd()
    return [line(head, '   '), ...body.map((r, i) => line(r, prefixes[i]!))]
  }
  const wide = build(2)
  return Math.max(...wide.map((l) => l.length)) <= WIDTH ? wide : build(1)
}

/**
 * Pure: the timing table of one block, one row per tx: when the sequencer received it (simulator-only), when our Fast Feed
 * connection received it, and when the block became visible on a direct read of the sequencer RPC, each as an offset from round
 * 1's start. `FF lead` = block finished − seen on FF; `wait` = seen on FF − arrived.
 */
export function formatTimingTable(rows: readonly LiveRow[], arrivals: readonly ArrivalRec[], blockVisibleAt: number | undefined, o: TableOpts): OutLine[] {
  const arrived = new Map(arrivals.map((a) => [lc(a.hash), a.arrivedAtMs]))
  const sorted = [...rows].sort((a, b) => a.txIndex - b.txIndex)
  const block = sorted[0]?.blockNumber
  const labels = o.labels ?? new Map<string, string>()
  const { shown, hidden } = pickKeep(sorted, (r) => isMineRow(r, o.mine) || labels.has(lc(r.hash)) || (o.competitors?.has(lc(r.hash)) ?? false), o.maxRows ?? 16)
  const off = (t: number | undefined) => (t === undefined ? '?' : fmtOff(t - o.originMs))
  const body = shown.map((r) => {
    const a = arrived.get(lc(r.hash))
    return [
      labelOf(labels, r.hash, o.competitors),
      String(r.pgaRound ?? '-'),
      String(r.txIndex),
      off(a),
      off(r.receivedAt),
      off(blockVisibleAt),
      blockVisibleAt === undefined ? '?' : fmtOff(blockVisibleAt - r.receivedAt),
      a === undefined ? '?' : fmtOff(r.receivedAt - a),
    ]
  })
  const lines: OutLine[] = [{ text: fit(`timing of block ${block ?? '?'}: ms after round 1 started, one row per tx`), kind: 'plain' }]
  const t = table(['tx', 'rnd', 'idx', 'arrived*', 'seen on FF', 'block done', 'FF lead', 'wait'], body, shown.map((r) => (isMineRow(r, o.mine) ? '>> ' : '   ')))
  t.forEach((l) => lines.push({ text: l, kind: 'plain' }))
  if (hidden > 0) lines.push({ text: `   ... ${hidden} more tx${hidden === 1 ? '' : 's'} not shown`, kind: 'plain' })
  const hasComp = shown.some((r) => o.competitors?.has(lc(r.hash)))
  lines.push(...noteOf(`* arrived = simulator-only data (sim_arrivals).${hasComp ? ' (c) = competitor sent just before X.' : ''}`))
  return lines
}

// ---------------------------------------------------------------------------
// F1: the race's block as seen with and without Fast Feed
// ---------------------------------------------------------------------------

export const FF_HEADING = 'WHAT I SEE WITH FAST FEED'
export const NO_FF_HEADING = 'WHAT OTHERS SEE WITHOUT FAST FEED'
/** Terminal width from which the two views are drawn side by side. */
export const SIDE_BY_SIDE_MIN = 160
/** Width of the left column when side by side (the right one gets up to `WIDTH`; 4 spaces between). */
const LEFT_COL = 76

export interface BlockComparisonInput {
  /** Feed rows of the block (any order). */
  rows: readonly LiveRow[]
  /** Wall-clock ms the block became visible on the RPC; undefined = not measured. */
  visibleAt: number | undefined
  block: number
  blockMs: number
  k: number
  roundMs: number
  /** Lower-case addresses marked `<- yours` / `<- rival`. */
  mine: ReadonlySet<string>
  rival: ReadonlySet<string>
  /** process.stdout.columns, undefined when not a terminal. */
  columns: number | undefined
}

/** Pure: the time gained on a user without Fast Feed, always printed negative: `-12.61s` (`0.00s` for none). */
export function fmtGain(leadMs: number): string {
  const s = Math.max(0, leadMs) / 1000
  return s === 0 ? '0.00s' : `-${s.toFixed(2)}s`
}

/** Pure: one skip NOTE (the comparison never changes a verdict). */
export function comparisonSkipNote(reason: string): OutLine[] {
  return noteOf(`Comparison with and without Fast Feed skipped: ${reason}.`)
}

/** Pure: a table of columns, first column left-aligned, the rest right-aligned, with a trailing marker per row. */
function viewTable(head: string[], body: string[][], marks: string[]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)))
  const cells = (c: string[]) => c.map((x, i) => (i === 0 ? x.padEnd(widths[i]!) : x.padStart(widths[i]!))).join('  ')
  return [`   ${cells(head)}`.trimEnd(), ...body.map((r, i) => `   ${cells(r)}${marks[i]}`)]
}

/**
 * Pure: the race's own block twice. Left: with Fast Feed, per round (round header, index/from/tip and the time gained versus
 * no Fast Feed = -(block visible on the RPC - feed receivedAt)). Right: the sealed block as the RPC shows it, one table in final
 * order, no rounds, no gain. Side by side from 160 columns, else stacked (left first). Without rows or a visible time: one NOTE.
 */
export function formatBlockComparison(i: BlockComparisonInput): OutLine[] {
  const rows = [...i.rows].filter((r) => r.blockNumber === i.block).sort((a, b) => a.txIndex - b.txIndex)
  if (rows.length === 0) return comparisonSkipNote(`the Fast Feed connection saw no transactions of block ${i.block}`)
  if (i.visibleAt === undefined) return comparisonSkipNote(`block ${i.block} was not seen on the RPC, so the time gained cannot be measured`)
  const visibleAt = i.visibleAt
  const mark = (r: LiveRow) => (r.from !== null && i.mine.has(lc(r.from)) ? '  <- yours' : r.from !== null && i.rival.has(lc(r.from)) ? '  <- rival' : '')
  const from = (r: LiveRow) => (r.from ? shortAddr(r.from) : '(undecodable)')
  const header = blockHeaderLine(i.block, i.blockMs)

  const left: string[] = [header]
  const rounds = [...new Set(rows.map((r) => r.pgaRound ?? 1))].sort((a, b) => a - b)
  rounds.forEach((rd, n) => {
    const rr = rows.filter((r) => (r.pgaRound ?? 1) === rd)
    if (n > 0) left.push('')
    left.push(`${roundHeaderLine(rd, i.k, i.roundMs)} · ${rr.length} tx${rr.length === 1 ? '' : 's'}`)
    left.push(...viewTable(['idx', 'from', 'tip', 'vs no FF'], rr.map((r) => [String(r.txIndex), from(r), fmtGwei(r.effectiveTip), fmtGain(visibleAt - r.receivedAt)]), rr.map(mark)))
  })
  const right: string[] = [header, ...viewTable(['idx', 'from', 'tip'], rows.map((r) => [String(r.txIndex), from(r), fmtGwei(r.effectiveTip)]), rows.map(mark))]

  const out: OutLine[] = []
  if (i.columns !== undefined && i.columns >= SIDE_BY_SIDE_MIN) {
    const cut = (s: string, w: number) => (s.length <= w ? s : `${s.slice(0, w - 1)}…`)
    const l = [FF_HEADING, ...left]
    const r = [NO_FF_HEADING, ...right]
    for (let j = 0; j < Math.max(l.length, r.length); j++) {
      out.push({ text: `${cut(l[j] ?? '', LEFT_COL).padEnd(LEFT_COL)}    ${cut(r[j] ?? '', WIDTH)}`.trimEnd(), kind: 'plain' })
    }
  } else {
    out.push({ text: FF_HEADING, kind: 'important' }, ...left.map((t) => ({ text: fit(t), kind: 'plain' as const })))
    out.push({ text: '', kind: 'plain' }, { text: NO_FF_HEADING, kind: 'important' }, ...right.map((t) => ({ text: fit(t), kind: 'plain' as const })))
  }
  return out
}

// ---------------------------------------------------------------------------
// PGA vs hypothetical FCFS
// ---------------------------------------------------------------------------

export interface FcfsResult {
  lines: OutLine[]
  /** 1-based positions of the first mine row under PGA (real) and under FCFS; undefined when there is none. */
  pgaPosition?: number
  fcfsPosition?: number
}

/**
 * Pure: the real PGA order of one round next to the same txs ordered by arrival at the sequencer (a hypothetical
 * first-come-first-served order), with the gap between consecutive arrivals and where your tx would have landed.
 * `pgaRows` is the round's rows in real order. Rows with no arrival record go last in the FCFS column, marked "(no arrival data)".
 */
export function formatFcfsComparison(pgaRows: readonly LiveRow[], arrivals: readonly ArrivalRec[], o: TableOpts & { block?: number; round?: number; ordering?: 'pga' | 'fifo' }): FcfsResult {
  const fifo = o.ordering === 'fifo'
  const realHead = fifo ? 'real FIFO order (by arrival)' : 'real PGA order (by tip)'
  const arrived = new Map(arrivals.map((a) => [lc(a.hash), a.arrivedAtMs]))
  const labels = o.labels ?? new Map<string, string>()
  const at = (r: LiveRow) => arrived.get(lc(r.hash))
  const fcfs = pgaRows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (at(a.r) ?? Infinity) - (at(b.r) ?? Infinity) || a.i - b.i)
    .map((x) => x.r)
  const first = pgaRows[0]
  const title = `hypothetical FCFS (local simulator data): round ${o.round ?? first?.pgaRound ?? '?'} of block ${o.block ?? first?.blockNumber ?? '?'}`
  const mark = (r: LiveRow) => (isMineRow(r, o.mine) ? ' <- yours' : '')
  const left = pgaRows.map((r, i) => `${i + 1}. ${labelOf(labels, r.hash, o.competitors)}  ${formatGwei(r.effectiveTip)} gwei${mark(r)}`)
  let prev: number | undefined
  const right = fcfs.map((r, i) => {
    const a = at(r)
    const gap = a === undefined ? 'no arrival data' : prev === undefined ? 'first' : `+${Math.round(a - prev)}ms`
    if (a !== undefined) prev = a
    return `${i + 1}. ${labelOf(labels, r.hash, o.competitors)} ${a === undefined ? '' : `${fmtOff(a - o.originMs)} `}(${gap})${mark(r)}`
  })
  const lw = Math.max(realHead.length, ...left.map((l) => l.length))
  const rows = Math.max(left.length, right.length)
  const shownRows = o.maxRows !== undefined ? Math.min(rows, o.maxRows) : rows
  const lines: OutLine[] = [{ text: fit(title), kind: 'plain' }]
  lines.push({ text: fit(`${realHead.padEnd(lw)}  FCFS order (by arrival; gap to the previous)`), kind: 'plain' })
  for (let i = 0; i < shownRows; i++) lines.push({ text: fit(`${(left[i] ?? '').padEnd(lw)}  ${right[i] ?? ''}`.trimEnd()), kind: 'plain' })
  if (shownRows < rows) lines.push({ text: `   ... ${rows - shownRows} more tx${rows - shownRows === 1 ? '' : 's'} not shown`, kind: 'plain' })
  const mineIdx = pgaRows.findIndex((r) => isMineRow(r, o.mine))
  const result: FcfsResult = { lines }
  if (mineIdx >= 0) {
    const me = pgaRows[mineIdx]!
    result.pgaPosition = mineIdx + 1
    const ma = at(me)
    const realText = `position ${mineIdx + 1} of ${pgaRows.length} ${fifo ? 'in the real FIFO order' : 'with PGA (the tip decided)'}`
    if (ma === undefined) {
      // No arrival record for our tx: never claim an FCFS position without data.
      lines.push(...noteOf(`Your tx: ${realText}.`))
      lines.push(...noteOf('arrival data was unavailable for your tx (sim_arrivals had no record), so its FCFS position is not shown.'))
    } else {
      const fcfsIdx = fcfs.indexOf(me)
      result.fcfsPosition = fcfsIdx + 1
      const before = fcfs[fcfsIdx - 1]
      const gapText = before !== undefined && at(before) !== undefined ? ` (it arrived ${Math.round(ma - at(before)!)}ms after the previous tx)` : ''
      const verdict = fcfsIdx === mineIdx ? `the same position under FCFS${gapText}` : `position ${fcfsIdx + 1} under FCFS${gapText}`
      lines.push(...noteOf(`Your tx: ${realText}; ${verdict}.`))
    }
  }
  lines.push(...noteOf('Under FCFS arrival (latency) decides; under PGA the tip does.'))
  return result
}

// ---------------------------------------------------------------------------
// E3: the two lessons after the block (short)
// ---------------------------------------------------------------------------

/**
 * Pure: at most two highlighted sentences, only when X was observed in round 2 of the block: round 1 was already final, and round 2 was
 * competed blind (by tip on a PGA stack, by arrival on FIFO). `round1`/`round2` are the other txs' letters shown and their real counts.
 */
export function formatRound2Lesson(i: { ordering: 'pga' | 'fifo'; inRound2: boolean; round1: readonly string[]; round1Total: number; round2: readonly string[]; round2Total: number }): OutLine[] {
  if (!i.inRound2) return []
  const out: OutLine[] = []
  if (i.round1Total > 0) {
    const one = i.round1Total === 1
    out.push(...importantOf(`${nameList(i.round1, i.round1Total)} ${one ? 'was' : 'were'} already final when you sent X: nothing you send goes before ${one ? 'it' : 'them'}.`))
  }
  if (i.round2Total === 0) out.push(...importantOf(`X had no competitors in round 2, so ${i.ordering === 'fifo' ? 'arrival' : 'the tip'} decided nothing there.`))
  else out.push(...importantOf(`In round 2 you competed blind: X was ${i.ordering === 'fifo' ? `ordered by arrival among ${nameList(i.round2, i.round2Total)}, not by tip (FIFO)` : `ranked by tip against ${nameList(i.round2, i.round2Total)}`}.`))
  return out
}
