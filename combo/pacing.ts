// F6: display-only pacing of the demo's Fast Feed tables. On a terminal the rows of a round table appear one after another
// (3 at once, the 4th a second later, the rest half a second after that), so the transactions seem to ARRIVE. Nothing measured
// changes: the delays are wall-clock sleeps in the output path only. Off a terminal (or with DEMO_ROW_PACING=0) a table prints at once.

/** The first rows appear immediately. */
export const ROW_PACE_FIRST = 3
/** The next row appears this long after the first group. */
export const ROW_PACE_FIRST_GAP_MS = 1000
/** All remaining rows appear this long after that. */
export const ROW_PACE_REST_GAP_MS = 500

/** The one NOTE printed (once per run) before the first paced reveal. */
export const PACING_NOTE = 'Rows appear with exaggerated pacing to show arrival; the real feed delivers a round within milliseconds.'

export interface RevealGroup {
  /** Rows revealed by this group. */
  count: number
  /** Wait before revealing them. */
  delayMs: number
}

/** Pure: how `n` rows are revealed: 3 at once, 1 after 1000 ms, the rest after 500 ms more (10 rows: 3 + 1 + 6). */
export function revealPlan(n: number): RevealGroup[] {
  if (!(n > 0)) return []
  const head = Math.min(n, ROW_PACE_FIRST)
  const out: RevealGroup[] = [{ count: head, delayMs: 0 }]
  if (n > head) out.push({ count: 1, delayMs: ROW_PACE_FIRST_GAP_MS })
  if (n > head + 1) out.push({ count: n - head - 1, delayMs: ROW_PACE_REST_GAP_MS })
  return out
}

/** Pure: pacing is on for a terminal stdout, unless DEMO_ROW_PACING is `0` (any other or unset value means on; never an error). */
export function rowPacingEnabled(isTTY: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTTY === true && (env.DEMO_ROW_PACING ?? '').trim() !== '0'
}

/** Sleep that resolves early (never rejects) when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export interface RowPacerOptions {
  enabled: boolean
  /** Injectable for tests; defaults to `abortableSleep`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}

/** Reveals the rows of a table in the planned groups; one instance serves every table of a run (the NOTE is announced once). */
export class RowPacer {
  private noted = false

  constructor(private readonly o: RowPacerOptions) {}

  get enabled(): boolean {
    return this.o.enabled
  }

  /** Same pacer when `on`; otherwise a disabled one (same abort signal): the unheld flow must never pace, it is display only. */
  when(on: boolean): RowPacer {
    return on || !this.o.enabled ? this : new RowPacer({ ...this.o, enabled: false })
  }

  get aborted(): boolean {
    return this.o.signal?.aborted === true
  }

  /** Before a table of `n` rows starts: when it will really be paced and nothing was announced yet, call `emit` (the one NOTE). */
  announce(n: number, emit: () => void): void {
    if (!this.o.enabled || this.noted || n <= ROW_PACE_FIRST || this.aborted) return
    this.noted = true
    emit()
  }

  /**
   * Reveal `n` rows: `show(shown)` is called with the number of rows visible so far, after each group's delay. Disabled (or n <= 3):
   * one call with `n`, no wait. An abort stops the reveal at once: no further `show`, and the promise resolves promptly.
   */
  async reveal(n: number, show: (shown: number) => void | Promise<void>): Promise<void> {
    if (!this.o.enabled || n <= ROW_PACE_FIRST) return void (await show(n))
    const sleep = this.o.sleep ?? abortableSleep
    let shown = 0
    for (const g of revealPlan(n)) {
      if (g.delayMs > 0) await sleep(g.delayMs, this.o.signal)
      if (this.aborted) return
      shown += g.count
      await show(shown)
    }
  }

  /**
   * Print `lines` in order; lines flagged `row` that are consecutive form a table body, revealed by `reveal`. The two lines before a
   * run (round header, column header) are printed first. `announce` runs before those header lines of the first paced run.
   */
  async printLines<T extends { text: string; row?: true }>(lines: readonly T[], print: (line: T) => void, emitNote: () => void): Promise<void> {
    let i = 0
    while (i < lines.length) {
      if (lines[i]!.row) {
        let j = i
        while (j < lines.length && lines[j]!.row) j++
        let printed = 0
        await this.reveal(j - i, (shown) => {
          for (; printed < shown; printed++) print(lines[i + printed]!)
        })
        if (this.aborted) return
        i = j
        continue
      }
      // The header of a run starts two lines before its first row: announce before it.
      if (lines[i + 2]?.row && !lines[i + 1]?.row && !lines[i]?.row) {
        let j = i + 2
        while (j < lines.length && lines[j]!.row) j++
        this.announce(j - (i + 2), emitNote)
      }
      print(lines[i]!)
      i++
    }
  }
}
