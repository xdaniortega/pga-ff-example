// C7: the panel (open block + previous closed block) and the FF lead, as pure functions and through LiveRounds with a fake RPC.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, test } from 'node:test'
import { parseGwei, type Hex } from 'viem'
import { PALETTE } from '../../shared/narrate.ts'
import {
  blockStatus,
  ffLeadMs,
  FOOTER,
  formatLeadLines,
  formatPanel,
  groupRows,
  LiveRounds,
  type BlockView,
  type LiveRow,
} from '../client/live.ts'

const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

function row(o: { block: number; round?: number; index: number; tip?: bigint; from?: string; recv: number; status?: number }): LiveRow {
  const tip = o.tip ?? parseGwei('0.1')
  return {
    blockNumber: o.block,
    pgaRound: o.round,
    txIndex: o.index,
    hash: ('0x' + o.index.toString(16).padStart(64, '0')) as Hex,
    from: (o.from ?? OTHER) as LiveRow['from'],
    nonce: 0,
    to: null,
    bid: { kind: 'eip1559', maxPriority: tip, maxFee: tip * 2n },
    effectiveTip: tip,
    gasUsed: 21_000n,
    feePaid: 21_000n * tip,
    status: o.status ?? 1,
    orderedAt: o.recv - 5,
    receivedAt: o.recv,
  }
}

const block = (n: number, rows: LiveRow[], extra: Partial<BlockView> = {}): BlockView => ({
  blockNumber: n,
  rows,
  firstReceivedAt: Math.min(...rows.map((r) => r.receivedAt)),
  complete: false,
  ...extra,
})
const mine = new Set([ME.toLowerCase()])
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

test('ffLeadMs is blockVisibleAt - feedReceivedAt and never negative (a row after the block was visible leads by 0)', () => {
  assert.equal(ffLeadMs(1_000, 3_500), 2_500)
  assert.equal(ffLeadMs(4_000, 3_500), 0, 'clamped, not negative')
  assert.equal(ffLeadMs(3_500, 3_500), 0)
})

test('formatPanel: open block with round 1 only, the not-visible status with elapsed time, round 2 waiting', () => {
  const open = block(8, [row({ block: 8, round: 1, index: 0, recv: 10_000 }), row({ block: 8, round: 1, index: 1, recv: 10_000, from: ME })])
  const lines = formatPanel(open, undefined, 24_200, { mine, k: 2 })
  assert.equal(lines[0], 'block 8: not visible on the sequencer RPC yet, +14.2s')
  assert.ok(lines.some((l) => /^ {2}round 1\/2 · 2 txs$/.test(l)), lines.join('\n'))
  assert.ok(lines.some((l) => l === '  round 2/2: not ordered yet'), lines.join('\n'))
  assert.match(lines.join('\n'), /FF lead/, 'the FF lead column header is there')
  assert.ok(lines.some((l) => l.startsWith('>> ') && l.endsWith('<- yours')), 'our row is marked')
  assert.ok(lines.filter((l) => l.startsWith('   ') && /\d/.test(l)).every((l) => l.trimEnd().endsWith('-')), 'no lead yet: a dash')
  // The timer ticks with the clock.
  assert.equal(formatPanel(open, undefined, 25_300, { k: 2 })[0], 'block 8: not visible on the sequencer RPC yet, +15.3s')
})

test('formatPanel: both rounds under the same block, then closed with an FF lead on every row (round 1 larger than round 2)', () => {
  const rows = [
    row({ block: 8, round: 1, index: 0, recv: 10_000 }),
    row({ block: 8, round: 1, index: 1, recv: 10_001, from: ME }),
    row({ block: 8, round: 2, index: 2, recv: 22_500 }),
  ]
  const open = block(8, rows)
  const both = formatPanel(open, undefined, 23_000, { mine, k: 2 })
  assert.ok(both.some((l) => l.includes('round 1/2')) && both.some((l) => l.includes('round 2/2')))
  assert.equal(both.filter((l) => l.startsWith('block ')).length, 1, 'one block, both rounds')
  open.visibleAt = 25_100
  open.complete = true
  const closed = formatPanel(open, undefined, 25_200, { mine, k: 2 })
  assert.equal(closed[0], 'block 8 [closed]: visible on the sequencer RPC, +15.1s after its first feed row')
  const lead = (idx: number) => Number(/\+(\d+\.\d\d)s/.exec(closed.find((l) => l.replace(/^(>> | {3})/, '').trimStart().startsWith(`${idx} `))!)![1])
  assert.equal(lead(0), 15.1)
  assert.equal(lead(2), 2.6)
  assert.ok(lead(0) > lead(2), 'round 1 leads by more than round 2')
})

