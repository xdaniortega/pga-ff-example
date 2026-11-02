// The Race contract's ABI, the two watchers that fire a pre-signed `claim` when `Opened` appears (`ClaimBot` on the Fast
// Feed, `PollingBot` on the RPC: the slow competitor), the ticket purchase and renewal for the two bots, and the readers
// for ranks and the winner.
// Concepts: combo/README.md (the story), fast-feed/README.md (feed and tickets), pga/README.md (the tip decides).
import { createPublicClient, encodeFunctionData, getAddress, http, pad, parseAbi, toEventSelector, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { ANVIL_ACCOUNT_MAP, anvilDevKey, type Preset } from '../shared/config.ts'
import { connectFeed, FeedRejectedError, rejectionLines, type FeedClient, type FeedMessageJson } from '../fast-feed/client/client.ts'
import { apiKeyHash, generateKey } from '../fast-feed/client/key.ts'
import { approve, balances, checkGrandfather, deposit, fmtToken, fmtWhen, formatTicketsError, makeCtx, mintLocal, nowSec, purchase, readRound, type TicketsCtx } from '../fast-feed/client/tickets.ts'
import { chainNowMs } from '../shared/clock.ts'
import { note, step } from '../shared/narrate.ts'
import { MAX_FEE, sleep } from '../pga/bot/common.ts'
import { presign } from '../pga/bot/tx.ts'

export const raceAbi = parseAbi([
  'function open(uint256 id)',
  'function claim(uint256 id)',
  'function winner(uint256 id) view returns (address)',
  'function rankOf(uint256 id, address who) view returns (uint256)',
  'function claimCount(uint256 id) view returns (uint256)',
  'function isOpen(uint256 id) view returns (bool)',
  'function operator() view returns (address)',
  'event Opened(uint256 indexed id)',
  'event Claimed(uint256 indexed id, address indexed claimer, uint256 rank)',
  'event AlreadyClaimed(uint256 indexed id, address indexed claimer)',
  'event ClaimTooEarly(uint256 indexed id, address indexed claimer)',
])

export const OPENED_TOPIC: Hex = toEventSelector('Opened(uint256 indexed id)')

/**
 * Extra gas on top of the estimate for `claim`. The estimate is taken against the race that is NOT open yet, where
 * `claim` only emits `ClaimTooEarly`; once the race is open it writes three fresh storage slots (about 22k gas each
 * on Ethereum, more on Arbitrum with the L1 component) plus the `Claimed` event. The limit only reserves balance
 * (limit x maxFee): the sender pays for the gas actually used.
 */
export const CLAIM_GAS_MARGIN = 100_000n

/** Pure: is this feed message the `Opened(id)` event of the Race contract at `race`, from a successful tx? */
export function isOpenedFor(msg: FeedMessageJson, race: string, id: bigint): boolean {
  const r = msg.transaction?.receipt
  if (!r || !Array.isArray(r.logs)) return false
  if (Number(r.status) !== 1 && r.status !== '0x1' && r.status !== '1') return false
  const idTopic = pad(toHex(id), { size: 32 }).toLowerCase()
  return r.logs.some(
    (l) =>
      l.address.toLowerCase() === race.toLowerCase() &&
      l.topics.length === 2 &&
      l.topics[0]!.toLowerCase() === OPENED_TOPIC.toLowerCase() &&
      l.topics[1]!.toLowerCase() === idTopic,
  )
}

/** One bot's wallet and its OWN feed key, generated in memory (never printed, never written to disk). */
export interface BotIdentity {
  name: 'mine' | 'rival'
  account: PrivateKeyAccount
  /** The raw feed key. In memory only: print `keyHash`, never this. */
  readonly key: string
  keyHash: Hex
}

/** `key` is for a caller that already owns the key (the demo reuses FEED_API_KEY): the default is a fresh random one. */
export function newIdentity(name: 'mine' | 'rival', accountIndex: number, key: string = generateKey()): BotIdentity {
  return { name, account: privateKeyToAccount(anvilDevKey(accountIndex)), key, keyHash: apiKeyHash(key) }
}

/** The local race wallets: the account-map roles (shared/config.ts ANVIL_ACCOUNT_MAP). */
export function localIdentities(): { mine: BotIdentity; rival: BotIdentity } {
  return { mine: newIdentity('mine', ANVIL_ACCOUNT_MAP.raceMine), rival: newIdentity('rival', ANVIL_ACCOUNT_MAP.raceRival) }
}

export function localOperator(): PrivateKeyAccount {
  return privateKeyToAccount(anvilDevKey(ANVIL_ACCOUNT_MAP.raceOperator))
}

/** Tickets of one race process: bought once, reused for every trial while the ticket round lasts. */
export interface TicketSession {
  /** Chain-time ms (shared/clock.ts: the wall clock unless the local simulator paused or skipped) when the tickets became active, and when they stop being active (end of that round). */
  activeFrom: number
  activeUntil: number
}

/** Does the session still hold tickets that stay active for at least `minRemainingMs` more? */
export function ticketsUsable(s: TicketSession | undefined, now: number, minRemainingMs: number): boolean {
  return !!s && now >= s.activeFrom && s.activeUntil - now >= minRemainingMs
}

/**
 * Wait until chain time `untilMs` (E2). Polls instead of one long sleep, because the local simulator's clock can be skipped forward
 * while we wait (the demo's chapter 3 does exactly that, and refreshes shared/clock.ts), which must end the wait at once.
 */
export async function sleepUntilChain(untilMs: number, stepMs = 250): Promise<void> {
  for (;;) {
    const left = untilMs - chainNowMs()
    if (left <= 0) return
    await sleep(Math.min(stepMs, left))
  }
}

const TICKETS_PER_BOT = 1
/** "both bots" or the one bot's name (only the feed bots need a ticket); `possessive`: "both bots'" / "mine's". */
function who(bots: readonly BotIdentity[], possessive = false): string {
  return bots.length > 1 ? (possessive ? "both bots'" : 'both bots') : possessive ? `${bots[0]!.name}'s` : bots[0]!.name
}
const MIN_ROUND_LEFT_S = 5
/** Deposit this many ticket prices per bot up front: the first purchase, a repurchase and several renewals. */
const BUDGET_TICKETS = 12

/** Mint (local only), approve and deposit so that each bot's deposited balance is at least `need`. */
async function fundBots(ctxs: readonly TicketsCtx[], need: bigint): Promise<void> {
  await Promise.all(ctxs.map(async (c) => {
    const { wallet, deposited } = await balances(c)
    const toDeposit = need > deposited ? need - deposited : 0n
    if (toDeposit > wallet) await mintLocal({ ...c, quiet: true }, toDeposit - wallet) // never narrated: the local wallet funding is a simulator detail, not a ticket step
  }))
  await Promise.all(ctxs.map(async (c) => {
    const { deposited } = await balances(c)
    if (need > deposited) await approve(c, need - deposited)
  }))
  await Promise.all(ctxs.map(async (c) => {
    const { deposited } = await balances(c)
    if (need > deposited) await deposit(c, need - deposited)
  }))
}

export interface TicketStepOptions {
  /** Print nothing (the demo buys in the background and summarises the result in one line). */
  quiet?: boolean
  /** Called with the activation time (wall-clock ms) as soon as the purchase is mined, before the wait. */
  onBought?: (activeFrom: number, round: number) => void
}

/**
 * Buy one ticket for each bot's key (each from its own wallet), then wait until both are active. Local only: it
 * funds the wallets with the local USDGTest (a quiet public mint). Both purchases must land in the same ticket round, so that both tickets are active in
 * the same following round; if the round rolls over between them, the earlier one is bought again.
 * Prints only the key hashes.
 */
export async function buyTickets(preset: Preset, bots: readonly BotIdentity[], opts: TicketStepOptions = {}): Promise<TicketSession> {
  const q = opts.quiet === true
  const ctxs: TicketsCtx[] = bots.map((b) => ({ ...makeCtx(preset, { PRIVATE_KEY: anvilKeyOf(b) }), quiet: q }))
  if (!q) for (let i = 0; i < bots.length; i++) step(`${bots[i]!.name}: wallet ${bots[i]!.account.address}, feed key hash ${bots[i]!.keyHash}`)
  // Phases run for both bots at once: each purchase takes about one block, so the whole run takes a few blocks, not a dozen.
  const first = await readRound(ctxs[0]!)
  const need = first.price * BigInt(BUDGET_TICKETS * TICKETS_PER_BOT)
  if (!q) {
    step(`${who(bots)} approve and deposit ${fmtToken(need)}${bots.length > 1 ? ' each' : ''}`)
  }
  await fundBots(ctxs, need)

  // Two purchases must land before the round ends: never less than 5s, and at large B at least one purchase's landing time.
  const minLeftS = minRoundLeftS(preset.local!.blockMs)
  let lastReason: unknown
  for (let attempt = 1; attempt <= 4; attempt++) {
    let r = await readRound(ctxs[0]!)
    const left = Number(r.roundEnd) - nowSec()
    if (left < minLeftS) {
      if (!q) note(`the ticket round ends in ${Math.max(left, 0)}s, too soon for two purchases to land together: waiting for the next one`)
      await sleepUntilChain(chainNowMs() + (Math.max(left, 0) + 1) * 1000)
      r = await readRound(ctxs[0]!)
    }
    if (!q) step(`${who(bots)} buy ${TICKETS_PER_BOT} ticket in round ${r.round} (each purchase names the key hash only)`)
    const results = await Promise.allSettled(ctxs.map(async (c, i) => {
      const ri = await readRound(c)
      checkGrandfather(ri, TICKETS_PER_BOT)
      return purchase(c, ri, TICKETS_PER_BOT, bots[i]!.keyHash)
    }))
    const ok = results.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof purchase>>> => x.status === 'fulfilled').map((x) => x.value)
    if (ok.length === bots.length && new Set(ok.map((p) => p.round)).size === 1) {
      const p = ok[0]!
      const activeFrom = Number(p.accessStart) * 1000
      const activeUntil = activeFrom + preset.local!.tickets.roundSeconds * 1000
      const wait = Math.max(0, activeFrom - chainNowMs())
      opts.onBought?.(activeFrom, Number(p.round))
      if (!q) {
        step(`tickets bought in ticket round ${p.round}`)
        note(`They become active when that round ends, ${fmtWhen(p.accessStart)}.`)
        step(`waiting ~${Math.ceil(wait / 1000)}s for the tickets to activate`)
        note(`LOCAL: a ticket round is ${preset.local!.tickets.roundSeconds}s; on Arbitrum One it is 24h.`)
      }
      await sleepUntilChain(activeFrom + 300)
      return { activeFrom, activeUntil }
    }
    const why = results.find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
    if (why) lastReason = why.reason
    if (!q) step(`the purchases did not land in the same ticket round${why ? ` (${formatTicketsError(why.reason)})` : ''}; buying again (attempt ${attempt} of 4)`)
  }
  throw buyFailure(lastReason)
}

