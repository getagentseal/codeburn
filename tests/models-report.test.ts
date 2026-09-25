import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, it, expect, vi } from 'vitest'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

import { aggregateModels, renderTable, renderMarkdown, renderJson, renderCsv, type ModelReportRow } from '../src/models-report.js'
import { setModelAliases } from '../src/models.js'
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

function makeCall(opts: {
  provider: string
  model: string
  costUSD: number
  input?: number
  output?: number
  reasoning?: number
  cacheWrite?: number
  cacheRead?: number
  savingsUSD?: number
  savingsBaselineModel?: string
  timestamp?: string
}): ParsedApiCall {
  return {
    provider: opts.provider,
    model: opts.model,
    usage: {
      ...emptyTokens(),
      inputTokens: opts.input ?? 0,
      outputTokens: opts.output ?? 0,
      reasoningTokens: opts.reasoning ?? 0,
      cacheCreationInputTokens: opts.cacheWrite ?? 0,
      cacheReadInputTokens: opts.cacheRead ?? 0,
    },
    costUSD: opts.costUSD,
    tools: [],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: opts.timestamp ?? '2026-05-09T00:00:00.000Z',
    bashCommands: [],
    deduplicationKey: `${opts.provider}-${opts.model}-${opts.costUSD}-${opts.timestamp ?? 'default'}`,
    savingsUSD: opts.savingsUSD,
    savingsBaselineModel: opts.savingsBaselineModel,
  }
}

function makeTurn(category: TaskCategory, calls: ParsedApiCall[]): ClassifiedTurn {
  return {
    userMessage: 'test',
    assistantCalls: calls,
    timestamp: '2026-05-09T00:00:00.000Z',
    sessionId: 's1',
    category,
    retries: 0,
    hasEdits: false,
  }
}

function makeSession(turns: ClassifiedTurn[]): SessionSummary {
  return {
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
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  }
}

function makeProject(turns: ClassifiedTurn[]): ProjectSummary {
  return {
    project: 'p',
    projectPath: '/tmp/p',
    sessions: [makeSession(turns)],
    totalCostUSD: 0,
    totalApiCalls: 0,
  }
}

// A session carrying an explicit agentType (Claude subagent transcript). Left
// undefined for ordinary main sessions.
function makeAgentSession(opts: { sessionId: string; agentType?: string; turns: ClassifiedTurn[] }): SessionSummary {
  return { ...makeSession(opts.turns), sessionId: opts.sessionId, agentType: opts.agentType }
}

function projectFromSessions(sessions: SessionSummary[]): ProjectSummary {
  return {
    project: 'p',
    projectPath: '/tmp/p',
    sessions,
    totalCostUSD: 0,
    totalApiCalls: 0,
  }
}

