import { describe, expect, it } from 'vitest'

import {
  aggregateByPr,
  buildSubagentIndex,
  prLinkedTotals,
  resolveSubagentAttribution,
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

function turn(opts: { cost: number; model?: string; ts: string; prRefs?: string[]; category?: ClassifiedTurn['category'] }): ClassifiedTurn {
  return {
    userMessage: '', timestamp: opts.ts, sessionId: 's',
    category: opts.category ?? 'coding', retries: 0, hasEdits: false,
    assistantCalls: [call(opts.cost, opts.model ?? 'claude-sonnet-4-5', opts.ts)],
    ...(opts.prRefs ? { prRefs: opts.prRefs } : {}),
  }
}

const BASE = {
  totalSavingsUSD: 0, totalEstimatedCostUSD: 0,
  totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
  totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
  modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
  categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
  skillBreakdown: {} as SessionSummary['skillBreakdown'],
  subagentBreakdown: {} as SessionSummary['subagentBreakdown'],
}

function parent(opts: {
  id: string; prLinks: string[]; turns: ClassifiedTurn[]; project?: string
  agentSpawnLinks?: Record<string, string>; spawnPrSets?: Record<string, string[]>
  prRefsAtRangeStart?: string[]; first?: string; last?: string; ambiguousSpawnAgentIds?: string[]
}): SessionSummary {
  return {
    ...BASE,
    sessionId: opts.id, project: opts.project ?? 'p',
    firstTimestamp: opts.first ?? '2026-07-01T10:00:00Z', lastTimestamp: opts.last ?? '2026-07-01T12:00:00Z',
    totalCostUSD: opts.turns.reduce((n, t) => n + t.assistantCalls.reduce((s, c) => s + c.costUSD, 0), 0),
    apiCalls: opts.turns.reduce((n, t) => n + t.assistantCalls.length, 0),
    turns: opts.turns, prLinks: opts.prLinks,
    ...(opts.agentSpawnLinks ? { agentSpawnLinks: opts.agentSpawnLinks } : {}),
    ...(opts.spawnPrSets ? { spawnPrSets: opts.spawnPrSets } : {}),
    ...(opts.prRefsAtRangeStart ? { prRefsAtRangeStart: opts.prRefsAtRangeStart } : {}),
    ...(opts.ambiguousSpawnAgentIds ? { ambiguousSpawnAgentIds: opts.ambiguousSpawnAgentIds } : {}),
  }
}

function child(opts: {
  agentId: string; parentId: string; cost: number; model?: string
  category?: ClassifiedTurn['category']; firstTs: string; last?: string
  project?: string; calls?: number; prLinks?: string[]
}): SessionSummary {
  const n = opts.calls ?? 1
  const t: ClassifiedTurn = {
    userMessage: '', timestamp: opts.firstTs, sessionId: `agent-${opts.agentId}`,
    category: opts.category ?? 'debugging', retries: 0, hasEdits: false,
    assistantCalls: Array.from({ length: n }, () => call(opts.cost / n, opts.model ?? 'claude-opus-4-8', opts.firstTs)),
    ...(opts.prLinks ? { prRefs: opts.prLinks } : {}),
  }
  return {
    ...BASE,
    sessionId: `agent-${opts.agentId}`, project: opts.project ?? 'p',
    parentSessionId: opts.parentId, agentId: opts.agentId,
    firstTimestamp: opts.firstTs, lastTimestamp: opts.last ?? opts.firstTs,
    totalCostUSD: opts.cost, apiCalls: n, turns: [t],
    ...(opts.prLinks ? { prLinks: opts.prLinks } : {}),
  }
}

function project(sessions: SessionSummary[], name = 'p', anchors?: SessionSummary[]): ProjectSummary {
  return { project: name, projectPath: `/${name}`, sessions, totalCostUSD: 0, totalSavingsUSD: 0, totalApiCalls: 0, totalProxiedCostUSD: 0, ...(anchors ? { subagentAnchors: anchors } : {}) }
}

function rowFor(rows: ReturnType<typeof aggregateByPr>, url: string) {
  return rows.find(r => r.url === url)
}

// Sum of the standalone cost of every subagent session, for the double-count check.
function subagentCostTotal(projects: ProjectSummary[]): number {
  let t = 0
  for (const p of projects) for (const s of p.sessions) if (s.parentSessionId) t += s.totalCostUSD
  return t
}

describe('buildSubagentIndex', () => {
  it('keys children by parentSessionId alone (global, cross-project)', () => {
    const idx = buildSubagentIndex([
      project([parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })] })], 'projA'),
      // Child lives in a DIFFERENT project than its parent (worktree cwd resolved elsewhere).
      project([child({ agentId: 'c1', parentId: 'P', cost: 50, firstTs: '2026-07-01T10:05:00Z', project: 'projB' })], 'projB'),
    ])
    // One key (parentSessionId, provider-prefixed), holding the single child.
    expect(idx.size).toBe(1)
    expect([...idx.values()].flat().map(s => s.agentId)).toEqual(['c1'])
  })
})

