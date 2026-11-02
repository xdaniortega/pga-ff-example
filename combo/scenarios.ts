// `npm run race -- --local --scenario s1|s2|s3|matrix [--trials N] [--poll-ms N] [--mine-delay-ms N] [--preset slow|fast]`:
// Fast Feed + PGA together (C1 S1, C2 S2, S3 and the matrix). Concepts and expected output: combo/README.md.
//
// "Information gets you into the round; the tip wins the round." A Race is opened by the operator; two bots want rank 1:
//   S1  both bots see `Opened` on the Fast Feed. The rival fires first with a low tip, mine 50ms later with a high tip:
//       both claims share the round after open's, so the TIP decides (mine wins).
//   S2  the rival POLLS the RPC (a high tip), mine uses the Fast Feed (a low tip): the rival sees `Opened` a round or more
//       later, so INFORMATION decides: mine is in an earlier round, and a tip cannot buy a round you are not in.
//   S3  the same, but mine also tips more: information AND tip (it would win a same-round tie too).
// `matrix` runs S1, S2 and S3 `--trials N` times each in one process and one ticket session, and prints one table.
//
// Exit codes: 0 the expected winner is rank 1 (matrix: in every trial); 1 FAIL (the expected winner lost, or an error);
// 3 inconclusive (the scenario did not play out as designed; none failed); 2 usage.
// `runTrial` is the one function every scenario and every matrix trial goes through; `RaceContext.session` keeps the
// tickets (and their renewals) between trials.
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, parseGwei, type Address, type Hex } from 'viem'
import { ConfigError, getPreset, loadDotEnv, resolvePreset, type Preset } from '../shared/config.ts'
import { chainNowMs } from '../shared/clock.ts'
import type { FeedMessageJson } from '../fast-feed/client/client.ts'
import { waitBlockVisible } from '../fast-feed/client/live.ts'
import { error, internal, note, noteLines, noteText, plain, result, setInternalVisible, step, verdictOfCode } from '../shared/narrate.ts'
import { collectLanded, exitCode, gwei, runWithRetry, syncToBlockStart, type Env, type Verdict } from '../pga/bot/common.ts'
import { assertAllowedChain } from '../pga/bot/bot.ts'
import {
  buyTickets,
  ClaimBot,
  currentRoundEnd,
  isRaceOpen,
  localIdentities,
  localOperator,
  makeReader,
  PollingBot,
  presignClaim,
  presignOpen,
  readRank,
  readWinner,
  renewDecision,
  renewTickets,
  ticketsUsable,
  type BotIdentity,
  type RaceBot,
  type RaceReader,
  type TicketSession,
} from './race.ts'

/** The scenarios this command knows (the `matrix` runs all of them). */
export type ScenarioId = 's1' | 's2' | 's3'
/** What decided who ranked first. */
export type Effect = 'tip' | 'information' | 'both'

export interface Scenario {
  id: ScenarioId
  title: string
  /** Who must be rank 1 for the scenario to pass. */
  expectedWinner: 'mine' | 'rival'
  /** Bids, wei. */
  rivalTip: bigint
  mineTip: bigint
  /** Ms each bot waits after seeing `Opened` before it sends. */
  rivalDelayMs: number
  mineDelayMs: number
  /** How the rival learns about `Opened`: the Fast Feed, or polling the RPC. Mine always uses the Fast Feed. */
  rivalVia: 'feed' | 'poll'
  /** The effect the scenario is designed to show. */
  effect: Effect
}

export const DEFAULT_MINE_DELAY_MS = 50
export const DEFAULT_POLL_MS = 250
export const DEFAULT_TRIALS = 5

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  s1: {
    id: 's1',
    title: 'S1: both bots see Opened on the Fast Feed; the rival fires first with a low tip, mine fires later with a high tip',
    expectedWinner: 'mine',
    rivalTip: parseGwei('0.001'),
    mineTip: parseGwei('0.1'),
    rivalDelayMs: 0,
    mineDelayMs: DEFAULT_MINE_DELAY_MS,
    rivalVia: 'feed',
    effect: 'tip',
  },
  s2: {
    id: 's2',
    title: 'S2: speed beats tip: the rival polls the RPC with a high tip; mine uses the Fast Feed with a low tip',
    expectedWinner: 'mine',
    rivalTip: parseGwei('0.1'),
    mineTip: parseGwei('0.001'),
    rivalDelayMs: 0,
    mineDelayMs: 0,
    rivalVia: 'poll',
    effect: 'information',
  },
  s3: {
    id: 's3',
    title: 'S3: the headline: the rival polls the RPC with tip 0.1; mine uses the Fast Feed with tip 0.2',
    expectedWinner: 'mine',
    rivalTip: parseGwei('0.1'),
    mineTip: parseGwei('0.2'),
    rivalDelayMs: 0,
    mineDelayMs: 0,
    rivalVia: 'poll',
    effect: 'both',
  },
}

export interface RaceArgs {
  scenario: ScenarioId | 'matrix'
  /** Overrides mine's delay. S1 (and the matrix's S1) only: S2 and S3 fire mine at once, so the flag is rejected there. */
  mineDelayMs?: number
  /** Poll period of the polling rival (S2, S3). */
  pollMs: number
  /** True when `--poll-ms` was given (S1 has no polling bot: main warns). */
  pollMsGiven: boolean
  /** Trials per scenario (matrix only). */
  trials: number
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i >= 0) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new ConfigError(`${name} needs a value.`)
    return v
  }
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
}

