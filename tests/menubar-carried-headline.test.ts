import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { DAILY_CACHE_VERSION, currentTzKey, type DailyCache, type DailyEntry } from '../src/daily-cache.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import { buildMenubarPayloadForRange, getDailyCacheConfigHash } from '../src/usage-aggregator.js'

// The adversarial-review blocker on the carry-forward PR: the daily cache held
// carried history, history.daily showed it, but the HEADLINE current.cost /
// calls / topProjects were rebuilt from the surviving-session parse alone, so
// the user-visible totals stayed truncated once session files expired. This
// test seeds a cache whose only day is carried (no session files exist at all)
// and asserts the headline reflects it.

const ROOT = join(tmpdir(), `codeburn-carried-headline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
const ENV_KEYS = ['HOME', 'CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEX_HOME'] as const
let savedEnv: Record<string, string | undefined>

function daysAgoStr(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function carriedDay(date: string): DailyEntry {
  return {
    date,
    cost: 100,
    savingsUSD: 0,
    calls: 40,
    sessions: 3,
    inputTokens: 5000,
    outputTokens: 2000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 4,
    oneShotTurns: 2,
    models: { 'Opus 4.8': { calls: 40, cost: 100, savingsUSD: 0, inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    categories: { coding: { turns: 10, cost: 100, savingsUSD: 0, editTurns: 4, oneShotTurns: 2 } },
    providers: {
      claude: {
        calls: 40, cost: 100, savingsUSD: 0, sessions: 3,
        inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0,
        projects: { 'proj-x': { cost: 100, calls: 40, savingsUSD: 0, sessions: 3, path: '/Users/gone/proj-x' } },
      },
    },
    projects: { 'proj-x': { cost: 100, calls: 40, savingsUSD: 0, sessions: 3, path: '/Users/gone/proj-x' } },
    carried: true,
  }
}

beforeAll(async () => {
  await loadPricing()
})

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  await mkdir(join(ROOT, 'home'), { recursive: true })
  await mkdir(join(ROOT, 'cache'), { recursive: true })
  process.env['HOME'] = join(ROOT, 'home')
  process.env['CODEBURN_CACHE_DIR'] = join(ROOT, 'cache')
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CLAUDE_CONFIG_DIRS']
  delete process.env['CODEX_HOME']
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (existsSync(ROOT)) await rm(ROOT, { recursive: true, force: true })
})

describe('carried history reaches the user-visible headline', () => {
  it('serves cost/calls/models/projects from carried cache days when no session files survive', async () => {
    const day = daysAgoStr(10)
    const cache: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: getDailyCacheConfigHash(),
      tzKey: currentTzKey(),
      lastComputedDate: daysAgoStr(1),
      days: [carriedDay(day)],
      complete: true,
    }
    await writeFile(join(ROOT, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`), JSON.stringify(cache), 'utf-8')

    const payload = await buildMenubarPayloadForRange(getDateRange('all'), { provider: 'all', optimize: false, timeline: false })

    // The history strip always showed the day; the regression was everything below.
    expect(payload.history.daily.some(d => d.date === day && d.cost === 100)).toBe(true)

    // Headline totals must reflect the carried day, not the (empty) live parse.
    expect(payload.current.cost).toBe(100)
    expect(payload.current.calls).toBe(40)
    expect(payload.current.sessions).toBe(3)

    // Model and project views must surface it too, with the friendly name
    // derived from the stored project path.
    expect(payload.current.topModels.some(m => m.name === 'Opus 4.8' && m.cost === 100)).toBe(true)
    const projects = payload.current.topProjects
    expect(projects.some(p => p.name === 'proj-x' && p.cost === 100 && p.sessions === 3)).toBe(true)

    // Scan-derived workflow-intelligence fields must be PROPAGATED onto the
    // cache-authoritative headline, not silently dropped by the selective
    // merge (the regression that made them dead on the default path). With no
    // surviving sessions they are the empty-scan values, but they must exist.
    expect(payload.current.workflow).toBeDefined()
    expect(payload.current.workflow?.corrections).toBe(0)
    expect(Array.isArray(payload.current.topReworkedFiles)).toBe(true)
    expect(typeof payload.current.pricingCoverage).toBe('number')
  })

  it('merges live today data on top of carried history without double counting', async () => {
    // Same seed, but the range also includes today, for which there is still
    // no live data — totals must stay exactly the carried values.
    const day = daysAgoStr(10)
    const cache: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: getDailyCacheConfigHash(),
      tzKey: currentTzKey(),
      lastComputedDate: daysAgoStr(1),
      days: [carriedDay(day)],
      complete: true,
    }
    await writeFile(join(ROOT, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`), JSON.stringify(cache), 'utf-8')

    const payload = await buildMenubarPayloadForRange(getDateRange('all'), { provider: 'all', optimize: false, timeline: false })
    expect(payload.current.cost).toBe(100)
    expect(payload.current.topProjects).toHaveLength(1)
  })
})
