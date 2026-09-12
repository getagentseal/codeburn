import { describe, expect, it } from 'vitest'
import type { DailyEntry } from '../src/daily-cache.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'
import {
  buildPayloadProjects,
  uniqueCanonicalSessionCount,
  uniqueCanonicalSessionCountFromProjects,
  uniquePeriodSessionCount,
} from '../src/usage-aggregator.js'

function session(opts: {
  id: string
  project: string
  cost: number
  provider?: string
  firstTimestamp?: string
}): SessionSummary {
  return {
    sessionId: opts.id,
    project: opts.project,
    firstTimestamp: opts.firstTimestamp ?? '2026-09-02T12:00:00.000Z',
    lastTimestamp: '2026-09-07T12:00:00.000Z',
    totalCostUSD: opts.cost,
    totalSavingsUSD: 0,
    apiCalls: 1,
    totalInputTokens: 100,
    totalOutputTokens: 20,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalReasoningTokens: 0,
    modelBreakdown: {},
    categoryBreakdown: {},
    turns: [{
      userMessage: 'task',
      timestamp: opts.firstTimestamp ?? '2026-09-02T12:00:00.000Z',
      assistantCalls: [{
        timestamp: opts.firstTimestamp ?? '2026-09-02T12:00:00.000Z',
        model: 'claude-sonnet-4-5',
        provider: opts.provider ?? 'claude',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUSD: opts.cost,
        cacheCostUSD: 0,
      }],
    }],
  } as SessionSummary
}

function liveRow(path: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project: 'vault',
    projectPath: path,
    sessions,
    totalCostUSD: sessions.reduce((n, s) => n + s.totalCostUSD, 0),
    totalSavingsUSD: 0,
    totalApiCalls: sessions.length,
    totalProxiedCostUSD: 0,
  }
}

function cacheDay(date: string, sessions: number, cost: number, path: string, carried = false): DailyEntry {
  const projects = { vault: { cost, calls: 1, savingsUSD: 0, sessions, path } }
  return {
    date,
    cost,
    savingsUSD: 0,
    calls: 1,
    sessions,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: { claude: { calls: 1, cost, savingsUSD: 0, sessions, projects } },
    projects,
    ...(carried ? { carried: true as const } : {}),
  }
}

describe('canonical session unique-count', () => {
  it('counts one provider+sessionId once', () => {
    const a = session({ id: 'same-actual-session', project: 'vault', cost: 0.006 })
    const b = session({ id: 'same-actual-session', project: 'vault', cost: 0.006, firstTimestamp: '2026-09-07T12:00:00.000Z' })
    expect(uniqueCanonicalSessionCount([a, b])).toBe(1)
  })

  it('keeps same-provider distinct ids and cross-provider same id string', () => {
    const claude = session({ id: 'sess', project: 'vault', cost: 1, provider: 'claude' })
    const otherClaude = session({ id: 'other', project: 'vault', cost: 1, provider: 'claude' })
    const codex = session({ id: 'sess', project: 'vault', cost: 1, provider: 'codex' })
    expect(uniqueCanonicalSessionCount([claude, otherClaude], '/tmp/p')).toBe(2)
    expect(uniqueCanonicalSessionCount([claude, codex], '/tmp/p')).toBe(2)
  })

  it('same filename sessionId in two folders stays two', () => {
    const a = session({ id: 'sess', project: 'vault', cost: 1 })
    const b = session({ id: 'sess', project: 'vault', cost: 1 })
    expect(uniqueCanonicalSessionCount([a], '/tmp/a/vault')).toBe(1)
    expect(uniqueCanonicalSessionCountFromProjects([
      liveRow('/tmp/a/vault', [a]),
      liveRow('/tmp/b/vault', [b]),
    ])).toBe(2)
  })
})

