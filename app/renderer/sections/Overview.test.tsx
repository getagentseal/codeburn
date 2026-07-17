// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Polled } from '../hooks/usePolled'
import { setActiveCurrency } from '../lib/format'
import type { ActReportJson, DailyHistoryEntry, MenubarPayload, YieldJsonReport } from '../lib/types'
import { Overview, OverviewContent, deriveSignals, localDateKey } from './Overview'

function polled(data: MenubarPayload): Polled<MenubarPayload> {
  return { data, error: null, loading: false, switching: false, lastSuccessAt: Date.now(), refresh: vi.fn() }
}

// Mock the typed bridge so the section fetches our payload instead of spawning
// the CLI. `normalizeCliError` (used by usePolled) is kept from the real module.
// `vi.hoisted` lets the hoisted `vi.mock` factory reference the spy safely.
const { getOverview, getActReport, getYield } = vi.hoisted(() => ({
  getOverview: vi.fn<(period: string, provider: string) => Promise<MenubarPayload>>(),
  getActReport: vi.fn<() => Promise<ActReportJson>>(),
  getYield: vi.fn<(period: string, provider: string) => Promise<YieldJsonReport>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getOverview, getActReport, getYield } }
})

function makeYieldReport(): YieldJsonReport {
  return {
    period: { label: 'Last 30 days', start: '2026-06-12', end: '2026-07-11' },
    summary: {
      productive: { costUSD: 120, sessions: 3, costPercent: 80, sessionPercent: 60 },
      reverted: { costUSD: 20, sessions: 1, costPercent: 13, sessionPercent: 20 },
      abandoned: { costUSD: 10, sessions: 1, costPercent: 7, sessionPercent: 20 },
      total: { costUSD: 150, sessions: 5 },
      productiveToRevertedCostRatio: 6,
    },
    details: [
      { sessionId: 's1', project: 'parser-service', category: 'productive', commitCount: 4, costUSD: 80 },
      { sessionId: 's2', project: 'pairing-svc', category: 'productive', commitCount: 2, costUSD: 40 },
      { sessionId: 's3', project: 'parser-service', category: 'reverted', commitCount: 0, costUSD: 20 },
      { sessionId: 's4', project: 'scratch', category: 'abandoned', commitCount: 0, costUSD: 10 },
    ],
  }
}

/**
 * A fully-typed payload anchored to `now` so today/MTD/projected are stable.
 * `history.daily` deliberately spans 30 backfill days (the real CLI emits up to
 * 365 regardless of period) so tests can prove period aggregation while the
 * trend chart keeps the real last 30 entries.
 */
function makePayload(now: Date): MenubarPayload {
  const DAYS = 30
  // 30 daily entries ending today. Base $5, a clear peak ($32) and runner-up
  // ($28), and today's entry (last) at $6.20 — the Today card's source value.
  const daily = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS - 1 - i))
    let cost = 5
    if (i === 10) cost = 32 // peak → .c.hi
    else if (i === 20) cost = 28 // runner-up → .c.hi2
    else if (i === DAYS - 1) cost = 6.2 // today
    return {
      date: localDateKey(d),
      cost,
      savingsUSD: 0,
      calls: 40,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      topModels: [
        {
          name: 'claude-opus-4',
          cost: cost - 1,
          savingsUSD: 0,
          calls: 30,
          inputTokens: 40_000_000,
          outputTokens: 2_000_000,
        },
        {
          name: 'claude-haiku-4',
          cost: 1,
          savingsUSD: 0,
          calls: 10,
          inputTokens: 1_000,
          outputTokens: 500,
        },
      ],
    }
  })

  return {
    generated: now.toISOString(),
    current: {
      label: 'Last 30 days',
      cost: 312.4,
      calls: 4200,
      sessions: 88,
      oneShotRate: 0.74,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitPercent: 63.4,
      codexCredits: 0,
      topActivities: [
        { name: 'coding', cost: 92.5, savingsUSD: 7.2, turns: 120, oneShotRate: 0.8 },
        { name: 'debugging', cost: 41.25, savingsUSD: 2.1, turns: 64, oneShotRate: null },
      ],
      topModels: [{ name: 'claude-opus-4', cost: 200, savingsUSD: 0, savingsBaselineModel: '', calls: 100 }],
      localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
      providers: {},
      topProjects: [
        {
          name: 'parser-service',
          cost: 8.41,
          savingsUSD: 0,
          sessions: 1,
          avgCostPerSession: 8.41,
          sessionDetails: [
            {
              cost: 8.41,
              savingsUSD: 0,
              calls: 41,
              inputTokens: 0,
              outputTokens: 0,
              date: '2026-07-08',
              models: [{ name: 'claude-opus-4', cost: 8.41, savingsUSD: 0 }],
            },
          ],
        },
      ],
      modelEfficiency: [],
      topSessions: [
        { project: 'parser-service', cost: 8.41, savingsUSD: 0, calls: 41, date: '2026-07-08' },
        { project: 'pairing-svc', cost: 6.12, savingsUSD: 0, calls: 33, date: '2026-07-07' },
      ],
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: [],
      skills: [],
      subagents: [],
      mcpServers: [],
    },
    optimize: { findingCount: 3, savingsUSD: 23.6, topFindings: [] },
    history: { daily },
  }
}

