import { describe, expect, it } from 'vitest'

import {
  aggregateByPr,
  attributeSessionPrSpend,
  buildSubagentIndex,
  prLinkedTotals,
  resolveChildFolds,
} from '../src/sessions-report.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary, TokenUsage } from '../src/types.js'

const A = 'https://github.com/o/r/pull/1'
const B = 'https://github.com/o/r/pull/2'

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
}

let seq = 0
function call(cost: number, model: string, ts: string): ParsedApiCall {
  return {
    provider: 'claude', model, usage: ZERO_USAGE, costUSD: cost,
    tools: [], mcpTools: [], skills: [], subagentTypes: [],
    hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
    timestamp: ts, bashCommands: [], deduplicationKey: `k${seq++}`,
  }
}

// A parent turn: one call of `cost` under `model`, at `ts`, optionally carrying
// `prRefs` and the `spawnToolUseIds` of subagents launched in the turn.
function turn(opts: {
  cost: number; model?: string; ts: string; category?: ClassifiedTurn['category']
  prRefs?: string[]; spawnToolUseIds?: string[]
}): ClassifiedTurn {
  return {
    userMessage: '', timestamp: opts.ts, sessionId: 's',
    category: opts.category ?? 'coding', retries: 0, hasEdits: false,
    assistantCalls: [call(opts.cost, opts.model ?? 'claude-sonnet-4-5', opts.ts)],
    ...(opts.prRefs ? { prRefs: opts.prRefs } : {}),
    ...(opts.spawnToolUseIds ? { spawnToolUseIds: opts.spawnToolUseIds } : {}),
  }
}

function parent(opts: {
  id: string; prLinks: string[]; turns: ClassifiedTurn[]
  agentSpawnLinks?: Record<string, string>; project?: string
}): SessionSummary {
  return {
    sessionId: opts.id, project: opts.project ?? 'p',
    firstTimestamp: '2026-07-01T10:00:00Z', lastTimestamp: '2026-07-01T12:00:00Z',
    totalCostUSD: 0, totalSavingsUSD: 0, totalEstimatedCostUSD: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
    totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    apiCalls: opts.turns.reduce((n, t) => n + t.assistantCalls.length, 0),
    turns: opts.turns,
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {} as SessionSummary['skillBreakdown'],
    subagentBreakdown: {} as SessionSummary['subagentBreakdown'],
    prLinks: opts.prLinks,
    ...(opts.agentSpawnLinks ? { agentSpawnLinks: opts.agentSpawnLinks } : {}),
  }
}

// A sidechain (subagent) session: one turn of `cost` under `model`/`category`,
// linked to `parentId` via `agentId`, first active at `firstTs`.
function child(opts: {
  agentId: string; parentId: string; cost: number; model?: string
  category?: ClassifiedTurn['category']; firstTs: string; project?: string; calls?: number
}): SessionSummary {
  const n = opts.calls ?? 1
  const t: ClassifiedTurn = {
    userMessage: '', timestamp: opts.firstTs, sessionId: `agent-${opts.agentId}`,
    category: opts.category ?? 'debugging', retries: 0, hasEdits: false,
    assistantCalls: Array.from({ length: n }, () => call(opts.cost / n, opts.model ?? 'claude-opus-4-8', opts.firstTs)),
  }
  return {
    sessionId: `agent-${opts.agentId}`, project: opts.project ?? 'p',
    parentSessionId: opts.parentId, agentId: opts.agentId,
    firstTimestamp: opts.firstTs, lastTimestamp: opts.firstTs,
    totalCostUSD: opts.cost, totalSavingsUSD: 0, totalEstimatedCostUSD: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
    totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    apiCalls: n, turns: [t],
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {} as SessionSummary['skillBreakdown'],
    subagentBreakdown: {} as SessionSummary['subagentBreakdown'],
  }
}

function project(sessions: SessionSummary[], name = 'p'): ProjectSummary {
  return { project: name, projectPath: `/${name}`, sessions, totalCostUSD: 0, totalSavingsUSD: 0, totalApiCalls: 0, totalProxiedCostUSD: 0 }
}

