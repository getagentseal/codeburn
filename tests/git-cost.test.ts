import { describe, expect, it } from 'vitest'

import { computeGitCost, parseGitSince, renderGitCostText, type GitCommit } from '../src/git-cost.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary } from '../src/types.js'

function commit(sha: string, committerDate: string, subject = `commit ${sha}`): GitCommit {
  return {
    sha,
    committerDate,
    authorName: 'Test User',
    subject,
  }
}

function makeCall(costUSD: number, timestamp: string): ParsedApiCall {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp,
    bashCommands: [],
    deduplicationKey: `${timestamp}:${costUSD}`,
  }
}

function makeTurn(sessionId: string, timestamp: string, costUSD: number): ClassifiedTurn {
  return {
    userMessage: 'test',
    assistantCalls: [makeCall(costUSD, timestamp)],
    timestamp,
    sessionId,
    category: 'coding',
    retries: 0,
    hasEdits: true,
  }
}

function makeSession(project: string, sessionId: string, first: string, last: string, costUSD: number): SessionSummary {
  const turns = [
    makeTurn(sessionId, first, costUSD / 2),
    makeTurn(sessionId, last, costUSD / 2),
  ]
  return {
    sessionId,
    project,
    firstTimestamp: first,
    lastTimestamp: last,
    totalCostUSD: costUSD,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 2,
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  }
}

function makeProject(projectPath: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project: projectPath.split('/').filter(Boolean).at(-1) ?? 'repo',
    projectPath,
    sessions,
    totalCostUSD: sessions.reduce((sum, session) => sum + session.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((sum, session) => sum + session.apiCalls, 0),
  }
}

describe('parseGitSince', () => {
  const now = new Date(2026, 4, 6, 12, 0, 0)

  it('parses 7days aliases', () => {
    const result = parseGitSince('7days', now)
    expect(result.label).toBe('Last 7 Days')
    expect(result.range.start).toEqual(new Date(2026, 3, 29))
  })

  it('parses week alias', () => {
    expect(parseGitSince('week', now).label).toBe('Last 7 Days')
  })

  it('parses today, month, and 30days', () => {
    expect(parseGitSince('today', now).label).toBe('Today (2026-05-06)')
    expect(parseGitSince('month', now).label).toBe('May 2026')
    expect(parseGitSince('30days', now).label).toBe('Last 30 Days')
  })

  it('parses arbitrary day windows', () => {
    const result = parseGitSince('14d', now)
    expect(result.label).toBe('Last 14 Days')
    expect(result.range.start).toEqual(new Date(2026, 3, 22))
  })

  it('uses singular wording for one-day custom windows', () => {
    expect(parseGitSince('1d', now).label).toBe('Last 1 Day')
  })

  it('rejects invalid values', () => {
    expect(() => parseGitSince('forever', now)).toThrow('Invalid --since value')
  })
})

