import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { DAILY_CACHE_VERSION, currentTzKey, ensureCacheHydrated, saveDailyCache, toDateString, type DailyEntry } from '../src/daily-cache.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { loadPricing } from '../src/models.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'reseal-straddle-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  clearSessionCache()
  await loadPricing()
})

afterEach(async () => {
  clearSessionCache()
  await rm(tmpDir, { recursive: true, force: true })
})

const now = new Date()
const local = (daysAgo: number, h = 0, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m)
const CWD = '/work/app'

const user = (ts: Date) => JSON.stringify({
  type: 'user', sessionId: 's1', timestamp: ts.toISOString(), cwd: CWD, message: { role: 'user', content: 'refactor the parser' },
})
const assistant = (id: string, ts: Date, input: number) => JSON.stringify({
  type: 'assistant', sessionId: 's1', timestamp: ts.toISOString(), cwd: CWD,
  message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: input, output_tokens: 0 } },
})

const catCost = (d: DailyEntry | undefined) => Object.values(d?.categories ?? {}).reduce((s, c) => s + c.cost, 0)
const catTurns = (d: DailyEntry | undefined) => Object.values(d?.categories ?? {}).reduce((s, c) => s + c.turns, 0)

// One turn: user at D 23:58, m1 at 23:59 ($3), m2 at D+1 00:01 ($9).
// D = today-8, D+1 = today-7 (the first day of the settle window).
async function sealThenHydrate(sealedThroughDaysAgo: number) {
  const dir = join(tmpDir, 'projects', '-work-app')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 's1.jsonl')
  const lastCall = local(7, 0, 1)
  await writeFile(file, [
    user(local(8, 23, 58)),
    assistant('m1', local(8, 23, 59), 1_000_000),
    assistant('m2', lastCall, 3_000_000),
  ].join('\n') + '\n')
  await utimes(file, lastCall, lastCall)

  const sealedThrough = toDateString(local(sealedThroughDaysAgo))
  const firstSealDays = aggregateProjectsIntoDays(await parseAllSessions({ start: local(30), end: new Date(local(sealedThroughDaysAgo - 1).getTime() - 1) }, 'all'))
    .filter(d => d.date <= sealedThrough)
  await saveDailyCache({
    version: DAILY_CACHE_VERSION, savingsConfigHash: '', tzKey: currentTzKey(),
    lastComputedDate: sealedThrough, complete: true, watermarkTrusted: true, days: firstSealDays,
  })
  clearSessionCache()
  const c = await ensureCacheHydrated((range) => parseAllSessions(range, 'all'), aggregateProjectsIntoDays)
  const sealed = firstSealDays.filter(d => d.date === toDateString(local(8)) || d.date === toDateString(local(7)))
  const after = c.days.filter(d => d.date === toDateString(local(8)) || d.date === toDateString(local(7)))
  return { sealed, after }
}

const sum = (days: DailyEntry[], f: (d: DailyEntry) => number) => days.reduce((s, d) => s + f(d), 0)

describe('settle-window reseal of a midnight-straddling turn', () => {
  it('does not count the post-midnight part again when D+1 becomes the window start', async () => {
    const { sealed, after } = await sealThenHydrate(2)
    expect(sum(sealed, catCost)).toBeCloseTo(12, 10)
    expect(sum(after, d => d.cost)).toBeCloseTo(12, 10)
    expect(sum(after, d => d.calls)).toBe(2)
    expect(sum(after, catCost)).toBeCloseTo(12, 10)
    expect(sum(after, catTurns)).toBe(sum(sealed, catTurns))
  })

  it('still gives D+1 its part when D was sealed alone and D+1 is the first unsealed day', async () => {
    const { sealed, after } = await sealThenHydrate(8)
    expect(sum(sealed, catCost)).toBeCloseTo(3, 10)
    expect(sum(after, d => d.cost)).toBeCloseTo(12, 10)
    expect(sum(after, catCost)).toBeCloseTo(12, 10)
  })
})
