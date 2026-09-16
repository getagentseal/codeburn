// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PeriodDiffReport, PeriodSessionDiff } from '../lib/types'
import { __resetPolledMemo } from '../hooks/usePolled'
import { PeriodCompare, defaultSevenRanges, leadSentence } from './PeriodCompare'

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
    { key: '/work/a', costA: 8, costB: 16, diff: 8, pct: 100, status: 'up', callsA: 8, callsB: 16 },
    { key: '/work/b', costA: 7, costB: 14, diff: 7, pct: 100, status: 'up', callsA: 7, callsB: 14 },
    { key: '/work/small', costA: 1, costB: 2, diff: 1, pct: 100, status: 'up', callsA: 1, callsB: 2 },
  ],
  models: [
    { key: 'claude-sonnet-4-5', costA: 40, costB: 160, diff: 120, pct: 300, status: 'up', callsA: 10, callsB: 16 },
  ],
  normalized: {
    perDay: { a: 100 / 7, b: 160 / 7, diff: 60 / 7, pct: 60 },
    per100Calls: { a: 1000, b: 1000, diff: 0, pct: 0 },
    denominators: { perDay: 'calendar days in the range (A: 7, B: 7)', per100Calls: 'API calls × 100 (A: 10, B: 16)' },
  },
  daily: {
    A: [10, 20, 15, 12, 18, 11, 14].map((cost, i) => ({ date: `2026-03-0${i + 2}`, cost })),
    B: [30, 20, 25, 22, 28, 21, 14].map((cost, i) => ({ date: `2026-03-${String(i + 9).padStart(2, '0')}`, cost })),
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
    await screen.findByText('What changed, biggest movers')
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
    expect(await screen.findByText('What changed, biggest movers')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('A spans 7 days')
    expect(screen.getByLabelText('Totals difference')).toHaveTextContent('API-equivalent cost')
    // The global diff (B − A) is on screen, not just the two columns.
    const totals = screen.getByLabelText('Totals difference')
    expect(totals).toHaveTextContent('+$60.00')
    expect(totals).toHaveTextContent('+60.0%')
    // Aggregate-only carried history is reported separately, never folded in.
    // A side with no aggregate-only days lists no days, never empty parentheses.
    expect(screen.getByText(/Daily history with no sessions behind it/)).not.toHaveTextContent('()')
    expect(screen.getByText(/These models have no price/)).toBeInTheDocument()
  })

  it('labels a zero-A contribution new this period, and not used this period for a disappeared one', async () => {
    const user = userEvent.setup()
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    expect(screen.getByText('new this period')).toBeInTheDocument()
    expect(screen.getByText('not used this period')).toBeInTheDocument()
    const newKey = screen.getByRole('button', { name: /\/work\/new/ })
    expect(newKey).toHaveTextContent('new this period')
    expect(newKey).not.toHaveTextContent('%')
    // A status word replaces the percentage; the signed change still shows it.
    const goneKey = screen.getByRole('button', { name: /\/work\/gone/ })
    expect(goneKey).toHaveTextContent('not used this period')
    expect(goneKey).toHaveTextContent('−$30.00')
    expect(goneKey).not.toHaveTextContent('%')

    // Clicking a contribution opens the session drill-down for it.
    await user.click(screen.getByRole('button', { name: /\/work\/eff/ }))
    expect(await screen.findByLabelText('Sessions behind /work/eff')).toBeInTheDocument()
    expect(mocks.getPeriodCompareSessions).toHaveBeenCalledWith(RANGE_A, RANGE_B, 'all', 'project', '/work/eff')
    expect(screen.getByText('long run')).toBeInTheDocument()
  })

  it('drills into sessions with the clicked side\'s range AND the contribution key', async () => {
    const user = userEvent.setup()
    const onInspectContribution = vi.fn()
    render(<PeriodCompare provider="all" onInspectContribution={onInspectContribution} />)
    await user.click(await screen.findByRole('button', { name: /\/work\/eff/ }))
    const drill = await screen.findByLabelText('Sessions behind /work/eff')
    await user.click(within(drill).getByRole('button', { name: 'Open A in Sessions →' }))
    expect(onInspectContribution).toHaveBeenCalledWith(RANGE_A, 'project', '/work/eff')
    await user.click(within(drill).getByRole('button', { name: 'Open B in Sessions →' }))
    expect(onInspectContribution).toHaveBeenCalledWith(RANGE_B, 'project', '/work/eff')
  })

  it('per-100-calls view recomputes honestly: cheaper per call is Down, zero calls is —', async () => {
    const user = userEvent.setup()
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    // Raw: /work/eff is Up (+100%).
    expect(screen.getByRole('button', { name: /\/work\/eff/ })).toHaveTextContent('+100%')
    await user.click(screen.getByRole('tab', { name: 'Per 100 calls' }))
    // Raw cost doubled, but per call it fell $100 → $2 per 100 calls: Down, not Up.
    const eff = screen.getByRole('button', { name: /\/work\/eff/ })
    expect(eff).toHaveTextContent('−98.0%')
    // Zero calls in A: no cost per call exists — em dash, and still New.
    const fresh = screen.getByRole('button', { name: /\/work\/new/ })
    expect(fresh).toHaveTextContent('—')
    expect(fresh).toHaveTextContent('new this period')
  })

  it('switches to the model lens and drills by model', async () => {
    const user = userEvent.setup()
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    await user.click(screen.getByRole('tab', { name: 'By model' }))
    expect(await screen.findByRole('columnheader', { name: 'Model' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /claude-sonnet-4-5/ }))
    await waitFor(() => expect(mocks.getPeriodCompareSessions).toHaveBeenCalledWith(RANGE_A, RANGE_B, 'all', 'model', 'claude-sonnet-4-5'))
  })

  it('persists the A/B selection so returning to the section keeps it', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    await user.click(screen.getByRole('button', { name: 'Swap A and B' }))
    // The swap re-fetches with the ranges exchanged.
    await waitFor(() => expect(mocks.getPeriodCompare).toHaveBeenCalledWith(RANGE_B, RANGE_A, 'all'))
    unmount()

    // Returning to the section (fresh component, no refetch needed) restores
    // the swapped selection from storage: A shows B's old dates.
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    expect(screen.getByLabelText('A · reference: 2026-03-09 to 2026-03-15')).toBeInTheDocument()
    expect(screen.getByLabelText('B · analyzed: 2026-03-02 to 2026-03-08')).toBeInTheDocument()
  })

  it('leads with a sentence that names the divergence when sessions move far more than cost per call', async () => {
    const divergent: PeriodDiffReport = {
      ...report,
      totals: {
        ...report.totals,
        A: { ...report.totals.A, cost: 2630 },
        B: { ...report.totals.B, cost: 936 },
        pct: { ...report.totals.pct, cost: -64.4, sessions: -86.8 },
      },
      normalized: { ...report.normalized, per100Calls: { a: 20.73, b: 14.52, diff: -6.21, pct: -30 } },
    }
    // The clause never asserts a direction it does not measure: cost per call
    // fell, so the calls got cheaper, whichever way sessions went.
    expect(leadSentence(divergent)).toBe(
      'The week of Mar 9, 2026 cost 64% less than the week before: $936.00 versus $2,630.00.'
      + ' Far fewer sessions, and cheaper calls: cost per call fell only 30%.',
    )
    const opposite: PeriodDiffReport = {
      ...divergent,
      totals: { ...divergent.totals, pct: { ...divergent.totals.pct, cost: 219, sessions: 636 } },
      normalized: { ...divergent.normalized, per100Calls: { a: 14.52, b: 19.76, diff: 5.24, pct: 36.11 } },
    }
    expect(leadSentence(opposite)).toContain('Far more sessions, and more expensive calls: cost per call rose only 36%.')
    mocks.getPeriodCompare.mockResolvedValue(divergent)
    render(<PeriodCompare provider="all" />)
    expect(await screen.findByText(/Far fewer sessions, and cheaper calls/)).toBeInTheDocument()
  })

  it('reads a near-flat range as flat rather than "0% less"', () => {
    const flat: PeriodDiffReport = { ...report, totals: { ...report.totals, pct: { ...report.totals.pct, cost: -0.3 } } }
    expect(leadSentence(flat)).toContain('cost the same as the week before')
  })

  it('rounds the tile percentages the way the sentence above them does', async () => {
    const tiles: PeriodDiffReport = {
      ...report,
      totals: {
        ...report.totals,
        diff: { ...report.totals.diff, cost: -1694.84, sessions: -1560 },
        pct: { ...report.totals.pct, cost: -64.4306, sessions: -86.811 },
      },
      normalized: { ...report.normalized, per100Calls: { a: 20.73, b: 14.52, diff: -6.21, pct: -29.9706 } },
    }
    mocks.getPeriodCompare.mockResolvedValue(tiles)
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    const tile = (label: string) => within(document.querySelector('.pcmp-tiles')!).getByText(label).closest('.pcmp-tile')!
    expect(tile('Total cost')).toHaveTextContent('−64%')
    expect(tile('Cost per 100 calls')).toHaveTextContent('−30%')
    // The cost tiles carry the cost color; more sessions is not a bill going up.
    expect(tile('Total cost').querySelector('.pcmp-tile-change')!.className).toContain('pcmp-down')
    expect(tile('Sessions').querySelector('.pcmp-tile-change')!.className.trim()).toBe('pcmp-tile-change')
  })

  it('labels the day axis on a stride instead of one label per day', async () => {
    const long = Array.from({ length: 100 }, (_, i) => {
      const day = new Date(2026, 2, 2)
      day.setDate(day.getDate() + i)
      return { date: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`, cost: 10 + i }
    })
    mocks.getPeriodCompare.mockResolvedValue({ ...report, daily: { A: long, B: long.slice(0, 98) } })
    render(<PeriodCompare provider="all" />)
    await screen.findByText('Cost per day, both ranges side by side')
    const axis = document.querySelector('.ov-xax')!
    expect(axis.children.length).toBeLessThanOrEqual(7)
    expect(axis.textContent).toBe('Day 1Day 21Day 41Day 61Day 81Day 100')
  })

  it('keeps the year and a single day straight in the shortened range headers', async () => {
    mocks.getPeriodCompare.mockResolvedValue({
      ...report,
      rangeA: { from: '2025-09-01', to: '2026-09-30', days: 395 },
      rangeB: { from: '2026-09-10', to: '2026-09-10', days: 1 },
    })
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    const movers = within(screen.getByLabelText('projects contributions'))
    expect(movers.getByRole('columnheader', { name: 'Sep 1–Sep 30' })).toBeInTheDocument()
    expect(movers.getByRole('columnheader', { name: 'Sep 10' })).toBeInTheDocument()
  })

  it('names the unit and the shortened range in the movers headers', async () => {
    const user = userEvent.setup()
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    const movers = within(screen.getByLabelText('projects contributions'))
    expect(movers.getByRole('columnheader', { name: 'Mar 2–8' })).toBeInTheDocument()
    expect(movers.getByRole('columnheader', { name: '%' })).toBeInTheDocument()
    // Project keys lose the home-directory prefix but keep the full path in the title.
    const row = screen.getByRole('button', { name: /\/work\/eff/ })
    expect(row.querySelector('.pcmp-key')).toHaveTextContent('work/eff')
    expect(row.querySelector('.pcmp-key')).toHaveAttribute('title', '/work/eff')
    await user.click(screen.getByRole('tab', { name: 'Per 100 calls' }))
    expect(movers.getByRole('columnheader', { name: 'Mar 2–8 · per 100 calls' })).toBeInTheDocument()
  })

  it('writes a negative day delta and an unpriced single call the way the rest of the page does', async () => {
    // This runner's jsdom has no localStorage, so the selection the meta line
    // describes has to be stubbed in rather than seeded through storage.
    const shortB = { from: '2026-03-09', to: '2026-03-13' }
    const store = new Map<string, string>([['codeburn.periodCompare.v1', JSON.stringify({
      preset: 'custom', rangeA: RANGE_A, rangeB: shortB, lens: 'projects', view: 'raw',
    })]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => store.clear(),
    })
    mocks.getPeriodCompare.mockResolvedValue({
      ...report,
      rangeB: { ...shortB, days: 5 },
      coverage: { ...report.coverage, unpricedModelsA: [{ model: 'mystery-model', calls: 1 }] },
    })
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    expect(screen.getByRole('status')).toHaveTextContent('duration differs by −2 days')
    expect(screen.getByText(/These models have no price/)).toHaveTextContent('mystery-model (A, 1 call)')
    vi.unstubAllGlobals()
  })

  it('leads with both directions when sessions and cost per call move together', () => {
    const together: PeriodDiffReport = {
      ...report,
      totals: {
        ...report.totals,
        A: { ...report.totals.A, cost: 160 },
        B: { ...report.totals.B, cost: 120 },
        pct: { ...report.totals.pct, cost: -25, sessions: -10 },
      },
      normalized: { ...report.normalized, per100Calls: { a: 1000, b: 800, diff: -200, pct: -20 } },
    }
    expect(leadSentence(together)).toBe(
      'The week of Mar 9, 2026 cost 25% less than the week before: $120.00 versus $160.00. Fewer sessions and cheaper calls.',
    )
  })

  it('names the range instead of the week when the ranges are not seven days', () => {
    const notWeeks: PeriodDiffReport = {
      ...report,
      rangeA: { ...report.rangeA, days: 10 },
      rangeB: { ...report.rangeB, days: 10 },
      totals: { ...report.totals, pct: { ...report.totals.pct, cost: 60, sessions: 10 } },
      normalized: { ...report.normalized, per100Calls: { a: 1000, b: 1200, diff: 200, pct: 20 } },
    }
    expect(leadSentence(notWeeks)).toBe(
      'The Mar 9, 2026 to Mar 15, 2026 range cost 60% more than the range before: $160.00 versus $100.00.'
      + ' More sessions and more expensive calls.',
    )
  })

  it('shows the five biggest movers and expands to the full list on request', async () => {
    const user = userEvent.setup()
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    // Six contributions, five shown: the smallest mover is held back.
    expect(screen.queryByRole('button', { name: /\/work\/small/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /\/work\/gone/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all 6' }))
    expect(screen.getByRole('button', { name: /\/work\/small/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show top five' }))
    expect(screen.queryByRole('button', { name: /\/work\/small/ })).not.toBeInTheDocument()
    // Changing the view reranks the list, so the expansion resets with it.
    await user.click(screen.getByRole('button', { name: 'Show all 6' }))
    await user.click(screen.getByRole('tab', { name: 'Per day' }))
    expect(screen.getByRole('button', { name: 'Show all 6' })).toBeInTheDocument()
  })

  it('folds the full metric tables and the basis notes away by default', async () => {
    const user = userEvent.setup()
    render(<PeriodCompare provider="all" />)
    await screen.findByText('What changed, biggest movers')
    const allMetrics = screen.getByText('All metrics').closest('details')!
    expect(allMetrics).not.toHaveAttribute('open')
    expect(within(allMetrics).getByLabelText('Totals difference')).toHaveTextContent('API-equivalent cost')
    await user.click(screen.getByText('All metrics'))
    expect(allMetrics).toHaveAttribute('open')

    const basis = screen.getByText(/What is counted/).closest('details')!
    expect(basis).not.toHaveAttribute('open')
    expect(within(basis).getByText(/These models have no price/)).toBeInTheDocument()
  })

  it('computes the default preset as the last seven complete days vs the seven before', () => {
    const ranges = defaultSevenRanges(new Date(2026, 2, 15, 12, 0, 0))
    expect(ranges.rangeB).toEqual({ from: '2026-03-08', to: '2026-03-14' })
    expect(ranges.rangeA).toEqual({ from: '2026-03-01', to: '2026-03-07' })
  })
})