describe('aggregateModels', () => {
  it('groups by (provider, model) and sorts by cost descending in default mode', async () => {
    const project = makeProject([
      makeTurn('feature', [
        makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', input: 1000, output: 200, cacheWrite: 500, cacheRead: 8000, costUSD: 5.0 }),
      ]),
      makeTurn('debugging', [
        makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', input: 800, output: 100, cacheWrite: 300, cacheRead: 5000, costUSD: 3.5 }),
      ]),
      makeTurn('feature', [
        makeCall({ provider: 'codex', model: 'gpt-5', input: 600, output: 80, costUSD: 1.2 }),
      ]),
    ])
    const rows = await aggregateModels([project])
    expect(rows.map(r => `${r.provider}:${r.model}`)).toEqual(['claude:claude-sonnet-4-6', 'codex:gpt-5'])
    const claudeRow = rows[0]!
    expect(claudeRow.inputTokens).toBe(1800)
    expect(claudeRow.outputTokens).toBe(300)
    expect(claudeRow.cacheWriteTokens).toBe(800)
    expect(claudeRow.cacheReadTokens).toBe(13000)
    expect(claudeRow.costUSD).toBeCloseTo(8.5, 6)
    expect(claudeRow.calls).toBe(2)
    expect(claudeRow.totalTokens).toBe(1800 + 300 + 800 + 13000)
  })

  it('computes Codex credits per model and leaves non-Codex / unknown models null', async () => {
    const rows = await aggregateModels([makeProject([
      // gpt-5.5: 1M non-cached input (125) + 1M cached read (12.5) + 1M output (750) = 887.5 credits
      makeTurn('feature', [
        makeCall({ provider: 'codex', model: 'gpt-5.5', input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, costUSD: 9 }),
      ]),
      // codex but no known credit rate -> null
      makeTurn('feature', [
        makeCall({ provider: 'codex', model: 'gpt-5', input: 1000, output: 80, costUSD: 1.2 }),
      ]),
      // non-codex provider -> null even if tokens present
      makeTurn('feature', [
        makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', input: 1000, output: 200, costUSD: 5 }),
      ]),
    ])])
    const byKey = Object.fromEntries(rows.map(r => [`${r.provider}:${r.model}`, r]))
    expect(byKey['codex:gpt-5.5']!.credits).toBeCloseTo(887.5, 6)
    expect(byKey['codex:gpt-5']!.credits).toBeNull()
    expect(byKey['claude:claude-sonnet-4-6']!.credits).toBeNull()
    expect(byKey['codex:gpt-5.5']!.creditsIncomplete).toBeFalsy()
  })

  it('partial-sums Codex credits when a merge mixes rated and unrated ids', async () => {
    setModelAliases({ 'codex-house-sku': 'gpt-5.5' })
    try {
      const rows = await aggregateModels([makeProject([
        makeTurn('feature', [
          makeCall({ provider: 'codex', model: 'gpt-5.5', input: 0, output: 1_000_000, costUSD: 9 }),
        ]),
        makeTurn('feature', [
          makeCall({ provider: 'codex', model: 'codex-house-sku', input: 0, output: 1_000_000, costUSD: 9 }),
        ]),
      ])])
      expect(rows).toHaveLength(1)
      expect(rows[0]!.model).toBe('gpt-5.5')
      // gpt-5.5 output is 750 credits/M; the aliased house SKU has no rate.
      expect(rows[0]!.credits).toBeCloseTo(750, 6)
      expect(rows[0]!.creditsIncomplete).toBe(true)
      expect(rows[0]!.calls).toBe(2)
      const parsed = JSON.parse(renderJson(rows))
      expect(parsed[0].credits).toBeCloseTo(750, 6)
      expect(parsed[0].creditsIncomplete).toBe(true)
    } finally {
      setModelAliases({})
    }
  })

  it('splits DeepSeek usage into peak and repriced off-peak dollars', async () => {
    const rows = await aggregateModels([makeProject([
      // Monday 2026-09-28: 02:00 UTC = peak, 12:00 UTC = off-peak.
      makeTurn('feature', [
        makeCall({ provider: 'dsh', model: 'deepseek-chat', input: 1000, output: 100, costUSD: 2, timestamp: '2026-09-28T02:00:00Z' }),
      ]),
      makeTurn('feature', [
        makeCall({ provider: 'dsh', model: 'deepseek-chat', input: 1000, output: 100, costUSD: 4, timestamp: '2026-09-28T12:00:00Z' }),
      ]),
    ])])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // Stored cost is untouched (list rate); the split carries the bill.
    expect(row.costUSD).toBeCloseTo(6, 6)
    expect(row.peakUSD).toBeCloseTo(2, 6)
    expect(row.offPeakUSD).toBeCloseTo(2, 6)
    expect(row.peakKind).toBe('deepseek-usd')
    expect(row.peakCalls).toBe(1)
    expect(row.offPeakCalls).toBe(1)
    const parsed = JSON.parse(renderJson(rows))
    expect(parsed[0].peakUSD).toBeCloseTo(2, 6)
    expect(parsed[0].offPeakUSD).toBeCloseTo(2, 6)
    expect(parsed[0].peakKind).toBe('deepseek-usd')
  })

  it('splits GLM usage as a consumption share without repricing dollars', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [
        makeCall({ provider: 'zcode', model: 'glm-5.3', input: 1000, output: 100, costUSD: 3, timestamp: '2026-09-28T08:00:00Z' }),
      ]),
      makeTurn('feature', [
        makeCall({ provider: 'zcode', model: 'glm-5.3', input: 1000, output: 100, costUSD: 5, timestamp: '2026-09-28T12:00:00Z' }),
      ]),
    ])])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.costUSD).toBeCloseTo(8, 6)
    expect(row.peakUSD).toBeCloseTo(3, 6)
    expect(row.offPeakUSD).toBeCloseTo(5, 6)
    expect(row.peakKind).toBe('zai-credits')
  })

  it('leaves rows without a peak regime or timestamp unsplit', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [
        makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', input: 100, output: 10, costUSD: 1, timestamp: '2026-09-28T02:00:00Z' }),
      ]),
    ])])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.peakUSD).toBeNull()
    expect(rows[0]!.offPeakUSD).toBeNull()
    expect(rows[0]!.peakKind).toBeUndefined()
  })

  it('includes credits in the JSON output', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [
        makeCall({ provider: 'codex', model: 'gpt-5.5', input: 0, output: 1_000_000, cacheRead: 0, costUSD: 9 }),
      ]),
    ])])
    const parsed = JSON.parse(renderJson(rows))
    expect(parsed[0].credits).toBeCloseTo(750, 6)
  })

  it('does not double-count cache reads when a provider sets both cache fields', async () => {
    // Providers like codex/mux/codebuff populate cacheReadInputTokens AND
    // cachedInputTokens with the same value (Anthropic vs OpenAI vocabulary for
    // the same tokens). The report must count them once, not sum them.
    const call = makeCall({ provider: 'mux', model: 'claude-opus-4-8', input: 100, output: 50, cacheRead: 4000, costUSD: 2.0 })
    call.usage.cachedInputTokens = 4000 // mirrors cacheReadInputTokens, as those providers do

    const rows = await aggregateModels([makeProject([makeTurn('feature', [call])])])
    expect(rows[0]!.cacheReadTokens).toBe(4000) // not 8000
  })

  it('falls back from a provider local table miss to the global short name', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [makeCall({ provider: 'cursor-agent', model: 'gpt-5.6-sol', costUSD: 2.5 })]),
    ])])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.modelDisplayName).toBe('GPT-5.6 Sol (est.)')
    expect(rows[0]!.model).toBe('gpt-5.6-sol')
  })

  it('resolves Fireworks path-form ids through the global table', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [makeCall({ provider: 'cline', model: 'accounts/fireworks/models/kimi-k2p6', costUSD: 1 })]),
    ])])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.modelDisplayName).toBe('Kimi K2.6')
    expect(rows[0]!.model).toBe('accounts/fireworks/models/kimi-k2p6')
  })

  it('merges two raw ids that resolve to the same alias-resolved canonical id', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('testing', [makeCall({
        provider: 'cline-cli', model: 'accounts/fireworks/models/glm-5p2',
        input: 800, output: 67, costUSD: 0.246,
      })]),
      makeTurn('conversation', [makeCall({
        provider: 'cline-cli', model: 'glm-5p2',
        input: 15, output: 1, costUSD: 0.019,
      })]),
    ])])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider).toBe('cline-cli')
    expect(rows[0]!.modelDisplayName).toBe('GLM-5.2')
    // First-seen raw id, not the lexicographically-smallest of the merge.
    expect(rows[0]!.model).toBe('accounts/fireworks/models/glm-5p2')
    expect(rows[0]!.inputTokens).toBe(815)
    expect(rows[0]!.outputTokens).toBe(68)
    expect(rows[0]!.costUSD).toBeCloseTo(0.265, 6)
    expect(rows[0]!.calls).toBe(2)
    expect(rows[0]!.topCategory).toBe('testing')
    expect(rows[0]!.topCategoryShare).toBeCloseTo(0.246 / 0.265, 3)
  })

  it('does not pick the lexicographically-smallest raw id after a merge', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [makeCall({ provider: 'codex', model: 'kimi-k3', costUSD: 2 })]),
      makeTurn('feature', [makeCall({ provider: 'codex', model: 'k3', costUSD: 1 })]),
    ])])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.model).toBe('kimi-k3')
    expect(rows[0]!.modelDisplayName).toBe('Kimi K3')
    expect(rows[0]!.calls).toBe(2)
  })

  it('does not merge same-provider ids that only share a display name', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [makeCall({ provider: 'codex', model: 'gpt-5', costUSD: 3 })]),
      makeTurn('feature', [makeCall({ provider: 'codex', model: 'gpt-5-untracked-xyz', costUSD: 1 })]),
      makeTurn('feature', [makeCall({ provider: 'cline-cli', model: 'glm-5p2', costUSD: 1 })]),
      makeTurn('feature', [makeCall({ provider: 'cline-cli', model: 'GLM-5.2', costUSD: 2 })]),
    ])])
    const codex = rows.filter(r => r.provider === 'codex')
    expect(codex).toHaveLength(2)
    expect(codex.every(r => r.modelDisplayName === 'GPT-5')).toBe(true)
    expect(new Set(codex.map(r => r.model))).toEqual(new Set(['gpt-5', 'gpt-5-untracked-xyz']))

    const cline = rows.filter(r => r.provider === 'cline-cli')
    expect(cline).toHaveLength(2)
    expect(cline.every(r => r.modelDisplayName === 'GLM-5.2')).toBe(true)
    expect(new Set(cline.map(r => r.model))).toEqual(new Set(['glm-5p2', 'GLM-5.2']))
  })

  it('clears a merged savings baseline when three raw ids disagree', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [makeCall({
        provider: 'codex', model: 'k3',
        costUSD: 1, savingsUSD: 2, savingsBaselineModel: 'gpt-4o',
      })]),
      makeTurn('feature', [makeCall({
        provider: 'codex', model: 'kimi-k3',
        costUSD: 1, savingsUSD: 2, savingsBaselineModel: 'claude-sonnet-4-6',
      })]),
      makeTurn('feature', [makeCall({
        provider: 'codex', model: 'k3-agent',
        costUSD: 1, savingsUSD: 2, savingsBaselineModel: 'gpt-5',
      })]),
    ])])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.provider).toBe('codex')
    expect(rows[0]!.modelDisplayName).toBe('Kimi K3')
    expect(rows[0]!.savingsUSD).toBe(6)
    expect(rows[0]!.savingsBaselineModel).toBe('')
    expect(rows[0]!.calls).toBe(3)
  })

  it('collapses two raw MiniMax routes into one row and keeps both visible as rawModels (#1239)', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [makeCall({ provider: 'opencode', model: 'minimax/MiniMax-M3', input: 100, output: 50, costUSD: 0.05 })]),
      makeTurn('feature', [makeCall({ provider: 'opencode', model: 'MiniMaxAI/MiniMax-M3', input: 200, output: 100, costUSD: 6.94 })]),
    ])])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.modelDisplayName).toBe('MiniMax M3')
    expect(rows[0]!.rawModels).toEqual(['minimax/MiniMax-M3', 'MiniMaxAI/MiniMax-M3'])
    expect(rows[0]!.costUSD).toBeCloseTo(6.99, 6)

    const parsed = JSON.parse(renderJson(rows))
    expect(parsed[0].rawModels).toEqual(['minimax/MiniMax-M3', 'MiniMaxAI/MiniMax-M3'])
  })

  it('does not merge the same display name across providers', async () => {
    const rows = await aggregateModels([makeProject([
      makeTurn('feature', [makeCall({ provider: 'cline-cli', model: 'glm-5p2', costUSD: 1 })]),
      makeTurn('feature', [makeCall({ provider: 'hermes', model: 'glm-5p2', costUSD: 2 })]),
    ])])
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => r.provider))).toEqual(new Set(['cline-cli', 'hermes']))
    expect(rows.every(r => r.modelDisplayName === 'GLM-5.2')).toBe(true)
  })

  it('reports the dominant task type with its cost share in default mode', async () => {
    const project = makeProject([
      makeTurn('feature', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 6.0, input: 100, output: 20 })]),
      makeTurn('debugging', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 50, output: 10 })]),
      makeTurn('refactoring', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 50, output: 10 })]),
    ])
    const rows = await aggregateModels([project])
    expect(rows[0]!.topCategory).toBe('feature')
    expect(rows[0]!.topCategoryShare).toBeCloseTo(0.6, 3)
  })

  it('explodes rows by task in byTask mode and groups them so renderer can blank repeats', async () => {
    const project = makeProject([
      makeTurn('feature', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 6.0, input: 100, output: 20 })]),
      makeTurn('debugging', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 50, output: 10 })]),
      makeTurn('feature', [makeCall({ provider: 'codex', model: 'gpt-5', costUSD: 1.0, input: 60, output: 10 })]),
    ])
    const rows = await aggregateModels([project], { byTask: true })
    expect(rows).toHaveLength(3)
    // Group order: claude (8.0) before codex (1.0); within claude, feature (6.0) before debugging (2.0).
    expect(rows.map(r => `${r.provider}:${r.model}:${r.category}`)).toEqual([
      'claude:claude-sonnet-4-6:feature',
      'claude:claude-sonnet-4-6:debugging',
      'codex:gpt-5:feature',
    ])
  })

  it('respects taskFilter by excluding non-matching turns from every bucket', async () => {
    const project = makeProject([
      makeTurn('feature', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 5.0, input: 100, output: 20 })]),
      makeTurn('debugging', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 50, output: 10 })]),
    ])
    const rows = await aggregateModels([project], { taskFilter: 'feature' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.costUSD).toBeCloseTo(5.0, 6)
  })

  it('applies topN and minCost filters', async () => {
    const project = makeProject([
      makeTurn('feature', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 5.0, input: 100, output: 20 })]),
      makeTurn('feature', [makeCall({ provider: 'codex', model: 'gpt-5', costUSD: 0.5, input: 50, output: 10 })]),
      makeTurn('feature', [makeCall({ provider: 'cursor', model: 'auto', costUSD: 0.001, input: 10, output: 1 })]),
    ])
    const top = await aggregateModels([project], { topN: 1 })
    expect(top).toHaveLength(1)
    const above = await aggregateModels([project], { minCost: 0.01 })
    expect(above.find(r => r.provider === 'cursor')).toBeUndefined()
  })

  // Providers that report reasoning as a bucket SEPARATE from output still get
  // it added in. Codex and claude do not - they bill reasoning inside
  // output_tokens - and that carve-out is covered in codex-pricing-1075.test.ts.
  it('counts reasoning tokens as output tokens', async () => {
    const project = makeProject([
      makeTurn('feature', [
        {
          provider: 'gemini',
          model: 'gemini-2.5-pro',
          usage: { ...emptyTokens(), inputTokens: 100, outputTokens: 50, reasoningTokens: 200 },
          costUSD: 1.0,
          tools: [],
          mcpTools: [],
          skills: [],
          hasAgentSpawn: false,
          hasPlanMode: false,
          speed: 'standard',
          timestamp: '2026-05-09T00:00:00.000Z',
          bashCommands: [],
          deduplicationKey: 'k',
        },
      ]),
    ])
    const rows = await aggregateModels([project])
    expect(rows[0]!.outputTokens).toBe(250)
  })

  it('gives copilot supplementary accounting no call weight and no phantom reasoning output', async () => {
    // One served request recorded twice: the per-turn call carries the full output, the
    // paired store row carries that output's reasoning subset plus real input/cache tokens.
    const perTurn = makeCall({ provider: 'copilot', model: 'claude-sonnet-4-5', input: 300, output: 500, cacheRead: 1000, costUSD: 1.0 })
    const supplementary: ParsedApiCall = {
      ...makeCall({ provider: 'copilot', model: 'claude-sonnet-4-5', input: 40, output: 0, reasoning: 800, cacheRead: 900, costUSD: 0.5 }),
      supplementaryAccounting: true,
    }
    const rows = await aggregateModels([makeProject([makeTurn('feature', [perTurn, supplementary])])])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.calls).toBe(1)
    expect(row.outputTokens).toBe(500)
    // Tokens and cost keep every call, supplementary included.
    expect(row.inputTokens).toBe(340)
    expect(row.cacheReadTokens).toBe(1900)
    expect(row.costUSD).toBeCloseTo(1.5, 6)
  })
})

