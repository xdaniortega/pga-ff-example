// Mock Fast Feed: a WebSocket server that publishes ONE JSON object per transaction,
// each sent as a BINARY frame, right after the sequencer orders/executes it.
//
// Message format: docs.arbitrum.io "Introduction to the Fast Feed" and "consume the fast feed".
//   { version: 1, timestamp_ms, pga_round?, transaction: { block_number, tx_index, raw_tx,
//     tx_hash, receipt: { status, gas_used, gas_used_for_l1, cumulative_gas_used,
//     effective_gas_price, base_fee, contract_address, logs } } }
// Byte fields are 0x-hex strings; the receipt omits block_hash.
//
// Auth (A2): the upgrade request must carry `Authorization: Bearer <key>`. The feed hashes the key
// with apiKeyHash() (keccak256 of the key's UTF-8 bytes, see fast-feed/client/key.ts: the same rule the
// buyer used for purchaseTickets) and asks a `FeedAuth` how many ACTIVE tickets that hash holds.
// FEED_AUTH=off passes no FeedAuth: A1's open feed (no 401, 429 or 1008).
//
// Connection rules (A3), simulating the documented endpoint (docs.arbitrum.io "How to use the Fast Feed",
// Troubleshoot -> "Connection rejected or closed"; the single error table is in fast-feed/README.md):
// - 401 at the upgrade when the key holds no active ticket; 429 when open connections >= active tickets.
// - Tickets bought in round N are active in round N+1 only. When a round ends, every connection whose key
//   holds no ticket in the new round is closed with 1008 `authentication expired`. Detection: a 250ms timer
//   fires a re-check as soon as the wall clock passes the roundEnd read at the previous check, so the close
//   lands within ~1s of the boundary (never later than one round).
//   ASSUMPTION: if a key holds fewer tickets in the new round than it has open connections, the excess
//   connections are closed, newest first, with the same 1008.
// - A plain (non-upgrade) HTTP request gets 426 (ws answers it). A data frame from a client closes it with 1003
//   `unexpected client message`. Stopping the stack closes clients with 1011 `server shutting down`.
// - 1013 `client lagged` is NOT simulated locally: the mock never drops slow clients.
import { feedServer } from '../../shared/narrate.ts'
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Hex } from 'viem'
import { apiKeyHash } from '../client/key.ts'

export type AuthResult =
  | { ok: true; tickets: number; round: bigint; roundEnd: number }
  /** `transient`: the check itself failed (e.g. a read error); that is not evidence of "no ticket". */
  | { ok: false; reason: string; transient?: boolean }
/** How many active tickets does a key hash hold (see fast-feed/mock/auth.ts: ticket events on the Tickets proxy)? */
export type FeedAuth = (keyHash: Hex) => Promise<AuthResult>

/** The key in `Authorization: Bearer <key>`, or undefined when missing or malformed. */
export function bearerKey(header: string | undefined): string | undefined {
  const m = /^Bearer ([^\s]{1,512})$/.exec(header ?? '')
  return m?.[1]
}

/** First line is the short status ("no active ticket"); the rest says why. Clients print it verbatim. */
export async function authorize(auth: FeedAuth, header: string | undefined): Promise<AuthResult> {
  const key = bearerKey(header)
  if (!key) return { ok: false, reason: 'missing or malformed "Authorization: Bearer <key>" header' }
  try {
    return await auth(apiKeyHash(key))
  } catch (e) {
    return { ok: false, transient: true, reason: `could not check tickets: ${(e as Error).message}` }
  }
}

export interface FeedLog {
  address: Hex
  topics: Hex[]
  data: Hex
}

export interface FeedReceipt {
  // ASSUMPTION: the docs do not state the JSON type of quantity fields; the mock emits JSON numbers.
  status: number
  gas_used: number
  /** ASSUMPTION: 0 locally, there is no L1. */
  gas_used_for_l1: number
  cumulative_gas_used: number
  effective_gas_price: number
  base_fee: number
  contract_address: Hex | null
  logs: FeedLog[]
}

