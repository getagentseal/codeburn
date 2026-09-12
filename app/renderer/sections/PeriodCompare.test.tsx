// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PeriodDiffReport, PeriodSessionDiff } from '../lib/types'
import { __resetPolledMemo } from '../hooks/usePolled'
import { PeriodCompare, defaultSevenRanges } from './PeriodCompare'

const mocks = vi.hoisted(() => ({
  getPeriodCompare: vi.fn<(a: { from: string; to: string }, b: { from: string; to: string }, provider: string) => Promise<PeriodDiffReport>>(),
  getPeriodCompareSessions: vi.fn<(a: { from: string; to: string }, b: { from: string; to: string }, provider: string, dimension: string, key: string) => Promise<PeriodSessionDiff>>(),
  telemetryTrack: vi.fn<(name: string, props?: Record<string, unknown>) => Promise<boolean>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

const RANGE_A = { from: '2026-03-02', to: '2026-03-08' }
const RANGE_B = { from: '2026-03-09', to: '2026-03-15' }

const report: PeriodDiffReport = {
  schema: 1,
  provider: 'all',
  rangeA: { ...RANGE_A, days: 7 },
  rangeB: { ...RANGE_B, days: 7 },
  overlapDays: 0,
  durationDeltaDays: 0,
  totals: {
    A: { cost: 100, calls: 10, sessions: 3, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100, savingsUSD: 0, estimatedCostUSD: 0 },
    B: { cost: 160, calls: 16, sessions: 4, inputTokens: 1800, outputTokens: 700, cacheReadTokens: 300, cacheWriteTokens: 120, savingsUSD: 0, estimatedCostUSD: 0 },
    diff: { cost: 60, calls: 6, sessions: 1, inputTokens: 800, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 20, savingsUSD: 0, estimatedCostUSD: 0 },
    pct: { cost: 60, calls: 60, sessions: 100 / 3, inputTokens: 80, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 20, savingsUSD: null, estimatedCostUSD: null },
  },
  projects: [
    { key: '/work/eff', costA: 10, costB: 20, diff: 10, pct: 100, status: 'up', callsA: 10, callsB: 1000 },
    { key: '/work/new', costA: 0, costB: 5, diff: 5, pct: null, status: 'new', callsA: 0, callsB: 50 },
    { key: '/work/gone', costA: 30, costB: 0, diff: -30, pct: -100, status: 'gone', callsA: 3, callsB: 0 },
  ],
  models: [
    { key: 'claude-sonnet-4-5', costA: 40, costB: 160, diff: 120, pct: 300, status: 'up', callsA: 10, callsB: 16 },
  ],
  normalized: {
    perDay: { a: 100 / 7, b: 160 / 7, diff: 60 / 7, pct: 60 },
    per100Calls: { a: 1000, b: 1000, diff: 0, pct: 0 },
    denominators: { perDay: 'calendar days in the range (A: 7, B: 7)', per100Calls: 'API calls × 100 (A: 10, B: 16)' },
  },
  coverage: {
    unpricedModelsA: [{ model: 'mystery-model', calls: 4 }],
    unpricedModelsB: [],
    pricingCoverageA: 0.9,
    pricingCoverageB: 1,
  },
  history: {
    historyCost: { A: 112, B: 0 },
    detailCost: { A: 100, B: 160 },
    days: { A: [{ date: '2026-03-05', historyCost: 12, detailCost: 0, aggregateOnly: 12 }], B: [] },
    aggregateOnly: { A: 12, B: 0 },
    basis: 'Totals come from parsed session transcripts.',
  },
}

const sessionsReport: PeriodSessionDiff = {
  dimension: 'project',
  key: '/work/eff',
  provider: 'all',
  rangeA: { ...RANGE_A, days: 7 },
  rangeB: { ...RANGE_B, days: 7 },
  sessions: [
    { identity: 'claude\0/work/eff\0s1', provider: 'claude', sessionId: 's1', project: '/work/eff', title: 'long run', costA: 10, costB: 20, diff: 10, callsA: 10, callsB: 1000 },
  ],
}

beforeEach(() => {
  globalThis.localStorage?.clear()
  __resetPolledMemo()
  // Start from explicit custom ranges so assertions are independent of the
  // runner's today (the default preset is covered by its own test).
  globalThis.localStorage?.setItem('codeburn.periodCompare.v1', JSON.stringify({
    preset: 'custom', rangeA: RANGE_A, rangeB: RANGE_B, lens: 'projects', view: 'raw',
  }))
  mocks.getPeriodCompare.mockReset().mockResolvedValue(report)
  mocks.getPeriodCompareSessions.mockReset().mockResolvedValue(sessionsReport)
  mocks.telemetryTrack.mockReset().mockResolvedValue(true)
})

describe('PeriodCompare', () => {
  it('recomputes percentages and direction for daily averages with unequal lengths', async () => {
    const unequal: PeriodDiffReport = { ...report, rangeA: { ...report.rangeA, days: 1 }, rangeB: { ...report.rangeB, days: 10 },
      projects: [{ key: '/work/eff', costA: 100, costB: 160, diff: 60, pct: 60, status: 'up', callsA: 10, callsB: 10 }] }
    mocks.getPeriodCompare.mockResolvedValue(unequal)
    render(<PeriodCompare provider="all" />)
    await screen.findByText('Contributions by project')
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Per day' }))
    const row = screen.getByRole('button', { name: /\/work\/eff:.*Down/ })
    expect(row).toHaveTextContent('$100.00')
    expect(row).toHaveTextContent('$16.00')
    expect(row).toHaveTextContent('−$84.00')
    expect(row).toHaveTextContent('−84.0%')
    expect(row).not.toHaveTextContent('+60.0%')
  })

  it('does not reuse session details from a different B range after remount', async () => {
    const user = userEvent.setup()
    const first = render(<PeriodCompare provider="all" />)
    await user.click(await screen.findByRole('button', { name: /\/work\/eff/ }))
    expect(await screen.findByLabelText('Sessions behind /work/eff')).toHaveTextContent('$20.00')
    expect(mocks.getPeriodCompareSessions).toHaveBeenCalledTimes(1)
    first.unmount()
    const rangeB = { from: RANGE_B.from, to: '2026-03-18' }
    localStorage.setItem('codeburn.periodCompare.v1', JSON.stringify({ preset: 'custom', rangeA: RANGE_A, rangeB, lens: 'projects', view: 'raw' }))
    mocks.getPeriodCompare.mockResolvedValue({ ...report, rangeB: { ...rangeB, days: 10 } })
    mocks.getPeriodCompareSessions.mockResolvedValue({ ...sessionsReport, rangeB: { ...rangeB, days: 10 }, sessions: [{ ...sessionsReport.sessions[0], costB: 250, diff: 240 }] })
    render(<PeriodCompare provider="all" />)
    await user.click(await screen.findByRole('button', { name: /\/work\/eff/ }))
    await waitFor(() => expect(mocks.getPeriodCompareSessions).toHaveBeenCalledTimes(2))
    expect(screen.getByLabelText('Sessions behind /work/eff')).toHaveTextContent('$250.00')
  })

  it('renders both ranges, the totals difference, and the coverage notes', async () => {
    render(<PeriodCompare provider="all" />)
    expect(await screen.findByText('Totals')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('A spans 7 days')
    expect(screen.getByLabelText('Totals difference')).toHaveTextContent('API-equivalent cost')
    // The global diff (B − A) is on screen, not just the two columns.
    const totals = screen.getByLabelText('Totals difference')
    expect(totals).toHaveTextContent('+$60.00')
    expect(totals).toHaveTextContent('+60.0%')
    // Aggregate-only carried history is reported separately, never folded in.
    expect(screen.getByText(/Aggregate history without session detail/)).toBeInTheDocument()
    expect(screen.getByText(/Missing pricing \(unknown, not zero\)/)).toBeInTheDocument()
  })

  it('labels a zero-A contribution New without a percentage, and Gone for a disappeared one', async () => {
    const user = userEvent.setup()
    render(<PeriodCompare provider="all" />)
    await screen.findByText('Contributions by project')
    expect(screen.getByText('New')).toBeInTheDocument()
    expect(screen.getByText('Gone')).toBeInTheDocument()
    const newKey = screen.getByRole('button', { name: /\/work\/new/ })
    expect(newKey).toHaveTextContent('New')
    expect(newKey).not.toHaveTextContent('%')
    // Gone carries its −100%.
    expect(screen.getByRole('button', { name: /\/work\/gone/ })).toHaveTextContent('Gone')
    expect(screen.getByRole('button', { name: /\/work\/gone/ })).toHaveTextContent('−100%')

    // Clicking a contribution opens the session drill-down for it.
    await user.click(screen.getByRole('button', { name: /\/work\/eff/ }))
    expect(await screen.findByLabelText('Sessions behind /work/eff')).toBeInTheDocument()
    expect(mocks.getPeriodCompareSessions).toHaveBeenCalledWith(RANGE_A, RANGE_B, 'all', 'project', '/work/eff')
    expect(screen.getByText('long run')).toBeInTheDocument()
  })

  it('drills into sessions and hands the requested range to the navigation adapter', async () => {
    const user = userEvent.setup()
    const onInspectRange = vi.fn()
    render(<PeriodCompare provider="all" onInspectRange={onInspectRange} />)
    await user.click(await screen.findByRole('button', { name: /\/work\/eff/ }))
    const drill = await screen.findByLabelText('Sessions behind /work/eff')
    await user.click(within(drill).getByRole('button', { name: 'Open A in Sessions →' }))
    expect(onInspectRange).toHaveBeenCalledWith(RANGE_A)
    await user.click(within(drill).getByRole('button', { name: 'Open B in Sessions →' }))
    expect(onInspectRange).toHaveBeenCalledWith(RANGE_B)
  })

  it('per-100-calls view recomputes honestly: cheaper per call is Down, zero calls is —', async () => {
    const user = userEvent.setup()
    render(<PeriodCompare provider="all" />)
    await screen.findByText('Contributions by project')
    // Raw: /work/eff is Up (+100%).
    expect(screen.getByRole('button', { name: /\/work\/eff/ })).toHaveTextContent('+100%')
    await user.click(screen.getByRole('tab', { name: 'Per 100 calls' }))
    // Raw cost doubled, but per call it fell $100 → $2 per 100 calls: Down, not Up.
    const eff = screen.getByRole('button', { name: /\/work\/eff/ })
    expect(eff).toHaveTextContent('−98.0%')
    // Zero calls in A: no cost per call exists — em dash, and still New.
    const fresh = screen.getByRole('button', { name: /\/work\/new/ })
    expect(fresh).toHaveTextContent('—')
    expect(fresh).toHaveTextContent('New')
  })

  it('switches to the model lens and drills by model', async () => {
    const user = userEvent.setup()
    render(<PeriodCompare provider="all" />)
    await screen.findByText('Contributions by project')
    await user.click(screen.getByRole('tab', { name: 'Models' }))
    expect(await screen.findByText('Contributions by model')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /claude-sonnet-4-5/ }))
    await waitFor(() => expect(mocks.getPeriodCompareSessions).toHaveBeenCalledWith(RANGE_A, RANGE_B, 'all', 'model', 'claude-sonnet-4-5'))
  })

  it('persists the A/B selection so returning to the section keeps it', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<PeriodCompare provider="all" />)
    await screen.findByText('Totals')
    await user.click(screen.getByRole('button', { name: 'Swap A and B' }))
    // The swap re-fetches with the ranges exchanged.
    await waitFor(() => expect(mocks.getPeriodCompare).toHaveBeenCalledWith(RANGE_B, RANGE_A, 'all'))
    unmount()

    // Returning to the section (fresh component, no refetch needed) restores
    // the swapped selection from storage: A shows B's old dates.
    render(<PeriodCompare provider="all" />)
    await screen.findByText('Totals')
    expect(screen.getByLabelText('A · reference: 2026-03-09 to 2026-03-15')).toBeInTheDocument()
    expect(screen.getByLabelText('B · analyzed: 2026-03-02 to 2026-03-08')).toBeInTheDocument()
  })

  it('computes the default preset as the last seven complete days vs the seven before', () => {
    const ranges = defaultSevenRanges(new Date(2026, 2, 15, 12, 0, 0))
    expect(ranges.rangeB).toEqual({ from: '2026-03-08', to: '2026-03-14' })
    expect(ranges.rangeA).toEqual({ from: '2026-03-01', to: '2026-03-07' })
  })
})