/** Pure: the error after 4 failed attempts; it names the last rejection (also as `cause`), quiet or not. */
export function buyFailure(lastReason: unknown): Error {
  const reason = lastReason === undefined ? '' : formatTicketsError(lastReason)
  const why = lastReason === undefined ? '' : ` Last error: ${reason}${reason.endsWith('.') ? '' : '.'}`
  return new Error(`could not buy both tickets inside one ticket round after 4 attempts.${why} Rerun (TICKET_ROUND_SECONDS may be too short for this machine).`, lastReason === undefined ? undefined : { cause: lastReason })
}

/** The ticket round running now (number and end, wall-clock ms), read from the Tickets contract. */
export async function readTicketRound(preset: Preset, bot: BotIdentity): Promise<{ round: number; roundEndMs: number }> {
  const r = await readRound(makeCtx(preset, { PRIVATE_KEY: anvilKeyOf(bot) }))
  return { round: Number(r.round), roundEndMs: Number(r.roundEnd) * 1000 }
}

/** Pure: the end (wall-clock ms) of the ticket round that is running at `now`, for a session whose tickets are active from `activeFrom`. */
export function currentRoundEnd(s: TicketSession, now: number, roundMs: number): number {
  return s.activeFrom + (Math.floor((now - s.activeFrom) / roundMs) + 1) * roundMs
}