describe('aggregateModels byAgent', () => {
  // One project: a planner agent on two models, a reviewer agent sharing one of
  // those models, a real agent named main, an ordinary main session, and a
  // non-Claude provider session (no agentType).
  function crossProject(): ProjectSummary {
    return projectFromSessions([
      makeAgentSession({ sessionId: 'a', agentType: 'planner', turns: [
        makeTurn('planning', [makeCall({ provider: 'claude', model: 'claude-opus-4-8', costUSD: 6.0, input: 100, output: 20 })]),
        makeTurn('planning', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 50, output: 10 })]),
      ] }),
      makeAgentSession({ sessionId: 'b', agentType: 'reviewer', turns: [
        makeTurn('exploration', [makeCall({ provider: 'claude', model: 'claude-opus-4-8', costUSD: 3.0, input: 40, output: 8 })]),
      ] }),
      makeAgentSession({ sessionId: 'real-main', agentType: 'main', turns: [
        makeTurn('exploration', [makeCall({ provider: 'claude', model: 'claude-opus-4-8', costUSD: 0.75, input: 25, output: 4 })]),
      ] }),
      // no agentType -> ordinary main session
      makeAgentSession({ sessionId: 'c', turns: [
        makeTurn('feature', [makeCall({ provider: 'claude', model: 'claude-opus-4-8', costUSD: 1.0, input: 30, output: 5 })]),
      ] }),
      // non-Claude provider, no agentType -> also '(main)'
      makeAgentSession({ sessionId: 'd', turns: [
        makeTurn('feature', [makeCall({ provider: 'codex', model: 'gpt-5', costUSD: 0.5, input: 20, output: 4 })]),
      ] }),
    ])
  }

  it('keeps a real agent named main distinct from the (main) sentinel across all formats', async () => {
    const rows = await aggregateModels([crossProject()], { byAgent: true })
    const byKey = Object.fromEntries(rows.map(r => [`${r.provider}:${r.model}:${r.agentType}`, r]))
    // one agent (planner) split across two models
    expect(byKey['claude:claude-opus-4-8:planner']!.costUSD).toBeCloseTo(6.0, 6)
    expect(byKey['claude:claude-sonnet-4-6:planner']!.costUSD).toBeCloseTo(2.0, 6)
    // two agents (planner + reviewer) on the same model
    expect(byKey['claude:claude-opus-4-8:reviewer']!.costUSD).toBeCloseTo(3.0, 6)
    // real agent named main and the ordinary-session sentinel remain separate
    expect(byKey['claude:claude-opus-4-8:main']!.costUSD).toBeCloseTo(0.75, 6)
    expect(byKey['claude:claude-opus-4-8:(main)']!.costUSD).toBeCloseTo(1.0, 6)
    // non-Claude provider (no agentType) also buckets under '(main)'
    expect(byKey['codex:gpt-5:(main)']!.agentType).toBe('(main)')
    expect(byKey['codex:gpt-5:(main)']!.costUSD).toBeCloseTo(0.5, 6)
    // four distinct agent rows share claude-opus-4-8
    const collisionRows = rows.filter(r => r.model === 'claude-opus-4-8')
    expect(collisionRows).toHaveLength(4)

    const table = stripAnsi(renderTable(collisionRows, { byAgent: true, showTotals: false, terminalWidth: 200 }))
    expect(table.split('\n').some(line => /│\s*\(main\)\s*│/.test(line))).toBe(true)
    expect(table.split('\n').some(line => /│\s*main\s*│/.test(line))).toBe(true)

    const markdown = renderMarkdown(collisionRows, { byAgent: true, showTotals: false })
    expect(markdown).toContain('| (main) |')
    expect(markdown).toContain('| main |')

    const jsonAgents = (JSON.parse(renderJson(collisionRows)) as Array<{ agentType: string }>).map(row => row.agentType)
    expect(jsonAgents).toContain('(main)')
    expect(jsonAgents).toContain('main')

    const csvAgents = renderCsv(collisionRows, { byAgent: true }).trimEnd().split('\n').slice(1).map(line => line.split(',')[2])
    expect(csvAgents).toContain('(main)')
    expect(csvAgents).toContain('main')
  })

  it('groups rows by (provider, model) ordered by total model cost, agents by cost desc within a group', async () => {
    const project = projectFromSessions([
      makeAgentSession({ sessionId: 'a', agentType: 'planner', turns: [
        makeTurn('planning', [makeCall({ provider: 'claude', model: 'claude-opus-4-8', costUSD: 6.0, input: 10, output: 2 })]),
        makeTurn('planning', [makeCall({ provider: 'claude', model: 'claude-sonnet-4-6', costUSD: 2.0, input: 10, output: 2 })]),
      ] }),
      makeAgentSession({ sessionId: 'b', agentType: 'reviewer', turns: [
        makeTurn('exploration', [makeCall({ provider: 'claude', model: 'claude-opus-4-8', costUSD: 3.0, input: 10, output: 2 })]),
      ] }),
    ])
    const rows = await aggregateModels([project], { byAgent: true })
    // opus group total (9) sorts before sonnet (2); within opus, planner (6) before reviewer (3).
    expect(rows.map(r => `${r.model}:${r.agentType}`)).toEqual([
      'claude-opus-4-8:planner',
      'claude-opus-4-8:reviewer',
      'claude-sonnet-4-6:planner',
    ])
  })

  it('leaves agentType null in the default and byTask views', async () => {
    const project = projectFromSessions([
      makeAgentSession({ sessionId: 'a', agentType: 'planner', turns: [
        makeTurn('planning', [makeCall({ provider: 'claude', model: 'claude-opus-4-8', costUSD: 6.0, input: 10, output: 2 })]),
      ] }),
    ])
    expect((await aggregateModels([project]))[0]!.agentType).toBeNull()
    expect((await aggregateModels([project], { byTask: true }))[0]!.agentType).toBeNull()
  })
})

