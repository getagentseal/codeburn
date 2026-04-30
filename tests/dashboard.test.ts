import { describe, it, expect } from 'vitest'

import { formatCost, formatTokens } from '../src/format.js'
import type { ProjectSummary, SessionSummary, TokenUsage } from '../src/types.js'

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

// Logic replicated from TopSessions component
function getTopSessions(projects: ProjectSummary[], n = 5) {
  const all = projects.flatMap(p => p.sessions.map(s => ({ ...s, projectName: p.project })))
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

function zeroTokens(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
}

function aggregateModelTotals(projects: ProjectSummary[]) {
  const totals: Record<string, { calls: number; costUSD: number; freshInput: number; output: number; cacheRead: number; cacheWrite: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        if (!totals[model]) totals[model] = { calls: 0, costUSD: 0, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        totals[model].calls += data.calls
        totals[model].costUSD += data.costUSD
        totals[model].freshInput += data.tokens.inputTokens
        totals[model].output += data.tokens.outputTokens
        totals[model].cacheRead += data.tokens.cacheReadInputTokens
        totals[model].cacheWrite += data.tokens.cacheCreationInputTokens
      }
    }
  }
  return totals
}

describe('formatTokens - size suffixes', () => {
  it('formats billions with B suffix', () => {
    expect(formatTokens(4_810_000_000)).toBe('4.81B')
  })

  it('formats millions with M suffix', () => {
    expect(formatTokens(168_400_000)).toBe('168.4M')
  })

  it('formats thousands with K suffix', () => {
    expect(formatTokens(23_500)).toBe('23.5K')
  })

  it('returns bare number for values under 1000', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })
})

describe('ModelBreakdown - token aggregation', () => {
  it('sums token fields across sessions and projects for a model', () => {
    const session: SessionSummary = {
      ...makeSession('s1', 10),
      modelBreakdown: {
        'Opus 4.6': {
          calls: 5,
          costUSD: 10,
          tokens: {
            ...zeroTokens(),
            inputTokens: 1000,
            outputTokens: 2000,
            cacheReadInputTokens: 3_000_000,
            cacheCreationInputTokens: 500_000,
          },
        },
      },
    }
    const session2: SessionSummary = {
      ...makeSession('s2', 5),
      modelBreakdown: {
        'Opus 4.6': {
          calls: 3,
          costUSD: 5,
          tokens: {
            ...zeroTokens(),
            inputTokens: 500,
            outputTokens: 1000,
            cacheReadInputTokens: 1_000_000,
            cacheCreationInputTokens: 200_000,
          },
        },
      },
    }
    const project = makeProject('proj', [session, session2])
    const totals = aggregateModelTotals([project])
    const opus = totals['Opus 4.6']
    expect(opus.calls).toBe(8)
    expect(opus.freshInput).toBe(1500)
    expect(opus.output).toBe(3000)
    expect(opus.cacheRead).toBe(4_000_000)
    expect(opus.cacheWrite).toBe(700_000)
    const totalTokens = opus.freshInput + opus.output + opus.cacheRead + opus.cacheWrite
    expect(formatTokens(totalTokens)).toBe('4.7M')
  })

  it('shows dash when a model has zero tokens recorded', () => {
    const session: SessionSummary = {
      ...makeSession('s1', 1),
      modelBreakdown: {
        'Empty Model': { calls: 1, costUSD: 1, tokens: zeroTokens() },
      },
    }
    const totals = aggregateModelTotals([makeProject('proj', [session])])
    const empty = totals['Empty Model']
    const totalTokens = empty.freshInput + empty.output + empty.cacheRead + empty.cacheWrite
    const label = totalTokens > 0 ? formatTokens(totalTokens) : '-'
    expect(label).toBe('-')
  })
})
