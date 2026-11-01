// Fast Feed ticket steps, one exported function per step. Each prints what it does and why.
// Concepts:             https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/fast-feed
// Purchase, deposit, errors: https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/use-fast-feed
//
// Hashing rule for the key: see key.ts (keccak256 of the UTF-8 bytes of the Bearer string).
// For production-style renewals use the official bot:
// https://github.com/OffchainLabs/feed-ticket-contracts/tree/main/bot
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  formatUnits,
  http,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chainNowSec, heldPausedMs } from '../../shared/clock.ts'
import { ConfigError, TOKEN_DECIMALS, walletKey, type Preset } from '../../shared/config.ts'
import { important, note, plain, step } from '../../shared/narrate.ts'
import { accessFor, pendingTickets, type Access, type PurchaseEvent } from './access.ts'
import { erc20Abi, ticketsAbi } from './abi.ts'

/** A problem the user can fix: printed as one line, exit status 1, no stack trace. */
export class UserError extends Error {}

export const fmtToken = (units: bigint): string => `${formatUnits(units, TOKEN_DECIMALS)} TEST`
/** Chain time in seconds (E2: the local simulator's clock can lag or lead the wall clock; elsewhere it is the wall clock). */
export const nowSec = (): number => chainNowSec()
/** `2026-01-01T00:00:00.000Z (in 12s)` / `(3s ago)`. Chain time is the wall clock on Arbitrum; locally the simulator may have paused or skipped it (shared/clock.ts). */
export function fmtWhen(unixSec: bigint | number, now = nowSec()): string {
  const t = Number(unixSec)
  const d = t - now
  return `${new Date(t * 1000).toISOString()} (${d >= 0 ? `in ${d}s` : `${-d}s ago`})`
}

export interface TicketsCtx {
  preset: Preset
  pub: PublicClient
  wallet: WalletClient
  account: Account
  tickets: Address
  token: Address
  /** Print no steps or notes (the demo buys its ticket in the background and summarises it in one line). Errors still throw. */
  quiet?: boolean
  /** Receipt wait limit in ms (default 180000). Time the demo holds the local simulator paused never counts against it. */
  receiptTimeoutMs?: number
}

/** `preset` must be resolved (see resolvePreset in config.ts): local addresses exist only at runtime. */
export function makeCtx(preset: Preset, env: NodeJS.ProcessEnv = process.env): TicketsCtx {
  if (!preset.ticketsProxy || !preset.testToken) throw new ConfigError('Tickets / TEST addresses are not known for this preset.')
  const chain: Chain = {
    id: preset.chainId,
    name: preset.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [preset.rpcUrl] } },
  }
  const account = privateKeyToAccount(walletKey(preset, env)) // key never printed
  return {
    preset,
    account,
    pub: createPublicClient({ chain, transport: http(preset.rpcUrl), pollingInterval: 250 }),
    wallet: createWalletClient({ account, chain, transport: http(preset.sendUrl) }),
    tickets: preset.ticketsProxy as Address,
    token: preset.testToken as Address,
  }
}

/**
 * Wait for a receipt. A wall-clock timeout can run out while the demo holds the local simulator paused (nothing is mined then), so a
 * timeout that coincides with held-pause time is waited out again instead of failing the purchase (E2).
 */
export async function waitReceipt(ctx: Pick<TicketsCtx, 'pub' | 'receiptTimeoutMs'>, hash: Hex) {
  const timeout = ctx.receiptTimeoutMs ?? 180_000
  let seen = heldPausedMs()
  for (;;) {
    try {
      return await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout })
    } catch (e) {
      const now = heldPausedMs()
      if ((e as Error).name !== 'WaitForTransactionReceiptTimeoutError' || now <= seen) throw e
      seen = now
    }
  }
}

async function confirm(ctx: TicketsCtx, hash: Hex, what: string): Promise<void> {
  if (!ctx.quiet) step(`tx ${hash}`)
  const r = await waitReceipt(ctx, hash)
  if (r.status !== 'success') throw new UserError(`${what} reverted on chain (tx ${hash}).`)
  if (!ctx.quiet) step(`mined in block ${r.blockNumber}`)
}

const read = <T>(ctx: TicketsCtx, address: Address, abi: typeof ticketsAbi | typeof erc20Abi, functionName: string, args: unknown[] = []) =>
  ctx.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>

