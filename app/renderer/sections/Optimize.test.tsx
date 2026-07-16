// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MenubarPayload, OptimizeJsonReport, YieldJsonReport } from '../lib/types'
import { Optimize, OptimizeContent } from './Optimize'

const { getOverview, getOptimizeReport, getYield } = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getOptimizeReport: vi.fn(),
  getYield: vi.fn(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getOverview, getOptimizeReport, getYield } }
})

function makePayload(): MenubarPayload {
  return {
    generated: '2026-07-10T19:00:00.000Z',
    current: {
      label: 'Last 30 days', cost: 612.48, calls: 1220, sessions: 88, oneShotRate: null,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      cacheHitPercent: 0, codexCredits: 0, topActivities: [], topModels: [],
      localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
      providers: {}, topProjects: [], modelEfficiency: [], topSessions: [],
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: [], skills: [], subagents: [], mcpServers: [],
    },
    optimize: {
      findingCount: 3,
      savingsUSD: 94.4,
      topFindings: [
        { title: 'Opus is doing your small talk', impact: 'high', savingsUSD: 9.1 },
        { title: 'Cache hit is low in agentseal-dash', impact: 'medium', savingsUSD: 8.7 },
        { title: 'Batch tiny requests', impact: 'low', savingsUSD: 2.4 },
      ],
    },
    history: { daily: [] },
  }
}

function makeOptimizeReport(): OptimizeJsonReport {
  return {
    period: { label: 'Last 30 days', start: '2026-06-11', end: '2026-07-10' },
    summary: {
      healthScore: 72, healthGrade: 'C', findingCount: 3, periodCostUSD: 612.48,
      sessions: 88, calls: 1220, potentialSavingsTokens: 184_000,
      potentialSavingsCostUSD: 94.4, potentialSavingsPercent: 15.4, costRateUSD: 0.0005,
    },
    findings: [
      {
        id: 'cost-outliers', title: 'Opus is doing your small talk',
        explanation: 'Small conversational requests are running on an expensive model.',
        severity: 'high', trend: 'active', tokensSaved: 18_200, estimatedSavingsUSD: 9.1,
        fix: { type: 'paste', label: 'Paste into CLAUDE.md', text: 'Use Sonnet for routine questions.', destination: 'claude-md' },
      },
      {
        id: 'context-heavy-sessions', title: 'Cache hit is low in agentseal-dash',
        explanation: 'Repeated context is not being served from cache.', severity: 'medium',
        trend: null, tokensSaved: 17_400, estimatedSavingsUSD: 8.7,
        fix: { type: 'command', label: 'Run this command', text: 'codeburn cache inspect' },
      },
      {
        id: 'warmup-heavy', title: 'Batch tiny requests', explanation: 'Many short sessions repeat setup work.',
        severity: 'low', trend: 'improving', tokensSaved: 4_800, estimatedSavingsUSD: 2.4,
        fix: { type: 'file-content', label: 'Create configuration', path: '~/.codeburn/config.json', content: '{"batch":true}' },
      },
    ],
  }
}

function makeYield(): YieldJsonReport {
  return {
    period: { label: 'Last 30 days', start: '2026-06-11', end: '2026-07-10' },
    summary: {
      productive: { costUSD: 440, sessions: 19, costPercent: 72, sessionPercent: 70 },
      reverted: { costUSD: 107, sessions: 4, costPercent: 17, sessionPercent: 15 },
      abandoned: { costUSD: 65.4, sessions: 3, costPercent: 11, sessionPercent: 15 },
      total: { costUSD: 612.4, sessions: 26 }, productiveToRevertedCostRatio: 4.1,
    },
    details: [
      { sessionId: 'rev-1', project: 'codeburn', category: 'reverted', commitCount: 2, costUSD: 55 },
      { sessionId: 'rev-2', project: 'agentseal-dash', category: 'reverted', commitCount: 1, costUSD: 52 },
      { sessionId: 'abn-1', project: 'sandbox-spike', category: 'abandoned', commitCount: 0, costUSD: 65.4 },
      { sessionId: 'prod-1', project: 'desktop-app', category: 'productive', commitCount: 5, costUSD: 440 },
    ],
  }
}

function emptyPayload(): MenubarPayload {
  const payload = makePayload()
  payload.optimize = { findingCount: 0, savingsUSD: 0, topFindings: [] }
  return payload
}

function emptyOptimizeReport(): OptimizeJsonReport {
  const report = makeOptimizeReport()
  report.summary = { ...report.summary, findingCount: 0, potentialSavingsTokens: 0, potentialSavingsCostUSD: 0, potentialSavingsPercent: 0 }
  report.findings = []
  return report
}

function emptyYield(): YieldJsonReport {
  const report = makeYield()
  report.summary.reverted = { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 }
  report.summary.abandoned = { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 }
  report.details = []
  return report
}

