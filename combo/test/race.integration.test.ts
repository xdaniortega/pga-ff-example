// C1/C2: `npm run race -- --local --scenario s1|s2|s3|matrix` as a real process against an in-process stack (slow preset, alternate
// ports, a short ticket round, feed auth ON: both bots buy real tickets with their own in-memory keys).
// PGA stack: exit 0, mine rank 1 and the rival rank 2 in the same round, winner(id) = mine.
// FIFO stack: the rival (sent first) wins, so the runner exits 1 and prints FAIL: it can fail (never PASS).
// Third stack (ticket round 20s): S2 (mine in an earlier round than the polling rival), S3, and `matrix --trials 2`, which
// takes longer than one ticket round and so must renew the bots' tickets (no rebuy) to keep its connections.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, test } from 'node:test'
import { createPublicClient, http, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ANVIL_ACCOUNT_MAP, anvilDevKey, localPreset } from '../../shared/config.ts'
import { raceAbi } from '../race.ts'
import { buildContracts } from '../../sim/build.ts'
import { startOrAttach, type Stack } from '../../sim/index.ts'

function envFor(ports: { rpc: string; feed: string; anvil: string }, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, BLOCK_PUBLISH_DELAY_MS: '100', SIM_ORDER: 'pga', FEED_AUTH: 'on', TICKET_ROUND_SECONDS: '20',
    SIM_RPC_PORT: ports.rpc, SIM_FEED_PORT: ports.feed, SIM_ANVIL_PORT: ports.anvil, ...extra,
    ENV_FILE: '/nonexistent-env-file', // never read the repo .env
  }
  delete env.PRIVATE_KEY
  delete env.FEED_API_KEY
  delete env.MY_ADDRESSES
  return env
}

const pgaEnv = envFor({ rpc: '53547', feed: '53642', anvil: '53545' })
const fifoEnv = envFor({ rpc: '53647', feed: '53742', anvil: '53645' }, { SIM_ORDER: 'fifo' })
const mxEnv = envFor({ rpc: '53847', feed: '53942', anvil: '53845' }, { TICKET_ROUND_SECONDS: '20' })
const stacks: Stack[] = []

async function start(env: NodeJS.ProcessEnv) {
  const preset = localPreset('slow', env)
  stacks.push(await startOrAttach(preset.local!, preset.chainId, { banner: false, env }))
}

before(async () => {
  buildContracts()
  await start(pgaEnv)
  await start(fifoEnv)
  await start(mxEnv)
}, { timeout: 120_000 })
after(async () => {
  for (const s of stacks) await s.stop()
})

