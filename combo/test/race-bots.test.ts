// The two watchers against fakes: a fake Fast Feed WebSocket server for `ClaimBot` and a fake JSON-RPC server for
// `PollingBot`. No Anvil, no chain. Ports are ephemeral (listen(0)), so they cannot clash with another test file.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { pad, toHex, type Address, type Hex } from 'viem'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { ClaimBot, OPENED_TOPIC, PollingBot } from '../race.ts'

const RACE = '0xb19b36b1456E65E3A6D514D3F715f204BD59f431' as Address
const ID = 7n
const RAW = '0xdeadbeef' as Hex
const idTopic = pad(toHex(ID), { size: 32 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms
  while (!cond()) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`)
    await sleep(10)
  }
}

const opened = (id: bigint = ID, block = 9) => ({
  version: 1,
  timestamp_ms: 0,
  transaction: {
    block_number: block, tx_index: 0, raw_tx: '0x', tx_hash: '0x00',
    receipt: {
      status: 1, gas_used: 1, cumulative_gas_used: 1, effective_gas_price: 1, base_fee: 1, contract_address: null,
      logs: [{ address: RACE, topics: [OPENED_TOPIC, pad(toHex(id), { size: 32 })], data: '0x' }],
    },
  },
})

const servers: { close(): void }[] = []
const closers: (() => Promise<void>)[] = []
after(async () => {
  for (const c of closers) await c()
  for (const s of servers) s.close()
})

/** A fake Fast Feed: binary JSON frames, like the real one. `sockets` are the open connections. */
async function fakeFeed(): Promise<{ url: string; sockets: Set<WsSocket>; publish: (m: unknown) => void }> {
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  const sockets = new Set<WsSocket>()
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('close', () => sockets.delete(ws))
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  servers.push({ close: () => { for (const s of sockets) s.terminate(); wss.close(); http.close() } })
  return { url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`, sockets, publish: (m) => { for (const s of sockets) s.send(Buffer.from(JSON.stringify(m)), { binary: true }) } }
}

/** A fake JSON-RPC endpoint. `onCall` answers; every request is recorded. */
async function fakeRpc(onCall: (method: string, params: unknown[], n: number) => unknown): Promise<{ url: string; calls: { method: string; params: unknown[] }[]; server: Server }> {
  const calls: { method: string; params: unknown[] }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const r = JSON.parse(body) as { id: number; method: string; params: unknown[] }
      const n = calls.filter((c) => c.method === r.method).length
      calls.push({ method: r.method, params: r.params })
      try {
        const result = onCall(r.method, r.params, n)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }))
      } catch (e) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32000, message: (e as Error).message } }))
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push({ close: () => server.close() })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, server }
}

function claimBot(feed: { url: string }, name: string, delayMs: number, sent: { name: string; at: number }[], extra: { onSeen?: (b: number) => void } = {}) {
  const bot = new ClaimBot({
    name, feedUrl: feed.url, apiKey: `key-${name}`, race: RACE, id: ID, delayMs, raw: RAW, onSeen: extra.onSeen,
    send: async () => {
      sent.push({ name, at: Date.now() })
      return `0x${'ab'.repeat(32)}` as Hex
    },
  })
  closers.push(() => bot.close())
  return bot
}

test('ClaimBot: a duplicate Opened fires the claim only once; unrelated messages and other ids are ignored', async () => {
  const feed = await fakeFeed()
  const sent: { name: string; at: number }[] = []
  const seen: number[] = []
  const bot = claimBot(feed, 'rival', 0, sent, { onSeen: (b) => seen.push(b) })
  await bot.connect(2000)
  await until(() => feed.sockets.size === 1, 2000, 'the bot to connect')
  feed.publish(opened(99n, 8)) // another race
  feed.publish({ version: 1, timestamp_ms: 0, transaction: { block_number: 8, receipt: { status: 1, logs: [] } } })
  feed.publish(opened(ID, 9))
  feed.publish(opened(ID, 9)) // the same event again
  feed.publish(opened(ID, 10)) // and again, in a later message
  assert.equal(await bot.waitSent(2000), true)
  await sleep(200)
  assert.equal(sent.length, 1, 'the claim was handed to the sequencer once')
  assert.deepEqual(seen, [9], 'onSeen fires once, with the block of the first Opened')
  assert.equal(bot.openBlock, 9)
  assert.ok(bot.seenAt !== undefined && bot.sentAt !== undefined && bot.sentAt >= bot.seenAt)
  assert.equal(bot.hash, `0x${'ab'.repeat(32)}`)
})

