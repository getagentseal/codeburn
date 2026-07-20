// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { formatDayShort } from '../lib/format'
import type { MenubarPayload } from '../lib/types'
import { PullRequests } from './PullRequests'

type PrPayload = NonNullable<MenubarPayload['current']['pullRequests']>

const { getOverview, openExternal } = vi.hoisted(() => ({
  getOverview: vi.fn<(period: string, provider: string) => Promise<MenubarPayload>>(),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getOverview, openExternal } }
})

// Mirror the component's span rule so the assertion stays timezone-safe.
function expectedSpan(first: string, last: string): string {
  const start = formatDayShort(first)
  const end = formatDayShort(last)
  return start === end ? start : `${start} - ${end}`
}

function makePayload(pullRequests?: PrPayload): MenubarPayload {
  return {
    generated: '2026-07-20T00:00:00Z',
    current: {
      label: 'Lifetime', cost: 0, calls: 0, sessions: 0, oneShotRate: null,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitPercent: 0,
      codexCredits: 0, topActivities: [], topModels: [],
      localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
      providers: {}, topProjects: [], modelEfficiency: [], topSessions: [],
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: [], skills: [], subagents: [], mcpServers: [],
      ...(pullRequests ? { pullRequests } : {}),
    },
    optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] },
    history: { daily: [] },
  }
}

const SAMPLE: PrPayload = {
  rows: [
    { url: 'https://github.com/getagentseal/codeburn/pull/780', label: 'getagentseal/codeburn#780', cost: 240.5, savingsUSD: 0, sessions: 3, calls: 512, firstStarted: '2026-07-01T10:00:00Z', lastEnded: '2026-07-03T18:00:00Z' },
    { url: 'https://github.com/getagentseal/codeburn/pull/781', label: 'getagentseal/codeburn#781', cost: 90.25, savingsUSD: 0, sessions: 1, calls: 120, firstStarted: '2026-07-05T13:00:00Z', lastEnded: '2026-07-05T15:00:00Z' },
  ],
  distinctCost: 300.75,
  distinctSessions: 3,
}

describe('PullRequests', () => {
  beforeEach(() => {
    getOverview.mockReset()
    openExternal.mockReset()
    openExternal.mockResolvedValue(undefined)
  })

  it('renders PR rows as a table with linked labels, cost, and a date span', async () => {
    getOverview.mockResolvedValue(makePayload(SAMPLE))
    render(<PullRequests period="lifetime" provider="all" />)

    const link = await screen.findByRole('link', { name: 'getagentseal/codeburn#780' })
    expect(link).toHaveAttribute('href', 'https://github.com/getagentseal/codeburn/pull/780')
    expect(screen.getByText('$240.50')).toBeInTheDocument()
    expect(screen.getByText('512')).toBeInTheDocument()
    expect(screen.getByText(expectedSpan(SAMPLE.rows[0]!.firstStarted, SAMPLE.rows[0]!.lastEnded))).toBeInTheDocument()
    // A same-day PR collapses its span to a single label.
    expect(screen.getByText(expectedSpan(SAMPLE.rows[1]!.firstStarted, SAMPLE.rows[1]!.lastEnded))).toBeInTheDocument()
  })

  it('opens the PR URL externally instead of navigating', async () => {
    getOverview.mockResolvedValue(makePayload(SAMPLE))
    render(<PullRequests period="lifetime" provider="all" />)

    const link = await screen.findByRole('link', { name: 'getagentseal/codeburn#780' })
    await userEvent.click(link)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/getagentseal/codeburn/pull/780')
  })

  it('states the distinct-total footer explaining by-reference attribution', async () => {
    getOverview.mockResolvedValue(makePayload(SAMPLE))
    render(<PullRequests period="lifetime" provider="all" />)

    const note = await screen.findByText(/produced pull requests/)
    expect(note.textContent).toContain('$300.75')
    expect(note.textContent).toContain('3 distinct sessions')
    expect(note.textContent).toContain('counts toward each')
  })

  it('shows the quiet empty state (never a fake table) when no PR links exist', async () => {
    getOverview.mockResolvedValue(makePayload())
    render(<PullRequests period="lifetime" provider="all" />)

    expect(await screen.findByText(/PR links are captured as sessions are parsed/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows the empty state when the PR array is present but empty', async () => {
    getOverview.mockResolvedValue(makePayload({ rows: [], distinctCost: 0, distinctSessions: 0 }))
    render(<PullRequests period="lifetime" provider="all" />)

    expect(await screen.findByText(/PR links are captured as sessions are parsed/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