function intFlag(argv: readonly string[], name: string, min: number, max: number, what: string): number | undefined {
  const v = flagValue(argv, name)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max} (${what}).`)
  return n
}

/** `--scenario s1|s2|s3|matrix` (default s1), `--mine-delay-ms N` (N >= 1), `--poll-ms N`, `--trials N` (matrix only). */
export function parseRaceArgs(argv: readonly string[]): RaceArgs {
  const s = (flagValue(argv, '--scenario') ?? 's1').toLowerCase()
  if (s !== 'matrix' && !Object.hasOwn(SCENARIOS, s)) throw new ConfigError(`Unknown scenario "${s}". Use s1, s2, s3 or matrix.`)
  const mineDelayMs = intFlag(argv, '--mine-delay-ms', 1, 60_000, 'mine must fire after the rival')
  const pollMs = intFlag(argv, '--poll-ms', 10, 60_000, 'how often the polling rival asks the RPC') ?? DEFAULT_POLL_MS
  if (mineDelayMs !== undefined && s !== 's1' && s !== 'matrix') throw new ConfigError('--mine-delay-ms applies to S1 (and the matrix\'s S1) only: in S2 and S3 mine fires at once.')
  const pollGiven = flagValue(argv, '--poll-ms') !== undefined
  const trials = intFlag(argv, '--trials', 1, 100, 'trials per scenario')
  if (trials !== undefined && s !== 'matrix') throw new ConfigError('--trials applies to --scenario matrix only.')
  return { scenario: s as RaceArgs['scenario'], mineDelayMs, pollMs, pollMsGiven: pollGiven, trials: trials ?? DEFAULT_TRIALS }
}

/** What one bot did, from its watcher, the sequencer and the chain. */
export interface BotResult {
  name: 'mine' | 'rival'
  address: Address
  /** How it learned about `Opened`. Default feed. */
  via?: 'feed' | 'poll'
  /** Wall-clock ms: the bot learned about Opened / the claim was sent. */
  seenAt?: number
  sentAt?: number
  /** From the receipt (effectiveGasPrice - base fee, wei), and where it landed. */
  landed?: { block: bigint; index: number; tip: bigint; pgaRound?: number; /** Set locally when sim_boostTrace could not name the round. */ roundUnknown?: boolean }
  /** From Race.rankOf: 1 = winner, 0 = not recorded. */
  rank: number
}

export interface RaceInput {
  scenario: ScenarioId
  id: bigint
  expectedWinner: 'mine' | 'rival'
  /** The stack's ordering (`sim_info.ordering`): a tip decides a round only under 'pga'. */
  ordering: 'pga' | 'fifo'
  mine: BotResult
  rival: BotResult
  /** Race.winner(id). */
  winner: Address
  /** The block number the feed message for `open` carried. */
  openBlock?: number
  /** Wall-clock ms when that block became visible on the RPC (measured), if it did. */
  visibleAt?: number
  /** The polling rival's period, ms. */
  pollMs?: number
}

export interface RaceJudgement {
  verdict: Verdict
  reason: string
  /** Who holds rank 1, when known. */
  rankOne?: 'mine' | 'rival'
  /** What decided it, as observed (PASS only). */
  effect?: Effect
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

type LandedAt = NonNullable<BotResult['landed']>
/** Two claims share a round when they share a block AND (locally, where pga_round is known) the pga_round. */
export const sameRound = (a: LandedAt, b: LandedAt): boolean => a.block === b.block && (a.pgaRound === undefined || b.pgaRound === undefined || a.pgaRound === b.pgaRound)
/** `a` is in an earlier round than `b`: an earlier block, or the same block and an earlier pga_round (unknown rounds compare as equal). */
export const roundBefore = (a: LandedAt, b: LandedAt): boolean => a.block < b.block || (a.block === b.block && a.pgaRound !== undefined && b.pgaRound !== undefined && a.pgaRound < b.pgaRound)
/** "block 12 round 2" (just "block 12" where the round is unknown). */
export const roundLabel = (l: LandedAt): string => `block ${l.block}${l.pgaRound !== undefined ? ` round ${l.pgaRound}` : ''}`
const before = (a: NonNullable<BotResult['landed']>, b: NonNullable<BotResult['landed']>) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1)

/** Checks every scenario shares once both claims landed: ranks recorded, consistent with the block order, `winner()` agrees. */
function integrity(i: RaceInput): RaceJudgement | undefined {
  const done = (reason: string, rankOne?: 'mine' | 'rival'): RaceJudgement => ({ verdict: 'FAIL', reason, rankOne })
  if (i.rival.rank === 0 || i.mine.rank === 0) {
    return done(`a claim was not recorded by the contract (rank rival ${i.rival.rank}, mine ${i.mine.rank}): it reached the chain before the race was open, or twice.`)
  }
  const first = before(i.rival.landed!, i.mine.landed!) < 0 ? i.rival : i.mine
  const second = first === i.rival ? i.mine : i.rival
  if (first.rank > second.rank) {
    return done(`the contract's ranks (rival ${i.rival.rank}, mine ${i.mine.rank}) disagree with the block order (rival block ${i.rival.landed!.block} idx ${i.rival.landed!.index}, mine block ${i.mine.landed!.block} idx ${i.mine.landed!.index}).`)
  }
  const one = i.mine.rank === 1 ? i.mine : i.rival
  if (!eq(i.winner, one.address)) return done(`winner(id) = ${i.winner} is not the rank-1 claimer ${one.address} (${one.name}).`, one.name)
  return undefined
}

/** Pure: judge one trial. Each scenario passes only when the effect it is about was observed, not merely when mine won. */
export function judgeRace(i: RaceInput): RaceJudgement {
  const bots = [i.rival, i.mine]
  const done = (verdict: Verdict, reason: string, rankOne?: 'mine' | 'rival', effect?: Effect): RaceJudgement => ({ verdict, reason, rankOne, effect })
  const noReceipt = bots.filter((b) => !b.landed).map((b) => b.name)
  if (noReceipt.length > 0) return done('FAIL', `no receipt for the claim of ${noReceipt.join(' and ')}: it never landed.`)
  const unsent = bots.filter((b) => b.sentAt === undefined).map((b) => b.name)
  if (unsent.length > 0) return done('FAIL', `${unsent.join(' and ')} never fired its claim (it never saw Opened).`)
  const [rl, ml] = [i.rival.landed!, i.mine.landed!]
  // A real FAIL (wrong winner, missing state) must not be masked by an unreadable round.
  const early = integrity(i)
  if (early) return early
  const unknown = bots.filter((b) => b.landed!.roundUnknown).map((b) => b.name)
  if (unknown.length > 0) {
    return done('INCONCLUSIVE', `the round (pga_round) of the claim of ${unknown.join(' and ')} could not be read from the simulator (sim_boostTrace), so whether the claims shared a round is unknown: rerun.`)
  }
  const sameBlock = sameRound(rl, ml)

  if (i.scenario === 's1') {
    if (!sameBlock) {
      return done(
        'INCONCLUSIVE',
        `the claims landed in different rounds (rival ${roundLabel(rl)}, mine ${roundLabel(ml)}): the earlier round wins whatever the tips, so this says nothing about the tip. Rerun.`,
      )
    }
    if (!(i.rival.sentAt! < i.mine.sentAt!)) {
      return done('INCONCLUSIVE', 'the rival did not fire before mine, so the scenario did not play out as designed (mine must be later). Rerun.')
    }
  }
  if (i.scenario === 's2' && sameBlock) {
    return done(
      'INCONCLUSIVE',
      `the rival made it into mine's round (both claims landed in ${roundLabel(ml)}): its poll${i.pollMs ? ` (every ${i.pollMs}ms)` : ''} saw Opened before the next round started, so it lost no round and information did not decide; the tip (or arrival) ranked the claims. S2 needs the rival to land in a later round: rerun, or poll more slowly (--poll-ms).`,
    )
  }
  const one = i.mine.rank === 1 ? i.mine : i.rival
  const two = one === i.mine ? i.rival : i.mine
  const mismatch = (): RaceJudgement =>
    done(
      'FAIL',
      `${one.name} ranks first (tip ${gwei(one.landed!.tip)} gwei, ${roundLabel(one.landed!)}) ahead of ${two.name} (tip ${gwei(two.landed!.tip)} gwei, ${roundLabel(two.landed!)}), but ${i.expectedWinner} was expected to win. ` +
        (i.scenario === 's1' && one.name === 'rival'
          ? 'The rival fired first and the sequencer ranked by arrival instead of by tip: is PGA ordering off (the simulator started with --fifo)?'
          : one.name === 'rival' && sameBlock && i.ordering === 'fifo'
            ? 'The stack orders by arrival (FIFO), so the tip did not count.'
            : 'The order does not match the scenario.'),
      one.name,
    )
  if (one.name !== i.expectedWinner) return mismatch()
  const tipWon = one.landed!.tip > two.landed!.tip
  const tips = `tip ${gwei(one.landed!.tip)} gwei vs ${gwei(two.landed!.tip)} gwei`

  if (i.scenario === 's2' || i.scenario === 's3') {
    if (!sameBlock) {
      const gap = i.rival.seenAt !== undefined && i.mine.seenAt !== undefined ? ` The rival learned of Opened ${Math.round(i.rival.seenAt - i.mine.seenAt)}ms after mine.` : ''
      const rivalTipped = i.rival.landed!.tip > i.mine.landed!.tip
      const text =
        `mine ranks first: it landed in ${roundLabel(ml)}, the rival (polling the RPC${i.pollMs ? ` every ${i.pollMs}ms` : ''}) in a LATER round, ${roundLabel(rl)}.${gap} ` +
        (rivalTipped ? `The rival tipped more (${gwei(rl.tip)} gwei vs mine ${gwei(ml.tip)} gwei), but a tip cannot buy a round you are not in: ` : 'The earlier round wins whatever the tips: ') +
        'information decided' +
        (i.scenario === 's3'
          ? tipWon && i.ordering === 'pga'
            ? ', and mine also tipped more, so it would have won a same-round tie as well (both).'
            : tipWon
              ? ', and mine tipped more, but on a FIFO sequencer the tip would not have counted in a same-round tie.'
              : '.'
          : '.')
      return done('PASS', text, one.name, i.scenario === 's3' && tipWon && i.ordering === 'pga' ? 'both' : 'information')
    }
    // Both claims share a block (S3; S2 was handled above): only the tip can have ranked them.
    if (i.ordering === 'fifo') return done('INCONCLUSIVE', `FIFO: arrival decided, not the tip (both claims landed in ${roundLabel(ml)}; mine arrived first). Start the simulator without --fifo.`)
    if (!tipWon) return done('INCONCLUSIVE', `both claims landed in ${roundLabel(ml)} and mine did not out-tip the rival (${tips}): nothing but arrival can explain the order. Rerun.`)
    return done('PASS', `mine ranks first: both claims landed in ${roundLabel(ml)}, so the TIP decided (${tips}).`, one.name, 'tip')
  }

  // S1
  if (i.ordering === 'fifo') return done('INCONCLUSIVE', `FIFO: arrival decided, not the tip (the stack orders by arrival, ${one.name} ranked first; its tip ${gwei(one.landed!.tip)} gwei vs ${gwei(two.landed!.tip)} gwei did not count). Start the simulator without --fifo.`)
  if (!tipWon) return done('INCONCLUSIVE', `${one.name} ranks first without the higher tip (${tips}): the tip did not decide. Rerun.`)
  const lead = i.mine.sentAt! - i.rival.sentAt!
  return done(
    'PASS',
    `${one.name} (tip ${gwei(one.landed!.tip)} gwei) ranks first although the rival was sent ${lead}ms earlier with tip ${gwei(i.rival.landed!.tip)} gwei: ` +
      'both claims were in the same round, so the TIP decided, not the send time. The Fast Feed got each bot into that round; it did not decide who won it.',
    one.name,
    'tip',
  )
}

