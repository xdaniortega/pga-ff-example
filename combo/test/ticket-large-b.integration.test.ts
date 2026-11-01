// C5: a large block time (B = 8000ms) WITHOUT TICKET_ROUND_SECONDS: the ticket round adapts to 4 x B = 32s, a purchase
// (visible only after its block closes) activates, renews and is accepted by the feed. Asserts the adapted round, the
// NOTE, and an accepted connection, never durations. Own ports, feed auth ON.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { ANVIL_ACCOUNT_MAP, localPreset, resolvePreset } from '../../shared/config.ts'
import { connectFeed, type FeedClient } from '../../fast-feed/client/client.ts'
import { bannerLines } from '../../sim/banner.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'
import { buyTickets, newIdentity, renewTickets, ticketsUsable } from '../race.ts'

const env: NodeJS.ProcessEnv = {
  ...process.env,
  SIM_BLOCK_MS: '8000',
  BLOCK_PUBLISH_DELAY_MS: '100',
  SIM_ORDER: 'pga',
  FEED_AUTH: 'on',
  SIM_RPC_PORT: '45547',
  SIM_FEED_PORT: '45642',
  SIM_ANVIL_PORT: '45545',
  ENV_FILE: '/nonexistent-env-file',
}
delete env.TICKET_ROUND_SECONDS
delete env.PRIVATE_KEY
const preset = localPreset('slow', env)
let stack: Stack | undefined
let client: FeedClient | undefined

before(async () => {
  buildContracts()
  stack = await startOrAttach(preset.local!, preset.chainId, { banner: false })
}, { timeout: 90_000 })

after(async () => {
  client?.close()
  await stack?.stop()
})

test('B = 8000ms: 32s ticket round with the NOTE; a purchase activates, is renewed, and the feed accepts the key', { timeout: 280_000 }, async () => {
  assert.equal(stack!.params.tickets.roundSeconds, 32)
  const lines = bannerLines(stack!.params)
  assert.ok(lines.some((l) => l.includes('ticket round = 32s (Arbitrum One: 24h)')))
  assert.equal(lines.filter((l) => l.includes('ticket round adapted from 30s to 32s')).length, 1)
  const info = await fetch(`http://127.0.0.1:${env.SIM_RPC_PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sim_info', params: [] }) })
  const body = (await info.json()) as { result: { tickets?: { roundSeconds?: number } } }
  assert.equal(body.result.tickets?.roundSeconds, 32, 'sim_info always carries tickets.roundSeconds')

  const p = await resolvePreset(preset)
  const mine = newIdentity('mine', ANVIL_ACCOUNT_MAP.raceMine)
  const session = await buyTickets(p, [mine]) // returns once the ticket is active
  assert.ok(ticketsUsable(session, Date.now(), 0), 'the ticket is active after the purchase')
  assert.equal(session.activeUntil - session.activeFrom, 32_000)

  client = connectFeed({ url: p.feedUrl, apiKey: mine.key, onMessage: () => {} })
  await client.ready // rejects (HTTP 401/429) when the ticket is not active

  // Renew for the next round: right after activation almost the whole ticket round is left, so the renewal must land.
  const renewed = await renewTickets(p, [mine], session)
  assert.ok(renewed, 'the renewal lands')
  assert.equal(renewed.activeUntil, session.activeUntil + 32_000)
})
