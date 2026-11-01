// Single source of truth for every parameter: network presets and local simulator values.
// Nothing else in the repo hardcodes a port, a block time, a base fee or an endpoint.
//
// One code path: the --local / --testnet flag only selects a preset below.
import { existsSync } from 'node:fs'
import { bytesToHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { setChainClock } from './clock.ts'

export type Mode = 'local' | 'testnet'
export type SimPresetName = 'slow' | 'fast'

export class ConfigError extends Error {}

// ---------------------------------------------------------------------------
// Arbitrum One reference values, printed next to the local values by the banner (R8).
// PGA: https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/pga
//   block B = 250ms, K = 2 rounds per block, round = B/K.
// Base fee floor: 0.01 gwei (Arbitrum chain parameters, docs.arbitrum.io).
// ---------------------------------------------------------------------------
export const ARBITRUM_ONE = {
  chainId: 42161,
  blockMs: 250,
  k: 2,
  roundMs: 250 / 2,
  baseFeeWei: 10_000_000n, // 0.01 gwei
  // Fast Feed tickets: https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/fast-feed
  ticketRoundSeconds: 24 * 60 * 60,
  targetTicketsPerRound: 100,
  maxTicketsPerRound: 200,
  minimumPrice: 17_000_000n, // $17, 6 decimals (USDG)
  priceUpdateFraction: 144,
  grandfatherPeriodFraction: 128, // 128/256 = ~0.5 of the round
  /** A block closes at 32 Mgas or 95,000 bytes of calldata, whichever comes first (see sim/README.md). */
  blockFull: '32 Mgas / 95 kB calldata per block',
} as const

/** Payment token decimals: USDG on Arbitrum One, TEST on Arbitrum Sepolia and locally all use 6. */
export const TOKEN_DECIMALS = 6

// Public Anvil dev keys (printed by `anvil`, anyone can spend from them: LOCAL ONLY).
// Account 0 is the default local user. Accounts 0-2 stay free for users.
export const ANVIL_DEV_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** Public Anvil dev keys of accounts 0-2: the default `npm run pga` / demo wallets, LOCAL ONLY (chainId 31337). */
export const ANVIL_DEV_KEYS: readonly `0x${string}`[] = [
  ANVIL_DEV_KEY_0,
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
]
// Anvil's public default mnemonic: accounts 10-19 are the traffic generator's wallets (sim/traffic.ts).
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
/** Dev accounts the local Anvil creates: 0-2 users/demos, 9 Tickets admin, 10-19 traffic. */
export const ANVIL_ACCOUNTS = 20
export const TRAFFIC_ACCOUNT_INDEXES: readonly number[] = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]

/**
 * The one account map of the local chain (Anvil dev accounts of the public mnemonic). Keep new roles off these indexes.
 *   0-2   users / demo wallets (`npm run pga` scenarios 1-3, demo.sh, the live view)
 *   0     also the flood scenario's zero-tip sender
 *   1     also the flood scenario's "later arrival" (tips exactly p); only one flood runs at a time
 *   3-8   the flood scenario's paying flooders
 *   3-5   also the demo's chapter-4 "competitors" (`npm run demo`; the flood and the demo never run together)
 *   9     Tickets admin (LOCAL_ADMIN_KEY)
 *   10-19 traffic generator
 *
 * Race roles (C1, `npm run race`) REUSE accounts that are idle while a race runs; only one scenario runs at a time, and
 * the race never runs together with the flood:
 *   9     race operator (calls Race.open; also the Tickets admin, which is idle during a race)
 *   0     race "mine" (the high-tip bot; also the default user wallet)
 *   2     race "rival" (the low-tip bot that fires first)
 * Each race bot buys its own Fast Feed ticket from its own wallet, with its own in-memory key.
 */
export const ANVIL_ACCOUNT_MAP = {
  users: [0, 1, 2],
  floodZeroTip: 0,
  floodLaterArrival: 1,
  flooders: [3, 4, 5, 6, 7, 8],
  admin: 9,
  traffic: TRAFFIC_ACCOUNT_INDEXES,
  raceOperator: 9,
  raceMine: 0,
  raceRival: 2,
  /**
   * B5 slot demo (`npm run pga:slot`): four wallets, one tx each, so nonce ordering never interferes. Account 3 is
   * also a flooder; the slot demo and the flood never run together.
   */
  slotSenders: [0, 1, 2, 3],
  /**
   * C8 (`npm run demo`, chapter 4): "competitor" wallets that put lower-tip txs into round 2 just before the demo's own tx.
   * They are flooders, idle during the demo (the flood and the demo never run together).
   */
  demoCompetitors: [3, 4, 5],
} as const