export interface RenewInput {
  /** End of the ticket round running now, wall-clock ms. */
  roundEndMs: number
  /** Until when the session's tickets are active (more than `roundEndMs` once next round is already bought). */
  coveredUntilMs: number
  nowMs: number
  /** How long a trial takes (the longest seen so far): the renewal must not wait for a rollover in mid-trial. */
  trialMs: number
  /** Renew when less than this remains of the round. */
  thresholdMs?: number
  /** Less than this is too late for a purchase to land before the round ends. */
  minToBuyMs?: number
  /** The block time B: scales the two limits above when they are not given (see `renewMinToBuyMs`, `renewThresholdMs`). */
  blockMs?: number
}

export const RENEW_THRESHOLD_MS = 15_000
export const RENEW_MIN_TO_BUY_MS = 3_000

/**
 * Pure: how long a purchase needs to land. A tx waits up to one block to be mined and the buyer sees it only after that
 * block closes, so one tx takes about (1 + 0.5) x B including margin; a purchase made of `txs` sequential txs takes
 * (txs + 0.5) x B. Never below the 3s constant (that is what B = 2000 gives for one tx).
 */
export function purchaseLandMs(blockMs: number, txs = 1): number {
  return Math.max(RENEW_MIN_TO_BUY_MS, (txs + 0.5) * blockMs)
}
/** Pure: below this much of the round a renewal cannot land (a plain renewal is one tx). */
export const renewMinToBuyMs = (blockMs: number): number => purchaseLandMs(blockMs, 1)
/** Pure: the least that must remain of a ticket round (seconds) for `buyTickets` to start a purchase: never below 5s, at large B one purchase's landing time. */
export const minRoundLeftS = (blockMs: number): number => Math.max(MIN_ROUND_LEFT_S, Math.ceil(purchaseLandMs(blockMs) / 1000))
/** Pure: true when the session's own `activeUntil` is too close for a renewal to land (it is compared with the ticket's expiry, not the round end). */
export const renewTooLate = (activeUntilMs: number, nowMs: number, blockMs: number): boolean => activeUntilMs - nowMs < renewMinToBuyMs(blockMs)
/** Pure: renew when less than this remains: 15s, or 4 x B when blocks are slow (the renewal takes a few blocks). */
export const renewThresholdMs = (blockMs: number): number => Math.max(RENEW_THRESHOLD_MS, 4 * blockMs)

