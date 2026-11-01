// Pre-signed type-2 transactions for the PGA bot: explicit nonce, gas and fees, so nothing is filled or estimated
// at send time and the txs can be signed BEFORE the tick sync and sent back to back.
import type { Address, Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'

export interface PresignArgs {
  to: Address
  data?: Hex
  value?: bigint
  /** maxPriorityFeePerGas, wei. */
  tip: bigint
  /** maxFeePerGas, wei. */
  maxFee: bigint
  nonce: number
  gas: bigint
  account: PrivateKeyAccount
  chain: { id: number }
}

/** A signed raw type-2 (EIP-1559) tx. A local account signs offline: viem fills nothing. */
export function presign(a: PresignArgs): Promise<Hex> {
  return a.account.signTransaction({
    type: 'eip1559',
    chainId: a.chain.id,
    to: a.to,
    data: a.data,
    value: a.value ?? 0n,
    nonce: a.nonce,
    gas: a.gas,
    maxFeePerGas: a.maxFee,
    maxPriorityFeePerGas: a.tip,
  })
}
