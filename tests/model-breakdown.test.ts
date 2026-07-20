import { describe, it, expect } from 'vitest'
import { aggregateModelTotals } from '../src/model-breakdown.js'
import type { ProjectSummary, TokenUsage } from '../src/types.js'

function tokens(input: number, cacheRead: number, cacheWrite: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
}

// Minimal ProjectSummary carrying only what aggregateModelTotals reads.
function project(modelBreakdown: Record<string, { calls: number; costUSD: number; tokens: TokenUsage }>): ProjectSummary {
  return { sessions: [{ modelBreakdown }] } as unknown as ProjectSummary
}

describe('aggregateModelTotals', () => {
  it('merges raw and normalized keys that resolve to the same model into one row', () => {
    // A mixed-vintage cache: the full Fireworks path from an older build and the
    // bare slug from a newer one — both resolve to `GLM-5.2`.
    const totals = aggregateModelTotals([
      project({ 'accounts/fireworks/models/glm-5p2': { calls: 2, costUSD: 3.0, tokens: tokens(100, 1000, 0) } }),
      project({ 'glm-5p2': { calls: 5, costUSD: 2.18, tokens: tokens(50, 500, 0) } }),
    ])

    expect(Object.keys(totals)).toEqual(['GLM-5.2'])
    expect(totals['GLM-5.2']).toMatchObject({ calls: 7, costUSD: 5.18, freshInput: 150, cacheRead: 1500 })
  })

  it('keeps distinct models on separate rows', () => {
    const totals = aggregateModelTotals([
      project({
        'accounts/fireworks/models/qwen3p7-plus': { calls: 1, costUSD: 0.5, tokens: tokens(10, 0, 0) },
        'accounts/fireworks/models/kimi-k2p7-code': { calls: 1, costUSD: 0.6, tokens: tokens(20, 0, 0) },
      }),
    ])
    expect(new Set(Object.keys(totals))).toEqual(new Set(['Qwen 3.7 Plus', 'Kimi K2.7 Code']))
  })
})
