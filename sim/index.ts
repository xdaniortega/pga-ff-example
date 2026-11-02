// Local stack: Anvil + mock sequencer RPC (8547) + mock Fast Feed (9642).
// startOrAttach(): attach if our stack already runs, else start it in this process.
import { localParamsFromJson, type LocalContracts, type LocalParams, type LocalParamsJson } from '../shared/config.ts'
import { internal, note, step } from '../shared/narrate.ts'
import { printBanner } from './banner.ts'
import { buildContracts } from './build.ts'
import { isPortFree, jsonRpc, startAnvil } from './chain.ts'
import { ticketAuth } from '../fast-feed/mock/auth.ts'
import { deployTickets, waitForFirstRound } from './deploy.ts'
import { fundUserWallets } from './fund.ts'
import { startFeed } from '../fast-feed/mock/feed.ts'
import { startRpc, STACK_ID } from './rpc.ts'
import { formatRound, Sequencer } from './sequencer.ts'
import { gatedAnvil, RwGate } from './blocks.ts'
import { SimClock } from './clock.ts'
import { withNow } from './rpc.ts'
import { encodeFunctionData, type Hex } from 'viem'
import { ticketsAbi } from '../fast-feed/client/abi.ts'

export interface Stack {
  attached: boolean
  /** Parameters of the RUNNING stack (for an attach, its own, which may differ from ours). */
  params: LocalParams
  /** The deployed USDGTest / Tickets proxy / admin addresses. */
  contracts: LocalContracts
  stop(): Promise<void>
}

export interface StartOptions {
  /** Run `forge build` first (CLI entries do; tests do not). */
  build?: boolean
  /** Print every round tick, including empty ones (npm run sim). */
  ticks?: boolean
  /** Stop the stack on SIGINT/SIGTERM and exit (CLI entries do; tests do not). */
  signalHandlers?: boolean
  /** Print the R8 banner. */
  banner?: boolean
  /** Replaces the R8 banner printer (the demo prints a compact table). */
  bannerPrinter?: (p: LocalParams, attached: boolean) => void
  /** Replace the build, start, deploy and address lines by one `local stack ready` line (the demo). Errors still surface. */
  quiet?: boolean
  /** Fail instead of starting a stack (ticket commands: state lives in the running simulator). */
  attachOnly?: boolean
  /** Environment read for the wallets to fund (PRIVATE_KEY, MY_ADDRESSES). Default: process.env. */
  env?: NodeJS.ProcessEnv
}

type ClockFacts = { pausedTotalMs?: number; skippedMs?: number; chainNowMs?: number; paused?: boolean }
type Probe = { state: 'free' } | { state: 'foreign' } | { state: 'ours'; params: LocalParams; contracts: LocalContracts; clock?: ClockFacts }

async function probe(p: LocalParams): Promise<Probe> {
  const url = `http://${p.host}:${p.rpcPort}`
  try {
    const r = await jsonRpc<(LocalParamsJson & { stack?: string; contracts: LocalContracts; clock?: ClockFacts }) | undefined>(url, 'sim_info')
    if (r?.stack !== STACK_ID) return { state: 'foreign' }
    // Parameters of the RUNNING stack (its preset may differ from ours).
    const { stack: _stack, contracts, receiptMismatches: _mismatches, clock, ...params } = r as typeof r & { receiptMismatches?: number }
    return { state: 'ours', params: { ...p, ...localParamsFromJson(params) }, contracts, clock }
  } catch {
    // Port taken but nothing JSON-RPC-ish of ours answered: not our stack.
    return (await isPortFree(p.rpcPort, p.host)) ? { state: 'free' } : { state: 'foreign' }
  }
}