/** The private key of a local Anvil dev account (public mnemonic: LOCAL ONLY). */
export function anvilDevKey(addressIndex: number): `0x${string}` {
  return bytesToHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex }).getHdKey().privateKey!)
}

/** The flood scenario's constant paying tip p, wei (0.01 gwei, equal to the pinned base fee). */
export const FLOOD_TIP_WEI = 10_000_000n
// Account 9 owns the local Tickets deployment: proxy admin, all roles, and the proceeds beneficiary.
export const LOCAL_ADMIN_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'

// Local simulator presets. B = block time, K = rounds per block.
// ASSUMPTION: the workshop slows time down (default 2000ms) so a human can see the feed
// message arrive before its block becomes visible. `fast` matches Arbitrum One's 250ms.
export const SIM_PRESETS: Record<SimPresetName, { blockMs: number; k: number }> = {
  slow: { blockMs: 2000, k: 2 },
  fast: { blockMs: 250, k: 2 },
}

/** Ticket market parameters of the local deployment (accelerated: a round lasts seconds, not a day). */
export interface LocalTicketParams {
  /** Ticket round length. TICKET_ROUND_SECONDS overrides it (tests use a few seconds). */
  roundSeconds: number
  /** True when roundSeconds was raised from the 30 s default to 4 x B (slow blocks). */
  roundAdapted?: boolean
  /** Set when TICKET_ROUND_SECONDS is below 4 x B (a purchase may miss its round). */
  roundWarning?: string
  targetTicketsPerRound: number
  maxTicketsPerRound: number
  /** Token base units (6 decimals). */
  minimumPrice: bigint
  priceUpdateFraction: number
  /** Out of 256. 0 = no grandfather period. */
  grandfatherPeriodFraction: number
  /** firstRoundStart = deploy time + this lead. */
  firstRoundLeadSeconds: number
}

export interface LocalParams {
  preset: SimPresetName
  blockMs: number
  k: number
  roundMs: number
  /** Extra delay after the block boundary before the block is visible on the mock RPC. */
  blockPublishDelayMs: number
  /** Pinned base fee, wei. ASSUMPTION: constant, equal to the Arbitrum One floor. */
  baseFeeWei: bigint
  rpcPort: number
  feedPort: number
  anvilPort: number
  anvilUrl: string
  host: string
  chainId: number
  tickets: LocalTicketParams
  /** FEED_AUTH=off disables ticket checks on the mock feed (A1 open-feed behaviour). */
  feedAuth: boolean
  /** 'pga' (default) orders each round by effective tip; 'fifo' keeps arrival order (local probe tests only). */
  ordering: 'pga' | 'fifo'
  /** GAP_HOLD_ROUNDS: rounds a nonce-gapped tx waits for its predecessor before it is dropped (ASSUMPTION, see pga/rules/pga-core.ts). */
  gapHoldRounds: number
  /**
   * MAX_TXS_PER_ROUND: block-full stand-in. At most this many txs per round (a block holds at most K x this); 0 = no cap.
   * ASSUMPTION: a tx-count cap stands in for Arbitrum One's 32 Mgas / 95 kB calldata block limit (sim/README.md).
   */
  maxTxsPerRound: number
  /** `--slowmo` / SIM_SLOWMO=1: B = 25000ms (Arbitrum One's 250ms x 100), K = 2. */
  slowmo: boolean
}

export interface Preset {
  mode: Mode
  name: string
  chainId: number
  /** Read endpoint. */
  rpcUrl: string
  /** Where raw transactions are sent (the sequencer endpoint). */
  sendUrl: string
  feedUrl: string
  explorerUrl?: string
  ticketsProxy?: string
  testToken?: string
  /** The `Race` contract (local: from `sim_info` at runtime; testnet: set by a later phase's `race:deploy`). */
  raceAddress?: string
  /** First block that can hold TicketsPurchased logs (the Tickets proxy deploy block). */
  ticketsFromBlock?: bigint
  local?: LocalParams
}

