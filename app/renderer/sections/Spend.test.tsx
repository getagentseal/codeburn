// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Polled } from '../hooks/usePolled'
import type { MenubarPayload, SpendFlow } from '../lib/types'
import { Spend, SpendContent } from './Spend'

const ROOT_WEEK_OVERVIEW = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/overview-week-all.json'), 'utf8'),
) as MenubarPayload

function polled(data: MenubarPayload): Polled<MenubarPayload> {
  return { data, error: null, loading: false, switching: false, lastSuccessAt: Date.now(), refresh: vi.fn() }
}

const { getOverview, getSpendFlow, getTimeline } = vi.hoisted(() => ({
  getOverview: vi.fn<(period: string, provider: string) => Promise<MenubarPayload>>(),
  getSpendFlow: vi.fn<(period: string, provider: string) => Promise<SpendFlow>>(),
  getTimeline: vi.fn<(period: string, provider: string) => Promise<MenubarPayload>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getOverview, getSpendFlow, getTimeline } }
})

function daily(date: string, cost: number, models: Array<{ name: string; cost: number }>) {
  return {
    date,
    cost,
    savingsUSD: 0,
    calls: 10,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    topModels: models.map(m => ({
      name: m.name,
      cost: m.cost,
      savingsUSD: 0,
      calls: 5,
      inputTokens: 0,
      outputTokens: 0,
    })),
  }
}

function makePayload(now: Date): MenubarPayload {
  return {
    generated: now.toISOString(),
    current: {
      label: 'Last 30 days',
      cost: 612.48,
      calls: 1220,
      sessions: 88,
      oneShotRate: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitPercent: 0,
      codexCredits: 0,
      topActivities: [{ name: 'coding', cost: 42, savingsUSD: 0, turns: 12, oneShotRate: null }],
      topModels: [],
      localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
      providers: {},
      topProjects: [
        {
          name: 'codeburn',
          cost: 246.1,
          savingsUSD: 0,
          sessions: 124,
          avgCostPerSession: 1.98,
          sessionDetails: [],
        },
        {
          name: 'agentseal-dash',
          cost: 141.3,
          savingsUSD: 0,
          sessions: 74,
          avgCostPerSession: 1.91,
          sessionDetails: [],
        },
      ],
      modelEfficiency: [],
      topSessions: [],
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: [{ name: 'Read', calls: 30 }],
      skills: [{ name: 'imagegen', turns: 3, cost: 1.25 }],
      subagents: [{ name: 'reviewer', calls: 2, cost: 2.5 }],
      mcpServers: [{ name: 'filesystem', calls: 9 }],
    },
    optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] },
    history: {
      daily: [
        daily('2026-06-30', 11, [{ name: 'claude-opus-4', cost: 11 }]),
        daily('2026-07-01', 12, [{ name: 'gpt-5.5-codex', cost: 12 }]),
        daily('2026-07-04', 13, [{ name: 'claude-opus-4', cost: 9 }, { name: 'claude-sonnet-5', cost: 4 }]),
        daily('2026-07-06', 8, [{ name: 'claude-haiku-4', cost: 8 }]),
        daily('2026-07-10', 15, [{ name: 'gpt-5.5-codex', cost: 15 }]),
      ],
    },
  }
}

function makeFlow(): SpendFlow {
  return {
    period: { label: 'Last 7 days', start: '2026-07-04', end: '2026-07-10' },
    models: [
      { id: 'claude-opus-4-20260701', label: 'claude-opus-4-20260701', cost: 22 },
      { id: 'gpt-5.5-codex', label: 'gpt-5.5-codex', cost: 18 },
    ],
    projects: [
      { id: '/Users/me/src/mobile-app', label: '/Users/me/src/mobile-app', cost: 30 },
      { id: '__other__', label: '__other__', cost: 10 },
    ],
    links: [
      { model: 'claude-opus-4-20260701', project: '/Users/me/src/mobile-app', cost: 18 },
      { model: 'claude-opus-4-20260701', project: '__other__', cost: 4 },
      { model: 'gpt-5.5-codex', project: '/Users/me/src/mobile-app', cost: 12 },
      { model: 'gpt-5.5-codex', project: '__other__', cost: 6 },
    ],
  }
}

