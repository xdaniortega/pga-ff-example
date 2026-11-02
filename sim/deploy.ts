// Deploys the Fast Feed ticket stack (and the C1 Race contract) onto the local chain at stack start:
//   USDGTest (local 6-decimals ERC20) + Tickets implementation + TransparentUpgradeableProxy(initialize).
// Pattern: github.com/OffchainLabs/feed-ticket-contracts bot/test/bot.test.ts (ERC20 + impl + proxy, firstRoundStart = latest block + lead).
// Admin, roles and beneficiary are Anvil dev account 9 (LOCAL_ADMIN_KEY), keeping accounts 0-2 free for users.
// Parameters come only from shared/config.ts (LocalParams.tickets).
//
// Blocks are mined here directly (evm_mine) before the sequencer exists; the sequencer then adopts the head.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, type Abi, type Address, type Chain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { LOCAL_ADMIN_KEY, type LocalContracts, type LocalParams } from '../shared/config.ts'
import { ticketsAbi } from '../fast-feed/client/abi.ts'
import type { Anvil } from './chain.ts'
import { withNow } from './rpc.ts'

interface Artifact {
  abi: Abi
  bytecode: Hex
}

function artifact(path: string): Artifact {
  let j: { abi: Abi; bytecode: { object: Hex } }
  try {
    j = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`Missing contract artifact ${path}. Run \`forge build\` first.`)
  }
  return { abi: j.abi, bytecode: j.bytecode.object }
}

export interface Deployed extends LocalContracts {
  firstRoundStart: number
  /** Latest block number after the deployment blocks. */
  head: number
}

/**
 * TIMESTAMP NOTE: the Tickets round views are functions of block.timestamp. Anvil runs --no-mining and
 * our sequencer mines only non-empty rounds, so the latest block's timestamp lags wall-clock time. All
 * reads therefore carry a block-timestamp override = wall-clock now (see rpc.ts `withNow`), and
 * `waitForFirstRound` waits in wall-clock time (Anvil block timestamps follow wall-clock time).
 */
export async function deployTickets(anvil: Anvil, p: LocalParams, chainId: number): Promise<Deployed> {
  const t = p.tickets
  const admin = privateKeyToAccount(LOCAL_ADMIN_KEY)
  const chain: Chain = { id: chainId, name: 'local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } }
  const wallet = createWalletClient({ account: admin, chain, transport: http(anvil.url) })
  const pub = createPublicClient({ chain, transport: http(anvil.url) })

  const mineOne = async () => {
    await anvil.call('anvil_setNextBlockBaseFeePerGas', ['0x' + p.baseFeeWei.toString(16)])
    await anvil.call('evm_mine')
  }
  const deploy = async (a: Artifact, args: unknown[]): Promise<Address> => {
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: admin, chain })
    await mineOne()
    const r = await pub.getTransactionReceipt({ hash })
    if (r.status !== 'success' || !r.contractAddress) throw new Error('local deployment failed')
    return getAddress(r.contractAddress)
  }

  const token = await deploy(artifact('out/TestToken.sol/TestToken.json'), [])
  const ticketsArt = artifact('out/Tickets.sol/Tickets.json')
  const impl = await deploy(ticketsArt, [token])
  // The C1 race contract: operator = the same admin wallet (Anvil account 9). Deployed before the proxy so the proxy's
  // block (the first-round clock and `deployBlock`) stays the last deployment.
  const race = await deploy(artifact('out/Race.sol/Race.json'), [admin.address])
  const latest = await pub.getBlock({ blockTag: 'latest' })
  // The proxy deployment block takes a wall-clock timestamp, which must be before firstRoundStart.
  const firstRoundStart = Math.max(Number(latest.timestamp), Math.floor(Date.now() / 1000)) + t.firstRoundLeadSeconds
  const initData = encodeFunctionData({
    abi: ticketsArt.abi,
    functionName: 'initialize',
    args: [
      {
        defaultAdmin: admin.address,
        beneficiarySetter: admin.address,
        marketParamsSetter: admin.address,
        beneficiary: admin.address,
        roundDuration: t.roundSeconds,
        targetTicketsPerRound: t.targetTicketsPerRound,
        maxTicketsPerRound: t.maxTicketsPerRound,
        minimumPrice: t.minimumPrice,
        priceUpdateFraction: t.priceUpdateFraction,
        grandfatherPeriodFraction: t.grandfatherPeriodFraction,
        firstRoundStart: BigInt(firstRoundStart),
      },
    ],
  })
  const proxy = await deploy(artifact('out/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json'), [impl, admin.address, initData])
  const head = Number(await pub.getBlockNumber())
  return { tickets: proxy, testToken: token, race, admin: admin.address, deployBlock: head, firstRoundStart, head }
}

/** Wait (wall-clock) until the first ticket round has started, then confirm with a real read. */
export async function waitForFirstRound(anvil: Anvil, tickets: string, firstRoundStart: number): Promise<void> {
  const data = encodeFunctionData({ abi: ticketsAbi, functionName: 'roundNumber' })
  const deadline = Date.now() + (firstRoundStart * 1000 - Date.now()) + 30_000
  for (;;) {
    const now = Math.floor(Date.now() / 1000)
    if (now > firstRoundStart) {
      try {
        await anvil.call('eth_call', withNow([{ to: tickets, data }], now))
        return
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`Tickets round views still revert after the first round start: ${(e as Error).message}`)
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}
