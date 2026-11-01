// E2: the time a CLIENT compares with chain timestamps (ticket rounds, roundEnd, activation times).
// On Arbitrum, and on any stack that never paused or skipped, chain time is the wall clock: the offset is 0.
// Locally the simulator can freeze and skip its chain clock (sim/clock.ts), so a client that talks to it asks `sim_clock` and
// remembers `chainNowMs - Date.now()` here. Wall-clock uses (timings, deadlines, receivedAt) keep using Date.now().

let offsetMs = 0
let frozenAt: number | undefined
let frozenSince: number | undefined
let pausedAcc = 0

function thaw(): void {
  if (frozenSince !== undefined) pausedAcc += Date.now() - frozenSince
  frozenSince = undefined
  frozenAt = undefined
}

/** Wall ms the client has held the simulator paused so far (an ongoing hold included): a wall-clock timeout must not count it. */
export function heldPausedMs(): number {
  return pausedAcc + (frozenSince !== undefined ? Date.now() - frozenSince : 0)
}

/** Chain time in ms as the clients see it: Date.now() plus the offset learned from the local simulator (0 elsewhere); constant while frozen. */
export function chainNowMs(): number {
  return frozenAt ?? Date.now() + offsetMs
}

/** Chain time in whole seconds (what a block timestamp and the Tickets round views use). */
export function chainNowSec(): number {
  return Math.floor(chainNowMs() / 1000)
}

/** Set from `sim_clock`: the simulator's chain time at `atWallMs` (a Date.now() reading taken with the answer). */
export function setChainClock(simChainNowMs: number, atWallMs: number = Date.now()): void {
  offsetMs = simChainNowMs - atWallMs
  thaw()
}

/** The local simulator is paused: its chain clock stands still, so the client's estimate must too (a wait on chain time must not end early). */
export function freezeChainClock(simChainNowMs: number): void {
  if (frozenSince === undefined) frozenSince = Date.now()
  frozenAt = simChainNowMs
}

/** Leave the frozen state (keeping the last known offset): the fallback when the resume and the clock read both failed. */
export function thawChainClock(): void {
  thaw()
}

export function chainOffsetMs(): number {
  return offsetMs
}

/** Tests: back to the wall clock. */
export function resetChainClock(): void {
  offsetMs = 0
  frozenAt = undefined
  frozenSince = undefined
  pausedAcc = 0
}
