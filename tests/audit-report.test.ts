import { describe, it, expect } from 'vitest'

import { aggregateAudit } from '../src/audit-report.js'
import type {
  ProjectSummary,
  SessionSummary,
  ClassifiedTurn,
  ParsedApiCall,
  TokenUsage,
  TaskCategory,
} from '../src/types.js'

function emptyTokens(): TokenUsage {
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

function makeCall(usage: Partial<TokenUsage>, costUSD: number, model = 'unknown-model-xyz', provider = 'claude'): ParsedApiCall {
  return {
    provider,
    model,
    usage: { ...emptyTokens(), ...usage },
    costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-05-09T00:00:00.000Z',
    bashCommands: [],
    deduplicationKey: `${provider}-${model}-${costUSD}-${usage.inputTokens ?? 0}-${usage.cachedInputTokens ?? 0}`,
  }
}

function makeProject(calls: ParsedApiCall[]): ProjectSummary {
  const turn: ClassifiedTurn = {
    userMessage: 't',
    assistantCalls: calls,
    timestamp: '2026-05-09T00:00:00.000Z',
    sessionId: 's1',
    category: 'feature' as TaskCategory,
    retries: 0,
    hasEdits: false,
  }
  const session: SessionSummary = {
    sessionId: 's1',
    project: 'p',
    firstTimestamp: '2026-05-09T00:00:00.000Z',
    lastTimestamp: '2026-05-09T00:00:00.000Z',
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 0,
    turns: [turn],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  }
  return { project: 'p', projectPath: 'p', sessions: [session], totalCostUSD: 0, totalApiCalls: 0 }
}

describe('aggregateAudit', () => {
  it('keeps raw fields and exposes codeburn normalizations', async () => {
    const anthropicCall = makeCall({ inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cacheReadInputTokens: 200 }, 0.5)
    const openaiCall = makeCall({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 300 }, 0.5)
    const rows = await aggregateAudit([makeProject([anthropicCall, openaiCall])])

    expect(rows).toHaveLength(1)
    const r = rows[0]!
    // raw fields are summed untouched
    expect(r.raw.inputTokens).toBe(200)
    expect(r.raw.outputTokens).toBe(100)
    expect(r.raw.reasoningTokens).toBe(10)
    expect(r.raw.cacheReadInputTokens).toBe(200)
    expect(r.raw.cachedInputTokens).toBe(300)
    // reasoning folds into output for pricing
    expect(r.displayed.outputTokens).toBe(110)
    // cache read is the SUM of per-call max(anthropic, openai), not max of sums
    expect(r.displayed.cacheReadTokens).toBe(500)
    // attributed cost is preserved exactly
    expect(r.attributedCostUSD).toBeCloseTo(1.0)
  })

  it('returns null rates and zero component cost for an unpriced model', async () => {
    const rows = await aggregateAudit([makeProject([makeCall({ inputTokens: 1000 }, 0, 'definitely-not-a-real-model-zzz')])])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.rates).toBeNull()
    expect(rows[0]!.cost.recomputedTotalUSD).toBe(0)
  })

  it('splits buckets by (provider, model)', async () => {
    const rows = await aggregateAudit([makeProject([
      makeCall({ inputTokens: 10 }, 0.1, 'model-a', 'claude'),
      makeCall({ inputTokens: 20 }, 0.2, 'model-b', 'claude'),
      makeCall({ inputTokens: 30 }, 0.3, 'model-a', 'codex'),
    ])])
    expect(rows).toHaveLength(3)
  })
})