export interface TimelineInput {
  id: bigint
  /** Wall-clock ms: when the first bot saw Opened. */
  t0: number
  openBlock?: number
  /** Wall-clock ms when `openBlock` became visible on the RPC (measured). */
  visibleAt?: number
  /** Stack ordering; undefined is treated as PGA. A tip decides a round only under PGA. */
  ordering?: 'pga' | 'fifo'
  mine: BotResult
  rival: BotResult
}

/** Probe period of the block-visibility measurement, ms. */
export const PROBE_MS = 25

/**
 * Pure: the time the block is known to have been visible by. The probe only gives an upper bound (it polls every
 * PROBE_MS), and a polling rival that SAW the log proves the block was visible no later than that.
 */
export function visibleBy(probeAt: number | undefined, rival: { via?: 'feed' | 'poll'; seenAt?: number }): number | undefined {
  const seen = rival.via === 'poll' ? rival.seenAt : undefined
  if (probeAt === undefined) return seen
  return seen === undefined ? probeAt : Math.min(probeAt, seen)
}

const offset = (t: number, t0: number) => `t0+${Math.round(t - t0)}ms`

/** Pure: the timeline lines. The last line names the deciding effect. */
export function formatTimeline(t: TimelineInput): string[] {
  const bots = [t.rival, t.mine]
  const seen = bots.filter((b) => b.seenAt !== undefined).sort((x, y) => x.seenAt! - y.seenAt!).map((b) => `${b.name}${b.via === 'poll' ? ' (poll)' : ''} ${offset(b.seenAt!, t.t0)}`).join(', ')
  const visible = t.visibleAt !== undefined ? `, visible on RPC by ${offset(t.visibleAt, t.t0)} (probe every ${PROBE_MS}ms)` : ', not seen on the RPC within the wait'
  const lines = [`feed saw Opened(${t.id}) at t0${t.openBlock !== undefined ? ` (the message for block ${t.openBlock}${visible})` : ''}  [${seen}]`]
  for (const b of [...bots].sort((x, y) => (x.sentAt ?? Infinity) - (y.sentAt ?? Infinity))) {
    lines.push(b.sentAt === undefined ? `${b.name} never sent` : `${b.name} sent at ${offset(b.sentAt, t.t0)} (tip ${b.landed ? gwei(b.landed.tip) : '?'} gwei)`)
  }
  const landed = bots.filter((b) => b.landed)
  if (landed.length === 2) {
    const [a, b] = [...landed].sort((x, y) => before(x.landed!, y.landed!))
    const rank = (r: number) => (r > 0 ? `rank ${r}` : 'not recorded')
    if (sameRound(a!.landed!, b!.landed!)) {
      lines.push(`${roundLabel(a!.landed!)}: ${a!.name} idx ${a!.landed!.index} (${rank(a!.rank)}), ${b!.name} idx ${b!.landed!.index} (${rank(b!.rank)})`)
      lines.push(
        a!.landed!.tip > b!.landed!.tip
          ? t.ordering === 'fifo'
            ? `same round, but the stack orders by arrival (FIFO): the higher tip (${a!.name}) ranked first by arrival, the tip did not count`
            : 'same round → higher tip wins'
          : a!.landed!.tip === b!.landed!.tip
            ? 'same round, equal tips: arrival order decided'
            : `same round, but the lower tip (${a!.name}) ranks first: not tip order`,
      )
    } else {
      if (t.openBlock !== undefined) lines.push(`open in block ${t.openBlock}; ${a!.name} landed in ${roundLabel(a!.landed!)}, ${b!.name} in ${roundLabel(b!.landed!)} (K rounds share a block: a round is identified by block and pga_round)`)
      lines.push(`${roundLabel(a!.landed!)}: ${a!.name} idx ${a!.landed!.index} (${rank(a!.rank)}); ${roundLabel(b!.landed!)}: ${b!.name} idx ${b!.landed!.index} (${rank(b!.rank)})`)
      lines.push('different rounds → the earlier round wins, whatever the tips')
    }
  }
  return lines
}

/** One claim's view of the sequencer (from the local-only `sim_boostTrace`). */
export interface ClaimQueueRow {
  name: string
  /** Queue priority on arrival (= effective tip, no boost yet), wei, and the round it arrived in. */
  priority: bigint
  arrivalRound: number
  /** Rank in the drained order (1 = first). */
  drained: number
}