test('ClaimBot: mine waits its delay after Opened, the rival fires at once (delay ordering)', async () => {
  const feed = await fakeFeed()
  const sent: { name: string; at: number }[] = []
  const rival = claimBot(feed, 'rival', 0, sent)
  const mine = claimBot(feed, 'mine', 150, sent)
  await Promise.all([rival.connect(2000), mine.connect(2000)])
  await until(() => feed.sockets.size === 2, 2000, 'both bots to connect')
  feed.publish(opened())
  await Promise.all([rival.requireSent(2000), mine.requireSent(2000)])
  assert.deepEqual(sent.map((s) => s.name), ['rival', 'mine'], 'the rival is sent first')
  assert.ok(mine.sentAt! - rival.sentAt! >= 140, `mine fired ${mine.sentAt! - rival.sentAt!}ms after the rival, expected about 150`)
  assert.ok(mine.sentAt! - mine.seenAt! >= 140, 'mine waited its delay after seeing Opened')
  assert.ok(rival.sentAt! - rival.seenAt! < 100, 'the rival fired at once')
})

test('ClaimBot: a bot that never sees Opened times out with an error that names the bot and the id', async () => {
  const feed = await fakeFeed()
  const sent: { name: string; at: number }[] = []
  const bot = claimBot(feed, 'rival', 0, sent)
  await bot.connect(2000)
  feed.publish(opened(99n)) // not our race
  await assert.rejects(bot.requireSent(300), /rival: did not see Opened\(7\) within 0.3s \(no Opened message arrived on its feed connection\)/)
  assert.equal(await bot.waitSent(50), false)
  assert.equal(sent.length, 0)
})

test('ClaimBot: when the feed closes first, the timeout error says how it closed', async () => {
  const feed = await fakeFeed()
  const bot = claimBot(feed, 'mine', 0, [])
  await bot.connect(2000)
  await until(() => feed.sockets.size === 1, 2000, 'the bot to connect')
  for (const s of feed.sockets) s.close(1008, 'authentication expired')
  await until(() => bot.closedWith !== undefined, 2000, 'the close')
  await assert.rejects(bot.requireSent(200), /mine: did not see Opened\(7\).*feed closed 1008 authentication expired/)
})

function pollingBot(rpcUrl: string, pollMs: number, sent: number[], delayMs = 0) {
  const bot = new PollingBot({
    name: 'rival', rpcUrl, race: RACE, id: ID, pollMs, delayMs, raw: RAW,
    send: async () => {
      sent.push(Date.now())
      return `0x${'cd'.repeat(32)}` as Hex
    },
  })
  closers.push(() => bot.close())
  return bot
}

