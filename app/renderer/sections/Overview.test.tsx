// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActReportJson, MenubarPayload, StatusJson, YieldJsonReport } from '../lib/types'
import { Overview, localDateKey } from './Overview'

// Mock the typed bridge so the section fetches our payload instead of spawning
// the CLI. `normalizeCliError` (used by usePolled) is kept from the real module.
// `vi.hoisted` lets the hoisted `vi.mock` factory reference the spy safely.
const { getOverview, getPlans, getActReport, getYield } = vi.hoisted(() => ({
  getOverview: vi.fn<(period: string, provider: string) => Promise<MenubarPayload>>(),
  getPlans: vi.fn<(period: string) => Promise<StatusJson>>(),
  getActReport: vi.fn<() => Promise<ActReportJson>>(),
  getYield: vi.fn<(period: string) => Promise<YieldJsonReport>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getOverview, getPlans, getActReport, getYield } }
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
 * trend chart keeps its contiguous 30-day window.
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

describe('Overview', () => {
  beforeEach(() => {
    getOverview.mockReset()
    getPlans.mockReset()
    getActReport.mockReset()
    getYield.mockReset()
    getPlans.mockResolvedValue({
      currency: 'USD',
      today: { cost: 0, savings: 0, calls: 0 },
      month: { cost: 0, savings: 0, calls: 0 },
      plan: {
        id: 'claude-pro', provider: 'claude', budget: 100, spent: 82, percentUsed: 82,
        status: 'near', projectedMonthEnd: 120, daysUntilReset: 4,
        periodStart: '2026-07-01', periodEnd: '2026-08-01',
      },
    })
    getActReport.mockResolvedValue({ totals: { realizedCostUSD: 84.2, measuredActions: 11 } })
    getYield.mockResolvedValue(makeYieldReport())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders real hero, model, plan, saved, session, and daily-chart data", async () => {
    const now = new Date()
    getOverview.mockResolvedValue(makePayload(now))

    const { container } = render(<Overview period="30days" provider="all" />)

    // The hero shows the SELECTED PERIOD's total (current.cost) + label, not
    // just today — so a 30-day view reads $312.40 under "Last 30 days".
    expect(await screen.findByText('$312.40')).toBeInTheDocument()
    expect(screen.getByText('Last 30 days')).toBeInTheDocument()
    expect(container.querySelector('.ov-streak')).toHaveTextContent('30-day streak')

    // The KPI strip surfaces the payload's previously hidden success/cache
    // metrics, and the saved KPI remains backed by the ACT report poll.
    const kpis = screen.getByLabelText('Key performance indicators')
    expect(within(kpis).getByText('74%')).toBeInTheDocument()
    expect(within(kpis).getByText('63%')).toBeInTheDocument()
    expect(within(kpis).getByText('$84.20')).toBeInTheDocument()

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
    const modelRows = within(modelsTable).getAllByRole('row')
    expect(modelRows[1]).toHaveTextContent('claude-opus-4')
    expect(modelRows[1]).toHaveTextContent('1.2B')
    expect(modelRows[1]).toHaveTextContent('60.0M')
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

    expect(screen.getByText('82%')).toBeInTheDocument()
    expect(screen.getByText('$84.20')).toBeInTheDocument()
    expect(screen.getByText('from 11 applied fixes')).toBeInTheDocument()
  })

  it('renders efficiency, cost-per-outcome, and real anomaly widgets', async () => {
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
    const anomalies = screen.getByLabelText('Spend anomalies')
    expect(anomalies).toHaveTextContent(/Today's spend is 10× your typical/)
  })

  it('uses honest empty states when no budget or realized savings exist', async () => {
    const now = new Date()
    getOverview.mockResolvedValue(makePayload(now))
    getPlans.mockResolvedValue({
      currency: 'USD',
      today: { cost: 0, savings: 0, calls: 0 },
      month: { cost: 0, savings: 0, calls: 0 },
    })
    getActReport.mockResolvedValue({ totals: { realizedCostUSD: 0, measuredActions: 7 } })

    render(<Overview period="30days" provider="all" />)

    expect(await screen.findByText('No budget set')).toBeInTheDocument()
    await waitFor(() => expect(getActReport).toHaveBeenCalled())
    expect(screen.getByText('$0.00')).toBeInTheDocument()
    expect(screen.getByText('from 0 applied fixes')).toBeInTheDocument()
  })

  it('always shows at least a 30-day window regardless of the selected period', async () => {
    const now = new Date()
    getOverview.mockResolvedValue(makePayload(now))

    // The daily chart is a trend, not scoped to the period selector: even for a
    // short period like "week" it renders a contiguous >= 30-day window,
    // backfilling days with no activity as zero-height bars.
    const { container } = render(<Overview period="week" provider="all" />)

    expect(await screen.findByText('parser-service')).toBeInTheDocument()
    expect(container.querySelectorAll('.chart .col')).toHaveLength(30)
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

  it('recovers a matched session model for the series dot and sub-line', async () => {
    const now = new Date()
    getOverview.mockResolvedValue(makePayload(now))

    const { container } = render(<Overview period="30days" provider="all" />)

    // parser-service session joins topProjects sessionDetails on
    // (project|date|calls|cost) → claude-opus-4 → blue dot + model in sub-line.
    expect(await screen.findByText('Jul 8 · claude-opus-4 · 41 calls')).toBeInTheDocument()
    const firstDot = container.querySelectorAll('.li')[0].querySelector('.mdot')
    expect(firstDot?.getAttribute('style')).toContain('var(--blue)')

    // pairing-svc has no matching project → neutral dot, model omitted from sub.
    expect(screen.getByText('Jul 7 · 33 calls')).toBeInTheDocument()
    const secondDot = container.querySelectorAll('.li')[1].querySelector('.mdot')
    expect(secondDot?.getAttribute('style')).toContain('var(--t3)')
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
    const dots = container.querySelectorAll('.li .mdot')
    expect(dots[0].getAttribute('style')).toContain('var(--blue)') // $10 → opus
    expect(dots[1].getAttribute('style')).toContain('var(--lav)') // $2 → haiku
  })

  it('shows the first-run locate-CLI state when the binary is missing', async () => {
    getOverview.mockRejectedValue({ kind: 'not-found', message: 'codeburn not found' })

    render(<Overview period="30days" provider="all" />)

    expect(await screen.findByText(/Locate the codeburn CLI/i)).toBeInTheDocument()
  })
})
