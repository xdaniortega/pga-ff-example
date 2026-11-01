// Mock sequencer JSON-RPC: an HTTP proxy in front of Anvil.
//  - eth_sendRawTransaction is intercepted: decode, validate, enqueue, return keccak256(raw).
//  - eth_getTransactionCount(addr, "pending") adds txs still waiting in our queue.
//  - Block reveal gating: the newest block stays hidden until the sequencer reveals it.
//    On Arbitrum the Fast Feed announces a tx before its block is visible; this reproduces it.
// Everything else passes through. ASSUMPTION: state reads at "latest" (eth_call, eth_getBalance,
// eth_estimateGas) pass through to Anvil and may already reflect a block that is not yet visible.
// Filter methods (eth_newFilter, eth_getFilterChanges, eth_subscribe, ...) are NOT gated.
// B6a (rounds in a block): the `anvil` client given here is wrapped by the read gate (sim/blocks.ts), so no call sees Anvil
// between `evm_revert` and the end of the final mine of a block.
// Anvil JSON-RPC errors (code, message, data such as revert data) are forwarded unchanged.
import { createServer, type Server } from 'node:http'
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem'
import { localParamsToJson, type LocalContracts, type LocalParams } from '../shared/config.ts'
import { RpcCallError, type Anvil } from './chain.ts'
import { ClockError } from './clock.ts'
import type { Sequencer } from './sequencer.ts'

export const STACK_ID = 'pga-ff-workshop'

