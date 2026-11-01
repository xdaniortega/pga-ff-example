// C3: `npm run demo -- --local --pause` as a real process (the demo starts and owns its own stack): slow preset, its own
// ports, a 20s ticket round, feed auth ON, no PRIVATE_KEY, no .env, stdin NOT a terminal (so --pause must not wait).
// Asserts the structure of the story, never absolute durations: all six chapters, chapter 4 (E3) showing round 1 of block X, the
// NOTE, our injected tx at index 0 of round 2 of the SAME block X (competitors after it), the sealed line, the short timing and FCFS
// tables (positive feed lead), mine at rank 1 in the race, no raw key, and no anvil left behind. The process is killed on a timer if it is stuck.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { FIFO_FAILURE, PAUSE_IGNORED } from '../demo.ts'
import { apiKeyHash } from '../../fast-feed/client/key.ts'
import { buildContracts } from '../../sim/build.ts'
import { isPortFree } from '../../sim/chain.ts'

const ports = { rpc: '43547', feed: '43642', anvil: '43545' }
const env: NodeJS.ProcessEnv = {
  ...process.env, BLOCK_PUBLISH_DELAY_MS: '100', SIM_ORDER: 'pga', FEED_AUTH: 'on', TICKET_ROUND_SECONDS: '20',
  SIM_RPC_PORT: ports.rpc, SIM_FEED_PORT: ports.feed, SIM_ANVIL_PORT: ports.anvil,
  ENV_FILE: '/nonexistent-env-file', // never read the repo .env
}
delete env.PRIVATE_KEY
// A known random marker as FEED_API_KEY: it must never be printed, only its keccak256 hash.
const marker = randomBytes(32).toString('hex')
env.FEED_API_KEY = marker
delete env.MY_ADDRESSES

