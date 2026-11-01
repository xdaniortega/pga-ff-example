// Reusable Fast Feed client (later phases reuse it).
// Format: docs.arbitrum.io "Introduction to the Fast Feed" / "consume the fast feed".
// - One JSON object per BINARY frame.
// - The client never sends anything. The server pings; `ws` answers with pongs automatically
//   (autoPong is on by default), which keeps the connection alive.
// - Auth: optional `Authorization: Bearer <key>` header. The key is never logged.
import WebSocket from 'ws'
import { parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem'

export interface FeedReceiptJson {
  status: number | string
  gas_used: number | string
  gas_used_for_l1?: number | string
  cumulative_gas_used: number | string
  effective_gas_price: number | string
  base_fee: number | string
  contract_address: Hex | null
  logs: { address: Hex; topics: Hex[]; data: Hex }[]
}

export interface FeedMessageJson {
  version: number
  timestamp_ms: number
  pga_round?: number
  transaction: {
    block_number: number
    tx_index: number
    raw_tx: Hex
    tx_hash: Hex
    receipt: FeedReceiptJson
  }
}

export interface DecodedFeedTx {
  block_number: number
  tx_index: number
  tx_hash: Hex
  from: Address
  to: Address | null
  /** effective_gas_price - base_fee, wei. */
  tip: bigint
  /** 1 = success, 0 = reverted. */
  status: number
  gas_used: bigint
  effective_gas_price: bigint
  base_fee: bigint
  timestamp_ms: number
  pga_round?: number
}

/** Quantities may arrive as JSON numbers, decimal strings or 0x-hex strings. */
export function toBigInt(v: number | string): bigint {
  return typeof v === 'number' ? BigInt(Math.trunc(v)) : BigInt(v)
}

export async function decodeFeedMessage(msg: FeedMessageJson): Promise<DecodedFeedTx> {
  const t = msg.transaction
  const r = t.receipt
  const tx = parseTransaction(t.raw_tx)
  const from = await recoverTransactionAddress({ serializedTransaction: t.raw_tx as `0x02${string}` })
  const effective = toBigInt(r.effective_gas_price)
  const baseFee = toBigInt(r.base_fee)
  return {
    block_number: t.block_number,
    tx_index: t.tx_index,
    tx_hash: t.tx_hash,
    from,
    to: tx.to ?? null,
    tip: effective - baseFee,
    status: Number(toBigInt(r.status)),
    gas_used: toBigInt(r.gas_used),
    effective_gas_price: effective,
    base_fee: baseFee,
    timestamp_ms: msg.timestamp_ms,
    pga_round: msg.pga_round,
  }
}

/** The feed refused the WebSocket upgrade with an HTTP status (e.g. 401 Unauthorized). */
export class FeedRejectedError extends Error {
  constructor(
    readonly status: number,
    /** The server's explanation (response body), first line = short status. */
    readonly body: string,
  ) {
    super(`feed refused the connection: HTTP ${status}${body ? ` ${body.split('\n')[0]}` : ''}`)
  }
}

export interface FeedClientOptions {
  url: string
  apiKey?: string
  onMessage: (msg: FeedMessageJson, receivedAt: number) => void
  onClose?: (code: number, reason: string) => void
  onError?: (err: Error) => void
}

export interface FeedClient {
  /** Resolves when the WebSocket is open. */
  ready: Promise<void>
  close(): Promise<void>
}

export function connectFeed(opts: FeedClientOptions): FeedClient {
  const headers: Record<string, string> = {}
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`
  const ws = new WebSocket(opts.url, { headers })
  let rejected = false // refused at the HTTP upgrade: report once via `ready`, not as a generic error/close
  const ready = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', (e) => reject(e))
    // Without this handler ws only says "Unexpected server response: 401" and drops the server's reason.
    ws.on('unexpected-response', (_req, res) => {
      rejected = true
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        reject(new FeedRejectedError(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8').trim()))
        ws.terminate()
      })
    })
  })
  ready.catch(() => {}) // surfaced via onError / the caller awaiting `ready`
  ws.on('message', (data: WebSocket.RawData) => {
    const receivedAt = Date.now()
    try {
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as Buffer).toString('utf8')
      opts.onMessage(JSON.parse(text) as FeedMessageJson, receivedAt)
    } catch (e) {
      opts.onError?.(new Error(`bad feed frame: ${(e as Error).message}`))
    }
  })
  ws.on('error', (e) => {
    if (!rejected) opts.onError?.(e)
  })
  ws.on('close', (code, reason) => {
    if (!rejected) opts.onClose?.(code, reason.toString())
  })
  return {
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        ws.once('close', () => resolve())
        ws.terminate()
      }),
  }
}

// ---------------------------------------------------------------------------
// Code -> explanation map (single source for the feed CLI and the live view).
// Causes and fixes are the docs' table (docs.arbitrum.io "How to use the Fast Feed", Troubleshoot ->
// "Connection rejected or closed"), copied once into fast-feed/README.md as the single error table.
// ---------------------------------------------------------------------------

export interface FeedCodeInfo {
  code: number
  /** `http`: the upgrade was refused with a status. `close`: an open WebSocket was closed with a code. */
  kind: 'http' | 'close'
  /** Short name: the HTTP reason phrase, or what the close means. */
  name: string
  cause: string
  fix: string
  /** Not in the docs' table: raised by the local simulator only (503). */
  local?: true
  /** Does `--reconnect` try again? (1003 is a client bug and 426 a wrong client: retrying cannot help.) */
  reconnect: boolean
}

export const FEED_CODES: Readonly<Record<number, FeedCodeInfo>> = {
  401: {
    code: 401,
    kind: 'http',
    name: 'Unauthorized',
    cause: "The Authorization header is missing, or the key's hash has no active ticket.",
    fix: 'Check the raw key and its hash. Tickets bought this round activate at roundEnd.',
    reconnect: true,
  },
  429: {
    code: 429,
    kind: 'http',
    name: 'Too Many Requests',
    cause: 'The key already has as many open connections as it has active tickets.',
    fix: 'Close a connection, or buy more tickets for the next round.',
    reconnect: true,
  },
  426: {
    code: 426,
    kind: 'http',
    name: 'Upgrade Required',
    cause: 'The request was not a WebSocket upgrade, for example a plain HTTPS GET.',
    fix: 'Use a WebSocket client.',
    reconnect: false,
  },
  503: {
    code: 503,
    kind: 'http',
    name: 'Service Unavailable',
    cause: 'The local simulator could not read the Tickets contract to check the key (a transient error).',
    fix: 'Retry in a moment; check the simulator log if it persists.',
    local: true,
    reconnect: true,
  },
  1008: {
    code: 1008,
    kind: 'close',
    name: 'ticket expired',
    cause: 'The round ended and your key holds no ticket in the new round.',
    fix: 'Buy before roundEnd each round, then reconnect.',
    reconnect: true,
  },
  1013: {
    code: 1013,
    kind: 'close',
    name: 'client lagged',
    cause: 'Your client fell more than 2048 messages behind.',
    fix: 'Drain the socket faster. Move parsing and processing off the read loop, then reconnect.',
    reconnect: true,
  },
  1003: {
    code: 1003,
    kind: 'close',
    name: 'unexpected client message',
    cause: 'Your client sent a data frame.',
    fix: 'Send only ping and pong frames.',
    reconnect: false,
  },
  1011: {
    code: 1011,
    kind: 'close',
    name: 'server shutting down',
    cause: 'The endpoint restarted.',
    fix: 'Reconnect with a short backoff.',
    reconnect: true,
  },
}

/** The explanation for an HTTP status or close code, or undefined when it is not one of the documented ones. */
export function explainFeedCode(code: number): FeedCodeInfo | undefined {
  return FEED_CODES[code]
}

/** Should `--reconnect` retry after this HTTP status / close code? Unknown codes: only a dropped connection (1001, 1006). */
export function shouldReconnect(code: number | undefined): boolean {
  if (code === undefined) return true // no code at all: the connection itself failed (e.g. endpoint down)
  return FEED_CODES[code]?.reconnect ?? (code === 1001 || code === 1006)
}

/** Exponential backoff with jitter: 1s doubling to a 30s cap. `attempt` starts at 0; `rand` is in [0, 1). Pure. */
export function backoffMs(attempt: number, rand: number = Math.random(), baseMs = 1000, capMs = 30_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
  return Math.round(ceiling / 2 + (ceiling / 2) * rand) // "equal jitter": between half the step and the step
}

/** The lines to print when an open feed connection closes. */
export function closeLines(code: number, reason: string, buyCmd: string): string[] {
  const info = FEED_CODES[code]
  if (!info || info.kind !== 'close') {
    return [`closed ${code}${reason ? ` (${reason})` : ''}. The connection was lost; the endpoint may be down or restarting.`]
  }
  const lines = [`closed ${code} (${info.name}). ${code === 1008 ? `Renew: ${buyCmd}` : info.fix}`]
  if (reason) lines.push(`    server said: ${reason}`)
  lines.push(`    cause: ${info.cause}`)
  if (code === 1008) lines.push(`    fix: ${info.fix}`)
  return lines
}

/**
 * The lines to print when the upgrade is refused. `net` is the CLI flag of the active preset. The hints about
 * the simulator (`npm run sim`, "a restarted simulator starts a fresh chain") are for `--local` only.
 */
export function rejectionLines(status: number, body: string, net: '--local' | '--testnet'): string[] {
  const info = FEED_CODES[status]
  const [head, ...why] = body.split('\n').filter(Boolean)
  const lines = [`${status} ${info?.name ?? 'Refused'}: ${head ?? 'connection refused'}`]
  for (const l of why) lines.push(`    ${l}`)
  // The 503 explanation is about the local simulator: show it for --local only (like the 401 hints below).
  if (info && (!info.local || net === '--local')) {
    lines.push(`    cause: ${info.cause}`)
    lines.push(`    fix: ${info.fix}`)
  }
  if (status === 401) {
    const local = net === '--local'
    const reason = why.join(' ')
    const buy = `npm run tickets:buy -- ${net}`
    if (/not active yet/.test(reason)) {
      lines.push('    Access starts when the purchase round ends (tickets:buy prints the time). Rerun this command then, or add --reconnect.')
    } else if (/ticket expired/.test(reason)) {
      lines.push(`    A ticket is active for one round only. Renew: ${buy}`)
    } else if (/unknown key/.test(reason)) {
      lines.push(`    No ticket exists for this key on this chain. Buy one: ${buy}${local ? ' (needs `npm run sim` running).' : '.'}`)
      if (local) lines.push('    A restarted simulator starts a fresh chain, so earlier tickets are gone: buy again.')
    } else if (/Authorization/.test(reason)) {
      lines.push('    Set FEED_API_KEY in your env file (.env, or $ENV_FILE) with `npm run key:new`, then buy a ticket with `npm run tickets:buy`.')
    }
    lines.push(`    Check your key's state with: npm run tickets:status -- ${net}`)
  }
  return lines
}
