import { describe, expect, it } from 'vitest'

import { buildBranchSpendReport } from '../src/branch-spend.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary, TokenUsage } from '../src/types.js'

// Fixtures with known outcomes for the Spend "By branch" report. Costs are
// round numbers so the required splits (3+5, A/B mains, pre-branch spend,
// worktree evidence) are checkable exactly.

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
}

let keySeq = 0
function call(cost: number, overrides: Partial<ParsedApiCall> = {}): ParsedApiCall {
  return {
    provider: 'claude', model: 'claude-sonnet', usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 20 }, costUSD: cost,
    tools: [], mcpTools: [], skills: [], subagentTypes: [],
    hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
    timestamp: '2026-07-01T10:00:00Z', bashCommands: [], deduplicationKey: `k${keySeq++}`,
    ...overrides,
  }
}

function turn(cost: number, opts: { calls?: number; gitBranch?: string; at?: string; usage?: Partial<TokenUsage>; provider?: string } = {}): ClassifiedTurn {
  const { calls = 1, gitBranch, at = '2026-07-01T10:00:00Z', usage, provider = 'claude' } = opts
  return {
    userMessage: '',
    assistantCalls: Array.from({ length: calls }, () => call(cost / calls, { timestamp: at, provider, ...(usage ? { usage: { ...ZERO_USAGE, ...usage } } : {}) })),
    timestamp: at, sessionId: 's',
    category: 'coding', retries: 0, hasEdits: false,
    ...(gitBranch ? { gitBranch } : {}),
  }
}

function session(id: string, turns: ClassifiedTurn[], overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id, project: 'p',
    firstTimestamp: '2026-07-01T10:00:00Z', lastTimestamp: '2026-07-01T11:00:00Z',
    totalCostUSD: 0, totalSavingsUSD: 0, totalEstimatedCostUSD: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
    totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    apiCalls: 0, turns,
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {} as SessionSummary['skillBreakdown'],
    subagentBreakdown: {} as SessionSummary['subagentBreakdown'],
    ...overrides,
  }
}

const RANGE = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-07-02T00:00:00Z') }

function report(projects: ProjectSummary[]) {
  return buildBranchSpendReport(projects, RANGE)
}

function project(key: { project: string; projectPath: string }, sessions: SessionSummary[]): ProjectSummary {
  return {
    project: key.project, projectPath: key.projectPath, sessions,
    totalCostUSD: 0, totalSavingsUSD: 0, totalApiCalls: 0, totalProxiedCostUSD: 0,
  }
}