describe('spawn-link resolution (async edge: spawn PR wins over first-timestamp)', () => {
  const projects = () => [project([
    parent({
      id: 'P', prLinks: [A, B],
      // Turn 0 works on A and spawns the child; turn 1 works on B. The child's
      // first activity lands during turn 1, but the spawn happened under A.
      turns: [
        turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] }),
        turn({ cost: 10, ts: '2026-07-01T10:30:00Z', prRefs: [B] }),
      ],
      agentSpawnLinks: { c1: 'toolu_x' },
      spawnPrSets: { toolu_x: [A] },
    }),
    child({ agentId: 'c1', parentId: 'P', cost: 100, model: 'claude-opus-4-8', firstTs: '2026-07-01T10:45:00Z' }),
  ])]

  it('folds the child under the spawn PR (A), not the first-timestamp PR (B)', () => {
    const rows = aggregateByPr(projects())
    expect(rowFor(rows, A)!.cost).toBeCloseTo(110, 6) // turn A ($10) + child ($100)
    expect(rowFor(rows, B)!.cost).toBeCloseTo(10, 6)
    expect(rowFor(rows, A)!.models).toContain('Opus 4.8')
  })

  it('counts the child once and keeps it a standalone session', () => {
    const p = projects()
    const totals = prLinkedTotals(p)
    expect(totals.subagentSessions).toBe(1)
    expect(totals.attributedCost).toBeCloseTo(120, 6)
    // No double-count: folded total minus the child's own cost equals the parents' own spend.
    expect(totals.cost - subagentCostTotal(p)).toBeCloseTo(20, 6)
    expect(p[0]!.sessions.some(s => s.sessionId === 'agent-c1')).toBe(true)
  })
})

describe('CRITICAL: a self-linking child is NOT folded (mutual exclusion, no double-charge)', () => {
  it('a child with its own prLinks attributes standalone only', () => {
    const projects = [project([
      parent({
        id: 'P', prLinks: [A],
        turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })],
        agentSpawnLinks: { c1: 'toolu_x' }, spawnPrSets: { toolu_x: [A] },
      }),
      // The child references its OWN PR (B). It must attribute standalone to B and
      // NOT also fold into the parent's A -- that would double-charge it.
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z', prLinks: [B] }),
    ])]
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(10, 6)   // parent only, child NOT folded here
    expect(rowFor(rows, B)!.cost).toBeCloseTo(100, 6)  // child self-attributes to B
    const totals = prLinkedTotals(projects)
    expect(totals.subagentSessions).toBe(0)            // nothing was folded
    // distinctCost / prLinkedTotals consistency: every dollar counted exactly once.
    const rowsSum = rows.reduce((s, r) => s + r.cost, 0)
    expect(rowsSum).toBeCloseTo(totals.attributedCost, 6)
    expect(totals.attributedCost).toBeCloseTo(110, 6)  // 10 + 100, no double
  })

  it('a child with NO links folds only (the complementary direction)', () => {
    const projects = [project([
      parent({
        id: 'P', prLinks: [A],
        turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })],
        agentSpawnLinks: { c1: 'toolu_x' }, spawnPrSets: { toolu_x: [A] },
      }),
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
    ])]
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(110, 6)  // folded
    expect(rowFor(rows, B)).toBeUndefined()
    expect(prLinkedTotals(projects).subagentSessions).toBe(1)
  })
})