/** Contracts the local stack deployed; published by the `sim_info` RPC method. */
export interface LocalContracts {
  tickets: string
  testToken: string
  /** Account 9: proxy admin, roles, beneficiary. */
  admin: string
  /** The C1 `Race` contract (operator = account 9). */
  race: string
  /** Block the Tickets proxy was deployed in. */
  deployBlock: number
}

export const TESTNET_PRESET: Preset = {
  mode: 'testnet',
  name: 'Arbitrum Sepolia',
  chainId: 421614,
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  sendUrl: 'https://sepolia-rollup-sequencer.arbitrum.io/rpc',
  feedUrl: 'wss://sepolia-rollup-txfeed.arbitrum.io',
  explorerUrl: 'https://sepolia.arbiscan.io',
  ticketsProxy: '0x6f940179448e0a1C7BD8cfCB787555eb85cFC879',
  testToken: '0xca202b90454Db321256Cd84531Dd4929561d1e00',
  // TODO(A5): set to the Arbitrum Sepolia deploy block of the Tickets proxy; 0 scans from genesis
  // (slow, and some RPCs cap eth_getLogs ranges).
  ticketsFromBlock: 0n,
}

/** Default for GAP_HOLD_ROUNDS (ASSUMPTION: the docs do not say how long a nonce-gapped tx waits). */
export const DEFAULT_GAP_HOLD_ROUNDS = 10

const LOCAL_DEFAULTS = {
  host: '127.0.0.1',
  rpcPort: 8547, // mock sequencer JSON-RPC (what users talk to)
  feedPort: 9642, // mock Fast Feed
  anvilPort: 8545, // internal; users only reach Anvil through the proxy
  chainId: 31337,
  baseFeeWei: 10_000_000n,
  blockPublishDelayMs: 50,
}

/** Local ticket round default (seconds); raised to 4 x B for slow blocks by ticketRoundSeconds. */
export const LOCAL_TICKET_ROUND_DEFAULT_S = 30

const LOCAL_TICKET_DEFAULTS: LocalTicketParams = {
  roundSeconds: LOCAL_TICKET_ROUND_DEFAULT_S,
  targetTicketsPerRound: 100,
  maxTicketsPerRound: 200,
  minimumPrice: 1_000_000n, // 1 TEST
  priceUpdateFraction: 144,
  grandfatherPeriodFraction: 0,
  firstRoundLeadSeconds: 3,
}

/**
 * Local ticket round: max(30 s, 4 x B) (ceil to whole seconds), because a purchase or renewal is visible only after its
 * block closes and must still land in the intended round. An explicit TICKET_ROUND_SECONDS wins, with a warning below 4 x B.
 */
export function ticketRoundSeconds(
  blockMs: number,
  env: NodeJS.ProcessEnv = process.env,
): { seconds: number; adapted: boolean; warning?: string } {
  const base = LOCAL_TICKET_DEFAULTS.roundSeconds
  const need = Math.ceil((4 * blockMs) / 1000)
  const explicit = intEnv(env, 'TICKET_ROUND_SECONDS', 0)
  if (explicit > 0) {
    return explicit < need
      ? { seconds: explicit, adapted: false, warning: `TICKET_ROUND_SECONDS=${explicit}s is below 4 x B (${need}s): a purchase or renewal (visible only after its ${blockMs / 1000}s block closes) may miss its round` }
      : { seconds: explicit, adapted: false }
  }
  return need > base ? { seconds: need, adapted: true } : { seconds: base, adapted: false }
}

/** Load a git-ignored .env if present (Node >= 22). Existing env vars win. */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENV_FILE || '.env' // ENV_FILE: test/override hook so tools never have to touch the repo .env
}

/** FEED_API_KEY, trimmed; undefined when unset or empty. The one reader used by every command. Never print it. */
export function feedApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.FEED_API_KEY?.trim() || undefined
}

/**
 * FEED_BACKOFF_MAX_MS: cap of the `feed --reconnect` backoff, default 30000 (1s doubling up to this).
 * Tests set a small value so a reconnect cannot overshoot a deadline.
 */
