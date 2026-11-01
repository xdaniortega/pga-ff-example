// Unit tests: key hashing, key file handling, access rule, error formatter, auth header, time override.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeErrorResult } from 'viem'
import { localParams } from '../../shared/config.ts'
import { erc20Abi, ticketsAbi } from '../client/abi.ts'
import { accessFor, activeTickets, pendingTickets } from '../client/access.ts'
import { apiKeyHash, generateKey, writeEnvKey } from '../client/key.ts'
import { checkGrandfather, explainRevert, formatRevertData, formatTicketsError, purchaseRoomDecision, UserError, type RoundInfo } from '../client/tickets.ts'
import { resolveBin } from '../../sim/chain.ts'
import { bannerLines, ticketSummaryLine } from '../../sim/banner.ts'
import { bearerKey } from '../mock/feed.ts'
import { withNow } from '../../sim/rpc.ts'

test('apiKeyHash: known vector and cast keccak agree (UTF-8 bytes of the string)', () => {
  assert.equal(apiKeyHash('test-key-not-secret'), '0xff23e3b3d9c65af9030f163ce1398621b52df61ac4842293012410a515e455b4')
  const cast = resolveBin('cast')
  for (const input of ['test-key-not-secret', generateKey()]) {
    const expected = execFileSync(cast, ['keccak', input], { encoding: 'utf8' }).trim()
    assert.equal(apiKeyHash(input), expected)
  }
})

test('generateKey: 64 hex chars, no 0x prefix, random', () => {
  const a = generateKey()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, generateKey())
})

test('writeEnvKey: creates, refuses to replace without force, preserves other lines', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'envtest-')), '.env')
  writeFileSync(f, 'PRIVATE_KEY=abc\n# a comment\nOTHER=1\n')
  assert.equal(writeEnvKey(f, 'k1', false), 'created')
  assert.equal(readFileSync(f, 'utf8'), 'PRIVATE_KEY=abc\n# a comment\nOTHER=1\nFEED_API_KEY=k1\n')
  assert.equal(writeEnvKey(f, 'k2', false), 'exists')
  assert.match(readFileSync(f, 'utf8'), /FEED_API_KEY=k1/)
  assert.equal(writeEnvKey(f, 'k2', true), 'replaced')
  assert.equal(readFileSync(f, 'utf8'), 'PRIVATE_KEY=abc\n# a comment\nOTHER=1\nFEED_API_KEY=k2\n')
  const g = join(mkdtempSync(join(tmpdir(), 'envtest-')), '.env')
  assert.equal(writeEnvKey(g, 'k', false), 'created') // no file yet
})

test('accessFor: tickets bought in round N are inactive in N, active in N+1 only, inactive in N+2; counts are summed per round', () => {
  assert.deepEqual(accessFor([], 3n), { active: false, reason: 'unknown-key' })
  const bought = [{ round: 3n, numTickets: 1n }]
  assert.deepEqual(accessFor(bought, 3n), { active: false, reason: 'not-yet-active', purchaseRound: 3n, pending: 1n })
  assert.deepEqual(accessFor(bought, 4n), { active: true, tickets: 1n })
  assert.deepEqual(accessFor(bought, 5n), { active: false, reason: 'expired', lastRound: 3n })
  // Several purchases in the same round add up; other rounds do not count.
  const many = [
    { round: 3n, numTickets: 2n },
    { round: 3n, numTickets: 1n },
    { round: 4n, numTickets: 5n },
  ]
  assert.equal(activeTickets(many, 4n), 3n)
  assert.equal(activeTickets(many, 5n), 5n)
  assert.equal(activeTickets(many, 6n), 0n)
  assert.equal(pendingTickets(many, 4n), 5n)
  // A key with a ticket in both rounds is active in both and keeps its connection across the rollover.
  assert.deepEqual(accessFor(many, 5n), { active: true, tickets: 5n })
  // Round 0 has no previous round.
  assert.deepEqual(accessFor([{ round: 0n, numTickets: 1n }], 0n), { active: false, reason: 'not-yet-active', purchaseRound: 0n, pending: 1n })
})