describe('MAJOR: nested subagents fold recursively', () => {
  it('parent > child ($100) > grandchild ($50) lands $150 on the parent PR', () => {
    const projects = [project([
      parent({
        id: 'P', prLinks: [A],
        turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })],
        agentSpawnLinks: { c1: 'toolu_x' }, spawnPrSets: { toolu_x: [A] },
      }),
      // Middle child (no PR of its own) spawned the grandchild; grandchild's parent
      // is the middle child, which has no prLinks -> only recursion reaches it.
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
      child({ agentId: 'gc', parentId: 'agent-c1', cost: 50, firstTs: '2026-07-01T10:06:00Z' }),
    ])]
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(160, 6) // 10 + 100 + 50
    const totals = prLinkedTotals(projects)
    expect(totals.subagentSessions).toBe(2)           // child + grandchild
    expect(totals.attributedCost).toBeCloseTo(160, 6)
  })

  it('a self-linking grandchild is excluded from the recursive fold', () => {
    const projects = [project([
      parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })], agentSpawnLinks: { c1: 'toolu_x' }, spawnPrSets: { toolu_x: [A] } }),
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
      child({ agentId: 'gc', parentId: 'agent-c1', cost: 50, firstTs: '2026-07-01T10:06:00Z', prLinks: [B] }),
    ])]
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(110, 6)  // 10 + 100 (grandchild NOT folded)
    expect(rowFor(rows, B)!.cost).toBeCloseTo(50, 6)   // grandchild self-attributes
  })

  it('a cycle in parent links terminates (visited guard)', () => {
    // Two sessions each claim the other as parent; the visited set must break it.
    const a = child({ agentId: 'x', parentId: 'agent-y', cost: 30, firstTs: '2026-07-01T10:06:00Z' })
    const b = child({ agentId: 'y', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z' })
    // Make x's child be y (cycle: y -> x -> y).
    const projects = [project([
      parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })], agentSpawnLinks: { y: 'toolu_x' }, spawnPrSets: { toolu_x: [A] } }),
      b, a,
    ])]
    // y folds into P (100), x folds into y (30); the y<->x cycle must not loop.
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(140, 6) // 10 + 100 + 30, counted once
  })
})

describe('MAJOR: date-range correctness', () => {
  it('(b) a spawn in a pre-range turn resolves to the spawn PR, not an in-range one', () => {
    // The parent's in-range turns only reference B, but the child was spawned in a
    // pre-range turn working on A (captured in spawnPrSets from the full history).
    const projects = [project([
      parent({
        id: 'P', prLinks: [A, B],
        turns: [turn({ cost: 10, ts: '2026-07-20T10:00:00Z', prRefs: [B] })], // only in-range turn
        prRefsAtRangeStart: [B],
        agentSpawnLinks: { c1: 'toolu_pre' }, spawnPrSets: { toolu_pre: [A] },
      }),
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-20T10:05:00Z' }),
    ])]
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(100, 6) // child follows the spawn PR
    expect(rowFor(rows, B)!.cost).toBeCloseTo(10, 6)  // parent's in-range turn only
  })

  it('(a) an in-range child of an anchor parent (no in-range turns) folds, anchor uncounted', () => {
    // The parent is a 0-cost fold ANCHOR: it carries prLinks + spawnPrSets but has
    // no in-range turns, so it lives in subagentAnchors, NOT sessions. Its in-range
    // child must still reach the PR, and the anchor must not inflate session counts.
    const anchor = parent({ id: 'P', prLinks: [A], turns: [], last: '', first: '', agentSpawnLinks: { c1: 'toolu_x' }, spawnPrSets: { toolu_x: [A] } })
    const projects = [project([
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-20T10:05:00Z', last: '2026-07-20T10:30:00Z' }),
    ], 'p', [anchor])]
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(100, 6)
    const totals = prLinkedTotals(projects)
    expect(totals.subagentSessions).toBe(1)
    expect(totals.sessions).toBe(0) // the anchor is NOT counted as a PR-linked session
    // The PR row's date span comes from the CHILD, not the anchor's empty timestamps.
    expect(rowFor(rows, A)!.firstStarted).toBe('2026-07-20T10:05:00Z')
    expect(rowFor(rows, A)!.lastEnded).toBe('2026-07-20T10:30:00Z')
  })
})

