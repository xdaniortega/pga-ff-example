// E2: the client chain clock: frozen while the demo holds the simulator paused, and the thaw fallback when the resume failed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chainNowMs, freezeChainClock, heldPausedMs, resetChainClock, setChainClock, thawChainClock } from '../clock.ts'

test('freeze stops the client chain clock; setChainClock resumes it from the simulator value and counts the hold', async () => {
  resetChainClock()
  const t = Date.now() + 5000
  freezeChainClock(t)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(chainNowMs(), t)
  assert.ok(heldPausedMs() >= 50)
  setChainClock(t + 1)
  assert.ok(chainNowMs() >= t + 1 && chainNowMs() < t + 500)
  assert.ok(heldPausedMs() >= 50, 'the hold stays counted after the thaw')
  resetChainClock()
})

test('thawChainClock: when neither the resume nor the clock read worked the clock runs again from the last offset instead of staying frozen', async () => {
  resetChainClock()
  setChainClock(Date.now() + 10_000) // offset +10 s
  freezeChainClock(Date.now() + 10_000)
  const frozen = chainNowMs()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(chainNowMs(), frozen)
  thawChainClock()
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(chainNowMs() > frozen + 50, 'running again')
  assert.ok(Math.abs(chainNowMs() - (Date.now() + 10_000)) < 100, 'the last offset is kept')
  resetChainClock()
})
