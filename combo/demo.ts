// `npm run demo -- --local [--pause] [--preset slow|fast]`: the whole workshop story in one narrated run, in 6 chapters.
// This file is glue: it only calls existing modules (config and banner, key.ts, the ticket helpers race.ts uses, the live
// view and feed client, the traffic generator, `presign`, and the C2 race runner and judge) and adds narration.
// Concepts: README "Run the full demo"; each chapter prints the one doc section that covers it.
//
// Exit codes: 0 every chapter observed what it expected; 1 a chapter observed a failure (named); 2 usage;
// 3 the race was inconclusive after its retry (and nothing else failed).
import type { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, keccak256, parseGwei, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ANVIL_ACCOUNT_MAP, anvilDevKey, blockMsOverride, ConfigError, feedApiKey, getPreset, loadDotEnv, resolvePreset, TRAFFIC_ACCOUNT_INDEXES, type LocalParams, type Preset } from '../shared/config.ts'
import { connectFeed, FeedRejectedError, rejectionLines, closeLines, type FeedClient, type FeedMessageJson } from '../fast-feed/client/client.ts'
import { generateKey } from '../fast-feed/client/key.ts'
import { decodeLiveRow, FOOTER, fmtGwei, formatPanel, formatTable, groupRows, LiveRounds, myAddresses, shortAddr, waitBlockVisible, type LiveOptions, type LiveRow } from '../fast-feed/client/live.ts'
import { chainNowMs, freezeChainClock, setChainClock, thawChainClock } from '../shared/clock.ts'
import { colorEnabled, error, important, note, noteLines, plain, result, step, style } from '../shared/narrate.ts'
import { DEAD, gwei, sleep, type Verdict } from '../pga/bot/common.ts'
import { presign } from '../pga/bot/tx.ts'
import {
  FIFO_FAILURE,
  formatFcfsComparison,
  formatTimingTable,
  formatRound2Lesson,
  indexWithinRound,
  judgeRound2Injection,
  labelTxs,
  parseArrivals,
  WIDTH,
  blockHeaderLine,
  formatBlockComparison,
  formatComparisonStage,
  formatSequencerSummary,
  comparisonSkipNote,
  roundHeaderLine,
  sealedLine,
  SLOWED_NOTE,
  yourTxLine,
  type ArrivalRec,
  type BlockComparisonInput,
  type OutLine,
  type Round2Judgement,
} from './round2.ts'
import { RaceStager } from './stages.ts'
import { PACING_NOTE, RowPacer, rowPacingEnabled } from './pacing.ts'
import { newIdentity, buyTickets, currentRoundEnd, readTicketRound, renewDecision, renewTickets, ticketsUsable, type BotIdentity, type TicketSession } from './race.ts'
import {
  DEFAULT_POLL_MS,
  makeRaceContext,
  printTrialReport,
  raceExitCode,
  runTrial,
  runTrialWithRetry,
  SCENARIOS,
  strategyOf,
  noteBlock,
  wrapText,
  whyLine,
  type RaceInput,
  type RaceJudgement,
} from './scenarios.ts'

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in combo/test/demo.test.ts)
// ---------------------------------------------------------------------------

export interface Chapter {
  n: number
  title: string
  /** The one doc section that covers the concept. */
  doc: string
}

export const CHAPTERS: readonly Chapter[] = [
  { n: 1, title: 'What is accelerated here', doc: 'sim/README.md' },
  { n: 2, title: 'Your wallets and a feed key', doc: 'fast-feed/README.md#tickets-and-keys' },
  { n: 3, title: 'A ticket, bought and activated', doc: 'fast-feed/README.md#timing-buy-in-round-n-active-in-round-n1-only' },
  { n: 4, title: 'One block, two rounds: your tip goes first', doc: 'pga/README.md#the-idea' },
  { n: 5, title: 'The race: information and tip', doc: 'combo/README.md#s3-the-headline-information-and-tip' },
  { n: 6, title: 'Recap', doc: 'README.md#run-the-full-demo' },
]

/** The header lines of a chapter: a blank line, the header (printed as an important step) and the doc pointer (printed as a NOTE). */
export function chapterHeader(c: Chapter): string[] {
  return ['', `▶ CHAPTER ${c.n}/${CHAPTERS.length}: ${c.title}`, `Read more: ${c.doc}`]
}

export const USAGE = 'Usage: npm run demo -- --local [--pause] [--preset slow|fast]   (--pause waits for Enter between chapters; --testnet comes with the testnet stage)'
export const TESTNET_REFUSAL =
  'Error: the testnet demo is the testnet stage (C4): needs funded wallets, tickets and `race:deploy -- --testnet`. Nothing was run. Use --local.'

export interface DemoArgs {
  mode: 'local' | 'testnet'
  pause: boolean
}

/** `--local` | `--testnet` (exactly one), `--pause`, `--preset slow|fast` (the value is checked by the preset parser). Anything else is a usage error. */
export function parseDemoArgs(argv: readonly string[]): DemoArgs {
  let local = false
  let testnet = false
  let pause = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--local') local = true
    else if (a === '--testnet') testnet = true
    else if (a === '--pause') pause = true
    else if (a === '--preset') i++ // its value is validated by getPreset
    else if (a.startsWith('--preset=')) continue
    else throw new ConfigError(`Unknown argument "${a}".`)
  }
  if (local && testnet) throw new ConfigError('Pass only one of --local or --testnet, not both.')
  if (!local && !testnet) throw new ConfigError('Missing network flag: pass --local.')
  return { mode: local ? 'local' : 'testnet', pause }
}

export interface PauseOptions {
  pause: boolean
  /** Is stdin a terminal? A pipe or /dev/null has nobody to press Enter: never wait then. */
  isTTY: boolean
  waitEnter: () => Promise<void>
  say: (line: string) => void
}

/** `--pause`: wait for Enter before a chapter, but only on a terminal. Returns whether it waited. */
export async function pauseBefore(o: PauseOptions, c: Chapter): Promise<boolean> {
  if (!o.pause || !o.isTTY) return false
  o.say(`-- press Enter for chapter ${c.n}/${CHAPTERS.length}: ${c.title} --`)
  await o.waitEnter()
  return true
}

/** The one line printed up front when `--pause` cannot be honoured (stdin is not a terminal). */
export const PAUSE_IGNORED = 'NOTE: --pause: stdin is not a terminal, so there is nobody to press Enter: running on without waiting (a terminal stdout gets the timed chapter delay instead).'

/** Pure: after a real `--pause`, what to do with the tickets before a chapter that needs `needMs` more of them. */
export type TicketAction = 'ok' | 'renew' | 'rebuy'
export function postPauseTicketAction(i: { session: TicketSession | undefined; nowMs: number; roundMs: number; needMs: number; blockMs?: number }): TicketAction {
  const { session, nowMs } = i
  if (!session || !ticketsUsable(session, nowMs, 0)) return 'rebuy' // none, or they ran out while paused
  const d = renewDecision({ roundEndMs: currentRoundEnd(session, nowMs, i.roundMs), coveredUntilMs: session.activeUntil, nowMs, trialMs: i.needMs, ...(i.blockMs !== undefined ? { blockMs: i.blockMs } : {}) })
  return d === 'renew' ? 'renew' : d === 'too-late' ? 'rebuy' : 'ok'
}

/**
 * Pure: must the ticket be refreshed before `chapter` even though nobody paused? Chapters 4-5 need ticket time (`chapterNeedMs`);
 * when the session's tickets are about to run out (or already did) the demo renews or rebuys first, whatever the pause state.
 */
export function ticketNeedsRefresh(i: { session: TicketSession | undefined; nowMs: number; roundMs: number; blockMs: number; chapter: number }): boolean {
  if (i.chapter < 4 || i.chapter > 5) return false
  return postPauseTicketAction({ session: i.session, nowMs: i.nowMs, roundMs: i.roundMs, needMs: chapterNeedMs(i.chapter, i.blockMs, i.roundMs), blockMs: i.blockMs }) !== 'ok'
}

/** What happened to the ticket at a pause: none yet, kept, renewed, rebought (with why), or expired and not needed again. */
export type PauseTicketOutcome =
  | { kind: 'none' | 'kept' | 'expired' }
  | { kind: 'renewed'; nextRound: number }
  | { kind: 'rebought'; why: 'expired' | 'too-late' | 'renewal-missed' | 'no-ticket' }

/** Pure: the one line printed after every real Enter: time left in the current ticket round and what became of the ticket. */
export function formatPauseTicketLine(i: { round: number; leftMs: number; outcome: PauseTicketOutcome; realPause?: boolean }): string {
  const left = `${Math.max(0, Math.ceil(i.leftMs / 1000))}s left`
  const o = i.outcome
  const why = { expired: i.realPause === false ? 'expired since the last chapter' : 'expired during the pause', 'too-late': 'too little of the round was left to renew', 'renewal-missed': 'the renewal did not land in time', 'no-ticket': 'there was no ticket' }
  let what: string
  if (o.kind === 'renewed') what = `ticket renewed for round ${o.nextRound}`
  else if (o.kind === 'rebought') what = `ticket rebought (${why[o.why]})`
  else what = { none: 'no ticket yet (chapter 3 buys one)', kept: 'ticket kept', expired: 'ticket expired (not needed again)' }[o.kind]
  return `ticket round ${i.round}: ${left} · ${what}`
}

/** Pure: what became of the ticket at a pause, from the action taken and whether a renewal (if tried) landed. */
export function pauseTicketOutcome(i: { action: TicketAction; renewed: boolean; why: 'expired' | 'too-late' | 'no-ticket'; nextRound: number }): PauseTicketOutcome {
  if (i.action === 'ok') return { kind: 'kept' }
  if (i.action === 'renew' && i.renewed) return { kind: 'renewed', nextRound: i.nextRound }
  return { kind: 'rebought', why: i.action === 'renew' ? 'renewal-missed' : i.why }
}

/** Pure: why a rebuy was needed, from the session as it stood after the pause. */
export function rebuyReason(session: TicketSession | undefined, nowMs: number): 'expired' | 'too-late' | 'no-ticket' {
  return !session ? 'no-ticket' : ticketsUsable(session, nowMs, 0) ? 'too-late' : 'expired'
}

/** Pure: "14:03:07Z", UTC like every other timestamp the demo prints (fmtWhen, the live header). */
export const clock = (ms: number): string => `${new Date(ms).toISOString().slice(11, 19)}Z`

// ---------------------------------------------------------------------------
// E2: pausing the simulator while the presenter talks (local only), and the clock skip in chapter 3
// ---------------------------------------------------------------------------

/** A stretch of wall time the simulator stood still (`to` undefined: still paused). */
export interface PauseSpan {
  from: number
  to?: number
}

/** Pure: the part of [a, b] covered by the pause spans (an open span runs to b). */
export function pausedOverlapMs(spans: readonly PauseSpan[], a: number, b: number): number {
  let sum = 0
  for (const s of spans) {
    const lo = Math.max(a, s.from)
    const hi = Math.min(b, s.to ?? b)
    if (hi > lo) sum += hi - lo
  }
  return sum
}

/** Pure: the time mapping for one finished pause: a time before it moves later by what is left of the pause after it (a time inside collapses to the end). */
export function retimeForPause(span: { from: number; to: number }): (t: number) => number {
  return (t) => t + Math.max(0, span.to - Math.max(t, span.from))
}

/** Pure: a wall time seen through every finished pause in order: "what the simulator's own clock would have read, anchored at now". */
export function retimeThrough(spans: readonly { from: number; to: number; sendsFrom?: number }[], t: number): number {
  // E3: a time inside a hold's send phase [sendsFrom, to] lands after the resume, in order and with its real gap to the first send.
  return spans.reduce((x, s) => (s.sendsFrom !== undefined && x >= s.sendsFrom && x <= s.to ? s.to + (x - s.sendsFrom) : retimeForPause(s)(x)), t)
}

/**
 * Pure: the origin of a timing table, measured at `measuredAt` (wall), seen through the pauses that came AFTER the measurement. The rows of
 * the block were retimed forward by those pauses (`retimeForPause`), so the origin must move with them; a pause that ended before the
 * measurement is already inside it (the origin was taken from the simulator's own clock minus its elapsed time).
 */
export function originAfterPauses(originMs: number, measuredAt: number, pauses: readonly { from: number; to: number }[]): number {
  return retimeThrough(pauses.filter((p) => p.from >= measuredAt), originMs)
}

export const HOLD_LEASE_MS = 15_000
/** The one NOTE the first time the simulator is paused. */
export const PAUSE_NOTE = 'the simulator is paused while you talk (local only; Arbitrum never pauses): no PGA rounds, no blocks, no traffic, and the ticket clock stands still. It continues in the same ticket round when you press Enter.'
/** F2: the demo (on a stack it owns) skips the clock silently as soon as the purchase has landed, when more than this much of the activation wait remains. */
export const ACTIVATION_SKIP_OVER_MS = 1_000
/** The funding, approve, deposit and purchase of the background flow take about this many blocks (a hard limit: each step needs a mined block). */
export const PURCHASE_BLOCKS = 4

/**
 * Pure: may an Enter prompt freeze the simulator? Not while the background ticket purchase (funding, approve, deposit, purchase: a few
 * blocks) is still in flight: a frozen simulator mines nothing, so chapter 3 would wait out the whole freeze for it. Once it settled, yes.
 */
export function shouldFreezeAtPrompt(i: { hasBackgroundTicket: boolean; backgroundSettled: boolean }): boolean {
  return !i.hasBackgroundTicket || i.backgroundSettled
}

/** `sim_clock` (local only). */
export interface SimClockInfo {
  paused: boolean
  holder: string | null
  armed: boolean
  heldAt: { block: number; round: number } | null
  leaseLeftMs: number
  pausedTotalMs: number
  skippedMs: number
  chainNowMs: number
  pendingSkip: number | null
}

export type SimRpcFn = <T>(method: string, params?: unknown[]) => Promise<T>

/**
 * The demo's hold on the simulator: `sim_pause` at once, a heartbeat every lease/3 (a dead demo never leaves the simulator frozen: the
 * lease runs out), `sim_resume` on release. Pausing refused ("paused by <other>") or missing (an older simulator) is reported, not thrown.
 */