export function feedBackoffMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = intEnv(env, 'FEED_BACKOFF_MAX_MS', 30_000)
  if (n < 1) throw new ConfigError('FEED_BACKOFF_MAX_MS must be a positive integer (milliseconds).')
  return n
}

export function loadDotEnv(): void {
  const file = envFilePath()
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file)
    } catch {
      /* ignore malformed .env */
    }
  }
}

function intEnv(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const v = env[name]
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer, got "${v}"`)
  return n
}

/** `--local` / `--testnet`: exactly one is required. */
export function parseMode(argv: readonly string[]): Mode {
  const local = argv.includes('--local')
  const testnet = argv.includes('--testnet')
  if (local && testnet) {
    throw new ConfigError('Pass only one of --local or --testnet, not both.')
  }
  if (!local && !testnet) {
    throw new ConfigError(
      'Missing network flag. Pass --local (Anvil + mock sequencer + mock Fast Feed, chainId 31337) ' +
        'or --testnet (Arbitrum Sepolia, chainId 421614).',
    )
  }
  return local ? 'local' : 'testnet'
}

/** `--preset slow|fast` or SIM_PRESET (local simulator only). Default: slow. */
export function parseSimPreset(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): SimPresetName {
  let value: string | undefined
  const i = argv.indexOf('--preset')
  if (i >= 0) {
    value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new ConfigError('--preset needs a value: slow or fast.')
  } else {
    const eq = argv.find((a) => a.startsWith('--preset='))
    if (eq) {
      value = eq.slice('--preset='.length)
      if (value === '') throw new ConfigError('--preset needs a value: slow or fast.')
    }
  }
  value ??= env.SIM_PRESET || undefined
  if (value === undefined) return 'slow'
  if (value !== 'slow' && value !== 'fast') throw new ConfigError(`Unknown preset "${value}". Use slow or fast.`)
  return value
}

/** Smallest block time `--block-ms` / SIM_BLOCK_MS accepts: Arbitrum One's own 250ms. */
export const MIN_BLOCK_MS = 250
/** Largest block time accepted (10 minutes): a longer block only makes a workshop look hung. */
export const MAX_BLOCK_MS = 600_000
/** `--slowmo`: Arbitrum One's 250ms block slowed down 100 times. */
export const SLOWMO_FACTOR = 100
export const SLOWMO_BLOCK_MS = ARBITRUM_ONE.blockMs * SLOWMO_FACTOR

/** Validate a block time given as text (flag or env var). Throws a one-line ConfigError. */
export function parseBlockMsValue(value: string | undefined, source: string): number {
  const bad = `${source} must be an even whole number of milliseconds from ${MIN_BLOCK_MS} to ${MAX_BLOCK_MS} (Arbitrum One: ${ARBITRUM_ONE.blockMs}; even so that round = B/2 is a whole number), got ${value === undefined || value === '' ? 'no value' : `"${value}"`}.`
  if (value === undefined || value === '' || !/^\d+$/.test(value.trim())) throw new ConfigError(bad)
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < MIN_BLOCK_MS || n > MAX_BLOCK_MS || n % 2 !== 0) throw new ConfigError(bad)
  return n
}

/** `--block-ms <ms>` (or `=<ms>`): the raw value, undefined when the flag is absent. A missing value is a ConfigError. */
export function parseBlockMsFlag(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--block-ms')
  if (i >= 0) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new ConfigError(`--block-ms needs a value: an even whole number of milliseconds from ${MIN_BLOCK_MS} to ${MAX_BLOCK_MS}.`)
    return v
  }
  const eq = argv.find((a) => a.startsWith('--block-ms='))
  return eq === undefined ? undefined : eq.slice('--block-ms='.length)
}

/**
 * B override of the chosen preset (K stays 2). Precedence: the `--block-ms` flag beats SIM_BLOCK_MS, which beats the
 * preset. Undefined when neither is set. `npm run sim` turns the flag into SIM_BLOCK_MS for the rest of the code.
 */
export function blockMsOverride(argv: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): number | undefined {
  const flag = parseBlockMsFlag(argv)
  if (flag !== undefined) return parseBlockMsValue(flag, '--block-ms')
  const e = env.SIM_BLOCK_MS
  return e === undefined || e === '' ? undefined : parseBlockMsValue(e, 'SIM_BLOCK_MS')
}

const truthy = (v: string | undefined) => ['1', 'on', 'true', 'yes'].includes((v ?? '').trim().toLowerCase())

/** `--slowmo` or SIM_SLOWMO=1: B = 25000ms, K = 2. Conflicts with --block-ms / SIM_BLOCK_MS (ConfigError). */
export function slowmoRequested(argv: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): boolean {
  const on = argv.includes('--slowmo') || truthy(env.SIM_SLOWMO)
  if (on && blockMsOverride(argv, env) !== undefined) {
    throw new ConfigError(`--slowmo sets the block time (${SLOWMO_BLOCK_MS}ms) itself and conflicts with --block-ms / SIM_BLOCK_MS; pass only one of them.`)
  }
  return on
}

export function localParams(
  preset: SimPresetName = 'slow',
  env: NodeJS.ProcessEnv = process.env,
): LocalParams {
  const { k } = SIM_PRESETS[preset]
  const slowmo = slowmoRequested([], env)
  const blockMs = slowmo ? SLOWMO_BLOCK_MS : (blockMsOverride([], env) ?? SIM_PRESETS[preset].blockMs)
  const d = LOCAL_DEFAULTS
  const ticketRound = ticketRoundSeconds(blockMs, env)
  const anvilPort = intEnv(env, 'SIM_ANVIL_PORT', d.anvilPort)
  return {
    preset,
    blockMs,
    k,
    roundMs: blockMs / k, // PGA: round = B/K
    blockPublishDelayMs: intEnv(env, 'BLOCK_PUBLISH_DELAY_MS', d.blockPublishDelayMs),
    baseFeeWei: d.baseFeeWei,
    rpcPort: intEnv(env, 'SIM_RPC_PORT', d.rpcPort),
    feedPort: intEnv(env, 'SIM_FEED_PORT', d.feedPort),
    anvilPort,
    anvilUrl: `http://${d.host}:${anvilPort}`,
    host: d.host,
    chainId: d.chainId,
    tickets: {
      ...LOCAL_TICKET_DEFAULTS,
      // max(30 s, 4 x B); TICKET_ROUND_SECONDS overrides (tests use a few seconds).
      roundSeconds: ticketRound.seconds,
      roundAdapted: ticketRound.adapted,
      ...(ticketRound.warning !== undefined ? { roundWarning: ticketRound.warning } : {}),
    },
    feedAuth: parseFeedAuth(env),
    ordering: parseOrdering(env),
    gapHoldRounds: gapHoldRounds(env),
    maxTxsPerRound: maxTxsPerRound(env),
    slowmo,
  }
}