function emptyFlow(): SpendFlow {
  return {
    period: { label: 'Last 7 days', start: '2026-07-04', end: '2026-07-10' },
    models: [],
    projects: [],
    links: [],
  }
}

describe('Spend', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 6, 10, 12, 0, 0))
    getOverview.mockReset()
    getSpendFlow.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('zero-fills a contiguous 15-day calendar window with a real date axis, projects, and Sankey ribbons', async () => {
    getOverview.mockResolvedValue(makePayload(new Date()))
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    const { container } = render(<Spend period="week" provider="all" />)

    expect(await screen.findByText('codeburn')).toBeInTheDocument()
    expect(screen.getByText('$246.10')).toBeInTheDocument()
    expect(screen.getByText('agentseal-dash')).toBeInTheDocument()
    expect(screen.getByText('top 2')).toBeInTheDocument()

    // Sparse history is zero-filled into 15 contiguous days ending today (Jul 10),
    // so the axis reflects real calendar spacing rather than compressing gaps.
    const barColumns = container.querySelectorAll('.sbars .c')
    expect(barColumns).toHaveLength(15)
    expect([...barColumns].map(col => col.getAttribute('data-date'))).toEqual([
      '2026-06-26', '2026-06-27', '2026-06-28', '2026-06-29', '2026-06-30',
      '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05',
      '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10',
    ])
    const ticks = container.querySelectorAll('.sbars-wrap > .ov-xax span')
    expect([...ticks].map(tick => tick.textContent)).toEqual(['Jun 26', 'Jun 30', 'Jul 4', 'Jul 8', 'Jul 10'])

    expect(container.querySelectorAll('[data-testid="sankey-ribbon"]')).toHaveLength(makeFlow().links.length)
  })

  it('renders the chart, projects, Sankey, and all non-empty breakdowns on one page', async () => {
    getOverview.mockResolvedValue(makePayload(new Date()))
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    render(<Spend period="week" provider="all" />)
    expect(await screen.findByLabelText('Daily spend by model')).toBeInTheDocument()
    expect(screen.getByText('By project')).toBeInTheDocument()
    expect(screen.getByText('Cost flow · model → project')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
    expect(screen.getByText('coding')).toBeInTheDocument()
    expect(screen.getByText('imagegen')).toBeInTheDocument()
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('MCP')).toBeInTheDocument()
    expect(screen.getByText('filesystem')).toBeInTheDocument()
    expect(screen.getByText('Subagents')).toBeInTheDocument()
    expect(screen.getByText('reviewer')).toBeInTheDocument()
  })

  it.each(['Activity', 'Tools', 'MCP', 'Subagents'])('hides an empty %s breakdown', async title => {
    const payload = makePayload(new Date())
    if (title === 'Activity') {
      payload.current.topActivities = []
      payload.current.skills = []
    } else if (title === 'Tools') {
      payload.current.tools = []
    } else if (title === 'MCP') {
      payload.current.mcpServers = []
    } else {
      payload.current.subagents = []
    }
    getOverview.mockResolvedValue(payload)
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    render(<Spend period="week" provider="all" />)
    expect(await screen.findByText('codeburn')).toBeInTheDocument()
    expect(screen.queryByText(title)).not.toBeInTheDocument()
  })

  it('shows one compact empty state when every breakdown is empty', async () => {
    const payload = makePayload(new Date())
    payload.current.topActivities = []
    payload.current.skills = []
    payload.current.tools = []
    payload.current.mcpServers = []
    payload.current.subagents = []
    getOverview.mockResolvedValue(payload)
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    render(<Spend period="week" provider="all" />)

    expect(await screen.findByText('No activity, tool, MCP, or subagent data in this range yet.')).toBeInTheDocument()
    expect(screen.queryByText('Activity')).not.toBeInTheDocument()
    expect(screen.queryByText('Tools')).not.toBeInTheDocument()
    expect(screen.queryByText('MCP')).not.toBeInTheDocument()
    expect(screen.queryByText('Subagents')).not.toBeInTheDocument()
  })

  it('does not render the removed lens tabs', async () => {
    getOverview.mockResolvedValue(makePayload(new Date()))
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    render(<Spend period="week" provider="all" />)
    expect(await screen.findByText('codeburn')).toBeInTheDocument()

    for (const name of ['Projects', 'Activity', 'Tools', 'MCP', 'Subagents']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('groups the top panels and breakdown panels in their page grids', async () => {
    getOverview.mockResolvedValue(makePayload(new Date()))
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    const { container } = render(<Spend period="week" provider="all" />)
    expect(await screen.findByText('codeburn')).toBeInTheDocument()

    expect(container.querySelector('.spend-top-row')?.children).toHaveLength(2)
    expect(container.querySelector('.spend-breakdowns')?.children).toHaveLength(4)
  })

  it('renders empty chart and flow states when no daily spend exists', async () => {
    const payload = makePayload(new Date())
    payload.history.daily = []
    getOverview.mockResolvedValue(payload)
    getSpendFlow.mockResolvedValue(emptyFlow())

    const { container } = render(<Spend period="week" provider="all" />)

    expect(await screen.findByText('No model spend in this range yet.')).toBeInTheDocument()
    expect(container.querySelector('.sbars')).not.toBeInTheDocument()
    expect(await screen.findByText('No model-project flow in this range yet.')).toBeInTheDocument()
  })

  it('renders the flow error path without hiding the rest of spend', async () => {
    getOverview.mockResolvedValue(makePayload(new Date()))
    getSpendFlow.mockRejectedValue({ kind: 'nonzero', message: 'flow command failed' })

    render(<Spend period="week" provider="all" />)

    expect(await screen.findByText('codeburn')).toBeInTheDocument()
    expect(await screen.findByText('flow command failed')).toBeInTheDocument()
  })

  it('renders the not-found panel when codeburn is not on PATH', async () => {
    getOverview.mockRejectedValue({ kind: 'not-found', message: 'codeburn not found' })
    getSpendFlow.mockResolvedValue(emptyFlow())

    render(<Spend period="week" provider="all" />)

    expect(await screen.findByText('Locate the codeburn CLI')).toBeInTheDocument()
    expect(screen.getByText(/isn't on your PATH yet/)).toBeInTheDocument()
  })

  it('maps stacked segments to the expected model series classes', async () => {
    const payload = makePayload(new Date())
    payload.history.daily = [
      daily('2026-07-10', 50, [
        { name: 'claude-opus-4', cost: 5 },
        { name: 'claude-fable-1', cost: 5 },
        { name: 'claude-sonnet-5', cost: 5 },
        { name: 'claude-haiku-4', cost: 5 },
        { name: 'gpt-5.6-sol', cost: 5 },
        { name: 'gpt-5.6-terra', cost: 5 },
        { name: 'gpt-5.6-luna', cost: 5 },
        { name: 'gemini-3.1-pro-preview', cost: 5 },
        { name: 'gemini-3.5-flash', cost: 5 },
        { name: 'mystery-model', cost: 5 },
      ]),
    ]
    getOverview.mockResolvedValue(payload)
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    const { container } = render(<Spend period="week" provider="all" />)
    expect(await screen.findByLabelText('Daily spend by model')).toBeInTheDocument()

    expect(container.querySelector('.sbars .s-flagship')).toBeInTheDocument()
    expect(container.querySelector('.sbars .s-premium')).toBeInTheDocument()
    expect(container.querySelector('.sbars .s-balanced')).toBeInTheDocument()
    expect(container.querySelector('.sbars .s-fast')).toBeInTheDocument()
    expect(container.querySelector('.sbars .s-other')).toBeInTheDocument()
    expect(screen.getByText('Flagship')).toBeInTheDocument()
    expect(screen.getByText('Premium')).toBeInTheDocument()
    expect(screen.getByText('Balanced')).toBeInTheDocument()
    expect(screen.getByText('Fast')).toBeInTheDocument()
    expect(screen.getByText('Other')).toBeInTheDocument()
    expect(screen.queryByText('Opus 4.8')).not.toBeInTheDocument()
    expect(screen.queryByText('Sonnet 5')).not.toBeInTheDocument()
    expect(screen.queryByText('Haiku 4.5')).not.toBeInTheDocument()
    expect(screen.queryByText('GPT-5.5 Codex')).not.toBeInTheDocument()
  })

  it('renders Sankey ribbons with model gradients, neutral other nodes, and shortened labels', async () => {
    getOverview.mockResolvedValue(makePayload(new Date()))
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    const { container } = render(<Spend period="week" provider="all" />)

    expect(await screen.findByText(/opus-4-20260701/)).toBeInTheDocument()
    expect(screen.getByText(/gpt-5.5-codex/)).toBeInTheDocument()
    expect(screen.queryByText(/Opus 4.8/)).not.toBeInTheDocument()
    expect(screen.queryByText(/GPT-5.5 Codex/)).not.toBeInTheDocument()
    const visibleProjectText = [...container.querySelectorAll('svg text')].map(el => el.textContent ?? '').join('\n')
    expect(visibleProjectText).toMatch(/src\/mobile-app/)
    expect(visibleProjectText).not.toMatch(/Users\/me\/src\/mobile-app/)

    const opusRibbon = container.querySelector('[data-testid="sankey-ribbon"][data-model="claude-opus-4-20260701"]')
    expect(opusRibbon?.getAttribute('stroke')).toBe('url(#sankey-claude-opus-4-20260701)')
    const opusStop = container.querySelector('linearGradient[id="sankey-claude-opus-4-20260701"] stop')
    expect(opusStop?.getAttribute('stop-color')).toBe('var(--s-flagship)')
    const otherNode = container.querySelector('[data-testid="sankey-node"][data-node-id="__other__"]')
    expect(otherNode?.getAttribute('fill')).toBe('var(--s-other)')
  })

  it('shows distinct same-basename hyphenated cwd labels on the cost-flow chart', async () => {
    getOverview.mockResolvedValue(makePayload(new Date()))
    getSpendFlow.mockResolvedValue({
      period: { label: 'Today', start: '2026-09-07', end: '2026-09-07' },
      models: [
        { id: 'Opus 4.6', label: 'Opus 4.6', cost: 0.45 },
        { id: 'Sonnet 4.5', label: 'Sonnet 4.5', cost: 0.018 },
      ],
      projects: [
        { id: '/tmp/shared-vault', label: 'tmp/shared-vault', cost: 0.46891 },
        { id: '/tmp/alt/shared-vault', label: 'alt/shared-vault', cost: 0.018 },
      ],
      links: [
        { model: 'Opus 4.6', project: '/tmp/shared-vault', cost: 0.45 },
        { model: 'Sonnet 4.5', project: '/tmp/alt/shared-vault', cost: 0.018 },
      ],
    })
    getTimeline.mockResolvedValue(makePayload(new Date()))

    const { container } = render(<Spend period="today" provider="all" />)

    expect(await screen.findByLabelText(/tmp\/shared-vault/)).toBeInTheDocument()
    expect(screen.getByLabelText(/alt\/shared-vault/)).toBeInTheDocument()
    const visibleProjectText = [...container.querySelectorAll('svg text')].map(el => el.textContent ?? '').join('\n')
    expect(visibleProjectText).toMatch(/tmp\/shared-vault/)
    expect(visibleProjectText).toMatch(/alt\/shared-vault/)
    expect(visibleProjectText).not.toMatch(/shared\/vault/)
    const svgTitles = [...container.querySelectorAll('svg title')].map(el => el.textContent)
    expect(svgTitles).toEqual(expect.arrayContaining(['/tmp/shared-vault', '/tmp/alt/shared-vault']))
  })

  it('expands a project row inline to reveal its sessions, one open row at a time', async () => {
    const user = userEvent.setup()
    const payload = makePayload(new Date())
    payload.current.topProjects[0].sessionDetails = [
      {
        cost: 120.5, savingsUSD: 0, calls: 40, inputTokens: 0, outputTokens: 0, date: '2026-07-09',
        models: [
          { name: 'claude-opus-4', cost: 100, savingsUSD: 0 },
          { name: 'claude-haiku-4', cost: 20.5, savingsUSD: 0 },
        ],
      },
      {
        cost: 44.25, savingsUSD: 0, calls: 12, inputTokens: 0, outputTokens: 0, date: '2026-07-05',
        models: [{ name: 'gpt-5.5-codex', cost: 44.25, savingsUSD: 0 }],
      },
    ]
    payload.current.topProjects[1].sessionDetails = [
      {
        cost: 9.9, savingsUSD: 0, calls: 3, inputTokens: 0, outputTokens: 0, date: '2026-07-02',
        models: [{ name: 'claude-sonnet-5', cost: 9.9, savingsUSD: 0 }],
      },
    ]
    getOverview.mockResolvedValue(payload)
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    render(<Spend period="week" provider="all" />)

    const first = await screen.findByRole('button', { name: /codeburn/ })
    const second = screen.getByRole('button', { name: /agentseal-dash/ })
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'codeburn sessions' })).not.toBeInTheDocument()

    await user.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'true')
    const detail = screen.getByRole('region', { name: 'codeburn sessions' })
    expect(within(detail).getByText('Jul 9')).toBeInTheDocument()
    expect(within(detail).getByText('$120.50')).toBeInTheDocument()
    expect(within(detail).getByText('claude-opus-4')).toBeInTheDocument()
    expect(within(detail).getByText('Jul 5')).toBeInTheDocument()
    expect(within(detail).getByText('$44.25')).toBeInTheDocument()

    // Expanding another project collapses the first (single open row).
    await user.click(second)
    expect(second).toHaveAttribute('aria-expanded', 'true')
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'codeburn sessions' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'agentseal-dash sessions' })).getByText('$9.90')).toBeInTheDocument()

    // Clicking the open row collapses it in place.
    await user.click(second)
    expect(second).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'agentseal-dash sessions' })).not.toBeInTheDocument()
  })

  it('expands same-basename projects independently when ids differ', async () => {
    const user = userEvent.setup()
    const payload = makePayload(new Date())
    payload.current.topProjects = [
      {
        id: '/tmp/shared-vault',
        name: 'shared-vault',
        cost: 0.47,
        savingsUSD: 0,
        sessions: 2,
        avgCostPerSession: 0.235,
        sessionDetails: [{
          cost: 0.45, savingsUSD: 0, calls: 3, inputTokens: 0, outputTokens: 0, date: '2026-09-07',
          models: [{ name: 'Opus 4.6', cost: 0.45, savingsUSD: 0 }],
        }],
      },
      {
        id: '/tmp/other-vault',
        name: 'other-vault',
        cost: 0.02,
        savingsUSD: 0,
        sessions: 1,
        avgCostPerSession: 0.02,
        sessionDetails: [{
          cost: 0.02, savingsUSD: 0, calls: 1, inputTokens: 0, outputTokens: 0, date: '2026-09-07',
          models: [{ name: 'Haiku 4.5', cost: 0.02, savingsUSD: 0 }],
        }],
      },
      {
        id: '/var/shared-vault',
        name: 'shared-vault',
        cost: 0.01,
        savingsUSD: 0,
        sessions: 1,
        avgCostPerSession: 0.01,
        sessionDetails: [{
          cost: 0.01, savingsUSD: 0, calls: 1, inputTokens: 0, outputTokens: 0, date: '2026-09-07',
          models: [{ name: 'Sonnet 4.5', cost: 0.01, savingsUSD: 0 }],
        }],
      },
    ]
    getOverview.mockResolvedValue(payload)
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    render(<Spend period="today" provider="all" />)

    const sharedRows = await screen.findAllByRole('button', { name: /shared-vault/ })
    expect(sharedRows).toHaveLength(2)
    const firstShared = sharedRows[0]!
    const secondShared = sharedRows[1]!

    await user.click(firstShared)
    expect(firstShared).toHaveAttribute('aria-expanded', 'true')
    expect(secondShared).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Opus 4.6')).toBeInTheDocument()
    expect(screen.queryByText('Sonnet 4.5')).not.toBeInTheDocument()
    expect(screen.queryByText('No session detail for this project.')).not.toBeInTheDocument()

    await user.click(secondShared)
    expect(firstShared).toHaveAttribute('aria-expanded', 'false')
    expect(secondShared).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByText('Opus 4.6')).not.toBeInTheDocument()
    expect(screen.getByText('Sonnet 4.5')).toBeInTheDocument()
  })

  it('shows a lower-bound session phrase and help, not an unqualified count', async () => {
    const payload = makePayload(new Date())
    payload.current.sessionCountBasis = 'partial'
    payload.current.topProjects = [{
      id: '/tmp/count-boundary',
      name: 'vault',
      cost: 4,
      savingsUSD: 0,
      sessions: 3,
      sessionCountBasis: 'partial',
      sessionDetails: [],
    }]
    getOverview.mockResolvedValue(payload)
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(payload)

    render(<Spend period="week" provider="all" />)

    const row = await screen.findByRole('button', { name: /At least 3 sessions/ })
    expect(row).toHaveAccessibleName(/At least 3 sessions/)
    expect(screen.getByText('At least 3 sessions')).toBeInTheDocument()
    expect(screen.getByTitle('Older session logs may be unavailable.')).toBeInTheDocument()
    expect(screen.queryByText(/^3 sessions$/)).not.toBeInTheDocument()
  })

  it('keeps an exact source-only count unqualified', async () => {
    const payload = makePayload(new Date())
    payload.current.sessionCountBasis = 'identity'
    payload.current.topProjects = [{
      id: '/tmp/only',
      name: 'vault',
      cost: 0.012,
      savingsUSD: 0,
      sessions: 1,
      avgCostPerSession: 0.012,
      sessionCountBasis: 'identity',
      sessionDetails: [],
    }]
    getOverview.mockResolvedValue(payload)
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(payload)

    render(<Spend period="today" provider="all" />)

    expect(await screen.findByText('1 session')).toBeInTheDocument()
    expect(screen.queryByText(/At least/)).not.toBeInTheDocument()
  })

  it('replaces legacy duplicate-name rows without leaving a ghost after current ids arrive', () => {
    const current = structuredClone(ROOT_WEEK_OVERVIEW)
    const ids = current.current.topProjects.map(row => row.id)
    expect(new Set(ids).size).toBe(5)
    expect(ids).toHaveLength(5)

    const legacy = structuredClone(current)
    legacy.current.topProjects.splice(1, 0, { ...structuredClone(legacy.current.topProjects[0]!), name: 'shared-vault' })
    legacy.current.topProjects[0]!.name = 'shared-vault'
    for (const row of legacy.current.topProjects) delete row.id

    const { rerender, container } = render(
      <SpendContent period="week" provider="all" overview={polled(legacy)} ready={false} />,
    )
    expect(container.querySelectorAll('.spend-scroll [role=button]')).toHaveLength(6)

    rerender(<SpendContent period="week" provider="all" overview={polled(current)} ready={false} />)
    expect(screen.getByText('top 5')).toBeTruthy()
    expect(container.querySelectorAll('.spend-scroll [role=button]')).toHaveLength(5)
    expect(screen.queryByText('shared-vault')).toBeNull()
  })

  it('expands legacy same-name rows independently when ids are absent', async () => {
    const user = userEvent.setup()
    const payload = makePayload(new Date())
    payload.current.topProjects = [
      {
        name: 'shared-vault',
        cost: 0.45,
        savingsUSD: 0,
        sessions: 1,
        avgCostPerSession: 0.45,
        sessionDetails: [{
          cost: 0.45, savingsUSD: 0, calls: 3, inputTokens: 0, outputTokens: 0, date: '2026-09-07',
          models: [{ name: 'Opus 4.6', cost: 0.45, savingsUSD: 0 }],
        }],
      },
      {
        name: 'shared-vault',
        cost: 0.01,
        savingsUSD: 0,
        sessions: 1,
        avgCostPerSession: 0.01,
        sessionDetails: [{
          cost: 0.01, savingsUSD: 0, calls: 1, inputTokens: 0, outputTokens: 0, date: '2026-09-07',
          models: [{ name: 'Sonnet 4.5', cost: 0.01, savingsUSD: 0 }],
        }],
      },
    ]
    getOverview.mockResolvedValue(payload)
    getSpendFlow.mockResolvedValue(makeFlow())
    getTimeline.mockResolvedValue(makePayload(new Date()))

    render(<Spend period="today" provider="all" />)

    const sharedRows = await screen.findAllByRole('button', { name: /shared-vault/ })
    expect(sharedRows).toHaveLength(2)
    const firstShared = sharedRows[0]!
    const secondShared = sharedRows[1]!

    await user.click(firstShared)
    expect(firstShared).toHaveAttribute('aria-expanded', 'true')
    expect(secondShared).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Opus 4.6')).toBeInTheDocument()
    expect(screen.queryByText('Sonnet 4.5')).not.toBeInTheDocument()

    await user.click(secondShared)
    expect(firstShared).toHaveAttribute('aria-expanded', 'false')
    expect(secondShared).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByText('Opus 4.6')).not.toBeInTheDocument()
    expect(screen.getByText('Sonnet 4.5')).toBeInTheDocument()
  })
})