describe('MAJOR: timestamp fallback (epoch, end-bounded)', () => {
  it('compares epoch not lexical: a 12:00Z child does NOT fold into a later 15:00Z (UTC) turn', () => {
    // Parent turn at 2026-07-01T10:00:00-05:00 == 15:00Z; child at 12:00Z is BEFORE it.
    const projects = [project([
      parent({
        id: 'P', prLinks: [A], last: '2026-07-01T16:00:00Z',
        turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00-05:00', prRefs: [A] })],
      }),
      // No spawn link -> timestamp fallback. 12:00Z < 15:00Z, so it must NOT land on A.
      child({ agentId: 'early', parentId: 'P', cost: 40, firstTs: '2026-07-01T12:00:00Z' }),
    ])]
    const rows = aggregateByPr(projects)
    // The only turn (A) starts AFTER the child, so nothing carries -> unattributed, no A row from the child.
    expect(rowFor(rows, A)!.cost).toBeCloseTo(10, 6) // parent turn only
    const totals = prLinkedTotals(projects)
    expect(totals.attributedCost).toBeCloseTo(10, 6)
    expect(totals.unattributedCost).toBeCloseTo(40, 6) // child fell before the turn -> unattributed
  })

  it('a child whose spawn link was omitted (ambiguous pairing) still folds via timestamp', () => {
    // The parent has NO agentSpawnLinks entry for this child (the spawn-result
    // pairing was ambiguous and omitted). The child must still fold via the
    // timestamp bucket, not disappear.
    const projects = [project([
      parent({ id: 'P', prLinks: [A], last: '2026-07-01T12:00:00Z', turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })] }),
      child({ agentId: 'noLink', parentId: 'P', cost: 40, firstTs: '2026-07-01T10:30:00Z' }),
    ])]
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(50, 6) // 10 parent + 40 child via timestamp bucket
    expect(prLinkedTotals(projects).subagentSessions).toBe(1)
  })

  it('a child active after the parent last timestamp is UNLINKED (contributes nothing)', () => {
    const projects = [project([
      parent({
        id: 'P', prLinks: [A], last: '2026-07-01T11:00:00Z',
        turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })],
      }),
      // No spawn link, and first activity is AFTER the parent's last timestamp.
      child({ agentId: 'late', parentId: 'P', cost: 40, firstTs: '2026-07-01T23:00:00Z' }),
    ])]
    const totals = prLinkedTotals(projects)
    expect(totals.subagentSessions).toBe(0)             // unlinked -> not counted
    expect(totals.attributedCost).toBeCloseTo(10, 6)
    expect(totals.unattributedCost).toBeCloseTo(0, 6)   // contributes nothing at all
  })
})

