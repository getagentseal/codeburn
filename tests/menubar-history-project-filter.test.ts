import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { DAILY_CACHE_VERSION, currentTzKey, type DailyCache, type DailyEntry } from '../src/daily-cache.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import { buildMenubarPayloadForRange, getDailyCacheConfigHash } from '../src/usage-aggregator.js'
import { setHome } from './setup/home.js'

// The headline is sliced to the requested projects and today's days come from a
// name-filtered parse, but the 365-day `history.daily` came straight out of the
// day cache. Every surface built on it — the heatmap, the streak, month-to-date,
// the daily-spend chart — therefore showed EVERY project's spend underneath a
// filtered headline.

const ROOT = join(tmpdir(), `codeburn-history-filter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
const ENV_KEYS = ['HOME', 'CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEX_HOME'] as const
let savedEnv: Record<string, string | undefined>

function daysAgoStr(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** One historical day shared by two projects, with the per-project split a
 *  post-v15 cache carries. */
function sharedDay(date: string): DailyEntry {
  const projects = {
    'proj-keep': { cost: 100, calls: 40, savingsUSD: 0, sessions: 3, path: '/Users/gone/proj-keep' },
    'proj-hide': { cost: 50, calls: 20, savingsUSD: 0, sessions: 2, path: '/Users/gone/proj-hide' },
  }
  return {
    date,
    cost: 150,
    savingsUSD: 0,
    calls: 60,
    sessions: 5,
    inputTokens: 7000,
    outputTokens: 3000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 6,
    oneShotTurns: 3,
    models: { 'Opus 4.8': { calls: 60, cost: 150, savingsUSD: 0, inputTokens: 7000, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    categories: { coding: { turns: 15, cost: 150, savingsUSD: 0, editTurns: 6, oneShotTurns: 3 } },
    providers: {
      claude: {
        calls: 60, cost: 150, savingsUSD: 0, sessions: 5,
        inputTokens: 7000, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0,
        projects,
      },
    },
    projects,
    carried: true,
  }
}

async function seedCache(day: string): Promise<void> {
  const cache: DailyCache = {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: getDailyCacheConfigHash(),
    tzKey: currentTzKey(),
    lastComputedDate: daysAgoStr(1),
    days: [sharedDay(day)],
    complete: true,
  }
  await writeFile(join(ROOT, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`), JSON.stringify(cache), 'utf-8')
}

beforeAll(async () => {
  await loadPricing()
})

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  await mkdir(join(ROOT, 'home'), { recursive: true })
  await mkdir(join(ROOT, 'cache'), { recursive: true })
  setHome(join(ROOT, 'home'))
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

describe('history.daily under a project filter', () => {
  it('slices the daily history the same way the headline is sliced', async () => {
    const day = daysAgoStr(10)
    await seedCache(day)

    const payload = await buildMenubarPayloadForRange(getDateRange('all'), {
      provider: 'all', optimize: false, timeline: false, exclude: ['/Users/gone/proj-hide'],
    })

    expect(payload.current.cost).toBe(100)
    const entry = payload.history.daily.find(d => d.date === day)
    expect(entry?.cost).toBe(100)
    expect(entry?.calls).toBe(40)
  })

  it('leaves the daily history whole when nothing is filtered', async () => {
    const day = daysAgoStr(10)
    await seedCache(day)

    const payload = await buildMenubarPayloadForRange(getDateRange('all'), { provider: 'all', optimize: false, timeline: false })

    expect(payload.current.cost).toBe(150)
    expect(payload.history.daily.find(d => d.date === day)?.cost).toBe(150)
  })
})