/**
 * LOCAL ONLY: mint TEST to the wallet. The local TestToken has a public `mint`. On Arbitrum Sepolia the
 * TEST token is minted by Offchain Labs (ask on Discord), so this prints a hint and does nothing.
 * This is the ONLY place feature code branches on the network.
 */
export async function mintLocal(ctx: TicketsCtx, amount: bigint): Promise<void> {
  if (ctx.preset.mode !== 'local') {
    note('Mint skipped: on Arbitrum Sepolia, TEST comes from Offchain Labs (ask via Discord); you cannot mint it.')
    return
  }
  if (!ctx.quiet) {
    step(`mint ${fmtToken(amount)} to ${ctx.account.address} `)
    note('Local only: the local TEST token has a public mint.')
  }
  const hash = await ctx.wallet.writeContract({ address: ctx.token, abi: erc20Abi, functionName: 'mint', args: [ctx.account.address, amount], chain: undefined, account: ctx.account })
  await confirm(ctx, hash, 'mint')
}

/** Tickets pulls the tokens with transferFrom, so it needs an allowance first. */
export async function approve(ctx: TicketsCtx, amount: bigint): Promise<void> {
  if (!ctx.quiet) {
    step(`approve the Tickets contract to pull ${fmtToken(amount)}`)
    note('depositToken uses transferFrom, which only works after an ERC20 approve.')
  }
  const hash = await ctx.wallet.writeContract({ address: ctx.token, abi: erc20Abi, functionName: 'approve', args: [ctx.tickets, amount], chain: undefined, account: ctx.account })
  await confirm(ctx, hash, 'approve')
}

/** Move tokens into the contract's internal balance; purchaseTickets debits that balance, not your wallet. */
export async function deposit(ctx: TicketsCtx, amount: bigint): Promise<void> {
  if (!ctx.quiet) {
    step(`depositToken(${fmtToken(amount)})`)
    note('purchaseTickets pays from this deposited balance. Unused balance can be taken back with tickets:withdraw.')
  }
  const hash = await ctx.wallet.writeContract({ address: ctx.tickets, abi: ticketsAbi, functionName: 'depositToken', args: [amount], chain: undefined, account: ctx.account })
  await confirm(ctx, hash, 'deposit')
}

export interface RoundInfo {
  round: bigint
  price: bigint
  roundEnd: bigint
  grandfatherEnd: bigint
  grandfatherCount: bigint
  /** Wall-clock seconds when read. */
  now: number
}

/**
 * Read the round and price right before buying; purchaseTickets reverts if either moved
 * (so you never pay a new round's higher price by accident).
 */
export async function readRound(ctx: TicketsCtx, opts: { print?: boolean } = {}): Promise<RoundInfo> {
  const [round, price, roundEnd, grandfatherEnd, grandfatherCount] = await Promise.all([
    read<bigint>(ctx, ctx.tickets, ticketsAbi, 'roundNumber'),
    read<bigint>(ctx, ctx.tickets, ticketsAbi, 'currentPrice'),
    read<bigint>(ctx, ctx.tickets, ticketsAbi, 'roundEnd'),
    read<bigint>(ctx, ctx.tickets, ticketsAbi, 'grandfatherPeriodEnd'),
    read<bigint>(ctx, ctx.tickets, ticketsAbi, 'grandfatherCount', [ctx.account.address]),
  ])
  const r: RoundInfo = { round, price, roundEnd, grandfatherEnd, grandfatherCount, now: nowSec() }
  if (opts.print) {
    step(`read roundNumber() = ${round} and currentPrice() = ${fmtToken(price)} per ticket`)
    note(`The purchase must name this exact round and price. This round ends ${fmtWhen(roundEnd, r.now)}.`)
    note(`Grandfather period ends ${fmtWhen(grandfatherEnd, r.now)}; you hold ${grandfatherCount} grandfathered ticket(s).`)
  }
  return r
}

/**
 * Pure: is there enough of the ticket round left for a purchase to land? A purchase tx waits up to one block and is seen only
 * after that block closes, so it needs about 1.5 x B (never below 3s, and `minLeftS` never below 5s). When less is left, wait
 * for the next round (`waitS` = the time left + 1s). A local B-aware twin of combo/race.ts's guard (fast-feed must not import combo).
 */
