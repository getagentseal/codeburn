import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/providers/index.js', async (importOriginal) => {
  type ProvidersModule = typeof import('../src/providers/index.js')
  const actual = await importOriginal<ProvidersModule>()
  return {
    ...actual,
    async discoverAllSessions() {
      return []
    },
  }
})

import {
  detectLowWorthSessions,
  findLowWorthCandidates,
} from '../src/optimize.js'
import type { ProjectSummary } from '../src/types.js'

type TestSession = ProjectSummary['sessions'][number]
type LowWorthTurn = TestSession['turns'][number]

function lowWorthTurn(overrides: Partial<LowWorthTurn> = {}): LowWorthTurn {
  return {
    userMessage: 'do the work',
    assistantCalls: [],
    timestamp: '2026-05-01T10:00:00Z',
    sessionId: 's1',
    category: 'coding',
    retries: 0,
    hasEdits: false,
    ...overrides,
  }
}

function lowWorthSession(cost: number, i: number, overrides: Partial<TestSession> = {}, project = 'app'): TestSession {
  const tokens = Math.round(cost * 1000)
  return {
    sessionId: `s${i + 1}`,
    project,
    firstTimestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    lastTimestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:30:00Z`,
    totalCostUSD: cost,
    totalInputTokens: tokens,
    totalOutputTokens: tokens,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as TestSession['categoryBreakdown'],
    skillBreakdown: {},
    ...overrides,
  }
}

function projectWithLowWorthSessions(sessions: TestSession[], project = 'app'): ProjectSummary {
  return {
    project,
    projectPath: `/tmp/${project}`,
    sessions,
    totalCostUSD: sessions.reduce((sum, s) => sum + s.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((sum, s) => sum + s.apiCalls, 0),
  }
}

// Regression test for issue #640: a zero-edit (exploration/reading) session
// flagged as low-worth must not claim its ENTIRE token spend as recoverable
// savings. The full session total is an upper bound, not a point estimate —
// presenting it as "Potential savings" tells the user 100% of an exploration
// session's cost was waste. The retry branch already applies a bounded
// recovery fraction; the no-edit branch should be bounded below 100% too.
describe('zero-edit low-worth savings estimate (issue #640)', () => {
  it('claims less than the full session token total for a no-edit session', () => {
    // Expensive exploration session: 4 read-only turns, no edits, no retries.
    // sessionTokenTotal = input + output + cacheRead + cacheWrite = 10K.
    const session = lowWorthSession(5, 0, {
      turns: [
        lowWorthTurn({ hasEdits: false }),
        lowWorthTurn({ hasEdits: false }),
        lowWorthTurn({ hasEdits: false }),
        lowWorthTurn({ hasEdits: false }),
      ],
    })
    const fullSessionTokens = session.totalInputTokens
      + session.totalOutputTokens
      + session.totalCacheReadTokens
      + session.totalCacheWriteTokens

    const candidates = findLowWorthCandidates([projectWithLowWorthSessions([session])])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].reasons).toContain('no edit turns')
    // The recoverable estimate must be a bounded fraction of the session,
    // not the whole thing.
    expect(candidates[0].tokens).toBeLessThan(fullSessionTokens)
  })

  it('does not headline 100% of a zero-edit session as tokensSaved', () => {
    const session = lowWorthSession(5, 0, {
      turns: [lowWorthTurn({ hasEdits: false })],
    })
    const fullSessionTokens = session.totalInputTokens
      + session.totalOutputTokens
      + session.totalCacheReadTokens
      + session.totalCacheWriteTokens

    const finding = detectLowWorthSessions([projectWithLowWorthSessions([session])])
    expect(finding).not.toBeNull()
    // tokensSaved feeds the "Potential savings: ~X tokens (~$Y, ~Z% of spend)"
    // headline and the JSON potentialSavingsCostUSD / estimatedSavingsUSD
    // fields; it must stay strictly below the session's full token total.
    expect(finding!.tokensSaved).toBeLessThan(fullSessionTokens)
  })
})
