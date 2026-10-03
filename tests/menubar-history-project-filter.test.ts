import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { DAILY_CACHE_VERSION, currentTzKey, type DailyCache, type DailyEntry, type ProjectDayStats } from '../src/daily-cache.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import { buildMenubarPayloadForRange, getDailyCacheConfigHash } from '../src/usage-aggregator.js'
import { exactProjectBucketKey } from '../src/project-scope.js'
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

function exactSharedDay(date: string): DailyEntry {
  const keepId = 'path:/Users/gone/proj-keep'
  const hideId = 'path:/Users/gone/proj-hide'
  const keepModel = { calls: 4, cost: 100, savingsUSD: 0, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 40 }
  const hideModel = { calls: 2, cost: 50, savingsUSD: 0, inputTokens: 500, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 20 }
  const keepCategory = { turns: 7, cost: 100, savingsUSD: 0, editTurns: 5, oneShotTurns: 4 }
  const hideCategory = { turns: 3, cost: 50, savingsUSD: 0, editTurns: 1, oneShotTurns: 1 }
  const keep: ProjectDayStats = { canonicalId: keepId, sourceLabel: 'proj-keep', displayName: 'proj-keep', path: '/Users/gone/proj-keep', provenance: 'exact', cost: 100, calls: 4, savingsUSD: 0, sessions: 3, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 40, editTurns: 5, oneShotTurns: 4, models: { 'Opus 4.8': keepModel }, categories: { coding: keepCategory } }
  const hide: ProjectDayStats = { canonicalId: hideId, sourceLabel: 'proj-hide', displayName: 'proj-hide', path: '/Users/gone/proj-hide', provenance: 'exact', cost: 50, calls: 2, savingsUSD: 0, sessions: 2, inputTokens: 500, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 20, editTurns: 1, oneShotTurns: 1, models: { 'Haiku 4.5': hideModel }, categories: { debugging: hideCategory } }
  const projects = { [exactProjectBucketKey(keepId)]: keep, [exactProjectBucketKey(hideId)]: hide }
  return {
    ...sharedDay(date),
    inputTokens: 1500,
    outputTokens: 300,
    cacheReadTokens: 500,
    cacheWriteTokens: 60,
    editTurns: 6,
    oneShotTurns: 5,
    models: { 'Opus 4.8': keepModel, 'Haiku 4.5': hideModel },
    categories: { coding: keepCategory, debugging: hideCategory },
    projects,
    providers: { claude: { ...sharedDay(date).providers.claude!, inputTokens: 1500, outputTokens: 300, cacheReadTokens: 500, cacheWriteTokens: 60, editTurns: 6, oneShotTurns: 5, models: { 'Opus 4.8': keepModel, 'Haiku 4.5': hideModel }, categories: { coding: keepCategory, debugging: hideCategory }, projects } },
  }
}

async function seedCache(day: string | DailyEntry): Promise<void> {
  const cache: DailyCache = {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: getDailyCacheConfigHash(),
    tzKey: currentTzKey(),
    lastComputedDate: daysAgoStr(1),
    days: [typeof day === 'string' ? sharedDay(day) : day],
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

  it('projects exact retained history without global top-up for a selected project', async () => {
    const day = daysAgoStr(10)
    await seedCache(exactSharedDay(day))

    const payload = await buildMenubarPayloadForRange(getDateRange('all'), {
      provider: 'all', optimize: false, timeline: false,
      desktopProjectId: 'path:/Users/gone/proj-keep',
    })
    expect(payload.current.cost).toBe(100)
    expect(payload.current.calls).toBe(4)
    expect(payload.current.inputTokens).toBe(1000)
    expect(payload.current.outputTokens).toBe(200)
    expect(payload.current.cacheReadTokens).toBe(300)
    expect(payload.current.cacheWriteTokens).toBe(40)
    expect(payload.current.topModels).toEqual([
      expect.objectContaining({ name: 'Opus 4.8', cost: 100, calls: 4, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 40 }),
    ])
    expect(payload.current.topActivities).toEqual([
      expect.objectContaining({ rawCategory: 'coding', turns: 7, cost: 100, oneShotRate: 4 / 5 }),
    ])
    expect(payload.history.daily.find(d => d.date === day)?.cost).toBe(100)
    expect(payload.history.daily.find(d => d.date === day)).toMatchObject({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 40, topModels: [expect.objectContaining({ name: 'Opus 4.8', cost: 100, calls: 4, inputTokens: 1000, outputTokens: 200 })] })
    expect(payload.periodTotals).toBeUndefined()
  })

  it('projects the retained rich fields from the selected provider slice', async () => {
    const day = daysAgoStr(10)
    await seedCache(exactSharedDay(day))

    const payload = await buildMenubarPayloadForRange(getDateRange('all'), {
      provider: 'claude', optimize: false, timeline: false,
      desktopProjectId: 'path:/Users/gone/proj-keep',
    })

    expect(payload.current).toMatchObject({ cost: 100, calls: 4, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 40 })
    expect(payload.current.topModels[0]).toMatchObject({ name: 'Opus 4.8', inputTokens: 1000, outputTokens: 200 })
    expect(payload.current.topActivities[0]).toMatchObject({ rawCategory: 'coding', turns: 7 })
    expect(payload.current.providerDetails[0]).toMatchObject({ id: 'claude', cost: 100, calls: 4, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 })
  })

  it('keeps an unavailable provider/project slice empty instead of using another provider or global history', async () => {
    const day = daysAgoStr(10)
    await seedCache(exactSharedDay(day))

    const payload = await buildMenubarPayloadForRange(getDateRange('all'), {
      provider: 'codex', optimize: false, timeline: false,
      desktopProjectId: 'path:/Users/gone/proj-keep',
    })

    expect(payload.current).toMatchObject({ cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [], topActivities: [] })
    expect(payload.history.daily.find(d => d.date === day)).toMatchObject({ cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [] })
  })
})