/** Pure: the `[sequencer]` summary of the claim round, for a simulator that runs in another terminal. */
export function claimRoundLines(rows: readonly ClaimQueueRow[], arrivalOrder: readonly string[]): string[] {
  if (rows.length === 0) return []
  const rounds = [...new Set(rows.map((r) => r.arrivalRound))]
  const byArrival = [...rows].sort((a, b) => arrivalOrder.indexOf(a.name) - arrivalOrder.indexOf(b.name))
  const drained = [...rows].sort((a, b) => a.drained - b.drained)
  if (rounds.length > 1) return [`the claims arrived in different rounds (${rounds.join(', ')}): each was drained in its own round`]
  return [
    `round ${rounds[0]}: waiting list, in arrival order: ${byArrival.map((r) => `${r.name} (queue priority ${gwei(r.priority)} gwei)`).join(', ')}`,
    `round ${rounds[0]}: drained, ${drained.map((r) => `${r.drained}. ${r.name}`).join(', ')} (see the simulator terminal for the full queue)`,
  ]
}

async function simTrace(url: string, hash: Hex): Promise<{ round: number; priority: string; included: boolean }[] | null> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sim_boostTrace', params: [hash] }) })
    const body = (await res.json()) as { result?: { round: number; priority: string; included: boolean }[] | null }
    return body.result ?? null
  } catch {
    return null
  }
}

/** What a trial needs; built once per race process. `session` carries the tickets from trial to trial (the matrix runs many). */
export interface RaceContext {
  preset: Preset
  chainId: number
  env: Env
  reader: RaceReader
  ids: { mine: BotIdentity; rival: BotIdentity }
  operator: ReturnType<typeof localOperator>
  /** True when the stack runs in another terminal (its [sequencer] lines are not in our output). */
  attached: boolean
  /** The stack's ordering (`sim_info.ordering`; the testnet sequencer is PGA). */
  ordering: 'pga' | 'fifo'
  /** Who holds a ticket: only the feed bots need one. A matrix buys for both (one session for all its trials). */
  ticketBots: 'both' | 'mine'
  session?: TicketSession
  /** The longest trial so far, ms: ticket renewal makes sure no rollover can hit a trial that long. */
  trialMs?: number
}

export interface Trial {
  id: bigint
  judgement: RaceJudgement
  input: RaceInput
  timeline: string[]
}

export interface TrialOptions {
  /** Overrides the scenario's delay for "mine". */
  mineDelayMs?: number
  /** The polling rival's period. */
  pollMs?: number
  /** F1: receives every feed message of mine's own connection. */
  onMineFeed?: (msg: FeedMessageJson, receivedAt: number) => void
  /** F3: called (not awaited) right after `open` was sent. Must never throw into the trial. */
  onOpenSent?: () => void
  /** F3: called (not awaited) when the block holding `open` became visible on the RPC (F5: with the wall time it was first seen). Must never throw into the trial. */
  onOpenBlockVisible?: (visibleAt: number) => void
  /** F6: awaited (best effort) before the `both claims are sent` line, so it cannot land inside a paced table the demo is still revealing. */
  beforeClaimsLine?: () => Promise<void>
  /** F5: awaited right before `open` is sent (after the block-start sync): the demo arms the simulator's hold here. Errors are swallowed. */
  beforeOpenSent?: () => Promise<void>
  /**
   * F5: awaited once mine's claim was accepted (with the block of `open` as mine saw it), BEFORE the rival is waited for: the demo shows
   * round 1 here while the simulator is held, then resumes it. The rival's wait (and its timeout) starts after this returns. Errors are swallowed.
   */
  afterMineSent?: (openBlock: number | undefined) => Promise<void>
  /** F5: maps a wall time to the demo's pause-free time line (the holds taken out); applied to every time the trial reports. */
  retime?: (t: number) => number
}

const OPEN_TIMEOUT_MS = 30_000
/** A trial needs the tickets to stay active for this long (connect, open, a round, the block becoming visible). */
const MIN_TICKET_REMAINING_MS = 15_000
/** Assumed trial length before one has been measured. */
const DEFAULT_TRIAL_MS = 12_000

/**
 * Pure: the ticket time a trial needs, scaled with the block time B: a trial takes a few blocks (connect, open, a round, the
 * block becoming visible), 7.5 x B, capped at one ticket round. 15s at B = 2000 (as before).
 */
export function minTicketRemainingMs(blockMs: number, roundMs: number): number {
  return Math.max(MIN_TICKET_REMAINING_MS, Math.min(7.5 * blockMs, roundMs))
}
/** Pure: the assumed trial length before one is measured: 12s, or 6 x B. */
export const defaultTrialMs = (blockMs: number): number => Math.max(DEFAULT_TRIAL_MS, 6 * blockMs)

async function freshId(reader: RaceReader): Promise<bigint> {
  let id = BigInt(Date.now())
  while (await isRaceOpen(reader, id)) id += 1n
  return id
}

/**
 * Between trials: renew both bots' tickets for the next ticket round when the current one is about to end (so the feed
 * connections survive the rollover), and fall back to buying again, and waiting for activation, when they ran out.
 */
async function ensureTickets(rc: RaceContext): Promise<void> {
  const roundMs = rc.preset.local!.tickets.roundSeconds * 1000
  const now = chainNowMs() // ticket times are chain times (E2)
  const bots = rc.ticketBots === 'both' ? [rc.ids.rival, rc.ids.mine] : [rc.ids.mine]
  if (rc.session && ticketsUsable(rc.session, now, 0)) {
    const d = renewDecision({ roundEndMs: currentRoundEnd(rc.session, now, roundMs), coveredUntilMs: rc.session.activeUntil, nowMs: now, trialMs: rc.trialMs ?? defaultTrialMs(rc.preset.local!.blockMs), blockMs: rc.preset.local!.blockMs })
    if (d === 'renew') rc.session = (await renewTickets(rc.preset, bots, rc.session)) ?? rc.session
  }
  if (!ticketsUsable(rc.session, chainNowMs(), minTicketRemainingMs(rc.preset.local!.blockMs, roundMs))) {
    step(rc.ticketBots === 'both' ? 'buying a Fast Feed ticket for each bot (each with its own wallet and its own key)' : 'buying a Fast Feed ticket for mine (the rival polls the RPC: it needs no ticket)')
    rc.session = await buyTickets(rc.preset, bots)
  } else step('reusing the tickets bought earlier in this run')
}

/** The short description of how a bot plays, for the table and the narration. */
export function strategyOf(sc: Scenario, who: 'mine' | 'rival', o: { pollMs?: number; mineDelayMs?: number } = {}): string {
  const tip = gwei(who === 'mine' ? sc.mineTip : sc.rivalTip)
  if (who === 'rival' && sc.rivalVia === 'poll') return `poll ${o.pollMs ?? DEFAULT_POLL_MS}ms, tip ${tip}`
  const delay = who === 'mine' ? (o.mineDelayMs ?? sc.mineDelayMs) : sc.rivalDelayMs
  return `feed${delay > 0 ? ` +${delay}ms` : ''}, tip ${tip}`
}

