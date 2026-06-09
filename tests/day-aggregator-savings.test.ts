import { describe, expect, it } from 'vitest'

import { aggregateProjectsIntoDays, buildPeriodDataFromDays } from '../src/day-aggregator.js'
import type { ParsedApiCall, ProjectSummary, SessionSummary, Turn } from '../src/types.js'

function makeCall(timestamp: string, opts: { costUSD: number; savingsUSD?: number; savingsBaselineModel?: string; model?: string }): ParsedApiCall {
  return {
    provider: 'claude',
    model: opts.model ?? 'local-model',
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: opts.costUSD,
    savingsUSD: opts.savingsUSD,
    savingsBaselineModel: opts.savingsBaselineModel,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp,
    bashCommands: [],
    deduplicationKey: `dk-${timestamp}-${opts.costUSD}-${opts.savingsUSD ?? 0}`,
  }
}

function makeTurn(timestamp: string, calls: ParsedApiCall[], category: string = 'coding'): Turn {
  return {
    userMessage: 'u',
    timestamp,
    sessionId: 's',
    category: category as Turn['category'],
    retries: 0,
    hasEdits: false,
    assistantCalls: calls,
  } as Turn
}

function makeSession(sessions: SessionSummary[]): ProjectSummary {
  const totalCostUSD = sessions.reduce((s, sess) => s + sess.totalCostUSD, 0)
  const totalSavingsUSD = sessions.reduce((s, sess) => s + sess.totalSavingsUSD, 0)
  const totalApiCalls = sessions.reduce((s, sess) => s + sess.apiCalls, 0)
  return {
    project: 'p',
    projectPath: '/p',
    sessions,
    totalCostUSD,
    totalSavingsUSD,
    totalApiCalls,
  }
}

describe('aggregateProjectsIntoDays: savings totals', () => {
  it('rolls up day, model, category, and provider savings separately from cost', () => {
    const turn = makeTurn('2026-04-10T10:00:00', [
      makeCall('2026-04-10T10:00:00', { costUSD: 0, savingsUSD: 5, savingsBaselineModel: 'gpt-4o' }),
    ])
    const turn2 = makeTurn('2026-04-10T10:01:00', [
      makeCall('2026-04-10T10:01:00', { costUSD: 2, savingsUSD: 0, model: 'gpt-4o' }),
    ])
    const project: ProjectSummary = {
      project: 'p',
      projectPath: '/p',
      sessions: [{
        sessionId: 's1',
        project: 'p',
        firstTimestamp: '2026-04-10T10:00:00',
        lastTimestamp: '2026-04-10T10:01:00',
        totalCostUSD: 2,
        totalSavingsUSD: 5,
        totalInputTokens: 200,
        totalOutputTokens: 400,
        totalCacheReadTokens: 100,
        totalCacheWriteTokens: 0,
        apiCalls: 2,
        turns: [turn, turn2],
        modelBreakdown: { 'Local Model': { calls: 1, costUSD: 0, savingsUSD: 5, tokens: { inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 50, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 } }, 'gpt-4o': { calls: 1, costUSD: 2, savingsUSD: 0, tokens: { inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 50, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 } } },
        toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
        categoryBreakdown: { coding: { turns: 1, costUSD: 2, savingsUSD: 5, retries: 0, editTurns: 0, oneShotTurns: 0 } },
        skillBreakdown: {}, subagentBreakdown: {},
      }],
      totalCostUSD: 2,
      totalSavingsUSD: 5,
      totalApiCalls: 2,
    }
    const days = aggregateProjectsIntoDays([project])
    expect(days).toHaveLength(1)
    const day = days[0]!
    expect(day.cost).toBe(2)
    expect(day.savingsUSD).toBe(5)
    expect(day.models['local-model']).toMatchObject({ calls: 1, cost: 0, savingsUSD: 5 })
    expect(day.models['gpt-4o']).toMatchObject({ calls: 1, cost: 2, savingsUSD: 0 })
    expect(day.providers['claude']).toMatchObject({ calls: 2, cost: 2, savingsUSD: 5 })
    expect(day.categories.coding).toMatchObject({ turns: 2, cost: 2, savingsUSD: 5 })
  })
})

describe('buildPeriodDataFromDays: savings totals', () => {
  it('threads savings through to model and category rollups', () => {
    const days = [
      {
        date: '2026-04-09',
        cost: 2,
        savingsUSD: 5,
        calls: 1,
        sessions: 1,
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        editTurns: 0,
        oneShotTurns: 0,
        models: { 'local-model': { calls: 1, cost: 0, savingsUSD: 5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        categories: { coding: { turns: 1, cost: 0, savingsUSD: 5, editTurns: 0, oneShotTurns: 0 } },
        providers: { claude: { calls: 1, cost: 0, savingsUSD: 5 } },
      },
      {
        date: '2026-04-10',
        cost: 3,
        savingsUSD: 0,
        calls: 1,
        sessions: 1,
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        editTurns: 0,
        oneShotTurns: 0,
        models: { 'gpt-4o': { calls: 1, cost: 3, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        categories: { coding: { turns: 1, cost: 3, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 } },
        providers: { claude: { calls: 1, cost: 3, savingsUSD: 0 } },
      },
    ]
    const pd = buildPeriodDataFromDays(days, '7 Days')
    expect(pd.savingsUSD).toBe(5)
    const coding = pd.categories.find(c => c.name === 'Coding')!
    expect(coding.savingsUSD).toBe(5)
    const local = pd.models.find(m => m.name === 'local-model')!
    expect(local.savingsUSD).toBe(5)
    expect(local.cost).toBe(0)
  })
})