/**
 * Pure: should the bots buy their tickets for the NEXT round now? Called between trials.
 * 'no' = enough of the round is left (or next round is already bought); 'renew' = buy now; 'too-late' = not enough time
 * for a purchase to land, so the caller falls back to the rebuy-and-wait path.
 */
export function renewDecision(i: RenewInput): 'no' | 'renew' | 'too-late' {
  if (i.coveredUntilMs > i.roundEndMs) return 'no'
  const left = i.roundEndMs - i.nowMs
  const minToBuy = i.minToBuyMs ?? (i.blockMs !== undefined ? renewMinToBuyMs(i.blockMs) : RENEW_MIN_TO_BUY_MS)
  if (left < minToBuy) return 'too-late'
  const threshold = i.thresholdMs ?? (i.blockMs !== undefined ? renewThresholdMs(i.blockMs) : RENEW_THRESHOLD_MS)
  return left < Math.max(threshold, i.trialMs) ? 'renew' : 'no'
}

/**
 * Buy each bot a ticket for the next ticket round with the SAME key, while the current round is still running
 * (fast-feed/README.md: a key with tickets in both rounds keeps its connection). Returns the extended session, or
 * undefined when the purchases did not land together before the round ended (the caller then falls back to a rebuy).
 */
export async function renewTickets(preset: Preset, bots: readonly BotIdentity[], s: TicketSession, opts: TicketStepOptions = {}): Promise<TicketSession | undefined> {
  const q = opts.quiet === true
  const ctxs: TicketsCtx[] = bots.map((b) => ({ ...makeCtx(preset, { PRIVATE_KEY: anvilKeyOf(b) }), quiet: q }))
  const r0 = await readRound(ctxs[0]!)
  if (!q) step(`renewing ${who(bots, true)} tickets for round ${r0.round + 1n} (the docs' every-round renewal): bought in round ${r0.round}, with the same keys`)
  if (!q) note(`a key that holds tickets in both rounds keeps its feed connection across the rollover (fast-feed/README.md); round ${r0.round} ends ${fmtWhen(r0.roundEnd)}`)
  // The ticket price moves between rounds: top up only when fewer than 3 tickets' worth is left deposited (a top-up costs a few blocks).
  const low = (await Promise.all(ctxs.map((c) => balances(c)))).some((b) => b.deposited < r0.price * 3n)
  if (low) await fundBots(ctxs, r0.price * BigInt(BUDGET_TICKETS * TICKETS_PER_BOT))
  // A top-up takes several blocks: with slow blocks little of the ticket's own time may be left afterwards, and a purchase that lands after it expires leaves a gap.
  if (renewTooLate(s.activeUntil, chainNowMs(), preset.local!.blockMs)) {
    if (!q) step('too little of the ticket round is left for the renewal to land: falling back to buying again when the tickets run out')
    return undefined
  }
  const results = await Promise.allSettled(ctxs.map(async (c, i) => {
    const ri = await readRound(c)
    checkGrandfather(ri, TICKETS_PER_BOT)
    return purchase(c, ri, TICKETS_PER_BOT, bots[i]!.keyHash)
  }))
  const ok = results.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof purchase>>> => x.status === 'fulfilled').map((x) => x.value)
  if (ok.length !== bots.length || new Set(ok.map((p) => p.round)).size !== 1) {
    const why = results.find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
    if (!q) step(`the renewals did not land in one ticket round${why ? ` (${formatTicketsError(why.reason)})` : ''}: falling back to buying again when the tickets run out`)
    return undefined
  }
  // The purchase must have been in the round the session is active in: it then starts exactly where the session ends.
  if (Number(ok[0]!.accessStart) * 1000 !== s.activeUntil) {
    if (!q) step('the ticket round rolled over before the renewals landed: they would leave a gap, so falling back to buying again')
    return undefined
  }
  const until = s.activeUntil + preset.local!.tickets.roundSeconds * 1000
  return { activeFrom: s.activeFrom, activeUntil: Math.max(s.activeUntil, until) }
}

