import { describe, expect, it } from 'vitest'

import {
  buildPeriodDiffReport,
  countLocalDays,
  defaultSevenDayRanges,
  diffSessions,
  historyBasis,
  localRangeInfo,
  overlapDays,
  rangeInfo,
} from '../src/period-diff.js'
import type { DailyCache, DailyEntry } from '../src/daily-cache.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'

// Minimal but arithmetically consistent session/project fixtures: the same
// fields buildPeriodData, the session-count key, and the model lens read.

type SessionSpec = {
  sessionId: string
  provider?: string
  model?: string
  modelCosts?: Record<string, { costUSD: number; calls: number }>
  costUSD: number
  calls: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  title?: string
  firstTimestamp?: string
}

function makeSession(spec: SessionSpec): SessionSummary {
  const modelBreakdown: SessionSummary['modelBreakdown'] = {}
  const models = spec.modelCosts ?? { [spec.model ?? 'test-model']: { costUSD: spec.costUSD, calls: spec.calls } }
  let totalCost = 0
  let totalCalls = 0
  for (const [model, d] of Object.entries(models)) {
    modelBreakdown[model] = {
      calls: d.calls,
      costUSD: d.costUSD,
      savingsUSD: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
    }
    totalCost += d.costUSD
    totalCalls += d.calls
  }
  const costUSD = spec.modelCosts ? totalCost : spec.costUSD
  const calls = spec.modelCosts ? totalCalls : spec.calls
  return {
    sessionId: spec.sessionId,
    project: 'proj',
    firstTimestamp: spec.firstTimestamp ?? '2026-03-10T10:00:00.000Z',
    lastTimestamp: spec.firstTimestamp ?? '2026-03-10T11:00:00.000Z',
    totalCostUSD: costUSD,
    totalSavingsUSD: 0,
    totalInputTokens: spec.inputTokens ?? 0,
    totalOutputTokens: spec.outputTokens ?? 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: spec.cacheReadTokens ?? 0,
    totalCacheWriteTokens: spec.cacheWriteTokens ?? 0,
    apiCalls: calls,
    turns: [],
    modelBreakdown,
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
  } as SessionSummary
}

function makeProject(project: string, sessions: SessionSummary[]): ProjectSummary {
  const totalCostUSD = sessions.reduce((s, sess) => s + sess.totalCostUSD, 0)
  return {
    project,
    projectPath: project,
    sessions,
    totalCostUSD,
    totalSavingsUSD: 0,
    totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    totalProxiedCostUSD: 0,
  }
}

const RANGE_A = { from: '2026-03-02', to: '2026-03-08' }
const RANGE_B = { from: '2026-03-09', to: '2026-03-15' }

// The acceptance fixture: A: X=70, Y=30 → 100. B: X=90, Z=70 → 160.
// Differences X=+20, Y=−30, Z=+70, total=+60. Every complete lens must
// reconcile the global difference before display rounding.
function acceptanceFixture(): { projectsA: ProjectSummary[]; projectsB: ProjectSummary[] } {
  return {
    projectsA: [
      makeProject('/work/x', [makeSession({ sessionId: 'x1', model: 'model-x', costUSD: 70, calls: 7 })]),
      makeProject('/work/y', [makeSession({ sessionId: 'y1', model: 'model-y', costUSD: 30, calls: 3 })]),
    ],
    projectsB: [
      makeProject('/work/x', [makeSession({ sessionId: 'x1', model: 'model-x', costUSD: 90, calls: 9 })]),
      makeProject('/work/z', [makeSession({ sessionId: 'z1', model: 'model-z', costUSD: 70, calls: 7 })]),
    ],
  }
}

function lensSum(rows: Array<{ diff: number }>): number {
  return rows.reduce((s, row) => s + row.diff, 0)
}