export interface FeedMessage {
  version: 1
  /** ASSUMPTION: locally, when the sequencer ordered the round (before execution); the docs do not say. */
  timestamp_ms: number
  /** 1..K: the PGA round within the block (locally K = 2 rounds share one Anvil block, like Arbitrum One). */
  pga_round?: number
  transaction: {
    block_number: number
    tx_index: number
    raw_tx: Hex
    tx_hash: Hex
    receipt: FeedReceipt
  }
}

export interface FeedServer {
  publish(msg: FeedMessage): void
  clientCount(): number
  close(): Promise<void>
}

const PING_INTERVAL_MS = 10_000
const ROLLOVER_TICK_MS = 250
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }

export interface FeedOptions {
  /** Chain time in ms for the round-rollover timer (E2: the simulator's clock, frozen while paused). Default: the wall clock. */
  chainNowMs?: () => number
}

export function startFeed(host: string, port: number, auth?: FeedAuth, opts: FeedOptions = {}): Promise<FeedServer> {
  const chainNowMs = opts.chainNowMs ?? Date.now
  return new Promise((resolve, reject) => {
    // Per key hash: open connections in the order they opened, and upgrades accepted but not yet open.
    const conns = new Map<Hex, WebSocket[]>()
    const reserved = new Map<Hex, number>()
    const keyOf = new WeakMap<IncomingMessage, { hash: Hex; release: () => void }>()
    let nextCheck = 0 // unix seconds: the roundEnd seen at the last check; 0 = unknown

    const wss = new WebSocketServer({
      host,
      port,
      verifyClient: auth
        ? (info, cb) => {
            void (async () => {
              const r = await authorize(auth, info.req.headers.authorization)
              if (!r.ok && r.transient) return cb(false, 503, `could not read Tickets; retry\n${r.reason}\n`, TEXT)
              if (!r.ok) return cb(false, 401, `no active ticket\n${r.reason}\n`, TEXT)
              const hash = apiKeyHash(bearerKey(info.req.headers.authorization)!)
              const open = (conns.get(hash)?.length ?? 0) + (reserved.get(hash) ?? 0)
              if (open >= r.tickets) {
                return cb(false, 429, `connections ≥ tickets (${open} open, ${r.tickets} active ticket${r.tickets === 1 ? '' : 's'})\n`, TEXT)
              }
              if (info.req.socket.destroyed) return cb(false, 400, 'client went away\n', TEXT) // aborted while the auth waited
              // The check above and this reservation both happen AFTER the auth await, with no await in between, so
              // concurrent upgrades cannot both pass the check. The reservation does not span the auth: it starts here
              // and lasts only until the synchronous 'connection' registration or the socket's 'close', whichever comes
              // first, plus a 10s safety timer; released exactly once (ws silently drops some upgrades after
              // verifyClient and never emits 'connection').
              reserved.set(hash, (reserved.get(hash) ?? 0) + 1)
              let released = false
              const release = () => {
                if (released) return
                released = true
                clearTimeout(timer)
                const n = (reserved.get(hash) ?? 1) - 1
                if (n <= 0) reserved.delete(hash)
                else reserved.set(hash, n)
              }
              const timer = setTimeout(release, 10_000)
              timer.unref()
              info.req.socket.once('close', release)
              keyOf.set(info.req, { hash, release })
              // Never push a pending boundary check later than it is.
              nextCheck = nextCheck === 0 ? r.roundEnd : Math.min(nextCheck, r.roundEnd)
              cb(true)
            })().catch(() => cb(false, 500, 'feed error\n', TEXT))
          }
        : undefined,
    })
    const alive = new WeakMap<WebSocket, boolean>()
    wss.once('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === 'EADDRINUSE' ? `Feed port ${port} is busy.` : `Feed server error: ${e.message}`)),
    )

    const closeWith = (ws: WebSocket, code: number, reason: string) => {
      if (ws.readyState === ws.OPEN) ws.close(code, reason)
    }

    // Round rollover: re-check every key with open connections once the wall clock passes the roundEnd.
    let checking = false
    let retryAt = 0
    const rolloverCheck = async () => {
      if (!auth || checking || nextCheck === 0 || conns.size === 0) return
      const nowS = Math.floor(chainNowMs() / 1000)
      if (nowS < nextCheck || Date.now() < retryAt) return
      checking = true
      try {
        let next: number | undefined // the new roundEnd, applied only when the whole pass completed
        for (const hash of [...conns.keys()]) {
          if (!conns.get(hash)?.length) continue
          const r = await auth(hash).catch((e: Error): AuthResult => ({ ok: false, transient: true, reason: e.message }))
          if (!r.ok && r.transient) {
            retryAt = Date.now() + 1000 // could not read the chain: close nobody on a failed read; nextCheck stays, so the retry runs
            return
          }
          const allowed = r.ok ? r.tickets : 0
          if (r.ok) next = next === undefined ? r.roundEnd : Math.min(next, r.roundEnd)
          const list = conns.get(hash) // re-read: connections may have come or gone during the await
          if (list && list.length > allowed) {
            const excess = list.splice(allowed) // keep the oldest `allowed`, close the newest first
            for (const ws of excess.reverse()) closeWith(ws, 1008, 'authentication expired')
            feedServer(`round ended: closed ${excess.length} connection(s) of key ${hash.slice(0, 10)}... with 1008 (${allowed} active ticket(s) now)`)
          }
          if (list && list.length === 0 && conns.get(hash) === list) conns.delete(hash)
        }
        if (conns.size === 0) nextCheck = 0 // nothing left to time
        else if (next !== undefined) nextCheck = next
      } finally {
        checking = false
      }
    }

    wss.once('listening', () => {
      wss.on('error', () => {})
      wss.on('connection', (ws, req) => {
        alive.set(ws, true)
        ws.on('pong', () => alive.set(ws, true))
        ws.on('error', () => {})
        const k = keyOf.get(req)
        if (k) {
          const hash = k.hash
          k.release()
          const list = conns.get(hash) ?? []
          list.push(ws)
          conns.set(hash, list)
          ws.on('close', () => {
            const l = conns.get(hash)
            if (!l) return
            const i = l.indexOf(ws)
            if (i >= 0) l.splice(i, 1)
            if (l.length === 0) conns.delete(hash)
          })
        }
        // The feed is one-way: a client must send only ping and pong frames. Any data frame is a client bug.
        ws.on('message', () => closeWith(ws, 1003, 'unexpected client message'))
      })
      // Server pings; clients (ws, browsers) answer with pongs automatically.
      const timer = setInterval(() => {
        for (const ws of wss.clients) {
          if (alive.get(ws) === false) {
            ws.terminate()
            continue
          }
          alive.set(ws, false)
          ws.ping()
        }
      }, PING_INTERVAL_MS)
      timer.unref()
      const rollover = setInterval(() => void rolloverCheck(), ROLLOVER_TICK_MS)
      rollover.unref()
      resolve({
        publish(msg) {
          const frame = Buffer.from(JSON.stringify(msg), 'utf8')
          for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true })
        },
        clientCount: () => wss.clients.size,
        close: async () => {
          clearInterval(timer)
          clearInterval(rollover)
          // Tell clients why: the endpoint is going away (they may reconnect with a short backoff).
          const open = [...wss.clients].filter((ws) => ws.readyState === ws.OPEN)
          await Promise.all(
            open.map(
              (ws) =>
                new Promise<void>((res) => {
                  const t = setTimeout(res, 1000)
                  ws.once('close', () => {
                    clearTimeout(t)
                    res()
                  })
                  ws.close(1011, 'server shutting down')
                }),
            ),
          )
          for (const ws of wss.clients) ws.terminate()
          await new Promise<void>((res) => wss.close(() => res()))
        },
      })
    })
  })
}
