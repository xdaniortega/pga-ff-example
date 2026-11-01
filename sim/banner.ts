// R8: print every accelerated/local parameter next to its Arbitrum One value.
// Values come only from shared/config.ts.
import { note, plain, warn, warnText } from '../shared/narrate.ts'
import { ARBITRUM_ONE, LOCAL_TICKET_ROUND_DEFAULT_S, SIM_PRESETS, SLOWMO_FACTOR, TOKEN_DECIMALS, type LocalParams } from '../shared/config.ts'

const gwei = (wei: bigint) => `${Number(wei) / 1e9} gwei`

const hours = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : `${sec}s`)
const frac = (n: number) => (n === 0 ? '0' : `${n}/256`)
const secs = (ms: number) => `${ms / 1000}s`
const arbFrac = (n: number) => `~${n / 256}`

/** The one line every ticket command prints first. */
export function ticketSummaryLine(p: LocalParams): string {
  const A = ARBITRUM_ONE
  return `LOCAL: ticket round = ${p.tickets.roundSeconds}s (Arbitrum One: ${hours(A.ticketRoundSeconds)}), grandfather = ${frac(p.tickets.grandfatherPeriodFraction)} (Arbitrum One: ${arbFrac(A.grandfatherPeriodFraction)})`
}

/** NOTE lines about the ticket round: raised from 30s to 4 x B, or an explicit value that is too short. */
export function ticketRoundNotes(p: LocalParams): string[] {
  const t = p.tickets
  const out: string[] = []
  if (t.roundAdapted) {
    out.push(`NOTE: ticket round adapted from ${LOCAL_TICKET_ROUND_DEFAULT_S}s to ${t.roundSeconds}s so a purchase or renewal (visible only after its ${secs(p.blockMs)} block closes) has time to land in its round`)
  }
  if (t.roundWarning) out.push(warnText(t.roundWarning))
  return out
}

/** How rounds map to blocks: K rounds share one block (slow motion: the same, ×100). */
function roundsLines(p: LocalParams): string[] {
  const A = ARBITRUM_ONE
  const roundNote = '  transactions published in round 1 are final before round 2 starts; round 2 can only add after them.'
  if (p.slowmo) {
    return [
      `  slow motion ×${SLOWMO_FACTOR}: round ${secs(p.roundMs)} (Arbitrum One: ${A.roundMs}ms), block ${secs(p.blockMs)} (Arbitrum One: ${A.blockMs}ms), ${p.k} rounds per block`,
      roundNote,
    ]
  }
  return [`  block = ${p.blockMs}ms, K = ${p.k} rounds of B/${p.k} = ${p.roundMs}ms   (Arbitrum One: ${A.blockMs}ms, two ${A.roundMs}ms rounds)`, roundNote]
}

