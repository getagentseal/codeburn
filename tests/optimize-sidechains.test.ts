import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/providers/index.js', async (importOriginal) => {
  type ProvidersModule = typeof import('../src/providers/index.js')
  const actual = await importOriginal<ProvidersModule>()
  return {
    ...actual,
    async discoverAllSessions() {
      return []
    },
  }
})

import {
  buildOptimizeJsonReport,
  cacheKey,
  computeInputCostRate,
  detectCapabilityReliability,
  detectSessionOutliers,
  findContextBloatCandidates,
  findLowWorthCandidates,
  runOptimize,
  scanAndDetect,
  type OptimizeResult,
} from '../src/optimize.js'
import type { ClassifiedTurn, ProjectSummary, SessionSummary } from '../src/types.js'

function behavioralTurn(
  model: string,
  index: number,
  options: { retries?: number; costUSD?: number; userMessage?: string } = {},
): ClassifiedTurn {
  const timestamp = new Date(Date.parse('2026-08-01T10:00:00.000Z') + index * 1_000).toISOString()
  return {
    userMessage: options.userMessage ?? 'edit the code',
    timestamp,
    sessionId: 'agent-behavior',
    category: 'feature',
    retries: options.retries ?? 0,
    hasEdits: true,
    assistantCalls: [{
      provider: 'claude',
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
      costUSD: options.costUSD ?? 1,
      tools: ['Edit'],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard',
      timestamp,
      bashCommands: [],
      deduplicationKey: `${model}-${index}`,
    }],
  }
}

function session(
  sessionId: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId,
    project: 'app',
    firstTimestamp: '2026-08-01T10:00:00.000Z',
    lastTimestamp: '2026-08-01T10:30:00.000Z',
    totalCostUSD: 1,
    totalSavingsUSD: 0,
    totalInputTokens: 1_000,
    totalOutputTokens: 1_000,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
    ...overrides,
  }
}

function sidechain(
  sessionId: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return session(sessionId, {
    isSidechain: true,
    parentSessionId: 'parent-session',
    agentId: sessionId.replace(/^agent-/, ''),
    ...overrides,
  })
}

function project(sessions: SessionSummary[]): ProjectSummary {
  return {
    project: 'app',
    projectPath: '/tmp/app',
    sessions,
    totalCostUSD: sessions.reduce((sum, item) => sum + item.totalCostUSD, 0),
    totalSavingsUSD: sessions.reduce((sum, item) => sum + item.totalSavingsUSD, 0),
    totalApiCalls: sessions.reduce((sum, item) => sum + item.apiCalls, 0),
    totalProxiedCostUSD: 0,
  }
}

