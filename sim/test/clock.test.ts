// E2: SimClock against a fake wall clock (no timers, no ports).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SimClock } from '../clock.ts'

function fake(start = 1_000_000) {
  let wall = start
  return { clock: new SimClock(() => wall), advance: (ms: number) => void (wall += ms), set: (t: number) => void (wall = t), now: () => wall }
}

test('sim time follows the wall clock while running; chain time equals it with no skip', () => {
  const { clock, advance } = fake()
  const a = clock.simNow()
  advance(500)
  assert.equal(clock.simNow(), a + 500)
  assert.equal(clock.chainNowMs(), clock.simNow())
})

test('freeze: sim and chain time stand still while paused, whatever the wall clock does', () => {
  const { clock, advance } = fake()
  advance(100)
  const t = clock.chainNowMs()
  assert.equal(clock.pause(), true)
  assert.equal(clock.pause(), false, 'pausing twice is a no-op')
  advance(600_000)
  assert.equal(clock.simNow(), t)
  assert.equal(clock.chainNowMs(), t)
  assert.equal(clock.pausedTotalMs, 600_000, 'an ongoing pause counts')
  assert.equal(clock.toWall(clock.simNow()), clock.chainNowMs() + 600_000, 'a sim instant maps to the wall instant (ongoing pause included)')
})

test('resume: time continues from the frozen value; the pause is added to the total; wall minus chain is the lag', () => {
  const { clock, advance, now } = fake()
  const t = clock.chainNowMs()
  clock.pause()
  advance(90_000)
  assert.equal(clock.resume(), 90_000)
  assert.equal(clock.chainNowMs(), t, 'the same instant as when it froze')
  advance(250)
  assert.equal(clock.chainNowMs(), t + 250)
  assert.equal(clock.pausedTotalMs, 90_000)
  assert.equal(clock.chainLagMs(), 90_000)
  assert.equal(clock.toWall(clock.simNow()), now())
  assert.equal(clock.resume(), 0, 'resume is idempotent')
})

test('skipTo is forward only and idempotent: a target already reached adds nothing', () => {
  const { clock, advance } = fake()
  const t = clock.chainNowMs()
  assert.equal(clock.skipTo(t + 20_000), 20_000)
  assert.equal(clock.chainNowMs(), t + 20_000)
  assert.equal(clock.skipTo(t + 20_000), 0, 'the same target twice')
  assert.equal(clock.skipTo(t), 0, 'a past target never moves the clock back')
  assert.equal(clock.chainNowMs(), t + 20_000)
  assert.equal(clock.skippedMs, 20_000)
  advance(1000)
  assert.equal(clock.chainNowMs(), t + 21_000, 'it keeps running from the skipped value')
  assert.equal(clock.chainLagMs(), -20_000, 'ahead of the wall clock')
  assert.equal(clock.simNow(), t + 1000, 'a skip moves chain time only, never the round schedule (sim time)')
})

test('a skip while paused moves chain time but sim time stays frozen', () => {
  const { clock, advance } = fake()
  clock.pause()
  const sim = clock.simNow()
  advance(5000)
  clock.skipTo(clock.chainNowMs() + 30_000)
  assert.equal(clock.simNow(), sim)
  assert.equal(clock.chainNowMs(), sim + 30_000)
})

test('running() resolves at once when running, on resume when paused, and on release()', async () => {
  const { clock } = fake()
  await clock.running()
  clock.pause()
  let woke = false
  const p = clock.running().then(() => (woke = true))
  await Promise.resolve()
  assert.equal(woke, false)
  clock.resume()
  await p
  assert.equal(woke, true)
  clock.pause()
  const q = clock.running()
  clock.release()
  await q // released without resuming
  assert.equal(clock.paused, true)
})

test('onPause listeners run on pause only, and can unsubscribe', () => {
  const { clock } = fake()
  let n = 0
  const off = clock.onPause(() => n++)
  clock.pause()
  clock.resume()
  clock.pause()
  assert.equal(n, 2, 'a second pause after a resume counts; a pause while paused does not')
  clock.pause()
  assert.equal(n, 2)
  off()
  clock.resume()
  clock.pause()
  assert.equal(n, 2)
})

test('property: chain time never decreases over random pause / resume / skip / wall-advance sequences', () => {
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let run = 0; run < 50; run++) {
    const { clock, advance } = fake(rnd() * 1e9)
    let prevChain = clock.chainNowMs()
    let prevSim = clock.simNow()
    for (let step = 0; step < 200; step++) {
      const r = rnd()
      if (r < 0.25) clock.pause()
      else if (r < 0.5) clock.resume()
      else if (r < 0.7) clock.skipTo(clock.chainNowMs() + Math.floor(rnd() * 100_000) - 20_000)
      else advance(Math.floor(rnd() * 5000)) // the wall clock only moves forward
      const c = clock.chainNowMs()
      const s = clock.simNow()
      assert.ok(c >= prevChain, `chain time went back: ${prevChain} -> ${c}`)
      assert.ok(s >= prevSim, `sim time went back: ${prevSim} -> ${s}`)
      prevChain = c
      prevSim = s
    }
  }
})