export function bannerLines(p: LocalParams): string[] {
  const A = ARBITRUM_ONE
  return [
    `LOCAL (${p.slowmo ? `${p.preset} preset, slow motion ×${SLOWMO_FACTOR}` : `${p.preset} preset`}): values differ from Arbitrum One as follows`,
    // Block, K and round are printed once, by roundsLines (slow motion has its own line).
    ...(!p.slowmo && p.blockMs !== SIM_PRESETS[p.preset].blockMs
      ? [`  block = ${p.blockMs}ms, round = ${p.roundMs}ms (Arbitrum One: ${A.blockMs}ms, ${A.roundMs}ms)   (--block-ms / SIM_BLOCK_MS overrides the ${p.preset} preset's ${SIM_PRESETS[p.preset].blockMs}ms; K stays ${p.k})`]
      : []),
    `  BLOCK_PUBLISH_DELAY_MS = ${p.blockPublishDelayMs}ms   (Arbitrum One: none; a block is visible when it is produced)`,
    `  base fee pinned at ${gwei(p.baseFeeWei)}   (Arbitrum One: floor ${gwei(A.baseFeeWei)}, moves with load)`,
    `  chainId = ${p.chainId}   (Arbitrum One: ${A.chainId})`,
    ...roundsLines(p),
    `  ${ticketSummaryLine(p)}`,
    ...ticketRoundNotes(p),
    `  tickets per round: target ${p.tickets.targetTicketsPerRound}, max ${p.tickets.maxTicketsPerRound}   (Arbitrum One: ${A.targetTicketsPerRound}, ${A.maxTicketsPerRound})`,
    `  minimum ticket price = ${p.tickets.minimumPrice} units = ${Number(p.tickets.minimumPrice) / 10 ** TOKEN_DECIMALS} TEST, ${TOKEN_DECIMALS} decimals   (Arbitrum One: ${A.minimumPrice} units = $${Number(A.minimumPrice) / 10 ** TOKEN_DECIMALS})`,
    `  price update fraction = ${p.tickets.priceUpdateFraction}   (Arbitrum One: ${A.priceUpdateFraction})`,
    `  payment token = local TEST (6 decimals, public mint)   (Arbitrum One: USDG)`,
    `  Fast Feed auth: ${p.feedAuth ? 'ON (Bearer key needs an active ticket: bought in the previous round, one connection each; FEED_AUTH=off opens the feed)' : 'OFF (FEED_AUTH=off: any client may connect, like A1)'}`,
    `  nonce gap hold = ${p.gapHoldRounds} rounds   (simulator assumption: the docs do not say what happens to a tx whose nonce is above its sender's next nonce; GAP_HOLD_ROUNDS)`,
    ...(p.maxTxsPerRound > 0
      ? [`  LOCAL: block-full stand-in = ${p.maxTxsPerRound} txs per round (Arbitrum One: ${A.blockFull}); a round that hits it carries the rest over and boosts them by p/(2K) (MAX_TXS_PER_ROUND)`]
      : [`  LOCAL: no block-full limit (Arbitrum One: ${A.blockFull}); every round drains the whole queue, so nothing is carried over or boosted (MAX_TXS_PER_ROUND=N sets a cap)`]),
    ...(p.ordering === 'fifo' ? ['  ordering: FIFO (PGA disabled)'] : []),
    '  LOCAL: the demo may freeze this simulator during --pause prompts (no rounds, blocks or traffic) and skip its clock to the next ticket round (Arbitrum never pauses; sim_pause, sim_resume, sim_skipTo)',
    `  sequencer RPC http://${p.host}:${p.rpcPort}, feed ws://${p.host}:${p.feedPort}, Anvil (internal) ${p.anvilUrl}`,
  ]
}

export function printBanner(p: LocalParams): void {
  for (const l of bannerLines(p)) (l.startsWith('WARNING:') ? warn : note)(l)
}

/** Column limit of the compact table (the demo's chapter 1). */
export const COMPACT_BANNER_MAX_COLS = 100

/**
 * The demo's chapter 1: ONE table of every local value that differs from Arbitrum One (parameter, local, Arbitrum One),
 * then at most 5 NOTE lines. Same data as `bannerLines`; `npm run sim` keeps the long form.
 */
