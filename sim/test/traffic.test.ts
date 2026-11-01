// The traffic generator: refuses --testnet (exit non-zero, explanation, nothing sent), keeps to its own wallets, tips in range.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ANVIL_DEV_KEY_0, LOCAL_ADMIN_KEY } from '../../shared/config.ts'
import { dropAfterMsFor, randomTip, refusalLines, SINKS, startTraffic, TIP_MAX_WEI, trafficAccounts } from '../traffic.ts'

test('traffic --testnet refuses: non-zero exit, the explanation, no traffic', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'sim/traffic.ts', '--testnet', '--tps', '5'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
  clearTimeout(killTimer)
  assert.notEqual(code, 0)
  for (const l of refusalLines()) assert.ok(out.includes(l), `prints: ${l}`)
  assert.match(out, /spam a shared network/)
  assert.ok(!/traffic: |==> /.test(out), 'it never started')
})

test('traffic wallets are dedicated Anvil accounts 10-19 (not the user, demo or admin accounts)', () => {
  const addrs = trafficAccounts().map((a) => a.address.toLowerCase())
  assert.equal(new Set(addrs).size, 10)
  for (const k of [ANVIL_DEV_KEY_0, LOCAL_ADMIN_KEY, '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a']) {
    assert.ok(!addrs.includes(privateKeyToAccount(k as `0x${string}`).address.toLowerCase()))
  }
  // Anvil account 10 (public default mnemonic).
  assert.equal(addrs[0], '0xbcd4042de499d14e55001ccbb24a551f3b954096')
})

test('tips are uniform in [0, 0.1] gwei and sinks are fixed addresses', () => {
  assert.equal(randomTip(() => 0), 0n)
  assert.equal(randomTip(() => 0.9999999999), parseGwei('0.1'))
  for (let i = 0; i < 1000; i++) assert.ok(randomTip() <= TIP_MAX_WEI)
  assert.ok(SINKS.length >= 2 && SINKS.every((s) => /^0x[0-9a-fA-F]{40}$/.test(s)))
})

test('dropAfterMsFor: 20s floor, 2 x B above it (--slowmo B = 25s gives 50s)', () => {
  assert.equal(dropAfterMsFor(undefined), 20_000)
  assert.equal(dropAfterMsFor(250), 20_000)
  assert.equal(dropAfterMsFor(2000), 20_000)
  assert.equal(dropAfterMsFor(10_000), 20_000)
  assert.equal(dropAfterMsFor(25_000), 50_000)
})

test('E2: while paused the traffic sends nothing and drops nothing; after the resume the wait is not counted against its txs', { timeout: 30_000 }, async () => {
  // A fake proxy: accepts every tx, never produces a receipt (so a running generator WOULD count drops).
  let sends = 0
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const { id, method } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string }
      let result: unknown = null
      if (method === 'eth_getTransactionCount') result = '0x0'
      else if (method === 'eth_sendRawTransaction') result = '0x' + String(++sends).padStart(64, '0')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  const t = await startTraffic({ rpcUrl: `http://127.0.0.1:${port}`, chainId: 31337, tps: 50, baseFeeWei: 10_000_000n, dropAfterMs: 600, statsEveryMs: 0, log: () => {} })
  try {
    await new Promise((r) => setTimeout(r, 250))
    assert.ok(t.stats().sent >= 1, 'it was sending')
    t.pause()
    t.pause() // idempotent
    assert.equal(t.paused, true)
    await new Promise((r) => setTimeout(r, 100)) // an in-flight send may still land
    const sent = t.stats().sent
    const skipped = t.stats().skipped
    await new Promise((r) => setTimeout(r, 1200)) // twice the drop time
    assert.equal(t.stats().sent, sent, 'nothing sent while paused')
    assert.equal(t.stats().skipped, skipped, 'a paused tick is not a skipped one')
    assert.equal(t.stats().dropped, 0, 'nothing dropped while paused, although the drop time passed')
    t.resume()
    assert.equal(t.stats().dropped, 0, 'right after the resume nothing is late: the paused time was added to every send time')
    await new Promise((r) => setTimeout(r, 1000))
    assert.ok(t.stats().dropped > 0, 'running again, a tx that never gets a receipt is dropped as before')
    assert.ok(t.stats().sent > sent, 'and it sends again')
  } finally {
    await t.stop()
    await new Promise<void>((r) => srv.close(() => r()))
  }
})