test('bearerKey: accepts "Bearer <key>", rejects the rest', () => {
  assert.equal(bearerKey('Bearer abc123'), 'abc123')
  for (const bad of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer a b', 'abc']) assert.equal(bearerKey(bad), undefined)
})

test('withNow: reads at latest get wall-clock block.timestamp; historical reads and caller overrides are kept', () => {
  assert.deepEqual(withNow([{ to: '0x1' }], 100), [{ to: '0x1' }, 'latest', null, { time: '0x64' }])
  assert.deepEqual(withNow([{ to: '0x1' }, 'pending', { a: 1 }], 100)[3], { time: '0x64' })
  assert.deepEqual(withNow([{ to: '0x1' }, 'latest', null, { time: '0x1' }], 100)[3], { time: '0x1' })
  const hist = [{ to: '0x1' }, '0x5']
  assert.deepEqual(withNow(hist, 100), hist)
})

test('explainRevert: every Tickets custom error has a readable message', () => {
  assert.equal(
    explainRevert('RoundNumberMismatch', [3n, 4n]),
    'Round changed (expected 3, now 4): the round rolled over between read and purchase; rerun the command.',
  )
  assert.match(explainRevert('IncorrectTicketPrice', [1_000_000n, 2_000_000n])!, /Ticket price changed \(expected 1 TEST, now 2 TEST\)/)
  assert.match(explainRevert('ZeroTicketsRequested')!, /0 tickets/)
  assert.match(explainRevert('MaxTicketsSold')!, /sold out/)
  assert.match(explainRevert('InsufficientTokenBalance', [0n, 1_500_000n])!, /deposited 0 TEST, needed 1.5 TEST/)
  assert.match(explainRevert('NotEnoughGrandfatheredTickets', [1n, 2n])!, /hold 1 grandfathered .* asked for 2/)
  assert.match(explainRevert('BeforeFirstRoundStart')!, /first ticket round/)
  assert.equal(explainRevert('SomethingElse'), undefined)
})

test('formatRevertData: decodes raw revert data through the ABI for each custom error', () => {
  const cases: [string, unknown[], RegExp][] = [
    ['RoundNumberMismatch', [3n, 4n], /expected 3, now 4/],
    ['IncorrectTicketPrice', [1n, 2n], /Ticket price changed/],
    ['ZeroTicketsRequested', [], /0 tickets/],
    ['MaxTicketsSold', [], /sold out/],
    ['InsufficientTokenBalance', [5n, 9n], /Not enough deposited TEST/],
    ['NotEnoughGrandfatheredTickets', [0n, 1n], /Grandfather period/],
    ['BeforeFirstRoundStart', [], /not started/],
  ]
  for (const [errorName, args, re] of cases) {
    const data = encodeErrorResult({ abi: ticketsAbi, errorName: errorName as never, args: args as never })
    assert.match(formatRevertData(data)!, re, errorName)
  }
  const allowance = encodeErrorResult({ abi: erc20Abi, errorName: 'ERC20InsufficientAllowance', args: ['0x0000000000000000000000000000000000000001', 0n, 1n] })
  assert.match(formatRevertData(allowance)!, /not approved/)
  assert.equal(formatRevertData('0xdeadbeef'), undefined)
})

test('formatTicketsError: UserError and plain errors give one line, never a stack', () => {
  assert.equal(formatTicketsError(new UserError('nope')), 'nope')
  assert.equal(formatTicketsError(new Error('boom')), 'boom')
  assert.equal(formatTicketsError('str'), 'str')
})

test('banner reports every accelerated ticket parameter next to its Arbitrum One value', () => {
  const p = localParams('slow', { TICKET_ROUND_SECONDS: '9', FEED_AUTH: 'off' })
  assert.equal(
    ticketSummaryLine(localParams('slow', {})),
    'LOCAL: ticket round = 30s (Arbitrum One: 24h), grandfather = 0 (Arbitrum One: ~0.5)',
  )
  const text = bannerLines(p).join('\n')
  assert.match(text, /ticket round = 9s \(Arbitrum One: 24h\)/)
  assert.match(text, /target 100, max 200 {3}\(Arbitrum One: 100, 200\)/)
  assert.match(text, /minimum ticket price = 1000000 units = 1 TEST.*17000000 units = \$17/)
  assert.match(text, /price update fraction = 144 {3}\(Arbitrum One: 144\)/)
  assert.match(text, /Fast Feed auth: OFF/)
  assert.match(bannerLines(localParams('slow', {})).join('\n'), /Fast Feed auth: ON/)
})

test('checkGrandfather: applies only when round > 0 (as Tickets.sol), with a one-line UserError', () => {
  const base: RoundInfo = { round: 0n, price: 1n, roundEnd: 200n, grandfatherEnd: 150n, grandfatherCount: 0n, now: 100 }
  // Round 0: no previous-round tickets exist, so the contract applies no grandfather rule.
  assert.doesNotThrow(() => checkGrandfather(base, 1))
  // Round 1, inside the period, not enough grandfathered tickets: clean error.
  assert.throws(() => checkGrandfather({ ...base, round: 1n }, 1), (e) => e instanceof UserError && !e.message.includes('\n') && /grandfather period/.test(e.message))
  // Enough grandfathered tickets, or period over: fine.
  assert.doesNotThrow(() => checkGrandfather({ ...base, round: 1n, grandfatherCount: 1n }, 1))
  assert.doesNotThrow(() => checkGrandfather({ ...base, round: 1n, now: 150 }, 1))
})

test('InsufficientTokenBalance advice depends on the context (purchase vs withdraw)', () => {
  assert.match(explainRevert('InsufficientTokenBalance', [1_000_000n, 2_000_000n], 'purchase')!, /deposit more/)
  const w = explainRevert('InsufficientTokenBalance', [1_000_000n, 2_000_000n], 'withdraw')!
  assert.match(w, /You only have 1 TEST deposited/)
  assert.doesNotMatch(w, /deposit more/)
})

test('purchaseRoomDecision: waits when less than the purchase landing time is left, B-aware (min 5s)', () => {
  assert.deepEqual(purchaseRoomDecision(30, 2000), { wait: false, minLeftS: 5, waitS: 31 })
  assert.equal(purchaseRoomDecision(4, 2000).wait, true)
  assert.equal(purchaseRoomDecision(5, 2000).wait, false)
  assert.equal(purchaseRoomDecision(-3, 2000).waitS, 1)
  // --slowmo B = 25s: one purchase needs ~37.5s -> 38s
  assert.equal(purchaseRoomDecision(30, 25_000).minLeftS, 38)
  assert.equal(purchaseRoomDecision(30, 25_000).wait, true)
  assert.equal(purchaseRoomDecision(40, 25_000).wait, false)
  assert.equal(purchaseRoomDecision(10, 250).minLeftS, 5)
})

test('E2: a receipt wait that times out while the demo holds the simulator paused is waited out, not failed; without a hold it still fails', { timeout: 20_000 }, async () => {
  const { waitReceipt } = await import('../client/tickets.ts')
  const { freezeChainClock, setChainClock, resetChainClock } = await import('../../shared/clock.ts')
  resetChainClock()
  let mined = false
  const pub = {
    waitForTransactionReceipt: async (o: { timeout: number }) => {
      const end = Date.now() + o.timeout
      while (!mined) {
        if (Date.now() > end) throw Object.assign(new Error('Timed out while waiting for transaction'), { name: 'WaitForTransactionReceiptTimeoutError' })
        await new Promise((r) => setTimeout(r, 10))
      }
      return { status: 'success' }
    },
  }
  const ctx = { pub: pub as never, receiptTimeoutMs: 100 }
  await assert.rejects(waitReceipt(ctx, '0x01'), /Timed out/, 'no hold: the timeout fails as before')
  freezeChainClock(Date.now()) // the demo holds the simulator paused: nothing is mined for a while
  const p = waitReceipt(ctx, '0x02')
  await new Promise((r) => setTimeout(r, 450)) // four times the receipt timeout
  mined = true
  setChainClock(Date.now()) // resumed
  assert.deepEqual(await p, { status: 'success' })
  resetChainClock()
})