function runDemo(args: string[], killAfterMs: number, runEnv: NodeJS.ProcessEnv = env): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // stdin 'ignore' = /dev/null: not a TTY.
    const child = spawn(process.execPath, ['--import', 'tsx', 'combo/demo.ts', ...args], { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

test('demo --local --pause (stdin not a TTY): the whole story, exit 0, our tx first with a positive feed lead, mine rank 1, no raw key, no anvil left', { timeout: 330_000 }, async () => {
  buildContracts()
  const r = await runDemo(['--local', '--pause'], 300_000)
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /\x1b\[/, 'piped output has no ANSI escapes')

  // --pause on a non-TTY stdin: the note, and the run did not wait for any Enter.
  assert.ok(r.out.includes(PAUSE_IGNORED), r.out)
  assert.doesNotMatch(r.out, /press Enter for chapter/)

  // Every chapter, numbered, in order.
  let at = -1
  for (let n = 1; n <= 6; n++) {
    const i = r.out.indexOf(`▶ CHAPTER ${n}/6: `)
    assert.ok(i > at, `chapter ${n} header missing or out of order:\n${r.out}`)
    at = i
  }
  assert.doesNotMatch(r.out, /^FAILED/m)
  assert.match(r.out, /LOCAL \(slow preset\): values differ from Arbitrum One/, 'the compact chapter-1 table')
  assert.match(r.out, /^ticket round +20s +24h$/m, 'the table shows the ticket round in use next to Arbitrum One')
  assert.match(r.out, /a ticket round is 20s here instead of 24h on Arbitrum One/, 'chapter 3 explains the short ticket round')
  assert.match(r.out, /==> ticket bought for our key hash 0x[0-9a-f]{64} in ticket round \d+/)
  const ch3 = r.out.slice(r.out.indexOf('▶ CHAPTER 3/6'), r.out.indexOf('▶ CHAPTER 4/6'))
  assert.doesNotMatch(ch3, /mined in block|==> tx 0x|no ticket yet/)
  assert.doesNotMatch(r.out, /key:new/)
  const ch1 = r.out.slice(r.out.indexOf('▶ CHAPTER 1/6'), r.out.indexOf('▶ CHAPTER 2/6'))
  assert.ok((ch1.match(/^NOTE:/gm) ?? []).length <= 5, 'chapter 1 has at most 5 NOTE lines:\n' + ch1)
  assert.equal((ch1.match(/Read more/g) ?? []).length, 1)
  assert.doesNotMatch(ch1, /forge build|deploying|Compiling|starting the local stack|Tickets proxy/)
  const ch2 = r.out.slice(r.out.indexOf('▶ CHAPTER 2/6'), r.out.indexOf('▶ CHAPTER 3/6'))
  assert.doesNotMatch(ch1 + ch2, /==> tx 0x|mined in block|mint 12|approve the Tickets|depositToken|purchaseTickets/, 'the background purchase is silent while chapters 1 and 2 print')
  assert.match(ch1, /^==> local stack ready: Anvil \+ mock sequencer \+ mock Fast Feed \(RPC http/m)
  assert.match(r.out, /the ticket activated at \d\d:\d\d:\d\dZ and expires at \d\d:\d\d:\d\dZ/, 'UTC clock times')
  assert.ok(r.out.includes(apiKeyHash(marker)), 'the hash of FEED_API_KEY is printed')
  assert.ok(!r.out.includes(marker), 'the raw FEED_API_KEY marker leaked into the output')
  assert.match(r.out, /using FEED_API_KEY from your environment/)

  // Chapter 4 (E3): one block. The header and round 1 of block X, the NOTE, our tx at index 0 of round 2 of the SAME block X with the
  // competitors after it, then the sealed line. tx_index counts block-wide: "index 0 of round R" is the position within the round.
  const ch4 = r.out.slice(r.out.indexOf('▶ CHAPTER 4/6'), r.out.indexOf('▶ CHAPTER 5/6'))
  const flat4 = ch4.replace(/\s+/g, ' ')
  const hdr = ch4.match(/^==> block (\d+) — 250 ms on Arbitrum One \(here 2 s\)$/m)
  assert.ok(hdr, 'the block header with Arbitrum One next to the local value:\n' + ch4)
  const X = hdr[1]!
  const at4 = (re: RegExp, from = 0) => {
    const m = re.exec(ch4.slice(from))
    assert.ok(m, `missing ${re} after offset ${from}:\n${ch4}`)
    return from + m.index
  }
  const iHdr = ch4.indexOf(hdr[0])
  const pre = ch4.slice(0, iHdr).split('\n').slice(2).filter((l) => l.trim() !== '') // after the chapter header and its Read more
  assert.ok(pre.length <= 6, `at most 6 lines before the story, got ${pre.length}:\n${pre.join('\n')}`)
  assert.doesNotMatch(pre.join('\n'), /Fast Feed live view|Your key holds|connecting to the Fast Feed/)
  const iR1 = at4(/^==> round 1 — 125 ms on Arbitrum One \(here 1 s\) · \d+ txs?:$/m, iHdr)
  const iT1 = at4(new RegExp(`^── block ${X} · round 1 · \\d+ txs? ──$`, 'm'), iR1)
  const iNote = at4(/^NOTE: Process slowed down for the demo: inserting a transaction with a bigger\n {6}tip in round 2$/m, iT1)
  const iR2 = at4(/^==> round 2 — 125 ms on Arbitrum One \(here 1 s\) · \d+ txs:$/m, iNote)
  const iT2 = at4(new RegExp(`^── block ${X} · round 2 · (\\d+) txs ──$`, 'm'), iR2)
  const iSealed = at4(new RegExp(`^==> block ${X} ordered and executed by the sequencer \\(sealed, visible on the RPC\\)$`, 'm'), iT2)
  assert.ok(iHdr < iR1 && iR1 < iT1 && iT1 < iNote && iNote < iR2 && iR2 < iT2 && iT2 < iSealed, 'round 1, the NOTE, round 2, then the sealed block, in that order')
  const t2 = ch4.slice(iT2, iSealed).split('\n').slice(1)
  const rows2 = t2.filter((l) => /^(>> | {3})\d+ /.test(l))
  assert.ok(rows2.length >= 3, 'X and at least two competitors in round 2:\n' + t2.join('\n'))
  assert.match(rows2[0]!, /^>> \d+ +0xf39F…2266 .*1 \/ 2 gwei +1 gwei .*<- yours, tip 1 gwei, index 0 of round 2$/, 'our tx is the first row of round 2')
  assert.ok(rows2.slice(1).every((l) => !l.startsWith('>>')), 'the competitors and traffic come after ours')
  assert.ok(rows2.filter((l) => /0\.05 \/ 2 gwei|0\.01 \/ 2 gwei/.test(l)).length >= 2, 'the two lower-tip competitors are in round 2 after ours')
  const mine = ch4.match(/^YOUR TX: block (\d+), round 2, first in its round \(tip 1 gwei\)$/m)
  assert.ok(mine, 'the highlighted line states block, round and position:\n' + ch4)
  assert.equal(mine[1], X, 'the SAME block X as the one whose round 1 was shown')
  assert.ok(ch4.indexOf(mine[0]) > iSealed, 'the explanations follow the sealed line')
  const lead = flat4.match(/YOUR TX: The Fast Feed showed it (\d+)ms before block (\d+) was visible\./)
  assert.ok(lead, ch4)
  assert.equal(lead[2], X)
  assert.ok(Number(lead[1]) > 0, `the feed lead must be positive, got ${lead[1]}ms`)
  assert.doesNotMatch(ch4, /block N {2}───|round 1 \(0–125ms\)/, 'the template explainer is gone')
  assert.doesNotMatch(ch4, /^ *FF lead  block \d+/m, 'the FF lead is a column of the timing table, not a line per row')
  const after = ch4.slice(iSealed).split('\n').slice(1)
  const endAfter = after.findIndex((l) => l.startsWith('==> traffic stopped'))
  assert.ok(endAfter > 0 && endAfter <= 28, `at most ~25 lines between the sealed line and the end of the story, got ${endAfter}:\n${after.join('\n')}`)
  // The timing table: three timestamps and the simulator-only label.
  assert.match(ch4, /^timing of block \d+: ms after round 1 started/m)
  assert.match(ch4, /tx +rnd +idx +arrived\* +seen on FF +block done +FF lead +wait/)
  assert.match(flat4, /\* arrived = simulator-only data \(sim_arrivals\)/)
  const xRow = ch4.match(/^>> X 0x[0-9a-f]{6} +2 +(\d+) +\+(\d+)ms +\+(\d+)ms +\+(\d+)ms +\+(\d+)ms +\+?(-?\d+)ms$/m)
  assert.ok(xRow, 'our row in the timing table:\n' + ch4)
  const [arrived, seenFF, done] = [Number(xRow[2]), Number(xRow[3]), Number(xRow[4])]
  assert.ok(arrived <= seenFF && seenFF <= done, `arrived <= seen on FF <= block done: ${arrived} ${seenFF} ${done}`)
  // The FCFS table: X first with PGA, behind the earlier-arriving competitors under FCFS.
  assert.match(ch4, /^hypothetical FCFS \(local simulator data\): round 2 of block \d+$/m)
  assert.match(ch4, /^1\. X 0x[0-9a-f]{6} {2}1 gwei <- yours /m, 'X is first in the real order')
  const fcfs = flat4.match(/position 1 of (\d+) with PGA \(the tip decided\); position (\d+) under FCFS/)
  assert.ok(fcfs && Number(fcfs[2]) >= 3, 'under FCFS X would sit behind the competitors that arrived first:\n' + ch4)
  assert.match(ch4, /\(c\)/)
  assert.match(flat4, /Under FCFS arrival \(latency\) decides; under PGA the tip does\./)
  assert.match(flat4, /were already final when you sent X: nothing you send goes before them\./)
  assert.match(flat4, /In round 2 you competed blind: X was ranked by tip against /)
  assert.equal((r.out.match(/the background renewal landed|already renewed for the next ticket round/g) ?? []).length, 1, 'the renewal outcome is printed once')

  // Chapter 5: the race, with the sequencer's internals, and mine at rank 1.
  assert.match(r.out, /\[sequencer\] round \d+: waiting list/)
  assert.match(r.out, /^Scenario s3: PASS - mine ranks first: /m)
  assert.match(r.out, /^YOUR TX: ranks: mine rank 1 \(.*\); rival rank 2 \(/m)
  assert.match(r.out, /^Mine: rank 1\. Why: Fast Feed got us into block \d+ round 2 \(rival polled, arrived in block \d+ round \d\); our tip 0\.2 also beat the rival's 0\.1 \(we'd also win a same-round tie\)\.$/m)
  assert.ok(r.out.trimEnd().split('\n').at(-1)!.startsWith('Mine: rank 1. Why: '), 'the "Mine: ..." line is the last line')

  // F1: the race's own block with and without Fast Feed (piped: stacked, left view first).
  const ch5 = r.out.slice(r.out.indexOf('▶ CHAPTER 5/6'))
  const iLeft = ch5.indexOf('WHAT I SEE WITH FAST FEED'), iRight = ch5.indexOf('WHAT OTHERS SEE WITHOUT FAST FEED')
  assert.ok(iLeft > 0 && iRight > iLeft, 'both headings, left first:\n' + ch5)
  const leftV = ch5.slice(iLeft, iRight), rightV = ch5.slice(iRight).split('YOUR TX:')[0]!
  assert.match(leftV, /^round 1 — /m)
  assert.match(leftV, /^round 2 — /m)
  assert.match(leftV, /-\d+\.\d\ds/)
  assert.doesNotMatch(leftV, /\+\d+\.\d\ds/)
  const raceBlock = leftV.match(/^block (\d+) — /m)![1]
  assert.match(rightV, new RegExp(`^block ${raceBlock} — `, 'm'))
  const leftTxs = [...leftV.matchAll(/ · (\d+) txs?$/gm)].reduce((n, m) => n + Number(m[1]), 0)
  const rightTxs = rightV.split('\n').slice(1).filter((l) => /^ {3}\d+ {2}/.test(l)).length
  assert.ok(leftTxs >= 2 && rightTxs === leftTxs, `right view lists ${rightTxs} txs, left rounds sum to ${leftTxs}`)
  assert.doesNotMatch(rightV, /vs no FF|round \d/)

  // The raw feed key is generated in memory and never printed: only 0x-prefixed hashes appear (a raw key is 64 hex with no 0x).
  const bare = r.out.match(/(?<![0-9a-zA-Fx])[0-9a-f]{64}(?![0-9a-fA-F])/g)
  assert.equal(bare, null, `a bare 64-hex token (a raw feed key?) was printed: ${bare?.[0]?.slice(0, 6)}...`)

  // The demo owned the stack and stopped it: nothing is left on its ports.
  for (const p of Object.values(ports)) assert.equal(await isPortFree(Number(p), '127.0.0.1'), true, `port ${p} is still in use: a process was left running`)
})

test('demo --local against a FIFO stack: chapter 4 fails by name (exit 1), PGA is never credited, and the stack is still stopped', { timeout: 330_000 }, async () => {
  const fifoPorts = { rpc: '43747', feed: '43842', anvil: '43745' }
  const fifoEnv: NodeJS.ProcessEnv = { ...env, SIM_ORDER: 'fifo', SIM_RPC_PORT: fifoPorts.rpc, SIM_FEED_PORT: fifoPorts.feed, SIM_ANVIL_PORT: fifoPorts.anvil }
  const r = await runDemo(['--local'], 300_000, fifoEnv)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`FAILED (chapter 4): ${FIFO_FAILURE}`), r.out)
  assert.ok(r.out.includes(`FAILED: chapter 4 (One block, two rounds: your tip goes first): ${FIFO_FAILURE}`), r.out)
  assert.match(r.out.replace(/\s+/g, ' '), /orders by arrival \(FIFO\), so index \d+ shows arrival, not the tip: PGA was not observed/)
  assert.match(r.out, /real FIFO order \(by arrival\)/, 'the FCFS comparison calls the real order FIFO')
  assert.doesNotMatch(r.out.replace(/\s+/g, ' '), /ranked (by tip )?against|competed here by tip|competes here by tip/)
  assert.match(r.out.replace(/\s+/g, ' '), /X was ordered by arrival among .*, not by tip \(FIFO\)/)
  assert.doesNotMatch(r.out, /PGA put us first in round|It sorted each round by tip/)
  assert.doesNotMatch(r.out, /rows are sorted by tip. That's PGA/)
  assert.match(r.out, /Not observed: this stack orders by arrival \(FIFO\)/)
  assert.match(r.out, /▶ CHAPTER 6\/6: /)
  for (const p of Object.values(fifoPorts)) assert.equal(await isPortFree(Number(p), '127.0.0.1'), true, `port ${p} is still in use`)
})

test('demo --local: Ctrl-C (SIGINT) during chapter 4 stops everything and exits 130, with no FAILED line after it', { timeout: 200_000 }, async () => {
  const sigPorts = { rpc: '43947', feed: '44042', anvil: '43945' }
  const sigEnv: NodeJS.ProcessEnv = { ...env, SIM_RPC_PORT: sigPorts.rpc, SIM_FEED_PORT: sigPorts.feed, SIM_ANVIL_PORT: sigPorts.anvil }
  delete sigEnv.FEED_API_KEY
  const child = spawn(process.execPath, ['--import', 'tsx', 'combo/demo.ts', '--local'], { env: sigEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const exited = new Promise<number | null>((r) => child.once('exit', r))
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  try {
    const end = Date.now() + 150_000
    while (!out.includes('▶ CHAPTER 4/6')) {
      assert.ok(Date.now() < end && child.exitCode === null, `chapter 4 never started:\n${out}`)
      await new Promise((r) => setTimeout(r, 100))
    }
    const before = out.length
    child.kill('SIGINT')
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('stuck'), 30_000))])
    assert.equal(code, 130, out)
    assert.doesNotMatch(out.slice(before), /FAILED/)
    for (const p of Object.values(sigPorts)) assert.equal(await isPortFree(Number(p), '127.0.0.1'), true, `port ${p} is still in use`)
  } finally {
    clearTimeout(killTimer)
    child.kill('SIGKILL')
  }
})
