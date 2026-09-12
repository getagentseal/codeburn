import { describe, expect, it } from 'vitest'

import {
  buildCohortComparison,
  buildCohortFacets,
  computeCohortStats,
  costHistogram,
  extractCohortObservations,
  linearPercentile,
  medianOf,
  type CohortObservation,
} from '../src/compare-cohorts.js'
import { findModelStat } from '../src/compare-stats.js'
import { getShortModelName } from '../src/models.js'
import type { ClassifiedTurn, ProjectSummary, SessionSummary } from '../src/types.js'

let keySeq = 0

function makeTurn(model: string | string[], cost: number, opts: {
  hasEdits?: boolean
  retries?: number
  category?: string
  timestamp?: string
  sessionId?: string
  outputTokens?: number
  inputTokens?: number
  unpriced?: boolean
  extraCalls?: Array<{ model: string; cost: number }>
} = {}): ClassifiedTurn {
  const models = Array.isArray(model) ? model : [model]
  const calls = models.map((m, i) => ({
    provider: 'claude',
    model: m,
    usage: {
      inputTokens: opts.inputTokens ?? 1200,
      outputTokens: opts.outputTokens ?? 300,
      cacheCreationInputTokens: 400,
      cacheReadInputTokens: 5000,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: i === 0 ? cost : 0,
    tools: opts.hasEdits === false ? ['Read'] : ['Edit'],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard' as const,
    timestamp: opts.timestamp ?? '2026-08-15T10:00:00Z',
    bashCommands: [],
    deduplicationKey: `key-${keySeq++}`,
  }))
  for (const extra of opts.extraCalls ?? []) {
    calls.push({
      provider: 'claude',
      model: extra.model,
      usage: {
        inputTokens: 1000,
        outputTokens: 250,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 4000,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
      },
      costUSD: extra.cost,
      tools: ['Edit'],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard' as const,
      timestamp: opts.timestamp ?? '2026-08-15T10:00:00Z',
      bashCommands: [],
      deduplicationKey: `key-${keySeq++}`,
    })
  }
  return {
    timestamp: opts.timestamp ?? '2026-08-15T10:00:00Z',
    category: (opts.category ?? 'coding') as ClassifiedTurn['category'],
    retries: opts.retries ?? 0,
    hasEdits: opts.hasEdits ?? true,
    userMessage: '',
    sessionId: opts.sessionId ?? 'sess-1',
    assistantCalls: calls,
  }
}

function makeSession(sessionId: string, turns: ClassifiedTurn[]): SessionSummary {
  return {
    sessionId,
    project: 'proj-a',
    firstTimestamp: turns[0]?.timestamp ?? '',
    lastTimestamp: turns[turns.length - 1]?.timestamp ?? '',
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.reduce((s, t) => s + t.assistantCalls.length, 0),
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {} as SessionSummary['skillBreakdown'],
  }
}

function makeProject(sessionId: string, turns: ClassifiedTurn[], project = 'proj-a'): ProjectSummary {
  const session = makeSession(sessionId, turns)
  session.project = project
  return {
    project,
    projectPath: `/work/${project}`,
    sessions: [session],
    totalCostUSD: 0,
    totalProxiedCostUSD: 0,
    totalApiCalls: session.apiCalls,
  }
}

// ————— The pinned percentile convention —————

describe('percentile convention (pinned)', () => {
  it('gives median 3 and P90 6.8 for [1, 2, 4, 8] with linear interpolation at (N-1)*p', () => {
    const sorted = [1, 2, 4, 8]
    expect(medianOf(sorted)).toBe(3)
    expect(linearPercentile(sorted, 0.9)).toBeCloseTo(6.8, 10)
  })

  it('interpolates at exact positions without rounding', () => {
    expect(linearPercentile([10, 20], 0.5)).toBe(15)
    expect(linearPercentile([10], 0.9)).toBe(10)
    expect(linearPercentile([], 0.9)).toBeNull()
  })
})

// ————— Observation extraction —————

describe('extractCohortObservations', () => {
  it('owns an edit turn by its single behavioral model and attributes only that model\'s cost', () => {
    // One turn: opus behavioral call ($0.10) + sonnet behavioral call ($0.05)
    // would be MULTI-model; here instead: opus call costs 0.10, a second call
    // of the SAME model adds 0.02 — both belong to the observation.
    const project = makeProject('s1', [
      makeTurn('opus-4-6', 0.10, { extraCalls: [{ model: 'opus-4-6', cost: 0.02 }] }),
    ])
    const { perModel, exclusions } = extractCohortObservations({ projects: [project] })
    const obs = perModel.get('opus-4-6')!
    expect(obs).toHaveLength(1)
    expect(obs[0]!.costUSD).toBeCloseTo(0.12)
    expect(obs[0]!.model).toBe('opus-4-6')
    // No other model gets an observation; nothing was excluded.
    expect(perModel.size).toBe(1)
    expect(exclusions.multiModelTurns).toHaveLength(0)
  })

  it('excludes multi-model edit turns and transfers no cost to either model', () => {
    const project = makeProject('s1', [
      makeTurn(['opus-4-6', 'sonnet-5'], 0.10, { extraCalls: [{ model: 'sonnet-5', cost: 0.05 }] }),
      makeTurn('opus-4-6', 0.10),
    ])
    const { perModel, exclusions } = extractCohortObservations({ projects: [project] })
    // The mixed turn is counted once, shown with combined cost 0.15, and NO
    // cohort receives any of it. opus keeps only its own single-model turn.
    expect(exclusions.multiModelTurns).toHaveLength(1)
    expect(exclusions.multiModelTurns[0]!.models).toEqual(['opus-4-6', 'sonnet-5'])
    expect(exclusions.combinedMultiModelCostUSD).toBeCloseTo(0.15)
    expect(perModel.get('opus-4-6')).toHaveLength(1)
    expect(perModel.get('opus-4-6')![0]!.costUSD).toBeCloseTo(0.10)
    expect(perModel.has('sonnet-5')).toBe(false)
  })

  it('reports one shared exclusion ledger even when a cohort has zero observations', () => {
    const project = makeProject('s1', [
      makeTurn(['opus-4-6', 'mystery-pro-9'], 0.10, { extraCalls: [{ model: 'mystery-pro-9', cost: 0.05 }] }),
    ])
    const { exclusions } = extractCohortObservations({ projects: [project] })
    expect(exclusions.multiModelTurns).toHaveLength(1)
  })

  it('counts edit turns with no behavioral model', () => {
    const turn = makeTurn('opus-4-6', 0)
    turn.assistantCalls[0]!.supplementaryAccounting = true
    const project = makeProject('s1', [turn])
    const { perModel, exclusions } = extractCohortObservations({ projects: [project] })
    expect(exclusions.noBehavioralModelTurns).toBe(1)
    expect(perModel.size).toBe(0)
  })

  it('respects the category selection before anything is counted', () => {
    const project = makeProject('s1', [
      makeTurn('opus-4-6', 0.10, { category: 'coding' }),
      makeTurn('opus-4-6', 0.20, { category: 'debugging' }),
    ])
    const coding = extractCohortObservations({ projects: [project], category: 'coding' })
    expect(coding.perModel.get('opus-4-6')).toHaveLength(1)
    expect(coding.perModel.get('opus-4-6')![0]!.costUSD).toBeCloseTo(0.10)

    const debugging = extractCohortObservations({ projects: [project], category: 'debugging' })
    expect(debugging.perModel.get('opus-4-6')![0]!.costUSD).toBeCloseTo(0.20)
  })

  it('skips non-edit turns entirely', () => {
    const project = makeProject('s1', [makeTurn('opus-4-6', 0.10, { hasEdits: false })])
    const { perModel } = extractCohortObservations({ projects: [project] })
    expect(perModel.size).toBe(0)
  })

  it('pairs project and session for identity (a bare sessionId is not a global key)', () => {
    const p1 = makeProject('same-id', [makeTurn('opus-4-6', 0.10)], 'proj-a')
    const p2 = makeProject('same-id', [makeTurn('opus-4-6', 0.10)], 'proj-b')
    const stats = computeCohortStats('opus-4-6', [
      ...(extractCohortObservations({ projects: [p1] }).perModel.get('opus-4-6') ?? []),
      ...(extractCohortObservations({ projects: [p2] }).perModel.get('opus-4-6') ?? []),
    ])
    // Two sessions share the literal id; distinct sessions must be 2.
    expect(stats.distinctSessionCount).toBe(2)
    expect(stats.observationCount).toBe(2)
  })
})

// ————— Cost semantics: unknown ≠ zero —————

describe('unknown cost handling', () => {
  it('marks an unpriced model\'s $0 observations as unknown and keeps them out of cost stats but in retry stats', () => {
    const project = makeProject('s1', [
      makeTurn('mystery-pro-9', 0, { retries: 3 }),
      makeTurn('mystery-pro-9', 0, { retries: 0 }),
    ])
    const { perModel } = extractCohortObservations({ projects: [project] })
    const obs = perModel.get('mystery-pro-9')!
    expect(obs.every(o => !o.costKnown)).toBe(true)
    const stats = computeCohortStats('mystery-pro-9', obs)
    expect(stats.observationCount).toBe(2)
    expect(stats.unknownCostCount).toBe(2)
    expect(stats.costKnownCount).toBe(0)
    expect(stats.costMedian).toBeNull()
    expect(stats.costP90).toBeNull()
    // Retry statistics never need pricing: they still count.
    expect(stats.retryCount).toBe(3)
    expect(stats.oneShotCount).toBe(1)
    expect(stats.retryRate).toBeCloseTo(1.5)
  })

  it('keeps legitimately free models (local / flat-rate) as known-zero cost', () => {
    const project = makeProject('s1', [makeTurn('qwen3:35b', 0)])
    const { perModel } = extractCohortObservations({ projects: [project] })
    const obs = perModel.get('qwen3:35b')!
    expect(obs[0]!.costKnown).toBe(true)
    const stats = computeCohortStats('qwen3:35b', obs)
    expect(stats.unknownCostCount).toBe(0)
    expect(stats.costMedian).toBe(0)
  })
})

// ————— Cohort statistics —————

describe('computeCohortStats', () => {
  function obs(cost: number, over: Partial<CohortObservation> = {}): CohortObservation {
    return {
      sessionId: 's1',
      project: 'proj-a',
      timestamp: '2026-08-15T10:00:00Z',
      category: 'coding',
      model: 'opus-4-6',
      costUSD: cost,
      costKnown: true,
      retries: 0,
      oneShot: true,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
      contextProxyTokens: 3000,
      tokensReported: true,
      ...over,
    }
  }

  it('produces the pinned [1,2,4,8] convention through the full stats path', () => {
    const stats = computeCohortStats('opus-4-6', [obs(1), obs(2), obs(4), obs(8)])
    expect(stats.costMedian).toBe(3)
    expect(stats.costP90).toBeCloseTo(6.8, 10)
  })

  it('handles N=0 with nulls and no NaN anywhere', () => {
    const stats = computeCohortStats('opus-4-6', [])
    expect(stats.observationCount).toBe(0)
    expect(stats.costMedian).toBeNull()
    expect(stats.costP90).toBeNull()
    expect(stats.retryRate).toBeNull()
    expect(stats.oneShotRate).toBeNull()
    expect(stats.costHistogram.counts).toEqual([])
    expect(stats.volume.outputMedian).toBeNull()
    expect(JSON.stringify(stats)).not.toContain('NaN')
  })

  it('handles N=1: median and P90 both equal the single value', () => {
    const stats = computeCohortStats('opus-4-6', [obs(0.42)])
    expect(stats.costMedian).toBeCloseTo(0.42)
    expect(stats.costP90).toBeCloseTo(0.42)
    expect(stats.oneShotRate).toBe(100)
  })

  it('keeps a huge outlier in every statistic and the histogram top bucket', () => {
    const costs = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 5.0]
    const stats = computeCohortStats('opus-4-6', costs.map(c => obs(c)))
    // Outlier still in the population and the percentiles.
    expect(stats.observationCount).toBe(10)
    expect(stats.costP90).toBeGreaterThan(0.09)
    expect(stats.costMedian).toBeCloseTo(0.055)
    const hist = stats.costHistogram
    expect(hist.counts.reduce((a, b) => a + b, 0)).toBe(10)
    // The 95th-percentile edge pushes the outlier into the last bucket.
    expect(hist.counts[hist.counts.length - 1]).toBeGreaterThanOrEqual(1)
  })

  it('handles very unequal groups by never inventing values for the small one', () => {
    const big = Array.from({ length: 50 }, (_, i) => obs(0.01 * (i + 1)))
    const stats = computeCohortStats('opus-4-6', big)
    expect(stats.observationCount).toBe(50)
    expect(stats.costMedian).toBeCloseTo(0.255)
    const tiny = computeCohortStats('sonnet-5', [obs(0.9, { model: 'sonnet-5' })])
    expect(tiny.observationCount).toBe(1)
  })

  it('computes volume percentiles only over observations that report tokens', () => {
    const withTokens = obs(0.10)
    const without = obs(0.10, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, tokensReported: false })
    const stats = computeCohortStats('opus-4-6', [withTokens, without])
    expect(stats.volume.missingMeasureCount).toBe(1)
    expect(stats.volume.outputMedian).toBe(500)
    // Cost statistics still cover BOTH observations (cost is known for both).
    expect(stats.costKnownCount).toBe(2)
  })

  it('is reproducible from the report\'s observation list', () => {
    const project = makeProject('s1', [
      makeTurn('opus-4-6', 0.10, { retries: 1 }),
      makeTurn('opus-4-6', 0.30, { retries: 0 }),
      makeTurn('sonnet-5', 0.05, { retries: 2 }),
    ])
    const report = buildCohortComparison([project], 'opus-4-6', 'sonnet-5', 'Test label', 'claude')
    // Recompute the medians from the reported sample lists; they must match.
    for (const side of [report.modelA, report.modelB]) {
      const known = side.observations.filter(o => o.costKnown).map(o => o.costUSD).sort((a, b) => a - b)
      const recomputed = medianOf(known)
      expect(recomputed).toBeCloseTo(side.stats.costMedian ?? NaN)
      expect(side.stats.observationCount).toBe(side.observations.length)
    }
  })
})