/** One trial of a scenario. Does not print the verdict; prints the steps as it goes. */
export async function runTrial(rc: RaceContext, sc: Scenario, opts: TrialOptions = {}): Promise<Trial> {
  const { reader, env } = rc
  const race = reader.race
  const mineDelayMs = opts.mineDelayMs ?? sc.mineDelayMs
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  await ensureTickets(rc)
  const startedAt = Date.now()
  const id = await freshId(reader)
  step(`race ${id}: pre-sign each bot's claim(${id}) BEFORE the trigger (explicit nonce, gas and fees), then start both watchers`)
  const [rp, mp] = [
    await presignClaim({ account: rc.ids.rival.account, race, id, tip: sc.rivalTip, chainId: rc.chainId, read: env.read }),
    await presignClaim({ account: rc.ids.mine.account, race, id, tip: sc.mineTip, chainId: rc.chainId, read: env.read }),
  ]
  const how = (who: 'mine' | 'rival') =>
    who === 'rival' && sc.rivalVia === 'poll'
      ? `polls the RPC every ${pollMs}ms (eth_getLogs for Opened) and fires on the first poll that sees it`
      : `watches the Fast Feed and fires ${(who === 'mine' ? mineDelayMs : sc.rivalDelayMs) > 0 ? `${who === 'mine' ? mineDelayMs : sc.rivalDelayMs}ms after Opened` : 'at once on Opened'}`
  step(`rival ${rc.ids.rival.account.address}: nonce ${rp.nonce}, gas ${rp.gas}, tip ${gwei(sc.rivalTip)} gwei, ${how('rival')}`)
  step(`mine  ${rc.ids.mine.account.address}: nonce ${mp.nonce}, gas ${mp.gas}, tip ${gwei(sc.mineTip)} gwei, ${how('mine')}`)
  const send = (raw: Hex) => env.send.sendRawTransaction({ serializedTransaction: raw })
  // Measured, not assumed: when does the block that holds `open` become visible on the RPC? Starts when mine sees Opened.
  let visible: Promise<number | undefined> | undefined
  let deferredBlock: number | undefined
  const startProbe = (block: number) => {
    if (visible) return
    visible = waitBlockVisible(rc.preset.rpcUrl, block, 20_000, PROBE_MS) // a fine probe: it is compared with the polling rival's sighting
    void visible.then((t) => { if (t !== undefined) try { opts.onOpenBlockVisible?.(t) } catch { /* best effort */ } }, () => {})
  }
  // F5: with a hook that may hold the simulator (and wait for Enter), the probe's own deadline must not run meanwhile: it starts after the hook.
  const onSeen = (block: number) => (opts.afterMineSent ? void (deferredBlock ??= block) : startProbe(block))
  const feedBot = (b: BotIdentity, raw: Hex, delayMs: number) => new ClaimBot({ name: b.name, feedUrl: rc.preset.feedUrl, apiKey: b.key, race, id, delayMs, raw, send, onSeen: b.name === 'mine' ? onSeen : undefined, onFeedMessage: b.name === 'mine' ? opts.onMineFeed : undefined })
  const rival: RaceBot =
    sc.rivalVia === 'poll'
      ? new PollingBot({ name: 'rival', rpcUrl: rc.preset.rpcUrl, race, id, delayMs: sc.rivalDelayMs, raw: rp.raw, send, pollMs })
      : feedBot(rc.ids.rival, rp.raw, sc.rivalDelayMs)
  const mine = feedBot(rc.ids.mine, mp.raw, mineDelayMs)
  try {
    await Promise.all([rival.connect(), mine.connect()])
    note(`both watchers are running: mine through its own Fast Feed ticket and connection, the rival ${sc.rivalVia === 'poll' ? 'by polling' : 'through its own ticket and connection'}`)
    step(`the operator (${rc.operator.address}) calls Race.open(${id})`)
    const openRaw = await presignOpen({ operator: rc.operator, race, id, chainId: rc.chainId, read: env.read })
    // Local only: send `open` right after a block STARTS, so it lands in round 1 and a claim made on the feed lands in round 2 of the
    // same block. A poller sees the block only once it is final (after round 2), so it can never share mine's round by accident.
    if (rc.preset.mode === 'local') await syncToBlockStart(rc.preset.sendUrl)
    try { await opts.beforeOpenSent?.() } catch { /* best effort */ }
    await send(openRaw)
    try { opts.onOpenSent?.() } catch { /* best effort */ }
    note('open is queued; once its round is ordered the feed publishes it: that is when mine (and a feed rival) sees Opened')
    let fired: PromiseSettledResult<void>[]
    if (opts.afterMineSent) {
      // F5: mine first; the hook (a held simulator and its Enter prompts) runs before the rival's timeout starts.
      const m = await Promise.allSettled([mine.requireSent(OPEN_TIMEOUT_MS)])
      if (m[0]!.status === 'fulfilled') try { await opts.afterMineSent(mine.openBlock ?? rival.openBlock) } catch { /* best effort */ }
      if (deferredBlock !== undefined) startProbe(deferredBlock)
      const r = await Promise.allSettled([rival.requireSent(OPEN_TIMEOUT_MS)])
      fired = [r[0]!, m[0]!]
    } else fired = await Promise.allSettled([rival.requireSent(OPEN_TIMEOUT_MS), mine.requireSent(OPEN_TIMEOUT_MS)])
    const failed = fired.filter((f): f is PromiseRejectedResult => f.status === 'rejected')
    if (failed.length > 0) throw new Error(`a bot did not fire within ${OPEN_TIMEOUT_MS / 1000}s of open: ${failed.map((f) => (f.reason as Error).message).join('; ')}`)
    try { await opts.beforeClaimsLine?.() } catch { /* best effort */ }
    step('both claims are sent; waiting for their receipts')
    const { landed, missing } = await collectLanded(env, [{ label: 'rival', hash: rival.hash! }, { label: 'mine', hash: mine.hash! }])
    const landedOf = (l: string) => landed.find((x) => x.label === l)
    const rt = (t: number | undefined): number | undefined => (t === undefined || !opts.retime ? t : opts.retime(t))
    const result = async (b: BotIdentity, bot: RaceBot): Promise<BotResult> => ({
      name: b.name,
      address: b.account.address,
      via: bot.via,
      seenAt: rt(bot.seenAt),
      sentAt: rt(bot.sentAt),
      landed: landedOf(b.name) ? { block: landedOf(b.name)!.block, index: landedOf(b.name)!.index, tip: landedOf(b.name)!.tip, pgaRound: landedOf(b.name)!.pgaRound, ...(landedOf(b.name)!.roundUnknown ? { roundUnknown: true } : {}) } : undefined,
      rank: missing.includes(b.name) ? 0 : await readRank(reader, id, b.account.address),
    })
    const openBlock = mine.openBlock ?? rival.openBlock
    const input: RaceInput = {
      scenario: sc.id,
      id,
      expectedWinner: sc.expectedWinner,
      ordering: rc.ordering,
      mine: await result(rc.ids.mine, mine),
      rival: await result(rc.ids.rival, rival),
      winner: await readWinner(reader, id),
      openBlock,
      visibleAt: undefined as number | undefined,
      pollMs: sc.rivalVia === 'poll' ? pollMs : undefined,
    }
    if (rc.attached) {
      const rows: ClaimQueueRow[] = []
      const landedOrder = (['rival', 'mine'] as const)
        .filter((n) => input[n].landed)
        .sort((x, y) => before(input[x].landed!, input[y].landed!))
      for (const [name, h] of [['rival', rival.hash!], ['mine', mine.hash!]] as const) {
        const tr = await simTrace(rc.preset.rpcUrl, h)
        if (tr && tr.length > 0) rows.push({ name, priority: BigInt(tr[0]!.priority), arrivalRound: tr[0]!.round, drained: landedOrder.indexOf(name) + 1 })
      }
      const order = [rival, mine].sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0)).map((b) => (b === rival ? 'rival' : 'mine'))
      for (const l of claimRoundLines(rows, order)) internal(l)
    }
    input.visibleAt = rt(visibleBy(visible ? await visible : undefined, rival))
    const t0 = rt(Math.min(...[rival.seenAt, mine.seenAt].filter((x): x is number => x !== undefined)))!
    const trial: Trial = {
      id,
      judgement: judgeRace(input),
      input,
      timeline: formatTimeline({ id, t0, openBlock, visibleAt: input.visibleAt, ordering: rc.ordering, mine: input.mine, rival: input.rival }),
    }
    rc.trialMs = Math.max(rc.trialMs ?? 0, (opts.retime ? opts.retime(Date.now()) : Date.now()) - (opts.retime ? opts.retime(startedAt) : startedAt)) // paused (held) time is not trial time
    return trial
  } finally {
    await Promise.all([rival.close(), mine.close()])
    await visible // never leave the probe running
  }
}

