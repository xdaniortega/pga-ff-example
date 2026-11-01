// Ticket check for the mock feed: how many ACTIVE tickets does this key hash hold on the local Tickets proxy?
// Rule (fast-feed/client/access.ts): the sum of numTickets of the TicketsPurchased(apiKeyHash) events whose round is
// currentRound - 1. Tickets bought in round N are active in round N+1 only.
// The current round is read from the contract at wall-clock time (block-timestamp override), because the
// latest block's timestamp lags: see the TIMESTAMP NOTE in sim/deploy.ts and `withNow` in sim/rpc.ts.
// Events are found with one eth_getLogs per check (a full scan, fine at workshop scale).
import { feedServer } from '../../shared/narrate.ts'
import { decodeErrorResult, decodeEventLog, encodeFunctionData, getAbiItem, toEventSelector, type Hex } from 'viem'
import { ticketsAbi } from '../client/abi.ts'
import { accessFor, type PurchaseEvent } from '../client/access.ts'
import { RpcCallError, type Anvil } from '../../sim/chain.ts'
import { withNow } from '../../sim/rpc.ts'
import type { FeedAuth } from './feed.ts'

const TICKETS_PURCHASED = toEventSelector(getAbiItem({ abi: ticketsAbi, name: 'TicketsPurchased' }))

/** The decoded custom-error name of a failed call, if it carries revert data. */
function revertName(e: unknown): string | undefined {
  if (!(e instanceof RpcCallError) || typeof e.data !== 'string') return undefined
  try {
    return decodeErrorResult({ abi: ticketsAbi, data: e.data as Hex }).errorName
  } catch {
    return undefined
  }
}

export function ticketAuth(anvil: Anvil, tickets: string, fromBlock = 0, chainNowMs: () => number = Date.now): FeedAuth {
  const view = async (fn: 'roundNumber' | 'roundEnd', now: number): Promise<bigint> =>
    BigInt(
      await anvil.call<Hex>(
        'eth_call',
        withNow([{ to: tickets, data: encodeFunctionData({ abi: ticketsAbi, functionName: fn }) }], now),
      ),
    )

  return async (keyHash) => {
    const now = Math.floor(chainNowMs() / 1000) // chain time: the simulator's clock (frozen while paused, moved by a skip)
    let round: bigint
    let roundEnd: bigint
    try {
      round = await view('roundNumber', now)
      roundEnd = await view('roundEnd', now)
    } catch (e) {
      // BeforeFirstRoundStart is a normal "not started"; anything else is a failure to read the contract.
      if (revertName(e) === 'BeforeFirstRoundStart') return { ok: false, reason: 'ticket rounds have not started yet' }
      feedServer(`could not read Tickets: ${(e as Error).message}`)
      return { ok: false, transient: true, reason: 'could not read Tickets on the local chain (see the simulator log)' }
    }
    const logs = await anvil.call<{ topics: Hex[]; data: Hex }[]>('eth_getLogs', [
      { address: tickets, fromBlock: '0x' + fromBlock.toString(16), toBlock: 'latest', topics: [TICKETS_PURCHASED, null, null, keyHash] },
    ])
    const purchases: PurchaseEvent[] = logs.map((l) => {
      const ev = decodeEventLog({ abi: ticketsAbi, eventName: 'TicketsPurchased', topics: l.topics as [Hex, ...Hex[]], data: l.data })
      return { round: ev.args.round, numTickets: ev.args.numTickets }
    })
    const a = accessFor(purchases, round)
    if (a.active) return { ok: true, tickets: Number(a.tickets), round, roundEnd: Number(roundEnd) }
    if (a.reason === 'unknown-key') {
      return { ok: false, reason: 'unknown key: no ticket was bought for this key. Buy one with npm run tickets:buy.' }
    }
    if (a.reason === 'expired') {
      return {
        ok: false,
        reason: `ticket expired: the key's last ticket was bought in round ${a.lastRound} and was active only in round ${a.lastRound + 1n}; it holds no ticket in round ${round}. Buy before each round ends.`,
      }
    }
    return {
      ok: false,
      reason: `ticket not active yet: it was bought in round ${a.purchaseRound}, and access starts when that round ends, at ${new Date(Number(roundEnd) * 1000).toISOString()} (in ${Number(roundEnd) - now}s)`,
    }
  }
}
