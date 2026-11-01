// The single palette and printer: every command narrates through these, so each kind of output looks the same everywhere.
//
//   kind        style                 printer
//   internal    magenta               internal()   sequencer internals; shown only in --local (a real sequencer is a black box)
//   step        cyan                  step()       "==> an action happening now"
//   important   bold + inverse        important()  chapter headers, the user's own tx, key moments
//   note        yellow                note()       "NOTE: ..." an explanation that is not an action
//   warn        bold yellow           warn()       "WARNING: ..." a request that will not be honoured (stdout)
//   result      bold green / red / yellow result()     PASS / FAIL / INCONCLUSIVE
//   error       red (stderr)          error()      errors and refusals
//   tables      default colour        plain()      "yours" rows bold (the live view)
//
// Colour is on only when it helps: see `colorEnabled`. Logs, pipes and tests stay plain text.

export type Kind = 'internal' | 'step' | 'important' | 'note' | 'warn' | 'pass' | 'fail' | 'inconclusive' | 'error' | 'bold'

/** The exact ANSI start sequence per kind (every styled string ends with RESET). */
export const PALETTE: Readonly<Record<Kind, string>> = {
  internal: '\x1b[35m', // magenta
  step: '\x1b[36m', // cyan
  important: '\x1b[1;7m', // bold + inverse
  note: '\x1b[33m', // yellow
  warn: '\x1b[1;33m', // bold yellow
  pass: '\x1b[1;32m', // bold green
  fail: '\x1b[1;31m', // bold red
  inconclusive: '\x1b[1;33m', // bold yellow
  error: '\x1b[31m', // red
  bold: '\x1b[1m',
}
export const RESET = '\x1b[0m'

/**
 * Pure gate. Precedence: NO_COLOR (any non-empty value) wins and turns colour off; then FORCE_COLOR: "0" or "false" turns it
 * off even on a TTY (Node convention), any other non-empty value turns it on even when not a TTY; otherwise colour is on only
 * when the stream is a TTY.
 */
export function colorEnabled(isTTY: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.NO_COLOR ?? '') !== '') return false
  const f = (env.FORCE_COLOR ?? '').toLowerCase()
  if (f === '0' || f === 'false') return false
  if (f !== '') return true
  return isTTY === true
}

/** Wrap `text` in the style of `kind`, unconditionally. Pure. */
export function style(kind: Kind, text: string): string {
  return `${PALETTE[kind]}${text}${RESET}`
}

/** Wrap `text` in the style of `kind` only when colour is enabled for stdout (the default) or the given stream flag. */
export function color(kind: Kind, text: string, enabled: boolean = colorEnabled(process.stdout.isTTY)): string {
  return enabled && text !== '' ? style(kind, text) : text
}

const colorErr = (kind: Kind, text: string) => color(kind, text, colorEnabled(process.stderr.isTTY))

let internalVisible = false

export function setInternalVisible(v: boolean): void {
  internalVisible = v
}

/** An action happening now. */
export function step(msg: string): void {
  console.log(color('step', `==> ${msg}`))
}

/** Pure: an explanation line. Always starts with "NOTE:", never doubled. */
export function noteText(msg: string): string {
  return `NOTE: ${msg.replace(/^\s*NOTE:\s*/, '')}`
}

/** An explanation that is not an action. Prints "NOTE: msg" (the prefix is added once, also without colour). */
export function note(msg: string): void {
  console.log(color('note', noteText(msg)))
}

/** Pure: a warning line. Always starts with "WARNING:", never doubled. */
export function warnText(msg: string): string {
  return `WARNING: ${msg.replace(/^\s*WARNING:\s*/i, '')}`
}

/** A warning (something the user asked for will not happen, or may not work): bold yellow "WARNING: msg", on stdout like the NOTE lines around it. */
export function warn(msg: string): void {
  console.log(color('warn', warnText(msg)))
}

/** Pre-formed NOTE lines (the first starts with `NOTE:`, the continuation lines are indented): printed in the note colour, one line each. */
export function noteLines(lines: readonly string[]): void {
  for (const l of lines) console.log(color('note', l))
}

/** An important step: bold and highlighted. */
export function important(msg: string): void {
  console.log(color('important', msg))
}

/** Sequencer internals: magenta, and only visible in --local. */
export function internal(msg: string): void {
  if (internalVisible) console.log(color('internal', `[sequencer] ${msg}`))
}

/** A line that is shown whatever the visibility (e.g. a corrupted-feed warning): same magenta tag, red when `isError`. */
export function sequencerAlways(msg: string, isError = false): void {
  console.log(color(isError ? 'error' : 'internal', `[sequencer] ${msg}`))
}

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'
const VERDICT_KIND = { PASS: 'pass', FAIL: 'fail', INCONCLUSIVE: 'inconclusive' } as const

/** Pure: which kind of style a verdict gets. */
export const verdictKind = (v: Verdict): Kind => VERDICT_KIND[v]

/** A result line, bold in the colour of its verdict: green PASS, red FAIL, yellow INCONCLUSIVE. */
export function result(v: Verdict, msg: string): void {
  console.log(color(verdictKind(v), msg))
}

/** An error or refusal: red, on stderr. */
export function error(msg = ''): void {
  console.error(colorErr('error', msg))
}

/** Table bodies and other data lines: default colour, printed as is. */
export function plain(msg = ''): void {
  console.log(msg)
}

/** The mock Fast Feed server's own log lines: magenta like the sequencer's (server internals). */
export function feedServer(msg: string): void {
  console.log(color('internal', `[feed] ${msg}`))
}

/** Pure: the verdict a process exit code stands for (0 PASS, 3 INCONCLUSIVE, anything else FAIL). */
export const verdictOfCode = (code: number): Verdict => (code === 0 ? 'PASS' : code === 3 ? 'INCONCLUSIVE' : 'FAIL')
