// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BranchBreakdown } from './BranchBreakdown'
import type { BranchSpendReport } from '../lib/types'

const { getBranchSpend } = vi.hoisted(() => ({
  getBranchSpend: vi.fn<(period: string, provider: string) => Promise<BranchSpendReport>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getBranchSpend } }
})

function report(overrides: Partial<BranchSpendReport> = {}): BranchSpendReport {
  return {
    period: { label: '2026-07-01 to 2026-07-02', start: '2026-07-01T00:00:00.000Z', end: '2026-07-02T00:00:00.000Z' },
    projects: [
      {
        id: '/code/alpha',
        label: 'alpha',
        totalCost: 8,
        branches: [
          {
            projectId: '/code/alpha', projectLabel: 'alpha', branch: 'feat/auth',
            cost: 3, calls: 4, sessions: 1,
            tokens: { inputTokens: 1200, outputTokens: 300, reasoningTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 50 },
            firstActive: '2026-07-01T08:00:00Z', lastActive: '2026-07-01T09:30:00Z',
            worktrees: [{ path: '/code/alpha', sessions: 1, cost: 3 }],
            sessionRows: [{
              sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Implement auth', provider: 'claude',
              workingDirectory: '/code/alpha', cost: 3, calls: 4,
              tokens: { inputTokens: 1200, outputTokens: 300, reasoningTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 50 },
              models: ['claude-sonnet'], firstActive: '2026-07-01T08:00:00Z', lastActive: '2026-07-01T09:30:00Z',
            }],
          },
          {
            projectId: '/code/alpha', projectLabel: 'alpha', branch: 'fix/parser',
            cost: 5, calls: 2, sessions: 1,
            tokens: { inputTokens: 400, outputTokens: 80, reasoningTokens: 0, cacheReadTokens: 2000, cacheWriteTokens: 0 },
            firstActive: '2026-07-01T10:00:00Z', lastActive: '2026-07-01T10:15:00Z',
            worktrees: [{ path: '/code/alpha-wt/task-42', sessions: 1, cost: 5 }],
            sessionRows: [{
              sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', provider: 'claude',
              workingDirectory: '/code/alpha-wt/task-42', cost: 5, calls: 2,
              tokens: { inputTokens: 400, outputTokens: 80, reasoningTokens: 0, cacheReadTokens: 2000, cacheWriteTokens: 0 },
              models: ['claude-sonnet'], firstActive: '2026-07-01T10:00:00Z', lastActive: '2026-07-01T10:15:00Z',
            }],
          },
          {
            projectId: '/code/alpha', projectLabel: 'alpha', branch: null,
            cost: 2, calls: 1, sessions: 1,
            tokens: { inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            firstActive: '2026-07-01T07:00:00Z', lastActive: '2026-07-01T07:05:00Z',
            worktrees: [],
            sessionRows: [],
          },
        ],
        coverage: {
          branchKnownCost: 8, branchUnknownCost: 2, noBranchDataCost: 4,
          noBranchDataSessions: 1, noBranchDataProviders: ['codex'], distinctSessions: 2,
        },
      },
      {
        id: '/code/beta',
        label: 'beta',
        totalCost: 6,
        branches: [{
          projectId: '/code/beta', projectLabel: 'beta', branch: 'main',
          cost: 6, calls: 3, sessions: 1,
          tokens: { inputTokens: 500, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 0 },
          firstActive: '2026-07-01T11:00:00Z', lastActive: '2026-07-01T11:20:00Z',
          worktrees: [], sessionRows: [{
            sessionId: 'ffffffff-1111-2222-3333-444444444444', provider: 'claude',
            cost: 6, calls: 3,
            tokens: { inputTokens: 500, outputTokens: 50, reasoningTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 0 },
            models: ['claude-sonnet'], firstActive: '2026-07-01T11:00:00Z', lastActive: '2026-07-01T11:20:00Z',
          }],
        }],
        coverage: {
          branchKnownCost: 6, branchUnknownCost: 0, noBranchDataCost: 0,
          noBranchDataSessions: 0, noBranchDataProviders: [], distinctSessions: 1,
        },
      },
    ],
    totals: {
      branchKnownCost: 14, branchUnknownCost: 2, noBranchDataCost: 4,
      noBranchDataSessions: 1, noBranchDataProviders: ['codex'], distinctSessions: 3,
    },
    ...overrides,
  }
}

describe('BranchBreakdown', () => {
  beforeEach(() => {
    getBranchSpend.mockReset()
    getBranchSpend.mockResolvedValue(report())
  })

  it('defaults to the top project and shows its branch rows with cost, sessions and calls', async () => {
    render(<BranchBreakdown period="30days" provider="all" />)
    await waitFor(() => expect(getBranchSpend).toHaveBeenCalledWith('30days', 'all'))
    // alpha is the top project: its rows show, beta's do not.
    expect(await screen.findByText('feat/auth')).toBeInTheDocument()
    expect(screen.getByText('fix/parser')).toBeInTheDocument()
    expect(screen.getByText('$3.00')).toBeInTheDocument()
    expect(screen.getByText('$5.00')).toBeInTheDocument()
    expect(screen.queryByText('beta / main')).not.toBeInTheDocument()
    // The Unknown bucket keeps its honest name (never relabeled as a branch).
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })

  it('expands a branch into tokens, worktree evidence and per-session contributions', async () => {
    const user = userEvent.setup()
    render(<BranchBreakdown period="30days" provider="all" />)
    await user.click(await screen.findByText('fix/parser'))
    expect(screen.getByText(/cacheR 2K/)).toBeInTheDocument()
    // Recorded worktree path: basename in the row, full path as tooltip.
    const wt = screen.getByText(/task-42 · 1 session · \$5.00/)
    expect(wt).toHaveAttribute('title', '/code/alpha-wt/task-42')
    // Session contribution shows the branch-sliced cost (5, not the session total 8).
    expect(screen.getByText('2 calls')).toBeInTheDocument()
    expect(screen.getByText('$5.00', { selector: '.sps-cost' })).toBeInTheDocument()
  })

  it('inspects a session with real detail: id, provider, working directory, models', async () => {
    const user = userEvent.setup()
    render(<BranchBreakdown period="30days" provider="all" />)
    await user.click(await screen.findByText('feat/auth'))
    await user.click(screen.getByText('Implement auth'))
    const region = await screen.findByRole('region', { name: /Session aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee detail/ })
    expect(region).toHaveTextContent('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(region).toHaveTextContent('claude')
    expect(region).toHaveTextContent('alpha')
    expect(region).toHaveTextContent('claude-sonnet')
  })

  it('keeps same-named branches of different projects separate in the All projects view', async () => {
    const user = userEvent.setup()
    render(<BranchBreakdown period="30days" provider="all" />)
    await user.click(await screen.findByRole('button', { name: /Project for the By branch lens/i }))
    await user.click(screen.getByRole('option', { name: 'All projects' }))
    expect(await screen.findByText('alpha / feat/auth')).toBeInTheDocument()
    expect(screen.getByText('beta / main')).toBeInTheDocument()
    // Two projects, each with its own spend line, no merged "main" row.
    expect(screen.queryByText(/^main$/)).not.toBeInTheDocument()
  })

  it('shows the coverage note with known, unknown, no-branch-data and distinct sessions', async () => {
    render(<BranchBreakdown period="30days" provider="all" />)
    const note = await screen.findByRole('note', { name: 'Branch metadata coverage' })
    expect(note).toHaveTextContent('On branches $8.00')
    expect(note).toHaveTextContent('Unknown, before first branch $2.00')
    expect(note).toHaveTextContent('No branch data $4.00 (1 session: codex)')
    expect(note).toHaveTextContent('2 distinct sessions')
  })

  it('renders the CLI error inside the panel when the report fails', async () => {
    // A provider no other test in this file fetched: earlier successes persist
    // as durable localStorage snapshots under their memo keys, and usePolled
    // keeps last-good data painted on an error for the SAME key.
    getBranchSpend.mockRejectedValue({ kind: 'nonzero', message: 'boom' })
    render(<BranchBreakdown period="30days" provider="grok" />)
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument())
  })
})
