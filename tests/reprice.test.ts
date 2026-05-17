import { describe, expect, it } from 'vitest'

import { calculateCost } from '../src/models.js'
import { analyzeReprice, canRepriceToModel, renderRepriceText } from '../src/reprice.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary } from '../src/types.js'

function makeCall(model: string, costUSD: number, opts: {
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  webSearch?: number
  speed?: 'standard' | 'fast'
  timestamp?: string
} = {}): ParsedApiCall {
  const timestamp = opts.timestamp ?? '2026-05-05T10:00:00Z'
  return {
    provider: 'claude',
    model,
    usage: {
      inputTokens: opts.inputTokens ?? 1000,
      outputTokens: opts.outputTokens ?? 500,
      cacheCreationInputTokens: opts.cacheWrite ?? 100,
      cacheReadInputTokens: opts.cacheRead ?? 2000,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: opts.webSearch ?? 0,
    },
    costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: opts.speed ?? 'standard',
    timestamp,
    bashCommands: [],
    deduplicationKey: `${model}:${timestamp}:${costUSD}`,
  }
}

function makeTurn(calls: ParsedApiCall[], timestamp = '2026-05-05T10:00:00Z'): ClassifiedTurn {
  return {
    userMessage: 'test',
    assistantCalls: calls,
    timestamp,
    sessionId: 's1',
    category: 'coding',
    retries: 0,
    hasEdits: true,
  }
}

function makeSession(project: string, sessionId: string, turns: ClassifiedTurn[]): SessionSummary {
  const costs = turns.flatMap(turn => turn.assistantCalls).reduce((sum, call) => sum + call.costUSD, 0)
  return {
    sessionId,
    project,
    firstTimestamp: turns[0]?.timestamp ?? '',
    lastTimestamp: turns[turns.length - 1]?.timestamp ?? '',
    totalCostUSD: costs,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.reduce((sum, turn) => sum + turn.assistantCalls.length, 0),
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  }
}

function makeProject(project: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project,
    projectPath: `/tmp/${project}`,
    sessions,
    totalCostUSD: sessions.reduce((sum, session) => sum + session.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((sum, session) => sum + session.apiCalls, 0),
  }
}

describe('canRepriceToModel', () => {
  it('recognizes known pricing models and aliases', () => {
    expect(canRepriceToModel('gpt-4o-mini')).toBe(true)
    expect(canRepriceToModel('claude-sonnet-4.5')).toBe(true)
    expect(canRepriceToModel('not-a-real-model')).toBe(false)
  })
})

describe('analyzeReprice', () => {
  it('recalculates every real call with the target model price', () => {
    const targetModel = 'gpt-4o-mini'
    const call = makeCall('claude-opus-4-7', 1.5, {
      inputTokens: 1200,
      outputTokens: 300,
      cacheWrite: 80,
      cacheRead: 400,
      webSearch: 2,
    })
    const expected = calculateCost(
      targetModel,
      call.usage.inputTokens,
      call.usage.outputTokens,
      call.usage.cacheCreationInputTokens,
      call.usage.cacheReadInputTokens,
      call.usage.webSearchRequests,
      call.speed,
    )

    const result = analyzeReprice([
      makeProject('api', [makeSession('api', 's1', [makeTurn([call])])]),
    ], 'Today', targetModel)

    expect(result.summary.actualCostUSD).toBeCloseTo(1.5)
    expect(result.summary.repricedCostUSD).toBeCloseTo(expected)
    expect(result.summary.savingsUSD).toBeCloseTo(1.5 - expected)
    expect(result.summary.calls).toBe(1)
    expect(result.summary.sessions).toBe(1)
  })

  it('preserves fast-mode pricing semantics for the target model', () => {
    const targetModel = 'claude-opus-4-7'
    const call = makeCall('claude-sonnet-4-5', 0.5, {
      speed: 'fast',
      inputTokens: 1000,
      outputTokens: 1000,
      cacheWrite: 0,
      cacheRead: 0,
    })

    const result = analyzeReprice([
      makeProject('api', [makeSession('api', 's1', [makeTurn([call])])]),
    ], 'Today', targetModel)

    expect(result.summary.repricedCostUSD).toBeCloseTo(calculateCost(targetModel, 1000, 1000, 0, 0, 0, 'fast'))
  })

  it('breaks impact down by project and source model', () => {
    const targetModel = 'gpt-4o-mini'
    const apiCall = makeCall('claude-opus-4-7', 2, { inputTokens: 1000 })
    const webCall = makeCall('claude-sonnet-4-5', 1, { inputTokens: 500 })

    const result = analyzeReprice([
      makeProject('api', [makeSession('api', 's1', [makeTurn([apiCall])])]),
      makeProject('web', [makeSession('web', 's2', [makeTurn([webCall])])]),
    ], 'Today', targetModel)

    expect(result.projects.map(row => row.name).sort()).toEqual(['api', 'web'])
    expect(result.sourceModels.map(row => row.name).sort()).toEqual(['claude-opus-4-7', 'claude-sonnet-4-5'])
    expect(result.projects.reduce((sum, row) => sum + row.calls, 0)).toBe(2)
    expect(result.sourceModels.reduce((sum, row) => sum + row.calls, 0)).toBe(2)
  })

  it('skips synthetic calls', () => {
    const targetModel = 'gpt-4o-mini'
    const result = analyzeReprice([
      makeProject('api', [
        makeSession('api', 's1', [makeTurn([makeCall('<synthetic>', 10)])]),
      ]),
    ], 'Today', targetModel)

    expect(result.summary.calls).toBe(0)
    expect(result.summary.actualCostUSD).toBe(0)
    expect(result.summary.repricedCostUSD).toBe(0)
    expect(result.topSessions).toEqual([])
  })

  it('sorts top sessions by absolute impact', () => {
    const targetModel = 'gpt-4o-mini'
    const result = analyzeReprice([
      makeProject('api', [
        makeSession('api', 'small', [makeTurn([makeCall('claude-opus-4-7', 1)])]),
        makeSession('api', 'large', [makeTurn([makeCall('claude-opus-4-7', 5)])]),
      ]),
    ], 'Today', targetModel)

    expect(result.topSessions[0]?.sessionId).toBe('large')
  })
})

describe('renderRepriceText', () => {
  it('renders empty usage clearly', () => {
    const result = analyzeReprice([], 'Today', 'gpt-4o-mini')
    expect(renderRepriceText(result)).toContain('No usage data found for this period.')
  })

  it('renders summary and target model', () => {
    const result = analyzeReprice([
      makeProject('api', [makeSession('api', 's1', [makeTurn([makeCall('claude-opus-4-7', 1)])])]),
    ], 'Today', 'gpt-4o-mini')

    const text = renderRepriceText(result)
    expect(text).toContain('CodeBurn what-if pricing')
    expect(text).toContain('gpt-4o-mini')
    expect(text).toContain('Actual spend')
    expect(text).toContain('What-if spend')
  })
})