export function compactBanner(p: LocalParams, o: { pauseSlowmo?: boolean } = {}): { title: string; table: string[]; notes: string[] } {
  const A = ARBITRUM_ONE
  const t = p.tickets
  const rows: string[][] = [
    ['parameter', 'local', 'Arbitrum One'],
    ['block time', `${secs(p.blockMs)}${p.slowmo ? ' (slow motion ×100)' : ''}`, `${A.blockMs}ms`],
    [`round time (K = ${p.k} rounds per block)`, secs(p.roundMs), `${A.roundMs}ms (K = ${A.k})`],
    ['base fee', `${gwei(p.baseFeeWei)} pinned`, `${gwei(A.baseFeeWei)} floor, moves with load`],
    ['chainId', String(p.chainId), String(A.chainId)],
    ['ticket round', `${t.roundSeconds}s${t.roundAdapted ? ` (adapted from ${LOCAL_TICKET_ROUND_DEFAULT_S}s)` : ''}`, hours(A.ticketRoundSeconds)],
    ['grandfather period', frac(t.grandfatherPeriodFraction), arbFrac(A.grandfatherPeriodFraction)],
    ['tickets per round: target / max', `${t.targetTicketsPerRound} / ${t.maxTicketsPerRound}`, `${A.targetTicketsPerRound} / ${A.maxTicketsPerRound}`],
    ['minimum ticket price', `${Number(t.minimumPrice) / 10 ** TOKEN_DECIMALS} TEST`, `$${Number(A.minimumPrice) / 10 ** TOKEN_DECIMALS}`],
    ['price update fraction', String(t.priceUpdateFraction), String(A.priceUpdateFraction)],
    ['payment token', 'TEST (public mint)', 'USDG'],
    ['block publish delay', `${p.blockPublishDelayMs}ms`, 'none'],
    ['Fast Feed auth', p.feedAuth ? 'ON (ticket needed)' : 'OFF (open feed)', 'ticket needed'],
    ['nonce gap hold (assumption)', `${p.gapHoldRounds} rounds`, 'not documented'],
    ['block-full cap', p.maxTxsPerRound > 0 ? `${p.maxTxsPerRound} txs per round` : 'none', A.blockFull],
    ...(p.ordering === 'fifo' ? [['ordering', 'FIFO (PGA disabled)', 'PGA (tip order)']] : []),
    ['sequencer RPC', `http://${p.host}:${p.rpcPort}`, 'public sequencer endpoint'],
    ['Fast Feed', `ws://${p.host}:${p.feedPort}`, 'public Fast Feed endpoint'],
    ['Anvil (internal)', p.anvilUrl, 'n/a'],
  ]
  const w = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c]!.length)))
  const fmt = (r: string[]) => `${r[0]!.padEnd(w[0]!)}  ${r[1]!.padEnd(w[1]!)}  ${r[2]!}`.trimEnd()
  const table = [fmt(rows[0]!), '-'.repeat(Math.min(COMPACT_BANNER_MAX_COLS, w[0]! + w[1]! + w[2]! + 4)), ...rows.slice(1).map(fmt)]
  const notes: string[] = [
    'Everything runs on a local simulator (Anvil + a mock sequencer + a mock Fast Feed). Values that differ from Arbitrum One do so on purpose, and none is accelerated silently.',
    'Rounds: transactions published in round 1 are final before round 2 starts; round 2 can only add after them.',
  ]
  if (p.slowmo) notes.push(`Slow motion ×${SLOWMO_FACTOR}: Arbitrum One's ${A.blockMs}ms block takes ${secs(p.blockMs)} here so each block can be watched${o.pauseSlowmo ? ' (--pause starts the simulator in slow motion; DEMO_SLOWMO=0 keeps the default preset)' : ''}.`)
  if (t.roundAdapted) notes.push(`The ticket round was raised from ${LOCAL_TICKET_ROUND_DEFAULT_S}s to ${t.roundSeconds}s so a purchase (visible only after its ${secs(p.blockMs)} block closes) lands in its round.`)
  if (t.roundWarning) notes.push(warnText(t.roundWarning))
  // The chapter header already says "Read more", so at most 4 here (5 with it). Over 4: drop the generic round note first; the slow-motion, adaptation and warning notes are the ones that must stay.
  const kept = notes.length > 4 ? notes.filter((n) => !n.startsWith('Rounds:')) : notes
  return { title: `LOCAL (${p.slowmo ? `${p.preset} preset, slow motion ×${SLOWMO_FACTOR}` : `${p.preset} preset`}): values differ from Arbitrum One as follows`, table, notes: kept }
}

export function printCompactBanner(p: LocalParams, o: { pauseSlowmo?: boolean } = {}): void {
  const c = compactBanner(p, o)
  plain(c.title)
  for (const l of c.table) plain(l)
  for (const l of c.notes) (l.startsWith('WARNING:') ? warn : note)(l)
}

/** The line `npm run traffic` prints: the local values its rate depends on. */
export function trafficSummaryLine(p: LocalParams): string {
  const A = ARBITRUM_ONE
  return (
    `LOCAL: block = ${p.blockMs}ms, round = ${p.roundMs}ms (Arbitrum One: ${A.blockMs}ms, ${A.roundMs}ms); a receipt is hidden until its block is ` +
    `revealed (when its block is final, +${p.blockPublishDelayMs}ms), so one wallet sends about one tx per block (~${(p.blockMs / 1000).toFixed(1)}s)`
  )
}

/** The lines `npm run feed -- --local --live` prints under its header: the local values the view depends on. */
export function liveSummaryLines(p: LocalParams): string[] {
  const A = ARBITRUM_ONE
  return [
    `LOCAL: block = ${p.blockMs}ms, round = ${p.roundMs}ms (Arbitrum One: ${A.blockMs}ms, ${A.roundMs}ms); ${p.k} PGA rounds share one block, so pga_round is 1..${p.k} (Arbitrum One: ${A.k} rounds per block)`,
    `LOCAL: a block is visible on RPC at the next block boundary + ${p.blockPublishDelayMs}ms (Arbitrum One: when it is produced), so the "block visible" time is slower than on Arbitrum`,
    ticketSummaryLine(p),
  ]
}
