import { describe, expect, it } from 'vitest'

import { aggregateByBranch } from '../src/sessions-report.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary, TokenUsage } from '../src/types.js'

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
}

let keySeq = 0
function call(cost: number): ParsedApiCall {
  return {
    provider: 'claude', model: 'claude', usage: ZERO_USAGE, costUSD: cost,
    tools: [], mcpTools: [], skills: [], subagentTypes: [],
    hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
    timestamp: '2026-07-01T10:00:00Z', bashCommands: [], deduplicationKey: `k${keySeq++}`,
  }
}

// A turn whose total cost `cost` is split across `calls` API calls. `gitBranch`
// is set only when supplied — the cache stores it only on the turn where the
// branch CHANGES, so omitting it here is exactly what the carry-forward under
// test must reconstruct.
function turn(cost: number, calls = 1, gitBranch?: string): ClassifiedTurn {
  return {
    userMessage: '',
    assistantCalls: Array.from({ length: calls }, () => call(cost / calls)),
    timestamp: '2026-07-01T10:00:00Z', sessionId: 's',
    category: 'coding', retries: 0, hasEdits: false,
    ...(gitBranch ? { gitBranch } : {}),
  }
}

function session(id: string, turns: ClassifiedTurn[], everHadBranch?: boolean): SessionSummary {
  return {
    sessionId: id, project: 'p',
    firstTimestamp: '2026-07-01T10:00:00Z', lastTimestamp: '2026-07-01T11:00:00Z',
    totalCostUSD: 0, totalSavingsUSD: 0, totalEstimatedCostUSD: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
    totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    apiCalls: 0, turns,
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {} as SessionSummary['skillBreakdown'],
    subagentBreakdown: {} as SessionSummary['subagentBreakdown'],
    ...(everHadBranch ? { everHadBranch } : {}),
  }
}

function project(sessions: SessionSummary[]): ProjectSummary {
  return { project: 'p', projectPath: '/p', sessions, totalCostUSD: 0, totalSavingsUSD: 0, totalApiCalls: 0, totalProxiedCostUSD: 0 }
}

describe('aggregateByBranch', () => {
  it('carries the last-seen branch forward across turns that omit it', () => {
    // The cache stored `main` on turn 1 (its first appearance) and nothing on
    // turn 2 (unchanged); turn 3 changed to `feature`. The report must attribute
    // turn 2 to `main` by carry-forward.
    const rows = aggregateByBranch([project([
      session('s', [
        turn(100, 2, 'main'),
        turn(50, 1),
        turn(30, 1, 'feature'),
      ]),
    ])])
    expect(rows.map(r => r.branch)).toEqual(['main', 'feature'])
    const main = rows[0]!
    expect(main.cost).toBeCloseTo(150, 6)
    expect(main.calls).toBe(3)
    expect(main.sessions).toBe(1)
    const feature = rows[1]!
    expect(feature.cost).toBeCloseTo(30, 6)
    expect(feature.calls).toBe(1)
  })

  it('attributes spend before the first observed branch to an explicit null row', () => {
    const rows = aggregateByBranch([project([
      session('s', [
        turn(20, 1),           // unbranched prefix
        turn(80, 1, 'main'),
      ]),
    ])])
    expect(rows.map(r => r.branch)).toEqual(['main', null])
    expect(rows.find(r => r.branch === null)!.cost).toBeCloseTo(20, 6)
    expect(rows.find(r => r.branch === 'main')!.cost).toBeCloseTo(80, 6)
  })

  it('keeps in-range unbranched spend as null when the branch anchor was filtered out (everHadBranch)', () => {
    // A branch-bearing session whose only in-range turns predate its first
    // branch: the date slice dropped the anchor, but everHadBranch (captured
    // pre-filter) still lets its $20 land in the explicit null row.
    const rows = aggregateByBranch([project([
      session('s', [turn(20, 1)], true),
    ])])
    expect(rows).toEqual([{ branch: null, cost: 20, calls: 1, sessions: 1 }])
  })

  it('drops sessions that never observed a branch (no null bucket that dwarfs the rest)', () => {
    const rows = aggregateByBranch([project([
      session('branched', [turn(10, 1, 'main')]),
      session('unbranched', [turn(999, 3), turn(999, 3)]),
    ])])
    expect(rows).toEqual([{ branch: 'main', cost: 10, calls: 1, sessions: 1 }])
  })

  it('counts a session toward each branch it touched, once', () => {
    const rows = aggregateByBranch([project([
      session('a', [turn(40, 1, 'main'), turn(10, 1, 'feature')]),
      session('b', [turn(30, 1, 'main')]),
    ])])
    const main = rows.find(r => r.branch === 'main')!
    expect(main.sessions).toBe(2)
    expect(main.cost).toBeCloseTo(70, 6)
    const feature = rows.find(r => r.branch === 'feature')!
    expect(feature.sessions).toBe(1)
  })

  it('sorts rows by cost, descending', () => {
    const rows = aggregateByBranch([project([
      session('a', [turn(5, 1, 'small'), turn(200, 1, 'big'), turn(50, 1, 'mid')]),
    ])])
    expect(rows.map(r => r.branch)).toEqual(['big', 'mid', 'small'])
  })

  it('returns nothing when no session carries branch data', () => {
    expect(aggregateByBranch([project([session('a', [turn(100, 1)])])])).toEqual([])
  })
})