describe('buildSubagentIndex', () => {
  it('indexes sidechains by project + parentSessionId; skips non-children', () => {
    const idx = buildSubagentIndex([project([
      parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })] }),
      child({ agentId: 'c1', parentId: 'P', cost: 50, firstTs: '2026-07-01T10:05:00Z' }),
      child({ agentId: 'c2', parentId: 'P', cost: 30, firstTs: '2026-07-01T10:06:00Z' }),
    ])])
    expect(idx.size).toBe(1) // one parent key
    expect([...idx.values()].flat().map(c => c.agentId).sort()).toEqual(['c1', 'c2'])
  })
})

describe('resolveChildFolds', () => {
  const p = parent({
    id: 'P', prLinks: [A, B],
    turns: [
      turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A], spawnToolUseIds: ['toolu_x'] }),
      turn({ cost: 10, ts: '2026-07-01T10:30:00Z', prRefs: [B] }),
    ],
    agentSpawnLinks: { c1: 'toolu_x' },
  })

  it('resolves via spawn tool_use id (true launch point)', () => {
    const c = child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:45:00Z' })
    const folds = resolveChildFolds(p, [buildFold(c)])
    // firstTs 10:45 sits in turn1's span, but the spawn id lives in turn0 -> turn0 wins.
    expect(folds.byTurnIndex.get(0)?.[0]?.agentId).toBe('c1')
    expect(folds.byTurnIndex.has(1)).toBe(false)
    expect(folds.unlinked).toHaveLength(0)
  })

  it('falls back to timestamp bucketing when there is no spawn link', () => {
    const c = child({ agentId: 'unknown', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:45:00Z' })
    const folds = resolveChildFolds(p, [buildFold(c)])
    // No agentSpawnLinks entry -> bucket by firstTs 10:45 into the last turn started <= it.
    expect(folds.byTurnIndex.get(1)?.[0]?.agentId).toBe('unknown')
    expect(folds.byTurnIndex.has(0)).toBe(false)
  })

  it('marks a child before the first turn as unlinked', () => {
    const c = child({ agentId: 'early', parentId: 'P', cost: 100, firstTs: '2026-07-01T09:00:00Z' })
    const folds = resolveChildFolds(p, [buildFold(c)])
    expect(folds.byTurnIndex.size).toBe(0)
    expect(folds.unlinked.map(f => f.agentId)).toEqual(['early'])
  })
})

// Round-trip a child SessionSummary through the public index so tests exercise the
// same ChildFold the report builds (agentId/cost/models/categories derivation).
function buildFold(c: SessionSummary) {
  return [...buildSubagentIndex([project([c])]).values()][0]![0]!
}

describe('attributeSessionPrSpend with folds', () => {
  it('folds a child into its spawn turn and surfaces its model in that PR', () => {
    const p = parent({
      id: 'P', prLinks: [A, B],
      turns: [
        turn({ cost: 10, model: 'claude-sonnet-4-5', ts: '2026-07-01T10:00:00Z', prRefs: [A], spawnToolUseIds: ['toolu_x'] }),
        turn({ cost: 10, model: 'claude-sonnet-4-5', ts: '2026-07-01T10:30:00Z', prRefs: [B] }),
      ],
      agentSpawnLinks: { c1: 'toolu_x' },
    })
    const c = buildFold(child({ agentId: 'c1', parentId: 'P', cost: 100, model: 'claude-opus-4-8', category: 'debugging', firstTs: '2026-07-01T10:45:00Z' }))
    const folds = resolveChildFolds(p, [c])
    const { perUrl } = attributeSessionPrSpend(p, folds)
    // A owns turn0's own $10 plus the child's $100.
    expect(perUrl.get(A)!.cost).toBeCloseTo(110, 6)
    expect(perUrl.get(B)!.cost).toBeCloseTo(10, 6)
    // The child's opus spend reaches PR A's model + category breakdown.
    expect(perUrl.get(A)!.models.get('claude-opus-4-8')).toBeCloseTo(100, 6)
    expect(perUrl.get(A)!.categories.get('debugging')).toBeCloseTo(100, 6)
    expect(perUrl.get(A)!.categories.get('coding')).toBeCloseTo(10, 6)
  })

  it('lands a child spawned before any PR reference in unattributed', () => {
    const p = parent({
      id: 'P', prLinks: [A],
      turns: [
        // turn0 references no PR (current === null); a child folded here is overhead.
        turn({ cost: 5, ts: '2026-07-01T10:00:00Z', spawnToolUseIds: ['toolu_pre'] }),
        turn({ cost: 10, ts: '2026-07-01T10:30:00Z', prRefs: [A] }),
      ],
      agentSpawnLinks: { c1: 'toolu_pre' },
    })
    const c = buildFold(child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z' }))
    const { perUrl, unattributed } = attributeSessionPrSpend(p, resolveChildFolds(p, [c]))
    expect(perUrl.get(A)!.cost).toBeCloseTo(10, 6)
    expect(unattributed.cost).toBeCloseTo(105, 6) // turn0's $5 + child $100
  })

  it('folds an unlinked child into unattributed', () => {
    const p = parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })] })
    const c = buildFold(child({ agentId: 'orphanTurn', parentId: 'P', cost: 40, firstTs: '2026-07-01T09:00:00Z' }))
    const { perUrl, unattributed } = attributeSessionPrSpend(p, resolveChildFolds(p, [c]))
    expect(perUrl.get(A)!.cost).toBeCloseTo(10, 6)
    expect(unattributed.cost).toBeCloseTo(40, 6)
  })

  it('is a no-op when no folds are supplied (regression guard)', () => {
    const p = parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })] })
    const { perUrl, unattributed } = attributeSessionPrSpend(p)
    expect(perUrl.get(A)!.cost).toBeCloseTo(10, 6)
    expect(unattributed.cost).toBe(0)
  })
})

