// Background traffic for the local stack: `npm run traffic -- --local [--tps N]`.
// Local only: it would spam a shared testnet, and the simulator's background load does not exist there.
//
// Design (so the live view stays strictly tip-ordered until B2 adds nonce gating):
//  - Ten dedicated Anvil dev accounts (indexes 10-19 of Anvil's public default mnemonic; no other command uses them).
//  - At most ONE tx in flight per wallet: a wallet sends its next tx only after the previous one has a receipt,
//    or was dropped (no receipt after DROP_AFTER_MS). So two txs of one sender never share a round.
//  - Nonces are tracked locally per wallet; txs are signed raw type-2 (explicit nonce, gas, maxFee, maxPriorityFee)
//    and sent with eth_sendRawTransaction. After "nonce too low", or a drop, the nonce is re-read from the proxy.
//  - Tips are uniform at random in [0, 0.1] gwei. maxFee = base fee + 1 gwei, far above base fee + tip.
//  - Each tick of the scheduler (1/tps seconds) picks the next idle wallet; with none idle the tick is skipped
//    and the rate is capped by "one in flight per wallet". The achieved rate is printed every 5s.
import { pathToFileURL } from 'node:url'
import { mnemonicToAccount } from 'viem/accounts'
import { parseGwei, type Address, type Hex } from 'viem'
import { ANVIL_MNEMONIC, ConfigError, getPreset, TRAFFIC_ACCOUNT_INDEXES, type LocalParams } from '../shared/config.ts'
import { error, note, plain, step } from '../shared/narrate.ts'
import { trafficSummaryLine } from './banner.ts'

type HdAccount = ReturnType<typeof mnemonicToAccount>

export const TIP_MAX_WEI = parseGwei('0.1')
/** A few sinks so the `to` column varies a little. */
export const SINKS: readonly Address[] = [
  '0x000000000000000000000000000000000000dEaD',
  '0x0000000000000000000000000000000000d00d01',
  '0x0000000000000000000000000000000000d00d02',
  '0x0000000000000000000000000000000000d00d03',
]

/** Uniform in [0, 0.1] gwei, in whole wei. `rand` is in [0, 1). */
export function randomTip(rand: () => number = Math.random): bigint {
  return BigInt(Math.floor(rand() * (Number(TIP_MAX_WEI) + 1)))
}

export function trafficAccounts(): HdAccount[] {
  return TRAFFIC_ACCOUNT_INDEXES.map((addressIndex) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex }))
}

export function refusalLines(): string[] {
  return [
    'The traffic generator is local only (--local).',
    'On a testnet it would spam a shared network, and the simulator\'s background load does not exist there:',
    'the real network has its own traffic. Run `npm run traffic -- --local --tps 5` against `npm run sim`.',
  ]
}

export interface TrafficOptions {
  rpcUrl: string
  chainId: number
  tps: number
  baseFeeWei: bigint
  /** Wallets with no receipt after this long count as dropped. Default: dropAfterMsFor(blockMs). */
  dropAfterMs?: number
  /** The stack's block time B (ms); a receipt can take up to about a block, so the default drop time scales with it (--slowmo: 25s). */
  blockMs?: number
  /** Print a stats line this often (0 = never). */
  statsEveryMs?: number
  log?: (line: string) => void
}

export interface TrafficStats {
  sent: number
  confirmed: number
  dropped: number
  skipped: number
  errors: number
  /** Mean ms from send to receipt over confirmed txs. */
  meanLatencyMs: number
}

export interface Traffic {
  stop(): Promise<void>
  /** E2: while paused it sends nothing and counts no drops; `resume` moves every in-flight send time forward by the paused time. Idempotent. */
  pause(): void
  resume(): void
  readonly paused: boolean
  stats(): TrafficStats
  readonly wallets: number
}

interface Wallet {
  account: HdAccount
  nonce: number
  inflight?: { hash: Hex; sentAt: number }
  syncing?: boolean
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  return body.result as T
}

/** Pure: when a wallet with no receipt counts as dropped: max(20s, 2 x B), so healthy txs are not misclassified under --slowmo. */
export function dropAfterMsFor(blockMs: number | undefined): number {
  return Math.max(20_000, 2 * (blockMs ?? 0))
}

