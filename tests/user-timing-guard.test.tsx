import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

import { afterEach, describe, expect, it } from 'vitest'

import { dropUserTimingEntries, startUserTimingGuard, userTimingEntryCount } from '../src/user-timing-guard.js'

// React's development build - the one Ink loads whenever NODE_ENV is not
// "production" - writes a performance.measure() entry per render into Node's
// user-timing buffer, and Node never trims that buffer, so a long-lived Ink UI
// grows without bound until V8 aborts with "JavaScript heap out of memory".
// The launcher defaults NODE_ENV to "production"; the guard covers an explicit
// NODE_ENV=development by dropping the entries on a timer.

type ProbeReport = { nodeEnv: string | null; renders: number; entriesWhileRunning: number; entriesAfterStop: number }

function runProbe(nodeEnv: string, mode: 'guard' | 'plain' = 'plain', durationMs = 500): ProbeReport {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/ink-user-timing-probe.tsx', mode, String(durationMs)], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: nodeEnv },
  })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as ProbeReport
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

afterEach(() => {
  dropUserTimingEntries()
})

describe('user-timing guard', () => {
  it('counts and drops marks and measures', () => {
    performance.mark('codeburn-test-mark')
    performance.measure('codeburn-test-measure')
    expect(userTimingEntryCount()).toBeGreaterThanOrEqual(2)

    const dropped = dropUserTimingEntries()

    expect(dropped).toBeGreaterThanOrEqual(2)
    expect(userTimingEntryCount()).toBe(0)
  })

  it('stops dropping once stopped', async () => {
    const stop = startUserTimingGuard(5)
    stop()
    performance.measure('codeburn-after-stop')
    await sleep(25)
    expect(userTimingEntryCount()).toBe(1)
  })

  describe('against a real Ink render loop', () => {
    it('React development build leaves an entry backlog behind (the premise)', () => {
      const plain = runProbe('development')
      expect(plain.renders).toBeGreaterThan(1)
      expect(plain.entriesWhileRunning).toBeGreaterThan(plain.renders)
      // Nothing drops them without the guard.
      expect(plain.entriesAfterStop).toBe(plain.entriesWhileRunning)
    })

    it('React production build (the launcher default) records nothing', () => {
      const production = runProbe('production')
      expect(production.renders).toBeGreaterThan(1)
      expect(production.entriesWhileRunning).toBe(0)
    })

    it('the guard keeps the backlog bounded while rendering and empties it on stop', () => {
      const plain = runProbe('development')
      const guarded = runProbe('development', 'guard')
      expect(guarded.renders).toBeGreaterThan(1)
      // At most one 10ms tick's worth of entries is ever pending.
      expect(guarded.entriesWhileRunning).toBeLessThan(plain.entriesWhileRunning / 2)
      expect(guarded.entriesAfterStop).toBe(0)
    })
  })
})
