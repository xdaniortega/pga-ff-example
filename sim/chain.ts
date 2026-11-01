// Spawns and talks to Anvil (the local EVM). Anvil is internal: users reach it only through
// the mock sequencer proxy (sim/rpc.ts).
//
// ASSUMPTION: Anvil runs with --no-mining, so we decide when a block exists. K PGA rounds share one block, like on
// Arbitrum; a block exists only when one of its rounds has transactions (sim/sequencer.ts).
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ANVIL_ACCOUNTS, type LocalParams } from '../shared/config.ts'

export function resolveBin(name: string): string {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  dirs.push(join(homedir(), '.foundry', 'bin'))
  for (const d of dirs) {
    const p = join(d, name)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      /* next */
    }
  }
  throw new Error(`Cannot find "${name}". Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup`)
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen(port, host, () => s.close(() => resolve(true)))
  })
}

/** A JSON-RPC error from Anvil; code, message and data (e.g. revert data) are preserved end to end. */
export class RpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export async function jsonRpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: T; error?: { code?: number; message: string; data?: unknown } }
  if (body.error) throw new RpcCallError(body.error.code ?? -32603, body.error.message, body.error.data)
  return body.result as T
}

export interface Anvil {
  url: string
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>
  stop(): Promise<void>
}

export async function startAnvil(p: LocalParams, chainId: number): Promise<Anvil> {
  if (!(await isPortFree(p.anvilPort, p.host))) {
    throw new Error(`Port ${p.anvilPort} (internal Anvil port) is busy. Stop whatever uses it or set SIM_ANVIL_PORT.`)
  }
  const bin = resolveBin('anvil')
  const child: ChildProcess = spawn(
    bin,
    [
      '--no-mining',
      // 0-2 user/demo wallets, 9 Tickets admin, 10-19 the traffic generator (sim/traffic.ts).
      '--accounts', String(ANVIL_ACCOUNTS),
      '--order', 'fifo',
      '--chain-id', String(chainId),
      '--host', p.host,
      '--port', String(p.anvilPort),
      '--base-fee', p.baseFeeWei.toString(),
      '--silent',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  let stopped = false
  let exited = false
  const exitPromise = new Promise<void>((resolve) =>
    child.once('exit', () => {
      exited = true
      resolve()
    }),
  )
  // Never leave an orphan: if this process exits for any reason, kill Anvil synchronously.
  const killOnExit = () => {
    if (!exited) child.kill('SIGKILL')
  }
  process.on('exit', killOnExit)

  const stop = async () => {
    if (stopped) return
    stopped = true
    process.off('exit', killOnExit)
    if (!exited) {
      child.kill('SIGTERM')
      const t = setTimeout(() => child.kill('SIGKILL'), 2000)
      await exitPromise
      clearTimeout(t)
    }
  }

  const url = p.anvilUrl
  const deadline = Date.now() + 15000
  for (;;) {
    if (exited) throw new Error('Anvil exited during startup (see output above).')
    try {
      await jsonRpc(url, 'eth_chainId')
      break
    } catch {
      if (Date.now() > deadline) {
        await stop()
        throw new Error('Anvil did not become ready within 15s.')
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  return { url, call: (m, params = []) => jsonRpc(url, m, params), stop }
}
