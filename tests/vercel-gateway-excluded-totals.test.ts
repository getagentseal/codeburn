import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildDurablePeriod, buildMenubarPayloadForRange, excludeProviderFromDay } from '../src/usage-aggregator.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import { setIncludeGatewayInTotals } from '../src/config.js'
import { emptyCache, type DailyCache } from '../src/daily-cache.js'
import { renderOverview } from '../src/overview.js'
import { aggregateSessions } from '../src/sessions-report.js'
import { aggregateModels } from '../src/models-report.js'
import { excludeAggregateOnlyProjects as excludeAggregateOnly, excludesAggregateOnlyProviders as excludesAggregateOnly, aggregateOnlyCostUSD as aggregateOnlyCost } from '../src/parser.js'
import type { ProjectSummary } from '../src/types.js'

// The gateway reports one aggregate row per day+model: $12.34 of spend that the
// local tools pointed at the gateway already recorded themselves. Counting both
// double counts, so the headline drops it and the provider row keeps it.
const GATEWAY_COST = 12.34
const LOCAL_COST = 1.5
// The gateway reports vendor-prefixed ids; a local tool reports the bare one.
// Both resolve to the same DISPLAY name, which is where a merge would fold
// gateway cost into a real model's row.
const GATEWAY_MODEL = 'openai/gpt-4o'
const LOCAL_MODEL = 'gpt-4o'

const ts = new Date().toISOString()
const emptyCat = { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }

function makeCall(provider: string, costUSD: number, key: string, requestCount?: number) {
  return {
    provider,
    model: provider === 'vercel-gateway' ? GATEWAY_MODEL : LOCAL_MODEL,
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard' as const,
    timestamp: ts,
    bashCommands: [],
    deduplicationKey: key,
    ...(requestCount != null ? { requestCount } : {}),
  }
}

function makeProject(provider: string, project: string, costUSD: number, key: string, requestCount?: number): ProjectSummary {
  return {
    project,
    projectPath: project,
    sessions: [{
      sessionId: `${key}-sess`,
      project,
      firstTimestamp: ts,
      lastTimestamp: ts,
      totalCostUSD: costUSD,
      totalSavingsUSD: 0,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      apiCalls: requestCount ?? 1,
      turns: [{
        userMessage: '',
        timestamp: ts,
        sessionId: `${key}-sess`,
        category: 'coding',
        retries: 0,
        hasEdits: false,
        assistantCalls: [makeCall(provider, costUSD, key, requestCount)],
      }],
      modelBreakdown: {
        [provider === 'vercel-gateway' ? GATEWAY_MODEL : LOCAL_MODEL]: {
          calls: requestCount ?? 1,
          costUSD,
          savingsUSD: 0,
          estimatedCostUSD: 0,
          tokens: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
        },
      },
      toolBreakdown: {},
      mcpBreakdown: {},
      bashBreakdown: {},
      subagentBreakdown: {},
      categoryBreakdown: { coding: { ...emptyCat, turns: 1, costUSD } },
      skillBreakdown: {},
    }],
    totalCostUSD: costUSD,
    totalSavingsUSD: 0,
    totalApiCalls: requestCount ?? 1,
  } as unknown as ProjectSummary
}

const gatewayProject = (): ProjectSummary => makeProject('vercel-gateway', 'Vercel AI Gateway', GATEWAY_COST, 'vercel-gateway:day:model', 3)
const localProject = (): ProjectSummary => makeProject('claude', 'local-repo', LOCAL_COST, 'claude-1')

/// What each parseAllSessions call should return, per provider scope. Set per
/// test so one fixture drives the all-provider and the `--provider` paths.
let corpus: ProjectSummary[] = []
/// Days the mocked durable cache holds (the "already sealed" case).
let cachedDays: DailyCache['days'] = []

const parseAllSessions = vi.hoisted(() => vi.fn())
const shared = vi.hoisted(() => ({ excludeAggregateOnlyProjects: (p: unknown[]) => p }))

vi.mock('../src/parser.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/parser.js')>()
  shared.excludeAggregateOnlyProjects = mod.excludeAggregateOnlyProjects as typeof shared.excludeAggregateOnlyProjects
  return {
    ...mod,
    parseAllSessions,
    isSessionHydrationComplete: vi.fn(() => true),
    sessionHydrationSnapshot: vi.fn(() => ({ complete: true, deferredForFirstPaint: false, indexedFiles: 0, pendingFiles: 0 })),
  }
})

