// `npm run tickets:buy|tickets:status|tickets:withdraw -- --local|--testnet [options]`
//   buy       [--tickets N]    mint (local) -> approve -> deposit -> read round/price -> purchase
//   status                     wallet, deposit, round, price, tickets, key access
//   withdraw  [--amount <tokens>]  take the deposit (all, or an amount) back to the wallet
// Concepts: fast-feed/README.md
import { parseUnits } from 'viem'
import { envFilePath, feedApiKey, getPreset, loadDotEnv, resolvePreset, TOKEN_DECIMALS } from '../../shared/config.ts'
import { error, important, note, plain, setInternalVisible, step } from '../../shared/narrate.ts'
import { apiKeyHash } from './key.ts'
import {
  approve,
  balances,
  checkGrandfather,
  deposit,
  ensureRoundRoom,
  fmtToken,
  fmtWhen,
  formatTicketsError,
  makeCtx,
  mintLocal,
  nowSec,
  purchase,
  readRound,
  status,
  UserError,
  withdraw,
} from './tickets.ts'

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i >= 0) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UserError(`${name} needs a value.`)
    return v
  }
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
}


async function main() {
  loadDotEnv()
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (cmd !== 'buy' && cmd !== 'status' && cmd !== 'withdraw') {
    throw new UserError('Usage: npm run tickets:buy|tickets:status|tickets:withdraw -- --local|--testnet')
  }
  let preset = getPreset(argv)
  if (preset.mode === 'local') {
    setInternalVisible(true)
    const { startOrAttach } = await import('../../sim/index.ts') // sim code is local-only
    // Tickets live in the running simulator's chain: a stack started just for this command would vanish with it.
    await startOrAttach(preset.local!, preset.chainId, { attachOnly: true, banner: false })
    preset = await resolvePreset(preset)
    const { ticketSummaryLine } = await import('../../sim/banner.ts')
    note(ticketSummaryLine(preset.local!))
  } else {
    step(`${preset.name}: ${preset.rpcUrl}`)
  }
  const ctx = makeCtx(preset)
  step(`wallet ${ctx.account.address} (key never printed)`)

  if (cmd === 'status') {
    const key = feedApiKey()
    await status(ctx, key ? apiKeyHash(key) : undefined)
    return
  }

  if (cmd === 'withdraw') {
    const a = flagValue(argv, '--amount')
    await withdraw(ctx, a === undefined ? undefined : parseUnits(a, TOKEN_DECIMALS))
    return
  }

  // buy
  const key = feedApiKey()
  if (!key) throw new UserError(`FEED_API_KEY is not set in ${envFilePath()}. Run \`npm run key:new\` first.`)
  const n = Number(flagValue(argv, '--tickets') ?? '1')
  if (!Number.isInteger(n) || n < 1) throw new UserError('--tickets must be a whole number >= 1.')
  const keyHash = apiKeyHash(key)

  // Size the deposit from the current price (a quiet pre-read; the narrated read happens right before buying).
  const pre = await readRound(ctx)
  checkGrandfather(pre, n)
  const need = pre.price * BigInt(n)
  const { wallet, deposited } = await balances(ctx)
  const toDeposit = need > deposited ? need - deposited : 0n
  note(`${n} ticket(s) x ${fmtToken(pre.price)} = ${fmtToken(need)}; already deposited ${fmtToken(deposited)}.`)
  if (toDeposit > wallet) await mintLocal(ctx, toDeposit - wallet)
  if (toDeposit > 0n) {
    await approve(ctx, toDeposit)
    await deposit(ctx, toDeposit)
  } else note('Enough is already deposited: skipping approve and deposit.')

  await ensureRoundRoom(ctx, preset.local?.blockMs ?? 250) // Arbitrum's block time is 250ms
  const r = await readRound(ctx, { print: true })
  checkGrandfather(r, n)
  const p = await purchase(ctx, r, n, keyHash)
  important(`  bought ${p.filled} ticket(s) in round ${p.round} at ${fmtToken(p.price)} each`)
  step(`access starts at ${fmtWhen(p.accessStart, nowSec())}`)
  note(`A ticket bought in round ${p.round} is active in round ${p.round + 1n} only: until that round starts the feed answers 401, and when it ends the connection closes with 1008.`)
  note('Renew every round: buy again before each round ends to keep the connection.')
  note(`Then: npm run feed -- ${argv.includes('--testnet') ? '--testnet' : '--local'}`)
}

main().catch((e) => {
  error(`Error: ${formatTicketsError(e)}`)
  process.exit(1)
})
