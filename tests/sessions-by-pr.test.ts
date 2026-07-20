import { describe, expect, it } from 'vitest'

import { aggregateByPr, prLinkedTotals, shortenPrUrl } from '../src/sessions-report.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'

function session(id: string, cost: number, calls: number, prLinks?: string[], first = '2026-07-01T10:00:00Z', last = '2026-07-01T11:00:00Z'): SessionSummary {
  return {
    sessionId: id, project: 'p',
    firstTimestamp: first, lastTimestamp: last,
    totalCostUSD: cost, totalSavingsUSD: 0, totalEstimatedCostUSD: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
    totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    apiCalls: calls, turns: [],
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {} as SessionSummary['skillBreakdown'],
    subagentBreakdown: {} as SessionSummary['subagentBreakdown'],
    ...(prLinks ? { prLinks } : {}),
  }
}

function project(sessions: SessionSummary[]): ProjectSummary {
  return { project: 'p', projectPath: '/p', sessions, totalCostUSD: 0, totalSavingsUSD: 0, totalApiCalls: 0, totalProxiedCostUSD: 0 }
}

describe('shortenPrUrl', () => {
  it('shortens GitHub PR URLs and passes anything else through', () => {
    expect(shortenPrUrl('https://github.com/getagentseal/codeburn/pull/755')).toBe('getagentseal/codeburn#755')
    expect(shortenPrUrl('https://gitlab.com/x/y/-/merge_requests/3')).toBe('https://gitlab.com/x/y/-/merge_requests/3')
  })
})

describe('aggregateByPr', () => {
  it('groups sessions by PR, sorted by cost, tracking the date span', () => {
    const rows = aggregateByPr([project([
      session('a', 100, 40, ['https://github.com/o/r/pull/1'], '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z'),
      session('b', 50, 10, ['https://github.com/o/r/pull/1'], '2026-06-20T09:00:00Z', '2026-06-20T10:00:00Z'),
      session('c', 200, 80, ['https://github.com/o/r/pull/2']),
    ])])
    expect(rows.map(r => r.label)).toEqual(['o/r#2', 'o/r#1'])
    const pr1 = rows[1]!
    expect(pr1.cost).toBe(150)
    expect(pr1.sessions).toBe(2)
    expect(pr1.calls).toBe(50)
    expect(pr1.firstStarted).toBe('2026-06-20T09:00:00Z')
    expect(pr1.lastEnded).toBe('2026-07-01T11:00:00Z')
  })

  it('a session referencing several PRs counts fully toward each row', () => {
    const rows = aggregateByPr([project([
      session('a', 100, 40, ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']),
    ])])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.cost).toBe(100)
    expect(rows[1]!.cost).toBe(100)
  })

  it('sessions without links contribute nothing', () => {
    expect(aggregateByPr([project([session('a', 100, 40)])])).toEqual([])
  })
})

describe('prLinkedTotals', () => {
  it('counts each PR-linked session once regardless of how many PRs it references', () => {
    const totals = prLinkedTotals([project([
      session('a', 100, 40, ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']),
      session('b', 50, 10, ['https://github.com/o/r/pull/1']),
      session('c', 999, 1),
    ])])
    expect(totals).toEqual({ cost: 150, sessions: 2 })
  })
})