describe('renderTable', () => {
  function visibleWidth(line: string): number {
    return stripAnsi(line).length
  }

  function row(partial: Partial<ModelReportRow>): ModelReportRow {
    return {
      provider: 'claude',
      providerDisplayName: 'Claude',
      model: 'claude-sonnet-4-6',
      modelDisplayName: 'Sonnet 4.6',
      category: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUSD: 0,
      savingsUSD: 0,
      savingsBaselineModel: '',
      calls: 0,
      credits: null,
      ...partial,
    }
  }

  it('blanks repeated provider/model cells in byTask mode but keeps them in default mode', () => {
    const rows: ModelReportRow[] = [
      row({ category: 'feature', costUSD: 7.78, inputTokens: 512_000, outputTokens: 98_000, cacheWriteTokens: 1_400_000, cacheReadTokens: 6_200_000, totalTokens: 8_210_000 }),
      row({ category: 'debugging', costUSD: 5.31, inputTokens: 380_000, outputTokens: 71_000, cacheWriteTokens: 920_000, cacheReadTokens: 4_100_000, totalTokens: 5_471_000 }),
    ]
    const out = renderTable(rows, { byTask: true, showTotals: false, terminalWidth: 200 })
    const lines = out.split('\n')
    // Layout: top border, header, header-separator, data..., bottom border.
    const dataLines = lines.slice(3, -1)
    expect(dataLines[0]).toContain('Sonnet 4.6')
    expect(dataLines[0]).toContain('Feature Dev')
    expect(dataLines[1]).not.toContain('Sonnet 4.6')
    expect(dataLines[1]).not.toContain('Claude')
    expect(dataLines[1]).toContain('Debugging')
  })

  it('renders an Agent column and blanks repeated provider/model in byAgent mode', () => {
    const rows: ModelReportRow[] = [
      row({ agentType: 'planner', costUSD: 6.0, inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
      row({ agentType: 'reviewer', costUSD: 3.0, inputTokens: 40, outputTokens: 8, totalTokens: 48 }),
    ]
    const out = renderTable(rows, { byAgent: true, showTotals: false, terminalWidth: 200 })
    expect(out).toContain('Agent')
    const dataLines = out.split('\n').slice(3, -1)
    expect(dataLines[0]).toContain('Sonnet 4.6')
    expect(dataLines[0]).toContain('planner')
    // same (provider, model) group -> model/provider blanked, agent still shown
    expect(dataLines[1]).not.toContain('Sonnet 4.6')
    expect(dataLines[1]).not.toContain('Claude')
    expect(dataLines[1]).toContain('reviewer')
  })

  it('keeps provider/model cells on every row in default mode', () => {
    const rows: ModelReportRow[] = [
      row({ topCategory: 'feature', topCategoryShare: 0.6, costUSD: 5.0 }),
      row({ provider: 'codex', providerDisplayName: 'Codex', model: 'gpt-5', modelDisplayName: 'GPT-5', topCategory: 'debugging', topCategoryShare: 0.4, costUSD: 1.2 }),
    ]
    const out = renderTable(rows, { byTask: false, showTotals: false, terminalWidth: 200 })
    const dataLines = out.split('\n').slice(3, -1)
    expect(dataLines[0]).toContain('Sonnet 4.6')
    expect(dataLines[1]).toContain('GPT-5')
  })

  it('drops cache columns when terminal is narrow', () => {
    const rows: ModelReportRow[] = [row({ topCategory: 'feature', topCategoryShare: 1, costUSD: 1 })]
    const wide = renderTable(rows, { showTotals: false, terminalWidth: 200 })
    const narrow = renderTable(rows, { showTotals: false, terminalWidth: 80 })
    expect(wide).toContain('Cache Write')
    expect(narrow).not.toContain('Cache Write')
    expect(narrow).not.toContain('Cache Read')
  })

  it('expands table borders to the available terminal width by default', () => {
    const rows: ModelReportRow[] = [
      row({ category: 'coding', costUSD: 1.0, inputTokens: 46_300, outputTokens: 3_700_000, cacheWriteTokens: 16_300_000, cacheReadTokens: 1_569_800_000, totalTokens: 1_589_800_000 }),
      row({ category: 'delegation', costUSD: 0.5, inputTokens: 44_200, outputTokens: 1_900_000, cacheWriteTokens: 9_400_000, cacheReadTokens: 499_600_000, totalTokens: 511_000_000 }),
    ]
    const out = renderTable(rows, { byTask: true, showTotals: false, terminalWidth: 132 })
    const lines = out.split('\n')
    expect(visibleWidth(lines[0]!)).toBe(132)
    expect(visibleWidth(lines[1]!)).toBe(132)
    expect(visibleWidth(lines.at(-1)!)).toBe(132)
  })

  it('keeps every colored table row aligned to the same visible width', () => {
    const originalLevel = chalk.level
    chalk.level = 1
    try {
      const rows: ModelReportRow[] = [
        row({ category: 'coding', costUSD: 978.89, inputTokens: 46_300, outputTokens: 3_700_000, cacheWriteTokens: 16_300_000, cacheReadTokens: 1_569_800_000, totalTokens: 1_589_800_000 }),
        row({ category: 'delegation', costUSD: 357.0, inputTokens: 44_200, outputTokens: 1_900_000, cacheWriteTokens: 9_400_000, cacheReadTokens: 499_600_000, totalTokens: 511_000_000 }),
        row({ category: 'exploration', costUSD: 324.86, inputTokens: 96_800, outputTokens: 1_600_000, cacheWriteTokens: 16_600_000, cacheReadTokens: 359_400_000, totalTokens: 377_800_000 }),
      ]
      const out = renderTable(rows, { byTask: true, terminalWidth: 160 })
      const widths = out.split('\n').map(visibleWidth)
      expect(new Set(widths)).toEqual(new Set([160]))
    } finally {
      chalk.level = originalLevel
    }
  })

  it('can render compact tables when fullWidth is disabled', () => {
    const rows: ModelReportRow[] = [
      row({ category: 'coding', costUSD: 1.0, inputTokens: 46_300, outputTokens: 3_700_000, totalTokens: 1_589_800_000 }),
    ]
    const out = renderTable(rows, { byTask: true, showTotals: false, terminalWidth: 160, fullWidth: false })
    expect(visibleWidth(out.split('\n')[0]!)).toBeLessThan(160)
  })

  it('emits a footer totals row by default and suppresses it under showTotals=false', () => {
    const rows: ModelReportRow[] = [row({ costUSD: 1.0, inputTokens: 100, totalTokens: 100 })]
    expect(renderTable(rows, { showTotals: true })).toContain('Total')
    expect(renderTable(rows, { showTotals: false })).not.toMatch(/^\s*Total/m)
  })
})

describe('renderMarkdown', () => {
  it('produces a GitHub-flavored markdown table with right-aligned numeric columns', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        model: 'claude-sonnet-4-6',
        modelDisplayName: 'Sonnet 4.6',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 0.6,
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 1.5,
        calls: 1,
      },
    ]
    const md = renderMarkdown(rows, { showTotals: false })
    const lines = md.split('\n')
    expect(lines[0]).toBe('| Provider | Model | Top Task | Input | Output | Cache Write | Cache Read | Total | Cost | Saved |')
    expect(lines[1]).toBe('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    expect(lines[2]).toContain('| Claude |')
    expect(lines[2]).toContain('`Sonnet 4.6`')
    expect(lines[2]).toContain('Feature Dev (60%)')
  })

  it('uses an Agent header and the agent value in byAgent mode', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        model: 'claude-opus-4-8',
        modelDisplayName: 'Opus 4.8',
        category: null,
        agentType: 'planner',
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 6.0,
        calls: 1,
      },
    ]
    const md = renderMarkdown(rows, { byAgent: true, showTotals: false })
    const lines = md.split('\n')
    expect(lines[0]).toBe('| Provider | Model | Agent | Input | Output | Cache Write | Cache Read | Total | Cost | Saved |')
    expect(lines[2]).toContain('| planner |')
  })

  it('escapes pipe characters in provider/model names', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'odd',
        providerDisplayName: 'A|B',
        model: 'm|n',
        modelDisplayName: 'M|N',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        calls: 0,
      },
    ]
    const md = renderMarkdown(rows, { showTotals: false })
    expect(md).toContain('A\\|B')
    expect(md).toContain('M\\|N')
  })

  it('emits a bold totals row when showTotals is true', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'p',
        providerDisplayName: 'P',
        model: 'm',
        modelDisplayName: 'M',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 1.5,
        calls: 1,
      },
    ]
    const md = renderMarkdown(rows)
    expect(md).toContain('**Total**')
  })
})