describe('optimize sidechain population (issue #974)', () => {
  it('does not recommend a model default from sidechain-only edit behavior', async () => {
    const sonnetTurns = Array.from({ length: 35 }, (_, index) =>
      behavioralTurn('claude-sonnet-4-20250514', index, {
        retries: index >= 32 ? 1 : 0,
        costUSD: 2,
      }))
    const haikuTurns = Array.from({ length: 32 }, (_, index) =>
      behavioralTurn('claude-haiku-3-5-20241022', index + 35, {
        retries: index >= 29 ? 1 : 0,
        costUSD: 0.9,
      }))
    const child = sidechain('agent-behavior', { turns: [...sonnetTurns, ...haikuTurns] })
    const projects = [project([child])]

    const result = await scanAndDetect(projects, {
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-08-02T00:00:00.000Z'),
    })

    expect(result.modelRecommendations).toEqual([])
  })

  it('does not emit coaching from sidechain-only correction behavior', () => {
    const turns = Array.from({ length: 66 }, (_, index) =>
      behavioralTurn('claude-sonnet-4-20250514', index, {
        userMessage: index === 0 ? 'review the code' : 'you missed the edge case',
      }))
    const child = sidechain('agent-corrections', {
      totalCostUSD: 9,
      totalInputTokens: 6_600,
      totalOutputTokens: 3_300,
      apiCalls: 66,
      turns,
    })
    const projects = [project([child])]
    const result: OptimizeResult = {
      findings: [],
      costRate: computeInputCostRate(projects),
      healthScore: 100,
      healthGrade: 'A',
      modelRecommendations: [],
    }

    const report = buildOptimizeJsonReport(projects, 'fixture', result)

    expect(report.coachingNotes).toEqual([])
    expect(report.summary.periodCostUSD).toBe(9)
    expect(report.summary.calls).toBe(66)
  })

  it('does not report retry-heavy capabilities from sidechain-only edits', () => {
    const turns = Array.from({ length: 5 }, (_, index) => {
      const item = behavioralTurn('claude-sonnet-4-20250514', index, {
        retries: index < 3 ? 1 : 0,
      })
      item.assistantCalls[0]!.skills = ['reviewer']
      return item
    })
    const child = sidechain('agent-capability', { turns })

    expect(detectCapabilityReliability([project([child])])).toBeNull()
  })

  it('keeps sidechain spend out of the low-worth candidate population', () => {
    const parent = session('parent', {
      totalCostUSD: 4,
      turns: [],
    })
    const child = sidechain('agent-child', {
      totalCostUSD: 12,
      turns: [],
    })

    expect(findLowWorthCandidates([project([parent, child])]).map(item => item.sessionId))
      .toEqual(['parent'])
  })

  it('does not use a sidechain as a context-heavy candidate or growth baseline', () => {
    const baseline = session('parent-baseline', {
      firstTimestamp: '2026-08-01T10:00:00.000Z',
      totalInputTokens: 20_000,
      totalOutputTokens: 2_000,
    })
    const child = sidechain('agent-child', {
      firstTimestamp: '2026-08-02T10:00:00.000Z',
      totalInputTokens: 200_000,
      totalOutputTokens: 100,
    })
    const candidate = session('parent-candidate', {
      firstTimestamp: '2026-08-03T10:00:00.000Z',
      totalInputTokens: 100_000,
      totalOutputTokens: 2_000,
    })

    const candidates = findContextBloatCandidates([project([baseline, child, candidate])])

    expect(candidates.map(item => item.sessionId)).toEqual(['parent-candidate'])
    expect(candidates[0]!.growthRatio).toBe(5)
  })

  it('does not let a sidechain satisfy the peer-sample minimum for cost outliers', () => {
    const sessions = [
      session('parent-cheap', { totalCostUSD: 1 }),
      session('parent-expensive', { totalCostUSD: 10 }),
      sidechain('agent-cheap', { totalCostUSD: 1 }),
    ]

    expect(detectSessionOutliers([project(sessions)])).toBeNull()
  })

  it('never reports an expensive sidechain as a parent-session cost outlier', () => {
    const sessions = [
      session('parent-1', { totalCostUSD: 1 }),
      session('parent-2', { totalCostUSD: 1 }),
      session('parent-3', { totalCostUSD: 1 }),
      sidechain('agent-expensive', { totalCostUSD: 100 }),
    ]

    expect(detectSessionOutliers([project(sessions)])).toBeNull()
  })

  it('counts only parent sessions while conserving sidechain cost, calls, and tokens', () => {
    const projects = [project([
      session('parent', {
        totalCostUSD: 3,
        totalInputTokens: 100,
        totalOutputTokens: 20,
        apiCalls: 2,
      }),
      sidechain('agent-child', {
        totalCostUSD: 7,
        totalInputTokens: 900,
        totalOutputTokens: 80,
        apiCalls: 4,
      }),
    ])]
    const result: OptimizeResult = {
      findings: [],
      costRate: computeInputCostRate(projects),
      healthScore: 100,
      healthGrade: 'A',
    }

    const report = buildOptimizeJsonReport(projects, 'fixture', result)

    expect(report.summary.sessions).toBe(1)
    expect(report.summary.periodCostUSD).toBe(10)
    expect(report.summary.calls).toBe(6)
    // Input-cost calibration keeps all spend and all input/cache tokens:
    // ($10 * 0.7) / (100 + 900) tokens.
    expect(report.summary.costRateUSD).toBeCloseTo(0.007, 12)
  })

  it('keeps sidechain spend out of every per-session finding in the optimize pipeline', async () => {
    const projects = [project([
      sidechain('agent-only', {
        totalCostUSD: 100,
        totalInputTokens: 1_000_000,
        totalOutputTokens: 100,
      }),
    ])]

    const result = await scanAndDetect(projects, {
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-08-02T00:00:00.000Z'),
    })

    expect(result.findings.map(finding => finding.id)).not.toContain('low-worth-sessions')
    expect(result.findings.map(finding => finding.id)).not.toContain('context-heavy-sessions')
    expect(result.findings.map(finding => finding.id)).not.toContain('cost-outliers')
  })

  it('uses the parent-session count in the text optimize headline', async () => {
    const projects = [project([
      session('parent', {
        totalCostUSD: 1,
        bashBreakdown: { git: { calls: 1 } },
      }),
      sidechain('agent-child', {
        totalCostUSD: 2,
        bashBreakdown: { git: { calls: 1 } },
      }),
    ])]
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await runOptimize(projects, 'fixture', {
        start: new Date('2026-08-01T00:00:00.000Z'),
        end: new Date('2026-08-02T00:00:00.000Z'),
      })
      const output = String(log.mock.calls.at(-1)?.[0] ?? '')
      expect(output).toContain('1 session')
      expect(output).not.toContain('2 sessions')
    } finally {
      log.mockRestore()
      stderr.mockRestore()
    }
  })

  it('separates cached optimize results when only sidechain classification changes', () => {
    const range = {
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-08-02T00:00:00.000Z'),
    }
    const parentOnly = project([session('same')])
    const sidechainOnly = project([sidechain('same')])

    expect(parentOnly.totalCostUSD).toBe(sidechainOnly.totalCostUSD)
    expect(parentOnly.totalApiCalls).toBe(sidechainOnly.totalApiCalls)
    expect(cacheKey([parentOnly], range)).not.toBe(cacheKey([sidechainOnly], range))

    const firstSidechain = project([session('first'), sidechain('second')])
    const secondSidechain = project([sidechain('first'), session('second')])
    expect(firstSidechain.sessions.length).toBe(secondSidechain.sessions.length)
    expect(firstSidechain.totalCostUSD).toBe(secondSidechain.totalCostUSD)
    expect(firstSidechain.sessions.filter(item => item.isSidechain).length)
      .toBe(secondSidechain.sessions.filter(item => item.isSidechain).length)
    expect(cacheKey([firstSidechain], range)).not.toBe(cacheKey([secondSidechain], range))
  })
})