export class SimHold {
  held = false
  private beat: NodeJS.Timeout | undefined
  /** The heartbeat call in flight: `release` awaits it, so a late heartbeat can never arrive after the resume. */
  private inflight: Promise<unknown> | undefined
  constructor(
    private readonly rpc: SimRpcFn,
    readonly holder: string,
    private readonly leaseMs = HOLD_LEASE_MS,
  ) {}

  /** `at: 'now'` pauses at once; `'afterRound1'` (E3) arms a hold that pauses right after the next block's round-1 publish (`info.armed`). */
  async acquire(at: 'now' | 'afterRound1' = 'now'): Promise<{ state: 'paused'; info: SimClockInfo } | { state: 'refused' | 'unsupported'; reason: string }> {
    const args = [{ holder: this.holder, at, leaseMs: this.leaseMs }]
    try {
      const info = await this.rpc<SimClockInfo>('sim_pause', args)
      this.held = true
      // Heartbeats only extend the lease (`heartbeat: true`): they never start a pause or turn an armed hold into one.
      const beatArgs = [{ holder: this.holder, heartbeat: true, leaseMs: this.leaseMs }]
      this.beat = setInterval(() => {
        if (this.inflight) return // one at a time
        const p = this.rpc('sim_pause', beatArgs).catch(() => {})
        this.inflight = p
        void p.finally(() => this.inflight === p && (this.inflight = undefined))
      }, Math.max(1, Math.floor(this.leaseMs / 3)))
      this.beat.unref()
      return { state: 'paused', info }
    } catch (e) {
      const reason = (e as Error).message
      return { state: /paused by/.test(reason) ? 'refused' : 'unsupported', reason }
    }
  }

  /** `sim_resume`; undefined when nothing was held. Throws when the resume call itself failed (the lease will resume the simulator). */
  async release(): Promise<{ resumed: boolean; pausedMs: number; chainNowMs: number } | undefined> {
    clearInterval(this.beat)
    this.beat = undefined
    await this.inflight
    if (!this.held) return undefined
    this.held = false
    return this.rpc('sim_resume', [{ holder: this.holder }])
  }
}

// Chapter 4's pure parts (verdict, story lines, tables) live in ./round2.ts; re-exported for the tests and other callers.
export { FIFO_FAILURE, formatFcfsComparison, formatTimingTable, indexWithinRound, judgeRound2Injection, labelTxs, yourTxLine }

/**
 * The live view's options for the demo. `footerEvery: 0`: the view's periodic footer credits PGA ("rows are sorted by tip.
 * That's PGA"), which is false on a FIFO stack, so the demo prints its own footer once, only on a PGA stack (see `stopLive`).
 */
export function demoLiveOptions(o: Pick<LiveOptions, 'rpcUrl' | 'mine' | 'bold' | 'onTable' | 'onTiming' | 'onRow' | 'onBlockVisible' | 'roundsPerBlock' | 'visibilityDeadlineMs' | 'isPaused'>): LiveOptions {
  return { ...o, footerEvery: 0 }
}

/** Pure: the recap's "what PGA did" line. PGA is credited only when chapter 4 observed it; otherwise it says why not. */
export function pgaRecapLine(i: { observed: boolean; ordering: 'pga' | 'fifo'; tipGwei: string; trafficTipMax: string; failure?: string }): string {
  const docs = 'Docs: pga/README.md#the-idea'
  if (i.observed) return `It sorted round 2 by tip: our ${i.tipGwei} gwei transaction, sent after we saw round 1, was first in round 2 of its block, ahead of the lower-tip competitors (up to ${i.trafficTipMax} gwei) that arrived before it. ${docs}`
  if (i.ordering === 'fifo') return `Not observed: this stack orders by arrival (FIFO), so the tip decided nothing. Restart without --fifo to see PGA. ${docs}`
  return `Not observed in this run: ${i.failure ?? 'chapter 4 did not complete (see the failure above)'}. ${docs}`
}

/** Pure: the recap's takeaway, stated as an observation only when chapter 4 saw PGA and the race passed. */
export function takeawayLine(observed: boolean): string {
  const t = 'Information gets you into the round; the tip wins the round.'
  return `${observed ? t : `The idea (not fully observed in this run): ${t}`} Docs: combo/README.md#s3-the-headline-information-and-tip`
}

/** The hands-off pause after a chapter on a terminal, so a presenter can read it. */
export const DEFAULT_CHAPTER_DELAY_MS = 3000

/**
 * Pure: how long to stop after each chapter. 3000ms on a TTY stdout, unless Enter is the pause (--pause with a TTY stdin);
 * so `--pause` with a non-TTY stdin and a TTY stdout falls back to the timed delay. 0 on a non-TTY stdout (tests and CI stay
 * fast). DEMO_CHAPTER_DELAY_MS (a non-negative integer, 0 disables) overrides all of that, also on a
 * non-TTY. An invalid value is a usage error (ConfigError, exit 2), never silently ignored. An empty value counts as unset.
 */
export function chapterDelayMs(isTTY: boolean, pause: boolean, env: NodeJS.ProcessEnv = process.env, stdinIsTTY = true): number {
  const raw = (env.DEMO_CHAPTER_DELAY_MS ?? '').trim()
  if (raw !== '') {
    if (!/^\d+$/.test(raw)) throw new ConfigError(`DEMO_CHAPTER_DELAY_MS must be a non-negative integer (milliseconds; 0 disables the chapter pause), got "${raw}".`)
    return Number(raw)
  }
  const enterIsThePause = pause && stdinIsTTY
  return isTTY && !enterIsThePause ? DEFAULT_CHAPTER_DELAY_MS : 0
}

export interface ChapterFailure {
  chapter: number
  what: string
}

/** Pure: 1 when any chapter failed, else 3 when the race was inconclusive after its retry, else 0. */
export function demoExitCode(failures: readonly ChapterFailure[], raceVerdict: Verdict | undefined): number {
  if (failures.length > 0) return 1
  return raceVerdict === 'INCONCLUSIVE' ? 3 : 0
}


// ---------------------------------------------------------------------------
// Slow motion for a paused run, and the TTY panel
// ---------------------------------------------------------------------------

/**
 * Pure: should a self-started stack run in slow motion (`--slowmo`, B = 25 s)? Only for a run a presenter drives: `--pause` that
 * is honoured (stdin AND stdout are terminals), when the user did not choose a block time (SIM_SLOWMO, SIM_BLOCK_MS) and did
 * not opt out with DEMO_SLOWMO=0 (also false/off/no). The hands-off demo keeps the default preset.
 */
export function wantSlowmo(i: { pause: boolean; stdinTTY: boolean; stdoutTTY: boolean; env: NodeJS.ProcessEnv }): boolean {
  if (!i.pause || !i.stdinTTY || !i.stdoutTTY) return false
  if (['0', 'false', 'off', 'no'].includes((i.env.DEMO_SLOWMO ?? '').trim().toLowerCase())) return false
  if ((i.env.SIM_SLOWMO ?? '') !== '' || blockMsOverride([], i.env) !== undefined) return false // the user already chose
  return true
}

/** Pure: the NOTE lines when `--pause` attaches to a running simulator: its block and round times, and how to get the slow-motion view. */
export function attachedStackLines(p: Pick<LocalParams, 'blockMs' | 'roundMs' | 'k' | 'slowmo'>): string[] {
  const lines = [`this simulator runs blocks of ${p.blockMs}ms and PGA rounds of ${p.roundMs}ms (K = ${p.k} rounds per block).`]
  if (!p.slowmo) lines.push('for the slow-motion view restart the simulator with npm run sim -- --slowmo')
  return lines
}

/**
 * Pure: may the live chapter draw the in-place panel? Needs a terminal stdout that understands cursor movement (TERM is not
 * "dumb"). NO_COLOR does not matter: cursor movement is not colour, so the panel is still drawn, just without colour codes.
 */
export function panelAllowed(isTTY: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTTY === true && (env.TERM ?? '') !== 'dumb'
}

export const HIDE_CURSOR = '\x1b[?25l'
export const SHOW_CURSOR = '\x1b[?25h'
export const PANEL_INTERVAL_MS = 100

export interface PanelStream {
  write(s: string): unknown
  columns?: number
  rows?: number
}

/**
 * Redraws a block of lines in place: cursor up over the previous frame, clear to the end of the screen, write the new frame.
 * At most one frame per `intervalMs` (100ms). The cursor is hidden while drawing and ALWAYS restored: on `stop()`, on
 * SIGINT/SIGTERM and on process exit (listeners on `proc`, which stop the panel but never exit: the owner still exits).
 */
export class PanelRenderer {
  private prevLines = 0
  private height = 0
  private lastDraw = 0
  private timer: NodeJS.Timeout | undefined
  private active = false
  private frameErrors = 0
  private lastFrameError = ''
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly onSignal = () => this.stop()

  constructor(
    private readonly o: {
      stream: PanelStream
      /** The frame: given the time, the columns and rows of the terminal. */
      frame: (nowMs: number, dims: { columns: number; rows: number }) => string[]
      proc?: Pick<EventEmitter, 'on' | 'off'>
      intervalMs?: number
      now?: () => number
      /** How many of the frame's last lines (status, prompt) must survive a cut: the body above them is trimmed first. */
      tailLines?: () => number
    },
  ) {
    this.now = o.now ?? Date.now
    this.intervalMs = o.intervalMs ?? PANEL_INTERVAL_MS
  }

  get running(): boolean {
    return this.active
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.o.stream.write(HIDE_CURSOR)
    for (const ev of ['SIGINT', 'SIGTERM', 'exit']) this.o.proc?.on(ev, this.onSignal)
    this.draw(true)
    this.timer = setInterval(() => this.draw(), this.intervalMs)
    this.timer.unref()
  }

  /** Draw a frame now unless one was drawn less than `intervalMs` ago (`force` skips the throttle). */
  draw(force = false, final = false): void {
    if (!this.active) return
    const t = this.now()
    if (!force && t - this.lastDraw < this.intervalMs) return
    this.lastDraw = t
    let lines: string[]
    try {
      lines = this.o.frame(t, { columns: this.o.stream.columns ?? 80, rows: this.o.stream.rows ?? 40 })
    } catch (e) {
      this.frameErrors++
      this.lastFrameError = (e as Error).message
      return // a frame that cannot be built keeps the previous one on screen; it must never crash the timer or skip stop()
    }
    // The height never grows after the first frame: a taller frame at the bottom of the screen would scroll the old top lines into
    // the scrollback. Frames are padded (or cut) to rows - 1; the last frame is only cut, so no blank block stays behind. The rows
    // are re-read on every frame: a terminal shrunk mid-run shrinks the height too. A cut trims the body above the tail lines
    // (the chapter-4 prompt) first, never the tail itself.
    const cap = Math.max(1, (this.o.stream.rows ?? 40) - 1)
    this.height = this.height === 0 ? cap : Math.min(this.height, cap)
    if (lines.length > this.height) {
      const tail = Math.min(Math.max(0, this.o.tailLines?.() ?? 0), lines.length, this.height)
      lines = tail > 0 ? [...lines.slice(0, lines.length - tail).slice(0, this.height - tail), ...lines.slice(lines.length - tail)] : lines.slice(0, this.height)
    } else if (!final) lines = [...lines, ...Array<string>(this.height - lines.length).fill('')]
    const back = this.prevLines > 0 ? `\x1b[${this.prevLines}A\r\x1b[J` : ''
    this.o.stream.write(`${back}${lines.join('\n')}\n`)
    this.prevLines = lines.length
  }

