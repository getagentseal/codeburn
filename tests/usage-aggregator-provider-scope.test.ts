import { beforeAll, describe, expect, it, vi } from 'vitest'

import { buildMenubarPayloadForRange, overlayProviderDaySlices } from '../src/usage-aggregator.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import { exactProjectBucketKey } from '../src/project-scope.js'
import type { DailyEntry, ProviderDaySlice } from '../src/daily-cache.js'
import { project } from './fixtures/project-scope.js'

const parseAllSessions = vi.hoisted(() => vi.fn(async () => []))

vi.mock('../src/parser.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/parser.js')>()
  return {
    ...mod,
    parseAllSessions,
    isSessionHydrationComplete: vi.fn(() => true),
    sessionHydrationSnapshot: vi.fn(() => ({
      complete: true,
      deferredForFirstPaint: false,
      indexedFiles: 0,
      pendingFiles: 0,
    })),
  }
})

vi.mock('../src/daily-cache.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/daily-cache.js')>()
  return {
    ...mod,
    ensureCacheHydrated: vi.fn(async (parseSessions: (range: { start: Date; end: Date }) => Promise<unknown>) => {
      await parseSessions({ start: new Date(0), end: new Date() })
      return mod.emptyCache()
    }),
    loadDailyCache: vi.fn(async () => mod.emptyCache()),
  }
})

describe('provider-scoped menubar aggregation', () => {
  beforeAll(async () => {
    await loadPricing()
  })

  it('never scans unrelated providers to render one selected provider', async () => {
    parseAllSessions.mockClear()

    await buildMenubarPayloadForRange(getDateRange('today'), {
      provider: 'hermes',
      optimize: false,
      timeline: false,
    })

    expect(parseAllSessions.mock.calls.map(([, provider]) => provider))
      .toEqual(['hermes'])
  })

  it('scopes the single-provider row to that provider period totals', async () => {
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), {
      provider: 'hermes',
      optimize: false,
      timeline: false,
    })

    // The whole period IS this provider here, so its providerDetails row must
    // mirror the period block rather than leave the dock glance without one.
    expect(payload.current.providerDetails).toEqual([
      expect.objectContaining({
        id: 'hermes',
        cost: payload.current.cost,
        calls: payload.current.calls,
        inputTokens: payload.current.inputTokens,
        outputTokens: payload.current.outputTokens,
        sessions: payload.current.sessions,
      }),
    ])
  })

  it('builds Pull Request rows from the provider and exact project-filtered corpus', async () => {
    const alphaUrl = 'https://github.com/example/repo/pull/alpha'
    const betaUrl = 'https://github.com/example/repo/pull/beta'
    const alpha = project('Alpha', '/work/alpha', 5, 'claude')
    const beta = project('Beta', '/work/beta', 7, 'claude')
    const withPr = (summary: typeof alpha, url: string) => ({
      ...summary,
      sessions: summary.sessions.map(session => ({ ...session, prLinks: [url] })),
    })
    parseAllSessions.mockImplementation(async (_range, provider) => provider === 'claude'
      ? [withPr(alpha, alphaUrl), withPr(beta, betaUrl)]
      : [])

    try {
      const payload = await buildMenubarPayloadForRange(getDateRange('all'), {
        provider: 'claude',
        desktopProjectId: 'path:/work/alpha',
        optimize: false,
        timeline: false,
      })

      expect(payload.current.pullRequests?.rows.map(row => row.url)).toEqual([alphaUrl])
    } finally {
      parseAllSessions.mockReset().mockResolvedValue([])
    }
  })

  it('overlays today without letting a shrunken parse rewrite settled history', () => {
    const slice = (cost: number, calls: number): ProviderDaySlice => ({ cost, calls, savingsUSD: 0, sessions: calls })
    const day = (date: string, providers: Record<string, ProviderDaySlice>): DailyEntry => ({
      date,
      cost: Object.values(providers).reduce((sum, provider) => sum + provider.cost, 0),
      calls: Object.values(providers).reduce((sum, provider) => sum + provider.calls, 0),
      sessions: Object.values(providers).reduce((sum, provider) => sum + (provider.sessions ?? 0), 0),
      savingsUSD: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      editTurns: 0,
      oneShotTurns: 0,
      models: {},
      categories: {},
      providers,
    })

    // 2026-08-20 is settled and its sources have partially aged off disk: the
    // fresh parse sees 3 of the 100 calls the cache finalized, so the cache
    // stays authoritative. 2026-08-21 is a settled day the cache never held
    // (cold cache), where the fresh parse is the only source there is.
    const result = overlayProviderDaySlices(
      [
        day('2026-08-20', { hermes: slice(10, 100), claude: slice(2, 3) }),
      ],
      [
        day('2026-08-20', { hermes: slice(0.3, 3) }),
        day('2026-08-21', { hermes: slice(0.438, 6) }),
      ],
      'hermes',
    )

    expect(result.map(entry => ({ date: entry.date, cost: entry.cost, calls: entry.calls }))).toEqual([
      { date: '2026-08-20', cost: 10, calls: 100 },
      { date: '2026-08-21', cost: 0.438, calls: 6 },
    ])
    expect(result[0]!.providers).toEqual({ hermes: slice(10, 100) })
    expect(result[1]!.providers).toEqual({ hermes: slice(0.438, 6) })
  })

  it('preserves rich project fields while slicing a day to one provider', () => {
    const [day] = aggregateProjectsIntoDays([project('alpha', '/work/alpha', 5, 'claude')])
    const key = exactProjectBucketKey('path:/work/alpha')
    const result = overlayProviderDaySlices([], [day!], 'claude')
    const projectStats = result[0]!.projects?.[key]
    const providerStats = result[0]!.providers.claude?.projects?.[key]

    expect(projectStats).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      cacheReadTokens: expect.any(Number),
      cacheWriteTokens: expect.any(Number),
      editTurns: expect.any(Number),
      oneShotTurns: expect.any(Number),
      models: expect.any(Object),
      categories: expect.any(Object),
    })
    expect(providerStats).toEqual(projectStats)
  })
})