/** MAX_TXS_PER_ROUND: a non-negative integer; 0 or unset = no cap. */
export function maxTxsPerRound(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, 'MAX_TXS_PER_ROUND', 0)
}

/** `--max-txs-per-round N` (or `=N`): the value, or undefined when the flag is absent. */
export function parseMaxTxsFlag(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--max-txs-per-round')
  if (i >= 0) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new ConfigError('--max-txs-per-round needs a value: a non-negative integer (0 = no cap).')
    return v
  }
  const eq = argv.find((a) => a.startsWith('--max-txs-per-round='))
  if (eq !== undefined) {
    const v = eq.slice('--max-txs-per-round='.length)
    if (v === '') throw new ConfigError('--max-txs-per-round needs a value: a non-negative integer (0 = no cap).')
    return v
  }
  return undefined
}

/** GAP_HOLD_ROUNDS: a positive integer (default 10). 0 is rejected rather than silently replaced by the default. */
export function gapHoldRounds(env: NodeJS.ProcessEnv = process.env): number {
  const n = intEnv(env, 'GAP_HOLD_ROUNDS', DEFAULT_GAP_HOLD_ROUNDS)
  if (n < 1) throw new ConfigError('GAP_HOLD_ROUNDS must be a positive integer (rounds a nonce-gapped tx waits before it is dropped), got 0.')
  return n
}