  /** Draw the last frame, restore the cursor, stop. Safe to call twice and from a signal handler. */
  stop(): void {
    if (!this.active) return
    this.draw(true, true)
    this.active = false
    clearInterval(this.timer)
    this.timer = undefined
    for (const ev of ['SIGINT', 'SIGTERM', 'exit']) this.o.proc?.off(ev, this.onSignal)
    this.o.stream.write(SHOW_CURSOR)
    this.prevLines = 0
    this.height = 0
    if (this.frameErrors > 0) {
      note(`the panel could not draw ${this.frameErrors} frame(s) (last error: ${this.lastFrameError}); the previous frame stayed on screen.`)
      this.frameErrors = 0
    }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface State {
  preset: Preset
  stack: { attached: boolean; params: NonNullable<Preset['local']> }
  mine: BotIdentity
  keyFromEnv: boolean
  session?: TicketSession
  /** The ticket purchase started in the background before chapter 1 prints (E1); chapter 3 reports it. */
  bg?: BackgroundTicket
  traffic?: { stop(): Promise<void>; stats(): { sent: number; confirmed: number }; pause(): void; resume(): void }
  /** E2: the hold on the simulator while an Enter prompt waits, when it started (wall ms), every finished pause, and the one-time notes. */
  hold?: SimHold
  holdFrom?: number
  pauses: { from: number; to: number; sendsFrom?: number }[]
  /** E3: the wall time of the first send of chapter 4's hold: arrivals from then until the resume keep their real gaps (see `retimeThrough`). */
  holdSendsFrom?: number
  pauseNoted?: boolean
  pauseUnavailableNoted?: boolean
  keepRunningNoted?: boolean
  renewalReported?: boolean
  renewalAdopted?: boolean
  /** The traffic generator's tip ceiling, wei (from its own constant). */
  trafficTipMax?: bigint
  client?: FeedClient
  closingFeed: boolean
  /** Set when the feed refused or closed our connection on its own (1008 = ticket expired, 401 = no active ticket). */
  feedClosed?: { code: number }
  live?: LiveRounds
  /** The in-place panel of chapter 4 (a terminal only). */
  panel?: PanelRenderer
  decoding: Promise<void>
  /** F6: reveals the rows of the Fast Feed tables one by one on a terminal (display only); aborted on Ctrl-C. */
  pacer: RowPacer
  /** Every feed row seen since chapter 4 started (the newest 3000), for its tables. */
  rows: LiveRow[]
  leadMs?: number
  /** Chapter 4 observed PGA putting our tx first (a PGA stack, competitors in the round, index 0). */
  firstObserved?: boolean
  /** Why chapter 4 did not observe PGA (its failure message), for the recap. */
  biggerTipFailure?: string
  race?: { input: RaceInput; judgement: RaceJudgement; verdict: Verdict }
}

/** Up to this many tx/s: the traffic generator is capped by one tx in flight per wallet. */
const TRAFFIC_TPS = 4
const INJECT_TIP = parseGwei('1')
const INJECT_MAX_FEE = parseGwei('2')
/** How much ticket time each chapter after a pause needs (capped at one ticket round). */
const NEED_MS: Record<number, number> = { 4: 25_000, 5: 15_000 }
/** The same needs in blocks (25s, 15s at B = 2000): with slow blocks a chapter takes proportionally longer. */
const NEED_BLOCKS: Record<number, number> = { 4: 12.5, 5: 7.5 }
/** Pure: ticket time chapter `chapter` needs: max(constant, blocks x B), at most one ticket round. */
export function chapterNeedMs(chapter: number, blockMs: number, roundMs: number): number {
  return Math.min(Math.max(NEED_MS[chapter] ?? 0, (NEED_BLOCKS[chapter] ?? 0) * blockMs), roundMs)
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`)
    await sleep(100)
  }
}

const addr = (index: number) => privateKeyToAccount(anvilDevKey(index)).address

/** ", ticket expiry: ..." when the feed refused or closed the connection because the ticket ran out, else "". */
function expiryNote(st: State): string {
  const c = st.feedClosed?.code
  return c === 1008 || c === 401 ? ` (ticket expiry: the feed answered ${c}; a ticket is active for one ticket round only, and a long --pause can outlast it)` : ''
}

async function chapter1(banner: () => Promise<void>): Promise<void> {
  await banner() // the compact table and its notes, printed by startOrAttach
}

/** Print lines made by the pure builders: "==> " is a step, "NOTE:" a note, anything else plain data. */
function emit(lines: readonly string[]): void {
  for (const l of lines) {
    if (l.startsWith('==> ')) step(l.slice(4))
    else if (l.startsWith('NOTE:')) note(l)
    else plain(l)
  }
}

/** Pure: chapter 2's feed-key lines. Only the hash is ever shown. */
export function keyLines(fromEnv: boolean, keyHash: string): string[] {
  return [
    '==> a Fast Feed key',
    fromEnv ? '==> using FEED_API_KEY from your environment' : '==> generated a random key in memory for this run (never printed, never written to disk)',
    'NOTE: Only its hash goes on chain.',
    `keccak256(key) = ${keyHash}`,
  ]
}

async function chapter2(st: State): Promise<void> {
  const { raceMine, raceRival, raceOperator } = ANVIL_ACCOUNT_MAP
  const t = TRAFFIC_ACCOUNT_INDEXES
  step('wallets: the public Anvil dev accounts')
  note('LOCAL ONLY: their keys are public; roles: sim/README.md#local-wallet-funding')
  plain(`mine      = Anvil account ${raceMine}  ${addr(raceMine)}   (the demo's acting wallet)`)
  plain(`rival     = Anvil account ${raceRival}  ${addr(raceRival)}   (races us in chapter 5)`)
  plain(`operator  = Anvil account ${raceOperator}  ${addr(raceOperator)}   (opens the race; also the Tickets admin)`)
  plain(`traffic   = Anvil accounts ${t[0]}-${t.at(-1)}  (${shortAddr(addr(t[0]!))} ... ${shortAddr(addr(t.at(-1)!))})   (background load in chapter 4)`)
  const { walletsToFund } = await import('../sim/fund.ts')
  for (const w of walletsToFund(process.env)) {
    plain(`${w.label}: ${w.address} (address only)`)
    note(`${st.stack.attached ? 'It was funded with 1000 ETH when the stack started, if it had it in its env' : 'It was funded with 1000 ETH on the local chain'}; the demo still acts with account ${raceMine}.`)
  }
  emit(keyLines(st.keyFromEnv, st.mine.keyHash))
}

/** The result of the background purchase: the session (renewed when the renewal landed), or why it failed. */
export type BackgroundResult = { ok: true; session: TicketSession; renewed: boolean; round: number } | { ok: false; error: Error }
export interface BackgroundTicket {
  /** Wall-clock ms when the bought ticket activates, known as soon as the purchase is mined. */
  activeFrom?: number
  round?: number
  /** The background purchase AND its renewal have finished (either way). */
  settled?: boolean
  /** Wall-clock ms when the background flow started (for the landing estimate). */
  startedAt?: number
  /** F2: the silent clock skip to the activation time, started as soon as the purchase landed (owned stack only). Always resolves. */
  skipped?: Promise<void>
  /** Why the silent skip failed, if it did (nothing is printed; chapter 3 then waits for the activation). */
  skipError?: Error
  /** The purchase is active (bought and activated); the renewal may still be running. Never rejects. */
  landed: Promise<LandedResult>
  /** Everything, the renewal included. */
  done: Promise<BackgroundResult>
}
export type LandedResult = { ok: true; session: TicketSession; round: number } | { ok: false; error: Error }

/**
 * Silently fund the wallet, then buy (approve, deposit, purchase) and renew the ticket while chapters 1 and 2 are read out. It never rejects:
 * chapter 3 reports the result. A signal exits the process, so nothing here needs to be cancelled.
 */
function startBackgroundTicket(st: State): BackgroundTicket {
  const bg: BackgroundTicket = { landed: undefined as never, done: undefined as never, startedAt: Date.now() }
  bg.landed = buyTickets(st.preset, [st.mine], {
    quiet: true,
    onBought: (from, round) => {
      bg.activeFrom = from
      bg.round = round
      // F2: silent, and only on a stack the demo owns: do not wait for the activation, move the chain clock there now (the skip itself waits for a block in progress).
      if (shouldSkipActivation({ attached: st.stack.attached, activeFromMs: from, chainNowMs: chainNowMs() })) {
        bg.skipped = silentSkip(() => skipSimClock(st, Math.ceil(from / 1000)), (e) => { bg.skipError = e })
      }
    },
  }).then(
    (bought): LandedResult => ({ ok: true, session: bought, round: bg.round ?? 0 }),
    (e): LandedResult => ({ ok: false, error: e instanceof Error ? e : new Error(String(e)) }),
  )
  // The renewal continues in the background after chapter 3 has reported the purchase (chapter 4 reports its outcome).
  bg.done = bg.landed.then(async (l): Promise<BackgroundResult> => {
    await bg.skipped // the skip ends (and the client clock is set) before the ticket counts as settled, so a prompt hold cannot overlap it
    if (!l.ok) return l
    // Best effort: a failed renewal keeps the purchase; the refresh before chapters 4-5 rebuys later.
    const renewed = await renewTickets(st.preset, [st.mine], l.session, { quiet: true }).catch(() => undefined)
    return { ok: true, session: renewed ?? l.session, renewed: renewed !== undefined, round: l.round }
  })
  void bg.done.then(() => {
    bg.settled = true
  })
  return bg
}

/** Pure (F2): skip the simulator clock to the activation only on a stack the demo owns and when more than ACTIVATION_SKIP_OVER_MS remain. */
export function shouldSkipActivation(i: { attached: boolean; activeFromMs: number; chainNowMs: number }): boolean {
  return !i.attached && i.activeFromMs - i.chainNowMs > ACTIVATION_SKIP_OVER_MS
}

/** Run a skip silently: the returned promise always resolves; a failure is handed to `record` (never printed). */
export function silentSkip(skip: () => Promise<void>, record: (e: Error) => void): Promise<void> {
  return skip().then(
    () => undefined,
    (e: unknown) => record(e instanceof Error ? e : new Error(String(e))),
  )
}

/** Pure: the one NOTE of chapter 3 on the ticket round (config value against 24 h). */
export function ticketRoundNoteLine(roundSeconds: number): string {
  return `NOTE: LOCAL: a ticket round is ${roundSeconds}s here instead of 24h on Arbitrum One, where a ticket is valid for 24h. A ticket bought in ticket round N is active in round N+1 only.`
}

/** Pure: the short summary of the background purchase (no tx hashes, no block numbers). */
export function ticketSummaryLines(i: { keyHash: string; round: number; renewed: boolean | 'pending'; activeFrom: number; activeUntil: number }): string[] {
  return [
    `==> ticket bought for our key hash ${i.keyHash} in ticket round ${i.round} (approve USDGTest, deposit, purchase)`,
    `NOTE: the ticket activated at ${clock(i.activeFrom)} and expires at ${clock(i.activeUntil)}${i.renewed === 'pending' ? ' (renewing it for the next ticket round in the background; chapter 4 reports the outcome)' : i.renewed ? ', already renewed for the next ticket round so the live view survives the rollover' : ' (the renewal did not land; it is retried before the chapters that need the ticket)'}`,
  ]
}

const CARD_LEFT = 35
const CARD_RIGHT = 38
const shortHex = (h: string): string => (h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h)

/**
 * Pure (F2): a boxed preview of a ticket: what is inside it (left) and how it is used (right), plain characters, every line at most 80
 * columns. The feed key itself is never an input; only its hash, shortened.
 */
export function formatTicketCard(i: { round: number; owner: string; keyHash: string; numTickets: number; activeFrom: number; activeUntil: number; roundSeconds: number }): string[] {
  const left = [
    'WHAT IS IN THE TICKET',
    `bought in    : round ${i.round}`,
    `owner        : ${shortHex(i.owner)}`,
    `feed key hash: ${shortHex(i.keyHash)}`,
    `tickets      : ${i.numTickets}`,
    `active from  : ${clock(i.activeFrom)}`,
    `expires      : ${clock(i.activeUntil)}`,
    'valid for    : 24h on Arbitrum One',
    `  here: ${i.roundSeconds}s, one ticket round`,
  ]
  const right = [
    'HOW IT IS USED',
    '1. USDGTest.approve(Tickets,',
    '   amount)',
    '2. Tickets.depositToken(amount)',
    '   (your internal balance)',
    '3. read roundNumber() and',
    '   currentPrice()',
    '4. Tickets.purchaseTickets(',
    `     expectedRound=${i.round},`,
    '     expectedPrice,',
    `     numTicketsDesired=${i.numTickets},`,
    `     apiKeyHash=${shortHex(i.keyHash)})`,
    '   (reverts if round/price moved)',
    '5. open the Fast Feed WebSocket',
    '   Authorization: Bearer <key>',
    '   feed: keccak256(key), then',
    '   counts TicketsPurchased',
  ]
  const l = left
  const r = right
  const n = Math.max(l.length, r.length)
  const bar = `+${'-'.repeat(CARD_LEFT + 2)}+${'-'.repeat(CARD_RIGHT + 2)}+`
  const rows = Array.from({ length: n }, (_, k) => `| ${(l[k] ?? '').padEnd(CARD_LEFT)} | ${(r[k] ?? '').padEnd(CARD_RIGHT)} |`)
  return [bar, rows[0]!, bar, ...rows.slice(1), bar]
}

/** Pure: when the purchase should have landed (about PURCHASE_BLOCKS blocks after the flow started); the time left, never negative. */
export function purchaseLandWaitMs(startedAt: number, nowMs: number, blockMs: number): number {
  return Math.max(0, startedAt + PURCHASE_BLOCKS * blockMs - nowMs)
}

/** Pure: the one waiting line when more than 20 s remain, else undefined. The purchase needs mined blocks, so this is an upper estimate. */
export function activationWaitLine(remainingMs: number, kind: 'purchase' | 'activation' = 'purchase'): string | undefined {
  if (remainingMs <= 20_000) return undefined
  if (kind === 'activation') return `==> waiting ~${Math.ceil(remainingMs / 1000)}s for the ticket to activate`
  return `==> waiting for the ticket purchase to land (up to ~${Math.ceil(remainingMs / 1000)}s)`
}

async function chapter3(st: State): Promise<void> {
  const bg = st.bg
  if (!bg) throw new Error('the background ticket purchase was not started')
  emit([ticketRoundNoteLine(st.stack.params.tickets.roundSeconds)])
  // Only the purchase itself needs time (mined blocks cannot be skipped); the activation is skipped silently as soon as it has landed (F2).
  let waitPrinted = false
  if (bg.activeFrom === undefined && !bg.settled) {
    const w = activationWaitLine(purchaseLandWaitMs(bg.startedAt ?? Date.now(), Date.now(), st.stack.params.blockMs))
    if (w) { emit([w]); waitPrinted = true }
  }
  await until(() => bg.activeFrom !== undefined || bg.settled === true, Math.max(60_000, 8 * st.stack.params.blockMs + 30_000), 'the ticket purchase to land').catch(() => {})
  await bg.skipped
  // Attached stacks (or a failed skip) wait for the activation: say so, unless the purchase wait line was already the one waiting line.
  if (!waitPrinted && bg.activeFrom !== undefined) {
    const w = activationWaitLine(bg.activeFrom - chainNowMs(), 'activation')
    if (w) emit([w])
  }
  const r = await bg.landed
  if (!r.ok) throw r.error
  st.session = r.session
  const settled = bg.settled === true
  // E3: the renewal outcome is printed once: here when it already settled, else by chapter 4 (`reportRenewal`).
  if (settled) st.renewalReported = true
  emit(ticketSummaryLines({ keyHash: st.mine.keyHash, round: r.round, renewed: settled ? ((await bg.done) as { renewed?: boolean }).renewed === true : 'pending', activeFrom: r.session.activeFrom, activeUntil: r.session.activeUntil }))
  for (const l of formatTicketCard({ round: r.round, owner: st.mine.account.address, keyHash: st.mine.keyHash, numTickets: 1, activeFrom: r.session.activeFrom, activeUntil: r.session.activeUntil, roundSeconds: st.stack.params.tickets.roundSeconds })) plain(l)
}

/**
 * Start of chapter 4: wait for the background renewal (usually long done; one `==> waiting` line when it is not), adopt its session and
 * say in one line how it ended, unless chapter 3 already did. A failed one is left to the ticket refresh.
 */
async function reportRenewal(st: State): Promise<void> {
  const bg = st.bg
  if (!bg || st.renewalAdopted) return
  st.renewalAdopted = true
  if (bg.settled !== true) step('waiting for the background renewal…')
  const d = await bg.done
  if (!d.ok) return
  if (d.renewed) st.session = d.session
  if (st.renewalReported) return
  st.renewalReported = true
  if (d.renewed) note('the background renewal landed: the ticket is also active for the next ticket round, so the live view survives the rollover.')
  else note('the background renewal did not land; the ticket is checked, and renewed or bought again, before this chapter.')
}

/**
 * After a real --pause: the tickets may have run out (or be about to). Renew, or buy again and wait, before the chapter
 * (chapters 4-5 only), then print one line: time left in the ticket round and what became of the ticket.
 */
async function refreshTickets(st: State, chapter: number, realPause: boolean): Promise<void> {
  const roundMs = st.stack.params.tickets.roundSeconds * 1000
  const blockMs = st.stack.params.blockMs
  let outcome: PauseTicketOutcome
  const needsTicket = chapter >= 4 && chapter <= 5
  const before = st.session
  // The round is read once, before any purchase: a renewal made now is for the round after this one.
  let round: { round: number; roundEndMs: number } | undefined
  let readError: string | undefined
  try {
    round = await readTicketRound(st.preset, st.mine)
  } catch (e) {
    readError = (e as Error).message
  }
  const action = needsTicket ? postPauseTicketAction({ session: st.session, nowMs: chainNowMs(), roundMs, needMs: chapterNeedMs(chapter, blockMs, roundMs), blockMs }) : 'ok'
  if (!needsTicket) outcome = !before ? { kind: 'none' } : ticketsUsable(before, chainNowMs(), 0) ? { kind: 'kept' } : { kind: 'expired' }
  else if (action === 'ok') outcome = { kind: 'kept' }
  else {
    const why = rebuyReason(before, chainNowMs())
    step(`${realPause ? 'you paused' : 'since the last chapter'}: ${action === 'renew' ? 'the ticket is about to run out, so renewing it' : 'the ticket ran out (or is about to), so buying a new one and waiting for it to activate'}`)
    let renewedOk = false
    if (action === 'renew') {
      const renewed = await renewTickets(st.preset, [st.mine], st.session!)
      if (renewed) {
        st.session = renewed
        renewedOk = true
      } else step('the renewal did not land in time: buying again instead')
    }
    if (!renewedOk) {
      st.session = await buyTickets(st.preset, [st.mine])
      try {
        round = await readTicketRound(st.preset, st.mine) // the round moved on while waiting for activation
      } catch (e) {
        readError = (e as Error).message
      }
    }
    outcome = pauseTicketOutcome({ action, renewed: renewedOk, why, nextRound: (round?.round ?? 0) + 1 })
  }
  if (round) note(formatPauseTicketLine({ round: round.round, leftMs: round.roundEndMs - chainNowMs(), outcome, realPause }))
  else note(`(ticket round could not be read: ${readError})`)
}

/** Pure: how the demo explains a close of the live view's feed: 1008 in demo terms (the demo itself renews), the rest as the CLI does. */
export function demoCloseLines(code: number, reason: string): string[] {
  if (code === 1008) return ['NOTE: the Fast Feed closed the connection (1008): the ticket expired (a ticket is active for one ticket round only, and a long pause can outlast it). The demo buys a new ticket and reconnects by itself.']
  return closeLines(code, reason, 'npm run tickets:buy -- --local')
}

/** Connect (or reconnect) the live view's feed client with our key. */
async function openFeed(st: State): Promise<void> {
  const view = st.live!
  st.feedClosed = undefined
  const client = connectFeed({
    url: st.preset.feedUrl,
    apiKey: st.mine.key,
    onMessage: (msg, receivedAt) => {
      st.decoding = st.decoding.then(async () => view.push(await decodeLiveRow(msg, receivedAt))).catch((e: Error) => error(`error decoding message: ${e.message}`))
    },
    onClose: (code, reason) => {
      if (st.closingFeed) return
      st.feedClosed = { code }
      for (const l of demoCloseLines(code, reason)) (l.startsWith('NOTE:') ? note : error)(l)
    },
    onError: (e) => {
      if (!st.closingFeed) error(`feed error: ${e.message}`)
    },
  })
  st.client = client
  try {
    await client.ready
  } catch (e) {
    if (e instanceof FeedRejectedError) {
      st.feedClosed = { code: e.status }
      for (const l of rejectionLines(e.status, e.body, '--local')) error(l)
      throw new Error(`the Fast Feed refused the connection (HTTP ${e.status})`)
    }
    throw e
  }
}

/**
 * Chapter 4 (E3): one block, two rounds. Connect to the Fast Feed, start traffic, then tell the story of ONE block: round 1 as it
 * arrives, the simulator held open right after it, our 1 gwei tx (after a few lower-tip competitors) going to the top of round 2 of
 * the SAME block, and the sealed block. The sequence lives in `roundTwoAttempt`.
 */
async function chapter4(st: State, io: { prompt?: () => Promise<void> } = {}): Promise<void> {
  const { preset } = st
  const p = st.stack.params
  if (p.k < 2) throw new Error(`chapter 4 needs K >= 2 rounds per block (this simulator has K = ${p.k})`)
  const { startTraffic, TIP_MAX_WEI } = await import('../sim/traffic.ts')
  st.trafficTipMax = TIP_MAX_WEI
  st.traffic = await startTraffic({ rpcUrl: preset.rpcUrl, chainId: preset.chainId, tps: TRAFFIC_TPS, baseFeeWei: p.baseFeeWei, blockMs: p.blockMs, statsEveryMs: 0, log: (l) => (/send failed/.test(l) ? note(l) : undefined) })
  const mine = myAddresses(preset)
  const usePanel = panelAllowed(process.stdout.isTTY)
  st.live = new LiveRounds(demoLiveOptions({
    rpcUrl: preset.rpcUrl,
    mine,
    bold: colorEnabled(process.stdout.isTTY),
    roundsPerBlock: p.k,
    visibilityDeadlineMs: Math.max(60_000, 2 * p.blockMs + 30_000), // slow motion: a block is visible up to ~B after its rows
    isPaused: () => st.hold !== undefined && st.holdFrom !== undefined, // a paused simulator reveals nothing: the probe's deadline does not run meanwhile
    onRow: (row) => {
      st.rows.push(row)
      if (st.rows.length > 3000) st.rows.splice(0, st.rows.length - 3000)
    },
  }))
  st.live.setLineOutput(false) // the chapter draws the block itself: a panel on a terminal, otherwise the tables of its one block
  await openFeed(st)
  step(`connected to the Fast Feed; traffic running (${TRAFFIC_TPS} tx/s, tips 0-${gwei(TIP_MAX_WEI)} gwei)`)
  note('">>" marks our own transactions (Anvil account 0).')
  wnote(`${p.ordering === 'pga' ? 'PGA sorts each round by tip, not by arrival.' : 'This stack orders by arrival (FIFO: PGA is off), so the tip will not decide anything here.'} The demo inserts our ${fmtGwei(INJECT_TIP)} tx (account ${ANVIL_ACCOUNT_MAP.raceMine}) into round 2 of the next block, after its round 1 is out.`)
  let run: Round2Run | undefined
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (st.feedClosed) {
      wstep(`the feed had closed our connection (${st.feedClosed.code}): reconnecting with the renewed ticket`)
      await st.client?.close()
      await openFeed(st)
    }
    run = await roundTwoAttempt(st, io, attempt)
    if (run.judgement.verdict !== 'INCONCLUSIVE') break
    if (attempt === 1) wstep(`inconclusive (${run.judgement.failure}); retrying once, automatically`)
  }
  const j = run!.judgement
  st.firstObserved = j.observed
  st.biggerTipFailure = j.failure
  if (run!.leadMs !== undefined && run!.leadMs > 0) st.leadMs = run!.leadMs
  if (j.failure) throw new Error(j.verdict === 'INCONCLUSIVE' ? `inconclusive after one retry: ${j.failure}` : j.failure)
}


/** The in-place panel over the live view. `extra` adds lines under it (chapter 4: the block story, the prompt and the status). */
/** Pure (F6): the blocks of the generic frame. While a hold is armed and its block is unknown (`hide`), the open block, the future X, is left out so its rows are never drawn whole before the paced reveal. */
export function genericFrameBlocks<T>(open: T | undefined, previous: T | undefined, hide: boolean): { open: T | undefined; previous: T | undefined } {
  return hide ? { open: previous, previous: undefined } : { open, previous }
}

function makePanel(
  st: State,
  mine: ReadonlySet<string>,
  extra: () => { text: string; kind: 'note' | 'important' | 'step' }[] = () => [],
  /** E3: once `block()` names the story's block, the panel shows only that block, laid out top-down by `compose` (it gets the block's panel lines). */
  story?: { block: () => number | undefined; hideOpen?: () => boolean; compose: (body: string[], dims: { columns: number; rows: number }) => { lines: string[]; tail: string[] } },
): PanelRenderer {
  const live = st.live!
  const k = st.stack.params.k
  const color = colorEnabled(process.stdout.isTTY)
  let tail = 0
  const panel = new PanelRenderer({
    stream: process.stdout,
    proc: process,
    tailLines: () => tail,
    frame: (now, dims) => {
      const { open, previous } = live.panelBlocks()
      const more = extra()
      // Cut to the terminal width BEFORE styling, so an escape sequence is never cut in half.
      const under = more.length === 0 ? [] : ['', ...more].map((l) => (typeof l === 'string' ? l : color ? style(l.kind, l.text.slice(0, dims.columns)) : l.text.slice(0, dims.columns)))
      tail = under.length
      const sx = story?.block()
      const sb = sx === undefined ? undefined : live.block(sx)
      if (story && sb) {
        const body = formatPanel(sb, undefined, now, { mine, color, k, width: dims.columns, maxLines: Math.max(8, dims.rows - 2 - under.length - 6) })
        const c = story.compose(body, dims)
        tail = c.tail.length + under.length // the NOTE + prompt (held) or the sealed line (after resume) survive a cut; rows are trimmed first
        return [...c.lines, ...c.tail, ...under]
      }
      // F6: while a hold is armed and its block unknown, the open block (the future X) is not drawn, so its rows are never shown whole.
      const g = genericFrameBlocks(open, previous, story?.hideOpen?.() === true)
      return [...formatPanel(g.open, g.previous, now, { mine, color, k, width: dims.columns, maxLines: Math.max(8, dims.rows - 2 - under.length) }), ...under]
    },
  })
  st.panel = panel
  return panel
}

// ---------------------------------------------------------------------------
// Chapter 4 (E3): the block story: round 1, the hold, round 2 with our tx on top, the sealed block
// ---------------------------------------------------------------------------

/** The lower-tip "competitor" txs sent into round 2 just before ours: other bots that happened to be faster on the network. */
export const COMPETITOR_TIPS_GWEI = ['0.05', '0.01', '0.02'] as const
export const COMPETITOR_MAX_TIP = parseGwei('0.05')

/** Pure: how many competitors, the gap between sends (ms) and how much of round 2 must be left to send them all and ours. */
export function round2Plan(roundMs: number): { competitors: number; gapMs: number; needMs: number } {
  const competitors = roundMs <= 2000 ? 2 : 3
  const gapMs = Math.max(10, Math.min(400, Math.floor(roundMs / 12)))
  return { competitors, gapMs, needMs: competitors * gapMs + Math.min(300, Math.floor(roundMs / 4)) }
}

/** `sim_blockInfo` (local only). */
export interface BlockInfo {
  block: number
  round: number
  roundStartMs: number
  blockStartMs: number
  k: number
  roundMs: number
  blockMs: number
  /** E2 (the simulator's own sim clock, frozen while it is paused): ms left in this round, ms into this block, paused, held after round 1. */
  roundLeftMs?: number
  blockElapsedMs?: number
  paused?: boolean
  heldAt?: { block: number; round: number }
}

/** Pure: ms left in the round `info` describes. The simulator's own figure when it gives one (it stands still while paused), else the wall-clock estimate. */
export function roundLeft(info: Pick<BlockInfo, 'roundStartMs' | 'roundMs' | 'roundLeftMs'>, nowMs: number): number {
  return info.roundLeftMs ?? info.roundStartMs + info.roundMs - nowMs
}

/** Pure: the panel's prompt area. A block is named only when it is the current target (slow rounds); short rounds name none, as the open block moves on. */
export function promptPanelLines(prompt: string, block?: number): { text: string; kind: 'note' | 'important' }[] {
  return [...(block === undefined ? [] : [{ text: `NOTE: block ${block} is open; the Fast Feed already shows its round 1.`, kind: 'note' as const }]), { text: prompt, kind: 'important' as const }]
}

/** Pure: when Enter arrives, send at once if round 2 of the target still has time, else wait for the next target. */
export function enterDecision(info: Pick<BlockInfo, 'block' | 'round' | 'roundStartMs' | 'roundMs' | 'roundLeftMs'>, targetBlock: number, nowMs: number, needMs: number): 'send' | 'next' {
  return canSendInRound2(info, targetBlock, nowMs, needMs) ? 'send' : 'next'
}

/** Pure: can the sends still land in round 2 of `targetBlock`? It must be that block, round 2, with `needMs` of the round left. */
export function canSendInRound2(info: Pick<BlockInfo, 'block' | 'round' | 'roundStartMs' | 'roundMs' | 'roundLeftMs'>, targetBlock: number, nowMs: number, needMs: number): boolean {
  return info.block === targetBlock && info.round === 2 && roundLeft(info, nowMs) >= needMs
}

async function simRpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) })
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
}