interface Req {
  jsonrpc?: string
  id?: unknown
  method: string
  params?: unknown[]
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

const hex = (n: number) => '0x' + n.toString(16)
// Only 0x quantities are numbers; tags such as 'earliest' yield undefined (pass through).
const num = (h: unknown) => (typeof h === 'string' && /^0x[0-9a-fA-F]+$/.test(h) ? Number(BigInt(h)) : undefined)
const isHash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
const isTag = (v: unknown) => v === 'latest' || v === 'pending' || v === 'safe' || v === 'finalized'

/**
 * Params for eth_call / eth_estimateGas: [tx, block?, stateOverrides?, blockOverrides?].
 * For latest/pending (or no block), set blockOverrides.time to wall-clock seconds unless the caller set it.
 * Anvil block timestamps follow wall-clock time, so this is the timestamp the next block will carry
 * (to within a second).
 */
export function withNow(params: unknown[], nowSec = Math.floor(Date.now() / 1000)): unknown[] {
  const tag = params[1]
  if (tag !== undefined && tag !== null && !isTag(tag)) return params // historical block: leave alone
  const blockOverrides = { ...((params[3] ?? {}) as Record<string, unknown>) }
  blockOverrides.time ??= hex(nowSec)
  return [params[0], tag ?? 'latest', params[2] ?? null, blockOverrides]
}

export interface RpcServer {
  close(): Promise<void>
}

export function startRpc(
  host: string,
  port: number,
  anvil: Anvil,
  seq: Sequencer,
  info: LocalParams,
  contracts: LocalContracts,
): Promise<RpcServer> {
  /** A refused clock request answers as -32000 with the reason (e.g. "paused by <holder>"). */
  async function clockCall<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ClockError) throw new RpcError(-32000, e.message)
      throw e
    }
  }
  /** Chain time in seconds: the wall clock until the simulator was paused or skipped (E2). */
  const chainSec = () => Math.floor(seq.clock.chainNowMs() / 1000)

  async function handle(r: Req): Promise<unknown> {
    const params = r.params ?? []
    const head = seq.revealedHead()
    const hidden = (blockNumber: unknown) => {
      const n = num(blockNumber)
      return n === undefined || n > head // null blockNumber = still pending in Anvil = not visible
    }
    switch (r.method) {
      case 'sim_info':
        return { stack: STACK_ID, ...localParamsToJson(info), contracts, receiptMismatches: seq.receiptMismatches, clock: seq.clockInfo() }

      // Local-only (E2): freeze / unfreeze the simulator (no rounds, no blocks, no traffic, a stopped ticket clock) and skip its chain
      // clock forward. Arbitrum never pauses. See sim/README.md#pausing-and-skipping-the-clock.
      case 'sim_pause': {
        const o = (params[0] ?? {}) as { holder?: unknown; at?: unknown; leaseMs?: unknown; heartbeat?: unknown }
        if (typeof o.holder !== 'string' || o.holder === '') throw new RpcError(-32602, 'sim_pause takes {holder, at?: "now"|"afterRound1", leaseMs?}')
        if (o.at !== undefined && o.at !== 'now' && o.at !== 'afterRound1') throw new RpcError(-32602, 'sim_pause: at must be "now" or "afterRound1"')
        if (o.leaseMs !== undefined && (typeof o.leaseMs !== 'number' || !(o.leaseMs > 0))) throw new RpcError(-32602, 'sim_pause: leaseMs must be a positive number (max 60000)')
        return clockCall(() => seq.pause(o.holder as string, (o.at as 'now' | 'afterRound1' | undefined) ?? 'now', (o.leaseMs as number | undefined) ?? 15_000, o.heartbeat === true))
      }
      case 'sim_resume': {
        const o = (params[0] ?? {}) as { holder?: unknown }
        if (typeof o.holder !== 'string' || o.holder === '') throw new RpcError(-32602, 'sim_resume takes {holder}')
        return clockCall(() => seq.resume(o.holder as string))
      }
      case 'sim_skipTo': {
        const o = (params[0] ?? {}) as { toSec?: unknown; holder?: unknown }
        if (typeof o.toSec !== 'number' || !Number.isFinite(o.toSec)) throw new RpcError(-32602, 'sim_skipTo takes {toSec, holder?}')
        const status = await clockCall(() => seq.skipTo(o.toSec as number, typeof o.holder === 'string' ? o.holder : undefined))
        return { status, ...seq.clockInfo() }
      }
      case 'sim_clock':
        return seq.clockInfo()

      // Test/demo tooling: lets a client send right after a round tick so a batch shares one round.
      case 'sim_msUntilNextRound':
        return hex(seq.msUntilNextRound())

      // Local-only: the next block boundary (= the start of round 1 of the next block) and the round/block collecting txs right now,
      // so a client can send a batch right after a block starts and have it share round 1.
      case 'sim_msUntilNextBlock':
        return hex(seq.msUntilNextBlock())

      case 'sim_blockInfo':
        return seq.blockInfo()

      // Local-only (C8): when the sequencer received each tx ordered in (block, pga_round): [{hash, from, arrivedAtMs, tipWei, txIndex}]
      // in tx_index order, for the last 32 blocks ([] otherwise). Arbitrum does not publish arrival times: simulator data only.
      case 'sim_arrivals': {
        const block = num(params[0]) ?? (typeof params[0] === 'number' ? params[0] : undefined)
        const round = num(params[1]) ?? (typeof params[1] === 'number' ? params[1] : undefined)
        if (block === undefined || round === undefined || !Number.isInteger(block) || !Number.isInteger(round)) throw new RpcError(-32602, 'sim_arrivals takes (block, round)')
        return seq.arrivals(block, round)
      }

      // Local-only (B3): the queue priority (effective tip + boost) of a tx in every round it waited, so a client can show
      // the boost 0 -> p/(2K) -> ... climbing. null for a hash the sequencer never saw.
      case 'sim_boostTrace': {
        if (!isHash(params[0])) throw new RpcError(-32602, 'sim_boostTrace takes one tx hash')
        return seq.boostTrace(params[0] as Hex) ?? null
      }

      // Anvil would put these straight into its pool, bypassing our queue and ordering.
      case 'eth_sendTransaction':
      case 'eth_sendUnsignedTransaction':
        throw new RpcError(
          -32601,
          'the local sequencer accepts only signed raw transactions (use --private-key / eth_sendRawTransaction), like the real Arbitrum sequencer endpoint',
        )

      case 'eth_sendRawTransaction': {
        const raw = params[0]
        if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new RpcError(-32602, 'invalid raw transaction')
        let from, nonce
        let tx: ReturnType<typeof parseTransaction>
        try {
          tx = parseTransaction(raw as Hex)
          nonce = tx.nonce ?? 0
          if (tx.chainId !== undefined && tx.chainId !== info.chainId)
            throw new RpcError(-32000, `invalid chain id: have ${tx.chainId}, want ${info.chainId}`)
          from = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })
        } catch (e) {
          if (e instanceof RpcError) throw e
          throw new RpcError(-32602, `invalid raw transaction: ${(e as Error).message}`)
        }
        const hash = keccak256(raw as Hex)
        if (seq.isKnown(hash)) return hash
        // Reject synchronously, as a real node would, instead of dropping the tx later.
        const latestNonce = Number(BigInt(await anvil.call<Hex>('eth_getTransactionCount', [from, 'latest'])))
        if (nonce < latestNonce) throw new RpcError(-32000, `nonce too low: next nonce ${latestNonce}, tx nonce ${nonce}`)
        const t = tx as { value?: bigint; gas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint }
        const cost = (t.value ?? 0n) + (t.gas ?? 0n) * (t.maxFeePerGas ?? t.gasPrice ?? 0n)
        const balance = BigInt(await anvil.call<Hex>('eth_getBalance', [from, 'latest']))
        if (balance < cost) throw new RpcError(-32000, `insufficient funds for gas * price + value: balance ${balance}, tx cost ${cost}`)
        const f = tx as { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }
        // ASSUMPTION: a second tx with the same sender and nonce as one already queued is refused, never replaced
        // (a real node would replace it for a >= 10% higher fee). Without this refusal Anvil would reject the extra
        // at round time, and its sender (e.g. viem sending concurrently from one wallet, all reading the same pending
        // nonce) would wait forever for a receipt. The check sits right before enqueue with NO await in between, so two
        // concurrent sends cannot both pass it.
        if (seq.isKnown(hash)) return hash // a concurrent resubmission of the identical raw tx: idempotent, like the check above
        if (seq.hasNonce(from, nonce)) {
          throw new RpcError(-32000, `a transaction from ${from} with nonce ${nonce} is already queued (local simulator: no replacement; send one at a time or use distinct nonces)`)
        }
        seq.enqueue({ hash, raw: raw as Hex, from, nonce, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, gasPrice: f.gasPrice }, latestNonce)
        return hash
      }

      // TIMESTAMP FIX: Anvil runs --no-mining and we mine only non-empty rounds, so the latest block's
      // timestamp lags wall-clock time, and `eth_call(latest)` would run with that stale block.timestamp:
      // Tickets' roundNumber/currentPrice/roundEnd would be stale versus the block a purchase lands in.
      // Reads and gas estimates at latest/pending run with block.timestamp = wall-clock now instead.
      case 'eth_call':
      case 'eth_estimateGas':
        return anvil.call(r.method, withNow(params, chainSec()))

      case 'eth_getTransactionCount': {
        const [addr, tag] = params as [string, unknown]
        // ASSUMPTION: "latest" is answered like "pending" (queued txs included). cast and some tools
        // ask for "latest" and send back-to-back; on Arbitrum One 250ms blocks make the two nearly
        // equal, locally the slowed-down blocks would otherwise make the second tx reuse a nonce.
        if (tag === 'pending' || tag === 'latest') {
          const base = BigInt(await anvil.call<Hex>('eth_getTransactionCount', [addr, 'latest']))
          return hex(seq.pendingNonce(addr as Hex, Number(base)))
        }
        if (isTag(tag)) return anvil.call(r.method, [addr, hex(head)]) // safe / finalized
        return anvil.call(r.method, params)
      }

      case 'eth_fillTransaction': {
        // viem asks Anvil to fill the nonce, which ignores our queue. Patch it with the pending nonce (only if the caller passed none).
        // It also estimates gas, and for time-dependent calls (Tickets.purchaseTickets checks the round)
        // Anvil would use the stale latest-block timestamp. So estimate here with wall-clock time (withNow)
        // and hand Anvil the gas, which makes it skip its own estimation. Reverts surface from our estimate
        // with the same code/data Anvil would have returned.
        const tx0 = { ...((params[0] ?? {}) as Record<string, unknown>) }
        if (tx0.gas === undefined && tx0.gasLimit === undefined) {
          tx0.gas = await anvil.call<Hex>('eth_estimateGas', withNow([tx0], chainSec()))
        }
        const filled = await anvil.call<{ raw?: Hex; tx?: { nonce?: Hex; from?: Hex } }>(r.method, [tx0, ...params.slice(1)])
        const from = (params[0] as { from?: Hex } | undefined)?.from
        // Only when the caller did NOT pass a nonce: an explicit nonce is never bumped.
        if ((params[0] as { nonce?: unknown } | undefined)?.nonce === undefined && filled?.tx?.nonce !== undefined && from) {
          filled.tx.nonce = hex(seq.pendingNonce(from, Number(BigInt(filled.tx.nonce)))) as Hex
          delete filled.raw // the unsigned raw bytes carried the stale nonce; callers sign from `tx`
        }
        return filled
      }

      case 'eth_blockNumber':
        return hex(head)

      case 'eth_getBlockByNumber': {
        const [tag, full] = params as [unknown, unknown]
        if (isTag(tag)) return anvil.call(r.method, [hex(head), full ?? false])
        const n = num(tag)
        if (n !== undefined && n > head) return null
        return anvil.call(r.method, params)
      }

      case 'eth_getBlockByHash': {
        const res = await anvil.call<{ number: Hex } | null>(r.method, params)
        return res && hidden(res.number) ? null : res
      }

      case 'eth_getTransactionReceipt':
      case 'eth_getTransactionByHash':
      case 'eth_getTransactionByBlockHashAndIndex':
      case 'eth_getTransactionByBlockNumberAndIndex': {
        if (r.method === 'eth_getTransactionByBlockNumberAndIndex') {
          const n = num(params[0])
          if (isTag(params[0])) params[0] = hex(head)
          else if (n !== undefined && n > head) return null
        }
        const res = await anvil.call<{ blockNumber: Hex | null } | null>(r.method, params)
        return res && hidden(res.blockNumber) ? null : res
      }

      case 'eth_getBlockTransactionCountByNumber': {
        const n = num(params[0])
        if (isTag(params[0])) return anvil.call(r.method, [hex(head)])
        if (n !== undefined && n > head) return null
        return anvil.call(r.method, params)
      }

      case 'eth_getBlockTransactionCountByHash': {
        const blk = await anvil.call<{ number: Hex } | null>('eth_getBlockByHash', [params[0], false])
        return blk && hidden(blk.number) ? null : anvil.call(r.method, params)
      }

      case 'eth_getBlockReceipts': {
        // Parameter: tag, hex number, block hash, or EIP-1898 object {blockHash} / {blockNumber}.
        let p0 = params[0]
        if (p0 && typeof p0 === 'object') {
          const o = p0 as { blockHash?: unknown; blockNumber?: unknown }
          p0 = o.blockHash ?? o.blockNumber
        }
        if (isHash(p0)) {
          const blk = await anvil.call<{ number: Hex } | null>('eth_getBlockByHash', [p0, false])
          return blk && hidden(blk.number) ? null : anvil.call(r.method, [p0])
        }
        if (isTag(p0)) return anvil.call(r.method, [hex(head)])
        const n = num(p0)
        if (n !== undefined && n > head) return null
        return anvil.call(r.method, [p0])
      }

      case 'eth_getLogs': {
        const f = { ...((params[0] ?? {}) as Record<string, unknown>) }
        const clamp = (v: unknown) => (v === undefined || isTag(v) || (num(v) ?? 0) > head ? hex(head) : v)
        if (f.blockHash === undefined) {
          if ((num(f.fromBlock) ?? 0) > head) return []
          f.toBlock = clamp(f.toBlock)
          if (f.fromBlock !== undefined) f.fromBlock = clamp(f.fromBlock)
        }
        const logs = await anvil.call<{ blockNumber: Hex }[]>(r.method, [f])
        return logs.filter((l) => !hidden(l.blockNumber))
      }

      default:
        return anvil.call(r.method, params)
    }
  }

  async function respond(r: Req) {
    try {
      return { jsonrpc: '2.0', id: r.id ?? null, result: await handle(r) }
    } catch (e) {
      const code = e instanceof RpcError || e instanceof RpcCallError ? e.code : -32603
      const data = e instanceof RpcError || e instanceof RpcCallError ? e.data : undefined
      const error: { code: number; message: string; data?: unknown } = { code, message: (e as Error).message }
      if (data !== undefined) error.data = data
      return { jsonrpc: '2.0', id: r.id ?? null, error }
    }
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      let out: unknown
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Req | Req[]
        out = Array.isArray(body) ? await Promise.all(body.map(respond)) : await respond(body)
      } catch {
        out = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === 'EADDRINUSE' ? `Sequencer RPC port ${port} is busy.` : e.message)),
    )
    server.listen(port, host, () =>
      resolve({
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections()
            server.close(() => res())
          }),
      }),
    )
  })
}
