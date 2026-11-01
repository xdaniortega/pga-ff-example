// Helpers shared by the PGA bot (bot.ts), the flood scenario (flood.ts) and the probe (probe.ts).
// This module imports none of them, so there are no import cycles.
import { createPublicClient, formatGwei, parseGwei, type Address, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { Preset } from '../../shared/config.ts'
import { presign } from './tx.ts'

export const DEAD: Address = '0x000000000000000000000000000000000000dEaD'
export const MAX_FEE = parseGwei('1')
export const RECEIPT_TIMEOUT_MS = 60_000

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

/** One tx as it landed (from its receipt). */
export interface Landed {
  /** Scenario label: the bid tip in gwei ("0.1"), or "N" / "N+1". */
  label: string
  block: bigint
  /** tx_index within the block (earlier rounds' txs come first). */
  index: number
  /** The PGA round (1..K) inside `block`: local only (from `sim_boostTrace`); undefined on a network that does not say. */
  pgaRound?: number
  /** Local only: `sim_boostTrace` gave no round for this tx, so "same round" cannot be judged (never treated as block-only). */
  roundUnknown?: boolean
  /** effectiveGasPrice - block baseFee, wei. */
  tip: bigint
}

export interface Env {
  preset: Preset
  chainId: number
  /** Reads (nonces, receipts, blocks). */
  read: ReturnType<typeof createPublicClient>
  /** Sends raw txs (the sequencer endpoint). */
  send: ReturnType<typeof createPublicClient>
  sendUrl: string
  wallets: PrivateKeyAccount[]
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const gwei = (wei: bigint) => formatGwei(wei)

async function simCall<T>(url: string, method: string, params: unknown[] = []): Promise<T | undefined> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = (await res.json()) as { result?: T }
    return body.result ?? undefined
  } catch {
    return undefined // not the local simulator
  }
}

/**
 * Local simulator only (the caller checks `preset.mode === 'local'`): wait until just after a round tick so the batch
 * shares one round. If the endpoint does not answer `sim_msUntilNextRound`, this does nothing, silently.
 */
export async function syncToTick(url: string): Promise<void> {
  const r = await simCall<string>(url, 'sim_msUntilNextRound')
  if (typeof r === 'string') await sleep(Number(BigInt(r)) + 60)
}

/**
 * Local simulator only: wait until just after the START of a block (`sim_msUntilNextBlock`), so a batch sent right away
 * collects in the block's round 1 and cannot be split across the K rounds of a block. Silent no-op elsewhere.
 */
export async function syncToBlockStart(url: string): Promise<void> {
  const r = await simCall<string>(url, 'sim_msUntilNextBlock')
  if (typeof r === 'string') await sleep(Number(BigInt(r)) + 60)
}

/** Local simulator only: the PGA round (1..K) in which `hash` was included, from `sim_boostTrace`; undefined when unknown. */
export async function pgaRoundOf(url: string, hash: Hex): Promise<number | undefined> {
  const trace = await simCall<{ included: boolean; pgaRound?: number }[]>(url, 'sim_boostTrace', [hash])
  return trace?.find((e) => e.included)?.pgaRound
}

/** Pure: do these txs share one round? Same block, and (when the rounds are known) the same pga_round. */
export function sameRound(landed: readonly Pick<Landed, 'block' | 'pgaRound' | 'roundUnknown'>[]): boolean {
  if (new Set(landed.map((l) => l.block)).size > 1) return false
  if (landed.some((l) => l.roundUnknown)) return false
  const rounds = landed.map((l) => l.pgaRound).filter((r): r is number => r !== undefined)
  return new Set(rounds).size <= 1
}

async function nonceOf(env: Env, a: Address): Promise<number> {
  return env.read.getTransactionCount({ address: a, blockTag: 'pending' })
}

/**
 * Sign a zero-value transfer to a dead address. Gas is estimated per tx through the read RPC (on Arbitrum the gas limit
 * includes the L1 cost, so a fixed 21000 is too low), or taken from `gas` when given (the flood reuses one estimate).
 */
export async function signTransfer(env: Env, account: PrivateKeyAccount, tip: bigint, nonce: number, gas?: bigint): Promise<Hex> {
  const limit = gas ?? ((await env.read.estimateGas({ account: account.address, to: DEAD, value: 0n })) * 11n) / 10n
  return presign({ to: DEAD, value: 0n, tip, maxFee: MAX_FEE, nonce, gas: limit, account, chain: { id: env.chainId } })
}

export async function pendingNonceOf(env: Env, a: Address): Promise<number> {
  return nonceOf(env, a)
}

/** Wait for the receipts of the sent txs (shared deadline) and say where each landed; tips come from the receipts. */
export async function collectLanded(
  env: Env,
  txs: readonly { label: string; hash: Hex }[],
  timeoutMs = RECEIPT_TIMEOUT_MS,
): Promise<{ landed: Landed[]; missing: string[]; lastError: string }> {
  const landed: Landed[] = []
  const missing: string[] = []
  let lastReceiptError = ''
  const deadline = Date.now() + timeoutMs
  const blockBase = new Map<bigint, bigint>()
  for (const t of txs) {
    let r: Awaited<ReturnType<typeof env.read.getTransactionReceipt>> | undefined
    let lastErr = ''
    while (!r && Date.now() < deadline) {
      r = await env.read.getTransactionReceipt({ hash: t.hash }).catch((e: Error) => {
        lastErr = e.message.split('\n')[0]!
        return undefined
      })
      if (!r) await sleep(200)
    }
    if (!r) {
      missing.push(t.label)
      if (lastErr) lastReceiptError = lastErr
      continue
    }
    if (!blockBase.has(r.blockNumber)) blockBase.set(r.blockNumber, (await env.read.getBlock({ blockNumber: r.blockNumber })).baseFeePerGas ?? 0n)
    // Local only: the round inside the block. On a testnet there is no such RPC, so the verdict stays block-only.
    const pgaRound = env.preset.mode === 'local' ? await pgaRoundOf(env.sendUrl, t.hash) : undefined
    const roundUnknown = env.preset.mode === 'local' && pgaRound === undefined
    landed.push({ label: t.label, block: r.blockNumber, index: r.transactionIndex, ...(pgaRound !== undefined ? { pgaRound } : {}), ...(roundUnknown ? { roundUnknown } : {}), tip: r.effectiveGasPrice - blockBase.get(r.blockNumber)! })
  }
  return { landed, missing, lastError: lastReceiptError }
}

/** Pure: 0 all PASS, 1 any FAIL, 3 inconclusive (and no FAIL). */
export function exitCode(verdicts: readonly Verdict[]): number {
  if (verdicts.includes('FAIL')) return 1
  if (verdicts.includes('INCONCLUSIVE')) return 3
  return 0
}


/**
 * Run an attempt; when it is INCONCLUSIVE, say so and run it once more (the caller's attempt reads fresh nonces and
 * waits for a fresh round tick). `retry` decides whether this attempt may be retried at all. Injectable for tests.
 */
export async function runWithRetry<T extends { verdict: Verdict; reason: string }>(
  run: () => Promise<T>,
  retry: boolean,
  onRetry: (first: T) => void,
): Promise<T> {
  const first = await run()
  if (first.verdict !== 'INCONCLUSIVE' || !retry) return first
  onRetry(first)
  const second = await run()
  return { ...second, reason: `${second.reason} (after 1 retry: the first attempt was inconclusive)` }
}
