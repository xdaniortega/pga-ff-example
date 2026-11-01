// Local only: fund the user's own wallets on the local chain, so `--local` commands work when `.env` holds a
// testnet PRIVATE_KEY (which has no balance on Anvil). Only addresses are printed, never a key.
import { isAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { note, step } from '../shared/narrate.ts'
import type { Anvil } from './chain.ts'

export const LOCAL_FUND_WEI = 1000n * 10n ** 18n

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** The addresses to fund: the PRIVATE_KEY wallet (derived, key never printed) and every MY_ADDRESSES entry. */
export function walletsToFund(env: NodeJS.ProcessEnv): { address: Address; label: string }[] {
  const out: { address: Address; label: string }[] = []
  const k = env.PRIVATE_KEY?.trim()
  if (k) {
    try {
      out.push({ address: privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex).address, label: 'your PRIVATE_KEY wallet' })
    } catch {
      note('PRIVATE_KEY is set but is not a valid private key; not funding it on the local chain.')
    }
  }
  // A rejected entry is never echoed (it might be a mistyped key): only its position is shown.
  ;(env.MY_ADDRESSES ?? '').split(',').map((x) => x.trim()).filter(Boolean).forEach((a, i) => {
    if (isAddress(a, { strict: false })) out.push({ address: a as Address, label: 'a MY_ADDRESSES wallet' })
    else note(`MY_ADDRESSES entry ${i + 1} (not an address); skipped.`)
  })
  return out
}

/** Give each wallet 1000 ETH on the local Anvil (anvil_setBalance), unless it already has at least that. */
export async function fundUserWallets(anvil: Anvil, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const w of walletsToFund(env)) {
    const have = BigInt(await anvil.call<Hex>('eth_getBalance', [w.address, 'latest']))
    if (have < LOCAL_FUND_WEI) {
      await anvil.call('anvil_setBalance', [w.address, '0x' + LOCAL_FUND_WEI.toString(16)])
      step(`funded ${short(w.address)} (${w.label}) with 1000 ETH on the local chain`)
    } else note(`${short(w.address)} (${w.label}) already has ≥ 1000 ETH on the local chain`)
  }
}
