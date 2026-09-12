// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_FILTERS } from '../lib/investigation'
import type { SessionRow } from '../lib/types'
import { INITIAL_VISIBLE, sessionRowKey, Sessions } from './Sessions'

const { getSessions, getSessionsContributions } = vi.hoisted(() => ({
  getSessions: vi.fn<(period: string, provider: string) => Promise<SessionRow[]>>(),
  getSessionsContributions: vi.fn<(period: string, provider: string) => Promise<SessionRow[]>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getSessions, getSessionsContributions } }
})

function session(overrides: Partial<SessionRow> & Pick<SessionRow, 'sessionId' | 'project' | 'provider'>): SessionRow {
  return {
    models: ['Default model'],
    cost: 0,
    savingsUSD: 0,
    calls: 1,
    turns: 1,
    inputTokens: 1_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    startedAt: '2026-07-01T10:00:00.000Z',
    endedAt: '2026-07-01T10:01:00.000Z',
    durationMs: 60_000,
    ...overrides,
  }
}

const rows: SessionRow[] = [
  session({
    sessionId: 'claude-session-123456789',
    project: '-Users-devuser-Projects-codeburn',
    provider: 'claude',
    models: ['Opus 4.8'],
    cost: 8.41,
    savingsUSD: 1.25,
    calls: 44,
    turns: 41,
    inputTokens: 1_420_000,
    outputTokens: 64_000,
    cacheReadTokens: 1_130_000,
    cacheWriteTokens: 12_000,
    startedAt: '2026-07-11T10:00:00.000Z',
    endedAt: '2026-07-11T11:35:00.000Z',
    durationMs: 5_700_000,
  }),
  session({
    sessionId: 'codex-session-987654321',
    project: 'client-api',
    provider: 'codex',
    models: ['GPT-5.5 Codex'],
    cost: 3.92,
    calls: 25,
    turns: 22,
    inputTokens: 120_000,
    outputTokens: 16_000,
    cacheReadTokens: 40_000,
    cacheWriteTokens: 4_000,
    endedAt: '2026-07-10T10:30:00.000Z',
    durationMs: 1_800_000,
  }),
  session({
    sessionId: 'claude-alpha-session',
    project: 'alpha-worker',
    provider: 'claude',
    models: ['Haiku 4.5'],
    cost: 1.10,
    turns: 80,
    inputTokens: 45_000,
    outputTokens: 5_000,
    endedAt: '2026-07-09T08:00:00.000Z',
  }),
  session({
    sessionId: 'codex-zeta-session',
    project: 'zeta-search',
    provider: 'codex',
    models: ['GPT-5.5 Codex'],
    cost: 6,
    turns: 10,
    inputTokens: 1_900_000,
    outputTokens: 100_000,
    endedAt: '2026-07-12T08:00:00.000Z',
  }),
  session({
    sessionId: 'claude-docs-session',
    project: 'docs-site',
    provider: 'claude',
    models: ['Sonnet 4.6'],
    cost: 0.50,
    turns: 5,
    inputTokens: 8_000,
    outputTokens: 2_000,
    endedAt: '2026-07-08T08:00:00.000Z',
  }),
  session({
    sessionId: 'codex-tools-session',
    project: 'tools-service',
    provider: 'codex',
    models: ['GPT-5.4 Mini'],
    cost: 2,
    turns: 30,
    inputTokens: 450_000,
    outputTokens: 50_000,
    endedAt: '2026-07-07T08:00:00.000Z',
  }),
]

