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
  it('tiers the audit recompute per call, never on the bucket sum (#1076 review blocker)', async () => {
    // One 300k-prompt gpt-5.6 codex call (past the 272k tier) plus 200 small
    // calls whose SUM would blow far past the threshold. The per-call
    // recompute must tier only the big call; a bucket-sum tier would have
    // repriced all 201 and opened a phantom gap vs attributedCostUSD.
    const big = makeCall({ inputTokens: 300_000, outputTokens: 1_000 }, 300_000 * 8e-6 + 1_000 * 3e-5, 'gpt-5.6', 'codex')
    const small: ParsedApiCall[] = Array.from({ length: 200 }, (_, i) =>
      makeCall({ inputTokens: 1_000, outputTokens: 10 }, 1_000 * 4e-6 + 10 * 2e-5, 'gpt-5.6', 'codex'))
    const rows = await aggregateAudit([makeProject([big, ...small])])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // Expected: the big call at tier rates (in 8e-6, out 3e-5) + the 200
    // small calls at base (in 4e-6, out 2e-5).
    const expected = 300_000 * 8e-6 + 1_000 * 3e-5 + 200 * (1_000 * 4e-6 + 10 * 2e-5)
    expect(row.cost.recomputedTotalUSD).toBeCloseTo(expected, 9)
    // attributed priced the same way at parse time, so the invariant holds.
    expect(row.attributedCostUSD).toBeCloseTo(expected, 9)
  })

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
    // Reasoning does NOT fold into output for claude or codex: both bill it
    // as part of output_tokens already, so adding it would double-count
    // (#1075). Providers that report reasoning as a separate bucket still get
    // the additive treatment - see tests/codex-pricing-1075.test.ts.
    expect(r.displayed.outputTokens).toBe(100)
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

  it('gives copilot supplementary accounting no call weight and no phantom reasoning output', async () => {
    // One served request recorded twice: the per-turn call carries the full output, the
    // paired store row carries that output's reasoning subset plus real input/cache tokens.
    const perTurn = makeCall({ inputTokens: 300, outputTokens: 500, cacheReadInputTokens: 1000 }, 1.0, 'claude-sonnet-4-5', 'copilot')
    const supplementary: ParsedApiCall = {
      ...makeCall({ inputTokens: 40, outputTokens: 0, reasoningTokens: 800, cacheReadInputTokens: 900 }, 0.5, 'claude-sonnet-4-5', 'copilot'),
      supplementaryAccounting: true,
    }
    const rows = await aggregateAudit([makeProject([perTurn, supplementary])])

    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.calls).toBe(1)
    expect(r.displayed.outputTokens).toBe(500)
    // Raw stays untouched, and tokens/cost keep every call, supplementary included.
    expect(r.raw.reasoningTokens).toBe(800)
    expect(r.raw.inputTokens).toBe(340)
    expect(r.displayed.cacheReadTokens).toBe(1900)
    expect(r.attributedCostUSD).toBeCloseTo(1.5)
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