/** The local public Anvil key of a bot (LOCAL ONLY). */
function anvilKeyOf(b: BotIdentity): Hex {
  const idx = b.name === 'mine' ? ANVIL_ACCOUNT_MAP.raceMine : ANVIL_ACCOUNT_MAP.raceRival
  return anvilDevKey(idx)
}

/** Sign `claim(id)` with explicit nonce, gas and fees, BEFORE the trigger: nothing is filled or estimated at fire time. */
export async function presignClaim(a: {
  account: PrivateKeyAccount
  race: Address
  id: bigint
  tip: bigint
  chainId: number
  read: ReturnType<typeof createPublicClient>
}): Promise<{ raw: Hex; nonce: number; gas: bigint }> {
  const data = encodeFunctionData({ abi: raceAbi, functionName: 'claim', args: [a.id] })
  const nonce = await a.read.getTransactionCount({ address: a.account.address, blockTag: 'pending' })
  // claim never reverts, so estimating against the unopened race works; the margin covers the open-race storage writes.
  const estimate = await a.read.estimateGas({ account: a.account.address, to: a.race, data })
  const gas = (estimate * 11n) / 10n + CLAIM_GAS_MARGIN
  const raw = await presign({ to: a.race, data, tip: a.tip, maxFee: MAX_FEE, nonce, gas, account: a.account, chain: { id: a.chainId } })
  return { raw, nonce, gas }
}