describe('renderJson', () => {
  it('emits a JSON array with the documented field shape', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        model: 'claude-sonnet-4-6',
        modelDisplayName: 'Sonnet 4.6',
        category: null,
        topCategory: 'feature',
        topCategoryCost: 6.0,
        topCategoryShare: 0.6,
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 1.5,
        calls: 1,
      },
    ]
    const parsed = JSON.parse(renderJson(rows)) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      modelDisplayName: 'Sonnet 4.6',
      topCategory: 'feature',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      calls: 1,
    })
    // agentType is null outside byAgent mode
    expect(parsed[0]!['agentType']).toBeNull()
  })

  it('emits the agentType field in byAgent rows', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        model: 'claude-opus-4-8',
        modelDisplayName: 'Opus 4.8',
        category: null,
        agentType: 'planner',
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 6.0,
        calls: 1,
      },
    ]
    const parsed = JSON.parse(renderJson(rows)) as Array<Record<string, unknown>>
    expect(parsed[0]!['agentType']).toBe('planner')
  })
})

describe('renderCsv', () => {
  it('produces a header row followed by one row per ModelReportRow', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        model: 'claude-sonnet-4-6',
        modelDisplayName: 'Sonnet 4.6',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 0.6,
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 1.5,
        savingsUSD: 0,
        calls: 1,
      },
    ]
    const csv = renderCsv(rows)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('provider,model,top_task,top_task_share,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,total_tokens,calls,cost_usd,savings_usd,savings_baseline_model')
    expect(lines[1]).toBe('Claude,Sonnet 4.6,Feature Dev,0.6000,100,50,0,0,150,1,1.500000,0.000000,')
  })

  it('emits an agent column in byAgent mode', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        model: 'claude-opus-4-8',
        modelDisplayName: 'Opus 4.8',
        category: null,
        agentType: 'planner',
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 150,
        costUSD: 6.0,
        savingsUSD: 0,
        savingsBaselineModel: '',
        calls: 1,
      },
    ]
    const csv = renderCsv(rows, { byAgent: true })
    const lines = csv.split('\n')
    expect(lines[0]).toBe('provider,model,agent,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,total_tokens,calls,cost_usd,savings_usd,savings_baseline_model')
    expect(lines[1]).toBe('Claude,Opus 4.8,planner,100,50,0,0,150,1,6.000000,0.000000,')
  })

  it('escapes commas in provider/model cells', () => {
    const rows: ModelReportRow[] = [
      {
        provider: 'weird',
        providerDisplayName: 'Weird, Co.',
        model: 'm',
        modelDisplayName: 'M',
        category: null,
        topCategory: 'feature',
        topCategoryShare: 1.0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        savingsUSD: 0,
        calls: 0,
      },
    ]
    const csv = renderCsv(rows)
    expect(csv.split('\n')[1]).toContain('"Weird, Co."')
  })
})