export async function startOrAttach(p: LocalParams, chainId: number, opts: StartOptions = {}): Promise<Stack> {
  const found = await probe(p)
  if (found.state === 'foreign') {
    throw new Error(
      `Port ${p.rpcPort} is in use by something that is not this workshop's simulator. ` +
        `Stop it, or set SIM_RPC_PORT / SIM_FEED_PORT / SIM_ANVIL_PORT to free ports.`,
    )
  }
  if (found.state === 'ours') {
    if (opts.banner !== false) (opts.bannerPrinter ?? printBanner)(found.params, true)
    if (await isPortFree(p.feedPort, p.host)) {
      throw new Error(`The simulator RPC on ${p.rpcPort} answers but the feed port ${p.feedPort} is down. Stop it and retry.`)
    }
    step(`attached to the running simulator (RPC http://${p.host}:${p.rpcPort}, feed ws://${p.host}:${p.feedPort})`)
    const c = found.clock
    if (c && ((c.pausedTotalMs ?? 0) > 0 || (c.skippedMs ?? 0) > 0)) {
      const lag = c.chainNowMs !== undefined ? Date.now() - c.chainNowMs : 0
      const s = (Math.abs(lag) / 1000).toFixed(1)
      note(`LOCAL: this simulator's chain clock ${lag >= 0 ? `lags the wall clock by ${s}s` : `is ${s}s ahead of the wall clock`} (it was paused or its clock skipped; ticket times follow the chain clock)${c.paused ? ' and it is paused right now' : ''}`)
    }
    return { attached: true, params: found.params, contracts: found.contracts, stop: async () => {} }
  }
  if (opts.attachOnly) {
    throw new Error('No local simulator is running. Start it in another terminal with `npm run sim`, then rerun this command.')
  }

  if (opts.banner !== false) (opts.bannerPrinter ?? printBanner)(p, false)
  if (opts.build) buildContracts({ quiet: opts.quiet })
  const say = (m: string) => { if (!opts.quiet) step(m) }
  say('starting the local stack: Anvil + mock sequencer + mock Fast Feed')
  if (!(await isPortFree(p.feedPort, p.host))) {
    throw new Error(`Feed port ${p.feedPort} is busy (not this simulator). Stop it or set SIM_FEED_PORT.`)
  }
  const anvil = await startAnvil(p, chainId)
  const closers: (() => Promise<void>)[] = [() => anvil.stop()]
  let contracts: LocalContracts
  try {
    say('deploying USDGTest + Tickets (behind a proxy, accelerated ticket parameters) + the Race contract')
    const dep = await deployTickets(anvil, p, chainId)
    contracts = { tickets: dep.tickets, testToken: dep.testToken, admin: dep.admin, race: dep.race, deployBlock: dep.deployBlock }
    say(`USDGTest ${dep.testToken}, Tickets proxy ${dep.tickets} (admin/beneficiary: Anvil account 9 ${dep.admin})`)
    say(`Race ${dep.race} (operator: Anvil account 9), used by \`npm run race\``)
    await fundUserWallets(anvil, opts.env ?? process.env)
    // Feed auth is built before the first-round wait; it reads the chain at request time.
    // Every Anvil caller except the sequencer waits while a block is being re-mined (read gate).
    const gate = new RwGate()
    const shared = gatedAnvil(anvil, gate)
    // E2: the clock the sequencer, the RPC proxy, the feed auth and the feed's rollover timer share (pause / skip, local only).
    const clock = new SimClock()
    const feed = await startFeed(p.host, p.feedPort, p.feedAuth ? ticketAuth(shared, dep.tickets, dep.deployBlock, () => clock.chainNowMs()) : undefined, { chainNowMs: () => clock.chainNowMs() })
    closers.unshift(() => feed.close())
    // Not ready until the first ticket round has started, so round views never revert for users.
    const wait = dep.firstRoundStart - Math.floor(Date.now() / 1000)
    if (wait > 0) say(`waiting ~${wait}s for the first ticket round to start`)
    await waitForFirstRound(anvil, dep.tickets, dep.firstRoundStart)
    const seq = new Sequencer(p, anvil, feed, (r) => {
      if (r.ordered > 0 || (r.held?.length ?? 0) > 0) for (const l of formatRound(r, p.ordering)) internal(l)
      if (r.pgaRound !== undefined && r.block !== undefined) {
        const where = `pga_round ${r.pgaRound} of block ${r.block}`
        const end = r.blockOpen
          ? `block ${r.block} stays open (not visible on RPC until round ${p.k} ends)`
          : `block ${r.block} closed and final; it becomes visible on RPC after ${p.blockPublishDelayMs}ms`
        const earlier = r.reMined ? `, re-mined behind ${r.reMined} tx(s) from earlier round(s) of the block` : ''
        const published = r.ordered > 0 ? `${r.ordered} feed message(s) published` : 'no feed message published'
        internal(`round ${r.round} (${where}): ordered ${r.ordered}, dropped ${r.dropped}${earlier}; ${published}; ${end}`)
      } else if (r.pgaRound !== undefined && r.ordered === 0 && r.dropped > 0) {
        internal(`round ${r.round}: every tx was left out of the provisional block, dropped ${r.dropped}; no block kept`)
      } else if (opts.ticks) internal(`round ${r.round}: empty, no block mined`)
    }, dep.head, gate, clock)
    // "ticket round N, Ns left" for the always-visible PAUSED / CLOCK SKIP lines (best effort).
    seq.ticketNote = async () => {
      const nowSec = Math.floor(clock.chainNowMs() / 1000)
      const view = async (fn: 'roundNumber' | 'roundEnd') => BigInt(await shared.call<Hex>('eth_call', withNow([{ to: dep.tickets, data: encodeFunctionData({ abi: ticketsAbi, functionName: fn }) }], nowSec)))
      const [round, end] = [await view('roundNumber'), await view('roundEnd')]
      return `ticket round ${round}, ${Math.max(0, Number(end) - nowSec)}s left`
    }
    const rpc = await startRpc(p.host, p.rpcPort, shared, seq, p, contracts)
    closers.unshift(() => rpc.close())
    closers.unshift(() => seq.stop())
    seq.start()
  } catch (e) {
    for (const c of closers) await c().catch(() => {})
    throw e
  }
  if (opts.quiet) step(`local stack ready: Anvil + mock sequencer + mock Fast Feed (RPC http://${p.host}:${p.rpcPort}, feed ws://${p.host}:${p.feedPort})`)
  else step(`sequencer RPC http://${p.host}:${p.rpcPort}  |  feed ws://${p.host}:${p.feedPort}`)

  let stopping: Promise<void> | undefined
  const stop = () => (stopping ??= (async () => {
    for (const c of closers) await c().catch(() => {})
  })())
  if (opts.signalHandlers) {
    const onSignal = () => {
      void stop().finally(() => process.exit(0))
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }
  return { attached: false, params: p, contracts, stop }
}