const readBlockInfo = (url: string) => simRpc<BlockInfo>(url, 'sim_blockInfo')
const readArrivals = async (url: string, block: number, round: number): Promise<ArrivalRec[]> => parseArrivals(await simRpc<unknown>(url, 'sim_arrivals', [block, round]))

const holderName = () => `demo-${process.pid}`

/**
 * E2: run `fn` (an Enter prompt) with the simulator frozen: no PGA rounds, no blocks, no traffic, the ticket clock stopped, so Enter
 * continues in the same ticket round with the same time left. A refused or missing pause prints one NOTE and falls back to the
 * old behaviour (the simulator keeps running; the post-pause ticket renewal covers it).
 */
async function whilePaused<T>(st: State, fn: () => Promise<T>): Promise<T> {
  return runPromptHold({
    inFlight: !shouldFreezeAtPrompt({ hasBackgroundTicket: st.bg !== undefined, backgroundSettled: st.bg?.settled === true }),
    settled: st.bg?.done,
    onKeepRunning: () => {
      if (!st.keepRunningNoted) {
        st.keepRunningNoted = true
        note('the simulator keeps running until your ticket purchase and its renewal have settled (they are still in flight); it is frozen from the moment they settle, while this prompt waits.')
      }
    },
    acquire: () => takeHold(st),
    release: () => endHold(st),
    fn,
  })
}