export function purchaseRoomDecision(leftS: number, blockMs: number): { wait: boolean; minLeftS: number; waitS: number } {
  const minLeftS = Math.max(5, Math.ceil(Math.max(3000, 1.5 * blockMs) / 1000))
  const left = Math.max(0, leftS)
  return { wait: leftS < minLeftS, minLeftS, waitS: left + 1 }
}

/** Waits for the next ticket round when the current one is too short for the purchase to land (with a NOTE), then returns. */
export async function ensureRoundRoom(ctx: TicketsCtx, blockMs: number): Promise<void> {
  const r = await readRound(ctx)
  const d = purchaseRoomDecision(Number(r.roundEnd) - nowSec(), blockMs)
  if (!d.wait) return
  note(`the ticket round ends in ${Math.max(Number(r.roundEnd) - nowSec(), 0)}s, too soon for the purchase to land (about ${d.minLeftS}s needed with B = ${blockMs}ms): waiting for the next round`)
  await new Promise((res) => setTimeout(res, d.waitS * 1000))
}

/**
 * During the grandfather period (start of a round) only holders of last round's tickets may buy, up to the
 * number they held. If that blocks us, say so and stop cleanly.
 */
export function checkGrandfather(r: RoundInfo, numTickets: number): void {
  // Tickets.sol applies the rule only when roundNumber > 0 (there are no previous-round tickets in round 0).
  if (r.round > 0n && BigInt(r.now) < r.grandfatherEnd && r.grandfatherCount < BigInt(numTickets)) {
    throw new UserError(
      `Round ${r.round} is in its grandfather period until ${fmtWhen(r.grandfatherEnd, r.now)}: only holders of ` +
        `previous-round tickets may buy, up to the number they held (you hold ${r.grandfatherCount}, requested ${numTickets}). ` +
        `Rerun the command after that time.`,
    )
  }
}

export interface Purchase {
  hash: Hex
  round: bigint
  filled: bigint
  price: bigint
  /** Access starts when the purchase round ends. */
  accessStart: bigint
}

/** `r.round` and `r.price` are what we EXPECT; the contract reverts if the chain disagrees. */
export async function purchase(ctx: TicketsCtx, r: RoundInfo, numTickets: number, keyHash: Hex): Promise<Purchase> {
  if (!ctx.quiet) {
    step(`purchaseTickets(round ${r.round}, price ${fmtToken(r.price)}, ${numTickets} ticket(s), keccak256(key))`)
    note(`Only the key's hash goes on chain: ${keyHash}`)
  }
  const hash = await ctx.wallet.writeContract({
    address: ctx.tickets,
    abi: ticketsAbi,
    functionName: 'purchaseTickets',
    args: [r.round, r.price, BigInt(numTickets), keyHash],
    chain: undefined,
    account: ctx.account,
  })
  if (!ctx.quiet) step(`tx ${hash}`)
  const receipt = await waitReceipt(ctx, hash)
  if (receipt.status !== 'success') {
    throw new UserError(
      `purchaseTickets reverted on chain (tx ${hash}). It passed estimation, so the likely cause is that the round rolled over while the transaction was queued; rerun the command.`,
    )
  }
  if (!ctx.quiet) step(`mined in block ${receipt.blockNumber}`)
  const ev = parseEventLogs({ abi: ticketsAbi, eventName: 'TicketsPurchased', logs: receipt.logs }).find((l) => l.args.apiKeyHash === keyHash)
  return { hash, round: r.round, filled: ev?.args.numTickets ?? BigInt(numTickets), price: ev?.args.price ?? r.price, accessStart: r.roundEnd }
}

/** Quiet balance read: wallet TEST and deposited TEST. */
export async function balances(ctx: TicketsCtx): Promise<{ wallet: bigint; deposited: bigint }> {
  const [wallet, deposited] = await Promise.all([
    read<bigint>(ctx, ctx.token, erc20Abi, 'balanceOf', [ctx.account.address]),
    read<bigint>(ctx, ctx.tickets, ticketsAbi, 'tokenBalance', [ctx.account.address]),
  ])
  return { wallet, deposited }
}

export interface Status {
  walletBalance: bigint
  deposited: bigint
  info: RoundInfo
  thisRound: bigint
  access?: Access
}