/**
 * The one retry rule of every run (a single scenario, a matrix trial, the demo): an INCONCLUSIVE trial is run once more
 * with a fresh race (`runWithRetry`, pga/bot/common.ts); a PASS or a FAIL never is. `reason` carries the retry note.
 * `onRetry` gets the first attempt's reason. Injectable: tests pass a fake `once`.
 */
export async function runTrialWithRetry<T extends { judgement: RaceJudgement }>(
  once: () => Promise<T>,
  onRetry: (firstReason: string) => void,
): Promise<T & { verdict: Verdict; reason: string; retried: boolean }> {
  let retried = false
  const r = await runWithRetry(
    async () => {
      const t = await once()
      return { ...t, verdict: t.judgement.verdict, reason: t.judgement.reason }
    },
    true,
    (first) => {
      retried = true
      onRetry(first.reason)
    },
  )
  return { ...r, retried }
}

/** The exit code of a verdict: 0 PASS, 1 FAIL, 3 INCONCLUSIVE. */
export function raceExitCode(v: Verdict): number {
  return exitCode([v])
}

/** Pure: the command a reader can paste to check the winner on chain. */
export function castCommand(race: string, id: bigint, rpcUrl: string): string {
  return `cast call ${race} "winner(uint256)" ${id} --rpc-url ${rpcUrl}`
}

/** Pure: the explanation printed under the timeline (what the feed did and did not buy the bots, and what decided). */
export function whyLines(i: RaceInput, v: RaceJudgement): string[] {
  const claimBlock = i.rival.landed && i.mine.landed && sameRound(i.rival.landed, i.mine.landed) ? roundLabel(i.mine.landed) : undefined
  const lines = [
    `open was already sequenced${i.openBlock !== undefined ? ` (block ${i.openBlock})` : ''} when the feed announced it: the feed cannot jump a transaction that is already ordered, and nobody can claim before open.`,
  ]
  // Both claims in one block: say what got them there. The feed bought a round only for a bot that used it.
  if (claimBlock !== undefined) {
    lines.push(
      i.rival.via === 'poll'
        ? `the poller's sighting was still in time for mine's round, so both claims were in the same round (${claimBlock}).`
        : `What the feed bought both bots is the NEXT round (${claimBlock}): they could pre-sign, see Opened at once and be in that round's queue.`,
    )
  }
  const pass = v.verdict === 'PASS'
  if (i.scenario === 's1') {
    if (pass) lines.push('Inside that round the queue is ordered by tip, not by arrival: the later, higher-tipping claim ranks first. Information got you in; the tip won the round.')
    return lines
  }
  const times = [i.mine.seenAt, i.rival.seenAt].filter((x): x is number => x !== undefined)
  const t0 = times.length > 0 ? Math.min(...times) : undefined
  // Only when mine really was in the earlier round (a pass): never describe the rival as late otherwise.
  if (pass && i.rival.landed && i.mine.landed && roundBefore(i.mine.landed, i.rival.landed) && (i.rival.seenAt === undefined || i.mine.seenAt === undefined || i.rival.seenAt > i.mine.seenAt)) {
    lines.push(`mine saw Opened on the Fast Feed and sent at once, so its claim joined the next round (${roundLabel(i.mine.landed)}).`)
    if (i.visibleAt !== undefined && i.rival.seenAt !== undefined && t0 !== undefined) {
      lines.push(
        `the rival saw Opened later because block ${i.openBlock ?? '?'} is visible on the RPC only after the next block boundary plus the publish delay (visible by t0+${Math.round(i.visibleAt - t0)}ms), ` +
          `and its poll${i.pollMs ? ` (every ${i.pollMs}ms)` : ''} then added ${i.visibleAt < i.rival.seenAt ? `at least ${Math.round(i.rival.seenAt - i.visibleAt)}ms (the probe only bounds when the block became visible)` : 'no measurable time (its own sighting is the bound)'}: it saw the log at t0+${Math.round(i.rival.seenAt - t0)}ms. Its claim therefore landed in ${roundLabel(i.rival.landed)}, a later round.`,
      )
    }
  }
  if (pass && v.effect === 'information') {
    lines.push('A tip cannot buy a round you are not in: the earlier round wins whatever the tips. Information got mine into the earlier round.')
    if (i.scenario === 's3' && i.ordering === 'fifo') lines.push('(On this FIFO stack the tip would not have counted even in the same round.)')
  }
  if (pass && v.effect === 'both') lines.push('Mine won twice over: it was in an earlier round (information) and it tipped more (so it would also have won a same-round tie). The information gets you in, the tip wins the round.')
  if (pass && v.effect === 'tip') lines.push('Both claims were in the same round, so the tip ranked them.')
  return lines
}

const firstSentence = (text: string): string => text.split(/(?<=\.)\s/)[0]!

/**
 * Pure: the demo's closing line, phrased only from what the judge OBSERVED (never a claim that was not observed; it shares
 * its guard with `whyLines`). `both`: information got mine into the earlier round AND the tip out-bid the rival's;
 * `information`: only the earlier round (and why the tip is not credited); `tip`: both claims in one round. Anything else:
 * the judge's own first sentence.
 */
export function whyLine(i: RaceInput | undefined, j: RaceJudgement | undefined): string {
  if (!i || !j) return 'Mine: no result. Why: the race did not complete (see the failed chapter above).'
  const rank = i.mine.rank > 0 ? `rank ${i.mine.rank}` : 'no rank recorded'
  const plain = `Mine: ${rank}. Why: ${j.verdict === 'FAIL' ? 'FAIL: ' : j.verdict === 'INCONCLUSIVE' ? 'not established (inconclusive): ' : ''}${firstSentence(j.reason)}`
  if (j.verdict !== 'PASS') return plain
  const [ml, rl] = [i.mine.landed, i.rival.landed]
  if (!ml || !rl) return plain
  const [mt, rt] = [gwei(ml.tip), gwei(rl.tip)]
  const rival = i.rival.via === 'poll' ? 'rival polled' : 'rival used the feed too'
  // Information is credited only when mine really was in the earlier round and the rival learned of Opened later.
  const earlier = roundBefore(ml, rl) && (i.rival.seenAt === undefined || i.mine.seenAt === undefined || i.rival.seenAt > i.mine.seenAt)
  if ((j.effect === 'both' || j.effect === 'information') && !earlier) return plain
  if (j.effect === 'both') {
    return `Mine: ${rank}. Why: Fast Feed got us into ${roundLabel(ml)} (${rival}, arrived in ${roundLabel(rl)}); our tip ${mt} also beat the rival's ${rt} (we'd also win a same-round tie).`
  }
  if (j.effect === 'information') {
    const tip = i.ordering === 'fifo' ? 'this stack orders by arrival (FIFO), so a tip would not have counted' : `our tip ${mt} did not beat the rival's ${rt}, so information alone decided`
    return `Mine: ${rank}. Why: Fast Feed got us into ${roundLabel(ml)} (${rival}, arrived in ${roundLabel(rl)}); ${tip}.`
  }
  if (j.effect === 'tip') return `Mine: ${rank}. Why: both claims landed in ${roundLabel(ml)}, so our tip ${mt} beat the rival's ${rt}; information did not decide.`
  return plain
}