describe('computeGitCost', () => {
  it('attributes matching repo sessions to commits inside the session window', () => {
    const session = makeSession(
      'repo',
      's1',
      '2026-05-06T10:00:00Z',
      '2026-05-06T10:30:00Z',
      10,
    )
    const result = computeGitCost([
      makeProject('/work/repo', [session]),
    ], [
      commit('abcdef123', '2026-05-06T11:00:00Z', 'ship feature'),
    ], {
      label: 'Last 7 Days',
      repoRoot: '/work/repo',
      windowMinutes: 120,
    })

    expect(result.summary.totalCostUSD).toBeCloseTo(10)
    expect(result.summary.attributedCostUSD).toBeCloseTo(10)
    expect(result.summary.unattributedCostUSD).toBeCloseTo(0)
    expect(result.commits).toEqual([
      expect.objectContaining({
        shortSha: 'abcdef1',
        subject: 'ship feature',
        costUSD: 10,
        sessions: 1,
        calls: 2,
      }),
    ])
  })

  it('splits one session across multiple matching commits without double-counting total cost', () => {
    const session = makeSession('repo', 's1', '2026-05-06T10:00:00Z', '2026-05-06T10:30:00Z', 12)
    const result = computeGitCost([
      makeProject('/work/repo', [session]),
    ], [
      commit('1111111', '2026-05-06T10:10:00Z'),
      commit('2222222', '2026-05-06T10:45:00Z'),
    ], {
      label: 'Last 7 Days',
      repoRoot: '/work/repo',
      windowMinutes: 120,
    })

    expect(result.summary.attributedCostUSD).toBeCloseTo(12)
    expect(result.commits).toHaveLength(2)
    expect(result.commits.map(row => row.costUSD)).toEqual([6, 6])
    expect(result.commits.map(row => row.calls)).toEqual([1, 1])
  })

  it('keeps sessions without matching commits unattributed', () => {
    const session = makeSession('repo', 's1', '2026-05-06T10:00:00Z', '2026-05-06T10:30:00Z', 8)
    const result = computeGitCost([
      makeProject('/work/repo', [session]),
    ], [
      commit('abcdef123', '2026-05-06T13:00:00Z'),
    ], {
      label: 'Last 7 Days',
      repoRoot: '/work/repo',
      windowMinutes: 30,
    })

    expect(result.summary.attributedCostUSD).toBe(0)
    expect(result.summary.unattributedCostUSD).toBeCloseTo(8)
    expect(result.unattributedSessions[0]).toMatchObject({ sessionId: 's1', costUSD: 8 })
  })

  it('ignores projects outside the current git repo', () => {
    const inside = makeSession('repo', 'inside', '2026-05-06T10:00:00Z', '2026-05-06T10:30:00Z', 5)
    const parent = makeSession('home', 'parent', '2026-05-06T10:00:00Z', '2026-05-06T10:30:00Z', 100)
    const sibling = makeSession('other', 'sibling', '2026-05-06T10:00:00Z', '2026-05-06T10:30:00Z', 100)

    const result = computeGitCost([
      makeProject('/work/repo/subdir', [inside]),
      makeProject('/work', [parent]),
      makeProject('/work/repo-other', [sibling]),
    ], [
      commit('abcdef123', '2026-05-06T10:15:00Z'),
    ], {
      label: 'Last 7 Days',
      repoRoot: '/work/repo',
      windowMinutes: 120,
    })

    expect(result.summary.totalCostUSD).toBeCloseTo(5)
    expect(result.summary.sessions).toBe(1)
  })

  it('matches desanitized absolute paths that are missing the leading slash', () => {
    const session = makeSession('repo', 's1', '2026-05-06T10:00:00Z', '2026-05-06T10:30:00Z', 5)
    const result = computeGitCost([
      makeProject('work/repo', [session]),
    ], [
      commit('abcdef123', '2026-05-06T10:15:00Z'),
    ], {
      label: 'Last 7 Days',
      repoRoot: '/work/repo',
      windowMinutes: 120,
    })

    expect(result.summary.totalCostUSD).toBeCloseTo(5)
    expect(result.summary.attributedCostUSD).toBeCloseTo(5)
  })

  it('matches projects when the git repo root is the filesystem root', () => {
    const session = makeSession('repo', 's1', '2026-05-06T10:00:00Z', '2026-05-06T10:30:00Z', 5)
    const result = computeGitCost([
      makeProject('/work/repo', [session]),
    ], [
      commit('abcdef123', '2026-05-06T10:15:00Z'),
    ], {
      label: 'Last 7 Days',
      repoRoot: '/',
      windowMinutes: 120,
    })

    expect(result.summary.totalCostUSD).toBeCloseTo(5)
    expect(result.summary.attributedCostUSD).toBeCloseTo(5)
  })
})

describe('renderGitCostText', () => {
  it('renders an empty repo-period message', () => {
    const result = computeGitCost([], [], {
      label: 'Last 7 Days',
      repoRoot: '/work/repo',
      windowMinutes: 120,
    })

    expect(renderGitCostText(result)).toContain('No usage sessions matched this git repository')
  })

  it('renders populated commit and unattributed sections', () => {
    const attributed = makeSession('repo', 'attributed', '2026-05-06T10:00:00Z', '2026-05-06T10:30:00Z', 10)
    const missing = Array.from({ length: 7 }, (_, index) =>
      makeSession('repo', `missing-${index}`, '2026-05-06T08:00:00Z', '2026-05-06T08:10:00Z', index + 1)
    )
    const result = computeGitCost([
      makeProject('/work/repo', [attributed, ...missing]),
    ], [
      commit('abcdef123', '2026-05-06T10:15:00Z', 'ship feature'),
    ], {
      label: 'Last 7 Days',
      repoRoot: '/work/repo',
      windowMinutes: 120,
    })

    const text = renderGitCostText(result)
    expect(text).toContain('Top commit costs')
    expect(text).toContain('ship feature')
    expect(text).toContain('Largest unattributed sessions')
    expect(text).toContain('...and 2 more unattributed sessions.')
  })

  it('formats fractional per-commit call shares for display', () => {
    const session = makeSession('repo', 'split-calls', '2026-05-06T10:00:00Z', '2026-05-06T10:10:00Z', 9)
    const result = computeGitCost([
      makeProject('/work/repo', [session]),
    ], [
      commit('1111111', '2026-05-06T10:02:00Z'),
      commit('2222222', '2026-05-06T10:04:00Z'),
      commit('3333333', '2026-05-06T10:06:00Z'),
    ], {
      label: 'Last 7 Days',
      repoRoot: '/work/repo',
      windowMinutes: 120,
    })

    const text = renderGitCostText(result)
    expect(text).toContain('0.7 calls')
    expect(text).not.toContain('0.666666')
  })
})