/** A key hash's `TicketsPurchased` events and what they mean in `round` (active, pending, expired). Quiet: prints nothing. */
export async function readKeyAccess(ctx: TicketsCtx, keyHash: Hex, round: bigint): Promise<{ access: Access; purchases: PurchaseEvent[] }> {
  const logs = await ctx.pub.getLogs({
    address: ctx.tickets,
    event: ticketsAbi.find((x) => x.type === 'event' && x.name === 'TicketsPurchased') as never,
    args: { apiKeyHash: keyHash } as never,
    fromBlock: ctx.preset.ticketsFromBlock ?? 0n,
    toBlock: 'latest',
  })
  const purchases = logs.map((l) => (l as unknown as { args: PurchaseEvent }).args)
  return { access: accessFor(purchases, round), purchases }
}

/** Where the wallet, the deposit and (optionally) a key hash stand right now. */
export async function status(ctx: TicketsCtx, keyHash?: Hex): Promise<Status> {
  const [walletBalance, deposited, info, thisRound] = await Promise.all([
    read<bigint>(ctx, ctx.token, erc20Abi, 'balanceOf', [ctx.account.address]),
    read<bigint>(ctx, ctx.tickets, ticketsAbi, 'tokenBalance', [ctx.account.address]),
    readRound(ctx),
    read<bigint>(ctx, ctx.tickets, ticketsAbi, 'thisRoundTicketCount', [ctx.account.address]),
  ])
  let access: Access | undefined
  let purchases: PurchaseEvent[] = []
  if (keyHash) ({ access, purchases } = await readKeyAccess(ctx, keyHash, info.round))
  const s: Status = { walletBalance, deposited, info, thisRound, access }
  step(`status for ${ctx.account.address}`)
  plain(`  wallet TEST balance:   ${fmtToken(walletBalance)}`)
  plain(`  deposited balance:     ${fmtToken(deposited)}`)
  plain(`  round:                 ${info.round}`)
  plain(`  ticket price:          ${fmtToken(info.price)}`)
  plain(`  round end:             ${fmtWhen(info.roundEnd, info.now)}`)
  plain(`  grandfather end:       ${fmtWhen(info.grandfatherEnd, info.now)}`)
  plain(`  tickets this round:    ${thisRound}`)
  plain(`  grandfatherCount:      ${info.grandfatherCount}`)
  if (!keyHash) plain('  key:                   no FEED_API_KEY (run npm run key:new)')
  else {
    const k = `  key ${keyHash.slice(0, 10)}...:`
    const end = fmtWhen(info.roundEnd, info.now)
    if (access?.active) {
      plain(`${k} ${access.tickets} ACTIVE ticket(s) in round ${info.round}; expires at ${end}`)
      note('Renew before then.')
      const pending = pendingTickets(purchases, info.round)
      if (pending > 0n) {
        plain(`${' '.repeat(k.length)} ${pending} more bought this round`)
        note(`Those are active in round ${info.round + 1n}.`)
      } else {
        plain(`${' '.repeat(k.length)} nothing bought for round ${info.round + 1n} yet`)
        note('Without a renewal the connection closes with 1008 at the round end.')
      }
    } else if (access?.reason === 'not-yet-active') {
      plain(`${k} 0 active tickets in round ${info.round}; ${access.pending} bought this round`)
      note(`They are NOT active yet: access starts at ${end}.`)
    } else if (access?.reason === 'expired') {
      plain(`${k} 0 active tickets in round ${info.round}; the last purchase was in round ${access.lastRound}`)
      note(`It was active only in round ${access.lastRound + 1n}. Buy to renew.`)
    } else plain(`${k} no ticket purchase found for this key hash`)
  }
  return s
}