describe('orphans and non-PR parents contribute nothing', () => {
  it('an orphan child whose parent is absent from the scan is ignored', () => {
    const projects = [project([child({ agentId: 'c1', parentId: 'MISSING', cost: 100, firstTs: '2026-07-01T10:05:00Z' })])]
    expect(aggregateByPr(projects)).toHaveLength(0)
    expect(prLinkedTotals(projects).subagentSessions).toBe(0)
  })

  it('a child of a parent that referenced no PR is not folded', () => {
    const projects = [project([
      parent({ id: 'Q', prLinks: [], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z' })] }),
      child({ agentId: 'c9', parentId: 'Q', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
    ])]
    expect(aggregateByPr(projects)).toHaveLength(0)
    expect(prLinkedTotals(projects).subagentSessions).toBe(0)
  })
})

describe('resolveSubagentAttribution', () => {
  it('resolves each PR-bearing parent to its resolved children', () => {
    const projects = [project([
      parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })], agentSpawnLinks: { c1: 'toolu_x' }, spawnPrSets: { toolu_x: [A] } }),
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
    ])]
    const resolved = [...resolveSubagentAttribution(projects).values()]
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!).toHaveLength(1)
    expect(resolved[0]![0]!.prSet).toEqual([A])
    expect(resolved[0]![0]!.fold.cost).toBe(100)
  })
})

describe('MAJOR: id-collision contamination', () => {
  it('folds a child into NEITHER of two distinct parents that share a session id', () => {
    // Two DISTINCT parent sessions both have id "P" (duplicate/imported data). A
    // child pointing at "P" is ambiguous: it must fold nowhere and stay standalone,
    // while both parents attribute their OWN spend only.
    const projects = [project([
      parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })], agentSpawnLinks: { c1: 'toolu_x' }, spawnPrSets: { toolu_x: [A] } }),
      parent({ id: 'P', prLinks: [B], turns: [turn({ cost: 20, ts: '2026-07-01T11:00:00Z', prRefs: [B] })], agentSpawnLinks: { c1: 'toolu_y' }, spawnPrSets: { toolu_y: [B] } }),
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
    ])]
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(10, 6)   // parent 1 own spend only
    expect(rowFor(rows, B)!.cost).toBeCloseTo(20, 6)   // parent 2 own spend only
    const totals = prLinkedTotals(projects)
    expect(totals.subagentSessions).toBe(0)            // the ambiguous child folds nowhere
    expect(totals.attributedCost).toBeCloseTo(30, 6)   // no child double-charge
  })

  it('folds nowhere when a PR-bearing parent shares its id with a PR-LESS parent', () => {
    // Only ONE of the two colliding parents has prLinks, but the identity is still
    // ambiguous: count ALL candidates, not just PR-bearing ones.
    const projects = [project([
      parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })], agentSpawnLinks: { c1: 'toolu_x' }, spawnPrSets: { toolu_x: [A] } }),
      // A PR-less session that happens to share id "P" (imported/duplicate data).
      parent({ id: 'P', prLinks: [], turns: [turn({ cost: 20, ts: '2026-07-01T11:00:00Z' })] }),
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
    ])]
    const rows = aggregateByPr(projects)
    expect(rowFor(rows, A)!.cost).toBeCloseTo(10, 6)   // parent own spend; child NOT folded
    expect(prLinkedTotals(projects).subagentSessions).toBe(0)
  })
})

