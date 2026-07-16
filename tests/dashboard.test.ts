import { homedir } from 'os'

import { describe, it, expect } from 'vitest'

import { getDailyActivityRows, pageHistoryCursor, scrollHistoryCursor, shortProject, showEmptyState } from '../src/dashboard.js'
import { formatCost } from '../src/format.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'

const EMPTY_CATEGORY_BREAKDOWN = {
  coding: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  debugging: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  feature: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  refactoring: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  testing: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  exploration: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  planning: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  delegation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  git: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  'build/deploy': { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  conversation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  brainstorming: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  general: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
} satisfies SessionSummary['categoryBreakdown']

function makeSession(id: string, cost: number, timestamp = '2026-04-14T10:00:00Z'): SessionSummary {
  return {
    sessionId: id,
    project: 'test-project',
    firstTimestamp: timestamp,
    lastTimestamp: timestamp,
    totalCostUSD: cost,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: { ...EMPTY_CATEGORY_BREAKDOWN },
    skillBreakdown: {},
  }
}

function makeProject(name: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project: name,
    projectPath: name,
    sessions,
    totalCostUSD: sessions.reduce((s, x) => s + x.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((s, x) => s + x.apiCalls, 0),
  }
}

function makeTurn(timestamp: string, costs: number[]): SessionSummary['turns'][number] {
  return {
    userMessage: 'fixture turn',
    sessionId: 'fixture-session',
    timestamp,
    category: 'coding',
    retries: 0,
    hasEdits: false,
    assistantCalls: costs.map((costUSD, index) => ({
      provider: 'codex',
      model: 'test-model',
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
      costUSD,
      tools: [],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard',
      timestamp,
      bashCommands: [],
      deduplicationKey: `fixture-${timestamp}-${index}`,
    })),
  }
}

// Logic replicated from TopSessions component
function getTopSessions(projects: ProjectSummary[], n = 5) {
  const all = projects.flatMap(p => p.sessions.map(s => ({ ...s, projectPath: p.projectPath })))
  return [...all].sort((a, b) => b.totalCostUSD - a.totalCostUSD).slice(0, n)
}

// Logic replicated from ProjectBreakdown component
function avgCostLabel(project: ProjectSummary): string {
  return project.sessions.length > 0
    ? formatCost(project.totalCostUSD / project.sessions.length)
    : '-'
}

describe('TopSessions - top-5 selection', () => {
  it('returns all sessions when fewer than 5 exist', () => {
    const project = makeProject('proj', [
      makeSession('s1', 1.0),
      makeSession('s2', 2.0),
    ])
    const top = getTopSessions([project])
    expect(top).toHaveLength(2)
    expect(top[0].totalCostUSD).toBe(2.0)
    expect(top[1].totalCostUSD).toBe(1.0)
  })

  it('returns exactly 5 when more than 5 sessions exist', () => {
    const sessions = [0.1, 0.5, 3.0, 1.0, 0.8, 2.0].map((cost, i) =>
      makeSession(`s${i}`, cost)
    )
    const project = makeProject('proj', sessions)
    const top = getTopSessions([project])
    expect(top).toHaveLength(5)
    expect(top[0].totalCostUSD).toBe(3.0)
    expect(top[4].totalCostUSD).toBe(0.5)
  })

  it('is stable on tied costs - preserves input order for equal values', () => {
    const sessions = [
      makeSession('s1', 1.0),
      makeSession('s2', 1.0),
      makeSession('s3', 1.0),
    ]
    const project = makeProject('proj', sessions)
    const top = getTopSessions([project])
    expect(top.map(s => s.sessionId)).toEqual(['s1', 's2', 's3'])
  })
})

describe('shortProject - path shortening', () => {
  const home = homedir()

  it('preserves directory names containing dashes', () => {
    expect(shortProject(`${home}/work/my-project`)).toBe('work/my-project')
  })

  it('preserves directory names containing dots', () => {
    expect(shortProject(`${home}/work/my.app.io`)).toBe('work/my.app.io')
  })

  it('returns "home" for the home dir itself', () => {
    expect(shortProject(home)).toBe('home')
  })

  it('does not strip a sibling whose name shares the home prefix', () => {
    const sibling = `${home}-backup/proj`
    expect(shortProject(sibling).endsWith('proj')).toBe(true)
    expect(shortProject(sibling)).not.toMatch(/^-/)
  })

  it('keeps only the last 3 segments for deeply nested paths', () => {
    expect(shortProject(`${home}/a/b/c/d/e/f`)).toBe('d/e/f')
  })

  it('handles paths outside the home dir', () => {
    expect(shortProject('/opt/myproject')).toBe('opt/myproject')
  })
})

describe('avg/s in ProjectBreakdown', () => {
  it('returns dash for a project with no sessions', () => {
    const project = makeProject('proj', [])
    expect(avgCostLabel(project)).toBe('-')
  })

  it('returns formatted average cost across sessions', () => {
    const sessions = [makeSession('s1', 2.0), makeSession('s2', 4.0)]
    const project = makeProject('proj', sessions)
    expect(avgCostLabel(project)).toBe(formatCost(3.0))
  })
})

describe('Daily Activity history', () => {
  it('aggregates every active day in chronological order', () => {
    const session = makeSession('s1', 0)
    session.turns = [
      makeTurn('2025-01-02T12:00:00Z', [1.25, 0.75]),
      makeTurn('2024-12-31T12:00:00Z', [3]),
    ]

    expect(getDailyActivityRows([makeProject('proj', [session])])).toEqual([
      { day: '2024-12-31', cost: 3, calls: 1 },
      { day: '2025-01-02', cost: 2, calls: 2 },
    ])
  })

  it('pages one viewport and keeps the final page full', () => {
    expect(pageHistoryCursor(0, 1, 35, 69)).toBe(34)
    expect(pageHistoryCursor(34, -1, 35, 69)).toBe(0)
    expect(pageHistoryCursor(0, -1, 35, 69)).toBe(0)
  })

  it('scrolls one row without moving past either end', () => {
    expect(scrollHistoryCursor(0, 1, 14, 21)).toBe(1)
    expect(scrollHistoryCursor(1, -1, 14, 21)).toBe(0)
    expect(scrollHistoryCursor(0, -1, 14, 21)).toBe(0)
    expect(scrollHistoryCursor(7, 1, 14, 21)).toBe(7)
  })
})

describe('showEmptyState', () => {
  it('keeps the clean empty state for a truly-new user in scrollable mode', () => {
    expect(showEmptyState(0, true, 0, false)).toBe(true)
  })

  it('renders the dashboard while full history is still loading', () => {
    expect(showEmptyState(0, true, 0, true)).toBe(false)
  })

  it('renders the dashboard when the period is empty but history exists', () => {
    expect(showEmptyState(0, true, 3, false)).toBe(false)
  })

  it('non-scrollable mode (custom range, day view) keeps the original behavior', () => {
    expect(showEmptyState(0, false, 0, false)).toBe(true)
    expect(showEmptyState(2, false, 0, false)).toBe(false)
  })
})