/** Withdraw `amount` (token units) of the deposit, or all of it. */
export async function withdraw(ctx: TicketsCtx, amount?: bigint): Promise<bigint> {
  const deposited = await read<bigint>(ctx, ctx.tickets, ticketsAbi, 'tokenBalance', [ctx.account.address])
  const amt = amount ?? deposited
  if (amt === 0n) {
    note('Nothing deposited, nothing to withdraw.')
    return 0n
  }
  step(`withdrawToken(${fmtToken(amt)})`)
  note('Returns unused deposited tokens to your wallet. Tickets already bought are not refunded.')
  let hash: Hex
  try {
    hash = await ctx.wallet.writeContract({ address: ctx.tickets, abi: ticketsAbi, functionName: 'withdrawToken', args: [amt], chain: undefined, account: ctx.account })
  } catch (e) {
    throw new UserError(formatTicketsError(e, 'withdraw'))
  }
  await confirm(ctx, hash, 'withdraw')
  const [after, wallet] = await Promise.all([
    read<bigint>(ctx, ctx.tickets, ticketsAbi, 'tokenBalance', [ctx.account.address]),
    read<bigint>(ctx, ctx.token, erc20Abi, 'balanceOf', [ctx.account.address]),
  ])
  important(`  withdrew ${fmtToken(amt)}; deposited balance now ${fmtToken(after)}; wallet TEST balance ${fmtToken(wallet)}`)
  return amt
}

// ---------------------------------------------------------------------------
// Readable errors. https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/use-fast-feed
// ---------------------------------------------------------------------------

/** One readable sentence per custom error of the Tickets contract (and the ERC20 ones a deposit can hit). */
export function explainRevert(name: string, args: readonly unknown[] = [], context: 'purchase' | 'withdraw' = 'purchase'): string | undefined {
  const a = args as bigint[]
  switch (name) {
    case 'RoundNumberMismatch':
      return `Round changed (expected ${a[0]}, now ${a[1]}): the round rolled over between read and purchase; rerun the command.`
    case 'IncorrectTicketPrice':
      return `Ticket price changed (expected ${fmtToken(a[0]!)}, now ${fmtToken(a[1]!)}): the price is set per round and moved; rerun the command to read the new price.`
    case 'ZeroTicketsRequested':
      return 'You asked for 0 tickets: pass --tickets 1 or more.'
    case 'MaxTicketsSold':
      return 'This round is sold out (maximum tickets per round reached): try again next round.'
    case 'InsufficientTokenBalance':
      if (context === 'withdraw') {
        return `You only have ${fmtToken(a[0]!)} deposited, so you cannot withdraw ${fmtToken(a[1]!)}: pass a smaller --amount, or omit --amount to withdraw everything.`
      }
      return `Not enough deposited TEST (deposited ${fmtToken(a[0]!)}, needed ${fmtToken(a[1]!)}): deposit more (tickets:buy does this for you) or ask for a smaller amount.`
    case 'NotEnoughGrandfatheredTickets':
      return `Grandfather period: you hold ${a[0]} grandfathered ticket(s) but asked for ${a[1]}. Only holders of previous-round tickets may buy now; retry after the grandfather period ends.`
    case 'BeforeFirstRoundStart':
      return 'The first ticket round has not started yet: wait a few seconds and rerun.'
    case 'ERC20InsufficientAllowance':
      return 'The Tickets contract is not approved to pull enough TEST: run the approve step first.'
    case 'ERC20InsufficientBalance':
      return `Wallet TEST balance too low (have ${fmtToken(a[1]!)}, need ${fmtToken(a[2]!)}).`
    default:
      return undefined
  }
}

/** Decode raw revert data (4-byte selector + args) with the Tickets/ERC20 ABIs. */
export function formatRevertData(data: Hex, context: 'purchase' | 'withdraw' = 'purchase'): string | undefined {
  try {
    const d = decodeErrorResult({ abi: [...ticketsAbi, ...erc20Abi], data })
    return explainRevert(d.errorName, d.args ?? [], context)
  } catch {
    return undefined
  }
}

/** Turn any error from the steps above into a readable message (never a stack trace). */
export function formatTicketsError(e: unknown, context: 'purchase' | 'withdraw' = 'purchase'): string {
  if (e instanceof UserError || e instanceof ConfigError) return e.message
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (rev instanceof ContractFunctionRevertedError) {
      const name = rev.data?.errorName
      if (name) return explainRevert(name, rev.data?.args ?? [], context) ?? `The contract reverted with ${name}.`
    }
    const raw = e.walk((x) => typeof (x as { data?: unknown }).data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test((x as { data: string }).data))
    if (raw) {
      const m = formatRevertData((raw as unknown as { data: Hex }).data, context)
      if (m) return m
    }
    if (rev instanceof ContractFunctionRevertedError && rev.reason) return `The contract reverted: ${rev.reason}`
    return e.shortMessage
  }
  return e instanceof Error ? e.message : String(e)
}