describe('Sessions', () => {
  beforeEach(() => { getSessions.mockReset(); getSessionsContributions.mockReset() })

  it('shows the first-load skeleton, then yields to the session list', async () => {
    let resolve!: (value: SessionRow[]) => void
    getSessions.mockReturnValue(new Promise<SessionRow[]>(r => { resolve = r }))
    const { container } = render(<Sessions period="30days" provider="all" />)

    expect(container.querySelector('.skel')).toBeInTheDocument()
    expect(screen.getByText('Scanning sessions…')).toHaveClass('sr-only')

    resolve(rows)
    await waitFor(() => expect(container.querySelector('.session-list')).toBeInTheDocument())
    expect(container.querySelector('.skel')).not.toBeInTheDocument()
  })

  it('shows a summary of every filtered session and groups providers', async () => {
    getSessions.mockResolvedValue(rows)
    const { container } = render(<Sessions period="30days" provider="all" />)

    expect(await screen.findByText('6 sessions · $21.93 · 4.2M tokens')).toBeInTheDocument()
    expect(screen.getByText('Claude').closest('.provider-h')).toHaveTextContent('Claude3 sessions$10.01')
    expect(screen.getByText('Codex').closest('.provider-h')).toHaveTextContent('Codex3 sessions$11.92')
    expect(container.querySelectorAll('.session-row')).toHaveLength(6)
    expect(screen.getByText('projects/codeburn')).toBeInTheDocument()
    expect(screen.queryByText('-Users-devuser-Projects-codeburn')).not.toBeInTheDocument()
  })

  it('filters by project and offers to clear a search with no matches', async () => {
    const user = userEvent.setup()
    getSessions.mockResolvedValue(rows)
    const { container } = render(<Sessions period="30days" provider="all" />)
    const search = await screen.findByRole('textbox', { name: 'Search sessions' })

    await user.type(search, 'codeb')
    expect(screen.getByText('1 sessions · $8.41 · 1.5M tokens')).toBeInTheDocument()
    expect(container.querySelectorAll('.session-row')).toHaveLength(1)
    expect(screen.getByText('projects/codeburn')).toBeInTheDocument()
    expect(screen.queryByText('client-api')).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'nothing-here')
    expect(screen.getByText('No sessions match "nothing-here".')).toBeInTheDocument()
    expect(container.querySelectorAll('.session-row')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByText('6 sessions · $21.93 · 4.2M tokens')).toBeInTheDocument()
    expect(container.querySelectorAll('.session-row')).toHaveLength(6)
  })

  it('reorders rows when the sort changes', async () => {
    const user = userEvent.setup()
    getSessions.mockResolvedValue(rows)
    const { container } = render(<Sessions period="30days" provider="all" />)
    await screen.findByText('6 sessions · $21.93 · 4.2M tokens')

    expect(container.querySelector('.session-row .session-title')).toHaveTextContent('zeta/search')
    await user.click(screen.getByRole('tab', { name: 'Turns' }))
    expect(container.querySelector('.session-row .session-title')).toHaveTextContent('alpha/worker')
  })

  it('turns provider grouping off and back on', async () => {
    const user = userEvent.setup()
    getSessions.mockResolvedValue(rows)
    const { container } = render(<Sessions period="30days" provider="all" />)
    const toggle = await screen.findByRole('button', { name: 'Group by provider' })

    expect(container.querySelectorAll('.provider-h')).toHaveLength(2)
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(container.querySelectorAll('.provider-h')).toHaveLength(0)
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(container.querySelectorAll('.provider-h')).toHaveLength(2)
  })

  // 15s timeout: the 125-row render runs the selection math over the full
  // population and the suite executes files in parallel, so the default 5s
  // can trip under load even though the invariant is instant in isolation.
  it('caps a large list and reveals the remaining rows without another fetch', { timeout: 15_000 }, async () => {
    const user = userEvent.setup()
    const largeRows = Array.from({ length: INITIAL_VISIBLE + 5 }, (_, index) => session({
      sessionId: `session-${index}`,
      project: `project-${index}`,
      provider: 'codex',
      cost: INITIAL_VISIBLE + 5 - index,
    }))
    getSessions.mockResolvedValue(largeRows)
    const { container } = render(<Sessions period="30days" provider="all" />)

    expect(await screen.findByText(`Showing ${INITIAL_VISIBLE} of ${INITIAL_VISIBLE + 5}`)).toBeInTheDocument()
    expect(container.querySelectorAll('.session-row')).toHaveLength(INITIAL_VISIBLE)
    await user.click(screen.getByRole('button', { name: 'Show 5 more · 5 remaining' }))
    expect(screen.getByText(`Showing ${INITIAL_VISIBLE + 5} of ${INITIAL_VISIBLE + 5}`)).toBeInTheDocument()
    expect(container.querySelectorAll('.session-row')).toHaveLength(INITIAL_VISIBLE + 5)
    expect(screen.queryByRole('button', { name: /remaining/ })).not.toBeInTheDocument()
    expect(getSessions).toHaveBeenCalledTimes(1)
  })

  it('opens the session in a side drawer, closes on Escape, and returns focus to the row', async () => {
    const user = userEvent.setup()
    getSessions.mockResolvedValue(rows)
    const { container } = render(<Sessions period="30days" provider="all" />)
    await screen.findByText('6 sessions · $21.93 · 4.2M tokens')

    const row = screen.getByRole('button', { name: /projects\/codeburn/ })
    await user.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    const drawer = screen.getByRole('dialog', { name: /session details/i })
    expect(drawer).toBeInTheDocument()
    expect(within(drawer).getByText(/claude · projects\/codeburn/)).toBeInTheDocument()
    expect(within(drawer).getByText(/Jul 11, 2026 → Jul 11, 2026 · 1h 35m/)).toBeInTheDocument()
    expect(container.querySelectorAll('.session-row')).toHaveLength(6)
    for (const label of ['Cost', 'Calls', 'Turns', 'Saved', 'Input', 'Output', 'Cache read', 'Cache write']) {
      expect(within(drawer).getByText(label)).toBeInTheDocument()
    }
    expect(within(drawer).getByText('44% hit')).toBeInTheDocument()

    // Escape closes the drawer (the drawer's own key handler), focus returns
    // to the row control that opened it, and the list keeps all rows.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: /session details/i })).not.toBeInTheDocument()
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(row).toHaveFocus()
    expect(container.querySelectorAll('.session-row')).toHaveLength(6)
  })

  it('closes (invalidates) the drawer when the open session leaves the population', async () => {
    getSessions.mockResolvedValue(rows)
    const onSessionClose = vi.fn()
    const openKey = sessionRowKey(rows[0]!)
    const view = render(<Sessions period="30days" provider="all" openSessionId={openKey} onSessionClose={onSessionClose} />)
    await screen.findByText('6 sessions · $21.93 · 4.2M tokens')
    expect(screen.getByRole('dialog', { name: /session details/i })).toBeInTheDocument()

    // The session disappears from the refreshed population (a manual refresh
    // bumps refreshToken): the drawer must close instead of showing a session
    // that no longer reconciles.
    getSessions.mockResolvedValue(rows.slice(1))
    view.rerender(<Sessions period="30days" provider="all" refreshToken={1} openSessionId={openKey} onSessionClose={onSessionClose} />)
    await screen.findByText(/5 sessions · \$13\.52/)
    expect(onSessionClose).toHaveBeenCalled()
  })

  it('shows the selection chips, per-row contributions, and the separately-labeled full cost', async () => {
    const user = userEvent.setup()
    const drillRows: SessionRow[] = [
      session({
        sessionId: 'mixed-1',
        project: 'mixed-project',
        provider: 'claude',
        cost: 1.0,
        calls: 10,
        turns: 8,
        inputTokens: 700_000,
        outputTokens: 100_000,
      }),
      session({
        sessionId: 'other-2',
        project: 'other-project',
        provider: 'codex',
        cost: 2.0,
        calls: 4,
        turns: 4,
        inputTokens: 100_000,
        outputTokens: 100_000,
      }),
    ].map((row, index) => index === 0
      ? {
          ...row,
          contributions: { segments: [
            { day: '2026-09-10', category: 'coding', branch: null, models: { 'Sonnet 4.5': 0.2 }, prs: [], cost: 0.2, calls: 2, savingsUSD: 0, inputTokens: 140_000, outputTokens: 20_000 },
            { day: '2026-09-10', category: 'debugging', branch: null, models: { 'Sonnet 4.5': 0.8 }, prs: [], cost: 0.8, calls: 8, savingsUSD: 0, inputTokens: 560_000, outputTokens: 80_000 },
          ] },
        }
      : row)
    getSessionsContributions.mockResolvedValue(drillRows)

    const onFiltersChange = vi.fn()
    const { container } = render(
      <Sessions
        period="30days"
        provider="all"
        filters={{ ...EMPTY_FILTERS, categories: ['coding'] }}
        onFiltersChange={onFiltersChange}
      />,
    )

    // The chips bar explains the selection and offers per-chip removal + Clear.
    await screen.findByText(/sessions in selection/)
    const chips = screen.getByRole('group', { name: /active investigation filters/i })
    expect(within(chips).getByText('coding')).toBeInTheDocument()
    expect(within(chips).getByRole('button', { name: /remove category filter coding/i })).toBeInTheDocument()
    expect(within(chips).getByRole('button', { name: 'Clear' })).toBeInTheDocument()

    // The summary reports the 0.20 contribution and keeps the session's full
    // 1.00 visible as a separate, clearly-labeled figure.
    const summaryBlock = within(container.querySelector('.sessions-summary') as HTMLElement)
    expect(summaryBlock.getByText('$0.20')).toBeInTheDocument()
    expect(summaryBlock.getByText(/full cost of these sessions \$1\.00/)).toBeInTheDocument()
    // The non-contributing session is not listed under the selection.
    expect(container.querySelectorAll('.session-row')).toHaveLength(1)

    // The row shows its contribution first, its full cost second.
    const row = container.querySelector('.session-row')!
    expect(row).toHaveTextContent('$0.20')
    expect(row).toHaveTextContent('of $1.00')

    // Removing the chip clears the dimension through the callback.
    await user.click(within(chips).getByRole('button', { name: /remove category filter coding/i }))
    expect(onFiltersChange).toHaveBeenCalledWith(EMPTY_FILTERS)
    expect(getSessions).not.toHaveBeenCalled()
  })

  it('paginates the selection over the full population, not just the visible page', async () => {
    const drillRows: SessionRow[] = Array.from({ length: INITIAL_VISIBLE + 3 }, (_, index) => ({
      ...session({
        sessionId: `drill-${index}`,
        project: `project-${index}`,
        provider: 'claude',
        cost: 1,
        calls: 1,
        inputTokens: 1_000,
      }),
      contributions: { segments: [
        { day: '2026-09-10', category: 'coding', branch: null, models: {}, prs: [], cost: 0.5, calls: 1, savingsUSD: 0, inputTokens: 1_000, outputTokens: 0 },
      ] },
    }))
    getSessionsContributions.mockResolvedValue(drillRows)
    const { container } = render(
      <Sessions period="30days" provider="all" filters={{ ...EMPTY_FILTERS, days: ['2026-09-10'] }} onFiltersChange={() => {}} />,
    )

    expect(await screen.findByText(`Showing ${INITIAL_VISIBLE} of ${INITIAL_VISIBLE + 3}`)).toBeInTheDocument()
    // One CLI read serves the whole selection: pagination must not refetch.
    expect(getSessionsContributions).toHaveBeenCalledTimes(1)
    // The selection totals cover the WHOLE filtered population (every row
    // contributes its 0.5), never just the rows on the visible page. The
    // full cost of the listed sessions ($1 each) is a separate figure.
    const summaryBlock = within(container.querySelector('.sessions-summary') as HTMLElement)
    expect(summaryBlock.getByText(`$${((INITIAL_VISIBLE + 3) / 2).toFixed(2)}`)).toBeInTheDocument()
    expect(container.querySelectorAll('.session-row')).toHaveLength(INITIAL_VISIBLE)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show 3 more · 3 remaining' }))
    expect(container.querySelectorAll('.session-row')).toHaveLength(INITIAL_VISIBLE + 3)
    expect(getSessionsContributions).toHaveBeenCalledTimes(1)
  })

  it('renders the honest empty state', async () => {
    getSessions.mockResolvedValue([])
    render(<Sessions period="week" provider="all" />)
    expect(await screen.findByText('No sessions in this range yet.')).toBeInTheDocument()
  })

  it('keeps the provider quick-filter visible in the empty state so a filtered-out user can switch back', async () => {
    const user = userEvent.setup()
    getSessions.mockResolvedValue([])
    const onProviderChange = vi.fn()
    const detected = [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
    ]
    render(<Sessions period="week" provider="gemini" detectedProviders={detected} onProviderChange={onProviderChange} />)
    await screen.findByText('No sessions in this range yet.')

    const filter = screen.getByRole('group', { name: /provider/i })
    await user.click(within(filter).getByRole('button', { name: 'All' }))
    expect(onProviderChange).toHaveBeenCalledWith('all')
  })

  it('lifts provider quick-filter clicks to the app callback with the internal id', async () => {
    const user = userEvent.setup()
    getSessions.mockResolvedValue(rows)
    const onProviderChange = vi.fn()
    const detected = [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
    ]
    render(<Sessions period="30days" provider="all" detectedProviders={detected} onProviderChange={onProviderChange} />)
    await screen.findByText('6 sessions · $21.93 · 4.2M tokens')

    const filter = screen.getByRole('group', { name: /provider/i })
    expect(within(filter).getAllByRole('button')).toHaveLength(3)

    await user.click(within(filter).getByRole('button', { name: 'Codex' }))
    expect(onProviderChange).toHaveBeenCalledWith('codex')

    await user.click(within(filter).getByRole('button', { name: 'All' }))
    expect(onProviderChange).toHaveBeenLastCalledWith('all')
  })

  it('renders quick-filter buttons only for cost>0 providers and presses the active one', async () => {
    getSessions.mockResolvedValue(rows)
    // Mirror App.tsx: detectedProviders are built by dropping cost=0 entries.
    const providerDetails = [
      { id: 'claude', label: 'Claude', cost: 12 },
      { id: 'codex', label: 'Codex', cost: 4 },
      { id: 'gemini', label: 'Gemini', cost: 0 },
    ]
    const detected = providerDetails.filter(p => p.cost > 0).map(({ id, label }) => ({ id, label }))
    render(<Sessions period="30days" provider="codex" detectedProviders={detected} onProviderChange={() => {}} />)
    await screen.findByText('6 sessions · $21.93 · 4.2M tokens')

    const filter = screen.getByRole('group', { name: /provider/i })
    expect(within(filter).getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(within(filter).getByRole('button', { name: 'Codex' })).toBeInTheDocument()
    expect(within(filter).queryByRole('button', { name: 'Gemini' })).not.toBeInTheDocument()
    expect(within(filter).getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(filter).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('headlines a captured title, demotes the id, and falls back to the project when untitled', async () => {
    getSessions.mockResolvedValue([
      session({ sessionId: 'claude-abc123456789xyz', project: 'codeburn', provider: 'claude', title: 'Fix lifetime period in menubar labels', cost: 5 }),
      session({ sessionId: 'claude-untitled-000000', project: 'docs-site', provider: 'claude', title: '', cost: 3 }),
    ])
    const { container } = render(<Sessions period="30days" provider="all" />)
    await screen.findByText('2 sessions · $8.00 · 2K tokens')

    const titles = [...container.querySelectorAll('.session-row .session-title')]
    const ids = [...container.querySelectorAll('.session-row .session-project')]
    // Titled row (higher cost, first): the title is the headline, the id its mono secondary line.
    expect(titles[0]).toHaveTextContent('Fix lifetime period in menubar labels')
    expect(ids[0]).toHaveTextContent('claude-abc')
    // Untitled row: unchanged behavior, the project (via shortenProjectPath) stays the headline.
    expect(titles[1]).toHaveTextContent('docs/site')
    expect(ids[1]).toHaveTextContent('claude-untitled')
  })

  it('matches sessions by their captured title', async () => {
    const user = userEvent.setup()
    getSessions.mockResolvedValue([
      session({ sessionId: 'claude-1', project: 'codeburn', provider: 'claude', title: 'Refactor the parser cache', cost: 5 }),
      session({ sessionId: 'codex-2', project: 'client-api', provider: 'codex', title: 'Add billing webhook', cost: 3 }),
    ])
    const { container } = render(<Sessions period="30days" provider="all" />)
    const search = await screen.findByRole('textbox', { name: 'Search sessions' })

    await user.type(search, 'webhook')
    expect(container.querySelectorAll('.session-row')).toHaveLength(1)
    expect(container.querySelector('.session-row .session-title')).toHaveTextContent('Add billing webhook')
  })
})
