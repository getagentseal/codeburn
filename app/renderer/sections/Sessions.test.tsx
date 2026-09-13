// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionRow, WorkUnitJson, WorkUnitReport } from '../lib/types'
import { INITIAL_VISIBLE, Sessions } from './Sessions'

const { getSessions, getWorkUnits } = vi.hoisted(() => ({
  getSessions: vi.fn<(period: string, provider: string) => Promise<SessionRow[]>>(),
  getWorkUnits: vi.fn<(period: string, provider: string) => Promise<WorkUnitReport>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getSessions, getWorkUnits } }
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
  beforeEach(() => {
    getSessions.mockReset()
    getWorkUnits.mockReset()
  })

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

// ————— Work-unit (orchestration) view —————

function unit(rootSessionId: string, children: string[]): WorkUnitJson {
  const role: WorkUnitJson['members'][number]['role'] = children.length > 0 ? 'root' : 'unknown'
  return {
    workUnitId: `trace-${rootSessionId}`,
    rootSessionId,
    rootProvider: 'claude',
    childSessionIds: [...children].sort(),
    roles: {
      [rootSessionId]: role,
      ...Object.fromEntries(children.map(childId => [childId, 'child'])),
    } as WorkUnitJson['roles'],
    members: [
      { sessionId: rootSessionId, provider: 'claude', role },
      ...[...children].sort().map(childId => ({ sessionId: childId, provider: 'claude', role: 'child' as const })),
    ],
  }
}

// Acceptance fixture: root 2 + children 3 and 5 + independent 7 → 17 / 10 / 8.
const groupFixture = (): WorkUnitReport => ({
  sessions: [
    session({ sessionId: 'root', project: 'orchestration', provider: 'claude', title: 'Ship the release', cost: 2, models: ['Opus 4.8'] }),
    session({ sessionId: 'child-a', project: 'orchestration', provider: 'claude', title: 'Explore indexing', cost: 3, agentType: 'Explore', startedAt: '2026-07-01T10:05:00.000Z' }),
    session({ sessionId: 'child-b', project: 'orchestration', provider: 'claude', title: 'Write the tests', cost: 5, agentType: 'general-purpose', startedAt: '2026-07-01T10:20:00.000Z' }),
    session({ sessionId: 'independent', project: 'solo-project', provider: 'claude', title: 'Solo work', cost: 7 }),
  ],
  workUnits: [unit('root', ['child-a', 'child-b']), unit('independent', [])],
})

describe('Sessions work-unit view', () => {
  beforeEach(() => {
    getSessions.mockReset()
    getWorkUnits.mockReset()
    // The plain list keeps its own fetch enabled; give it the same population
    // the work-unit payload will carry, like the app has when a user switches
    // views on real data.
    getSessions.mockResolvedValue(groupFixture().sessions)
  })

  it('groups sessions, separates root from agents, and distinguishes sessions from groups', async () => {
    const user = userEvent.setup()
    getWorkUnits.mockResolvedValue(groupFixture())
    const { container } = render(<Sessions period="30days" provider="all" />)

    await user.click(await screen.findByRole('button', { name: 'Group by work units' }))
    expect(await screen.findByText('4 sessions · 1 group · $17.00 · 4K tokens')).toBeInTheDocument()
    expect(getWorkUnits).toHaveBeenCalledTimes(1)

    const groupRow = screen.getByRole('button', { name: /Ship the release/ })
    expect(groupRow).toHaveTextContent('orchestration · 2 agents · root $2.00 + agents $8.00')
    expect(groupRow).toHaveTextContent('$10.00')
    expect(screen.getByRole('button', { name: /Solo work/ })).toHaveTextContent('$7.00')
    // The aggregate row does not re-sum the member detail: one group row only.
    expect(container.querySelectorAll('.work-unit-row')).toHaveLength(1)
  })

  it('expands members with their recorded agent type, collapses, and totals never move', async () => {
    const user = userEvent.setup()
    getWorkUnits.mockResolvedValue(groupFixture())
    const { container } = render(<Sessions period="30days" provider="all" />)
    await user.click(await screen.findByRole('button', { name: 'Group by work units' }))
    const summary = await screen.findByText('4 sessions · 1 group · $17.00 · 4K tokens')

    const groupRow = screen.getByRole('button', { name: /Ship the release/ })
    await user.click(groupRow)
    expect(groupRow).toHaveAttribute('aria-expanded', 'true')
    const members = screen.getByRole('region', { name: 'Ship the release group members' })
    expect(within(members).getByText('Explore')).toBeInTheDocument()
    expect(within(members).getByText('general-purpose')).toBeInTheDocument()
    // Root carries no agent type: the resolver role labels it, nothing invented.
    expect(within(members).getByText('root session')).toBeInTheDocument()
    expect(within(members).getByRole('button', { name: /Write the tests/ })).toHaveTextContent('$5.00')

    await user.click(within(members).getByRole('button', { name: /Explore indexing/ }))
    expect(within(members).getByRole('region', { name: 'orchestration session details' })).toBeInTheDocument()
    expect(summary).toBeInTheDocument()
    expect(container.querySelectorAll('.work-unit-row')).toHaveLength(1)

    await user.click(groupRow)
    expect(groupRow).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Ship the release group members' })).not.toBeInTheDocument()
    // Expand/collapse never moves the top-level totals.
    expect(screen.getByText('4 sessions · 1 group · $17.00 · 4K tokens')).toBeInTheDocument()
  })

  it('searching for a member surfaces the whole group and flags only the match', async () => {
    const user = userEvent.setup()
    getWorkUnits.mockResolvedValue(groupFixture())
    const { container } = render(<Sessions period="30days" provider="all" />)
    await user.click(await screen.findByRole('button', { name: 'Group by work units' }))
    await screen.findByText('4 sessions · 1 group · $17.00 · 4K tokens')

    const search = screen.getByRole('textbox', { name: 'Search sessions' })
    await user.type(search, 'indexing')

    const groupRow = screen.getByRole('button', { name: /Ship the release/ })
    expect(groupRow).toBeInTheDocument()
    await user.click(groupRow)
    const members = screen.getByRole('region', { name: 'Ship the release group members' })
    // The whole group is visible and only the matching member is flagged.
    const matchedRow = within(members).getByRole('button', { name: /Explore indexing/ })
    expect(matchedRow).toHaveTextContent('search match')
    const rootMemberRow = within(members).getByRole('button', { name: /Ship the release/ })
    expect(rootMemberRow).toHaveTextContent('root session')
    expect(rootMemberRow).not.toHaveTextContent('search match')
    expect(container.querySelectorAll('.member-row')).toHaveLength(3)
  })

  it('searching by a member\'s agent type finds the group (the label the row shows)', async () => {
    const user = userEvent.setup()
    getWorkUnits.mockResolvedValue(groupFixture())
    render(<Sessions period="30days" provider="all" />)
    await user.click(await screen.findByRole('button', { name: 'Group by work units' }))
    await screen.findByText('4 sessions · 1 group · $17.00 · 4K tokens')

    const search = screen.getByRole('textbox', { name: 'Search sessions' })
    await user.type(search, 'explore')

    // The group containing the Explore agent stays visible; the solo does not.
    expect(screen.getByRole('button', { name: /Ship the release/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Solo work/ })).not.toBeInTheDocument()
    // The WHOLE group counts (3 member sessions), not just the matched member.
    expect(screen.getByText('3 sessions · 1 group · $10.00 · 3K tokens')).toBeInTheDocument()
  })

  it('sorts by whole-unit cost, so a $10 group outranks a $9 standalone', async () => {
    const user = userEvent.setup()
    getWorkUnits.mockResolvedValue({
      sessions: [
        session({ sessionId: 'big-root', project: 'orchestration', provider: 'claude', title: 'Orchestrator', cost: 2 }),
        session({ sessionId: 'big-child', project: 'orchestration', provider: 'claude', title: 'Worker', cost: 8, startedAt: '2026-07-01T10:05:00.000Z' }),
        session({ sessionId: 'mid-solo', project: 'solo-project', provider: 'claude', title: 'Mid solo', cost: 9 }),
      ],
      workUnits: [unit('big-root', ['big-child']), unit('mid-solo', [])],
    })
    const { container } = render(<Sessions period="30days" provider="all" />)
    await user.click(await screen.findByRole('button', { name: 'Group by work units' }))
    await screen.findByText('3 sessions · 1 group · $19.00 · 3K tokens')

    const titles = [...container.querySelectorAll('.session-row .session-title')].map(node => node.textContent)
    expect(titles).toEqual(['Orchestrator', 'Mid solo'])
  })

  it('a population switch closes an open group so no detail outlives its population', async () => {
    const user = userEvent.setup()
    getWorkUnits.mockResolvedValue(groupFixture())
    const { rerender } = render(<Sessions period="30days" provider="all" />)
    await user.click(await screen.findByRole('button', { name: 'Group by work units' }))

    const groupRow = await screen.findByRole('button', { name: /Ship the release/ })
    await user.click(groupRow)
    expect(screen.getByRole('region', { name: 'Ship the release group members' })).toBeInTheDocument()

    getWorkUnits.mockResolvedValue({ sessions: [], workUnits: [] })
    rerender(<Sessions period="week" provider="all" />)
    await screen.findByText('0 sessions')
    expect(screen.queryByRole('region', { name: 'Ship the release group members' })).not.toBeInTheDocument()
  })

  it('says so when the range has sessions but no recorded lineage', async () => {
    const user = userEvent.setup()
    getWorkUnits.mockResolvedValue({
      sessions: [session({ sessionId: 'plain', project: 'solo-project', provider: 'codex', title: 'Plain work', cost: 4 })],
      workUnits: [unit('plain', [])],
    })
    const { container } = render(<Sessions period="30days" provider="all" />)
    await user.click(await screen.findByRole('button', { name: 'Group by work units' }))

    expect(await screen.findByText('1 session · 0 groups · $4.00 · 1K tokens')).toBeInTheDocument()
    expect(screen.getByText(/No agent groups in this range/)).toBeInTheDocument()
    expect(container.querySelectorAll('.session-row')).toHaveLength(1)
  })
})