describe('buildPeriodDiffReport — acceptance fixture', () => {
  it('keeps same-label projects separate by canonical path through drill-down', () => {
    const one = { ...makeProject('app', [makeSession({ sessionId: 'shared', costUSD: 3, calls: 1 })]), projectPath: '/work/a/app' }
    const two = { ...makeProject('app', [makeSession({ sessionId: 'shared', costUSD: 5, calls: 1 })]), projectPath: '/work/b/app' }
    const report = buildPeriodDiffReport({ provider: 'all', rangeA: RANGE_A, rangeB: RANGE_B, projectsA: [], projectsB: [one, two] })
    expect(report.projects.map(p => [p.key, p.costB])).toEqual([['/work/b/app', 5], ['/work/a/app', 3]])
    expect(lensSum(report.projects)).toBe(report.totals.diff.cost)
    expect(diffSessions([], [one, two], 'project', '/work/a/app')).toMatchObject([{ costB: 3 }])
    expect(diffSessions([], [one, two], 'project', '/work/b/app')).toMatchObject([{ costB: 5 }])
    expect(diffSessions([], [one, two], 'project', 'app')).toEqual([])
  })

  it('adds multiple summaries of the same canonical project instead of overwriting', () => {
    const one = makeProject('/work/app', [makeSession({ sessionId: 'one', costUSD: 3, calls: 1 })])
    const two = makeProject('/work/app', [makeSession({ sessionId: 'two', costUSD: 5, calls: 1 })])
    const report = buildPeriodDiffReport({ provider: 'all', rangeA: RANGE_A, rangeB: RANGE_B, projectsA: [], projectsB: [one, two] })
    expect(report.projects).toMatchObject([{ key: '/work/app', costB: 8, callsB: 2 }])
  })

  const { projectsA, projectsB } = acceptanceFixture()
  const report = buildPeriodDiffReport({ provider: 'all', rangeA: RANGE_A, rangeB: RANGE_B, projectsA, projectsB })

  it('reports the global difference B − A', () => {
    expect(report.totals.A.cost).toBe(100)
    expect(report.totals.B.cost).toBe(160)
    expect(report.totals.diff.cost).toBe(60)
    expect(report.totals.pct.cost).toBeCloseTo(60, 10)
  })

  it('reconciles the project lens with the global difference', () => {
    const x = report.projects.find(row => row.key === '/work/x')
    const y = report.projects.find(row => row.key === '/work/y')
    const z = report.projects.find(row => row.key === '/work/z')
    expect(x).toMatchObject({ costA: 70, costB: 90, diff: 20, status: 'up' })
    expect(y).toMatchObject({ costA: 30, costB: 0, diff: -30, status: 'gone' })
    expect(z).toMatchObject({ costA: 0, costB: 70, diff: 70, status: 'new' })
    expect(y!.pct).toBeCloseTo(-100, 10)
    expect(z!.pct).toBeNull() // New: no infinite percentage.
    expect(lensSum(report.projects)).toBeCloseTo(report.totals.diff.cost, 10)
  })

  it('reconciles the separate model lens with the same global difference', () => {
    const byKey = new Map(report.models.map(row => [row.key, row]))
    expect(byKey.get('model-x')!.diff).toBe(20)
    expect(byKey.get('model-y')!.diff).toBe(-30)
    expect(byKey.get('model-z')!.diff).toBe(70)
    expect(lensSum(report.models)).toBeCloseTo(report.totals.diff.cost, 10)
    // Lenses are perspectives, not partitions to be summed together — the
    // report carries them separately and nothing adds projects + models.
  })

  it('shows both ranges, their duration, and disjointness', () => {
    expect(report.rangeA).toMatchObject({ from: '2026-03-02', to: '2026-03-08', days: 7 })
    expect(report.rangeB).toMatchObject({ from: '2026-03-09', to: '2026-03-15', days: 7 })
    expect(report.durationDeltaDays).toBe(0)
    expect(report.overlapDays).toBe(0)
  })

  it('normalizes per day and per 100 calls with explicit denominators', () => {
    // A: $100 over 10 calls → $10/call → $1000 per 100 calls; B: $160/16 calls.
    expect(report.normalized.perDay).toMatchObject({ a: 100 / 7, b: 160 / 7 })
    expect(report.normalized.per100Calls).toMatchObject({ a: 1000, b: 1000, diff: 0 })
    expect(report.normalized.denominators.perDay).toContain('A: 7')
    expect(report.normalized.denominators.per100Calls).toContain('calls × 100')
  })
})

