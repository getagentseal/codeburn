import { describe, it, expect } from 'vitest'
import { filterProjectsByDateRange } from '../src/parser.js'
import type { ProjectSummary, SessionSummary, ClassifiedTurn, ParsedApiCall, TokenUsage } from '../src/types.js'

function makeTurn(timestamp: string, costUSD: number, model = 'claude-sonnet-4-6'): ClassifiedTurn {
  const usage: TokenUsage = {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
  const call: ParsedApiCall = {
    provider: 'claude',
    model,
    usage,
    costUSD,
    tools: ['Read'],
    mcpTools: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp,
    bashCommands: [],
    deduplicationKey: `test:${timestamp}`,
  }
  return {
    userMessage: 'test',
    assistantCalls: [call],
    timestamp,
    sessionId: 'sess1',
    category: 'coding',
    retries: 0,
    hasEdits: false,
  }
}

function makeSession(turns: ClassifiedTurn[]): SessionSummary {
  const totalCost = turns.reduce((s, t) => s + t.assistantCalls.reduce((a, c) => a + c.costUSD, 0), 0)
  return {
    sessionId: 'sess1',
    project: 'test-project',
    firstTimestamp: turns[0]?.timestamp ?? '',
    lastTimestamp: turns[turns.length - 1]?.timestamp ?? '',
    totalCostUSD: totalCost,
    totalInputTokens: turns.length * 100,
    totalOutputTokens: turns.length * 50,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.length,
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
  }
}

function makeProject(sessions: SessionSummary[]): ProjectSummary {
  return {
    project: 'test-project',
    projectPath: '/test/project',
    sessions,
    totalCostUSD: sessions.reduce((s, sess) => s + sess.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
  }
}

describe('filterProjectsByDateRange', () => {
  const day1Turn = makeTurn('2026-04-15T10:00:00Z', 0.05)
  const day2Turn = makeTurn('2026-04-16T10:00:00Z', 0.10)
  const day3Turn = makeTurn('2026-04-17T10:00:00Z', 0.15)

  const session = makeSession([day1Turn, day2Turn, day3Turn])
  const project = makeProject([session])

  it('filters turns to a 1-day range', () => {
    const range = {
      start: new Date('2026-04-16T00:00:00Z'),
      end: new Date('2026-04-16T23:59:59.999Z'),
    }
    const result = filterProjectsByDateRange([project], range)
    expect(result).toHaveLength(1)
    expect(result[0].sessions[0].turns).toHaveLength(1)
    expect(result[0].sessions[0].turns[0].timestamp).toBe('2026-04-16T10:00:00Z')
  })

  it('recomputes totals from filtered turns', () => {
    const range = {
      start: new Date('2026-04-16T00:00:00Z'),
      end: new Date('2026-04-16T23:59:59.999Z'),
    }
    const result = filterProjectsByDateRange([project], range)
    expect(result[0].totalCostUSD).toBeCloseTo(0.10)
    expect(result[0].totalApiCalls).toBe(1)
    expect(result[0].sessions[0].totalCostUSD).toBeCloseTo(0.10)
  })

  it('does not mutate input', () => {
    const original = JSON.parse(JSON.stringify(project))
    const range = {
      start: new Date('2026-04-16T00:00:00Z'),
      end: new Date('2026-04-16T23:59:59.999Z'),
    }
    filterProjectsByDateRange([project], range)
    expect(project.sessions[0].turns).toHaveLength(3)
    expect(project.totalCostUSD).toBeCloseTo(original.totalCostUSD)
  })

  it('excludes sessions with all turns outside range', () => {
    const range = {
      start: new Date('2026-04-20T00:00:00Z'),
      end: new Date('2026-04-20T23:59:59.999Z'),
    }
    const result = filterProjectsByDateRange([project], range)
    expect(result).toHaveLength(0)
  })

  it('excludes projects where all sessions are excluded', () => {
    const range = {
      start: new Date('2026-04-20T00:00:00Z'),
      end: new Date('2026-04-20T23:59:59.999Z'),
    }
    const result = filterProjectsByDateRange([project], range)
    expect(result).toHaveLength(0)
  })

  it('full range returns equivalent data', () => {
    const range = {
      start: new Date(0),
      end: new Date('2030-01-01T00:00:00Z'),
    }
    const result = filterProjectsByDateRange([project], range)
    expect(result).toHaveLength(1)
    expect(result[0].sessions[0].turns).toHaveLength(3)
    expect(result[0].totalCostUSD).toBeCloseTo(project.totalCostUSD)
  })

  it('cost invariant: totalCostUSD equals sum of turn costs', () => {
    const range = {
      start: new Date('2026-04-15T00:00:00Z'),
      end: new Date('2026-04-16T23:59:59.999Z'),
    }
    const result = filterProjectsByDateRange([project], range)
    const sess = result[0].sessions[0]
    const sumFromTurns = sess.turns
      .flatMap(t => t.assistantCalls)
      .reduce((s, c) => s + c.costUSD, 0)
    expect(sess.totalCostUSD).toBeCloseTo(sumFromTurns)
  })
})
