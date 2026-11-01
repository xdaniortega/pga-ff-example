// The access rule shared by the mock feed and `tickets:status`.
// Tickets bought in round N are active for round N+1 ONLY (docs.arbitrum.io "How to use the Fast Feed",
// Step 6 and FAQ: "At the end of the round in which you buy it. It stays active until the end of the next round").
// So the number of ACTIVE tickets for a key hash in round R is the sum of `numTickets` over the
// TicketsPurchased events with that hash and `round == R - 1`. Zero active tickets means HTTP 401, and when a
// round ends the connections of a key that holds no ticket in the new round are closed with 1008.
// https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/use-fast-feed

/** One TicketsPurchased event for a key hash. */
export interface PurchaseEvent {
  round: bigint
  numTickets: bigint
}

export type Access =
  | { active: true; tickets: bigint }
  | { active: false; reason: 'unknown-key' }
  /** Nothing active yet, but tickets bought in the current round activate when it ends. */
  | { active: false; reason: 'not-yet-active'; purchaseRound: bigint; pending: bigint }
  /** Tickets existed, but none was bought in the previous round. */
  | { active: false; reason: 'expired'; lastRound: bigint }

/** Tickets active in `currentRound`: bought in `currentRound - 1`, counts summed. */
export function activeTickets(purchases: readonly PurchaseEvent[], currentRound: bigint): bigint {
  return purchases.filter((p) => p.round === currentRound - 1n).reduce((a, p) => a + p.numTickets, 0n)
}

/** Tickets bought in `currentRound`: they become active when it ends. */
export function pendingTickets(purchases: readonly PurchaseEvent[], currentRound: bigint): bigint {
  return purchases.filter((p) => p.round === currentRound).reduce((a, p) => a + p.numTickets, 0n)
}

export function accessFor(purchases: readonly PurchaseEvent[], currentRound: bigint): Access {
  if (purchases.length === 0) return { active: false, reason: 'unknown-key' }
  const tickets = activeTickets(purchases, currentRound)
  if (tickets > 0n) return { active: true, tickets }
  const pending = pendingTickets(purchases, currentRound)
  if (pending > 0n) return { active: false, reason: 'not-yet-active', purchaseRound: currentRound, pending }
  return { active: false, reason: 'expired', lastRound: purchases.reduce((a, p) => (p.round > a ? p.round : a), 0n) }
}
