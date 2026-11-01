// Runs `forge build` before the local stack starts (forge skips work when artifacts are fresh).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { error, note, step } from '../shared/narrate.ts'
import { resolveBin } from './chain.ts'

function hasSol(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? hasSol(p) : f.endsWith('.sol')
    })
  } catch {
    return false
  }
}

const LIBS = ['lib/forge-std/src', 'lib/openzeppelin-contracts/contracts', 'lib/openzeppelin-contracts-upgradeable/contracts']
const LIB_SPECS = ['foundry-rs/forge-std@v1.16.1', 'OpenZeppelin/openzeppelin-contracts@v5.6.1', 'OpenZeppelin/openzeppelin-contracts-upgradeable@v5.6.1']

/** A fresh clone has empty lib/ submodule directories: fetch them (pinned by .gitmodules / the recorded commits). */
export function ensureLibs(): void {
  if (LIBS.every((d) => existsSync(d))) return
  step('Solidity libs missing in lib/: git submodule update --init')
  spawnSync('git', ['submodule', 'update', '--init'], { stdio: 'inherit' })
  if (LIBS.every((d) => existsSync(d))) return
  step('submodules unavailable: falling back to forge install --no-git (pinned tags)')
  const r = spawnSync(resolveBin('forge'), ['install', '--no-git', ...LIB_SPECS], { stdio: 'inherit' })
  if (r.status !== 0 || !LIBS.every((d) => existsSync(d))) {
    throw new Error('Could not install the Solidity libs into lib/. Run `git submodule update --init` or see docs/setup.md.')
  }
}

/** `quiet`: capture forge's output and print it only when the build fails. */
export function buildContracts(opts: { quiet?: boolean } = {}): void {
  if (!hasSol('contracts/src')) {
    note('forge build: no contracts in contracts/src yet, skipping.')
    return
  }
  ensureLibs()
  if (!opts.quiet) step('forge build')
  const r = spawnSync(resolveBin('forge'), ['build'], opts.quiet ? { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 } : { stdio: 'inherit' })
  if (r.status !== 0) {
    if (opts.quiet) for (const l of `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n')) if (l.trim() !== '') error(l)
    throw new Error(`forge build failed${r.error ? `: ${r.error.message}` : ''}`)
  }
}