interface WatchBotBase {
  name: string
  id: bigint
  /** Wait this long after seeing `Opened` before sending (the rival: 0; "mine": a small delay). */
  delayMs: number
  /** The pre-signed claim. */
  raw: Hex
  /** Sends a raw tx to the sequencer endpoint and returns its hash. */
  send: (raw: Hex) => Promise<Hex>
}

/** What a trial needs from either watcher. */
export interface RaceBot {
  readonly name: string
  readonly via: 'feed' | 'poll'
  seenAt?: number
  sentAt?: number
  hash?: Hex
  openBlock?: number
  error?: string
  connect(timeoutMs?: number, net?: '--local' | '--testnet'): Promise<void>
  waitSent(timeoutMs: number): Promise<boolean>
  requireSent(timeoutMs: number): Promise<void>
  close(): Promise<void>
}

/** What both watchers share: fire the pre-signed claim once, record when, and report why nothing was sent. */
abstract class WatchBot {
  abstract readonly via: 'feed' | 'poll'
  /** Wall-clock ms (Date.now) when this bot learned about `Opened`. */
  seenAt?: number
  /** Ms just before the claim was handed to the sequencer. */
  sentAt?: number
  hash?: Hex
  /** The block number of the `open` tx, as this bot's source reported it. */
  openBlock?: number
  error?: string
  protected fired = false
  private resolveSent!: () => void
  /** Resolves once the claim was sent (or failed to). */
  readonly sent = new Promise<void>((r) => (this.resolveSent = r))
  readonly name: string

  protected constructor(private readonly b: WatchBotBase) {
    this.name = b.name
  }

  /** The first sighting of `Opened`: remember it and fire (after the delay), once. */
  protected trigger(receivedAt: number, block: number | undefined): void {
    if (this.fired) return
    this.fired = true
    this.seenAt = receivedAt
    this.openBlock = block
    if (this.b.delayMs <= 0) void this.fire()
    else setTimeout(() => void this.fire(), this.b.delayMs)
  }

  private async fire(): Promise<void> {
    this.sentAt = Date.now()
    try {
      this.hash = await this.b.send(this.b.raw)
    } catch (e) {
      this.error = `send failed: ${(e as Error).message.split('\n')[0]}`
    }
    this.resolveSent()
  }

  /** Why nothing was sent (for the timeout error). */
  protected abstract why(): string

  /** Resolves true when the claim was sent, false on timeout or when the claim could not be sent. */
  async waitSent(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    const stop = new Promise<false>((r) => (timer = setTimeout(() => r(false), timeoutMs)))
    const res = await Promise.race([this.sent.then(() => true as const), stop])
    clearTimeout(timer)
    return res && this.hash !== undefined
  }

