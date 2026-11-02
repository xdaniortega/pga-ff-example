// F5: the staged run of the race chapter, as pure orchestration with every effect injected (unit-tested with fakes; combo/demo.ts wires it
// to the real simulator hold, the feed rows and the terminal). The race itself is unchanged: this only decides what is shown when, and
// holds the simulator after round 1 of the block with `open` so that the stages can be shown one by one.

export type HoldArm = { ok: true } | { ok: false; reason: string }
export type HoldWait = { ok: true; block: number } | { ok: false; reason: string }

export interface StageDeps {
  /** Arm the simulator's hold (before `open` is sent). Never throws: a refusal is `{ok: false}`. */
  arm(): Promise<HoldArm>
  /** Wait until the armed hold took effect; `block` is the block it holds. A timeout releases the hold itself. */
  waitHeld(): Promise<HoldWait>
  /** Resume the simulator (idempotent). */
  release(): Promise<void>
  /** Stage 1: round 1 of block N (the simulator stands still). */
  showStage1(block: number): Promise<void>
  /** Send the extra low-tip txs for round 2 of block N while held, and wait until the proxy accepted them. */
  sendRound2Extras(): Promise<void>
  /** A real `--pause` terminal only: wait for Enter while held. Without it the stager waits `waitMs` instead. */
  prompt?: (block: number) => Promise<void>
  sleep(ms: number): Promise<void>
  /** Stage 2: round 2 of block N on the left and the whole block on the right (block N is sealed; `visibleAt` is the raw wall time). */
  showStage2(visibleAt: number | undefined): Promise<void>
  /** Stage 3: block M under block N on the right. Returns false when there is nothing to show (no prompt is asked then). */
  hasStage3(): boolean
  showStage3(): Promise<void>
  /** Stage 3's Enter, with the simulator frozen meanwhile (a real `--pause` terminal only). */
  promptStage3?: () => Promise<void>
  /** One NOTE: the stages fall back to the unstaged comparison. */
  fallbackNote(reason: string): void
  /** Wait after stage 1 / before stage 3 when nobody presses Enter. */
  waitMs?: number
}

/** One attempt (one race) of the staged chapter. */
export class RaceStager {
  /** The hold was armed before `open`. */
  armed = false
  stage1Shown = false
  stage2Shown = false
  private readonly pending: Promise<void>[] = []

  constructor(private readonly d: StageDeps) {}

  /** True when stage 1 was shown: the comparison continues in stages and the unstaged one must not be printed. */
  get staged(): boolean {
    return this.stage1Shown
  }

  /** Right before `open`: arm the hold. A failure is one NOTE and the unstaged flow. */
  async beforeOpen(): Promise<void> {
    const got = await this.d.arm().catch((e: unknown) => ({ ok: false as const, reason: (e as Error).message }))
    this.armed = got.ok
    if (!got.ok) this.d.fallbackNote(got.reason)
  }

  /**
   * Mine's claim is in the queue: wait for the hold, show stage 1, send the round-2 extras, wait for Enter (or a moment), resume.
   * The simulator is resumed in every case (also after an error); a hold on another block, or none, means the unstaged flow.
   */
  async afterMineSent(openBlock: number | undefined): Promise<void> {
    if (!this.armed) return
    try {
      const held = await this.d.waitHeld()
      if (!held.ok) return this.d.fallbackNote(held.reason)
      if (openBlock !== undefined && held.block !== openBlock) return this.d.fallbackNote(`it held block ${held.block}, not the block of open (${openBlock})`)
      await this.d.showStage1(held.block)
      this.stage1Shown = true
      await this.d.sendRound2Extras().catch(() => undefined) // decoration: never blocks the stage
      if (this.d.prompt) await this.d.prompt(held.block)
      else await this.d.sleep(this.d.waitMs ?? 1000)
    } finally {
      await this.d.release().catch(() => undefined)
    }
  }

  /** The block with `open` became visible: stage 2 (once; not before stage 1; started in the background, awaited by `finish`). */
  onVisible(visibleAt: number | undefined): void {
    if (!this.stage1Shown || this.stage2Shown) return
    this.stage2Shown = true
    this.pending.push(this.d.showStage2(visibleAt).catch(() => undefined))
  }

  /** F6: wait for a stage 2 that is still being shown (a paced table takes a while), so later output does not interleave with it. */
  async drain(): Promise<void> {
    await Promise.all(this.pending)
  }

  /** After the race: finish stage 2 if the visible time never came, then Enter and stage 3 (only when there is a block M). */
  async finish(): Promise<void> {
    if (!this.stage1Shown) return
    if (!this.stage2Shown) {
      this.stage2Shown = true
      this.pending.push(this.d.showStage2(undefined).catch(() => undefined))
    }
    await Promise.all(this.pending)
    if (!this.d.hasStage3()) return
    if (this.d.promptStage3) await this.d.promptStage3()
    else await this.d.sleep(this.d.waitMs ?? 1000)
    await this.d.showStage3()
  }
}