// ---------------------------------------------------------------------------
// The matrix: S1, S2 and S3, N trials each, one table
// ---------------------------------------------------------------------------

/** Matrix lines are printed with a 2-space indent: keep them within 78 columns so the output fits 80. */
const WIDTH = 78

export const TAKEAWAY = 'information gets you into the round; the tip wins the round'

export interface TrialRecord {
  scenario: ScenarioId
  verdict: Verdict
  effect?: Effect
  reason: string
  /** The first attempt was inconclusive and the trial was run once more (this record is the second attempt). */
  retried?: boolean
}

export interface MatrixRow {
  scenario: ScenarioId
  mine: string
  rival: string
  trials: number
  wins: number
  inconclusive: number
  failed: number
  /** The effects observed in the winning trials. */
  effects: Effect[]
}

/** Pure: one row per scenario, from the recorded trials. */
export function summarizeMatrix(records: readonly TrialRecord[], o: { pollMs?: number; mineDelayMs?: number } = {}): MatrixRow[] {
  return (['s1', 's2', 's3'] as const)
    .map((id) => {
      const rs = records.filter((r) => r.scenario === id)
      const sc = SCENARIOS[id]
      return {
        scenario: id,
        mine: strategyOf(sc, 'mine', { mineDelayMs: id === 's1' ? o.mineDelayMs : undefined }),
        rival: strategyOf(sc, 'rival', { pollMs: o.pollMs }),
        trials: rs.length,
        wins: rs.filter((r) => r.verdict === 'PASS').length,
        inconclusive: rs.filter((r) => r.verdict === 'INCONCLUSIVE').length,
        failed: rs.filter((r) => r.verdict === 'FAIL').length,
        effects: [...new Set(rs.filter((r) => r.verdict === 'PASS' && r.effect).map((r) => r.effect!))],
      }
    })
    .filter((r) => r.trials > 0)
}

/** Pure: 0 when mine won every trial, 1 when any trial failed, 3 when some were inconclusive and none failed, 2 when no trial ran. */
export function matrixExitCode(rows: readonly MatrixRow[]): number {
  if (rows.length === 0) return 2 // nothing ran: never a pass
  if (rows.some((r) => r.failed > 0)) return 1
  if (rows.some((r) => r.inconclusive > 0 || r.wins < r.trials)) return 3
  return 0
}

/** Pure: wrap `text` to `width` columns; continuation lines get `indent`. */
export function wrapText(text: string, width: number, indent = ''): string[] {
  const out: string[] = []
  let line = ''
  const words = text.split(/\s+/).filter(Boolean).flatMap((w) => {
    const room = Math.max(1, width - indent.length)
    const parts: string[] = []
    for (let k = 0; k < w.length; k += room) parts.push(w.slice(k, k + room))
    return w.length > room ? parts : [w]
  })
  for (const w of words) {
    if (line.length > 0 && line.length + 1 + w.length > width) {
      out.push(line)
      line = indent + w
    } else line = line.length > 0 ? `${line} ${w}` : w
  }
  if (line.length > 0) out.push(line)
  return out
}

/** Pure: one explanation as NOTE lines: `NOTE: ` on the first line, 6 spaces on the continuation lines, each at most `width` columns. */
export function noteBlock(text: string, width = WIDTH, indent = ''): string[] {
  return wrapText(text, width - 6, indent).map((l, i) => (i === 0 ? noteText(l) : `      ${l}`))
}

/**
 * Pure: the matrix. `table` is the data (at most 80 columns, printed plain); `notes` is every explanation (what the effects
 * mean, the inconclusive count, retries, per-trial reasons, the takeaway) as NOTE lines of at most 80 columns, in one list.
 */
export function formatMatrix(rows: readonly MatrixRow[], records: readonly TrialRecord[] = []): { table: string[]; notes: string[] } {
  const head = ['Scen', 'Mine', 'Rival', 'Wins', 'Deciding effect']
  const body = rows.map((r) => [r.scenario.toUpperCase(), r.mine, r.rival, `${r.wins}/${r.trials}`, r.effects.length > 0 ? r.effects.join(' + ') : '-'])
  const w = head.map((h, c) => Math.max(h.length, ...body.map((b) => b[c]!.length)))
  const fmt = (cells: string[]) => cells.map((x, c) => (c === cells.length - 1 ? x : x.padEnd(w[c]!))).join('  ').trimEnd()
  const table = [fmt(head), fmt(w.map((n) => '-'.repeat(n))), ...body.map(fmt)]
  const notes: string[] = []
  notes.push(...noteBlock('feed = Fast Feed; poll = the RPC polled; tips in gwei; +Nms = fires N ms after Opened.'))
  notes.push(...noteBlock('tip = both claims in one round, the higher tip ranked first; information = mine was in an earlier round; both = an earlier round AND the higher tip (mine would also win a same-round tie).'))
  const inc = rows.filter((r) => r.inconclusive > 0)
  if (inc.length > 0) notes.push(...noteBlock(`inconclusive (not counted as wins): ${inc.map((r) => `${r.scenario.toUpperCase()} ${r.inconclusive}`).join(', ')}`))
  const retried = [...new Set(records.filter((r) => r.retried).map((r) => r.scenario))].map((id) => `${id.toUpperCase()} ${records.filter((r) => r.scenario === id && r.retried).length}`)
  if (retried.length > 0) notes.push(...noteBlock(`retried once (the first attempt was inconclusive; each still counts as one trial): ${retried.join(', ')}`))
  for (const r of records.filter((x) => x.verdict !== 'PASS')) notes.push(...noteBlock(`${r.scenario.toUpperCase()} ${r.verdict}: ${r.reason}`))
  notes.push(...noteBlock(`Takeaway: ${TAKEAWAY}.`))
  return { table, notes }
}

/**
 * Build the context a trial needs from a RESOLVED local preset (the stack's own parameters and the Race address).
 * `ids` and `session` let a caller that already bought a ticket (the demo) hand them over; the default is two fresh in-memory keys.
 */
export async function makeRaceContext(
  preset: Preset,
  o: { attached: boolean; ticketBots: RaceContext['ticketBots']; ids?: RaceContext['ids']; session?: TicketSession },
): Promise<RaceContext> {
  if (!preset.raceAddress) throw new ConfigError('The running simulator did not publish a Race contract (sim_info.contracts.race): it predates this command. Stop it and restart `npm run sim`.')
  const read = createPublicClient({ transport: http(preset.rpcUrl) })
  const chainId = await read.getChainId()
  assertAllowedChain(chainId, preset, process.env)
  return {
    preset,
    chainId,
    env: { preset, chainId, read, send: createPublicClient({ transport: http(preset.sendUrl) }), sendUrl: preset.sendUrl, wallets: [] },
    reader: makeReader(preset.rpcUrl, preset.raceAddress),
    ids: o.ids ?? localIdentities(), // two fresh in-memory feed keys per run; only their hashes are ever printed
    operator: localOperator(),
    attached: o.attached,
    ordering: preset.local!.ordering,
    ticketBots: o.ticketBots,
    session: o.session,
  }
}