/**
 * The prompt's hold (pure orchestration, tested with fakes). Normally: acquire, run the prompt, release. When the background ticket
 * purchase is still in flight the prompt opens unfrozen, and the hold is acquired as soon as `settled` resolves while the prompt is still
 * waiting (a long talk over chapter 1 must not use ticket time). Release after the prompt; a hold taken at the very moment of Enter is released too.
 */
export async function runPromptHold<T>(o: { inFlight: boolean; settled?: Promise<unknown>; onKeepRunning: () => void; acquire: () => Promise<void>; release: () => Promise<void>; fn: () => Promise<T> }): Promise<T> {
  if (!o.inFlight) {
    await o.acquire()
    try {
      return await o.fn()
    } finally {
      await o.release()
    }
  }
  o.onKeepRunning()
  let over = false
  let acquiring: Promise<void> | undefined
  void (o.settled ?? Promise.resolve()).catch(() => {}).then(() => {
    if (!over) acquiring = o.acquire().catch(() => {}) // a failed acquire is never an unhandled rejection; the prompt still works
  })
  try {
    return await o.fn()
  } finally {
    over = true
    await acquiring // an acquire that is under way finishes first, then it is released
    await o.release()
  }
}

/** The client side of a hold that took effect: remember it, freeze the client's chain clock (a wait on chain time must not end early) and the traffic. */
function adoptHold(st: State, hold: SimHold, chainNow: number): void {
  st.hold = hold
  st.holdFrom = Date.now()
  st.holdSendsFrom = undefined
  freezeChainClock(chainNow)
  st.traffic?.pause()
}

/** Freeze the simulator for a prompt: `sim_pause`, the client clock, the traffic. A refused or missing pause prints one NOTE and changes nothing. */
async function takeHold(st: State): Promise<void> {
  if (st.hold) return
  const hold = new SimHold((m, p) => simRpc(st.preset.sendUrl, m, p), holderName())
  const got = await hold.acquire()
  if (got.state !== 'paused') {
    if (!st.pauseUnavailableNoted) {
      st.pauseUnavailableNoted = true
      note(`the simulator could not be paused (${got.reason}): it keeps running while you talk, so the ticket may need renewing after the pause.`)
    }
    return
  }
  adoptHold(st, hold, got.info.chainNowMs)
  if (!st.pauseNoted) {
    st.pauseNoted = true
    note(PAUSE_NOTE)
  }
}

/** Resume the simulator (idempotent; also called by the signal handler), and take the pause out of every client-side timing. */
async function endHold(st: State): Promise<void> {
  const hold = st.hold
  if (!hold) return
  st.hold = undefined
  const from = st.holdFrom ?? Date.now()
  st.holdFrom = undefined
  let chain: number | undefined
  try {
    chain = (await hold.release())?.chainNowMs
  } catch {
    // the resume call failed: the lease resumes the simulator by itself; ask for the clock below
  }
  if (chain === undefined) chain = await simRpc<SimClockInfo>(st.preset.sendUrl, 'sim_clock').then((c) => c.chainNowMs).catch(() => undefined)
  const to = Date.now()
  if (chain !== undefined) setChainClock(chain, to)
  else thawChainClock() // resume and clock read both failed: do not stay frozen (the last offset stays; the lease resumes the simulator)
  // The whole hold (until the resume) is taken out of every time; chapter 4's sends keep their gaps through `sendsFrom`.
  const span = { from, to, ...(st.holdSendsFrom !== undefined ? { sendsFrom: st.holdSendsFrom } : {}) }
  st.holdSendsFrom = undefined
  st.pauses.push(span)
  st.live?.retime(retimeForPause(span)) // rows received before the pause: the pause is not part of "visible minus received"
  st.traffic?.resume()
}

/** Skip the simulator's chain clock forward to `toSec` and wait until it is applied (a block still open delays it); then refresh the client clock. */
async function skipSimClock(st: State, toSec: number): Promise<void> {
  const url = st.preset.sendUrl
  let info = await simRpc<SimClockInfo & { status: string }>(url, 'sim_skipTo', [{ toSec, holder: holderName() }])
  const end = Date.now() + st.stack.params.blockMs + 10_000
  while (info.pendingSkip !== null) {
    if (Date.now() > end) throw new Error('the skip stayed pending (a block was still open)')
    await sleep(200)
    info = await simRpc<SimClockInfo & { status: string }>(url, 'sim_clock')
  }
  setChainClock(info.chainNowMs)
}

/** Chapter-4 narration wrapped to 80 columns (the first line keeps its prefix; continuation lines are indented). */
const wnote = (text: string): void => noteLines(noteBlock(text))
function wstep(text: string): void {
  wrapText(text, WIDTH - 4).forEach((l, i) => (i === 0 ? step(l) : plain(`    ${l}`)))
}
function wimportant(text: string): void {
  for (const l of wrapText(text, WIDTH)) important(l)
}

/** Print formatter output in the palette: notes in the note colour (already `NOTE:`-prefixed), important lines highlighted. */
function printOut(lines: readonly OutLine[]): void {
  for (const l of lines) {
    if (l.kind === 'note') noteLines([l.text])
    else if (l.kind === 'important') important(l.text)
    else plain(l.text)
  }
}

/** F6: like `printOut`, but the table rows the formatter flagged as new are revealed one by one on a terminal (see pacing.ts). */
async function printOutPaced(st: State, lines: readonly OutLine[]): Promise<void> {
  await st.pacer.printLines(lines, (l) => printOut([l]), () => wnote(PACING_NOTE))
}

interface Target {
  block: number
  /** Where the block started on the client's clock with the simulator's pauses taken out (see `retimeForPause`): the origin of the timing table. */
  blockStartMs: number
  /** Round 2's time left when it was measured (the simulator's own clock) and when (wall): the countdown is frozen while paused. */
  leftMs: number
  measuredAt: number
  round1Txs: number
}

interface Round2Run {
  judgement: Round2Judgement
  leadMs?: number
}

/**
 * E3: arm the simulator's hold (`sim_pause` at `afterRound1`) and wait until it takes effect: the next block that has transactions in
 * round 1 is published on the feed and its round 2 is held open (`heldAt`). On success the client side is frozen too (`adoptHold`).
 * A refusal, an older simulator or a timeout is reported, never thrown, so the caller falls back to the unheld behaviour.
 */
async function armAndWait(st: State, timeoutMs: number, onBlock?: (block: number) => void): Promise<{ ok: true; block: number } | { ok: false; reason: string }> {
  const url = st.preset.sendUrl
  return armHoldAndWait({
    rpc: (m, p) => simRpc(url, m, p),
    holder: holderName(),
    timeoutMs,
    onArmed: (hold) => {
      st.hold = hold // the signal handler and the caller's `finally` release it; `holdFrom` stays unset until the pause took effect
    },
    onHeld: (hold, chainNow, block) => {
      if (block !== undefined) onBlock?.(block)
      adoptHold(st, hold, chainNow)
    },
    onTimeout: () => endHold(st),
  })
}

/**
 * The orchestration of `armAndWait`, with its effects injected (unit-tested with a fake RPC): arm, poll `sim_clock` until the hold
 * took effect (`heldAt`), and report which block it holds. A refused or missing pause, or a timeout (the hold is released first), is
 * `{ok: false, reason}`: the caller falls back to the unheld behaviour.
 */
export async function armHoldAndWait(o: {
  rpc: SimRpcFn
  holder: string
  timeoutMs: number
  pollMs?: number
  onArmed: (hold: SimHold) => void
  onHeld: (hold: SimHold, chainNowMs: number, block?: number) => void
  onTimeout: () => Promise<void>
  leaseMs?: number
}): Promise<{ ok: true; block: number } | { ok: false; reason: string }> {
  const armed = await armHold(o)
  if (!armed.ok) return armed
  return waitHeld({ ...o, hold: armed.hold })
}

/** F5: the first half of `armHoldAndWait`: arm the hold (the simulator pauses right after the next block's round 1). Refused or missing: `{ok: false}`. */
export async function armHold(o: { rpc: SimRpcFn; holder: string; onArmed: (hold: SimHold) => void; leaseMs?: number }): Promise<{ ok: true; hold: SimHold } | { ok: false; reason: string }> {
  const hold = new SimHold(o.rpc, o.holder, o.leaseMs)
  const got = await hold.acquire('afterRound1')
  if (got.state !== 'paused') return { ok: false, reason: got.reason }
  o.onArmed(hold)
  return { ok: true, hold }
}

/** F5: the second half: poll `sim_clock` until the armed hold took effect and report its block; a timeout releases the hold first. */
export async function waitHeld(o: {
  rpc: SimRpcFn
  hold: SimHold
  timeoutMs: number
  pollMs?: number
  onHeld: (hold: SimHold, chainNowMs: number, block?: number) => void
  onTimeout: () => Promise<void>
}): Promise<{ ok: true; block: number } | { ok: false; reason: string }> {
  const end = Date.now() + o.timeoutMs
  for (;;) {
    const info = await o.rpc<SimClockInfo>('sim_clock').catch(() => undefined)
    if (info?.paused && info.heldAt) {
      o.onHeld(o.hold, info.chainNowMs, info.heldAt.block)
      return { ok: true, block: info.heldAt.block }
    }
    if (Date.now() > end) {
      await o.onTimeout()
      await o.hold.release().catch(() => undefined) // disarms an armed hold that never took effect (a no-op once released)
      return { ok: false, reason: `no block with transactions opened within ${Math.round(o.timeoutMs / 1000)}s` }
    }
    await sleep(o.pollMs ?? 40)
  }
}

/**
 * Pure: the chapter-4 panel for block X, top-down like the story. `body` is `formatPanel` of that one block (status line, column
 * header, then per round a `  round R/K ...` label and its rows). Result: the block header, `round 1 — ...` with the column header and
 * round 1's rows, the NOTE and the prompt after round 1's rows, `round 2 — ...` above round 2's rows, then the sealed line.
 */
export function composeStoryPanel(
  body: readonly string[],
  o: { block: number; blockMs: number; roundMs: number; k: number; columns: number; color: boolean; slowed: readonly string[]; prompt?: string; sealed?: string; reveal?: Readonly<Record<number, number | undefined>> },
): { lines: string[]; tail: string[] } {
  const cut = (kind: 'note' | 'important' | 'step', text: string) => (o.color ? style(kind, text.slice(0, o.columns)) : text.slice(0, o.columns))
  const after = [...o.slowed.map((l) => cut('note', l)), ...(o.prompt !== undefined ? [cut('important', o.prompt)] : [])]
  const out = [cut('step', blockHeaderLine(o.block, o.blockMs))]
  const colHead = body[1] // the column header goes right under `round 1 — ...`, above the rows
  let headed = false
  let held = false
  let inserted = false
  let curRound: number | undefined // F6: rows of a round are revealed one by one: only the first `reveal[round]` of its rows are drawn
  let drawn = 0
  for (const line of body.slice(2)) {
    const m = /^ {2}round (\d+)\/\d+(.*)$/.exec(line)
    if (!m) {
      const limit = curRound === undefined ? undefined : o.reveal?.[curRound]
      if (limit !== undefined && drawn >= limit) continue
      drawn++
      out.push(line)
      continue
    }
    curRound = Number(m[1])
    drawn = 0
    if (m[1] === '2' && /^: not ordered yet/.test(m[2]!)) {
      held = true // round 2 has not run: the NOTE and the prompt are the tail, in place of its empty header
      continue
    }
    if (m[1] === '2' && !inserted) {
      out.push(...after)
      inserted = true
    }
    out.push(cut('step', `${roundHeaderLine(Number(m[1]), o.k, o.roundMs)}${m[2]!.replace(/^:/, ' ·')}`))
    if (!headed && colHead !== undefined) out.push(colHead)
    headed = true
  }
  if (held || !inserted) return { lines: out, tail: after } // held (or round 2 absent): the story ends with the NOTE and the prompt
  return { lines: out, tail: o.sealed ? [cut('step', o.sealed)] : [] }
}

type StatusLine = { text: string; kind: 'note' | 'important' | 'step' }

/**
 * One try of chapter 4. The simulator is asked to hold the next block's round 2 open right after round 1 (E3). With the block held:
 * show its header and round 1, say the NOTE, (with --pause on a terminal: wait for Enter,) send the lower-tip competitors and then our
 * 1 gwei tx, resume once the proxy accepted them all, show round 2 with our tx on top and the sealed block, then the short explanations.
 * If the hold cannot be armed the old behaviour applies: wait for round 2 of an open block whose round 1 the feed already showed and
 * send into it at full speed. On a terminal the panel draws and the text is queued; otherwise every line is printed in order.
 */