describe('Optimize', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>()

  beforeEach(() => {
    getOverview.mockReset().mockResolvedValue(makePayload())
    getOptimizeReport.mockReset().mockResolvedValue(makeOptimizeReport())
    getYield.mockReset().mockResolvedValue(makeYield())
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  })

  it('renders tabs and actionable Waste findings with impact, savings, explanation, and copy-paste fix', async () => {
    render(<Optimize period="30days" provider="all" />)

    expect(await screen.findByText('Opus is doing your small talk')).toBeInTheDocument()
    expect(screen.getByText('3 findings · $94.40 potential · health 72/100')).toBeInTheDocument()
    expect(screen.getByText('High')).toHaveClass('opt-impact-high')
    expect(screen.getByText('Medium')).toHaveClass('opt-impact-medium')
    expect(screen.getByText('Low')).toHaveClass('opt-impact-low')
    expect(screen.getByText('$9.10')).toHaveClass('opt-finding-savings')
    expect(screen.getByText('18.2K tokens')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Waste $94.40' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Reverts $107.00' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Abandoned $65.40' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Fixes 3' })).toBeInTheDocument()

    const row = screen.getByRole('button', { name: /Opus is doing your small talk/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Small conversational requests are running on an expensive model.')).toBeInTheDocument()
    expect(screen.getByText('Use Sonnet for routine questions.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Use Sonnet for routine questions.'))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('keeps only one finding expanded and renders file-content path and content', async () => {
    render(<Optimize period="30days" provider="all" />)
    const first = await screen.findByRole('button', { name: /Opus is doing your small talk/ })
    fireEvent.click(first)
    fireEvent.click(screen.getByRole('button', { name: /Batch tiny requests/ }))

    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Small conversational requests are running on an expensive model.')).not.toBeInTheDocument()
    expect(screen.getByText('~/.codeburn/config.json')).toBeInTheDocument()
    expect(screen.getByText('{"batch":true}')).toBeInTheDocument()
  })

  it('switches to Reverts and Abandoned and shows only the matching yield details', async () => {
    render(<Optimize period="30days" provider="all" />)
    await screen.findByText('Opus is doing your small talk')

    fireEvent.click(screen.getByRole('tab', { name: 'Reverts $107.00' }))
    expect(screen.getByText('codeburn')).toBeInTheDocument()
    expect(screen.getByText('2 commits · rev-1')).toBeInTheDocument()
    expect(screen.queryByText('sandbox-spike')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Abandoned $65.40' }))
    expect(screen.getByText('sandbox-spike')).toBeInTheDocument()
    expect(screen.getByText('0 commits · abn-1')).toBeInTheDocument()
    expect(screen.getByText('$65.40')).toHaveClass('val')
    expect(screen.queryByText('codeburn')).not.toBeInTheDocument()
    expect(screen.queryByText('desktop-app')).not.toBeInTheDocument()
  })

  it('renders honest placeholders for unavailable yield totals and tab bodies', async () => {
    getYield.mockReset().mockRejectedValue(new Error('yield failed'))
    render(<Optimize period="30days" provider="all" />)

    expect(await screen.findByRole('tab', { name: 'Reverts —' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Abandoned —' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Reverts —' }))
    expect(screen.getByText('Yield data is unavailable right now.')).toBeInTheDocument()
  })

  it('keeps the Fixes tab populated and preserves all four empty tab states', async () => {
    const { rerender } = render(<Optimize period="30days" provider="all" />)
    await screen.findByText('Opus is doing your small talk')
    fireEvent.click(screen.getByRole('tab', { name: 'Fixes 3' }))
    expect(screen.getByText('Opus is doing your small talk')).toBeInTheDocument()

    getOverview.mockResolvedValue(emptyPayload())
    getOptimizeReport.mockResolvedValue(emptyOptimizeReport())
    getYield.mockResolvedValue(emptyYield())
    rerender(<Optimize period="week" provider="all" />)

    expect(await screen.findByText('No fixes in this range yet.')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Fixes 0' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Waste $0.00' }))
    expect(screen.getByText('No waste findings in this range yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Reverts $0.00' }))
    expect(screen.getByText('No reverted sessions in this range yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Abandoned $0.00' }))
    expect(screen.getByText('No abandoned sessions in this range yet.')).toBeInTheDocument()
  })

  it('labels the Fixes tab with the rendered list length, not the menubar-wide findingCount', async () => {
    const payload = makePayload()
    // The menubar counts 25 findings, but the Fixes tab only renders topFindings.
    payload.optimize = {
      findingCount: 25,
      savingsUSD: 94.4,
      topFindings: [
        { title: 'A', impact: 'high', savingsUSD: 1 },
        { title: 'B', impact: 'low', savingsUSD: 1 },
      ],
    }
    getOverview.mockResolvedValue(payload)

    render(<Optimize period="30days" provider="all" />)

    expect(await screen.findByRole('tab', { name: 'Fixes 2' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Fixes 25' })).not.toBeInTheDocument()
  })

  it('passes provider and custom range to the optimize report and yield bridges', async () => {
    render(<Optimize period="30days" provider="claude" range={{ from: '2026-07-01', to: '2026-07-11' }} />)
    await screen.findByText('Opus is doing your small talk')
    expect(getOptimizeReport).toHaveBeenCalledWith('30days', 'claude', { from: '2026-07-01', to: '2026-07-11' })
    expect(getYield).toHaveBeenCalledWith('30days', 'claude', { from: '2026-07-01', to: '2026-07-11' })
  })

  it('keeps last-good yield totals and rows visible during revalidation', async () => {
    getYield.mockReset().mockResolvedValueOnce(makeYield()).mockImplementation(() => new Promise<YieldJsonReport>(() => {}))
    const overview = { data: makePayload(), error: null, loading: false, lastSuccessAt: Date.now(), refresh: vi.fn() }
    const { rerender } = render(<OptimizeContent period="30days" overview={overview} refreshToken={0} />)

    expect(await screen.findByRole('tab', { name: 'Reverts $107.00' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Reverts $107.00' }))
    expect(screen.getByText('codeburn')).toBeInTheDocument()
    rerender(<OptimizeContent period="30days" overview={overview} refreshToken={1} />)
    await waitFor(() => expect(getYield).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('tab', { name: 'Reverts $107.00' })).toBeInTheDocument()
    expect(screen.getByText('codeburn')).toBeInTheDocument()
  })
})