describe('buildPayloadProjects session counts', () => {
  const path = '/tmp/same-session-project'

  it('one live session spanning two occupancy days is one project session', () => {
    const live = [liveRow(path, [session({ id: 'same-actual-session', project: 'vault', cost: 0.012 })])]
    const days = [
      cacheDay('2026-09-02', 1, 0.006, path),
      cacheDay('2026-09-07', 1, 0.006, path),
    ]
    const rows = buildPayloadProjects(live, days, '/Users/synthetic')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost).toBeCloseTo(0.012)
    expect(rows[0]!.sessions).toBe(1)
    expect(rows[0]!.sessionCountBasis).toBe('partial')
    expect(rows[0]!.sessionDetails).toHaveLength(1)
  })

  it('same-provider distinct session ids stay two', () => {
    const live = [liveRow(path, [
      session({ id: 'a', project: 'vault', cost: 0.01 }),
      session({ id: 'b', project: 'vault', cost: 0.02 }),
    ])]
    const days = [
      cacheDay('2026-09-02', 1, 0.01, path),
      cacheDay('2026-09-07', 1, 0.02, path),
    ]
    const rows = buildPayloadProjects(live, days, '/Users/synthetic')
    expect(rows[0]!.sessions).toBe(2)
    expect(rows[0]!.sessionCountBasis).toBe('partial')
    expect(rows[0]!.cost).toBeCloseTo(0.03)
  })

  it('cross-provider identities stay distinct at one cwd', () => {
    const live = [liveRow(path, [
      session({ id: 'claude-1', project: 'vault', cost: 0.01, provider: 'claude' }),
      session({ id: 'codex-1', project: 'vault', cost: 0.02, provider: 'codex' }),
    ])]
    const days = [cacheDay('2026-09-07', 2, 0.03, path)]
    const rows = buildPayloadProjects(live, days, '/Users/synthetic')
    expect(rows[0]!.sessions).toBe(2)
    expect(rows[0]!.sessionCountBasis).toBe('partial')
  })

  it('source-dead multi-day occupancy without identities is not a false unique 2', () => {
    const days = [
      cacheDay('2026-08-01', 1, 1, path, true),
      cacheDay('2026-08-02', 1, 1, path, true),
    ]
    const rows = buildPayloadProjects([], days, '/Users/synthetic')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost).toBe(2)
    expect(rows[0]!.sessions).toBe(1)
    expect(rows[0]!.sessionCountBasis).toBe('partial')
  })

  it('source-only live identities with no cache rows are exact', () => {
    const live = [liveRow(path, [session({ id: 'same-actual-session', project: 'vault', cost: 0.012 })])]
    const rows = buildPayloadProjects(live, null, '/Users/synthetic')
    expect(rows[0]!.sessions).toBe(1)
    expect(rows[0]!.sessionCountBasis).toBe('identity')
  })

  it('one surviving identity plus a cache day of three sessions is a lower bound of 3', () => {
    const live = [liveRow(path, [session({ id: 'surviving-id', project: 'vault', cost: 1 })])]
    const days = [cacheDay('2026-09-02', 3, 3, path), cacheDay('2026-09-07', 1, 1, path)]
    const rows = buildPayloadProjects(live, days, '/Users/synthetic')
    expect(rows[0]!.cost).toBe(4)
    expect(rows[0]!.sessions).toBe(3)
    expect(rows[0]!.sessionCountBasis).toBe('partial')
  })

  it('empty source-only data is exact 0', () => {
    expect(uniquePeriodSessionCount([], [])).toEqual({ sessions: 0, basis: 'identity' })
  })
})

function blankDay(date: string, path: string): DailyEntry {
  const projects = { vault: { path, cost: 0, calls: 0, savingsUSD: 0, sessions: 0 } }
  return {
    date,
    cost: 0,
    savingsUSD: 0,
    calls: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: { claude: { calls: 0, cost: 0, savingsUSD: 0, sessions: 0, projects } },
    projects,
  }
}