export async function startTraffic(o: TrafficOptions): Promise<Traffic> {
  const log = o.log ?? plain
  const dropAfterMs = o.dropAfterMs ?? dropAfterMsFor(o.blockMs)
  const statsEveryMs = o.statsEveryMs ?? 5000
  const wallets: Wallet[] = trafficAccounts().map((account) => ({ account, nonce: 0 }))
  const pendingNonce = async (a: Address) => Number(BigInt(await rpc<Hex>(o.rpcUrl, 'eth_getTransactionCount', [a, 'pending'])))
  await Promise.all(wallets.map(async (w) => (w.nonce = await pendingNonce(w.account.address))))

  const st = { sent: 0, confirmed: 0, dropped: 0, skipped: 0, errors: 0, latencySum: 0 }
  let stopped = false
  let next = 0 // round-robin cursor
  let warnedCap = false
  let lastErr = ''
  let pausedAt: number | undefined

  const resync = async (w: Wallet) => {
    try {
      w.nonce = await pendingNonce(w.account.address)
    } catch {
      /* keep the old nonce; the next send reports the error */
    }
  }

  const sendOne = async (w: Wallet) => {
    const tip = randomTip()
    const raw = await w.account.signTransaction({
      type: 'eip1559',
      chainId: o.chainId,
      to: SINKS[Math.floor(Math.random() * SINKS.length)]!,
      value: 1n,
      gas: 21_000n,
      nonce: w.nonce,
      maxPriorityFeePerGas: tip,
      maxFeePerGas: o.baseFeeWei + parseGwei('1'),
    })
    try {
      const hash = await rpc<Hex>(o.rpcUrl, 'eth_sendRawTransaction', [raw])
      w.inflight = { hash, sentAt: Date.now() }
      w.nonce++
      st.sent++
    } catch (e) {
      const msg = (e as Error).message
      if (/nonce too low/i.test(msg)) await resync(w)
      else {
        st.errors++
        if (msg !== lastErr) log(`traffic: send failed (${msg}); retrying`)
        lastErr = msg
        await resync(w)
      }
    }
  }

  // Receipts: one pass over the busy wallets every 100ms.
  const poll = setInterval(() => {
    for (const w of wallets) {
      const f = w.inflight
      if (!f || f.hash === '0x' || w.syncing || pausedAt !== undefined) continue // paused: nothing can be dropped
      void rpc<{ status: Hex } | null>(o.rpcUrl, 'eth_getTransactionReceipt', [f.hash])
        .then(async (r) => {
          if (w.inflight !== f) return
          if (r) {
            st.confirmed++
            st.latencySum += Date.now() - f.sentAt
            w.inflight = undefined
          } else if (Date.now() - f.sentAt > dropAfterMs) {
            w.inflight = undefined // first, so an overlapping poll of the same tx cannot count the drop twice
            st.dropped++
            w.syncing = true
            await resync(w) // the tx vanished: ask the proxy what the next nonce is
            w.syncing = false
          }
        })
        .catch(() => {})
    }
  }, 100)

  const tick = setInterval(() => {
    if (stopped || pausedAt !== undefined) return
    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[(next + i) % wallets.length]!
      if (!w.inflight && !w.syncing) {
        next = (next + i + 1) % wallets.length
        w.inflight = { hash: '0x' as Hex, sentAt: Date.now() } // reserve the wallet while the send is under way
        void sendOne(w)
          .catch((e: Error) => {
            st.errors++ // e.g. a signing failure: count it, free the wallet below
            if (e.message !== lastErr) log(`traffic: send failed (${e.message}); retrying`)
            lastErr = e.message
          })
          .finally(() => {
          if (w.inflight?.hash === '0x') w.inflight = undefined // the send failed: free the wallet
        })
        return
      }
    }
    st.skipped++
    if (!warnedCap && st.errors === 0) {
      warnedCap = true
      log(
        `traffic: rate capped by "one in flight per wallet": all ${wallets.length} wallets are waiting for a receipt, so --tps ${o.tps} cannot be reached ` +
          `(about ${wallets.length} wallets / one receipt latency, roughly ${((wallets.length * 1000) / Math.max(1, st.confirmed ? st.latencySum / st.confirmed : 2500)).toFixed(1)} tx/s). The achieved rate is printed every ${statsEveryMs / 1000}s.`,
      )
    }
  }, Math.max(1, Math.round(1000 / o.tps)))

  let windowStart = Date.now()
  let windowSent = 0
  let windowErrors = 0
  const stats = setInterval(() => {
    const now = Date.now()
    const rate = ((st.sent - windowSent) * 1000) / (now - windowStart)
    windowStart = now
    windowSent = st.sent
    const errs = st.errors - windowErrors
    windowErrors = st.errors
    const lat = st.confirmed ? Math.round(st.latencySum / st.confirmed) : 0
    log(
      `traffic: achieved ${rate.toFixed(1)} tx/s (target ${o.tps})${rate < o.tps * 0.9 ? (errs > 0 ? ', below target because sends failed' : ', capped by one in flight per wallet') : ''}; ` +
        `sent ${st.sent}, confirmed ${st.confirmed}, dropped ${st.dropped}, errors ${st.errors}; mean send-to-receipt ${lat}ms`,
    )
  }, Math.max(1, statsEveryMs))
  if (statsEveryMs <= 0) clearInterval(stats)

  return {
    wallets: wallets.length,
    get paused() {
      return pausedAt !== undefined
    },
    pause: () => {
      pausedAt ??= Date.now()
    },
    resume: () => {
      if (pausedAt === undefined) return
      const ms = Date.now() - pausedAt
      pausedAt = undefined
      for (const w of wallets) if (w.inflight) w.inflight = { ...w.inflight, sentAt: w.inflight.sentAt + ms } // the sim clock did not run: nothing is late
    },
    stats: () => ({
      sent: st.sent,
      confirmed: st.confirmed,
      dropped: st.dropped,
      skipped: st.skipped,
      errors: st.errors,
      meanLatencyMs: st.confirmed ? Math.round(st.latencySum / st.confirmed) : 0,
    }),
    stop: async () => {
      stopped = true
      clearInterval(tick)
      clearInterval(poll)
      clearInterval(stats)
    },
  }
}