  /** Like `waitSent`, but throws an error that names the bot and says why it did not fire. */
  async requireSent(timeoutMs: number): Promise<void> {
    if (await this.waitSent(timeoutMs)) return
    const seen = this.seenAt !== undefined
    throw new Error(
      seen
        ? `${this.name}: saw Opened(${this.b.id}) but could not send its claim (${this.error ?? 'unknown error'})`
        : `${this.name}: did not see Opened(${this.b.id}) within ${+(timeoutMs / 1000).toFixed(1)}s (${this.why()})`,
    )
  }

  abstract connect(timeoutMs?: number, net?: '--local' | '--testnet'): Promise<void>
  abstract close(): Promise<void>
}

export interface ClaimBotOptions extends WatchBotBase {
  feedUrl: string
  /** The bot's own raw feed key (sent as the Bearer token, never printed). */
  apiKey: string
  race: Address
  /** Called once, when `Opened` is first seen: the block the feed message carried and when it arrived. */
  onSeen?: (block: number, receivedAt: number) => void
  /** F1: called for EVERY message of this bot's own feed connection (the demo collects the race block's rows from it). */
  onFeedMessage?: (msg: FeedMessageJson, receivedAt: number) => void
}

/**
 * A Fast Feed watcher: reuses the reusable client (fast-feed/client/client.ts), filters each message for the Race's
 * `Opened(id)` event and fires its pre-signed claim, once.
 */
export class ClaimBot extends WatchBot implements RaceBot {
  readonly via = 'feed' as const
  closedWith?: { code: number; reason: string }
  private client?: FeedClient

  constructor(private readonly o: ClaimBotOptions) {
    super(o)
  }

  protected why(): string {
    return this.error ?? (this.closedWith ? `feed closed ${this.closedWith.code} ${this.closedWith.reason}` : 'no Opened message arrived on its feed connection')
  }

  /** Connect to the feed, retrying while the ticket is not active yet (401), the slot is busy (429) or the read failed (503). */
  async connect(timeoutMs = 20_000, net: '--local' | '--testnet' = '--local'): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const c = connectFeed({
        url: this.o.feedUrl,
        apiKey: this.o.apiKey,
        onMessage: (m, at) => this.onMessage(m, at),
        onClose: (code, reason) => (this.closedWith = { code, reason }),
        onError: (e) => (this.error ??= e.message),
      })
      try {
        await c.ready
        this.client = c
        return
      } catch (e) {
        await c.close()
        if (e instanceof FeedRejectedError && [401, 429, 503].includes(e.status) && Date.now() < deadline) {
          await sleep(400)
          continue
        }
        if (e instanceof FeedRejectedError) throw new Error(`${this.name}: ${rejectionLines(e.status, e.body, net).join('\n')}`)
        throw e
      }
    }
  }

  private onMessage(msg: FeedMessageJson, receivedAt: number): void {
    this.o.onFeedMessage?.(msg, receivedAt)
    if (this.fired || !isOpenedFor(msg, this.o.race, this.o.id)) return
    this.trigger(receivedAt, msg.transaction.block_number)
    this.o.onSeen?.(msg.transaction.block_number, receivedAt)
  }

  close(): Promise<void> {
    return this.client?.close() ?? Promise.resolve()
  }
}