test('formatPanel: two blocks only, previous above the open one; a rolled third block is not drawn', () => {
  const b7 = block(7, [row({ block: 7, round: 1, index: 0, recv: 1_000 }), row({ block: 7, round: 2, index: 1, recv: 2_000 })], { visibleAt: 3_000, complete: true })
  const b8 = block(8, [row({ block: 8, round: 1, index: 2, recv: 3_500 })])
  const lines = formatPanel(b8, b7, 4_000, { k: 2 })
  const heads = lines.filter((l) => l.startsWith('block '))
  assert.deepEqual(heads.map((h) => h.split(':')[0]), ['block 7 [closed]', 'block 8'])
  assert.ok(lines.indexOf(heads[0]!) < lines.indexOf(heads[1]!))
  assert.equal(lines.filter((l) => l.startsWith('block ')).length, 2, 'only two block status lines')
  assert.deepEqual(formatPanel(undefined, undefined, 0), ['waiting for the first Fast Feed message...'])
})

test('formatPanel: every line fits 80 columns, also for long rows and a narrow terminal; elides rows to maxLines but keeps ours', () => {
  const long = row({ block: 8, round: 1, index: 0, recv: 1_000, tip: parseGwei('123456789.123456789'), from: ME })
  const many = Array.from({ length: 30 }, (_, i) => row({ block: 8, round: 1, index: i + 1, recv: 1_000 }))
  const open = block(8, [long, ...many])
  for (const width of [80, 60, 40]) {
    const lines = formatPanel(open, block(7, [row({ block: 7, round: 1, index: 0, recv: 100 })], { visibleAt: 900 }), 2_000, { mine, k: 2, width })
    assert.ok(lines.every((l) => l.length <= width), `width ${width}: ${lines.filter((l) => l.length > width)[0]}`)
  }
  const cut = formatPanel(open, undefined, 2_000, { mine, k: 2, maxLines: 12 })
  assert.ok(cut.length <= 12, `${cut.length} lines`)
  assert.ok(cut.some((l) => l.startsWith('>> ')), 'our row survives the elision')
  assert.ok(cut.some((l) => /\.\.\. \d+ more tx/.test(l)))
  const wide = formatPanel(open, undefined, 2_000, { mine, k: 2, width: 500 })
  assert.ok(wide.every((l) => l.length <= 80), 'never wider than 80')
})

test('formatPanel: colour only when asked: yours rows bold and the status line in the palette; plain otherwise', () => {
  const open = block(8, [row({ block: 8, round: 1, index: 0, recv: 1_000, from: ME })])
  const plainLines = formatPanel(open, undefined, 2_000, { mine, k: 2 })
  assert.ok(!plainLines.join('\n').includes('\x1b'))
  const col = formatPanel(open, undefined, 2_000, { mine, k: 2, color: true })
  assert.ok(col[0]!.startsWith(PALETTE.note), 'the not-visible status is a NOTE colour')
  assert.ok(col.some((l) => l.startsWith(PALETTE.bold) && strip(l).startsWith('>> ')), 'yours rows are bold')
  assert.deepEqual(col.map(strip), plainLines, 'colour adds only escapes')
})

test('blockStatus: closed, never visible, not visible yet', () => {
  const b = block(3, [row({ block: 3, round: 1, index: 0, recv: 1_000 })])
  assert.equal(blockStatus(b, 3_000).kind, 'open')
  assert.equal(blockStatus({ ...b, gaveUp: true }, 3_000).kind, 'gaveUp')
  assert.match(blockStatus({ ...b, visibleAt: 2_500 }, 3_000).text, /\[closed\].*\+1\.5s after its first feed row/)
})

test('formatLeadLines: one line per row, yours marked', () => {
  const g = groupRows([row({ block: 9, round: 2, index: 5, recv: 1, from: ME }), row({ block: 9, round: 2, index: 6, recv: 2 })])[0]!
  const lines = formatLeadLines(g, (r) => (r.txIndex === 5 ? 1_250 : 800), { mine, k: 2 })
  assert.deepEqual(lines, ['>> FF lead  block 9 round 2/2  tx_index 5  +1.25s', '   FF lead  block 9 round 2/2  tx_index 6  +0.80s'])
})