describe('MAJOR: ambiguous pairing + late child grace window', () => {
  const makeProjects = (childFirstTs: string) => [project([
    // No spawn link for c1, but the parent recorded it as an AMBIGUOUS pairing.
    parent({
      id: 'P', prLinks: [A], last: '2026-07-01T11:00:00Z',
      turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })],
      ambiguousSpawnAgentIds: ['c1'],
    }),
    child({ agentId: 'c1', parentId: 'P', cost: 40, firstTs: childFirstTs }),
  ])]

  it('folds a within-grace late child to the last turn', () => {
    // Child starts 20 min after the parent's last timestamp (11:00Z) -> within 30 min.
    const rows = aggregateByPr(makeProjects('2026-07-01T11:20:00Z'))
    expect(rowFor(rows, A)!.cost).toBeCloseTo(50, 6) // 10 parent + 40 child, folded to last turn
    expect(prLinkedTotals(makeProjects('2026-07-01T11:20:00Z')).subagentSessions).toBe(1)
  })

  it('leaves a beyond-grace late child unlinked', () => {
    // Child starts 2 hours after the parent's last timestamp -> beyond the window.
    const totals = prLinkedTotals(makeProjects('2026-07-01T13:00:00Z'))
    expect(totals.subagentSessions).toBe(0)
    expect(totals.attributedCost).toBeCloseTo(10, 6) // parent only; child unlinked
    expect(totals.unattributedCost).toBeCloseTo(0, 6)
  })

  it('does NOT grace a late child whose pairing was merely ABSENT (not ambiguous)', () => {
    // Same timing, but the parent never recorded this agent id -> no grace.
    const projects = [project([
      parent({ id: 'P', prLinks: [A], last: '2026-07-01T11:00:00Z', turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })] }),
      child({ agentId: 'c1', parentId: 'P', cost: 40, firstTs: '2026-07-01T11:20:00Z' }),
    ])]
    expect(prLinkedTotals(projects).subagentSessions).toBe(0)
  })
})

describe('MINOR: row session-key delimiter does not collide on names with spaces', () => {
  it('counts two sessions whose space-joined keys would collide as distinct', () => {
    // "a b" + "c"  and  "a" + "b c"  both become "a b c" under a space delimiter,
    // undercounting the PR row's session count. A NUL delimiter keeps them distinct.
    const s1 = parent({ id: 'c', project: 'a b', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })] })
    const s2 = parent({ id: 'b c', project: 'a', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })] })
    const rows = aggregateByPr([project([s1], 'a b'), project([s2], 'a')])
    expect(rowFor(rows, A)!.sessions).toBe(2)
  })
})

describe('MAJOR: recursion dedup and conflicting duplicates', () => {
  // Parent P > c1, c2; both reach a grandchild id "agent-gc" (duplicate data).
  const diamond = (gc1Cost: number, gc2Cost: number, order: 'c1first' | 'c2first') => {
    const base = [
      parent({ id: 'P', prLinks: [A], turns: [turn({ cost: 10, ts: '2026-07-01T10:00:00Z', prRefs: [A] })], agentSpawnLinks: { c1: 'x1', c2: 'x2' }, spawnPrSets: { x1: [A], x2: [A] } }),
      child({ agentId: 'c1', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:05:00Z' }),
      child({ agentId: 'c2', parentId: 'P', cost: 100, firstTs: '2026-07-01T10:06:00Z' }),
    ]
    const gc1 = child({ agentId: 'gc', parentId: 'agent-c1', cost: gc1Cost, firstTs: '2026-07-01T10:07:00Z' })
    const gc2 = child({ agentId: 'gc', parentId: 'agent-c2', cost: gc2Cost, firstTs: '2026-07-01T10:07:00Z' })
    return [project([...base, ...(order === 'c1first' ? [gc1, gc2] : [gc2, gc1])])]
  }

  it('conflicting duplicate ids ($50 vs $500) fold into NEITHER, deterministic across input order', () => {
    for (const order of ['c1first', 'c2first'] as const) {
      const rows = aggregateByPr(diamond(50, 500, order))
      // 10 (parent) + 100 (c1) + 100 (c2); the conflicting grandchild folds nowhere.
      expect(rowFor(rows, A)!.cost).toBeCloseTo(210, 6)
      expect(prLinkedTotals(diamond(50, 500, order)).subagentSessions).toBe(2) // c1, c2 only
    }
  })

  it('identical duplicate ids fold exactly once', () => {
    // Same id, same fingerprint (cost/span/links): one logical session, folds once.
    const rows = aggregateByPr(diamond(50, 50, 'c1first'))
    expect(rowFor(rows, A)!.cost).toBeCloseTo(260, 6) // 10 + 100 + 100 + 50 (once)
    expect(prLinkedTotals(diamond(50, 50, 'c1first')).subagentSessions).toBe(3)
  })
})
