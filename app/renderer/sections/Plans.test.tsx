// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { JsonPlanSummary, StatusJson } from '../lib/types'
import { Plans } from './Plans'

const { getPlans } = vi.hoisted(() => ({
  getPlans: vi.fn<(period: string) => Promise<StatusJson>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getPlans } }
})

const periodStart = new Date(2026, 5, 15).toISOString()
const periodEnd = new Date(2026, 6, 15).toISOString()

const claudePlan: JsonPlanSummary = {
  id: 'claude-max',
  provider: 'claude',
  budget: 200,
  spent: 230,
  percentUsed: 115,
  status: 'over',
  projectedMonthEnd: 254,
  daysUntilReset: 4,
  periodStart,
  periodEnd,
}

const cursorPlan: JsonPlanSummary = {
  id: 'cursor-pro',
  provider: 'cursor',
  budget: 20,
  spent: 8.2,
  percentUsed: 41,
  status: 'under',
  projectedMonthEnd: 12.4,
  daysUntilReset: 4,
  periodStart,
  periodEnd,
}

const codexPlan: JsonPlanSummary = {
  id: 'none',
  provider: 'codex',
  budget: 0,
  spent: 31.02,
  percentUsed: 15,
  status: 'under',
  projectedMonthEnd: 31.02,
  daysUntilReset: 4,
  periodStart,
  periodEnd,
}

const baseStatus = {
  currency: 'USD',
  today: { cost: 22.5, savings: 4.2, calls: 19 },
  month: { cost: 269.02, savings: 52, calls: 181 },
} satisfies Omit<StatusJson, 'plan' | 'plans'>

const statusWithPlans: StatusJson = {
  ...baseStatus,
  plans: {
    claude: claudePlan,
    cursor: cursorPlan,
    codex: codexPlan,
  },
}

describe('Plans', () => {
  beforeEach(() => {
    getPlans.mockReset()
  })

  it('renders plan rows from StatusJson with clamped tracks, overage, pace, and cycle caption', async () => {
    getPlans.mockResolvedValue(statusWithPlans)

    const { container } = render(<Plans period="30days" />)

    expect(await screen.findByText('Claude Max')).toBeInTheDocument()
    expect([...container.querySelectorAll('.plrow b')].map(row => row.textContent)).toEqual([
      'Claude Max',
      'API usage',
      'Cursor Pro',
    ])
    expect(screen.getByText('Cycle Jun 15 – Jul 14 · day 26 of 30')).toBeInTheDocument()
    expect(screen.getByText('Cycle: Jun 15 – Jul 14')).toBeInTheDocument()
    expect(screen.getByText('$200.00 / month · claude')).toBeInTheDocument()
    expect(screen.getByText('$230.00 · 115% · $30.00 over')).toBeInTheDocument()

    const claudeFill = container.querySelector('[data-testid="plan-track-claude"] i')
    expect(claudeFill).toHaveStyle({ width: '100%' })
    expect(claudeFill).toHaveClass('over')

    const hotPace = screen.getByText('On pace to exceed; projected $254.00 by Jul 14')
    expect(hotPace).toHaveClass('pace', 'hot')

    expect(screen.getByText('Cursor Pro')).toBeInTheDocument()
    expect(screen.getByText('$20.00 / month · cursor')).toBeInTheDocument()
    expect(screen.getByText('$8.20 · 41%')).toBeInTheDocument()
    const cursorFill = container.querySelector('[data-testid="plan-track-cursor"] i')
    expect(cursorFill).toHaveStyle({ width: '41%' })
    expect(cursorFill).not.toHaveClass('over')
    expect(screen.getByText('On track')).toHaveClass('pace', 'ok')

    expect(screen.getByText('API usage')).toBeInTheDocument()
    expect(screen.getByText('codex · pay as you go, no plan')).toBeInTheDocument()
    expect(screen.getByText('$31.02 this cycle')).toBeInTheDocument()
    const codexFill = container.querySelector('[data-testid="plan-track-codex"] i')
    expect(codexFill).toHaveStyle({ width: '15%' })
    expect(codexFill).toHaveClass('mut')
  })

  it('renders near status as an amber non-exceeding projection when below budget', async () => {
    getPlans.mockResolvedValue({
      ...baseStatus,
      plans: {
        grok: {
          id: 'supergrok-heavy',
          provider: 'grok',
          budget: 300,
          spent: 255,
          percentUsed: 85,
          status: 'near',
          projectedMonthEnd: 280,
          daysUntilReset: 4,
          periodStart,
          periodEnd,
        },
      },
    })

    render(<Plans period="30days" />)

    const pace = await screen.findByText('85% of budget used; projected $280.00 by Jul 14')
    expect(pace).toHaveClass('pace', 'hot')
    expect(screen.queryByText(/On pace to exceed/)).not.toBeInTheDocument()
  })

  it('falls back to StatusJson.plan when the CLI returns a singular plan summary', async () => {
    getPlans.mockResolvedValue({
      ...baseStatus,
      plan: cursorPlan,
    })

    render(<Plans period="month" />)

    expect(await screen.findByText('Cursor Pro')).toBeInTheDocument()
    expect(screen.getByText('Cycle Jun 15 – Jul 14 · day 26 of 30')).toBeInTheDocument()
  })

  it('renders an honest empty state when StatusJson has no plan summaries', async () => {
    getPlans.mockResolvedValue({
      currency: 'USD',
      today: { cost: 0, savings: 0, calls: 0 },
      month: { cost: 0, savings: 0, calls: 0 },
    })

    render(<Plans period="month" />)

    expect(await screen.findByText('No plans configured')).toBeInTheDocument()
    expect(screen.getByText('Add a plan in the CLI settings to see budget pacing here.')).toBeInTheDocument()
  })

  it('renders the CLI locate state when getPlans reports not-found', async () => {
    getPlans.mockRejectedValue({ kind: 'not-found', message: 'codeburn not found' })

    render(<Plans period="week" />)

    expect(await screen.findByText('Locate the codeburn CLI')).toBeInTheDocument()
  })

  it('renders permission-denied CLI failures as the amber Full Disk Access state', async () => {
    getPlans.mockRejectedValue({ kind: 'nonzero', message: 'Cursor permission denied: grant Full Disk Access' })

    render(<Plans period="week" />)

    expect(await screen.findByText('Permission denied')).toBeInTheDocument()
    expect(screen.getByText('permission denied; grant Full Disk Access')).toHaveStyle({ color: 'var(--amber)' })
  })
})
