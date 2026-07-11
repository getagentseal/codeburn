// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StatusJson } from '../lib/types'
import { Plans } from './Plans'

const { getPlans } = vi.hoisted(() => ({
  getPlans: vi.fn<(period: string) => Promise<StatusJson>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getPlans } }
})

const statusWithPlans: StatusJson = {
  currency: 'USD',
  today: { cost: 22.5, savings: 4.2, calls: 19 },
  month: { cost: 269.02, savings: 52, calls: 181 },
  plans: {
    claude: {
      id: 'claude-max',
      provider: 'claude',
      budget: 200,
      spent: 230,
      percentUsed: 115,
      status: 'over',
      projectedMonthEnd: 254,
      daysUntilReset: 4,
      periodStart: '2026-06-15T00:00:00.000Z',
      periodEnd: '2026-07-14T00:00:00.000Z',
    },
    cursor: {
      id: 'cursor-pro',
      provider: 'cursor',
      budget: 20,
      spent: 8.2,
      percentUsed: 41,
      status: 'under',
      projectedMonthEnd: 12.4,
      daysUntilReset: 4,
      periodStart: '2026-06-15T00:00:00.000Z',
      periodEnd: '2026-07-14T00:00:00.000Z',
    },
    codex: {
      id: 'none',
      provider: 'codex',
      budget: 0,
      spent: 31.02,
      percentUsed: 15,
      status: 'under',
      projectedMonthEnd: 31.02,
      daysUntilReset: 4,
      periodStart: '2026-06-15T00:00:00.000Z',
      periodEnd: '2026-07-14T00:00:00.000Z',
    },
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
    expect(screen.getByText('Cycle Jun 15 - Jul 14 · day 26 of 30')).toBeInTheDocument()
    expect(screen.getByText('Cycle: Jun 15 - Jul 14')).toBeInTheDocument()
    expect(screen.getByText('$200.00 / month · claude')).toBeInTheDocument()
    expect(screen.getByText('$230.00 · 115% · $30.00 over')).toBeInTheDocument()

    const claudeFill = container.querySelector('[data-testid="plan-track-claude"] i')
    expect(claudeFill).toHaveStyle({ width: '100%' })
    expect(claudeFill).toHaveClass('over')

    const hotPace = screen.getByText('On pace to exceed - projected $254.00 by Jul 14')
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
})
