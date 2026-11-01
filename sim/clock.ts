// E2: the simulator's own clock. LOCAL ONLY: Arbitrum never pauses, and the real chain time is the wall clock.
//
// Two clocks, both derived from the wall clock:
//  - sim time   `simNow()`      = wall - (time spent paused). Frozen while paused, never decreases. The PGA round schedule,
//                               the block reveal times and the "ms until next round" answers use it, so a pause freezes them.
//  - chain time `chainNowMs()`  = simNow + skipped. The block timestamps, the `eth_call` time override, the feed auth and its
//                               rollover timer and the Tickets round all use it. A forward-only skip moves it ahead of sim time
//                               (to jump to the next ticket round without waiting).
// `toWall(simMs)` converts a sim instant to the wall instant a client can compare with Date.now().
// Pure apart from the injected wall clock, so the tests drive it with a fake one.

/** A refused clock request (another holder owns the pause, a skip too far ahead): the RPC answers it as -32000. */
export class ClockError extends Error {}

export class SimClock {
  private pausedAt: number | undefined
  private pausedTotal = 0
  private skipped = 0
  private lastSim = -Infinity
  private resumeWaiters: (() => void)[] = []
  private readonly pauseListeners = new Set<() => void>()

  constructor(private readonly wall: () => number = Date.now) {}

  get paused(): boolean {
    return this.pausedAt !== undefined
  }

  /** Wall time minus the time spent paused; frozen while paused; never decreases. */
  simNow(): number {
    const s = (this.pausedAt ?? this.wall()) - this.pausedTotal
    if (s > this.lastSim) this.lastSim = s
    return this.lastSim
  }

  /** Sim time plus the forward skips: the time the chain (block timestamps, Tickets rounds, feed auth) sees. */
  chainNowMs(): number {
    return this.simNow() + this.skipped
  }

  /** Total time spent paused, an ongoing pause included. */
  get pausedTotalMs(): number {
    return this.pausedTotal + (this.pausedAt !== undefined ? Math.max(0, this.wall() - this.pausedAt) : 0)
  }

  get skippedMs(): number {
    return this.skipped
  }

  /** Wall instant of a sim instant (an ongoing pause counts), so `toWall(simNow()) == wall` also while paused. */
  toWall(simMs: number): number {
    return simMs + this.pausedTotalMs
  }

  /** How far the chain clock is behind the wall clock (negative = ahead, after a skip). */
  chainLagMs(): number {
    return this.wall() - this.chainNowMs()
  }

  /** Freeze. Returns false when already paused (idempotent). */
  pause(): boolean {
    if (this.pausedAt !== undefined) return false
    this.simNow() // fix lastSim at the frozen value
    this.pausedAt = this.wall()
    for (const l of [...this.pauseListeners]) l()
    return true
  }

  /** Unfreeze. Returns the length of the pause in ms (0 when it was not paused). */
  resume(): number {
    if (this.pausedAt === undefined) return 0
    const ms = Math.max(0, this.wall() - this.pausedAt)
    this.pausedTotal += ms
    this.pausedAt = undefined
    for (const w of this.resumeWaiters.splice(0)) w()
    return ms
  }

  /** Move the chain clock forward to `targetMs` (chain time). Forward only: a target already reached adds nothing. Returns the ms added. */
  skipTo(targetMs: number): number {
    const add = Math.max(0, targetMs - this.chainNowMs())
    this.skipped += add
    return add
  }

  /** Resolves at once when running, else when the clock is resumed (or `release()` is called). */
  running(): Promise<void> {
    if (this.pausedAt === undefined) return Promise.resolve()
    return new Promise((resolve) => this.resumeWaiters.push(resolve))
  }

  /** Wake everything waiting in `running()` without resuming (the owner is shutting down). */
  release(): void {
    for (const w of this.resumeWaiters.splice(0)) w()
  }

  /** Called when the clock is paused (a sleep waiting on sim time must wake up). Returns the unsubscribe function. */
  onPause(fn: () => void): () => void {
    this.pauseListeners.add(fn)
    return () => void this.pauseListeners.delete(fn)
  }
}