vi.mock('../src/daily-cache.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/daily-cache.js')>()
  const cache = (): DailyCache => ({ ...mod.emptyCache(), days: cachedDays, complete: true })
  return {
    ...mod,
    ensureCacheHydrated: vi.fn(async () => cache()),
    loadDailyCache: vi.fn(async () => cache()),
  }
})

function sessionProvider(project: ProjectSummary): string {
  return project.sessions[0]!.turns[0]!.assistantCalls[0]!.provider
}

// Honours `includeAggregateOnly` through the REAL shared filter, so a caller
// in buildDurablePeriod that forgot the write-side opt-out shows up here as a
// gateway provider row that dropped to zero.
parseAllSessions.mockImplementation(async (_range: unknown, provider?: string, opts?: { includeAggregateOnly?: boolean }) => {
  const scoped = provider && provider !== 'all' ? corpus.filter(p => sessionProvider(p) === provider) : corpus
  return opts?.includeAggregateOnly === true
    ? scoped
    : (shared.excludeAggregateOnlyProjects as unknown as typeof import('../src/parser.js')['excludeAggregateOnlyProjects'])(scoped, provider)
})

const opts = { provider: 'all', optimize: false, timeline: false } as const

describe('vercel-gateway: daily aggregates are shown but not totalled', () => {
  beforeAll(async () => {
    await loadPricing()
  })

  afterEach(() => {
    setIncludeGatewayInTotals(false)
    corpus = []
    cachedDays = []
  })

  it('keeps gateway-only spend off the headline and on its own row', async () => {
    corpus = [gatewayProject()]
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), opts)

    expect(payload.current.cost).toBe(0)
    const row = payload.current.providerDetails!.find(p => p.id === 'vercel-gateway')!
    expect(row.cost).toBeCloseTo(GATEWAY_COST, 10)
    expect(row.excludedFromTotal).toBe(true)
    // The legacy providers map keeps the provider too: it is real spend.
    expect(payload.current.providers['vercel ai gateway']).toBeCloseTo(GATEWAY_COST, 10)
    // Nothing derived from the day may smuggle it back in.
    expect(payload.current.topModels).toEqual([])
    expect(payload.current.topActivities).toEqual([])
    expect(payload.history.daily.reduce((s, d) => s + d.cost, 0)).toBe(0)

    const durable = await buildDurablePeriod(getDateRange('today'), opts)
    expect(durable.excludedGateway.costUSD).toBeCloseTo(GATEWAY_COST, 10)
  })

  it('counts it exactly once with the opt-in on', async () => {
    corpus = [gatewayProject()]
    setIncludeGatewayInTotals(true)
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), opts)

    expect(payload.current.cost).toBeCloseTo(GATEWAY_COST, 10)
    const row = payload.current.providerDetails!.find(p => p.id === 'vercel-gateway')!
    expect(row.cost).toBeCloseTo(GATEWAY_COST, 10)
    expect(row.excludedFromTotal).toBeUndefined()

    const durable = await buildDurablePeriod(getDateRange('today'), opts)
    expect(durable.excludedGateway.costUSD).toBe(0)
  })

  it('leaves a local session on the headline when the gateway shares its day and model', async () => {
    corpus = [gatewayProject(), localProject()]
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), opts)

    expect(payload.current.cost).toBeCloseTo(LOCAL_COST, 8)
    // The shared model row keeps the local remainder only.
    expect(payload.current.topModels.reduce((s, m) => s + m.cost, 0)).toBeCloseTo(LOCAL_COST, 8)
    expect(payload.current.providerDetails!.find(p => p.id === 'vercel-gateway')!.cost).toBeCloseTo(GATEWAY_COST, 10)
  })

  it('makes the headline the exact sum of the providers it counts', async () => {
    corpus = [gatewayProject(), localProject()]
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), opts)

    const counted = payload.current.providerDetails!
      .filter(p => !p.excludedFromTotal)
      .reduce((sum, p) => sum + p.cost, 0)
    expect(counted).toBeCloseTo(payload.current.cost, 8)
  })

  it('leaves --provider vercel-gateway reporting the full amount', async () => {
    corpus = [gatewayProject(), localProject()]
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), { ...opts, provider: 'vercel-gateway' })

    expect(payload.current.cost).toBeCloseTo(GATEWAY_COST, 10)
    expect(payload.current.providerDetails![0]!.excludedFromTotal).toBeUndefined()

    const durable = await buildDurablePeriod(getDateRange('today'), { ...opts, provider: 'vercel-gateway' })
    expect(durable.data.cost).toBeCloseTo(GATEWAY_COST, 10)
    expect(durable.excludedGateway.costUSD).toBe(0)
  })

  it('reports request_count as the row call count', async () => {
    corpus = [gatewayProject()]
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), { ...opts, provider: 'vercel-gateway' })
    expect(payload.current.calls).toBe(3)

    const all = await buildMenubarPayloadForRange(getDateRange('today'), opts)
    expect(all.current.providerDetails!.find(p => p.id === 'vercel-gateway')!.calls).toBe(3)
  })

  // The slice is sealed into the daily cache whether or not it is counted, so
  // flipping the opt-in re-reads history that can never be fetched again.
  it('applies retroactively to sealed days with no re-fetch', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('no network in this test') })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    try {
      const sealed = aggregateProjectsIntoDays([gatewayProject(), localProject()])
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const key = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
      cachedDays = sealed.map(d => ({ ...d, date: key }))
      corpus = []

      const excluded = await buildDurablePeriod(getDateRange('week'), opts)
      expect(excluded.data.cost).toBeCloseTo(LOCAL_COST, 8)
      expect(excluded.excludedGateway.costUSD).toBeCloseTo(GATEWAY_COST, 10)

      setIncludeGatewayInTotals(true)
      const included = await buildDurablePeriod(getDateRange('week'), opts)
      expect(included.data.cost).toBeCloseTo(LOCAL_COST + GATEWAY_COST, 8)
      expect(included.excludedGateway.costUSD).toBe(0)

      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })


  it('keeps the gateway out of every detail panel beside the excluded headline', async () => {
    corpus = [gatewayProject(), localProject()]
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), opts)

    // Same display name on both sides, so a merge would fold gateway cost into
    // the local model's row.
    expect(payload.current.topModels).toHaveLength(1)
    expect(payload.current.topModels[0]!.cost).toBeCloseTo(LOCAL_COST, 8)
    expect(payload.current.topProjects.map(p => p.name)).not.toContain('Vercel AI Gateway')
    expect(payload.current.topProjects.reduce((s, p) => s + p.cost, 0)).toBeLessThanOrEqual(payload.current.cost + 1e-9)
    expect(payload.current.topSessions.map(row => row.project)).not.toContain('Vercel AI Gateway')
    expect(payload.current.topActivities.reduce((s, a) => s + a.cost, 0)).toBeCloseTo(LOCAL_COST, 8)
  })

  it('shows the gateway project and model again with the opt-in on', async () => {
    corpus = [gatewayProject(), localProject()]
    setIncludeGatewayInTotals(true)
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), opts)

    expect(payload.current.cost).toBeCloseTo(LOCAL_COST + GATEWAY_COST, 8)
    expect(payload.current.topProjects.map(p => p.name)).toContain('Vercel AI Gateway')
    expect(payload.current.topModels.reduce((s, m) => s + m.cost, 0)).toBeCloseTo(LOCAL_COST + GATEWAY_COST, 8)
  })

  it('stays consistent under --project and --exclude', async () => {
    corpus = [gatewayProject(), localProject()]

    const onlyLocal = await buildDurablePeriod(getDateRange('today'), { ...opts, project: ['local-repo'] })
    expect(onlyLocal.data.cost).toBeCloseTo(LOCAL_COST, 8)
    expect(onlyLocal.data.models.reduce((s, m) => s + m.cost, 0)).toBeCloseTo(LOCAL_COST, 8)

    // Excluding the only local project leaves nothing — NOT the gateway's
    // spend, which the headline was never counting.
    const excludeLocal = await buildDurablePeriod(getDateRange('today'), { ...opts, exclude: ['local-repo'] })
    expect(excludeLocal.data.cost).toBe(0)
    expect(excludeLocal.data.models).toEqual([])
    expect(excludeLocal.liveProjects).toEqual([])

    // Naming the gateway's own project cannot resurrect it into a total.
    const onlyGateway = await buildDurablePeriod(getDateRange('today'), { ...opts, project: ['Vercel AI Gateway'] })
    expect(onlyGateway.data.cost).toBe(0)
    expect(onlyGateway.data.models).toEqual([])
  })

  it('reconciles the text overview: By tool shares sum to 100% over counted rows', async () => {
    corpus = [gatewayProject(), localProject()]
    const durable = await buildDurablePeriod(getDateRange('today'), opts)
    const text = renderOverview(durable.liveProjects, {
      label: 'Today',
      color: false,
      durable: {
        cost: durable.data.cost,
        savingsUSD: durable.data.savingsUSD,
        calls: durable.data.calls,
        sessions: durable.data.sessions,
        inputTokens: durable.data.inputTokens,
        outputTokens: durable.data.outputTokens,
        cacheReadTokens: durable.data.cacheReadTokens,
        cacheWriteTokens: durable.data.cacheWriteTokens,
        days: durable.days,
        carriedCostUSD: durable.carriedCostUSD,
        excludedGateway: durable.excludedGateway,
      },
    })

    const byTool = text.slice(text.indexOf('By tool'))
    const shares = [...byTool.matchAll(/(\d+)%/g)].map(m => Number(m[1]))
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100)
    // Present, labelled, and with no share of a total it is not in.
    expect(byTool).toContain('vercel-gateway (not in total)')
    expect(byTool).toContain(GATEWAY_COST.toFixed(2))
    expect(text).toContain('excludes')
  })

  it('applies the same rule to every standalone report through the shared corpus filter', async () => {
    const both = [gatewayProject(), localProject()]
    const filtered = excludeAggregateOnly(both, 'all')

    expect(filtered.reduce((s, p) => s + p.totalCostUSD, 0)).toBeCloseTo(LOCAL_COST, 8)
    expect(aggregateOnlyCost(both)).toBeCloseTo(GATEWAY_COST, 10)
    // `sessions`
    expect(aggregateSessions(filtered)).toHaveLength(1)
    // `models`
    const models = await aggregateModels(filtered, { minCost: 0 })
    expect(models.some(row => row.provider === 'vercel-gateway')).toBe(false)
    expect(models.reduce((s, row) => s + row.costUSD, 0)).toBeCloseTo(LOCAL_COST, 8)
    // `export` / `budget` / `compare` all total the same array the filter returns.
    expect(filtered.reduce((s, p) => s + p.totalApiCalls, 0)).toBe(1)

    // Opt-in on: the SAME array object comes back, so no report can diverge.
    setIncludeGatewayInTotals(true)
    expect(excludeAggregateOnly(both, 'all')).toBe(both)
    // A provider-scoped read is never narrowed either way.
    setIncludeGatewayInTotals(false)
    expect(excludeAggregateOnly(both, 'vercel-gateway')).toBe(both)
  })

  // `src/sync/cli.ts` pushes `await parseAllSessions(range)` with no provider
  // argument, so it inherits the shared default: the backend would double count
  // a gateway aggregate exactly the way a local headline would.
  it('treats an unscoped parse (the sync push shape) as all-provider', () => {
    expect(excludesAggregateOnly(undefined)).toBe(true)
    expect(excludesAggregateOnly('all')).toBe(true)
    expect(excludesAggregateOnly('vercel-gateway')).toBe(false)
    setIncludeGatewayInTotals(true)
    expect(excludesAggregateOnly(undefined)).toBe(false)
  })

  it('is a no-op array-identity pass when no gateway session exists', () => {
    const local = [localProject()]
    expect(excludeAggregateOnly(local, 'all')).toBe(local)
    expect(aggregateOnlyCost(local)).toBe(0)
  })

  // The write side must stay whole even when the read side is narrowed twice
  // over: a project filter slices the same sealed days the opt-in later
  // re-includes.
  it('flips the opt-in retroactively under a project filter, off the cache', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('no network in this test') })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    try {
      const sealed = aggregateProjectsIntoDays([gatewayProject(), localProject()])
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const key = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
      cachedDays = sealed.map(d => ({ ...d, date: key }))
      corpus = []
      const filtered = { ...opts, project: ['local-repo', 'Vercel AI Gateway'] }

      const off = await buildDurablePeriod(getDateRange('week'), filtered)
      expect(off.data.cost).toBeCloseTo(LOCAL_COST, 8)
      expect(off.excludedGateway.costUSD).toBeCloseTo(GATEWAY_COST, 10)

      setIncludeGatewayInTotals(true)
      const on = await buildDurablePeriod(getDateRange('week'), filtered)
      expect(on.data.cost).toBeCloseTo(LOCAL_COST + GATEWAY_COST, 8)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('subtracts a day exactly, keeping the slice for the provider row', () => {
    const [day] = aggregateProjectsIntoDays([gatewayProject(), localProject()])
    const left = excludeProviderFromDay(day!, 'vercel-gateway')

    expect(left.cost).toBeCloseTo(LOCAL_COST, 8)
    expect(left.calls).toBe(1)
    expect(left.providers['vercel-gateway']!.cost).toBeCloseTo(GATEWAY_COST, 10)
    expect(left.providers['vercel-gateway']!.calls).toBe(3)
    // The gateway's own synthetic project leaves the day's project split.
    expect(Object.keys(left.projects ?? {})).toEqual(['local-repo'])
    // A day with no slice for the provider is returned untouched.
    expect(excludeProviderFromDay(day!, 'nope')).toBe(day)
  })
})