describe('edge cases', () => {
  it('A = 0: every row is New, no percentage is invented, per-100-calls is unavailable', () => {
    const report = buildPeriodDiffReport({
      provider: 'all',
      rangeA: RANGE_A,
      rangeB: RANGE_B,
      projectsA: [],
      projectsB: [makeProject('/work/z', [makeSession({ sessionId: 'z1', model: 'model-z', costUSD: 70, calls: 7 })])],
    })
    expect(report.totals.A.cost).toBe(0)
    expect(report.totals.diff.cost).toBe(70)
    expect(report.projects).toHaveLength(1)
    expect(report.projects[0]).toMatchObject({ status: 'new', pct: null, diff: 70 })
    expect(report.models[0]).toMatchObject({ status: 'new', pct: null })
    // No calls in A → cost per 100 calls is unavailable, not zero and not ∞.
    expect(report.normalized.per100Calls.a).toBeNull()
    expect(report.normalized.per100Calls.diff).toBeNull()
    // Per-day still works: 0 days with data is a zero denominator too.
    expect(report.normalized.perDay.a).toBe(0)
  })

  it('B = 0: every row is Gone, the difference is −A', () => {
    const report = buildPeriodDiffReport({
      provider: 'all',
      rangeA: RANGE_A,
      rangeB: RANGE_B,
      projectsA: [makeProject('/work/y', [makeSession({ sessionId: 'y1', model: 'model-y', costUSD: 30, calls: 3 })])],
      projectsB: [],
    })
    expect(report.totals.diff.cost).toBe(-30)
    expect(report.projects[0]).toMatchObject({ status: 'gone', diff: -30 })
    expect(report.projects[0]!.pct).toBeCloseTo(-100, 10)
    expect(report.normalized.per100Calls.b).toBeNull()
  })

  it('ranges of different lengths normalize honestly and report the duration delta', () => {
    const report = buildPeriodDiffReport({
      provider: 'all',
      rangeA: { from: '2026-03-02', to: '2026-03-08' }, // 7 days
      rangeB: { from: '2026-03-09', to: '2026-03-22' }, // 14 days
      projectsA: [makeProject('/w', [makeSession({ sessionId: 'a', costUSD: 70, calls: 7 })])],
      projectsB: [makeProject('/w', [makeSession({ sessionId: 'b', costUSD: 140, calls: 14 })])],
    })
    expect(report.durationDeltaDays).toBe(7)
    expect(report.normalized.perDay).toMatchObject({ a: 10, b: 10, diff: 0 })
    // Raw totals doubled, normalized per day did not — the view must show both.
    expect(report.totals.diff.cost).toBe(70)
  })

  it('overlapping ranges report their overlap in days', () => {
    const report = buildPeriodDiffReport({
      provider: 'all',
      rangeA: { from: '2026-03-05', to: '2026-03-11' },
      rangeB: { from: '2026-03-09', to: '2026-03-15' },
      projectsA: [makeProject('/w', [makeSession({ sessionId: 'a', costUSD: 1, calls: 1 })])],
      projectsB: [makeProject('/w', [makeSession({ sessionId: 'b', costUSD: 2, calls: 1 })])],
    })
    expect(report.overlapDays).toBe(3) // Mar 9, 10, 11.
  })

  it('unpriced models and estimated cost are surfaced as coverage, not hidden', () => {
    // 'mystery-model' has calls but no price → cost 0 and it lands in
    // unpricedModels via the shared buildPeriodData rules.
    const report = buildPeriodDiffReport({
      provider: 'all',
      rangeA: RANGE_A,
      rangeB: RANGE_B,
      projectsA: [makeProject('/w', [makeSession({ sessionId: 'a', model: 'mystery-model', costUSD: 0, calls: 4 })])],
      projectsB: [makeProject('/w', [makeSession({ sessionId: 'b', model: 'claude-sonnet-4-5', costUSD: 5, calls: 4 })])],
    })
    expect(report.coverage.unpricedModelsA.map(m => m.model)).toContain('mystery-model')
    expect(report.coverage.pricingCoverageA).toBeLessThan(1)
  })
})

describe('calendar arithmetic', () => {
  it('counts days across a month boundary by walking local midnights', () => {
    expect(countLocalDays('2026-02-27', '2026-03-03')).toBe(5)
    expect(countLocalDays('2026-01-31', '2026-02-01')).toBe(2)
  })

  it('counts days across DST transitions without millisecond math', () => {
    // US DST starts 2026-03-08; EU DST starts 2026-10-25 and ends 2026-03-29.
    // Whatever the runner's timezone, a calendar walk counts calendar days.
    expect(countLocalDays('2026-03-07', '2026-03-09')).toBe(3)
    expect(countLocalDays('2026-10-24', '2026-10-26')).toBe(3)
    expect(countLocalDays('2026-03-28', '2026-03-30')).toBe(3)
  })

  it('defaults to the last seven complete days vs the seven before', () => {
    const ranges = defaultSevenDayRanges(new Date(2026, 2, 15, 12, 0, 0)) // Mar 15 2026, noon local
    expect(ranges.B).toEqual({ from: '2026-03-08', to: '2026-03-14' })
    expect(ranges.A).toEqual({ from: '2026-03-01', to: '2026-03-07' })
    expect(rangeInfo(ranges.A).days).toBe(7)
    expect(rangeInfo(ranges.B).days).toBe(7)
    // Today (Mar 15) is deliberately outside both ranges: it is not complete.
  })

  it('rejects inverted ranges as zero days', () => {
    expect(countLocalDays('2026-03-10', '2026-03-01')).toBe(0)
  })

  it('round-trips a DateRange through localRangeInfo', () => {
    const info = localRangeInfo({ start: new Date(2026, 2, 9), end: new Date(2026, 2, 15, 23, 59, 59, 999) })
    expect(info).toEqual({ from: '2026-03-09', to: '2026-03-15', days: 7 })
  })
})