async function roundTwoAttempt(st: State, io: { prompt?: () => Promise<void> }, attempt: number): Promise<Round2Run> {
  const { preset } = st
  const live = st.live!
  const params = st.stack.params
  const mineSet = myAddresses(preset)
  const plan = round2Plan(params.roundMs)
  const tipGwei = gwei(INJECT_TIP)
  const read = createPublicClient({ transport: http(preset.rpcUrl) })
  const send = createPublicClient({ transport: http(preset.sendUrl) })
  const sendUrl = preset.sendUrl

  // Pre-sign everything first: explicit nonces, nothing left to fill in while the simulator is held.
  const account = privateKeyToAccount(anvilDevKey(ANVIL_ACCOUNT_MAP.raceMine))
  const gas = ((await read.estimateGas({ account: account.address, to: DEAD, value: 0n })) * 11n) / 10n
  const signFor = async (acct: ReturnType<typeof privateKeyToAccount>, tip: bigint) => {
    const nonce = await read.getTransactionCount({ address: acct.address, blockTag: 'pending' })
    const raw: Hex = await presign({ to: DEAD, value: 0n, tip, maxFee: INJECT_MAX_FEE, nonce, gas, account: acct, chain: { id: preset.chainId } })
    return { raw, hash: keccak256(raw), from: acct.address as Address, tip }
  }
  const competitors = await Promise.all(
    ANVIL_ACCOUNT_MAP.demoCompetitors.slice(0, plan.competitors).map((i, n) => signFor(privateKeyToAccount(anvilDevKey(i)), parseGwei(COMPETITOR_TIPS_GWEI[n]!))),
  )
  const ours = await signFor(account, INJECT_TIP)

  // Output. With the panel up, the story goes under it: `story` (in order: the block and round headers, the NOTE, the sealed line) stays,
  // `transient` is the one latest chatter line; the closing summary is queued until the panel stops. Without a panel every line is
  // printed in order, as it happens.
  const story: StatusLine[] = []
  let transient: StatusLine | undefined
  const afterPanel: (() => void)[] = []
  const later = (fn: () => void) => (panel ? afterPanel.push(fn) : fn())
  /** `keep`: part of the story the panel keeps on screen; otherwise it is chatter (a line-mode line; the panel shows only the latest). */
  const showStep = (text: string, keep = false) => {
    if (!panel) wstep(text)
    else if (keep) story.push({ text, kind: 'step' })
    else transient = { text, kind: 'step' }
  }
  const showNote = (text: string, keep = true) => {
    if (!panel) wnote(text)
    else if (keep) for (const l of noteBlock(text)) story.push({ text: l, kind: 'note' })
  }
  const short = params.roundMs < 4000 // a human cannot hit the end of a sub-second round: Enter only starts the send
  let promptText: (() => string) | undefined
  // Panel layout (top-down, like the story): the block header, the column header, `round 1 — ...` above round 1's rows, the NOTE and the
  // prompt, `round 2 — ...` above round 2's rows, the sealed line. Set as the story advances.
  let storyX: number | undefined
  let slowedLines: string[] = []
  let sealed: string | undefined
  /** F6: per round, how many of its rows the panel draws so far (absent = all). */
  const reveal: Record<number, number | undefined> = {}
  // Pacing happens only while the simulator is held (display only: it must never delay the sends); set once the hold took effect.
  let pacer = st.pacer.when(false)
  let hideOpen = false // armed, the held block unknown: the generic frame must not draw the block that is about to be X
  const announcePace = (n: number) => pacer.announce(n, () => (panel ? showNote(PACING_NOTE) : wnote(PACING_NOTE)))
  const color = colorEnabled(process.stdout.isTTY)
  const usePanel = panelAllowed(process.stdout.isTTY)
  let panel: PanelRenderer | undefined
  let target: Target | undefined
  if (usePanel) {
    panel = makePanel(st, mineSet, () => [...story, ...(transient ? [transient] : []), ...(storyX === undefined && promptText ? promptPanelLines(promptText(), undefined) : [])], {
      block: () => storyX,
      hideOpen: () => hideOpen,
      compose: (body, dims) => composeStoryPanel(body, { block: storyX!, blockMs: params.blockMs, roundMs: params.roundMs, k: params.k, columns: dims.columns, color, slowed: slowedLines, prompt: promptText?.(), sealed, reveal }),
    })
    panel.start()
  }
  const roundRows = (n: number, r: number) => st.rows.filter((x) => x.blockNumber === n && x.pgaRound === r).sort((a, b) => a.txIndex - b.txIndex)
  /** Line mode: the rows of one round as the live view's table. The panel shows them itself. */
  const printRound = async (n: number, r: number) => {
    if (panel) return
    const [group] = groupRows(roundRows(n, r))
    if (!group) return
    const lines = formatTable(group, { mine: mineSet, bold: colorEnabled(process.stdout.isTTY) })
    for (const l of lines.slice(0, 2)) plain(l) // the table's label and column header first (widths already come from all rows)
    await pacer.reveal(lines.length - 2, (shown) => {
      for (let k = shownLines; k < shown; k++) plain(lines[2 + k]!)
      shownLines = shown
    })
    shownLines = 0
  }
  let shownLines = 0

  const timeoutMs = 2 * params.blockMs + 60_000
  /** The unheld fallback: wait until the feed has shown round 1 of an open block and its round 2 still has time. */
  const waitTarget = async (): Promise<Target> => {
    let found: Target | undefined
    const end = Date.now() + timeoutMs
    while (!found) {
      if (Date.now() > end) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for round 1 of an open block on the live view`)
      const q0 = Date.now()
      const info = await readBlockInfo(sendUrl)
      const q = Math.round((q0 + Date.now()) / 2)
      const r1 = st.rows.filter((r) => r.blockNumber === info.block && r.pgaRound === 1)
      const left = roundLeft(info, q)
      if (info.round === 2 && r1.length > 0 && left >= plan.needMs) {
        found = { block: info.block, blockStartMs: q - (info.blockElapsedMs ?? q - info.blockStartMs), leftMs: left, measuredAt: q, round1Txs: r1.length }
      } else await sleep(40)
    }
    return found
  }

  let probes: { n: number; p: Promise<number | undefined> }[] = []
  try {
    // --- 1. Which block? Ask the simulator to hold the next block after its round 1.
    if (panel) transient = { text: 'waiting for the next block: the demo slows the simulator down right after its round 1', kind: 'step' }
    hideOpen = panel !== undefined && st.pacer.enabled
    const armed = await armAndWait(st, timeoutMs, (b) => {
      // The hold took effect on block b: from this frame on only the story view draws it, with round 1's rows hidden until revealed.
      if (panel && st.pacer.enabled) {
        reveal[1] = 0
        storyX = b
      }
      hideOpen = false
    })
    hideOpen = false
    const held = armed.ok
    pacer = st.pacer.when(held)
    if (armed.ok) {
      const X = armed.block
      await until(() => roundRows(X, 1).length > 0, 10_000, 'round 1 of the held block on the Fast Feed').catch(() => {}) // published just before the hold
      await sleep(350) // longer than the view's quiet period: the whole round is in
      const info = await readBlockInfo(sendUrl).catch(() => undefined)
      const from = st.holdFrom ?? Date.now()
      // The simulator's own clock stands still while held: the block started `blockElapsedMs` before the hold took effect.
      target = { block: X, blockStartMs: from - (info?.blockElapsedMs ?? params.roundMs), leftMs: info?.roundLeftMs ?? params.roundMs, measuredAt: from, round1Txs: roundRows(X, 1).length }
    } else {
      showNote(`could not slow the simulator down (${armed.reason}): the demo sends into round 2 of an open block at full speed instead, so the same block is not guaranteed.`)
      showStep('waiting for round 1 of an open block to appear on the Fast Feed...')
      target = await waitTarget()
    }

    // --- 2. Round 1, as it arrived on the feed.
    const showHeaders = async (n: number, round1Txs: number) => {
      if (panel) {
        if (pacer.enabled) reveal[1] = 0 // the rows are revealed below, inside the frame
        storyX = n // the panel now shows only this block, with the headers above their rows
        transient = undefined
        announcePace(round1Txs)
        await pacer.reveal(roundRows(n, 1).length, (shown) => void (reveal[1] = shown))
        reveal[1] = undefined
        return
      }
      wstep(blockHeaderLine(n, params.blockMs))
      announcePace(round1Txs)
      wstep(`${roundHeaderLine(1, params.k, params.roundMs)} · ${round1Txs} tx${round1Txs === 1 ? '' : 's'}:`)
      await printRound(n, 1)
    }
    await showHeaders(target.block, target.round1Txs)
    let X = target.block

    if (held) {
      if (panel) slowedLines = noteBlock(SLOWED_NOTE)
      else wnote(SLOWED_NOTE)
      const askText = `Press Enter: insert your ${tipGwei} gwei tx into round 2 of block ${X}`
      if (io.prompt && attempt === 1) {
        promptText = () => askText
        if (!panel) wimportant(askText)
        await io.prompt() // the simulator already stands still (and keeps its lease alive meanwhile)
        promptText = undefined
      } else await sleep(1000) // a short moment to read the note
    } else if (io.prompt && attempt === 1) {
      const askText = short ? `Press Enter: the demo sends your ${tipGwei} gwei tx into round 2 of the next open block` : `Press Enter: send your ${tipGwei} gwei tx into round 2 of block ${X}`
      let t = target
      const spans = (): PauseSpan[] => [...st.pauses, ...(st.hold && st.holdFrom !== undefined ? [{ from: st.holdFrom }] : [])]
      promptText = () => (short ? askText : `${askText} (${Math.max(0, (t.leftMs - (Date.now() - t.measuredAt - pausedOverlapMs(spans(), t.measuredAt, Date.now()))) / 1000).toFixed(1)}s left)`)
      if (!panel) wimportant(askText)
      await whilePaused(st, io.prompt) // no hold: the old behaviour, the prompt freezes the simulator itself
      const info = await readBlockInfo(sendUrl)
      promptText = undefined
      if (enterDecision(info, t.block, Date.now(), plan.needMs) === 'next') {
        // Enter is never "too late": the demo sends into round 2 of the next block that shows a round 1.
        const late = `Enter came after round 2 of block ${t.block} had (nearly) closed`
        showStep(`${late}: sending into round 2 of the next block automatically`)
        t = await waitTarget()
        target = t
        X = t.block
        await showHeaders(X, t.round1Txs)
      }
    } else {
      showStep(`no prompt (${attempt > 1 ? 'the retry is automatic' : 'no --pause on a terminal'}): sending your ${tipGwei} gwei tx into round 2 of block ${X}${panel ? '' : ' now'}`)
    }
    const B = target.block
    const cNames = `${competitors.map((c) => gwei(c.tip)).join(', ')} gwei, Anvil accounts ${ANVIL_ACCOUNT_MAP.demoCompetitors.slice(0, competitors.length).join(', ')}`
    showNote(`first, ${competitors.length} lower-tip competitor txs (${cNames}) go into round 2 a moment BEFORE yours: other bots that happened to be faster on the network.`, false)

    // --- 3. The sends. While the simulator is held they all queue for round 2; it resumes once the proxy accepted every one.
    const deadline = Math.max(60_000, 2 * params.blockMs + 30_000)
    if (panel && pacer.enabled) reveal[2] = 0 // round 2's rows (hidden until revealed) are not drawn the moment they arrive
    if (held) st.holdSendsFrom = Date.now() // from here the sends keep their real gaps on the timing table's timeline
    else probes = [{ n: B, p: waitBlockVisible(preset.rpcUrl, B, deadline, 25) }]
    showStep(`sending ${competitors.length} competitors (tips ${competitors.map((c) => gwei(c.tip)).join(', ')} gwei), then yours (${tipGwei} gwei) into round 2 of block ${B}`)
    for (const c of competitors) {
      await send.sendRawTransaction({ serializedTransaction: c.raw })
      await sleep(plan.gapMs)
    }
    await send.sendRawTransaction({ serializedTransaction: ours.raw }) // the proxy answers once the tx is queued: all of them are accepted now
    if (held) {
      showStep('all accepted: resuming the simulator, round 2 runs now')
      await endHold(st)
      probes = [{ n: B, p: waitBlockVisible(preset.rpcUrl, B, deadline, 25) }]
    }
    showStep(`sent ${ours.hash.slice(0, 10)}... (explicit nonce, maxPriorityFee ${tipGwei} gwei) after ${competitors.length} competitors: waiting for it on the Fast Feed`)

    const findX = () => st.rows.find((r) => r.hash.toLowerCase() === ours.hash.toLowerCase())
    await until(() => findX() !== undefined, 2 * params.blockMs + 30_000, 'our transaction on the Fast Feed').catch(() => {
      throw new Error(`our transaction never appeared in the live view${st.feedClosed ? ' (the feed connection had closed)' : ''}`)
    })
    const xRow = findX()!
    if (xRow.blockNumber !== B) probes.push({ n: xRow.blockNumber, p: waitBlockVisible(preset.rpcUrl, xRow.blockNumber, deadline, 25) })
    // --- 4. Round 2 on the feed, our tx on top.
    await sleep(400) // longer than the view's quiet period: the rest of the round is in
    const round2Rows = roundRows(xRow.blockNumber, xRow.pgaRound ?? 2).length
    if (!panel) {
      announcePace(round2Rows)
      wstep(`${roundHeaderLine(2, params.k, params.roundMs)} · ${round2Rows} txs:`)
      await printRound(xRow.blockNumber, xRow.pgaRound ?? 2)
    } else {
      announcePace(round2Rows)
      await pacer.reveal(round2Rows, (shown) => void (reveal[2] = shown))
      reveal[2] = undefined
    }
    // --- 5. The sealed block.
    const seen = await Promise.all(probes.map(async (x) => ({ n: x.n, at: await x.p })))
    for (const x of seen) if (x.at !== undefined) live.markVisible(x.n, x.at) // the panel's FF lead column uses the same visible time as the table
    if (panel) await sleep(700) // the panel draws the closed block (FF lead filled in) once before it stops
    const visibleOf = (n: number): number | undefined => {
      const times = [seen.find((x) => x.n === n)?.at, live.block(n)?.visibleAt].filter((t): t is number => t !== undefined)
      return times.length > 0 ? Math.min(...times) : undefined
    }
    transient = undefined
    if (visibleOf(xRow.blockNumber) !== undefined) {
      if (panel) sealed = sealedLine(xRow.blockNumber)
      else wstep(sealedLine(xRow.blockNumber))
    }
    else showNote(`block ${xRow.blockNumber} was not visible on the sequencer RPC within the wait, so it is not shown as sealed.`)

    // --- Gather what was observed
    live.flush()
    const blockRows = (n: number) => st.rows.filter((r) => r.blockNumber === n).sort((a, b) => a.txIndex - b.txIndex)
    const roundOf = (rows: LiveRow[], r: number) => rows.filter((x) => x.pgaRound === r)
    const rowsN = blockRows(B)
    const x = xRow
    const xRows = roundOf(blockRows(x.blockNumber), x.pgaRound ?? 0)
    const lead = visibleOf(x.blockNumber) === undefined ? undefined : visibleOf(x.blockNumber)! - x.receivedAt
    const j = judgeRound2Injection({
      ordering: params.ordering,
      targetBlock: B,
      block: x.blockNumber,
      round: x.pgaRound,
      indexInRound: indexWithinRound(xRows, x),
      competitors: xRows.length - 1,
      leadMs: lead,
      tipGwei,
    })
    const hashesOf = (rows: LiveRow[]) => rows.map((r) => r.hash as string)
    const landedInTarget = x.blockNumber === B
    const inRound2 = landedInTarget && x.pgaRound === 2
    const compHashes = competitors.map((c) => c.hash as string)
    const labels = labelTxs(hashesOf(roundOf(rowsN, 1)), hashesOf(roundOf(rowsN, 2)), ours.hash, landedInTarget ? [] : hashesOf(xRows), compHashes)
    const arrivalErrors: string[] = []
    const arrivalsOf = (r: number) =>
      readArrivals(sendUrl, B, r).catch((e: unknown) => {
        arrivalErrors.push(`sim_arrivals(${B}, ${r}) failed: ${(e as Error).message}`)
        return [] as ArrivalRec[]
      })
    // sim_arrivals times are wall clock: put them on the same pause-free time line as the rows (the live view retimed those).
    const unpaused = (a: ArrivalRec[]): ArrivalRec[] => a.map((x) => ({ ...x, arrivedAtMs: retimeThrough(st.pauses, x.arrivedAtMs) }))
    const arrivals1 = unpaused(await arrivalsOf(1))
    const arrivals2 = unpaused(await arrivalsOf(2))
    const opts = { originMs: originAfterPauses(target.blockStartMs, target.measuredAt, st.pauses), mine: mineSet, labels, competitors: new Set(competitors.map((c) => c.hash.toLowerCase())), maxRows: 5 }
    const letters = (hs: string[]) => hs.filter((h) => labels.has(h.toLowerCase())).map((h) => labels.get(h.toLowerCase())!)
    const r1Others = hashesOf(roundOf(rowsN, 1)).filter((h) => h.toLowerCase() !== ours.hash.toLowerCase())
    const r2Others = hashesOf(roundOf(rowsN, 2)).filter((h) => h.toLowerCase() !== ours.hash.toLowerCase())
    later(() => {
      // 1. the highlighted line
      wimportant(yourTxLine({ block: x.blockNumber, round: x.pgaRound, indexInRound: indexWithinRound(xRows, x), inRound: xRows.length, tipGwei }))
      if (j.verdict !== 'INCONCLUSIVE' || inRound2) {
        // 2. the two short tables, after the block closed
        printOut(formatTimingTable(rowsN, [...arrivals1, ...arrivals2], visibleOf(B), opts))
        if (inRound2) printOut(formatFcfsComparison(roundOf(rowsN, 2), arrivals2, { ...opts, block: B, round: 2, ordering: params.ordering }).lines)
      }
      // 3. what it shows, and the verdict
      for (const e of arrivalErrors) wnote(`${e}: arrival columns show "(no arrival data)".`)
      printOut(formatRound2Lesson({ ordering: params.ordering, inRound2, round1: letters(r1Others), round1Total: r1Others.length, round2: letters(r2Others), round2Total: r2Others.length }))
      // Observed: the first sentence repeats the highlighted line above; only what it adds (the feed lead) follows.
      const verdict = j.observed ? j.lines.slice(1) : j.lines
      if (verdict.length > 0) (j.observed ? wimportant : wnote)(j.observed ? `YOUR TX: ${verdict.join(' ')}` : verdict.join(' '))
    })
    return { judgement: j, leadMs: lead }
  } finally {
    await endHold(st).catch(() => {}) // never leave the simulator held (also after an error); the lease is the backstop
    reveal[1] = reveal[2] = undefined // an error path must not leave a round hidden in the final frame
    if (panel) {
      await sleep(400).catch(() => {})
      live.flush()
      panel.stop()
      st.panel = undefined // line output stays off: rows seen while the panel draws are never dumped later (Q1)
    }
    for (const fn of afterPanel.splice(0)) fn()
  }
}


async function stopLive(st: State, fast = false): Promise<void> {
  st.panel?.stop()
  st.closingFeed = true
  if (st.traffic) {
    const s = st.traffic.stats()
    if (fast) void st.traffic.stop().catch(() => {}) // interrupted: do not wait for the traffic's in-flight block
    else await st.traffic.stop()
    st.traffic = undefined
    step(`traffic stopped (sent ${s.sent}, confirmed ${s.confirmed})`)
  }
  if (st.client) {
    await st.client.close()
    st.client = undefined
    if (!fast) {
      await st.decoding
      await st.live?.drain() // interrupted: skip, the exit must be prompt
    }
    if (!fast && st.stack.params.ordering === 'pga') wnote(FOOTER) // the footer credits PGA: only on a PGA stack, and never after Ctrl-C (it was not shown)
    st.live = undefined
  }
}

/**
 * F1/F5: the comparison's input for block `block` from the feed rows mine's own connection saw. `retime` takes the simulator's holds out
 * of the rows' receive times (`visibleAt` must already be on the same time line).
 */
async function comparisonInput(
  st: State,
  o: { block: number; feed: readonly { msg: FeedMessageJson; at: number }[]; mine: string; rival: string; rivalBlock?: number; visibleAt: number | undefined; retime: (t: number) => number },
): Promise<BlockComparisonInput> {
  const rows: LiveRow[] = []
  for (const f of o.feed) if (f.msg.transaction.block_number === o.block || f.msg.transaction.block_number === o.rivalBlock) rows.push(await decodeLiveRow(f.msg, o.retime(f.at)))
  const p = st.stack.params
  return {
    rows,
    visibleAt: o.visibleAt,
    block: o.block,
    blockMs: p.blockMs,
    k: p.k,
    roundMs: p.roundMs,
    mine: new Set([o.mine.toLowerCase()]),
    rival: new Set([o.rival.toLowerCase()]),
    rivalBlock: o.rivalBlock,
    columns: process.stdout.isTTY ? process.stdout.columns : undefined,
  }
}

/** F1: the race's own block (the one holding mine's claim) with and without Fast Feed, all at once (the unstaged flow). Never changes the verdict: any problem is one NOTE. */
async function printRaceBlockComparison(st: State, input: RaceInput, feed: readonly { msg: FeedMessageJson; at: number }[], retime: (t: number) => number): Promise<void> {
  const landed = input.mine.landed
  if (!landed) return printOut(comparisonSkipNote('mine\'s claim did not land in a block'))
  const block = Number(landed.block)
  if (input.openBlock !== block) return printOut(comparisonSkipNote(`mine's claim landed in block ${block}, not in the block of open (${input.openBlock ?? '?'}), whose visibility was measured`))
  const rivalBlock = input.rival.landed ? Number(input.rival.landed.block) : undefined
  printOut(formatBlockComparison(await comparisonInput(st, { block, feed, mine: input.mine.address, rival: input.rival.address, rivalBlock, visibleAt: input.visibleAt, retime })))
}

/** F3: tips (gwei) of the extra txs in the race's block N (with `open`) and block M (with the rival's claim), and F5's in round 2 of block N behind mine's claim: all below 0.1 (rival) and 0.2 (mine). */
export const RACE_EXTRA_TIPS_GWEI = { first: ['0.05', '0.03', '0.02', '0.01'], second: ['0.04', '0.025', '0.015'], round2: ['0.045', '0.035', '0.025', '0.015'] } as const

/**
 * F3: best-effort extra lower-tip txs for the race's blocks, so the with / without Fast Feed tables have a few rows. Presigned
 * (explicit nonce) and sent through the proxy; any failure is swallowed (they only decorate the comparison, never the verdict).
 * `round2` (F5) resolves once the proxy accepted every one (the hold waits for it). `settled()` is awaited before the comparison is printed.
 */
function raceExtrasSender(st: State): { first: () => void; second: () => void; round2: () => Promise<void>; settled: () => Promise<void> } {
  const { preset } = st
  const pending: Promise<unknown>[] = []
  const batch = (tips: readonly string[]): Promise<void> => {
    const job = (async () => {
      const read = createPublicClient({ transport: http(preset.rpcUrl) })
      const send = createPublicClient({ transport: http(preset.sendUrl) })
      const gas = ((await read.estimateGas({ account: privateKeyToAccount(anvilDevKey(ANVIL_ACCOUNT_MAP.raceExtras[0])).address, to: DEAD, value: 0n })) * 11n) / 10n
      for (const [n, t] of tips.entries()) {
        const acct = privateKeyToAccount(anvilDevKey(ANVIL_ACCOUNT_MAP.raceExtras[n % ANVIL_ACCOUNT_MAP.raceExtras.length]!))
        const nonce = await read.getTransactionCount({ address: acct.address, blockTag: 'pending' })
        const raw: Hex = await presign({ to: DEAD, value: 0n, tip: parseGwei(t), maxFee: INJECT_MAX_FEE, nonce, gas, account: acct, chain: { id: preset.chainId } })
        await send.sendRawTransaction({ serializedTransaction: raw }).catch(() => undefined)
      }
    })().catch(() => undefined)
    pending.push(job)
    return job
  }
  return {
    first: () => void batch(RACE_EXTRA_TIPS_GWEI.first),
    second: () => void batch(RACE_EXTRA_TIPS_GWEI.second),
    round2: () => batch(RACE_EXTRA_TIPS_GWEI.round2),
    settled: async () => void (await Promise.allSettled(pending)),
  }
}

/** F5: the note printed when the stages cannot be shown (the hold was refused, missing or on another block). */
export const stagesFallbackNote = (reason: string): string => `could not hold the simulator after round 1 (${reason}): the race block is shown in one go, without stages.`

async function chapter5(st: State, io: { prompt?: () => Promise<void> } = {}): Promise<void> {
  const { preset } = st
  await stopLive(st)
  await sleep(st.stack.params.roundMs + 500) // let the last in-flight traffic transactions land: the race starts quiet
  try {
    const sc = SCENARIOS.s3
    step(sc.title)
    note(
      `The trigger: the operator opens a Race. Mine sees Opened on the Fast Feed and fires a claim it pre-signed with tip ${gwei(sc.mineTip)} gwei before the trigger; ` +
        `the rival polls the RPC and has pre-signed tip ${gwei(sc.rivalTip)} gwei.`,
    )
    note(`round = ${st.stack.params.roundMs}ms; rival: ${strategyOf(sc, 'rival', { pollMs: DEFAULT_POLL_MS })}; mine: ${strategyOf(sc, 'mine')}. Locally K = ${st.stack.params.k} rounds share a block, so a round is named by its block and pga_round.`)
    const rc = await makeRaceContext(preset, {
      attached: st.stack.attached,
      ticketBots: 'mine', // only mine uses the feed: the poller needs no ticket
      ids: { mine: st.mine, rival: newIdentity('rival', ANVIL_ACCOUNT_MAP.raceRival) },
      session: st.session,
    })
    const params = st.stack.params
    const mineAddr = rc.ids.mine.account.address
    const rivalAddr = rc.ids.rival.account.address
    const operator = new Set([rc.operator.address.toLowerCase()])
    const retime = (t: number): number => retimeThrough(st.pauses, t) // the holds (and the Enter waits) are not part of any time shown
    // F1: mine's own feed connection already sees every message; keep them to show the race's block with Fast Feed.
    let raceFeed: { msg: FeedMessageJson; at: number }[] = []
    const local = rc.preset.mode === 'local'
    let noted = false
    let attempt = 0
    let extras = raceExtrasSender(st) // F3: per attempt, best effort
    let visibleRaw: number | undefined // the probe's wall time for block N (stage 2 and 3 use this one value)
    let finalVisible: () => number | undefined = () => undefined
    let tryInput: RaceInput | undefined // the finished race, for stage 3

    const feedRows = (block: number, round: number) => raceFeed.filter((f) => f.msg.transaction.block_number === block && f.msg.pga_round === round).length
    const attemptOnce = async () => {
      attempt++
      const attemptNo = attempt
      raceFeed = []
      extras = raceExtrasSender(st)
      visibleRaw = undefined
      tryInput = undefined
      let held: number | undefined // block N once the hold took effect
      const url = st.preset.sendUrl
      const rpc: SimRpcFn = (m, p) => simRpc(url, m, p)
      let armedHold: SimHold | undefined
      const cmp = async (o: { rivalBlock?: number; visibleAt: number | undefined }) =>
        comparisonInput(st, { block: held!, feed: raceFeed, mine: mineAddr, rival: rivalAddr, retime, ...o })
      const prompt = io.prompt && attemptNo === 1 ? io.prompt : undefined
      const s = new RaceStager({
        arm: async () => {
          if (!local) return { ok: false, reason: 'not a local stack' }
          const r = await armHold({ rpc, holder: holderName(), onArmed: (h) => ((armedHold = h), (st.hold = h)) })
          return r.ok ? { ok: true } : r
        },
        waitHeld: async () => {
          const r = await waitHeld({ rpc, hold: armedHold!, timeoutMs: 2 * params.roundMs + 10_000, onHeld: (h, chainNow) => adoptHold(st, h, chainNow), onTimeout: () => endHold(st) })
          if (r.ok) held = r.block
          return r
        },
        release: () => endHold(st),
        showStage1: async (block) => {
          await until(() => feedRows(block, 1) > 0, 10_000, 'round 1 of the race block on the Fast Feed').catch(() => {})
          await sleep(350) // longer than a round's publish: the whole round is in
          wnote(`the demo holds the simulator after round 1 of block ${block} (Arbitrum never does): mine's claim and a few more txs wait in the queue for round 2.`)
          await printOutPaced(st, formatComparisonStage(await cmp({ visibleAt: undefined }), 1))
          if (prompt) wimportant(`Press Enter: resume the simulator, round 2 of block ${block} runs now`)
        },
        sendRound2Extras: () => extras.round2(),
        prompt: prompt ? () => prompt() : undefined,
        sleep: async (ms) => void (await sleep(ms)),
        showStage2: async (visibleAt) => {
          await sleep(250) // the rest of round 2's rows are in
          const v = visibleAt === undefined ? finalVisible() : retime(visibleAt)
          await printOutPaced(st, formatComparisonStage(await cmp({ visibleAt: v }), 2))
        },
        hasStage3: () => {
          const inp = tryInput
          return inp !== undefined && inp.mine.landed !== undefined && Number(inp.mine.landed.block) === held && inp.rival.landed !== undefined && Number(inp.rival.landed.block) !== held
        },
        showStage3: async () => {
          const inp = tryInput!
          const v = visibleRaw !== undefined ? retime(visibleRaw) : inp.visibleAt
          printOut(formatComparisonStage(await cmp({ rivalBlock: Number(inp.rival.landed!.block), visibleAt: v }), 3))
        },
        promptStage3:
          io.prompt && attemptNo === 1
            ? async () => {
                wimportant('Press Enter: show the block where the rival\'s claim landed (right side only)')
                await whilePaused(st, io.prompt!)
              }
            : undefined,
        fallbackNote: (reason) => {
          if (noted) return
          noted = true
          wnote(stagesFallbackNote(reason))
        },
      })
      finalVisible = () => tryInput?.visibleAt
      return s
    }

    let last: RaceStager | undefined
    const trial = await runTrialWithRetry(
      async () => {
        const s = (last = await attemptOnce())
        return runTrial(rc, sc, {
          pollMs: DEFAULT_POLL_MS,
          retime,
          onMineFeed: (msg, at) => raceFeed.push({ msg, at }),
          beforeOpenSent: local ? () => s.beforeOpen() : undefined,
          afterMineSent: local ? (b) => s.afterMineSent(b) : undefined,
          onOpenSent: local ? () => extras.first() : undefined,
          beforeClaimsLine: st.pacer.enabled ? () => s.drain() : undefined,
          onOpenBlockVisible: local
            ? (t) => {
                visibleRaw = t
                extras.second()
                s.onVisible(t)
              }
            : undefined,
        })
      },
      (first) => step(`inconclusive (${first.split(':')[0]}); retrying once with a fresh race`),
    )
    if (st.pacer.enabled) await last?.drain() // a paced stage 2 may still be revealing rows: do not interleave the report with it
    const verdict = printTrialReport(trial, sc)
    await extras.settled()
    tryInput = trial.input
    const stagedRun = last?.staged === true
    if (stagedRun) await last!.finish().catch((e: unknown) => printOut(comparisonSkipNote(`${(e as Error).message}`)))
    else await printRaceBlockComparison(st, trial.input, raceFeed, retime).catch((e: unknown) => printOut(comparisonSkipNote(`${(e as Error).message}`)))
    // F5: at most 3 NOTE lines on what the sequencer did, from the rows the feed showed (the streamed [sequencer] narration is off here).
    try {
      const blockN = trial.input.openBlock
      const rivalBlock = trial.input.rival.landed ? Number(trial.input.rival.landed.block) : undefined
      if (blockN !== undefined) {
        const rows: LiveRow[] = []
        for (const f of raceFeed) if (f.msg.transaction.block_number === blockN || f.msg.transaction.block_number === rivalBlock) rows.push(await decodeLiveRow(f.msg, retime(f.at)))
        const rivalSeen = trial.input.rival.seenAt
        printOut(formatSequencerSummary({ block: blockN, rows, operator, mine: new Set([mineAddr.toLowerCase()]), rival: new Set([rivalAddr.toLowerCase()]), rivalSawAfterSealed: rivalSeen !== undefined && trial.input.visibleAt !== undefined ? rivalSeen >= trial.input.visibleAt : undefined }))
      }
    } catch {
      // decoration only: the verdict is printed regardless
    }
    st.race = { input: trial.input, judgement: trial.judgement, verdict }
    const rank = (b: RaceInput['mine']) => `${b.name} rank ${b.rank} (${b.landed ? `block ${b.landed.block} round ${b.landed.pgaRound ?? '?'}` : 'block ?'}, tx_index ${b.landed?.index ?? '?'}, tip ${b.landed ? gwei(b.landed.tip) : '?'} gwei)`
    important(`YOUR TX: ranks: ${rank(trial.input.mine)}; ${rank(trial.input.rival)}`)
    if (raceExitCode(verdict) === 1) throw new Error(`the race FAILED: ${trial.reason.split('\n')[0]}`)
  } finally {
    await endHold(st).catch(() => {}) // never leave the simulator held (also after an error); the lease is the backstop
  }
}

function recap(st: State): void {
  const effect = st.race?.verdict === 'PASS' ? st.race.judgement.effect : undefined
  const tipMax = st.trafficTipMax !== undefined ? gwei(st.trafficTipMax) : '?'
  step('what the Fast Feed did')
  note(
    st.leadMs !== undefined
      ? `It showed us each transaction right after it was ordered, before its block was visible on the RPC (${st.leadMs}ms ahead in chapter 4).`
      : 'It should show each transaction right after it was ordered, before its block is visible; the lead was not measured in this run (see the failure above).',
  )
  note(
    effect === 'both' || effect === 'information'
      ? "That information got us into the NEXT round: mine saw Opened on the feed and was in the following round's waiting list; the rival, which polled, learned it later and landed in a later round."
      : 'Being early on the feed is what puts a bot in the next round; this run did not observe that effect in the race (see chapter 5).',
  )
  note('It cannot jump a transaction that is already ordered. Docs: fast-feed/README.md#live-view, combo/README.md#the-game')
  step('what PGA did')
  note(pgaRecapLine({ observed: st.firstObserved === true, ordering: st.stack.params.ordering, tipGwei: gwei(INJECT_TIP), trafficTipMax: gwei(COMPETITOR_MAX_TIP), failure: st.biggerTipFailure }))
  note("Two rules keep that fair: the nonce rule (a sender's nonce N+1 never goes before N) and the boost (a waiting transaction gains priority every round, so a zero tip still lands). They are not exercised in this demo.")
  note('Docs: pga/README.md#the-nonce-rule-demo-2, pga/README.md#the-boost')
  step('the takeaway')
  note(takeawayLine(st.firstObserved === true && st.race?.verdict === 'PASS'))
}

/** Resolves on the first line from `input`, or when it closes (EOF), so it can never hang a closed stdin. Injectable for tests. */
export function waitEnter(input: Readable = process.stdin): Promise<void> {
  return new Promise<void>((resolve) => {
    const rl = createInterface({ input })
    rl.once('line', () => {
      rl.close()
      resolve()
    })
    rl.once('close', resolve)
  })
}

/**
 * Wait for one Enter keypress WITHOUT echoing it (raw mode), so a panel that is redrawing in place is not shifted by the echoed
 * newline. Raw mode swallows the signal keys, so Ctrl-C AND Ctrl-D (end of input, treated like Ctrl-C: the presenter wants out,
 * not "continue") restore the terminal and raise SIGINT through `raise`. Not a terminal: falls back to `waitEnter`.
 */
export function waitEnterKey(input: NodeJS.ReadStream = process.stdin, raise: (sig: NodeJS.Signals) => void = (sig) => void process.kill(process.pid, sig)): Promise<void> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return waitEnter(input)
  return new Promise<void>((resolve) => {
    const done = () => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
    }
    const onData = (d: Buffer | string) => {
      const s = d.toString()
      if (s.includes('\x03') || s.includes('\x04')) {
        done()
        raise('SIGINT')
      } else if (/[\r\n]/.test(s)) {
        done()
        resolve()
      }
    }
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  let args: DemoArgs
  try {
    args = parseDemoArgs(argv)
  } catch (e) {
    error(`Error: ${(e as Error).message}`)
    error(USAGE)
    return 2
  }
  if (args.mode === 'testnet') {
    error(TESTNET_REFUSAL) // before anything touches the network or the env file
    return 1
  }
  loadDotEnv()
  // A presenter-driven run (--pause on a terminal) that starts its own stack runs it in slow motion (B = 25 s), so the panel is
  // readable. When the demo attaches to a running simulator, that simulator's own times apply (see attachedStackLines).
  const stdinTTY = process.stdin.isTTY === true
  const stdoutTTY = process.stdout.isTTY === true
  const slowmoRun = wantSlowmo({ pause: args.pause, stdinTTY, stdoutTTY, env: process.env })
  if (slowmoRun) process.env.SIM_SLOWMO = '1'
  let preset: Preset
  try {
    preset = getPreset(argv)
  } catch (e) {
    error(`Error: ${(e as Error).message}`)
    error(USAGE)
    return 2
  }

  let delayMs: number
  try {
    delayMs = chapterDelayMs(process.stdout.isTTY === true, args.pause, process.env, process.stdin.isTTY === true)
  } catch (e) {
    error(`Error: ${(e as Error).message}`)
    error(USAGE)
    return 2
  }
  const isTTY = process.stdin.isTTY === true
  // E2: the simulator stands still while the Enter prompt waits (`st` is built below; the callback runs later).
  const pauseOpts: PauseOptions = { pause: args.pause, isTTY, waitEnter: () => whilePaused(st, () => waitEnter()), say: important }
  if (args.pause && !isTTY) note(PAUSE_IGNORED)

  const failures: ChapterFailure[] = []
  const failed = new Set<number>()
  const keyFromEnv = feedApiKey() !== undefined
  const key = feedApiKey() ?? generateKey()
  const mine = newIdentity('mine', ANVIL_ACCOUNT_MAP.raceMine, key) // the key stays in memory: only its hash is ever printed
  const paceAbort = new AbortController() // Ctrl-C ends a pending paced reveal at once
  const pacer = new RowPacer({ enabled: rowPacingEnabled(process.stdout.isTTY, process.env), signal: paceAbort.signal })
  const st: State = { preset, stack: { attached: false, params: preset.local! }, mine, keyFromEnv, closingFeed: false, decoding: Promise.resolve(), rows: [], pauses: [], pacer }
  let stop = async () => {}

  // Ctrl-C: stop the traffic, the feed connection and the stack we own (Anvil included), then exit 130.
  let interrupted = false
  const onSignal = () => {
    paceAbort.abort()
    interrupted = true // from here no chapter failure is printed: the exit is always 130
    st.panel?.stop() // restores the cursor first (the panel also listens to the signal itself)
    void (async () => {
      await Promise.race([endHold(st).catch(() => {}), sleep(2000)]) // never leave a running simulator frozen (the lease is the backstop)
      await stopLive(st, true).catch(() => {})
      await stop().catch(() => {})
      if (panelAllowed(process.stdout.isTTY)) process.stdout.write(SHOW_CURSOR) // idempotent: the last thing written on a terminal
      process.exit(130)
    })()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  let delayedBefore = false
  const run = async (c: Chapter, body: () => Promise<void>): Promise<void> => {
    if (interrupted) return
    // A hands-off delay uses ticket time like a pause does, so chapters 4-5 re-check the ticket after one.
    const realPause = c.n > 1 ? await pauseBefore(pauseOpts, c) : false
    const paused = realPause || (delayedBefore && c.n >= 4)
    delayedBefore = false
    const [gap, head, readMore] = chapterHeader(c)
    plain(gap)
    important(head!)
    note(readMore!)
    try {
      // After a pause or delay, and whenever the tickets are about to run out (E2: with the simulator frozen a pause no longer uses ticket time).
      if (c.n === 4) await reportRenewal(st)
      const roundMs = st.stack.params.tickets.roundSeconds * 1000
      if (c.n > 3 && (paused || ticketNeedsRefresh({ session: st.session, nowMs: chainNowMs(), roundMs, blockMs: st.stack.params.blockMs, chapter: c.n }))) await refreshTickets(st, c.n, realPause)
      await body()
    } catch (e) {
      if (interrupted) return
      const what = (e as Error).message + (c.n === 4 ? expiryNote(st) : '')
      failures.push({ chapter: c.n, what })
      failed.add(c.n)
      result('FAIL', `FAILED (chapter ${c.n}): ${what}`)
      return // a failed chapter is not followed by the reading delay
    } finally {
      // Hands-off mode: stop after each chapter (not after the last) so a presenter can read it. Never on a non-TTY.
      if (!failed.has(c.n) && !interrupted && delayMs > 0 && c.n < CHAPTERS.length) {
        await sleep(delayMs)
        delayedBefore = true
      }
    }
  }
  const [c1, c2, c3, c4, c5, c6] = CHAPTERS as [Chapter, Chapter, Chapter, Chapter, Chapter, Chapter]

  try {
    await run(c1, async () => {
      const { startOrAttach } = await import('../sim/index.ts') // sim code is local-only
      const { printCompactBanner } = await import('../sim/banner.ts')
      await chapter1(async () => {
        // The banner, the build and the stack start are printed by startOrAttach.
        const stack = await startOrAttach(preset.local!, preset.chainId, { build: true, quiet: true, bannerPrinter: (bp, attached) => printCompactBanner(bp, { pauseSlowmo: slowmoRun && !attached }) })
        stop = stack.stop
        st.preset = preset = await resolvePreset(preset)
        st.stack = { attached: stack.attached, params: stack.params }
        if (stack.attached && args.pause && stdinTTY && stdoutTTY) for (const l of attachedStackLines(stack.params)) note(l)
        st.bg = startBackgroundTicket(st) // silent; chapter 3 reports it
      })
    })
    if (failed.has(1)) return 1 // nothing else can run without the stack
    await run(c2, () => chapter2(st))
    await run(c3, () => chapter3(st))
    if (!failed.has(3)) {
      // The Enter prompt of the block story runs with the simulator already held (E3); the prompt before the next chapter freezes it as usual.
      await run(c4, () => chapter4(st, { prompt: args.pause && isTTY ? () => waitEnterKey() : undefined }))
      await stopLive(st).catch(() => {}) // the live view and the traffic end with chapter 4, so the race starts quiet
    } else note('chapter 4 skipped: it needs the ticket from chapter 3')
    if (!failed.has(3)) await run(c5, () => chapter5(st, { prompt: args.pause && isTTY ? () => waitEnterKey() : undefined }))
    else note('chapter 5 skipped: it needs the ticket from chapter 3')
    await stopLive(st).catch(() => {})
    if (interrupted) return 130
    await run(c6, async () => {
      recap(st)
      plain()
      for (const f of failures) result('FAIL', `FAILED: chapter ${f.chapter} (${CHAPTERS[f.chapter - 1]!.title}): ${f.what}`)
      important(whyLine(st.race?.input, st.race?.judgement))
    })
    return interrupted ? 130 : demoExitCode(failures, st.race?.verdict)
  } finally {
    await stopLive(st).catch(() => {})
    await stop()
  }
}

// Run only as the entry point (tests import the pure helpers).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      error(`Error: ${(e as Error).message}`)
      process.exit(1)
    },
  )
}
