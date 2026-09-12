// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohortComparisonReport, CompareJsonReport, ModelStats } from '../lib/types'
import { Compare } from './Compare'

const mocks = vi.hoisted(() => ({
  getCompareModels: vi.fn<(period: string, provider: string) => Promise<ModelStats[]>>(),
  getCompare: vi.fn<(period: string, provider: string, modelA: string, modelB: string) => Promise<CompareJsonReport>>(),
  getCompareCohortModels: vi.fn<(period: string, provider: string) => Promise<import('../lib/types').CohortFacets>>(),
  getCompareCohort: vi.fn<(period: string, provider: string, modelA: string, modelB: string, range?: unknown, projects?: string[], category?: string) => Promise<CohortComparisonReport>>(),
  telemetryTrack: vi.fn<(name: string, props?: Record<string, unknown>) => Promise<boolean>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

const modelA: ModelStats = {
  model: 'Opus 4.8', calls: 4812, cost: 331.2, outputTokens: 9_640_000, inputTokens: 152_600_000,
  cacheReadTokens: 119_400_000, cacheWriteTokens: 16_000_000, totalTurns: 1000, editTurns: 786,
  oneShotTurns: 558, retries: 267, selfCorrections: 33, editCost: 0.42,
  firstSeen: '2026-06-12T00:00:00.000Z', lastSeen: '2026-07-11T00:00:00.000Z',
}
const modelB: ModelStats = {
  model: 'Sonnet 5', calls: 3318, cost: 108.63, outputTokens: 6_080_000, inputTokens: 77_700_000,
  cacheReadTokens: 63_300_000, cacheWriteTokens: 7_000_000, totalTurns: 850, editTurns: 641,
  oneShotTurns: 404, retries: 300, selfCorrections: 40, editCost: 0.19,
  firstSeen: '2026-06-14T00:00:00.000Z', lastSeen: '2026-07-11T00:00:00.000Z',
}
const report: CompareJsonReport = {
  period: { label: 'Last 30 days', provider: 'all' },
  modelA,
  modelB,
  metrics: [
    { section: 'Performance', label: 'One-shot rate', valueA: 71, valueB: 63, formatFn: 'percent', winner: 'a' },
    { section: 'Efficiency', label: 'Cost / call', valueA: 0.069, valueB: 0.033, formatFn: 'cost', winner: 'b' },
  ],
  categories: [
    { category: 'Coding', turnsA: 400, editTurnsA: 312, oneShotRateA: 74, turnsB: 350, editTurnsB: 280, oneShotRateB: 66, winner: 'a' },
  ],
  workingStyle: [
    { label: 'Planning rate', valueA: 22, valueB: 9, formatFn: 'percent' },
  ],
}

describe('Compare', () => {
  beforeEach(() => {
    mocks.getCompareModels.mockReset()
    mocks.getCompare.mockReset()
    mocks.getCompareCohortModels.mockReset()
    mocks.getCompareCohort.mockReset()
    mocks.telemetryTrack.mockReset().mockResolvedValue(true)
  })

  it('reports each distinct pair put on screen as a name-only compare_view', async () => {
    const user = userEvent.setup()
    mocks.getCompareModels.mockResolvedValue([modelA, modelB])
    mocks.getCompare.mockResolvedValue(report)
    render(<Compare period="30days" provider="all" />)

    await waitFor(() => expect(mocks.telemetryTrack).toHaveBeenCalledWith('compare_view', { modelA: 'Opus 4.8', modelB: 'Sonnet 5' }))
    expect(mocks.telemetryTrack).toHaveBeenCalledTimes(1)

    // Re-rendering the same pair does not fire again.
    await user.click(await screen.findByLabelText('First model'))
    await user.click(screen.getByRole('option', { name: 'Opus 4.8 · 4,812 calls' }))
    expect(mocks.telemetryTrack).toHaveBeenCalledTimes(1)
  })

  it('defaults to the top two and renders formatted report panels and winners', async () => {
    const user = userEvent.setup()
    mocks.getCompareModels.mockResolvedValue([modelA, modelB])
    mocks.getCompare.mockResolvedValue(report)
    render(<Compare period="30days" provider="all" />)

    const first = await screen.findByLabelText('First model')
    const second = screen.getByLabelText('Second model')
    await waitFor(() => {
      expect(first).toHaveTextContent('Opus 4.8 · 4,812 calls')
      expect(second).toHaveTextContent('Sonnet 5 · 3,318 calls')
    })

    expect(await screen.findByText('Performance')).toBeInTheDocument()
    expect(mocks.getCompare).toHaveBeenCalledWith('30days', 'all', 'Opus 4.8', 'Sonnet 5')
    expect(screen.getByText('Efficiency')).toBeInTheDocument()
    expect(screen.getByText('Context')).toBeInTheDocument()
    expect(screen.getByText('71%')).toHaveClass('cmp-best')
    expect(screen.getByText('$0.03')).toHaveClass('cmp-best')
    expect(screen.getByText('$331.20')).toBeInTheDocument()
    expect(screen.getByText('152.6M')).toBeInTheDocument()
    expect(screen.getByText('9.6M')).toBeInTheDocument()

    const context = screen.getByText('Context').closest<HTMLElement>('.cmp-card')!
    expect(within(context).getByText('Cache hit rate')).toBeInTheDocument()
    expect(within(context).getByText('Days of data')).toBeInTheDocument()

    await user.click(second)
    await user.click(screen.getByRole('option', { name: 'Opus 4.8 · 4,812 calls' }))
    await waitFor(() => expect(first).toHaveTextContent('Sonnet 5 · 3,318 calls'))
    expect(mocks.getCompare).toHaveBeenCalledWith('30days', 'all', 'Sonnet 5', 'Opus 4.8')
  })

  it('computes cache hit rate over input + cache reads (excludes cache writes)', async () => {
    mocks.getCompareModels.mockResolvedValue([modelA, modelB])
    mocks.getCompare.mockResolvedValue(report)
    render(<Compare period="30days" provider="all" />)

    const context = (await screen.findByText('Context')).closest<HTMLElement>('.cmp-card')!
    const row = within(context).getByText('Cache hit rate').closest('.cmp-metric')!
    // 119.4M / (152.6M + 119.4M) = 44%, not 119.4 / (152.6 + 119.4 + 16) = 41%.
    expect(row).toHaveTextContent('44%')
    expect(row).not.toHaveTextContent('41%')
  })

  it('notes that custom ranges are unsupported and still compares by period', async () => {
    mocks.getCompareModels.mockResolvedValue([modelA, modelB])
    mocks.getCompare.mockResolvedValue(report)
    render(<Compare period="30days" provider="all" range={{ from: '2026-07-01', to: '2026-07-11' }} />)

    expect(await screen.findByText('Compare uses the selected period, custom dates are not supported yet.')).toBeInTheDocument()
    expect(mocks.getCompareModels).toHaveBeenCalledWith('30days', 'all')
  })

  it('renders the need-two-models note without requesting a report', async () => {
    mocks.getCompareModels.mockResolvedValue([modelA])
    render(<Compare period="week" provider="all" />)

    expect(await screen.findByText('Need at least two models with usage in this range to compare.')).toBeInTheDocument()
    expect(mocks.getCompare).not.toHaveBeenCalled()
  })
})

// ————— Cohorts mode —————

const cohortReport: CohortComparisonReport = {
  kind: 'cohort-comparison',
  period: { label: 'Last 30 days', provider: 'all' },
  selection: { projects: [], category: null, from: null, to: null },
  conventions: {
    percentile: 'linear interpolation at position (N-1)*p',
    contextProxy: 'input + cache-read tokens (proxy, not a measured context window)',
    attribution: 'observation cost = recorded cost of the owning model\'s calls in the turn',
  },
  modelA: {
    model: 'Opus 4.8',
    label: 'Opus 4.8',
    stats: {
      model: 'Opus 4.8', label: 'Opus 4.8', observationCount: 4, distinctSessionCount: 2,
      retryCount: 3, retryRate: 0.75, oneShotCount: 2, oneShotRate: 50,
      costKnownCount: 4, unknownCostCount: 0,
      costMedian: 3, costP90: 6.8, costMean: 3.75,
      costHistogram: { edges: [1, 2, 3, 4, 5, 6, 7], counts: [1, 1, 0, 1, 0, 0, 0, 1] },
      volume: { outputMedian: 500, outputP90: 900, inputMedian: 1000, inputP90: 2000, contextProxyMedian: 3000, contextProxyP90: 5000, missingMeasureCount: 0 },
    },
    observations: [
      { sessionId: 's1', project: '/work/app', timestamp: '2026-08-14T10:00:00Z', category: 'coding', model: 'Opus 4.8', costUSD: 1, costKnown: true, retries: 1, oneShot: false, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100, contextProxyTokens: 3000, tokensReported: true },
      { sessionId: 's1', project: '/work/app', timestamp: '2026-08-14T11:00:00Z', category: 'coding', model: 'Opus 4.8', costUSD: 2, costKnown: true, retries: 0, oneShot: true, inputTokens: 1200, outputTokens: 600, cacheReadTokens: 2200, cacheWriteTokens: 100, contextProxyTokens: 3400, tokensReported: true },
      { sessionId: 's2', project: '/work/kit', timestamp: '2026-08-15T10:00:00Z', category: 'debugging', model: 'Opus 4.8', costUSD: 4, costKnown: true, retries: 2, oneShot: false, inputTokens: 1500, outputTokens: 800, cacheReadTokens: 3000, cacheWriteTokens: 100, contextProxyTokens: 4500, tokensReported: true },
      { sessionId: 's2', project: '/work/kit', timestamp: '2026-08-15T11:00:00Z', category: 'coding', model: 'Opus 4.8', costUSD: 8, costKnown: true, retries: 0, oneShot: true, inputTokens: 4000, outputTokens: 900, cacheReadTokens: 5000, cacheWriteTokens: 100, contextProxyTokens: 9000, tokensReported: true },
    ],
    exclusions: { multiModelTurnCount: 1, combinedMultiModelCostUSD: 0.15, noBehavioralModelTurns: 0 },
  },
  modelB: {
    model: 'Sonnet 5',
    label: 'Sonnet 5',
    stats: {
      model: 'Sonnet 5', label: 'Sonnet 5', observationCount: 0, distinctSessionCount: 0,
      retryCount: 0, retryRate: null, oneShotCount: 0, oneShotRate: null,
      costKnownCount: 0, unknownCostCount: 0,
      costMedian: null, costP90: null, costMean: null,
      costHistogram: { edges: [], counts: [] },
      volume: { outputMedian: null, outputP90: null, inputMedian: null, inputP90: null, contextProxyMedian: null, contextProxyP90: null, missingMeasureCount: 0 },
    },
    observations: [],
    exclusions: { multiModelTurnCount: 1, combinedMultiModelCostUSD: 0.15, noBehavioralModelTurns: 0 },
  },
}

const facets = {
  kind: 'cohort-facets' as const,
  models: [modelA, modelB],
  projects: [
    { project: '/work/app', projectPath: '/work/app', sessions: 1, costUSD: 10 },
    { project: '/work/kit', projectPath: '/work/kit', sessions: 1, costUSD: 5 },
  ],
  categories: [
    { id: 'coding', label: 'Coding' },
    { id: 'debugging', label: 'Debugging' },
  ],
}

describe('Compare cohorts mode', () => {
  beforeEach(() => {
    mocks.getCompareModels.mockReset()
    mocks.getCompare.mockReset()
    mocks.getCompareCohortModels.mockReset()
    mocks.getCompareCohort.mockReset()
    mocks.telemetryTrack.mockReset().mockResolvedValue(true)
    // The classic view mounts first (the mode switch lives inside it), so the
    // classic mocks need implementations even in cohort-only tests.
    mocks.getCompareModels.mockResolvedValue([modelA, modelB])
    mocks.getCompare.mockResolvedValue(report)
    mocks.getCompareCohortModels.mockResolvedValue(facets)
    mocks.getCompareCohort.mockResolvedValue(cohortReport)
  })

  async function openCohorts() {
    const user = userEvent.setup()
    render(<Compare period="30days" provider="all" />)
    await user.click(await screen.findByRole('tab', { name: 'Cohorts' }))
    await screen.findByLabelText('Cohort first model')
    await screen.findByLabelText('Cohort second model')
    await screen.findByText('Population')
    return user
  }

  it('shows the population disclosure before the metrics and requests the cohort report', async () => {
    await openCohorts()
    expect(mocks.getCompareCohort).toHaveBeenCalledWith('30days', 'all', 'Opus 4.8', 'Sonnet 5', undefined, undefined, undefined)
    // Exclusion ledger visible: mixed-model turns with their combined cost.
    expect(screen.getAllByText(/Excluded turns mixing models/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('1 ($0.15)').length).toBe(2)
    // Metrics cards render the pinned convention numbers.
    expect(screen.getAllByText('$3.00').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('$6.80').length).toBeGreaterThanOrEqual(1)
  })

  it('renders a zero-observation cohort as explicit emptiness, not zeros', async () => {
    const user = await openCohorts()
    const second = screen.getByLabelText('Cohort second model')
    // Keep Sonnet 5 selected: its cohort is empty → the sample card explains it.
    expect(second).toBeInTheDocument()
    expect(await screen.findByText(/No observations match the current selection/)).toBeInTheDocument()
    expect(mocks.getCompareCohort).toHaveBeenCalled()
    void user
  })

  it('passes a project selection through so out-of-selection observations are excluded before calculation', async () => {
    const user = await openCohorts()
    await user.click(screen.getByLabelText('Cohort project'))
    await user.click(await screen.findByRole('option', { name: 'work/app' }))
    await waitFor(() => expect(mocks.getCompareCohort).toHaveBeenCalledWith('30days', 'all', 'Opus 4.8', 'Sonnet 5', undefined, ['/work/app'], undefined))
  })

  it('applies a volume band from the declared population and shows what it excluded', async () => {
    const user = await openCohorts()
    // Band on output tokens [0, 700]: keeps 2 of the 4 Opus observations
    // (output 500 and 600); the 800 and 900 ones are excluded and counted.
    await user.type(screen.getByLabelText('Volume band minimum'), '0')
    await user.type(screen.getByLabelText('Volume band maximum'), '700')
    await waitFor(() => expect(screen.getByText(/Volume band excludes 2 observation/)).toBeInTheDocument())
    // The recomputed median over the kept costs [1, 2] is 1.5.
    expect(screen.getAllByText('$1.50').length).toBeGreaterThanOrEqual(1)
  })

  it('counts band exclusions of observations without token data, never reading them as small', async () => {
    const user = await openCohorts()
    // A report as the CLI would answer for the /work/app project: two
    // token-bearing observations plus one with NO token measure at all.
    const withMissing = {
      ...cohortReport,
      modelA: {
        ...cohortReport.modelA,
        observations: [
          cohortReport.modelA.observations[0]!,
          cohortReport.modelA.observations[1]!,
          { sessionId: 's3', project: '/work/app', timestamp: '2026-08-16T10:00:00Z', category: 'coding', model: 'Opus 4.8', costUSD: 0.5, costKnown: true, retries: 0, oneShot: true, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextProxyTokens: 0, tokensReported: false },
        ],
      },
    }
    mocks.getCompareCohort.mockResolvedValue(withMissing)
    // A new selection = a new memo key = a real re-fetch of the new payload.
    await user.click(screen.getByLabelText('Cohort project'))
    await user.click(await screen.findByRole('option', { name: 'work/app' }))
    await user.type(screen.getByLabelText('Volume band minimum'), '0')
    await user.type(screen.getByLabelText('Volume band maximum'), '700')
    await waitFor(() => expect(screen.getByText(/without any token measure/)).toBeInTheDocument())
    // The missing-measure observation is excluded from the banded stats
    // (2 of the 4 observations in the spread mock survive the band; the mock
    // carries the original stats object, hence 4). The first Inspect samples
    // card is model A's.
    expect(screen.getAllByText('Inspect samples')[0]!.closest('.cmp-card')).toHaveTextContent('2 of 4 in selection')
  })

  it('returns to the classic comparison unchanged', async () => {
    const user = await openCohorts()
    mocks.getCompareModels.mockResolvedValue([modelA, modelB])
    mocks.getCompare.mockResolvedValue(report)
    await user.click(screen.getByRole('tab', { name: 'Classic' }))
    expect(await screen.findByLabelText('First model')).toBeInTheDocument()
    expect(await screen.findByText('Performance')).toBeInTheDocument()
  })
})