export interface PollingBotOptions extends WatchBotBase {
  /** The preset's read RPC. */
  rpcUrl: string
  race: Address
  /** Poll period, ms. */
  pollMs: number
}

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = (await res.json()) as { result?: T; error?: { message?: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`)
  return body.result as T
}

/**
 * The slow competitor: no Fast Feed, it polls the read RPC every `pollMs` with `eth_getLogs` (Race address, `Opened`
 * topic, id) and fires its pre-signed claim once, on the first poll that returns the log. The RPC shows a block only
 * after its block boundary (plus the publish delay locally), so the bot learns about `Opened` later than the feed does,
 * by that delay plus up to one poll interval.
 */
export class PollingBot extends WatchBot implements RaceBot {
  readonly via = 'poll' as const
  /** Polls made so far, and the last poll error (a failing poll is retried at the next tick, never fatal). */
  polls = 0
  lastPollError?: string
  private fromBlock = 0
  private stopped = false
  private timer?: NodeJS.Timeout
  private wake?: () => void

  constructor(private readonly o: PollingBotOptions) {
    super(o)
  }

  protected why(): string {
    return `${this.polls} poll(s) of ${this.o.rpcUrl} every ${this.o.pollMs}ms returned no Opened log${this.lastPollError ? `; last poll error: ${this.lastPollError}` : ''}`
  }

  /** Reads the current head (logs are searched from there on) and starts polling in the background. */
  async connect(): Promise<void> {
    const head = await rpcCall<string>(this.o.rpcUrl, 'eth_blockNumber', [])
    this.fromBlock = Number(BigInt(head))
    void this.loop()
  }

  private async loop(): Promise<void> {
    let next = Date.now()
    while (!this.stopped && !this.fired) {
      await this.poll()
      if (this.fired) return
      next = Math.max(next + this.o.pollMs, Date.now()) // a slow poll restarts the schedule from now: no burst of catch-up polls
      const wait = Math.max(0, next - Date.now())
      await new Promise<void>((r) => {
        this.wake = r
        this.timer = setTimeout(r, wait)
      })
    }
  }

  private async poll(): Promise<void> {
    this.polls++
    try {
      const logs = await rpcCall<{ blockNumber: string }[]>(this.o.rpcUrl, 'eth_getLogs', [
        {
          address: this.o.race,
          topics: [OPENED_TOPIC, pad(toHex(this.o.id), { size: 32 })],
          fromBlock: toHex(this.fromBlock),
          toBlock: 'latest',
        },
      ])
      this.lastPollError = undefined
      if (!this.stopped && Array.isArray(logs) && logs.length > 0) this.trigger(Date.now(), Number(BigInt(logs[0]!.blockNumber)))
    } catch (e) {
      this.lastPollError = (e as Error).message.split('\n')[0]
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    this.wake?.()
  }
}

export interface RaceReader {
  read: ReturnType<typeof createPublicClient>
  race: Address
}

export function makeReader(rpcUrl: string, race: string): RaceReader {
  return { read: createPublicClient({ transport: http(rpcUrl) }), race: getAddress(race) }
}

/** Rank (1 = winner, 0 = did not claim) of `who` in race `id`. */
export async function readRank(r: RaceReader, id: bigint, who: Address): Promise<number> {
  return Number(await r.read.readContract({ address: r.race, abi: raceAbi, functionName: 'rankOf', args: [id, who] }))
}

/** The rank-1 address of race `id`, or the zero address. */
export async function readWinner(r: RaceReader, id: bigint): Promise<Address> {
  return (await r.read.readContract({ address: r.race, abi: raceAbi, functionName: 'winner', args: [id] })) as Address
}

export async function isRaceOpen(r: RaceReader, id: bigint): Promise<boolean> {
  return (await r.read.readContract({ address: r.race, abi: raceAbi, functionName: 'isOpen', args: [id] })) as boolean
}

/** Sign `open(id)` with the operator wallet (explicit nonce, gas and fees). */
export async function presignOpen(a: { operator: PrivateKeyAccount; race: Address; id: bigint; chainId: number; read: ReturnType<typeof createPublicClient> }): Promise<Hex> {
  const data = encodeFunctionData({ abi: raceAbi, functionName: 'open', args: [a.id] })
  const nonce = await a.read.getTransactionCount({ address: a.operator.address, blockTag: 'pending' })
  const estimate = await a.read.estimateGas({ account: a.operator.address, to: a.race, data })
  return presign({ to: a.race, data, tip: 10_000_000n, maxFee: MAX_FEE, nonce, gas: (estimate * 11n) / 10n + CLAIM_GAS_MARGIN, account: a.operator, chain: { id: a.chainId } })
}