describe('buildBranchSpendReport', () => {
  it('keeps identical branch names of different projects in separate rows', () => {
    const rep = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('a1', [turn(4, { gitBranch: 'main' })]),
      ]),
      project({ project: 'beta', projectPath: '/code/beta' }, [
        session('b1', [turn(7, { gitBranch: 'main' })]),
      ]),
    ])
    expect(rep.projects).toHaveLength(2)
    const alpha = rep.projects.find(p => p.label === 'alpha')!
    const beta = rep.projects.find(p => p.label === 'beta')!
    expect(alpha.branches.map(r => [r.branch, r.cost])).toEqual([['main', 4]])
    expect(beta.branches.map(r => [r.branch, r.cost])).toEqual([['main', 7]])
    expect(rep.totals.distinctSessions).toBe(2)
  })

  it('splits a switching session per branch: 3 on feat/auth, 5 on fix/parser, one distinct session, 8 total', () => {
    const rep = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('s1', [
          turn(3, { gitBranch: 'feat/auth' }),
          turn(5, { gitBranch: 'fix/parser' }),
        ]),
      ]),
    ])
    const alpha = rep.projects[0]!
    expect(alpha.branches.map(r => [r.branch, r.cost])).toEqual([
      ['fix/parser', 5], ['feat/auth', 3],
    ])
    // Same session counts toward each row, but the identity-based count is one.
    expect(alpha.branches.every(r => r.sessions === 1)).toBe(true)
    expect(alpha.coverage.distinctSessions).toBe(1)
    expect(rep.totals.distinctSessions).toBe(1)
    // Branch rows overlap, so they are NOT summable into a distinct count —
    // but their costs are disjoint turn slices that reconcile to the source.
    expect(alpha.branches.reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(8, 6)
    expect(alpha.coverage.branchKnownCost).toBeCloseTo(8, 6)
    expect(alpha.coverage.branchUnknownCost).toBe(0)
  })

  it('identifies a worktree from the recorded historical working directory', () => {
    const rep = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('main-s', [turn(2, { gitBranch: 'main' })], { workingDirectory: '/code/alpha' }),
        session('wt-s', [turn(6, { gitBranch: 'feat/auth' })], { workingDirectory: '/code/alpha-worktrees/task-42' }),
      ]),
    ])
    const feat = rep.projects[0]!.branches.find(r => r.branch === 'feat/auth')!
    expect(feat.worktrees).toEqual([
      { path: '/code/alpha-worktrees/task-42', sessions: 1, cost: 6 },
    ])
    // The worktree session still belongs to the canonical project.
    expect(feat.projectId).toBe('/code/alpha')
    expect(rep.projects[0]!.coverage.distinctSessions).toBe(2)
  })

  it('keeps in-range spend on the branch carried from before the range', () => {
    // The parser resolves the carry across the range boundary before slicing,
    // so an in-range turn active on `main` (set before the window) arrives
    // with gitBranch='main' and must NOT land in the Unknown bucket.
    const rep = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('s1', [
          turn(9, { gitBranch: 'main', at: '2026-07-01T09:00:00Z' }),
          turn(1, { gitBranch: 'main', at: '2026-07-01T10:00:00Z' }),
        ]),
      ]),
    ])
    expect(rep.projects[0]!.branches.map(r => [r.branch, r.cost])).toEqual([['main', 10]])
    expect(rep.projects[0]!.coverage.branchUnknownCost).toBe(0)
  })

  it('attributes spend made before the first known branch to Unknown, never to a later branch', () => {
    const rep = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('s1', [
          turn(2),                        // before any branch was observed
          turn(5, { gitBranch: 'feat/auth' }),
        ]),
      ]),
    ])
    const alpha = rep.projects[0]!
    expect(alpha.branches.map(r => [r.branch, r.cost])).toEqual([
      ['feat/auth', 5], [null, 2],
    ])
    expect(alpha.coverage.branchKnownCost).toBeCloseTo(5, 6)
    expect(alpha.coverage.branchUnknownCost).toBeCloseTo(2, 6)
    // everHadBranch pre-filter evidence: a session whose only in-range turns
    // precede its first branch still participates via the Unknown bucket.
    const anchored = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('s2', [turn(2)], { everHadBranch: true }),
      ]),
    ])
    expect(anchored.projects[0]!.branches).toHaveLength(1)
    expect(anchored.projects[0]!.branches[0]!.branch).toBeNull()
  })

  it('reports provider-sources without branch metadata as coverage, not as a branch', () => {
    const rep = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('claude-s', [turn(5, { gitBranch: 'main' })]),
        session('codex-s', [turn(7, { provider: 'codex' })]),
      ]),
    ])
    const alpha = rep.projects[0]!
    expect(alpha.branches.map(r => r.branch)).toEqual(['main'])
    expect(alpha.coverage.noBranchDataCost).toBeCloseTo(7, 6)
    expect(alpha.coverage.noBranchDataSessions).toBe(1)
    expect(alpha.coverage.noBranchDataProviders).toEqual(['codex'])
    // Reconciliation: known + unknown + no-metadata covers the full spend.
    expect(
      alpha.coverage.branchKnownCost + alpha.coverage.branchUnknownCost + alpha.coverage.noBranchDataCost,
    ).toBeCloseTo(alpha.totalCost, 6)
  })

  it('sums token components per branch from the contributing calls', () => {
    const rep = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('s1', [
          turn(1, { gitBranch: 'main', usage: { inputTokens: 300, outputTokens: 50, reasoningTokens: 25, cacheReadInputTokens: 900, cacheCreationInputTokens: 40 } }),
          turn(1, { gitBranch: 'main', usage: { inputTokens: 100, outputTokens: 10 } }),
        ]),
      ]),
    ])
    const tokens = rep.projects[0]!.branches[0]!.tokens
    expect(tokens.inputTokens).toBe(400)
    expect(tokens.outputTokens).toBe(60)
    expect(tokens.reasoningTokens).toBe(25)
    expect(tokens.cacheReadTokens).toBe(900)
    expect(tokens.cacheWriteTokens).toBe(40)
  })

  it('tracks activity windows and per-session contributions inside a branch', () => {
    const rep = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('s1', [
          turn(3, { gitBranch: 'feat/auth', at: '2026-07-01T08:00:00Z' }),
          turn(2, { gitBranch: 'feat/auth', at: '2026-07-01T09:30:00Z' }),
        ], { title: 'Implement auth' }),
        session('s2', [turn(4, { gitBranch: 'feat/auth', at: '2026-07-01T10:15:00Z' })]),
      ]),
    ])
    const feat = rep.projects[0]!.branches.find(r => r.branch === 'feat/auth')!
    expect(feat.firstActive).toBe('2026-07-01T08:00:00Z')
    expect(feat.lastActive).toBe('2026-07-01T10:15:00Z')
    expect(feat.sessions).toBe(2)
    expect(feat.sessionRows.map(s => [s.sessionId, s.cost])).toEqual([['s1', 5], ['s2', 4]])
    expect(feat.sessionRows[0]!.title).toBe('Implement auth')
    expect(feat.sessionRows[0]!.firstActive).toBe('2026-07-01T08:00:00Z')
    expect(feat.sessionRows[0]!.lastActive).toBe('2026-07-01T09:30:00Z')
  })

  it('omits projects with neither branch rows nor no-branch spend', () => {
    const rep = report([
      project({ project: 'alpha', projectPath: '/code/alpha' }, [
        session('s1', [turn(5, { gitBranch: 'main' })]),
      ]),
      project({ project: 'empty', projectPath: '/code/empty' }, []),
    ])
    expect(rep.projects.map(p => p.label)).toEqual(['alpha'])
  })
})