// --- LiveRounds with a fake RPC that reveals the block after a delay ---------------------------------------------------
const servers: Server[] = []
after(() => void servers.forEach((s) => s.close()))
async function fakeRpc(revealAfterMs: number | null): Promise<string> {
  let t0 = 0
  const srv = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (!t0) t0 = Date.now()
      const visible = revealAfterMs !== null && Date.now() - t0 >= revealAfterMs
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: visible ? { number: '0x1' } : null }))
    })
  })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('LiveRounds: onRow for every row, block visibility from the RPC probe, leads per row (round 1 > round 2), line mode prints FF lead lines', async () => {
  const url = await fakeRpc(300)
  const lines: string[] = []
  const seen: [number, number | undefined][] = []
  const visible: BlockView[] = []
  const v = new LiveRounds({
    rpcUrl: url, out: (l) => lines.push(l), quietMs: 50, footerEvery: 0, roundsPerBlock: 2,
    onRow: (r, b) => seen.push([r.txIndex, b.visibleAt]),
    onBlockVisible: (b) => visible.push({ ...b }),
  })
  const t0 = Date.now()
  v.push(row({ block: 1, round: 1, index: 0, recv: t0 }))
  v.push(row({ block: 1, round: 1, index: 1, recv: t0 }))
  await wait(150)
  v.push(row({ block: 1, round: 2, index: 2, recv: Date.now() }))
  assert.deepEqual(seen, [[0, undefined], [1, undefined], [2, undefined]], 'every row fires onRow, before the block is visible')
  await wait(500)
  await v.drain()
  assert.equal(visible.length, 1)
  const b = visible[0]!
  assert.ok(b.visibleAt !== undefined && b.complete)
  const leads = lines.filter((l) => l.includes('FF lead  block 1'))
  assert.equal(leads.length, 3, lines.join('\n'))
  const lead = (i: number) => Number(/\+(\d+\.\d\d)s$/.exec(leads.find((l) => l.includes(`tx_index ${i} `))!)![1])
  assert.ok(lead(0) > 0 && lead(2) > 0 && lead(0) > lead(2), `round 1 lead ${lead(0)}s > round 2 lead ${lead(2)}s`)
  assert.match(leads[0]!, /round 1\/2/)
  assert.match(leads[2]!, /round 2\/2/)
  const ti = lines.findIndex((l) => l.startsWith('ordered (round 1)'))
  assert.ok(ti >= 0 && lines.findIndex((l) => l.includes('FF lead  block 1 round 1/2')) > ti, 'the lead lines follow their timing line')
  assert.equal(v.panelBlocks().open?.blockNumber, 1)
  assert.equal(v.panelBlocks().previous, undefined)
})

test('LiveRounds: block-aware completion: a visible block flushes its round at once (not after the quiet period); a later block completes the earlier one', async () => {
  const url = await fakeRpc(100)
  const tables: number[] = []
  const v = new LiveRounds({ rpcUrl: url, out: () => {}, quietMs: 5_000, footerEvery: 0, onTable: (r) => tables.push(r.group.blockNumber) })
  v.push(row({ block: 1, round: 1, index: 0, recv: Date.now() }))
  assert.equal(v.block(1)?.complete, false)
  const end = Date.now() + 2_000
  while (tables.length === 0 && Date.now() < end) await wait(20)
  assert.deepEqual(tables, [1], 'flushed when the block became visible, well before the 5s quiet period')
  assert.equal(v.block(1)?.complete, true)
  // A later block's row completes an earlier block that is not visible yet.
  const never = await fakeRpc(null)
  const w = new LiveRounds({ rpcUrl: never, out: () => {}, quietMs: 5_000, footerEvery: 0, visibilityDeadlineMs: 400 })
  w.push(row({ block: 4, round: 1, index: 0, recv: Date.now() }))
  assert.equal(w.block(4)?.complete, false)
  w.push(row({ block: 5, round: 1, index: 1, recv: Date.now() }))
  assert.equal(w.block(4)?.complete, true, 'a later block arrived')
  assert.equal(w.block(5)?.complete, false)
  assert.equal(w.blocksSeen(), 2)
  assert.equal(w.panelBlocks().open?.blockNumber, 5)
  assert.equal(w.panelBlocks().previous?.blockNumber, 4)
})

test('LiveRounds: a row that arrives after its block was visible gets a lead of 0, never negative', async () => {
  const url = await fakeRpc(0)
  const lines: string[] = []
  const v = new LiveRounds({ rpcUrl: url, out: (l) => lines.push(l), quietMs: 30, footerEvery: 0, roundsPerBlock: 2 })
  v.push(row({ block: 1, round: 1, index: 0, recv: Date.now() }))
  await wait(200) // visible by now
  v.push(row({ block: 1, round: 2, index: 1, recv: Date.now() }))
  await v.drain()
  await wait(100)
  await v.drain()
  const b = v.block(1)!
  assert.ok(b.visibleAt !== undefined)
  assert.equal(ffLeadMs(b.rows[1]!.receivedAt, b.visibleAt!), 0)
  assert.ok(!lines.some((l) => /FF lead.*-\d/.test(l)), lines.join('\n'))
  const panel = formatPanel(b, undefined, Date.now(), { k: 2 })
  assert.ok(panel.every((l) => !/-\d+\.\d\ds/.test(l)))
})

