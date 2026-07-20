// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
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
    { url: 'https://github.com/getagentseal/codeburn/pull/780', label: 'getagentseal/codeburn#780', cost: 240.5, savingsUSD: 0, sessions: 3, calls: 512, firstStarted: '2026-07-01T10:00:00Z', lastEnded: '2026-07-03T18:00:00Z', models: ['fable', 'opus', 'haiku'], categories: [{ name: 'Feature work', cost: 180.25 }, { name: 'Debugging', cost: 60.25 }] },
    { url: 'https://github.com/getagentseal/codeburn/pull/781', label: 'getagentseal/codeburn#781', cost: 90.25, savingsUSD: 0, sessions: 1, calls: 120, firstStarted: '2026-07-05T13:00:00Z', lastEnded: '2026-07-05T15:00:00Z', models: ['sonnet'], categories: [{ name: 'Refactoring', cost: 90.25 }] },
  ],
  distinctCost: 376.05,
  distinctSessions: 3,
  attributedCost: 330.75,
  unattributedCost: 45.3,
  otherPrCount: 0,
  otherPrCost: 0,
}

// Get the button-role row wrapping a given PR link, for click/keyboard toggling.
function rowForLink(link: HTMLElement): HTMLElement {
  const row = link.closest('[role="button"]')
  if (!row) throw new Error('expected a button-role row around the PR link')
  return row as HTMLElement
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

  it('renders the Models column with a "+N" overflow tag', async () => {
    getOverview.mockResolvedValue(makePayload(SAMPLE))
    render(<PullRequests period="lifetime" provider="all" />)

    // Three models collapse to the first two plus a count of the rest.
    expect(await screen.findByText('fable, opus +1')).toBeInTheDocument()
    // A single model renders as-is, with no overflow tag.
    expect(screen.getByText('sonnet')).toBeInTheDocument()
  })

  it('opens the PR URL externally without navigating or toggling the row', async () => {
    getOverview.mockResolvedValue(makePayload(SAMPLE))
    render(<PullRequests period="lifetime" provider="all" />)

    const link = await screen.findByRole('link', { name: 'getagentseal/codeburn#780' })
    await userEvent.click(link)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/getagentseal/codeburn/pull/780')
    // Clicking the link must not expand its row.
    expect(rowForLink(link)).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Feature work')).toBeNull()
  })

  it('expands a row to its category breakdown on click, then collapses', async () => {
    getOverview.mockResolvedValue(makePayload(SAMPLE))
    render(<PullRequests period="lifetime" provider="all" />)

    const link = await screen.findByRole('link', { name: 'getagentseal/codeburn#780' })
    const row = rowForLink(link)
    expect(row).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Feature work')).toBeInTheDocument()
    expect(screen.getByText('$180.25')).toBeInTheDocument()
    expect(screen.getByText('Debugging')).toBeInTheDocument()

    await userEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Feature work')).toBeNull()
  })

  it('closes an open expansion when the period changes the PR set', async () => {
    const changed: PrPayload = { ...SAMPLE, rows: [SAMPLE.rows[0]!] } // #781 dropped
    getOverview.mockImplementation((period: string) => Promise.resolve(makePayload(period === 'lifetime' ? SAMPLE : changed)))
    const { rerender } = render(<PullRequests period="lifetime" provider="all" />)

    const link = await screen.findByRole('link', { name: 'getagentseal/codeburn#780' })
    await userEvent.click(rowForLink(link))
    expect(rowForLink(link)).toHaveAttribute('aria-expanded', 'true')

    rerender(<PullRequests period="week" provider="all" />)
    // The new period drops #781, so the PR set changes and the stale expansion
    // resets once the new data lands (wait for the breakdown to disappear).
    await waitFor(() => expect(screen.queryByText('Feature work')).toBeNull())
    const link2 = await screen.findByRole('link', { name: 'getagentseal/codeburn#780' })
    expect(rowForLink(link2)).toHaveAttribute('aria-expanded', 'false')
  })

  it('toggles expansion from the keyboard with Enter', async () => {
    getOverview.mockResolvedValue(makePayload(SAMPLE))
    render(<PullRequests period="lifetime" provider="all" />)

    const link = await screen.findByRole('link', { name: 'getagentseal/codeburn#780' })
    const row = rowForLink(link)
    row.focus()

    await userEvent.keyboard('{Enter}')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Feature work')).toBeInTheDocument()

    await userEvent.keyboard('{Enter}')
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })

  it('states the attributed-total footer and the summable framing', async () => {
    getOverview.mockResolvedValue(makePayload(SAMPLE))
    render(<PullRequests period="lifetime" provider="all" />)

    const note = await screen.findByText(/attributed to the rows above/)
    expect(note.textContent).toContain('$330.75')
    expect(note.textContent).toContain('3 PR-linked sessions')
    expect(note.textContent).toContain('summable')
    expect(screen.getByText(/Not tied to a specific PR/).textContent).toContain('$45.30')
  })

  it('marks an approximate (legacy) row with a ~ prefix and a tooltip', async () => {
    const approxPayload: PrPayload = {
      rows: [
        { url: 'https://github.com/getagentseal/codeburn/pull/900', label: 'getagentseal/codeburn#900', cost: 12.5, savingsUSD: 0, sessions: 1, calls: 30, firstStarted: '2026-07-10T10:00:00Z', lastEnded: '2026-07-10T11:00:00Z', approx: true },
      ],
      distinctCost: 12.5,
      distinctSessions: 1,
      attributedCost: 12.5,
      unattributedCost: 0,
    }
    getOverview.mockResolvedValue(makePayload(approxPayload))
    render(<PullRequests period="lifetime" provider="all" />)

    const cost = await screen.findByText('~$12.50')
    expect(cost).toHaveAttribute('title')
    // A zero unattributed remainder hides the muted line.
    expect(screen.queryByText(/Not tied to a specific PR/)).toBeNull()
  })

  it('expands a category-less (legacy) row to a muted note, not an empty box', async () => {
    const approxPayload: PrPayload = {
      rows: [
        { url: 'https://github.com/getagentseal/codeburn/pull/900', label: 'getagentseal/codeburn#900', cost: 12.5, savingsUSD: 0, sessions: 1, calls: 30, firstStarted: '2026-07-10T10:00:00Z', lastEnded: '2026-07-10T11:00:00Z', approx: true },
      ],
      distinctCost: 12.5,
      distinctSessions: 1,
      attributedCost: 12.5,
      unattributedCost: 0,
    }
    getOverview.mockResolvedValue(makePayload(approxPayload))
    render(<PullRequests period="lifetime" provider="all" />)

    const link = await screen.findByRole('link', { name: 'getagentseal/codeburn#900' })
    await userEvent.click(rowForLink(link))
    expect(screen.getByText(/No per-turn detail/)).toBeInTheDocument()
  })

  it('renders the old-CLI by-reference footer without NaN and never claims summable', async () => {
    const oldPayload: PrPayload = {
      rows: [
        { url: 'https://github.com/getagentseal/codeburn/pull/500', label: 'getagentseal/codeburn#500', cost: 120.4, savingsUSD: 0, sessions: 2, calls: 300, firstStarted: '2026-06-01T10:00:00Z', lastEnded: '2026-06-02T12:00:00Z' },
      ],
      distinctCost: 120.4,
      distinctSessions: 2,
    }
    getOverview.mockResolvedValue(makePayload(oldPayload))
    render(<PullRequests period="lifetime" provider="all" />)

    const note = await screen.findByText(/produced pull requests/)
    expect(note.textContent).toContain('$120.40')
    expect(note.textContent).toContain('by reference')
    expect(note.textContent).toContain('not summed')
    expect(note.textContent).not.toContain('summable')
    // No optional field renders as NaN and no unattributed line appears.
    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.queryByText(/Not tied to a specific PR/)).toBeNull()
  })

  it('renders an Other (N more PRs) reconciliation row when PRs are capped', async () => {
    const cappedPayload: PrPayload = {
      rows: [
        { url: 'https://github.com/getagentseal/codeburn/pull/780', label: 'getagentseal/codeburn#780', cost: 200, savingsUSD: 0, sessions: 3, calls: 512, firstStarted: '2026-07-01T10:00:00Z', lastEnded: '2026-07-03T18:00:00Z', models: ['fable'], categories: [{ name: 'Feature work', cost: 200 }] },
      ],
      distinctCost: 288.4,
      distinctSessions: 4,
      attributedCost: 288.4,
      unattributedCost: 0,
      otherPrCount: 5,
      otherPrCost: 88.4,
    }
    getOverview.mockResolvedValue(makePayload(cappedPayload))
    render(<PullRequests period="lifetime" provider="all" />)

    expect(await screen.findByText('Other (5 more PRs)')).toBeInTheDocument()
    expect(screen.getByText('$88.40')).toBeInTheDocument()
  })

  it('shows the quiet empty state (never a fake table) when no PR links exist', async () => {
    getOverview.mockResolvedValue(makePayload())
    render(<PullRequests period="lifetime" provider="all" />)

    expect(await screen.findByText(/PR links are captured as sessions are parsed/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows the empty state when the PR array is present but empty', async () => {
    getOverview.mockResolvedValue(makePayload({ rows: [], distinctCost: 0, distinctSessions: 0, attributedCost: 0, unattributedCost: 0 }))
    render(<PullRequests period="lifetime" provider="all" />)

    expect(await screen.findByText(/PR links are captured as sessions are parsed/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
