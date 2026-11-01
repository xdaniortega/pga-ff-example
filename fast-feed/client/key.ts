// Feed API key: generation (`npm run key:new`) and the ONE hashing rule used everywhere.
//
// HASHING RULE: apiKeyHash(key) = keccak256 of the UTF-8 bytes of the key string, exactly as it is
// sent in `Authorization: Bearer <key>`. The same function is used by key:new, tickets:buy/status and
// the mock feed. The docs say the endpoint "hashes [the raw key] with Keccak-256"
// (https://docs.arbitrum.io/how-arbitrum-works/priority-gas-auction/use-fast-feed): the string you
// present is the preimage. Keys generated here are 64 hex characters WITHOUT a 0x prefix, so
// `cast keccak <key>` (which hashes a non-0x string as text) gives the same value; a 0x-prefixed key
// would be hashed by cast as raw bytes, which is a different preimage. We never do that.
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { keccak256, stringToBytes, type Hex } from 'viem'
import { envFilePath } from '../../shared/config.ts'
import { error, note, plain, step } from '../../shared/narrate.ts'

export function apiKeyHash(key: string): Hex {
  return keccak256(stringToBytes(key))
}

/** 32 random bytes as 64 hex chars (no 0x prefix, see the hashing rule above). */
export function generateKey(): string {
  return randomBytes(32).toString('hex')
}

export type EnvWrite = 'created' | 'replaced' | 'exists'

/** Set FEED_API_KEY in an env file, preserving every other line. Refuses to replace a non-empty key without `force`. */
export function writeEnvKey(path: string, key: string, force: boolean): EnvWrite {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = text === '' ? [] : text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop() // re-added by the final newline
  const idx = lines.findIndex((l) => /^\s*FEED_API_KEY\s*=/.test(l))
  let result: EnvWrite = 'created'
  if (idx >= 0) {
    const existing = lines[idx]!.replace(/^\s*FEED_API_KEY\s*=/, '').trim()
    if (existing !== '' && !force) return 'exists'
    lines[idx] = `FEED_API_KEY=${key}`
    result = existing !== '' ? 'replaced' : 'created'
  } else {
    lines.push(`FEED_API_KEY=${key}`)
  }
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 })
  chmodSync(path, 0o600) // writeFileSync's mode only applies to new files
  return result
}

/** `npm run key:new [-- --force]` */
function main(): void {
  const force = process.argv.includes('--force')
  const key = generateKey()
  const file = envFilePath()
  const outcome = writeEnvKey(file, key, force)
  if (outcome === 'exists') {
    error(`FEED_API_KEY already exists in ${file}. Replacing it would orphan any tickets bought for it.`)
    error('Run `npm run key:new -- --force` to replace it.')
    process.exit(1)
  }
  step(`${outcome === 'replaced' ? 'replaced' : 'wrote'} FEED_API_KEY in ${file}`)
  note('It must be git-ignored; never commit it, never paste it anywhere.')
  plain(`keccak256(key) = ${apiKeyHash(key)}`)
  note('Only this hash goes on chain (as the apiKeyHash of purchaseTickets).')
  note(`The raw key stays in ${file}; the feed client presents it as "Authorization: Bearer <key>" and the feed hashes it with keccak256.`)
  note('Next: npm run tickets:buy -- --local --tickets 1')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
