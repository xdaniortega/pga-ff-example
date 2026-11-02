// F5: the staged chapter-5 runner with fake hold, prompt and rows (no simulator).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RaceStager, type StageDeps } from '../stages.ts'

function fake(o: Partial<StageDeps> = {}, log: string[] = []): { d: StageDeps; log: string[] } {
  const d: StageDeps = {
    arm: async () => (log.push('arm'), { ok: true }),
    waitHeld: async () => (log.push('waitHeld'), { ok: true, block: 12 }),
    release: async () => void log.push('release'),
    showStage1: async (b) => void log.push(`stage1:${b}`),
    sendRound2Extras: async () => void log.push('extras'),
    sleep: async (ms) => void log.push(`sleep:${ms}`),
    showStage2: async (v) => void log.push(`stage2:${v}`),
    hasStage3: () => true,
    showStage3: async () => void log.push('stage3'),
    fallbackNote: (r) => void log.push(`note:${r}`),
    ...o,
  }
  return { d, log }
}

test('F5 staged, hands-off: stage 1 with the simulator held, extras, a 1 s wait, resume; then stage 2 on visibility; stage 3 at the end; no prompt', async () => {
  const { d, log } = fake()
  const s = new RaceStager(d)
  await s.beforeOpen()
  await s.afterMineSent(12)
  assert.deepEqual(log, ['arm', 'waitHeld', 'stage1:12', 'extras', 'sleep:1000', 'release'])
  s.onVisible(777)
  s.onVisible(888) // once
  await s.finish()
  assert.deepEqual(log.slice(6), ['stage2:777', 'sleep:1000', 'stage3'])
  assert.equal(s.staged, true)
})

test('F5 staged on a --pause terminal: the Enter prompts run in order, stage 1 before the first, the resume only after it, stage 3 after the second', async () => {
  const { d, log } = fake({
    prompt: async (b) => void log.push(`enter1:${b}`),
    promptStage3: async () => void log.push('enter2'),
  })
  const s = new RaceStager(d)
  await s.beforeOpen()
  await s.afterMineSent(12)
  assert.deepEqual(log, ['arm', 'waitHeld', 'stage1:12', 'extras', 'enter1:12', 'release'])
  s.onVisible(5)
  await s.finish()
  assert.deepEqual(log.slice(6), ['stage2:5', 'enter2', 'stage3'])
})

test('F5 a refused hold, a missing RPC or a hold on another block: one NOTE, no stages (the unstaged flow), nothing left held', async () => {
  for (const [name, o, expectRelease] of [
    ['refused', { arm: async () => ({ ok: false as const, reason: 'paused by demo-9' }) }, false],
    ['timeout', { waitHeld: async () => ({ ok: false as const, reason: 'no block' }) }, true],
    ['other block', { waitHeld: async () => ({ ok: true as const, block: 99 }) }, true],
  ] as const) {
    const { d, log } = fake(o)
    const s = new RaceStager(d)
    await s.beforeOpen()
    await s.afterMineSent(12)
    s.onVisible(1)
    await s.finish()
    assert.equal(log.filter((l) => l.startsWith('note:')).length, 1, name)
    assert.ok(!log.some((l) => /^stage/.test(l) || l === 'extras'), name)
    assert.equal(s.staged, false, name)
    assert.equal(log.includes('release'), expectRelease, `${name}: ${log}`)
  }
})

test('F5 the simulator is resumed when showing stage 1 or the prompt throws; stage 3 is skipped when there is no block M', async () => {
  const { d, log } = fake({ showStage1: async () => { throw new Error('boom') } })
  const s = new RaceStager(d)
  await s.beforeOpen()
  await assert.rejects(s.afterMineSent(12), /boom/)
  assert.ok(log.includes('release'))
  const p = fake({ prompt: async () => { throw new Error('prompt boom') } })
  const ps = new RaceStager(p.d)
  await ps.beforeOpen()
  await assert.rejects(ps.afterMineSent(12), /prompt boom/)
  assert.ok(p.log.includes('release'), 'released after the prompt threw')
  const f = fake({ hasStage3: () => false })
  const t = new RaceStager(f.d)
  await t.beforeOpen()
  await t.afterMineSent(12)
  await t.finish() // stage 2 is shown with no visible time (the demo falls back to the trial's), stage 3 is not
  assert.ok(f.log.includes('stage2:undefined') && !f.log.includes('stage3'))
})

test('F6 RaceStager.drain resolves after a slow stage 2 and before finish shows stage 3', async () => {
  const log: string[] = []
  const { d } = fake({
    showStage2: async () => {
      log.push('stage2:start')
      await new Promise((r) => setTimeout(r, 40))
      log.push('stage2:end')
    },
    showStage3: async () => void log.push('stage3'),
  }, log)
  const s = new RaceStager(d)
  await s.beforeOpen()
  await s.afterMineSent(12)
  s.onVisible(1)
  await s.drain()
  log.push('drained')
  assert.deepEqual(log.slice(-3), ['stage2:start', 'stage2:end', 'drained'])
  assert.ok(!log.includes('stage3'))
  await s.finish()
  assert.equal(log.at(-1), 'stage3')
})