function tpsOf(argv: readonly string[]): number {
  const i = argv.indexOf('--tps')
  const v = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--tps='))?.slice(6)
  if (i >= 0 && (v === undefined || v.startsWith('--'))) throw new ConfigError('--tps needs a value (tx per second, default 5).')
  if (v === undefined) return 5
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || n > 100) throw new ConfigError('--tps must be a number between 0 and 100 (default 5).')
  return n
}

async function main() {
  const argv = process.argv.slice(2)
  const preset = getPreset(argv) // ConfigError when --local/--testnet is missing or ambiguous
  if (preset.mode !== 'local') {
    for (const l of refusalLines()) error(l)
    process.exit(1)
  }
  const tps = tpsOf(argv)
  const { startOrAttach } = await import('./index.ts')
  // The load goes through the running simulator's RPC; a stack started by this command would die with it.
  const stack = await startOrAttach(preset.local!, preset.chainId, { attachOnly: true, banner: false })
  const p: LocalParams = stack.params
  step(`traffic: ${TRAFFIC_ACCOUNT_INDEXES.length} wallets (Anvil dev accounts ${TRAFFIC_ACCOUNT_INDEXES[0]}-${TRAFFIC_ACCOUNT_INDEXES.at(-1)}), --tps ${tps}, tips uniform in [0, 0.1] gwei, one tx in flight per wallet`)
  note(trafficSummaryLine(p))
  const t = await startTraffic({ rpcUrl: preset.rpcUrl, chainId: p.chainId, tps, baseFeeWei: p.baseFeeWei, blockMs: p.blockMs })
  // E2: follow the simulator's pause (a demo freezes it while the presenter talks), so the load stops with it and drops nothing.
  const follow = setInterval(() => {
    void rpc<{ paused?: boolean }>(preset.rpcUrl, 'sim_clock', [])
      .then((c) => {
        if (c?.paused && !t.paused) {
          t.pause()
          note('the simulator is paused: traffic waits (local only)')
        } else if (!c?.paused && t.paused) {
          t.resume()
          note('the simulator resumed: traffic continues')
        }
      })
      .catch(() => {})
  }, 1000)
  follow.unref()
  const onSignal = () => {
    clearInterval(follow)
    void t.stop().then(() => {
      const s = t.stats()
      step(`traffic stopped: sent ${s.sent}, confirmed ${s.confirmed}, dropped ${s.dropped}, errors ${s.errors}`)
      process.exit(0)
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  note('Ctrl-C stops it.')
}

// Run as a command only (the integration test imports startTraffic).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    error(`Error: ${(e as Error).message}`)
    process.exit(1)
  })
}