// ————— Histogram determinism —————

describe('costHistogram', () => {
  it('is deterministic and totals the population', () => {
    const costs = [0.1, 0.2, 0.3, 0.4, 0.5]
    const h1 = costHistogram(costs)
    const h2 = costHistogram([...costs].reverse())
    expect(h1).toEqual(h2)
    expect(h1.counts.reduce((a, b) => a + b, 0)).toBe(costs.length)
  })

  it('collapses to a single bucket when every cost is zero', () => {
    const h = costHistogram([0, 0, 0])
    expect(h.edges).toEqual([])
    expect(h.counts).toEqual([3])
  })
})

// ————— Facets and alias resolution —————

describe('facets and model identity', () => {
  it('lists canonical project identities once with merged session counts', () => {
    const p1 = makeProject('s1', [makeTurn('opus-4-6', 0.10)], 'proj-a')
    const p2 = makeProject('s2', [makeTurn('opus-4-6', 0.10)], 'proj-a')
    const facets = buildCohortFacets([p1, p2])
    expect(facets.projects).toHaveLength(1)
    expect(facets.projects[0]!.sessions).toBe(2)
    expect(facets.categories.length).toBeGreaterThan(5)
  })

  it('resolves display-name aliases to the canonical id like the classic picker', () => {
    const project = makeProject('s1', [makeTurn('claude-opus-4-6-20260610', 0.10)])
    const facets = buildCohortFacets([project])
    const canonical = facets.models[0]!.model
    expect(canonical).toBe('claude-opus-4-6-20260610')
    // findModelStat is the shared alias-aware lookup; a display name like
    // "Opus 4.6" resolves to the same canonical row.
    const byDisplay = findModelStat(facets.models, getShortModelName(canonical))
    expect(byDisplay?.model).toBe(canonical)
  })
})