/** SIM_ORDER=fifo keeps arrival order (PGA disabled). `npm run sim -- --fifo` sets it. Default: pga. */
export function parseOrdering(env: NodeJS.ProcessEnv = process.env): 'pga' | 'fifo' {
  return (env.SIM_ORDER ?? '').trim().toLowerCase() === 'fifo' ? 'fifo' : 'pga'
}

/** FEED_AUTH=off (or 0/false) opens the local feed; anything else keeps ticket auth on. */
export function parseFeedAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.FEED_AUTH ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** JSON form of LocalParams (bigint -> string), as served by `sim_info`. */
export type LocalParamsJson = Omit<LocalParams, 'baseFeeWei' | 'tickets'> & {
  baseFeeWei: string
  tickets: Omit<LocalTicketParams, 'minimumPrice'> & { minimumPrice: string }
}

export function localParamsToJson(p: LocalParams): LocalParamsJson {
  return { ...p, baseFeeWei: p.baseFeeWei.toString(), tickets: { ...p.tickets, minimumPrice: p.tickets.minimumPrice.toString() } }
}

export function localParamsFromJson(j: LocalParamsJson): LocalParams {
  return { ...j, baseFeeWei: BigInt(j.baseFeeWei), tickets: { ...j.tickets, minimumPrice: BigInt(j.tickets.minimumPrice) } }
}

/**
 * For the local preset the Tickets / TEST addresses exist only after the stack deployed them, so
 * ask the running stack (`sim_info`) and return the preset with them filled in, plus the stack's
 * own parameters (its ticket round length may differ from our env). The testnet preset already
 * has fixed addresses and is returned unchanged.
 */
export async function resolvePreset(preset: Preset): Promise<Preset> {
  if (preset.mode !== 'local') return preset
  const res = await fetch(preset.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sim_info', params: [] }),
  })
  const body = (await res.json()) as { result?: LocalParamsJson & { contracts?: LocalContracts; clock?: { chainNowMs?: number } }; error?: { message: string } }
  if (!body.result?.contracts) throw new ConfigError(`The local simulator did not report its contracts (${body.error?.message ?? 'no sim_info.contracts'}).`)
  const { contracts, receiptMismatches: _mismatches, clock, ...params } = body.result as LocalParamsJson & { contracts: LocalContracts; receiptMismatches?: number; clock?: { chainNowMs?: number } }
  // E2: the simulator's chain clock may lag the wall clock (it was paused) or lead it (skipped): ticket times are chain times.
  if (typeof clock?.chainNowMs === 'number') setChainClock(clock.chainNowMs)
  return {
    ...preset,
    ticketsProxy: contracts.tickets,
    testToken: contracts.testToken,
    raceAddress: contracts.race,
    ticketsFromBlock: BigInt(contracts.deployBlock),
    local: localParamsFromJson(params as LocalParamsJson),
  }
}

/** Wallet for the CLI: PRIVATE_KEY from env if set, else Anvil dev account 0 (local only). Never printed. */
export function walletKey(preset: Preset, env: NodeJS.ProcessEnv = process.env): `0x${string}` {
  const k = env.PRIVATE_KEY?.trim()
  if (k) return (k.startsWith('0x') ? k : `0x${k}`) as `0x${string}`
  if (preset.mode === 'local') return ANVIL_DEV_KEY_0
  throw new ConfigError(`PRIVATE_KEY is not set. Put a throwaway wallet key in ${envFilePath(env)} (see docs/setup.md).`)
}

export function localPreset(preset: SimPresetName = 'slow', env: NodeJS.ProcessEnv = process.env): Preset {
  const lp = localParams(preset, env)
  const rpc = `http://${lp.host}:${lp.rpcPort}`
  return {
    mode: 'local',
    name: 'Local simulator (Anvil + mock sequencer + mock Fast Feed)',
    chainId: LOCAL_DEFAULTS.chainId,
    rpcUrl: rpc,
    sendUrl: rpc,
    feedUrl: `ws://${lp.host}:${lp.feedPort}`,
    local: lp,
  }
}

/** Resolve the active preset from CLI args. Throws ConfigError on bad flags. */
export function getPreset(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Preset {
  const mode = parseMode(argv)
  return mode === 'testnet' ? TESTNET_PRESET : localPreset(parseSimPreset(argv, env), env)
}