describe('unknown cache accounting without session identities', () => {
  const path = '/tmp/same-session-project'
  const live = [liveRow(path, [session({ id: 'surviving-id', project: 'vault', cost: 1 })])]

  it('a truly empty cache row does not poison source-only exactness', () => {
    expect(uniquePeriodSessionCount(live, [blankDay('2026-09-02', path)])).toEqual({ sessions: 1, basis: 'identity' })
    expect(uniquePeriodSessionCount([], [blankDay('2026-09-02', path)])).toEqual({ sessions: 0, basis: 'identity' })
    const rows = buildPayloadProjects(live, [blankDay('2026-09-02', path)], '/Users/synthetic')
    expect(rows[0]!.sessionCountBasis).toBe('identity')
    expect(rows[0]!.sessions).toBe(1)
  })

  it('cost-bearing history with sessions 0 is a bound, not identity', () => {
    const day = blankDay('2026-09-02', path)
    day.cost = 3
    day.calls = 2
    day.projects!.vault!.cost = 3
    day.projects!.vault!.calls = 2
    day.providers.claude!.cost = 3
    day.providers.claude!.calls = 2
    const counted = uniquePeriodSessionCount(live, [day])
    expect(counted).toEqual({ sessions: 1, basis: 'partial' })
    const row = buildPayloadProjects(live, [day], '/Users/synthetic')[0]!
    expect(row.cost).toBe(3)
    expect(row.sessionCountBasis).toBe('partial')
  })

  it('call-only history with no session ids is unknown', () => {
    const day = blankDay('2026-09-02', path)
    day.calls = 4
    day.projects!.vault!.calls = 4
    day.providers.claude!.calls = 4
    expect(uniquePeriodSessionCount(live, [day]).basis).toBe('partial')
  })

  it('savings-only history with no session ids is unknown', () => {
    const day = blankDay('2026-09-02', path)
    day.savingsUSD = 1.5
    day.projects!.vault!.savingsUSD = 1.5
    day.providers.claude!.savingsUSD = 1.5
    expect(uniquePeriodSessionCount(live, [day]).basis).toBe('partial')
  })

  it('token-only history with no session ids is unknown', () => {
    const day = blankDay('2026-09-02', path)
    day.inputTokens = 900
    day.outputTokens = 40
    day.providers.claude!.inputTokens = 900
    day.providers.claude!.outputTokens = 40
    expect(uniquePeriodSessionCount(live, [day]).basis).toBe('partial')
    expect(uniquePeriodSessionCount(live, [day]).sessions).toBe(1)
  })

  it('absent session field on a cost-bearing row is unknown', () => {
    const day = blankDay('2026-09-02', path)
    day.cost = 2
    day.projects!.vault!.cost = 2
    delete (day as { sessions?: number }).sessions
    delete (day.projects!.vault! as { sessions?: number }).sessions
    delete (day.providers.claude! as { sessions?: number }).sessions
    expect(uniquePeriodSessionCount(live, [day as DailyEntry]).basis).toBe('partial')
  })
})

describe('uniquePeriodSessionCount headline', () => {
  it('uses live identity over occupancy ticks', () => {
    const live = [liveRow('/tmp/p', [session({ id: 'same-actual-session', project: 'vault', cost: 0.012 })])]
    const days = [
      cacheDay('2026-09-02', 1, 0.006, '/tmp/p'),
      cacheDay('2026-09-07', 1, 0.006, '/tmp/p'),
    ]
    expect(uniquePeriodSessionCount(live, days)).toEqual({ sessions: 1, basis: 'partial' })
  })

  it('keeps single-day carried occupancy when no live sessions survive', () => {
    const days = [cacheDay('2026-08-01', 3, 100, '/gone', true)]
    expect(uniquePeriodSessionCount([], days)).toEqual({ sessions: 3, basis: 'partial' })
  })

  it('does not add a carried-day tick to a surviving identity', () => {
    const live = [liveRow('/tmp/p', [session({ id: 'surviving-id', project: 'vault', cost: 1 })])]
    const days = [cacheDay('2026-09-02', 1, 1, '/tmp/p', true), cacheDay('2026-09-07', 1, 1, '/tmp/p')]
    const count = uniquePeriodSessionCount(live, days)
    expect(count.sessions).toBe(1)
    expect(count.basis).not.toBe('identity')
  })
})