function runRace(env: NodeJS.ProcessEnv, args: string[], killAfterMs = 170_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'combo/scenarios.ts', '--local', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

/** The race CLI prints key HASHES (0x + 64 hex) and tx hashes; a raw feed key is 64 hex with no 0x. None may appear. */
function assertNoRawKey(out: string) {
  const bare = out.match(/(?<![0-9a-zA-Fx])[0-9a-f]{64}(?![0-9a-fA-F])/g)
  assert.equal(bare, null, `a bare 64-hex token (a raw feed key?) was printed: ${bare?.[0]?.slice(0, 6)}...`)
  assert.match(out, /feed key hash 0x[0-9a-f]{64}/, 'the check is meaningful: hashes with 0x are printed')
}

const mineAddr = privateKeyToAccount(anvilDevKey(ANVIL_ACCOUNT_MAP.raceMine)).address
const rivalAddr = privateKeyToAccount(anvilDevKey(ANVIL_ACCOUNT_MAP.raceRival)).address

test('race s1 on the PGA stack: exit 0, mine rank 1 and the rival rank 2 in the same round (block and pga_round), winner(id) = mine', { timeout: 180_000 }, async () => {
  const r = await runRace(pgaEnv, ['--scenario', 's1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^Scenario s1: PASS - /m)
  // `open` is sent right after a block starts (round 1), so both feed claims land in round 2 of that block, behind `open`.
  const m = r.out.match(/block (\d+) round (\d+): mine idx (\d+) \(rank 1\), rival idx (\d+) \(rank 2\)/)
  assert.ok(m, r.out)
  assert.equal(Number(m[4]), Number(m[3]) + 1, 'rival is right behind mine in the same round')
  assert.equal(m[2], '2', 'the claims are in round 2 of the block that holds open')
  assert.match(r.out, /^NOTE: same round → higher tip wins/m)
  assert.match(r.out, /rival sent at t0\+\d+ms \(tip 0\.001 gwei\)/)
  assert.match(r.out, /mine sent at t0\+\d+ms \(tip 0\.1 gwei\)/)
  const sent = (n: string) => Number(r.out.match(new RegExp(`${n} sent at t0\\+(\\d+)ms`))![1])
  assert.ok(sent('mine') > sent('rival'), 'mine fired later than the rival')
  assert.match(r.out, /\[sequencer\] round \d+: waiting list, in arrival order: rival \(queue priority 0\.001 gwei\), mine \(queue priority 0\.1 gwei\)/)
  assertNoRawKey(r.out)

  // The printed cast command, checked through viem (the same call): winner(id) is mine's address.
  const cast = r.out.match(/cast call (0x[0-9a-fA-F]{40}) "winner\(uint256\)" (\d+) --rpc-url (\S+)/)
  assert.ok(cast, r.out)
  const read = createPublicClient({ transport: http(cast[3]!.replace('8547', '53547')) })
  const winner = await read.readContract({ address: cast[1] as Address, abi: raceAbi, functionName: 'winner', args: [BigInt(cast[2]!)] })
  assert.equal(winner, mineAddr)
  const rank = (who: Address) => read.readContract({ address: cast[1] as Address, abi: raceAbi, functionName: 'rankOf', args: [BigInt(cast[2]!), who] })
  assert.equal(await rank(mineAddr), 1n)
  assert.equal(await rank(rivalAddr), 2n)
})

test('race s1 against a --fifo stack must FAIL (exit 1): the rival, sent first, wins; the runner can fail', { timeout: 180_000 }, async () => {
  const r = await runRace(fifoEnv, ['--scenario', 's1'])
  assert.equal(r.code, 1, r.out)
  assert.doesNotMatch(r.out, /^Scenario s1: PASS/m, 'FIFO must never PASS')
  assert.match(r.out, /^Scenario s1: FAIL - rival ranks first/m)
  assert.match(r.out, /rival idx \d+ \(rank 1\), mine idx \d+ \(rank 2\)/)
  assert.match(r.out, /equal tips|arrival order decided|not tip order/)
  assert.doesNotMatch(r.out, /same round → higher tip wins/)
})

test('race s2: mine (feed, low tip) is rank 1 in an earlier round; the rival (polling, high tip) landed in a LATER round; exit 0', { timeout: 200_000 }, async () => {
  const r = await runRace(mxEnv, ['--scenario', 's2'], 190_000)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^Scenario s2: PASS - mine ranks first: it landed in block \d+ round 2, the rival \(polling the RPC every 250ms\) in a LATER round, block \d+ round \d\./m)
  const m = r.out.match(/open in block (\d+); mine landed in block (\d+) round (\d), rival in block (\d+) round (\d)/)
  assert.ok(m, r.out)
  const [open, mine, rival] = [Number(m[1]), Number(m[2]), Number(m[4])]
  // `open` is sent right after a block starts: it is in round 1, mine's feed claim in round 2 of the SAME block (deterministic),
  // and the poller sees the block only once it is final, so it lands in a later block.
  assert.equal(open, mine, 'mine claims in the block that holds open')
  assert.equal(m[3], '2', "mine is in round 2 of that block")
  assert.ok(mine < rival, `mine ${mine} < rival ${rival}`)
  assert.match(r.out, /mine idx \d+ \(rank 1\); block \d+ round \d: rival idx \d+ \(rank 2\)/)
  assert.match(r.out, /^NOTE: different rounds → the earlier round wins, whatever the tips/m)
  assert.match(r.out, /rival \(poll\) t0\+\d+ms/)
  const vis = Number(r.out.match(/visible on RPC by t0\+(-?\d+)ms/)![1])
  const polled = Number(r.out.match(/rival \(poll\) t0\+(-?\d+)ms/)![1])
  assert.ok(vis <= polled, `visible by ${vis} must be at or before the rival's sighting ${polled}`)
  assert.match(r.out, /buying a Fast Feed ticket for mine/)
  assert.doesNotMatch(r.out, /both bots buy/)
  assert.match(r.out, /visible on RPC by t0\+\d+ms \(probe every 25ms\)/)
  assert.match(r.out, /rival sent at t0\+\d+ms \(tip 0\.1 gwei\)/)
  assert.match(r.out, /mine sent at t0\+\d+ms \(tip 0\.001 gwei\)/)
  assert.match(r.out, /next block boundary plus the publish delay \(visible by t0\+\d+ms\)/)
  assert.doesNotMatch(r.out, /NEXT round/)
  assertNoRawKey(r.out)
  const cast = r.out.match(/cast call (0x[0-9a-fA-F]{40}) "winner\(uint256\)" (\d+)/)!
  const read = createPublicClient({ transport: http('http://127.0.0.1:53847') })
  assert.equal(await read.readContract({ address: cast[1] as Address, abi: raceAbi, functionName: 'winner', args: [BigInt(cast[2]!)] }), mineAddr)
})

test('race s3: mine (feed, tip 0.2) beats the polling rival (tip 0.1): exit 0, information AND tip', { timeout: 200_000 }, async () => {
  const r = await runRace(mxEnv, ['--scenario', 's3'], 190_000)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^Scenario s3: PASS - mine ranks first: .*LATER round.*\(both\)/m)
  assert.match(r.out, /tip 0\.2 gwei/)
  assert.match(r.out, /(buying a Fast Feed ticket for mine|reusing the tickets)/)
  assert.doesNotMatch(r.out, /both bots buy/)
  assertNoRawKey(r.out)
})

test('race matrix --trials 2: one table, S1/S2/S3 at 2/2, the takeaway; the run outlasts a ticket round and renews instead of rebuying', { timeout: 420_000 }, async () => {
  const t0 = Date.now()
  const r = await runRace(mxEnv, ['--scenario', 'matrix', '--trials', '2'], 400_000)
  const secs = (Date.now() - t0) / 1000
  assert.equal(r.code, 0, r.out)
  const tableAt = r.out.split('\n').findIndex((l) => /^\s*Scen +Mine +Rival +Wins +Deciding effect$/.test(l))
  assert.ok(tableAt >= 0, r.out)
  assert.equal(r.out.split('\n').filter((l) => /^\s*Scen +Mine/.test(l)).length, 1, 'ONE table')
  const rows = r.out.split('\n').slice(tableAt + 2, tableAt + 5).map((l) => l.trim())
  assert.match(rows[0]!, /^S1 +feed \+50ms, tip 0\.1 +feed, tip 0\.001 +2\/2 +tip$/)
  assert.match(rows[1]!, /^S2 +feed, tip 0\.001 +poll 250ms, tip 0\.1 +2\/2 +information$/)
  assert.match(rows[2]!, /^S3 +feed, tip 0\.2 +poll 250ms, tip 0\.1 +2\/2 +both$/)
  const end = r.out.split('\n').findIndex((l) => /^PASS: mine won every trial/.test(l))
  assert.ok(end > tableAt, r.out)
  for (const l of r.out.split('\n').slice(tableAt - 1, end + 1)) assert.ok(l.length <= 80, `matrix output line too wide (${l.length}): ${l}`)
  assert.match(r.out, /Takeaway: information gets you into the round; the tip wins the round\./)
  // The run is longer than one 20s ticket round (6 trials, several seconds each), so it crossed at least one rollover.
  assert.ok(secs > 20, `the matrix took ${secs}s: it must outlast a 20s ticket round for this test to mean anything`)
  assert.match(r.out, /==> renewing both bots' tickets for round \d+ \(the docs' every-round renewal\)/)
  // Tickets are normally bought once and later rounds renewed. Under a loaded parallel suite a slow trial can correctly fall
  // back to a rebuy (renewDecision's fallback), so allow at most two purchases; the renew path itself is pinned by the
  // renewDecision unit tests, and the renew line above plus the no-1008 / no-FAIL checks below stay strict.
  assert.ok((r.out.match(/both bots buy 1 ticket in round/g) ?? []).length <= 2, 'tickets were bought at most twice; later rounds were renewed, not rebought')
  assert.doesNotMatch(r.out, /FAIL \(error\)|closed 1008|authentication expired/)
  assertNoRawKey(r.out)
})