describe('sessions spanning the A/B boundary', () => {
  // The parser hands each range a post-slice tree: the same session carries
  // only its in-range calls on each side. The drill-down must join the two
  // halves into ONE row keyed by the canonical identity — never two sessions.
  it('joins both halves of a boundary-straddling session', () => {
    const session = (cost: number, calls: number): SessionSummary =>
      makeSession({ sessionId: 'straddle-1', model: 'model-x', costUSD: cost, calls, title: 'long run' })
    const report = buildPeriodDiffReport({
      provider: 'all',
      rangeA: RANGE_A,
      rangeB: RANGE_B,
      projectsA: [makeProject('/work/x', [session(30, 3)])],
      projectsB: [makeProject('/work/x', [session(40, 4)])],
    })
    expect(report.projects).toHaveLength(1)
    expect(report.projects[0]).toMatchObject({ costA: 30, costB: 40, diff: 10 })

    const rows = diffSessions(
      [makeProject('/work/x', [session(30, 3)])],
      [makeProject('/work/x', [session(40, 4)])],
      'project',
      '/work/x',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: 'straddle-1', costA: 30, costB: 40, diff: 10, callsA: 3, callsB: 4 })
    expect(rows[0]!.identity).toContain('straddle-1')
  })

  it('drills by model across projects and by project across models', () => {
    const a = [makeProject('/w1', [makeSession({ sessionId: 's1', modelCosts: { 'm-a': { costUSD: 10, calls: 1 }, 'm-b': { costUSD: 5, calls: 1 } } })])]
    const b = [makeProject('/w2', [makeSession({ sessionId: 's2', modelCosts: { 'm-a': { costUSD: 25, calls: 2 } } })])]
    // Two DIFFERENT sessions (a bare sessionId is not globally unique — the
    // identity includes the project path), so the model lens yields two rows.
    const byModel = diffSessions(a, b, 'model', 'm-a')
    expect(byModel).toHaveLength(2)
    const pairA = byModel.find(row => row.costA === 10)
    const pairB = byModel.find(row => row.costB === 25)
    expect(pairA).toMatchObject({ costB: 0, diff: -10 })
    expect(pairB).toMatchObject({ costA: 0, diff: 25 })
    expect(lensSum(byModel)).toBe(15)
    // m-b exists only in A → its own row, status via negative diff.
    const goneModel = diffSessions(a, b, 'model', 'm-b')
    expect(goneModel).toHaveLength(1)
    expect(goneModel[0]).toMatchObject({ costA: 5, costB: 0, diff: -5 })
    const byProject = diffSessions(a, b, 'project', '/w2')
    expect(byProject).toHaveLength(1)
    expect(byProject[0]).toMatchObject({ costA: 0, costB: 25 })
  })
})

function day(date: string, cost: number, carried?: true): DailyEntry {
  return {
    date,
    cost,
    savingsUSD: 0,
    calls: 1,
    sessions: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: {},
    ...(carried ? { carried: true as const } : {}),
  }
}

describe('history basis (aggregate-only carried history)', () => {
  const cache: DailyCache = {
    version: 21,
    savingsConfigHash: '',
    lastComputedDate: '2026-03-15',
    days: [
      day('2026-03-03', 10),          // fully explained by detail
      day('2026-03-05', 12, true),    // sources gone: 12 in history, 0 in detail
      day('2026-03-11', 4),           // explained
      day('2026-03-13', 9, true),     // sources gone on the B side
    ],
  }

  it('lists only the days history holds that session detail cannot explain', () => {
    const freshA = [day('2026-03-03', 10)]
    const freshB = [day('2026-03-11', 4)]
    const basis = historyBasis(cache, RANGE_A, RANGE_B, 'all', freshA, freshB)
    expect(basis.aggregateOnly.A).toBeCloseTo(12, 10)
    expect(basis.aggregateOnly.B).toBeCloseTo(9, 10)
    expect(basis.days.A.map(row => row.date)).toEqual(['2026-03-05'])
    expect(basis.days.B.map(row => row.date)).toEqual(['2026-03-13'])
    // The totals NEVER include the aggregate-only amount: the detail basis
    // stays reconciled with its own lenses.
    expect(basis.detailCost.A).toBe(10)
    expect(basis.historyCost.A).toBe(22)
  })

  it('never reports a negative unexplained remainder when detail leads history', () => {
    const plainCache: DailyCache = { ...cache, days: [day('2026-03-03', 10)] }
    const basis = historyBasis(plainCache, RANGE_A, RANGE_B, 'all', [day('2026-03-03', 15)], [])
    expect(basis.aggregateOnly.A).toBe(0)
    expect(basis.days.A).toHaveLength(0)
  })
})

describe('overlap helper', () => {
  it('handles disjoint and identical ranges', () => {
    expect(overlapDays({ from: '2026-03-01', to: '2026-03-07' }, { from: '2026-03-09', to: '2026-03-15' })).toBe(0)
    expect(overlapDays(RANGE_A, RANGE_A)).toBe(7)
  })
})