describe('aggregateByPr / prLinkedTotals fold subagents end to end', () => {
  const projects = () => [project([
    parent({
      id: 'P', prLinks: [A],
      turns: [turn({ cost: 20, model: 'claude-sonnet-4-5', ts: '2026-07-01T10:00:00Z', prRefs: [A], spawnToolUseIds: ['toolu_x'] })],
      agentSpawnLinks: { c1: 'toolu_x' },
    }),
    child({ agentId: 'c1', parentId: 'P', cost: 100, model: 'claude-opus-4-8', firstTs: '2026-07-01T10:05:00Z', calls: 5 }),
  ])]

  it('counts the child cost exactly once in by-PR while it stays a standalone session', () => {
    const rows = aggregateByPr(projects())
    const rowA = rows.find(r => r.url === A)!
    expect(rowA.cost).toBeCloseTo(120, 6) // parent $20 + child $100, once
    expect(rowA.calls).toBe(6)            // parent 1 + child 5
    expect(rowA.models).toContain('Opus 4.8') // short name of claude-opus appears beside the parent model
    // The child is still present as its own session (not removed from projects).
    expect(projects()[0]!.sessions.some(s => s.sessionId === 'agent-c1')).toBe(true)
  })

  it('reports subagentSessions alongside PR-linked parent sessions', () => {
    const totals = prLinkedTotals(projects())
    expect(totals.sessions).toBe(1)          // one PR-linked parent
    expect(totals.subagentSessions).toBe(1)  // one folded child
    expect(totals.attributedCost).toBeCloseTo(120, 6)
    expect(totals.cost).toBeCloseTo(120, 6)
  })

  it('ignores an orphan child whose parent is absent from the scan', () => {
    const rows = aggregateByPr([project([
      // No parent 'P' here; the child references a parent that is not in the scan.
      child({ agentId: 'c1', parentId: 'MISSING', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
    ])])
    // Nothing PR-linked, so no rows and no folded spend.
    expect(rows).toHaveLength(0)
    const totals = prLinkedTotals([project([
      child({ agentId: 'c1', parentId: 'MISSING', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
    ])])
    expect(totals.subagentSessions).toBe(0)
    expect(totals.cost).toBe(0)
  })

  it('does not fold children of a parent that referenced no PR', () => {
    const rows = aggregateByPr([project([
      // Parent has turns but NO prLinks -> skipped entirely; its child folds nowhere.
      parent({ id: 'Q', prLinks: [], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z' })] }),
      child({ agentId: 'c9', parentId: 'Q', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
    ])])
    expect(rows).toHaveLength(0)
  })
})
