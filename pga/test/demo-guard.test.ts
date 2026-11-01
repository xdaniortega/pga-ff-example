// demo.sh must refuse any chain except 31337 and 421614 (with ALLOW_TESTNET=1) BEFORE it signs or sends.
// A tiny JSON-RPC stub answers eth_chainId and records every method it is asked.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { after, before, test } from 'node:test'

let server: Server
let url: string
let chainId = 42161
const methods: string[] = []

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string }
      methods.push(body.method)
      const result = body.method === 'eth_chainId' ? '0x' + chainId.toString(16) : null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

function runDemo(env: Record<string, string>, demo = '1') {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile(
      'bash',
      ['pga/scripts/demo.sh', demo],
      { env: { PATH: `${process.env.PATH}:${homedir()}/.foundry/bin`, HOME: homedir(), RPC: url, ...env }, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    )
  })
}

test('demo.sh refuses an unsupported chainId (Arbitrum One) and never sends', async () => {
  chainId = 42161
  methods.length = 0
  const r = await runDemo({ K1: '0x01', K2: '0x02', K3: '0x03' })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /unsupported chainId 42161: this demo runs on --local \(31337\) and Arbitrum Sepolia \(421614\) only; never mainnet/)
  assert.ok(!methods.includes('eth_sendRawTransaction'))
  assert.ok(!methods.includes('eth_getTransactionCount'), 'did not even start signing')
})

test('demo.sh on Arbitrum Sepolia needs ALLOW_TESTNET=1 and never sends without it', async () => {
  chainId = 421614
  methods.length = 0
  const r = await runDemo({ K1: '0x01', K2: '0x02', K3: '0x03' })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /ALLOW_TESTNET=1/)
  assert.ok(!methods.includes('eth_sendRawTransaction'))
  assert.ok(!methods.includes('eth_getTransactionCount'))
})

test('demo.sh refuses when RPC and READ_RPC report different chain ids, and never sends', async () => {
  const other = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string }
      methods.push('read:' + body.method)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x7a69' : null }))
    })
  })
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
  try {
    chainId = 421614 // RPC (send) says Sepolia, READ_RPC says 31337
    methods.length = 0
    const readUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    const r = await runDemo({ READ_RPC: readUrl, ALLOW_TESTNET: '1', K1: '0x01', K2: '0x02', K3: '0x03' })
    assert.notEqual(r.code, 0)
    assert.match(r.out, /chainId .* but READ_RPC is chainId/)
    assert.ok(!methods.includes('eth_sendRawTransaction'))
  } finally {
    other.close()
  }
})

for (const demo of ['2', '3']) {
  test(`demo.sh ${demo} refuses Arbitrum One (42161) before it reads a nonce, signs or sends`, async () => {
    chainId = 42161
    methods.length = 0
    const r = await runDemo({ K1: '0x01', K2: '0x02', K3: '0x03' }, demo)
    assert.notEqual(r.code, 0)
    assert.match(r.out, /unsupported chainId 42161: this demo runs on --local \(31337\) and Arbitrum Sepolia \(421614\) only; never mainnet/)
    assert.ok(!methods.includes('eth_sendRawTransaction'))
    assert.ok(!methods.includes('eth_getTransactionCount'))
  })

  test(`demo.sh ${demo} on Arbitrum Sepolia needs ALLOW_TESTNET=1 and never sends without it`, async () => {
    chainId = 421614
    methods.length = 0
    const r = await runDemo({ K1: '0x01', K2: '0x02', K3: '0x03' }, demo)
    assert.notEqual(r.code, 0)
    assert.match(r.out, /ALLOW_TESTNET=1/)
    assert.ok(!methods.includes('eth_sendRawTransaction'))
    assert.ok(!methods.includes('eth_getTransactionCount'))
  })
}

test('demo.sh with an unknown demo number exits 2 with usage', async () => {
  const r = await runDemo({}, '4')
  assert.equal(r.code, 2)
  assert.match(r.out, /Usage: .*demo.sh 1\|2\|3/)
})

test('demo.sh output: plain when piped or NO_COLOR, red errors only when FORCE_COLOR forces it', async () => {
  chainId = 42161
  const piped = await runDemo({ K1: '0x01', K2: '0x02', K3: '0x03' })
  assert.doesNotMatch(piped.out, /\x1b\[/)
  const noColor = await runDemo({ K1: '0x01', K2: '0x02', K3: '0x03', FORCE_COLOR: '1', NO_COLOR: '1' })
  assert.doesNotMatch(noColor.out, /\x1b\[/)
  for (const off of ['0', 'false', 'FALSE', 'False']) {
    const r = await runDemo({ K1: '0x01', K2: '0x02', K3: '0x03', FORCE_COLOR: off })
    assert.doesNotMatch(r.out, /\x1b\[/, `FORCE_COLOR=${off} turns colour off (case-insensitive, like colorEnabled)`)
  }
  const forced = await runDemo({ K1: '0x01', K2: '0x02', K3: '0x03', FORCE_COLOR: '1' })
  assert.match(forced.out, /\x1b\[31mError: unsupported chainId 42161/, 'errors are red')
  const usage = await runDemo({ K1: '0x01' }, '9')
  assert.equal(usage.code, 2)
  assert.doesNotMatch(usage.out, /\x1b\[/)
})
