import { describe, expect, it } from 'vitest'

import { aggregateModelEfficiency } from '../src/model-efficiency.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary } from '../src/types.js'

function call(model: string, costUSD = 1, provider: 'claude' | 'devin' = 'claude'): ParsedApiCall {
  return {
    provider,
    model,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD,
    tools: ['Edit'],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-05-05T00:00:00Z',
    bashCommands: [],
    deduplicationKey: `${provider}-${model}-${costUSD}`,
  }
}

function turn(model: string, opts: { hasEdits?: boolean; retries?: number; costUSD?: number } = {}): ClassifiedTurn {
  return {
    userMessage: '',
    assistantCalls: [call(model, opts.costUSD ?? 1)],
    timestamp: '2026-05-05T00:00:00Z',
    sessionId: 's1',
    category: 'coding',
    retries: opts.retries ?? 0,
    hasEdits: opts.hasEdits ?? true,
  }
}

function multiModelTurn(calls: ParsedApiCall[], opts: { retries?: number; hasEdits?: boolean } = {}): ClassifiedTurn {
  return {
    userMessage: '',
    assistantCalls: calls,
    timestamp: '2026-05-05T00:00:00Z',
    sessionId: 's1',
    category: 'coding',
    retries: opts.retries ?? 0,
    hasEdits: opts.hasEdits ?? true,
  }
}

function project(turns: ClassifiedTurn[]): ProjectSummary {
  const session: SessionSummary = {
    sessionId: 's1',
    project: 'app',
    firstTimestamp: '2026-05-05T00:00:00Z',
    lastTimestamp: '2026-05-05T00:00:00Z',
    totalCostUSD: turns.reduce((sum, t) => sum + t.assistantCalls.reduce((s, c) => s + c.costUSD, 0), 0),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.reduce((sum, t) => sum + t.assistantCalls.length, 0),
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  }
  return {
    project: 'app',
    projectPath: '/app',
    sessions: [session],
    totalCostUSD: session.totalCostUSD,
    totalApiCalls: session.apiCalls,
  }
}

describe('aggregateModelEfficiency', () => {
  it('computes one-shot, retry, and cost-per-edit metrics by display model', () => {
    const stats = aggregateModelEfficiency([project([
      turn('claude-sonnet-4-5', { hasEdits: true, retries: 0, costUSD: 2 }),
      turn('claude-sonnet-4-5', { hasEdits: true, retries: 2, costUSD: 4 }),
      turn('claude-opus-4-6', { hasEdits: true, retries: 0, costUSD: 10 }),
      turn('claude-sonnet-4-5', { hasEdits: false, retries: 0, costUSD: 3 }),
    ])])

    const sonnet = stats.get('Sonnet 4.5')
    expect(sonnet?.editTurns).toBe(2)
    expect(sonnet?.oneShotTurns).toBe(1)
    expect(sonnet?.oneShotRate).toBe(50)
    expect(sonnet?.retriesPerEdit).toBe(1)
    expect(sonnet?.costPerEditUSD).toBe(3)

    const opus = stats.get('Opus 4.6')
    expect(opus?.oneShotRate).toBe(100)
  })

  it('returns no stats for non-edit turns', () => {
    const stats = aggregateModelEfficiency([project([
      turn('claude-sonnet-4-5', { hasEdits: false }),
    ])])

    expect(stats.size).toBe(0)
  })

  it('attributes a multi-model turn to the first non-synthetic model', () => {
    const stats = aggregateModelEfficiency([project([
      multiModelTurn([
        call('<synthetic>', 0),
        call('claude-opus-4-6', 2),
        call('claude-sonnet-4-5', 1),
      ], { retries: 0, hasEdits: true }),
    ])])

    expect(stats.has('Opus 4.6')).toBe(true)
    expect(stats.has('Sonnet 4.5')).toBe(false)
    expect(stats.has('<synthetic>')).toBe(false)
    const opus = stats.get('Opus 4.6')!
    expect(opus.editTurns).toBe(1)
    expect(opus.oneShotTurns).toBe(1)
    expect(opus.costPerEditUSD).toBe(3)
  })

  it('skips a turn whose calls are all synthetic', () => {
    const stats = aggregateModelEfficiency([project([
      multiModelTurn([
        call('<synthetic>', 0),
        call('<synthetic>', 0),
      ], { retries: 0, hasEdits: true }),
    ])])

    expect(stats.size).toBe(0)
  })

  it('keeps Devin model variants as raw model ids', () => {
    const stats = aggregateModelEfficiency([project([
      turn('gpt-5-3-codex-xhigh', { hasEdits: true, retries: 0, costUSD: 2 }),
      turn('gpt-5-4-low', { hasEdits: true, retries: 1, costUSD: 3 }),
    ].map(t => ({
      ...t,
      assistantCalls: t.assistantCalls.map(c => ({ ...c, provider: 'devin' as const })),
    })))])

    expect(stats.has('gpt-5-3-codex-xhigh')).toBe(true)
    expect(stats.has('gpt-5-4-low')).toBe(true)
    expect(stats.has('GPT-5')).toBe(false)
  })
})
