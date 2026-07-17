// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionRow } from '../lib/types'
import { INITIAL_VISIBLE, Sessions } from './Sessions'

const { getSessions } = vi.hoisted(() => ({
  getSessions: vi.fn<(period: string, provider: string) => Promise<SessionRow[]>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getSessions } }
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
    project: '-Users-torukmakto-Projects-codeburn',
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
  beforeEach(() => getSessions.mockReset())

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
    expect(screen.queryByText('-Users-torukmakto-Projects-codeburn')).not.toBeInTheDocument()
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

  it('caps a large list and reveals the remaining rows without another fetch', async () => {
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

  it('expands the live eight-stat detail inline and collapses the row in place', async () => {
    const user = userEvent.setup()
    getSessions.mockResolvedValue(rows)
    const { container } = render(<Sessions period="30days" provider="all" />)
    await screen.findByText('6 sessions · $21.93 · 4.2M tokens')

    const row = screen.getByRole('button', { name: /projects\/codeburn/ })
    await user.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    const detail = screen.getByRole('region', { name: 'projects/codeburn session details' })
    expect(detail).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '← Back to sessions' })).not.toBeInTheDocument()
    expect(screen.getByText('claude · Opus 4.8')).toBeInTheDocument()
    expect(screen.getByText(/Jul 11, 2026 → Jul 11, 2026 · 1h 35m/)).toBeInTheDocument()
    expect(container.querySelectorAll('.stat')).toHaveLength(8)
    expect(container.querySelectorAll('.session-row')).toHaveLength(6)
    for (const label of ['Cost', 'Calls', 'Turns', 'Saved', 'Input', 'Output', 'Cache read', 'Cache write']) {
      expect(within(detail).getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('44')).toBeInTheDocument()
    expect(screen.getByText('44% hit')).toBeInTheDocument()
    expect(screen.queryByText('Context window')).not.toBeInTheDocument()

    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'projects/codeburn session details' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('.session-row')).toHaveLength(6)
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
})