test('PollingBot: fires on the first poll that returns the log, and not before; once only', async () => {
  const LOGS_AT = 3 // the 4th getLogs call (index 3) returns the log
  const rpc = await fakeRpc((method, _p, n) => {
    if (method === 'eth_blockNumber') return '0x10'
    if (method === 'eth_getLogs') return n < LOGS_AT ? [] : [{ address: RACE, topics: [OPENED_TOPIC, idTopic], blockNumber: '0x12', data: '0x' }]
    throw new Error(`unexpected ${method}`)
  })
  const sent: number[] = []
  const bot = pollingBot(rpc.url, 40, sent)
  const startedAt = Date.now()
  await bot.connect()
  await until(() => rpc.calls.filter((c) => c.method === 'eth_getLogs').length >= LOGS_AT, 3000, `${LOGS_AT} polls`)
  assert.equal(sent.length, 0, 'no claim while the polls return nothing')
  assert.equal(bot.seenAt, undefined)
  await bot.requireSent(3000)
  const polls = rpc.calls.filter((c) => c.method === 'eth_getLogs')
  assert.equal(polls.length, LOGS_AT + 1, 'it fired on the first poll that returned the log')
  assert.equal(bot.polls, LOGS_AT + 1)
  assert.equal(sent.length, 1)
  assert.equal(bot.openBlock, 0x12)
  assert.ok(bot.seenAt! - startedAt >= (LOGS_AT - 1) * 40 - 15, 'the polls were spaced by the poll period')
  // The query: the Race address, the Opened topic and the id, from the head at connect time.
  const f = polls[0]!.params[0] as { address: string; topics: string[]; fromBlock: string }
  assert.equal(f.address, RACE)
  assert.deepEqual(f.topics, [OPENED_TOPIC, idTopic])
  assert.equal(f.fromBlock, '0x10')
  // It stops polling once it has fired.
  await sleep(200)
  assert.equal(rpc.calls.filter((c) => c.method === 'eth_getLogs').length, LOGS_AT + 1, 'no more polls after the claim was sent')
  assert.equal(sent.length, 1)
})

test('PollingBot: keeps polling after a failed poll, and a bot that never sees the log times out naming the bot, the id, the poll count and the endpoint', async () => {
  let calls = 0
  const rpc = await fakeRpc((method) => {
    if (method === 'eth_blockNumber') return '0x10'
    calls++
    if (calls === 1) throw new Error('rate limited')
    return []
  })
  const sent: number[] = []
  const bot = pollingBot(rpc.url, 30, sent)
  await bot.connect()
  await assert.rejects(bot.requireSent(400), (e: Error) => /^rival: did not see Opened\(7\) within 0.4s \(\d+ poll\(s\) of http:\/\/127\.0\.0\.1:\d+ every 30ms returned no Opened log\)$/.test(e.message))
  assert.ok(bot.polls >= 3, 'it kept polling after the failed poll')
  assert.equal(sent.length, 0)
  await bot.close()
})

test('PollingBot: a delay after the sighting postpones the send', async () => {
  const rpc = await fakeRpc((method) => (method === 'eth_blockNumber' ? '0x10' : [{ address: RACE, topics: [OPENED_TOPIC, idTopic], blockNumber: '0x11', data: '0x' }]))
  const sent: number[] = []
  const bot = pollingBot(rpc.url, 20, sent, 120)
  await bot.connect()
  await bot.requireSent(3000)
  assert.ok(bot.sentAt! - bot.seenAt! >= 110)
})

test('PollingBot: after a slow poll the schedule restarts from now (no burst of catch-up polls)', async () => {
  const stamps: number[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const r = JSON.parse(body) as { id: number; method: string }
      const answer = (result: unknown) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }))
      }
      if (r.method !== 'eth_getLogs') return answer('0x10')
      stamps.push(Date.now())
      // The first poll takes 400ms: eight 50ms periods pass while it runs.
      if (stamps.length === 1) setTimeout(() => answer([]), 400)
      else answer([])
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push({ close: () => server.close() })
  const bot = pollingBot(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 50, [])
  await bot.connect()
  await sleep(900)
  await bot.close()
  const t0 = stamps[0]!
  const burst = stamps.filter((t) => t - t0 >= 400 && t - t0 < 440).length
  assert.ok(burst <= 2, `${burst} polls right after the slow one: catch-up polls fired back to back (${stamps.map((t) => t - t0).join(', ')})`)
  assert.ok(stamps.length >= 5, 'it kept polling at the regular period afterwards')
})