/** Pure: is this timeline line the closing verdict sentence ("different rounds → ...", "same round → ...", "same round, but ...")? Those are NOTEs. */
export function isTimelineVerdict(line: string): boolean {
  return line.startsWith('different rounds →') || line.startsWith('same round →') || line.startsWith('same round, ')
}

/** Prints what a single-scenario run prints after the trial: the timeline, the explanation and the verdict line. Returns the verdict. */
export function printTrialReport(trial: Trial & { reason: string }, sc: Scenario): Verdict {
  plain()
  step('timeline')
  // The timeline's data lines are plain; its closing verdict sentence (all variants) is a NOTE.
  for (const l of trial.timeline) (isTimelineVerdict(l) ? note(l) : plain(`  ${l}`))
  for (const l of whyLines(trial.input, trial.judgement)) note(l)
  plain()
  const v = trial.judgement.verdict
  result(v, `Scenario ${sc.id}: ${v} - ${trial.reason}`)
  return v
}

const USAGE =
  'Usage: npm run race -- --local [--scenario s1|s2|s3|matrix] [--trials N] [--poll-ms N] [--mine-delay-ms N] [--preset slow|fast]   (--testnet is not available yet)'

async function runMatrix(rc: RaceContext, args: RaceArgs): Promise<number> {
  const records: TrialRecord[] = []
  for (const id of ['s1', 's2', 's3'] as const) {
    const sc = SCENARIOS[id]
    for (let n = 1; n <= args.trials; n++) {
      step(`matrix: ${id.toUpperCase()} trial ${n}/${args.trials}: ${sc.title}`)
      try {
        // Like a single run: one retry with a fresh race, still ONE trial. A FAIL is never retried.
        const t = await runTrialWithRetry(
          () => runTrial(rc, sc, { mineDelayMs: id === 's1' ? args.mineDelayMs : undefined, pollMs: args.pollMs }),
          (first) => step(`${id.toUpperCase()} trial ${n}/${args.trials}: inconclusive (${first.split(':')[0]}); retrying once with a fresh race`),
        )
        const { retried, reason } = t
        const j = t.judgement
        records.push({ scenario: id, verdict: j.verdict, effect: j.effect, reason, retried })
        const ln = (b: BotResult) => `${b.name} rank ${b.rank} (${b.landed ? roundLabel(b.landed) : 'block ?'})`
        step(`${id.toUpperCase()} trial ${n}/${args.trials}: ${j.verdict}${retried ? ' after 1 retry' : ''}${j.effect ? ` (${j.effect})` : ''}: ${ln(t.input.mine)}, ${ln(t.input.rival)}`)
      } catch (e) {
        records.push({ scenario: id, verdict: 'FAIL', reason: (e as Error).message })
        step(`${id.toUpperCase()} trial ${n}/${args.trials}: FAIL (error): ${(e as Error).message}`)
      }
    }
  }
  const rows = summarizeMatrix(records, { pollMs: args.pollMs, mineDelayMs: args.mineDelayMs })
  plain()
  step(`matrix: mine's win rate over ${args.trials} trial(s) per scenario`)
  const m = formatMatrix(rows, records)
  for (const l of m.table) plain(`  ${l}`)
  plain()
  noteLines(m.notes)
  plain()
  const code = matrixExitCode(rows)
  plain(''); result(verdictOfCode(code), code === 0 ? 'PASS: mine won every trial.' : code === 3 ? 'Inconclusive (exit 3): some trials did not play out as designed; rerun.' : 'FAIL (exit 1): mine did not win every trial (see the rows above).')
  return code
}

async function main(): Promise<number> {
  loadDotEnv()
  const argv = process.argv.slice(2)
  let preset: Preset
  let args: RaceArgs
  try {
    preset = getPreset(argv)
    args = parseRaceArgs(argv)
  } catch (e) {
    error(`Error: ${(e as Error).message}`)
    error(USAGE)
    return 2
  }
  if (preset.mode === 'testnet') {
    // TODO(C4): a persisted feed key per bot (the raw keys must be kept between runs, since tickets are bought a round
    // ahead), a Race deployed on Arbitrum Sepolia by `race:deploy -- --testnet`, and the ALLOW_TESTNET guards.
    error(
      'Error: the testnet race comes in a later stage. It needs `race:deploy -- --testnet` (a Race contract on Arbitrum Sepolia) and persisted feed keys for the two bots; ' +
        'neither exists yet, so nothing was run. Use --local.',
    )
    return 1
  }
  assertAllowedChain(preset.chainId, preset, process.env)
  setInternalVisible(true) // the sequencer's round queue (the stack prints it when it runs in this process)
  const { startOrAttach } = await import('../sim/index.ts') // sim code is local-only
  const { ticketSummaryLine } = await import('../sim/banner.ts')
  const stack = await startOrAttach(preset.local!, preset.chainId, { build: true })
  try {
    preset = await resolvePreset(preset) // the RUNNING stack's parameters and the Race address
    const rc = await makeRaceContext(preset, {
      attached: stack.attached,
      ticketBots: args.scenario === 'matrix' || SCENARIOS[args.scenario].rivalVia === 'feed' ? 'both' : 'mine',
    })
    const { chainId, ordering } = rc
    note(`network: ${preset.name} (chainId ${chainId}); Race at ${preset.raceAddress}; stack ordering: ${ordering === 'fifo' ? 'FIFO (PGA OFF: the tip is ignored, arrival order decides)' : 'PGA (effective tip, then arrival)'}`)
    note(ticketSummaryLine(preset.local!))
    if (args.pollMsGiven && args.scenario === 's1') note('--poll-ms is ignored by S1: both bots use the Fast Feed, nobody polls.')
    if (args.scenario === 'matrix') {
      step(`matrix: S1, S2 and S3, ${args.trials} trial(s) each, one ticket session`)
      note('Tickets are renewed between trials while a ticket round is about to end.')
      note(`round = ${preset.local!.roundMs}ms; the polling rival asks the RPC every ${args.pollMs}ms. One ticket session buys for both bots, though S2 and S3 rivals never use theirs (simpler: S1 needs both)`)
      return await runMatrix(rc, args)
    }
    const sc = SCENARIOS[args.scenario]
    const mineDelay = args.mineDelayMs ?? sc.mineDelayMs
    step(sc.title)
    note(`round = ${preset.local!.roundMs}ms; rival: ${strategyOf(sc, 'rival', { pollMs: args.pollMs })}; mine: ${strategyOf(sc, 'mine', { mineDelayMs: mineDelay })}`)
    const trial = await runTrialWithRetry(
      () => runTrial(rc, sc, { mineDelayMs: mineDelay, pollMs: args.pollMs }),
      (first) => step(`inconclusive (${first.split(':')[0]}); retrying once with a fresh race`),
    )
    const v = printTrialReport(trial, sc)
    plain()
    step('check it on chain')
    note('winner(id) is rank 1; cast prints the address left-padded to 32 bytes, so it should end in mine\'s address.')
    plain(`  ${castCommand(rc.reader.race, trial.id, preset.rpcUrl)}`)
    plain(`  mine  = ${trial.input.mine.address}`)
    plain(`  rival = ${trial.input.rival.address}`)
    const code = raceExitCode(v)
    plain(''); result(verdictOfCode(code), code === 0 ? 'PASS.' : code === 3 ? 'Inconclusive (exit 3): rerun.' : 'FAIL (exit 1).')
    return code
  } finally {
    await stack.stop()
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
