// Local funding of the user's own wallets (sim/fund.ts): PRIVATE_KEY and MY_ADDRESSES get 1000 ETH on Anvil at stack
// start, so `--local` commands work when `.env` holds a testnet key. Only the address is printed, never the key.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { localPreset } from '../../shared/config.ts'
import { buildContracts } from '../build.ts'
import { jsonRpc } from '../chain.ts'
import { walletsToFund } from '../fund.ts'
import { startOrAttach, type Stack } from '../index.ts'

test('walletsToFund: PRIVATE_KEY (with or without 0x) and MY_ADDRESSES; an invalid key is skipped without echoing it', () => {
  const key = generatePrivateKey()
  const addr = privateKeyToAccount(key).address
  assert.deepEqual(walletsToFund({}), [])
  assert.deepEqual(walletsToFund({ PRIVATE_KEY: key }).map((w) => w.address), [addr])
  assert.deepEqual(walletsToFund({ PRIVATE_KEY: key.slice(2) }).map((w) => w.address), [addr])
  assert.deepEqual(walletsToFund({ MY_ADDRESSES: ` ${addr}, not-an-address ` }).map((w) => w.address), [addr])
  const logs: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => void logs.push(a.join(' '))
  try {
    assert.deepEqual(walletsToFund({ PRIVATE_KEY: 'secret-not-a-key' }), [])
    assert.deepEqual(walletsToFund({ MY_ADDRESSES: 'secret-typo' }), [])
  } finally {
    console.log = orig
  }
  assert.ok(!logs.join('\n').includes('secret-not-a-key'))
  assert.ok(!logs.join('\n').includes('secret-typo'), 'a rejected MY_ADDRESSES entry is not echoed')
  assert.match(logs.join('\n'), /MY_ADDRESSES entry 1 \(not an address\)/)
})

let stack: Stack | undefined
after(async () => {
  await stack?.stop()
})

test('stack start funds the PRIVATE_KEY wallet and MY_ADDRESSES with 1000 ETH, printing only addresses', { timeout: 120_000 }, async () => {
  buildContracts()
  const key = generatePrivateKey() // a throwaway key, passed through the environment
  const mine = privateKeyToAccount(key).address
  const extra = privateKeyToAccount(generatePrivateKey()).address
  const env = { ...process.env, PRIVATE_KEY: key, MY_ADDRESSES: extra, SIM_RPC_PORT: '21547', SIM_FEED_PORT: '21642', SIM_ANVIL_PORT: '21545', FEED_AUTH: 'off' }
  const preset = localPreset('slow', env)
  const logs: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => void logs.push(a.join(' '))
  try {
    stack = await startOrAttach(preset.local!, preset.chainId, { banner: false, env })
  } finally {
    console.log = orig
  }
  const balance = async (a: string) => BigInt(await jsonRpc<string>(preset.rpcUrl, 'eth_getBalance', [a, 'latest']))
  assert.equal(await balance(mine), 1000n * 10n ** 18n)
  assert.equal(await balance(extra), 1000n * 10n ** 18n)
  const out = logs.join('\n')
  assert.ok(out.includes(`funded ${mine.slice(0, 6)}…${mine.slice(-4)} (your PRIVATE_KEY wallet) with 1000 ETH on the local chain`), out)
  assert.ok(!out.includes(key) && !out.includes(key.slice(2)), 'the key is never printed')
})
