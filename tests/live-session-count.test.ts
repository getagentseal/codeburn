import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDateRange } from '../src/cli-date.js'
import { currentTzKey, DAILY_CACHE_VERSION, emptyCache, toDateString, type DailyCache, type DailyEntry } from '../src/daily-cache.js'
import { loadPricing } from '../src/models.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { buildDurableOverviewFromNormalizedIndex, buildMenubarPayloadForRange, getDailyCacheConfigHash } from '../src/usage-aggregator.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-live-count-'))
  process.env['CLAUDE_CONFIG_DIR'] = join(root, 'claude')
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(root, 'desktop')
  clearSessionCache()
  await loadPricing()
  const now = new Date()
  const timestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  for (const name of ['alpha', 'beta']) {
    const dir = join(root, 'claude', 'projects', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${name}.jsonl`), JSON.stringify({
      type: 'assistant', sessionId: name, timestamp, cwd: `/projects/${name}`,
      message: {
        id: name, role: 'assistant', type: 'message', model: 'claude-sonnet-4-6', content: [],
        usage: { input_tokens: 1000, output_tokens: 100 },
      },
    }) + '\n')
  }
})

afterEach(async () => {
  clearSessionCache()
  await rm(root, { recursive: true, force: true })
})

async function seedHistory(): Promise<DailyEntry> {
  const now = new Date()
  const date = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const projects = { alpha: { path: '/projects/alpha', cost: 9, calls: 9, sessions: 3, savingsUSD: 0 } }
  const day: DailyEntry = {
    date, cost: 9, calls: 9, sessions: 3, savingsUSD: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    editTurns: 0, oneShotTurns: 0, models: {}, categories: {}, projects,
    providers: { claude: { cost: 9, calls: 9, sessions: 3, savingsUSD: 0, projects } },
    carried: true,
  }
  const cache: DailyCache = {
    ...emptyCache(), version: DAILY_CACHE_VERSION, days: [day], lastComputedDate: date,
    savingsConfigHash: getDailyCacheConfigHash(), tzKey: currentTzKey(), complete: true, watermarkTrusted: true,
  }
  await mkdir(join(root, 'cache'), { recursive: true })
  await writeFile(join(root, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`), JSON.stringify(cache))
  return day
}

const options = { optimize: false, timeline: false }

describe('live Today session counts (#1785)', () => {
  it.each([
    ['all', undefined, 2],
    ['claude', undefined, 2],
    ['all', ['alpha'], 1],
    ['claude', ['alpha'], 1],
  ] as const)('keeps Today exact for %s with project filter %j', async (provider, project, count) => {
    // Retained history exists but is outside the selected Today range.
    await seedHistory()
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), {
      ...options, provider, project: project ? [...project] : undefined,
    })
    expect(payload.current).toMatchObject({ sessions: count, sessionCountBasis: 'identity', calls: count })
    expect(payload.current.cost).toBeGreaterThan(0)
    expect(payload.current.providerDetails.find(p => p.id === 'claude'))
      .toMatchObject({ sessions: count, sessionCountBasis: 'identity' })
    expect(payload.current.topProjects).toHaveLength(count)
    for (const row of payload.current.topProjects) {
      expect(row).toMatchObject({ sessions: 1, sessionCountBasis: 'identity' })
      expect(row.avgCostPerSession).toBeCloseTo(row.cost)
    }
    expect(payload.current.topProjects.reduce((sum, p) => sum + p.cost, 0)).toBeCloseTo(payload.current.cost)
  })

  it.each(['all', 'claude'])('preserves historical lower bounds and money for %s', async provider => {
    await seedHistory()
    const today = await buildMenubarPayloadForRange(getDateRange('today'), { ...options, provider })
    const week = await buildMenubarPayloadForRange(getDateRange('week'), { ...options, provider })
    expect(week.current).toMatchObject({ sessions: 3, sessionCountBasis: 'partial', calls: 11 })
    expect(week.current.cost).toBeCloseTo(9 + today.current.cost)
    expect(week.current.providerDetails.find(p => p.id === 'claude'))
      .toMatchObject({ sessions: 3, sessionCountBasis: 'partial' })
    const historical = week.current.topProjects.find(p => p.name === 'alpha')!
    expect(historical).toMatchObject({ sessions: 3, sessionCountBasis: 'partial' })
    // Kept numeric for older menubar decoders; current clients gate on basis.
    expect(historical.avgCostPerSession).toBeCloseTo(historical.cost / 3)
    // A different project backed only by today's live row stays exact.
    expect(week.current.topProjects.find(p => p.name === 'beta'))
      .toMatchObject({ sessions: 1, sessionCountBasis: 'identity' })
    expect(week.current.topProjects.reduce((sum, p) => sum + p.cost, 0)).toBeCloseTo(week.current.cost)
  })

  it.each(['all', 'claude'])('keeps the normalized-index Today headline exact for %s', async provider => {
    const period = getDateRange('today')
    const projects = await parseAllSessions(period.range, provider)
    const result = buildDurableOverviewFromNormalizedIndex(period, projects, emptyCache(), { provider })
    expect(result).toMatchObject({ sessions: 2, sessionCountBasis: 'identity', calls: 2 })
    expect(result.cost).toBeGreaterThan(0)
  })

  it('keeps an empty Today exact', async () => {
    await rm(join(root, 'claude'), { recursive: true, force: true })
    await seedHistory()
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), { ...options, provider: 'claude' })
    expect(payload.current).toMatchObject({ sessions: 0, sessionCountBasis: 'identity', cost: 0 })
    expect(payload.current.topProjects).toEqual([])
  })
})