describe('models CLI breakdown flags', () => {
  vi.setConfig({ testTimeout: 30_000 })

  it('filters the models report to unpriced rows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-models-unpriced-'))
    try {
      const projectDir = join(home, '.claude', 'projects', 'models-unpriced')
      await mkdir(projectDir, { recursive: true })
      await writeFile(join(projectDir, 'session.jsonl'), [
        JSON.stringify({
          type: 'user',
          sessionId: 'models-unpriced-session',
          timestamp: '2026-05-09T00:00:00.000Z',
          cwd: '/tmp/models-unpriced',
          message: { role: 'user', content: 'Use one priced and one unpriced model.' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'models-unpriced-session',
          timestamp: '2026-05-09T00:01:00.000Z',
          cwd: '/tmp/models-unpriced',
          message: {
            id: 'priced',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'priced' }],
            usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'models-unpriced-session',
          timestamp: '2026-05-09T00:02:00.000Z',
          cwd: '/tmp/models-unpriced',
          message: {
            id: 'unpriced',
            type: 'message',
            role: 'assistant',
            model: 'zz-unpriced-frontier-model',
            content: [{ type: 'text', text: 'unpriced' }],
            usage: { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
      ].join('\n') + '\n')

      const res = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'models', '--unpriced', '--from', '2026-05-09', '--to', '2026-05-09', '--provider', 'claude', '--format', 'json'],
        { cwd: process.cwd(), env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'), TZ: 'UTC' }, encoding: 'utf-8', timeout: 30_000 },
      )

      expect(res.status, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0)
      const rows = JSON.parse(res.stdout) as Array<{ model: string; calls: number }>
      expect(rows.map(row => row.model)).toEqual(['zz-unpriced-frontier-model'])
      expect(rows[0]?.calls).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  // Unpriced rows all sort at $0 in aggregateModels, so the old implementation
  // preserved transcript/Map order instead of findUnpricedModels' token order.
  it('keeps unpriced rows when --unpriced is combined with --top', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-models-unpriced-top-'))
    try {
      const projectDir = join(home, '.claude', 'projects', 'models-unpriced-top')
      await mkdir(projectDir, { recursive: true })
      const assistant = (id: string, model: string, timestamp: string, input: number) => JSON.stringify({
        type: 'assistant',
        sessionId: 'models-unpriced-top-session',
        timestamp,
        cwd: '/tmp/models-unpriced-top',
        message: {
          id, type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: id }],
          usage: { input_tokens: input, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      })
      await writeFile(join(projectDir, 'session.jsonl'), [
        JSON.stringify({
          type: 'user',
          sessionId: 'models-unpriced-top-session',
          timestamp: '2026-05-09T00:00:00.000Z',
          cwd: '/tmp/models-unpriced-top',
          message: { role: 'user', content: 'Three unpriced models arrive small-first.' },
        }),
        // Transcript order is deliberately different from token order:
        // 1.1k, 9.1k, 5.1k total tokens. The two largest must survive --top 2.
        assistant('small', 'zz-unpriced-small', '2026-05-09T00:01:00.000Z', 1000),
        assistant('largest', 'zz-unpriced-largest', '2026-05-09T00:02:00.000Z', 9000),
        assistant('middle', 'zz-unpriced-middle', '2026-05-09T00:03:00.000Z', 5000),
      ].join('\n') + '\n')

      const res = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'models', '--unpriced', '--top', '2', '--from', '2026-05-09', '--to', '2026-05-09', '--provider', 'claude', '--format', 'json'],
        { cwd: process.cwd(), env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'), TZ: 'UTC' }, encoding: 'utf-8', timeout: 30_000 },
      )

      expect(res.status, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0)
      const rows = JSON.parse(res.stdout) as Array<{ model: string }>
      expect(rows).toHaveLength(2)
      expect(rows.map(row => row.model)).toEqual(['zz-unpriced-largest', 'zz-unpriced-middle'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects --by-task and --by-agent together with a clear error and exit 1', () => {
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'models', '--by-agent', '--by-task', '-p', 'today'],
      { cwd: process.cwd(), env: { ...process.env, TZ: 'UTC' }, encoding: 'utf-8', timeout: 30_000 },
    )
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('--by-task and --by-agent cannot be combined')
  })
})