function mkDay(date: string, cost: number): DailyHistoryEntry {
  return { date, cost, savingsUSD: 0, calls: 10, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [] }
}

/** A payload with an explicit history + current overrides for deriveSignals tests. */
function signalsPayload(now: Date, over: {
  current?: Partial<MenubarPayload['current']>
  daily?: DailyHistoryEntry[]
  optimize?: MenubarPayload['optimize']
}): MenubarPayload {
  const base = makePayload(now)
  return {
    ...base,
    current: { ...base.current, ...over.current },
    optimize: over.optimize ?? { findingCount: 0, savingsUSD: 0, topFindings: [] },
    history: { daily: over.daily ?? [] },
  }
}

/** N consecutive days ending today; `cost(i)` sets each day's spend (i = oldest→0). */
function consecutiveDays(now: Date, count: number, cost: (index: number) => number): DailyHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => mkDay(localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - i))), cost(i)))
}

describe('Overview', () => {
  beforeEach(() => {
    setActiveCurrency({ code: 'USD', symbol: '$', rate: 1 })
    getOverview.mockReset()
    getActReport.mockReset()
    getYield.mockReset()
    getActReport.mockResolvedValue({ totals: { realizedCostUSD: 84.2, measuredActions: 11 } })
    getYield.mockResolvedValue(makeYieldReport())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders real hero, stats, model, saved, session, and daily-chart data", async () => {
    const now = new Date()
    getOverview.mockResolvedValue(makePayload(now))

    const { container } = render(<Overview period="30days" provider="all" />)

    // The hero shows the SELECTED PERIOD's total (current.cost) + label, not
    // just today — so a 30-day view reads $312.40 under "Last 30 days".
    expect(await screen.findByText('$312.40')).toBeInTheDocument()
    expect(screen.getByText('Last 30 days')).toBeInTheDocument()
    expect(container.querySelector('.ov-streak')).toHaveTextContent('30-day streak')

    // The unified hero keeps spend/savings, activity, and efficiency in one
    // divided card. Success/cache now live only in the scorecard column.
    const kpis = screen.getByLabelText('Key performance indicators')
    expect(within(kpis).getAllByText('74%')).toHaveLength(1)
    expect(within(kpis).getAllByText('63%')).toHaveLength(1)
    expect(within(kpis).getByText('$84.20')).toBeInTheDocument()
    expect(within(kpis).getByLabelText('Efficiency grade B')).toHaveTextContent('B')
    expect(kpis.querySelector(':scope > .ov-efficiency')).toBeInTheDocument()
    expect(kpis.querySelector('.ov-efficiency.ov-card')).not.toBeInTheDocument()

    // The contribution grid contains the real active history days, and the
    // right rail renders real, cost-sorted activity data including one-shot.
    const heatmap = screen.getByRole('grid', { name: 'Daily activity contribution heatmap' })
    expect(heatmap.querySelectorAll('[data-active="true"]')).toHaveLength(30)
    expect(screen.getByText('30 active days')).toBeInTheDocument()
    expect(screen.getByText('coding')).toBeInTheDocument()
    expect(screen.getByText('$92.50')).toBeInTheDocument()
    expect(screen.getByText('120 turns')).toBeInTheDocument()
    expect(screen.getByText('80% one-shot')).toBeInTheDocument()

    // Session row title = the session's project (topSessions has no title field).
    expect(screen.getByText('parser-service')).toBeInTheDocument()

    // The selected range produces one real bar per day and only its peak is highlighted.
    const bars = container.querySelectorAll('.chart .col')
    expect(bars).toHaveLength(30)
    expect(bars[10].classList.contains('hi')).toBe(true)
    expect(container.querySelectorAll('.chart .col.hi')).toHaveLength(1)
    expect(bars[29]).toHaveAttribute('data-cost', '6.2')
    expect(bars[29]).toHaveAttribute('data-calls', '40')
    expect(bars[29]).toHaveAttribute('data-led', 'claude-opus-4')
    fireEvent.mouseEnter(bars[29], { clientX: 100, clientY: 80 })
    expect(screen.getByText('40 calls · claude-opus-4 led')).toBeInTheDocument()
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.parentElement).toBe(document.body)
    expect(tooltip).toHaveStyle({ position: 'fixed' })

    // Daily model breakdowns are summed over the selected period and sorted by
    // cost. Token values use the same compact B/M/K notation as the menubar.
    const modelsTable = screen.getByRole('table', { name: 'Models this period' })
    expect(within(modelsTable).queryByRole('columnheader', { name: 'Relative cost' })).not.toBeInTheDocument()
    const modelRows = within(modelsTable).getAllByRole('row')
    expect(modelRows[1]).toHaveTextContent('claude-opus-4')
    expect(modelRows[1]).toHaveTextContent('1.2B')
    // Tokens now use the shared formatCompact helper (drops a trailing .0).
    expect(modelRows[1]).toHaveTextContent('60M')
    expect(modelRows[1]).toHaveTextContent('$171.20')
    expect(modelRows[1]).toHaveTextContent('900')
    expect(modelRows[2]).toHaveTextContent('claude-haiku-4')
    expect(modelRows[2]).toHaveTextContent('30K')
    expect(modelRows[2]).toHaveTextContent('15K')

    // Weekly labels align to every seventh bar, and all three menubar-style
    // daily summaries are derived from the displayed 30-day chart window.
    const ticks = container.querySelectorAll('.ov-xax span')
    expect(ticks).toHaveLength(5)
    expect(ticks[0]).toHaveTextContent(new Date(
      now.getFullYear(), now.getMonth(), now.getDate() - 29,
    ).toLocaleString('en-US', { month: 'short', day: 'numeric' }))
    const summaries = screen.getByLabelText('Daily spend summary')
    expect(within(summaries).getByText('Avg/day')).toBeInTheDocument()
    expect(within(summaries).getByText('$6.71')).toBeInTheDocument()
    expect(within(summaries).getByText('Peak')).toBeInTheDocument()
    expect(within(summaries).getByText(/\$32\.00 · \d{1,2}\/\d{1,2}/)).toBeInTheDocument()
    expect(within(summaries).getByText('Yesterday')).toBeInTheDocument()
    expect(within(summaries).getByText('$5.00')).toBeInTheDocument()

    expect(container.querySelector('.ov-spark')).not.toBeInTheDocument()

    // Scope to the KPI card (kpis, declared above): month-to-date spend can
    // equal the saved figure on some dates, so an unscoped getByText('$84.20')
    // would match two cards.
    expect(within(kpis).getByText('$84.20')).toBeInTheDocument()
    expect(within(kpis).getByText('across 11 fixes')).toBeInTheDocument()
    const statsCard = screen.getByText('Month to date').closest('.ov-stats3')
    expect(statsCard).toHaveClass('ov-card')
    expect(statsCard?.children).toHaveLength(2)
    expect(within(statsCard as HTMLElement).getByText('Projected month')).toBeInTheDocument()
    expect(screen.queryByText('Nearest limit')).not.toBeInTheDocument()
  })

  it('renders efficiency, cost-per-outcome, and the weekday-spike risk signal', async () => {
    const now = new Date()
    const payload = makePayload(now)
    const today = payload.history.daily.at(-1)
    if (!today) throw new Error('fixture must contain today')
    today.cost = 50 // Prior same weekdays are $5, so the real detector reports 10×.
    getOverview.mockResolvedValue(payload)

    render(<Overview period="30days" provider="all" />)

    expect(await screen.findByLabelText('Efficiency grade B')).toHaveTextContent('B')
    const outcome = screen.getByText('Cost per outcome').closest('.ov-panel')
    expect(outcome).not.toBeNull()
    expect(within(outcome as HTMLElement).getByText('$25.00')).toBeInTheDocument()
    expect(within(outcome as HTMLElement).getByText('$40.00')).toBeInTheDocument()
    // The weekday-spike anomaly is absorbed into the Signals card as a risk.
    const signals = screen.getByLabelText('Coaching signals')
    const risks = within(signals).getByText('Risks').closest('.ov-signal-group') as HTMLElement
    expect(within(risks).getByText(/Today's spend is 10× your typical/)).toBeInTheDocument()
  })

  it('hides the applied-fixes line when there are no realized savings', async () => {
    const now = new Date()
    getOverview.mockResolvedValue(makePayload(now))
    getActReport.mockResolvedValue({ totals: { realizedCostUSD: 0, measuredActions: 7 } })

    render(<Overview period="30days" provider="all" />)

    await waitFor(() => expect(getActReport).toHaveBeenCalled())
    expect(screen.queryByText('Saved by applied fixes')).not.toBeInTheDocument()
    expect(screen.queryByText(/across \d+ fix/)).not.toBeInTheDocument()
  })

  it('zero-fills a contiguous 30-day window from sparse history', async () => {
    const now = new Date()
    const payload = makePayload(now)
    payload.history.daily = payload.history.daily.slice(-5)
    getOverview.mockResolvedValue(payload)

    // history.daily is sparse (active days only). The daily chart zero-fills a
    // contiguous calendar window (at least 30 days) so gaps read as real
    // calendar time instead of compressed bars — the date keys match localDateKey.
    const { container } = render(<Overview period="week" provider="all" />)

    expect(await screen.findByText('parser-service')).toBeInTheDocument()
    const bars = container.querySelectorAll('.chart .col')
    expect(bars).toHaveLength(30)
    // The five real days keep their cost at the end; the leading 25 days are zeros.
    expect([...bars].slice(-5).map(bar => bar.getAttribute('data-cost'))).toEqual(['5', '5', '5', '5', '6.2'])
    expect([...bars].slice(0, 25).every(bar => bar.getAttribute('data-cost') === '0')).toBe(true)
  })

  it('computes month-to-date, projection, and previous-month pace', async () => {
    const now = new Date(2026, 6, 15, 12, 0, 0) // Wed Jul 15 2026, local
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    const payload = makePayload(now)
    // Prepend three high-spend May days. The pace comparator must be the PREVIOUS
    // calendar month (June) only — averaging all prior months (incl. May) would
    // skew the % and mislabel it, which is the bug this guards.
    const mkMay = (date: string) => ({
      date,
      cost: 50,
      savingsUSD: 0,
      calls: 40,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      topModels: [],
    })
    payload.history.daily = [mkMay('2026-05-10'), mkMay('2026-05-11'), mkMay('2026-05-12'), ...payload.history.daily]
    getOverview.mockResolvedValue(payload)

    render(<Overview period="30days" provider="all" />)

    // MTD = sum of July daily costs = 13×$5 + $28 + $6.20 = $99.20.
    expect(await screen.findByText('$99.20')).toBeInTheDocument()
    // Projected = MTD + median(trailing-7 = $5) × 16 days left = $179.20.
    expect(screen.getByText('$179.20')).toBeInTheDocument()
    expect(screen.getByText('$80.00 to go')).toBeInTheDocument()
    // Pace compares July's daily avg (6.613) to the PREVIOUS calendar month's
    // (June: 14×$5 + $32 = $102 / 15 = 6.8) → -3%, and the label names June.
    expect(screen.getByText('-3% vs June pace')).toBeInTheDocument()
  })

  it('recovers a matched session model for the sub-line without a series dot', async () => {
    const now = new Date()
    getOverview.mockResolvedValue(makePayload(now))

    const { container } = render(<Overview period="30days" provider="all" />)

    // parser-service session joins topProjects sessionDetails on
    // (project|date|calls|cost) → claude-opus-4 in the sub-line.
    expect(await screen.findByText('Jul 8 · claude-opus-4 · 41 calls')).toBeInTheDocument()

    // pairing-svc has no matching project → model omitted from sub.
    expect(screen.getByText('Jul 7 · 33 calls')).toBeInTheDocument()
    expect(container.querySelectorAll('.ov-sessions-widget .mdot')).toHaveLength(0)
  })

  it('disambiguates two same-project/same-day/same-calls sessions by cost', async () => {
    const now = new Date()
    const base = makePayload(now)
    // Two sessions identical on (project, date, calls) but differing in cost and
    // model. Without cost in the join key they collide; with it they resolve.
    const payload: MenubarPayload = {
      ...base,
      current: {
        ...base.current,
        topProjects: [
          {
            name: 'svc',
            cost: 12,
            savingsUSD: 0,
            sessions: 2,
            avgCostPerSession: 6,
            sessionDetails: [
              {
                cost: 10,
                savingsUSD: 0,
                calls: 20,
                inputTokens: 0,
                outputTokens: 0,
                date: '2026-07-08',
                models: [{ name: 'claude-opus-4', cost: 10, savingsUSD: 0 }],
              },
              {
                cost: 2,
                savingsUSD: 0,
                calls: 20,
                inputTokens: 0,
                outputTokens: 0,
                date: '2026-07-08',
                models: [{ name: 'claude-haiku-4', cost: 2, savingsUSD: 0 }],
              },
            ],
          },
        ],
        topSessions: [
          { project: 'svc', cost: 10, savingsUSD: 0, calls: 20, date: '2026-07-08' },
          { project: 'svc', cost: 2, savingsUSD: 0, calls: 20, date: '2026-07-08' },
        ],
      },
    }
    getOverview.mockResolvedValue(payload)

    const { container } = render(<Overview period="30days" provider="all" />)

    expect(await screen.findByText('Jul 8 · claude-opus-4 · 20 calls')).toBeInTheDocument()
    expect(screen.getByText('Jul 8 · claude-haiku-4 · 20 calls')).toBeInTheDocument()
    expect(container.querySelectorAll('.ov-sessions-widget .mdot')).toHaveLength(0)
  })

  it('shows the first-run locate-CLI state when the binary is missing', async () => {
    getOverview.mockRejectedValue({ kind: 'not-found', message: 'codeburn not found' })

    render(<Overview period="30days" provider="all" />)

    expect(await screen.findByText(/Locate the codeburn CLI/i)).toBeInTheDocument()
  })

  it('sources Models this period from current.topModels when a provider filter is active', async () => {
    const now = new Date()
    const payload = makePayload(now)
    // Provider-filtered CLI output: history.daily loses its per-model breakdown,
    // but current is already provider-scoped.
    payload.history.daily = payload.history.daily.map(day => ({ ...day, topModels: [] }))
    payload.current.topModels = [
      { name: 'gpt-5.5-codex', cost: 120, savingsUSD: 0, savingsBaselineModel: '', calls: 240 },
      { name: 'claude-opus-4', cost: 60, savingsUSD: 0, savingsBaselineModel: '', calls: 90 },
    ]

    render(<OverviewContent period="30days" provider="codex" overview={polled(payload)} />)

    const modelsTable = await screen.findByRole('table', { name: 'Models this period' })
    const rows = within(modelsTable).getAllByRole('row')
    // Sourced from current.topModels (cost-sorted), not the now-empty daily aggregation.
    expect(rows[1]).toHaveTextContent('gpt-5.5-codex')
    expect(rows[1]).toHaveTextContent('$120.00')
    expect(rows[1]).toHaveTextContent('240')
    expect(rows[2]).toHaveTextContent('claude-opus-4')
    // current.topModels carries no per-model tokens → both token cells show a dash.
    expect(within(rows[1] as HTMLElement).getAllByText('—')).toHaveLength(2)
  })

  it('suppresses the week-over-week signal and MTD card for a custom range', async () => {
    const now = new Date()
    const overview = polled(makePayload(now))

    const { rerender } = render(<OverviewContent period="30days" provider="all" overview={overview} />)
    // Baseline (no range): the MTD card, the coach pacing line, and the
    // week-over-week Signals entry are all present.
    expect(await screen.findByText('Month to date')).toBeInTheDocument()
    expect(screen.getAllByText(/than last week/).length).toBeGreaterThan(0)
    expect(screen.getByText(/vs last 7 days/)).toBeInTheDocument()

    const from = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2))
    const to = localDateKey(now)
    rerender(<OverviewContent period="30days" provider="all" range={{ from, to }} overview={overview} />)

    expect(screen.queryByText('Month to date')).not.toBeInTheDocument()
    expect(screen.queryByText('Projected month')).not.toBeInTheDocument()
    expect(screen.queryByText(/than last week/)).toBeNull()
    // The week-over-week Signals entry is suppressed under a custom range too.
    expect(screen.queryByText(/vs last 7 days|vs prior 7 days/)).toBeNull()
    expect(screen.getByText(/is the biggest driver in this range/)).toBeInTheDocument()
  })

  it('renders local-model savings in the hero only when present', async () => {
    const now = new Date()
    const payload = makePayload(now)
    payload.current.localModelSavings = { totalUSD: 42.5, calls: 10, byModel: [], byProvider: [] }

    render(<OverviewContent period="30days" provider="all" overview={polled(payload)} />)

    expect(await screen.findByText('Saved by applied fixes')).toBeInTheDocument()
    expect(screen.getByText('Saved via local models')).toBeInTheDocument()
    expect(screen.getByText('$42.50')).toBeInTheDocument()
    expect(screen.queryByText('Saved to date')).not.toBeInTheDocument()
  })

  it('shows a stale banner when last-good data is present but the latest poll failed', async () => {
    const now = new Date()
    const overview: Polled<MenubarPayload> = {
      data: makePayload(now),
      error: { kind: 'nonzero', message: 'codeburn exited 1' },
      loading: false,
      switching: false,
      lastSuccessAt: Date.now(),
      refresh: vi.fn(),
    }

    render(<OverviewContent period="30days" provider="all" overview={overview} />)

    expect(await screen.findByRole('status')).toHaveTextContent('Refresh failed, showing last good data · codeburn exited 1')
  })

  it('groups current-driven signals into wins and improvements', () => {
    const now = new Date()
    const wins = deriveSignals(signalsPayload(now, {
      current: {
        cacheHitPercent: 85,
        oneShotRate: 0.82,
        localModelSavings: { totalUSD: 15, calls: 4, byModel: [], byProvider: [] },
      },
      optimize: {
        findingCount: 2,
        savingsUSD: 30,
        topFindings: [
          { title: 'Trim CLAUDE.md preamble', impact: 'high', savingsUSD: 12 },
          { title: 'Route trivial edits to Haiku', impact: 'medium', savingsUSD: 8 },
        ],
      },
    }), now, false)
    expect(wins.wins.map(s => s.text)).toEqual([
      'Cache hit at 85%, most prompts reuse cache',
      '82% one-shot, edits land first try',
      '$15.00 saved via local models',
    ])
    expect(wins.improvements).toEqual([
      { text: 'Trim CLAUDE.md preamble', trailing: '$12.00' },
      { text: 'Route trivial edits to Haiku', trailing: '$8.00' },
    ])
    expect(wins.risks).toEqual([])
  })

  it('flags low cache-hit, low one-shot, and heavy retry tax as improvements', () => {
    const now = new Date()
    const { improvements } = deriveSignals(signalsPayload(now, {
      current: {
        cacheHitPercent: 40,
        oneShotRate: 0.4,
        cost: 100,
        retryTax: { totalUSD: 30, retries: 5, editTurns: 10, byModel: [] },
      },
    }), now, false)
    expect(improvements.map(s => s.text)).toEqual([
      'Cache hit only 40%, paying for cold prompts',
      '40% one-shot, lots of iteration',
      'Retry tax is 30% of spend',
    ])
  })

  it('does not treat a zero cache-hit (no data) as a cold-prompt improvement', () => {
    const now = new Date()
    const { improvements } = deriveSignals(signalsPayload(now, {
      current: { cacheHitPercent: 0, oneShotRate: 0.6 },
    }), now, false)
    expect(improvements).toEqual([])
  })

  it('derives streak and a week-over-week drop as wins from history', () => {
    const now = new Date()
    // 14 consecutive active days; prior 7 at $20, recent 7 at $5 → spend down 75%.
    const daily = consecutiveDays(now, 14, i => (i < 7 ? 20 : 5))
    const { wins } = deriveSignals(signalsPayload(now, {
      current: { cacheHitPercent: 60, oneShotRate: 0.6 },
      daily,
    }), now, false)
    expect(wins.map(s => s.text)).toEqual([
      'Spend down 75% vs last 7 days',
      '14-day usage streak',
    ])
  })

  it('reports weekday spike, week-over-week rise, and month overrun as risks', () => {
    const now = new Date(2026, 6, 15) // Jul 15 2026
    // June total = $5 (prior-month baseline); July: prior 7 low, recent 7 high.
    const daily = [mkDay('2026-06-11', 5), ...consecutiveDays(now, 14, i => (i < 7 ? 2 : 20))]
    const { risks } = deriveSignals(signalsPayload(now, {
      current: { cacheHitPercent: 60, oneShotRate: 0.6 },
      daily,
    }), now, false)
    expect(risks).toHaveLength(3)
    expect(risks[0].text).toMatch(/Today's spend is 10× your typical/)
    expect(risks[1].text).toBe('Spend up 900% vs prior 7 days')
    expect(risks[2].text).toMatch(/^On pace for .* this month, \+\d+% vs last$/)
  })

  it('suppresses week-over-week and projection risks under a custom range, keeping the weekday spike', () => {
    const now = new Date(2026, 6, 15)
    const daily = [mkDay('2026-06-11', 5), ...consecutiveDays(now, 14, i => (i < 7 ? 2 : 20))]
    const payload = signalsPayload(now, { current: { cacheHitPercent: 60, oneShotRate: 0.6 }, daily })
    const { risks } = deriveSignals(payload, now, true)
    expect(risks).toHaveLength(1)
    expect(risks[0].text).toMatch(/Today's spend is 10× your typical/)
  })

  it('caps each group at three signals', () => {
    const now = new Date()
    // Five wins would qualify (cache, one-shot, week-down, streak, local); cap keeps 3.
    const daily = consecutiveDays(now, 14, i => (i < 7 ? 20 : 5))
    const { wins } = deriveSignals(signalsPayload(now, {
      current: {
        cacheHitPercent: 85,
        oneShotRate: 0.82,
        localModelSavings: { totalUSD: 15, calls: 4, byModel: [], byProvider: [] },
      },
      daily,
    }), now, false)
    expect(wins).toHaveLength(3)
    expect(wins.map(s => s.text)).toEqual([
      'Cache hit at 85%, most prompts reuse cache',
      '82% one-shot, edits land first try',
      'Spend down 75% vs last 7 days',
    ])
  })

  it('renders the three-column Signals card with optimize findings under Improvements', async () => {
    const now = new Date()
    const payload = signalsPayload(now, {
      current: {
        cacheHitPercent: 85,
        oneShotRate: 0.82,
        localModelSavings: { totalUSD: 15, calls: 4, byModel: [], byProvider: [] },
      },
      optimize: {
        findingCount: 1,
        savingsUSD: 12,
        topFindings: [{ title: 'Trim CLAUDE.md preamble', impact: 'high', savingsUSD: 12 }],
      },
    })

    render(<OverviewContent period="30days" provider="all" overview={polled(payload)} />)

    const signals = await screen.findByLabelText('Coaching signals')
    const wins = within(signals).getByText('Wins').closest('.ov-signal-group') as HTMLElement
    expect(within(wins).getByText(/Cache hit at 85%/)).toBeInTheDocument()
    const improvements = within(signals).getByText('Improvements').closest('.ov-signal-group') as HTMLElement
    expect(within(improvements).getByText('Trim CLAUDE.md preamble')).toBeInTheDocument()
    expect(within(improvements).getByText('$12.00')).toBeInTheDocument()
  })

  it('renders no Signals card when every group is empty', async () => {
    const now = new Date()
    const payload = signalsPayload(now, {
      current: { cacheHitPercent: 60, oneShotRate: 0.6 },
      daily: [],
      optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] },
    })

    render(<OverviewContent period="30days" provider="all" overview={polled(payload)} />)

    expect(await screen.findByText('Daily spend')).toBeInTheDocument()
    expect(screen.queryByLabelText('Coaching signals')).not.toBeInTheDocument()
  })

  it('renders section costs in the active non-USD currency (rate applied once, symbol swapped)', async () => {
    setActiveCurrency({ code: 'EUR', symbol: '€', rate: 0.9 })
    const now = new Date()
    getOverview.mockResolvedValue(makePayload(now))

    render(<Overview period="30days" provider="all" />)

    // Cost per outcome sources raw-USD yield values: $/commit = 150/6 = 25 → €22.50,
    // $/productive session = 120/3 = 40 → €36.00 (rate applied exactly once).
    const outcome = (await screen.findByText('Cost per outcome')).closest('.ov-panel') as HTMLElement
    expect(within(outcome).getByText('€22.50')).toBeInTheDocument()
    expect(within(outcome).getByText('€36.00')).toBeInTheDocument()
  })
})