test('LiveRounds: with line output off (a panel draws) no line is printed, but events still fire; rounds flushed then never print lines later', async () => {
  const url = await fakeRpc(100)
  const lines: string[] = []
  let tables = 0
  const v = new LiveRounds({ rpcUrl: url, out: (l) => lines.push(l), quietMs: 20, footerEvery: 0, onTable: () => tables++ })
  v.setLineOutput(false)
  v.push(row({ block: 1, round: 1, index: 0, recv: Date.now() }))
  await v.drain()
  v.setLineOutput(true)
  await wait(100)
  await v.drain()
  assert.equal(tables, 1)
  assert.deepEqual(lines, [])
})

test('LiveRounds.finish with colour forced and no out: the footer is yellow (note colour)', async () => {
  const prev = process.env.FORCE_COLOR
  const prevNo = process.env.NO_COLOR
  process.env.FORCE_COLOR = '1'
  delete process.env.NO_COLOR
  const logged: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => void logged.push(a.join(' '))
  try {
    const v = new LiveRounds({ rpcUrl: 'http://127.0.0.1:1', footerEvery: 0, visibilityDeadlineMs: 20 })
    await v.finish(10)
  } finally {
    console.log = orig
    if (prev === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = prev
    if (prevNo !== undefined) process.env.NO_COLOR = prevNo
  }
  assert.deepEqual(logged, [`${PALETTE.note}${FOOTER}\x1b[0m`])
})

test('formatPanel: below the full height the previous block is cut first; the open block keeps its header, status and newest rows', () => {
  const b7 = block(7, [row({ block: 7, round: 1, index: 0, recv: 1_000 }), row({ block: 7, round: 2, index: 1, recv: 2_000 })], { visibleAt: 3_000, complete: true })
  const b8 = block(8, [row({ block: 8, round: 1, index: 2, recv: 3_500 }), row({ block: 8, round: 1, index: 3, recv: 3_500 }), row({ block: 8, round: 2, index: 4, recv: 3_800 })])
  const full = formatPanel(b8, b7, 4_000, { k: 2 })
  const openAt = full.findIndex((l) => l.startsWith('block 8'))
  const openFull = full.length - openAt
  const cut = formatPanel(b8, b7, 4_000, { k: 2, maxLines: openFull })
  assert.equal(cut.length, openFull)
  assert.ok(cut[0]!.startsWith('block 8'), 'the previous block was cut first')
  assert.ok(!cut.some((l) => l.startsWith('block 7')))
  const tiny = formatPanel(b8, b7, 4_000, { k: 2, maxLines: 4 })
  assert.equal(tiny.length, 4)
  assert.ok(tiny[0]!.startsWith('block 8'), 'header (status line) kept')
  assert.ok(/^\s+index/.test(tiny[1]!), 'column header kept')
  assert.ok(tiny.at(-1)!.includes(' 4 '), 'the newest row is kept')
})

test('LiveRounds.panelBlocks: after blocks 1, 2, 3 the open block is 3 and the previous is 2', async () => {
  const never = await fakeRpc(null)
  const v = new LiveRounds({ rpcUrl: never, out: () => {}, quietMs: 5_000, footerEvery: 0, visibilityDeadlineMs: 300 })
  for (const n of [1, 2, 3]) v.push(row({ block: n, round: 1, index: n, recv: Date.now() }))
  const { open, previous } = v.panelBlocks()
  assert.equal(open?.blockNumber, 3)
  assert.equal(previous?.blockNumber, 2)
  v.flush()
})

test('E3 LiveRounds.markVisible: an earlier sighting by the caller wins (one FF lead figure everywhere); a later one or an unknown block changes nothing', async () => {
  const never = await fakeRpc(null)
  const v = new LiveRounds({ rpcUrl: never, out: () => {}, quietMs: 5_000, footerEvery: 0, visibilityDeadlineMs: 5_000 })
  const t0 = Date.now()
  v.push(row({ block: 7, round: 1, index: 0, recv: t0 }))
  v.markVisible(99, t0 + 10) // unknown block: ignored
  assert.equal(v.block(7)?.visibleAt, undefined)
  v.markVisible(7, t0 + 120)
  assert.equal(v.block(7)?.visibleAt, t0 + 120)
  assert.equal(v.block(7)?.complete, true)
  v.markVisible(7, t0 + 400) // later: keeps the earlier
  assert.equal(v.block(7)?.visibleAt, t0 + 120)
  v.markVisible(7, t0 + 100)
  assert.equal(v.block(7)?.visibleAt, t0 + 100)
  const lines = formatPanel(v.block(7), undefined, t0 + 500, { k: 2 })
  assert.ok(lines.some((l) => l.includes(`+${(0.1).toFixed(2)}s`)), lines.join('\n'))
})
