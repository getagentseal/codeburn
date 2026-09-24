import { describe, it, expect, vi } from 'vitest'

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
  detectJunkReads,
  detectDuplicateReads,
  detectLowReadEditRatio,
  detectCacheBloat,
  detectBloatedClaudeMd,
  detectContextBloat,
  detectCapabilityReliability,
  detectLowWorthSessions,
  detectSessionOutliers,
  detectLowCacheHitSessions,
  scanAndDetect,
  cacheKey,
  computeHealth,
  computeTrend,
  buildOptimizeJsonReport,
  renderOptimize,
  findingBasis,
  optimizeRemediationCopy,
  optimizePasteHeader,
  optimizeTuiPasteHeader,
  optimizeEmptyScanLines,
  sessionOpenerLabel,
  askAgentLabel,
  type FindingId,
  type ToolCall,
  type ApiCallMeta,
  type WasteFinding,
  type OptimizeResult,
} from '../src/optimize.js'
import type { ProjectSummary } from '../src/types.js'
import type { AppliedFix } from '../src/act/types.js'

function call(name: string, input: Record<string, unknown>, sessionId = 's1', project = 'p1'): ToolCall {
  return { name, input, sessionId, project }
}

function emptyProjects(): ProjectSummary[] {
  return []
}

function projectWithSessions(costs: number[], project = 'app'): ProjectSummary {
  const sessions = costs.map((cost, i) => {
    const tokens = Math.round(cost * 1000)
    return {
      sessionId: `s${i + 1}`,
      project,
      firstTimestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
      lastTimestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:30:00Z`,
      totalCostUSD: cost,
      totalInputTokens: tokens,
      totalOutputTokens: tokens,
      totalReasoningTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      apiCalls: 1,
      turns: [],
      modelBreakdown: {},
      toolBreakdown: {},
      mcpBreakdown: {},
      bashBreakdown: {},
      categoryBreakdown: {} as ProjectSummary['sessions'][number]['categoryBreakdown'],
      skillBreakdown: {},
    }
  })

  return {
    project,
    projectPath: `/tmp/${project}`,
    sessions,
    totalCostUSD: costs.reduce((sum, cost) => sum + cost, 0),
    totalApiCalls: sessions.length,
  }
}

function projectWithDeliveredSessions(costs: number[], project = 'app'): ProjectSummary {
  const summary = projectWithSessions(costs, project)
  for (const session of summary.sessions) {
    session.bashBreakdown = { 'git commit -m test': { calls: 1 } }
  }
  return summary
}

function optimizeDateRange(day: number) {
  const padded = String(day).padStart(2, '0')
  return {
    start: new Date(`2026-06-${padded}T00:00:00Z`),
    end: new Date(`2026-06-${padded}T23:59:59Z`),
  }
}

type TestSession = ProjectSummary['sessions'][number]

function contextSession(
  i: number,
  overrides: Partial<TestSession>,
  project = 'app',
): TestSession {
  return {
    sessionId: `s${i + 1}`,
    project,
    firstTimestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    lastTimestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:30:00Z`,
    totalCostUSD: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as TestSession['categoryBreakdown'],
    skillBreakdown: {},
    ...overrides,
  }
}

function projectWithContextSessions(sessions: TestSession[], project = 'app'): ProjectSummary {
  return {
    project,
    projectPath: `/tmp/${project}`,
    sessions,
    totalCostUSD: sessions.reduce((sum, session) => sum + session.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((sum, session) => sum + session.apiCalls, 0),
  }
}

describe('detectJunkReads', () => {
  it('returns null below minimum threshold', () => {
    const calls = [
      call('Read', { file_path: '/x/node_modules/a.js' }),
      call('Read', { file_path: '/x/node_modules/b.js' }),
    ]
    expect(detectJunkReads(calls)).toBeNull()
  })

  it('flags when threshold is met', () => {
    const calls = [
      call('Read', { file_path: '/x/node_modules/a.js' }),
      call('Read', { file_path: '/x/node_modules/b.js' }),
      call('Read', { file_path: '/x/.git/config' }),
    ]
    const finding = detectJunkReads(calls)
    expect(finding).not.toBeNull()
    expect(finding!.impact).toBe('low')
  })

  it('scales impact with read count', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) =>
      call('Read', { file_path: `/x/node_modules/file-${i}.js` })
    )
    expect(detectJunkReads(make(25))!.impact).toBe('high')
    expect(detectJunkReads(make(10))!.impact).toBe('medium')
  })

  it('ignores non-junk paths', () => {
    const calls = [
      call('Read', { file_path: '/x/src/a.ts' }),
      call('Read', { file_path: '/x/src/b.ts' }),
      call('Read', { file_path: '/x/README.md' }),
    ]
    expect(detectJunkReads(calls)).toBeNull()
  })

  it('ignores non-read tools', () => {
    const calls = [
      call('Edit', { file_path: '/x/node_modules/a.js' }),
      call('Bash', { command: 'ls node_modules' }),
      call('Grep', { pattern: 'test', path: '/x/node_modules' }),
    ]
    expect(detectJunkReads(calls)).toBeNull()
  })

  it('handles missing file_path gracefully', () => {
    const calls = [
      call('Read', {}),
      call('Read', { file_path: null as unknown as string }),
    ]
    expect(detectJunkReads(calls)).toBeNull()
  })

  it('suggests CLAUDE.md advice listing detected and common junk dirs', () => {
    const calls = Array.from({ length: 5 }, () => call('Read', { file_path: '/x/node_modules/a.js' }))
    const finding = detectJunkReads(calls)!
    expect(finding.fix.type).toBe('paste')
    if (finding.fix.type === 'paste') {
      expect(finding.fix.text).toContain('node_modules')
      // Issue #277: every paste-style fix should declare its destination so
      // users can tell a permanent CLAUDE.md rule from a one-time session
      // opener at a glance.
      expect(finding.fix.destination).toBe('claude-md')
    }
    expect(finding.fix.label).toContain('CLAUDE.md')
  })
})

describe('detectDuplicateReads', () => {
  it('counts same file read multiple times in same session', () => {
    const calls = [
      ...Array.from({ length: 4 }, () => call('Read', { file_path: '/src/a.ts' }, 's1')),
      ...Array.from({ length: 4 }, () => call('Read', { file_path: '/src/b.ts' }, 's1')),
    ]
    const finding = detectDuplicateReads(calls)
    expect(finding).not.toBeNull()
  })

  it('does not count across sessions', () => {
    const calls = [
      call('Read', { file_path: '/src/a.ts' }, 's1'),
      call('Read', { file_path: '/src/a.ts' }, 's2'),
      call('Read', { file_path: '/src/a.ts' }, 's3'),
    ]
    expect(detectDuplicateReads(calls)).toBeNull()
  })

  it('excludes junk directory reads', () => {
    const calls = Array.from({ length: 10 }, () =>
      call('Read', { file_path: '/x/node_modules/foo.js' }, 's1')
    )
    expect(detectDuplicateReads(calls)).toBeNull()
  })

  it('returns null for single reads', () => {
    const calls = [
      call('Read', { file_path: '/src/a.ts' }, 's1'),
      call('Read', { file_path: '/src/b.ts' }, 's1'),
    ]
    expect(detectDuplicateReads(calls)).toBeNull()
  })
})

describe('detectLowReadEditRatio', () => {
  it('counts read-shaped bash commands as reads (#941)', () => {
    // 10 edits with 40 rg/cat/git-log lookups through the shell: a healthy
    // 4:1 workflow that previously read as 0 reads and fired at high impact.
    const calls = [
      ...Array.from({ length: 20 }, () => call('Bash', { command: 'rg -n "pattern" src/' })),
      ...Array.from({ length: 10 }, () => call('Bash', { command: 'cat src/parser.ts | head -50' })),
      ...Array.from({ length: 10 }, () => call('Bash', { command: 'git log --oneline -5' })),
      ...Array.from({ length: 10 }, () => call('Edit', {})),
    ]
    expect(detectLowReadEditRatio(calls)).toBeNull()
  })

  it('does not count mutating or unclassifiable bash as reads (#941)', () => {
    const calls = [
      ...Array.from({ length: 20 }, () => call('Bash', { command: 'npm test' })),
      ...Array.from({ length: 10 }, () => call('Bash', { command: 'cat notes.md && sed -i s/a/b/ src/x.ts' })),
      ...Array.from({ length: 10 }, () => call('Bash', {})),
      ...Array.from({ length: 10 }, () => call('Edit', {})),
    ]
    const finding = detectLowReadEditRatio(calls)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('0 reads')
  })

  it('returns null below minimum edit count', () => {
    const calls = [
      call('Edit', {}),
      call('Edit', {}),
      call('Read', {}),
    ]
    expect(detectLowReadEditRatio(calls)).toBeNull()
  })

  it('returns null when ratio is healthy', () => {
    const calls = [
      ...Array.from({ length: 40 }, () => call('Read', {})),
      ...Array.from({ length: 10 }, () => call('Edit', {})),
    ]
    expect(detectLowReadEditRatio(calls)).toBeNull()
  })

  it('flags when edits outpace reads', () => {
    const calls = [
      ...Array.from({ length: 5 }, () => call('Read', {})),
      ...Array.from({ length: 10 }, () => call('Edit', {})),
    ]
    const finding = detectLowReadEditRatio(calls)
    expect(finding).not.toBeNull()
    expect(finding!.impact).toBe('high')
  })

  it('counts Grep and Glob as reads for ratio', () => {
    const calls = [
      ...Array.from({ length: 40 }, () => call('Grep', {})),
      ...Array.from({ length: 10 }, () => call('Edit', {})),
    ]
    expect(detectLowReadEditRatio(calls)).toBeNull()
  })

  it('counts Write as edit', () => {
    const calls = [
      ...Array.from({ length: 15 }, () => call('Read', {})),
      ...Array.from({ length: 10 }, () => call('Write', {})),
    ]
    const finding = detectLowReadEditRatio(calls)
    expect(finding).not.toBeNull()
  })
})

describe('detectCacheBloat', () => {
  it('returns null below minimum api calls', () => {
    const apiCalls: ApiCallMeta[] = [
      { cacheCreationTokens: 80000, version: '2.1.100' },
      { cacheCreationTokens: 80000, version: '2.1.100' },
    ]
    expect(detectCacheBloat(apiCalls, emptyProjects())).toBeNull()
  })

  it('returns null when median is close to baseline', () => {
    const apiCalls: ApiCallMeta[] = Array.from({ length: 20 }, () => ({
      cacheCreationTokens: 50000,
      version: '2.1.98',
    }))
    expect(detectCacheBloat(apiCalls, emptyProjects())).toBeNull()
  })

  it('flags when median exceeds 1.4x baseline', () => {
    const apiCalls: ApiCallMeta[] = Array.from({ length: 20 }, () => ({
      cacheCreationTokens: 80000,
      version: '2.1.100',
    }))
    const finding = detectCacheBloat(apiCalls, emptyProjects())
    expect(finding).not.toBeNull()
  })
})

describe('detectBloatedClaudeMd', () => {
  it('returns null when no projects have CLAUDE.md', () => {
    const result = detectBloatedClaudeMd(new Set(['/nonexistent/path']))
    expect(result).toBeNull()
  })

  it('returns null for empty project set', () => {
    const result = detectBloatedClaudeMd(new Set())
    expect(result).toBeNull()
  })
})

describe('detectContextBloat', () => {
  it('returns null below the input/context token floor', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 74_999,
        totalOutputTokens: 100,
      }),
    ])

    expect(detectContextBloat([project])).toBeNull()
  })

  it('returns null when output is proportionate to input/context tokens', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 100_000,
        totalOutputTokens: 5_000,
      }),
    ])

    expect(detectContextBloat([project])).toBeNull()
  })

  it('counts reasoning with output when measuring context pressure', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 100_000,
        totalOutputTokens: 3_500,
        totalReasoningTokens: 2_000,
      }),
    ])

    expect(detectContextBloat([project])).toBeNull()
  })

  it('discounts cache reads when estimating context pressure', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 5_000,
        totalCacheReadTokens: 700_000,
        totalOutputTokens: 5_000,
      }),
    ])

    expect(detectContextBloat([project])).toBeNull()
  })

  it('weights cache writes when estimating context pressure', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 10_000,
        totalCacheWriteTokens: 80_000,
        totalOutputTokens: 3_000,
      }),
    ])

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('110.0K effective input/cache')
    expect(finding!.tokensSaved).toBe(65_000)
  })

  it('flags sessions where input/cache tokens swamp output', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 90_000,
        totalCacheReadTokens: 30_000,
        totalOutputTokens: 2_000,
      }),
    ])

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('context-heavy session')
    expect(finding!.explanation).toContain('app/s1')
    expect(finding!.explanation).toContain('93.0K effective input/cache')
    expect(finding!.explanation).toContain('46.5:1')
    expect(finding!.impact).toBe('low')
    expect(finding!.tokensSaved).toBe(63_000)
  })

  it('uses medium impact between the low and high tiers', () => {
    const project = projectWithContextSessions(
      Array.from({ length: 4 }, (_, i) => contextSession(i, {
        totalInputTokens: 80_000,
        totalOutputTokens: 1_000,
      })),
    )

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.impact).toBe('medium')
  })

  it('uses high impact at 10 or more candidates regardless of total size', () => {
    const project = projectWithContextSessions(
      Array.from({ length: 10 }, (_, i) => contextSession(i, {
        totalInputTokens: 80_000,
        totalOutputTokens: 1_000,
      })),
    )

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.impact).toBe('high')
  })

  it('includes context growth from the previous session when it is large', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 20_000,
        totalOutputTokens: 1_000,
      }),
      contextSession(1, {
        totalInputTokens: 100_000,
        totalOutputTokens: 2_000,
      }),
    ])

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('5.0x previous session input')
  })

  it('calculates context growth within each project only', () => {
    const finding = detectContextBloat([
      projectWithContextSessions([
        contextSession(0, {
          totalInputTokens: 20_000,
          totalOutputTokens: 1_000,
        }),
        contextSession(1, {
          totalInputTokens: 100_000,
          totalOutputTokens: 2_000,
        }),
      ], 'app'),
      projectWithContextSessions([
        contextSession(0, {
          totalInputTokens: 100_000,
          totalOutputTokens: 2_000,
        }, 'api'),
      ], 'api'),
    ])

    expect(finding).not.toBeNull()
    expect(finding!.explanation.match(/previous session input/g)).toHaveLength(1)
  })

  it('summarizes additional candidates after the preview limit', () => {
    const project = projectWithContextSessions(
      Array.from({ length: 6 }, (_, i) => contextSession(i, {
        totalInputTokens: 80_000 + i * 10_000,
        totalOutputTokens: 1_000,
      })),
    )

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('app/s6')
    expect(finding!.explanation).toContain('; +1 more')
    expect(finding!.impact).toBe('high')
  })

  it('uses high impact for one very large context-heavy session', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 600_000,
        totalOutputTokens: 10_000,
      }),
    ])

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.impact).toBe('high')
  })

  it('handles zero-output sessions without dividing by zero', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 80_000,
        totalOutputTokens: 0,
      }),
    ])

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('1000+:1')
    expect(finding!.tokensSaved).toBe(80_000)
  })

  it('caps display ratio at 1000+:1 for non-zero-output sessions too', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 5_000_000,
        totalOutputTokens: 100,
      }),
    ])

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('1000+:1')
  })

  it('suppresses the growth ratio when the previous session is more than 7 days back', () => {
    const project = projectWithContextSessions([
      {
        ...contextSession(0, { totalInputTokens: 20_000, totalOutputTokens: 1_000 }),
        firstTimestamp: '2026-05-01T10:00:00Z',
        lastTimestamp: '2026-05-01T10:30:00Z',
      },
      {
        ...contextSession(1, { totalInputTokens: 100_000, totalOutputTokens: 2_000 }),
        firstTimestamp: '2026-05-15T10:00:00Z',
        lastTimestamp: '2026-05-15T10:30:00Z',
      },
    ])

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    expect(finding!.explanation).not.toContain('previous session input')
  })

  it('anchors growth even when the previous session is below the reporting threshold', () => {
    const project = projectWithContextSessions([
      contextSession(0, { totalInputTokens: 20_000, totalOutputTokens: 1_000 }),
      contextSession(1, { totalInputTokens: 100_000, totalOutputTokens: 2_000 }),
    ])

    const finding = detectContextBloat([project])
    expect(finding).not.toBeNull()
    // The first session sits below CONTEXT_BLOAT_MIN_INPUT_TOKENS (75K) and
    // is not itself a candidate, but the growth-from-previous comparison for
    // the second session must still anchor against it.
    expect(finding!.explanation).toContain('5.0x previous session input')
  })

  it('honors excludedSessionIds passed by the orchestrator', () => {
    const project = projectWithContextSessions([
      contextSession(0, {
        totalInputTokens: 90_000,
        totalCacheReadTokens: 30_000,
        totalOutputTokens: 2_000,
      }),
    ])

    const finding = detectContextBloat([project], new Set(['s1']))
    expect(finding).toBeNull()
  })
})

describe('detectLowCacheHitSessions', () => {
  it('flags a big session under the 80% hit target', () => {
    const project = projectWithContextSessions([
      contextSession(0, { apiCalls: 10, totalInputTokens: 60_000, totalCacheReadTokens: 40_000 }),
      contextSession(1, { apiCalls: 10, totalInputTokens: 5_000, totalCacheReadTokens: 95_000 }),
    ])
    const finding = detectLowCacheHitSessions([project])
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('low-cache-hit-sessions')
    expect(finding!.title).toBe('1 session with a low cache hit rate')
    expect(finding!.explanation).toContain('app/s1')
    expect(finding!.explanation).toContain('40.0% of 100.0K input')
    expect(finding!.explanation).not.toContain('app/s2')
    expect(finding!.tokensSaved).toBe(36_000)
  })

  it('counts cache writes as misses', () => {
    const project = projectWithContextSessions([
      contextSession(0, { apiCalls: 10, totalInputTokens: 1_000, totalCacheWriteTokens: 60_000, totalCacheReadTokens: 39_000 }),
    ])
    expect(detectLowCacheHitSessions([project])!.explanation).toContain('39.0% of 100.0K input')
  })

  it('ignores sessions with no cache token fields', () => {
    const project = projectWithContextSessions([
      contextSession(0, { apiCalls: 10, totalInputTokens: 500_000 }),
    ])
    expect(detectLowCacheHitSessions([project])).toBeNull()
  })

  it('ignores tiny sessions', () => {
    const project = projectWithContextSessions([
      contextSession(0, { apiCalls: 10, totalInputTokens: 50_000, totalCacheReadTokens: 10_000 }),
      contextSession(1, { apiCalls: 4, totalInputTokens: 500_000, totalCacheReadTokens: 10_000 }),
    ])
    expect(detectLowCacheHitSessions([project])).toBeNull()
  })
})

type LowWorthTurn = TestSession['turns'][number]

function lowWorthTurn(overrides: Partial<LowWorthTurn> = {}): LowWorthTurn {
  return {
    userMessage: 'do the work',
    assistantCalls: [],
    timestamp: '2026-05-01T10:00:00Z',
    sessionId: 's1',
    category: 'coding',
    retries: 0,
    hasEdits: false,
    ...overrides,
  }
}

function lowWorthSession(cost: number, i: number, overrides: Partial<TestSession> = {}, project = 'app'): TestSession {
  const tokens = Math.round(cost * 1000)
  return {
    sessionId: `s${i + 1}`,
    project,
    firstTimestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    lastTimestamp: `2026-05-${String(i + 1).padStart(2, '0')}T10:30:00Z`,
    totalCostUSD: cost,
    totalInputTokens: tokens,
    totalOutputTokens: tokens,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as TestSession['categoryBreakdown'],
    skillBreakdown: {},
    ...overrides,
  }
}

function projectWithLowWorthSessions(sessions: TestSession[], project = 'app'): ProjectSummary {
  return {
    project,
    projectPath: `/tmp/${project}`,
    sessions,
    totalCostUSD: sessions.reduce((sum, s) => sum + s.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((sum, s) => sum + s.apiCalls, 0),
  }
}

describe('detectLowWorthSessions', () => {
  it('returns null for cheap sessions', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(1.99, 0, { turns: [lowWorthTurn({ hasEdits: false })] }),
    ])
    expect(detectLowWorthSessions([project])).toBeNull()
  })

  it('does not flag the no-edit cost boundary', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(2.99, 0, { turns: [lowWorthTurn({ hasEdits: false })] }),
    ])
    expect(detectLowWorthSessions([project])).toBeNull()
  })

  it('flags expensive sessions with no edit turns', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(4, 0, { turns: [lowWorthTurn({ hasEdits: false })] }),
    ])
    const finding = detectLowWorthSessions([project])
    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('possibly low-worth')
    expect(finding!.explanation).toContain('app/s1')
    expect(finding!.explanation).toContain('no edit turns')
    // sessionTokenTotal = input + output + cache. The lowWorthSession helper
    // sets input=output=cost*1000, so the full session total is 8K and the
    // bounded no-edit recovery fraction gives a 4K savings estimate.
    expect(finding!.tokensSaved).toBe(4_000)
  })

  it('flags retry-heavy sessions', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(2.5, 0, {
        turns: [
          lowWorthTurn({ hasEdits: true, retries: 1 }),
          lowWorthTurn({ hasEdits: true, retries: 2 }),
        ],
      }),
    ])
    const finding = detectLowWorthSessions([project])
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('3 retries')
  })

  it('estimates recoverable tokens by retry fraction for sessions with edits', () => {
    // 4 turns, 2 retries spread across 2 edits, 0 one-shot edits → trips the
    // 'no one-shot edit turns' reason. totalTurns=4, fraction=2/4=0.5,
    // sessionTokenTotal=8K, so recoverable savings ceiling is 4K — half the
    // session, not the full ceiling that no-edit sessions get.
    const project = projectWithLowWorthSessions([
      lowWorthSession(4, 0, {
        turns: [
          lowWorthTurn({ hasEdits: true, retries: 1 }),
          lowWorthTurn({ hasEdits: true, retries: 1 }),
          lowWorthTurn({ hasEdits: false }),
          lowWorthTurn({ hasEdits: false }),
        ],
      }),
    ])
    const finding = detectLowWorthSessions([project])
    expect(finding).not.toBeNull()
    expect(finding!.tokensSaved).toBe(4_000)
  })

  it('uses the bounded recovery fraction for no-edit sessions', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(4, 0, { turns: [lowWorthTurn({ hasEdits: false })] }),
    ])
    const finding = detectLowWorthSessions([project])
    // No edits at all -> bounded half-session estimate. sessionTokenTotal = 8K.
    expect(finding!.tokensSaved).toBe(4_000)
  })

  it('keeps all reasons that apply to the same session', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(4, 0, {
        turns: [
          lowWorthTurn({ hasEdits: false, retries: 1 }),
          lowWorthTurn({ hasEdits: false, retries: 2 }),
        ],
      }),
    ])
    const finding = detectLowWorthSessions([project])
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('no edit turns')
    expect(finding!.explanation).toContain('3 retries')
  })

  it('flags edit sessions with retries but no one-shot edit turns via categoryBreakdown', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(2.25, 0, {
        categoryBreakdown: {
          coding: { turns: 2, costUSD: 2.25, retries: 2, editTurns: 2, oneShotTurns: 0 },
        } as TestSession['categoryBreakdown'],
      }),
    ])
    const finding = detectLowWorthSessions([project])
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('no one-shot edit turns')
  })

  it('skips sessions with a git delivery command', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(8, 0, {
        turns: [lowWorthTurn({ hasEdits: false })],
        bashBreakdown: { 'cd /tmp/app && git commit -m "ship fix"': { calls: 1 } },
      }),
    ])
    expect(detectLowWorthSessions([project])).toBeNull()
  })

  it('skips sessions with gh pr create', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(8, 0, {
        turns: [lowWorthTurn({ hasEdits: false })],
        bashBreakdown: { 'gh pr create --fill': { calls: 1 } },
      }),
    ])
    expect(detectLowWorthSessions([project])).toBeNull()
  })

  it('does not treat read-only git commands as delivery', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(8, 0, {
        turns: [lowWorthTurn({ hasEdits: false })],
        bashBreakdown: { 'git tag -l': { calls: 1 } },
      }),
    ])
    expect(detectLowWorthSessions([project])).not.toBeNull()
  })

  it('does not treat dry-run git commands as delivery', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(8, 0, {
        turns: [lowWorthTurn({ hasEdits: false })],
        bashBreakdown: { 'git push --dry-run origin main': { calls: 1 } },
      }),
    ])
    expect(detectLowWorthSessions([project])).not.toBeNull()
  })

  it('does not treat git commit-tree as a delivery command', () => {
    // Regex must match `git commit` only, not `git commit-tree` /
    // `git commit-graph`. Without the (?:\s|$|--) lookahead this would be a
    // false positive and the session would silently skip detection.
    const project = projectWithLowWorthSessions([
      lowWorthSession(8, 0, {
        turns: [lowWorthTurn({ hasEdits: false })],
        bashBreakdown: { 'git commit-tree HEAD^{tree}': { calls: 1 } },
      }),
    ])
    expect(detectLowWorthSessions([project])).not.toBeNull()
  })

  it('still treats `git commit --amend` as a delivery command', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(8, 0, {
        turns: [lowWorthTurn({ hasEdits: false })],
        bashBreakdown: { 'git commit --amend --no-edit': { calls: 1 } },
      }),
    ])
    expect(detectLowWorthSessions([project])).toBeNull()
  })

  it('uses low impact for a single small candidate', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(4, 0, { turns: [lowWorthTurn({ hasEdits: false })] }),
    ])
    const finding = detectLowWorthSessions([project])
    expect(finding!.impact).toBe('low')
  })

  it('uses medium impact between low and high tiers', () => {
    const project = projectWithLowWorthSessions(
      Array.from({ length: 3 }, (_, i) => lowWorthSession(4, i, {
        turns: [lowWorthTurn({ hasEdits: false })],
      })),
    )
    const finding = detectLowWorthSessions([project])
    expect(finding!.impact).toBe('medium')
  })

  it('uses high impact at 10 or more candidates', () => {
    const project = projectWithLowWorthSessions(
      Array.from({ length: 10 }, (_, i) => lowWorthSession(3, i, {
        turns: [lowWorthTurn({ hasEdits: false })],
      })),
    )
    const finding = detectLowWorthSessions([project])
    expect(finding!.impact).toBe('high')
  })

  it('summarizes additional candidates after the preview limit', () => {
    const project = projectWithLowWorthSessions(
      Array.from({ length: 6 }, (_, i) => lowWorthSession(4 + i, i, {
        turns: [lowWorthTurn({ hasEdits: false })],
      })),
    )
    const finding = detectLowWorthSessions([project])
    expect(finding!.explanation).toContain('; +1 more')
  })
})

type ReliabilityCall = LowWorthTurn['assistantCalls'][number]

function reliabilityCall(overrides: Partial<ReliabilityCall> = {}): ReliabilityCall {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    usage: {
      inputTokens: 1000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: 0.01,
    tools: ['Edit'],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-05-01T10:00:00Z',
    bashCommands: [],
    deduplicationKey: 'call',
    ...overrides,
  }
}

function reliabilityTurn(
  i: number,
  overrides: Partial<LowWorthTurn> & { call?: Partial<ReliabilityCall> } = {},
): LowWorthTurn {
  const { call: callOverrides, ...turnOverrides } = overrides
  return lowWorthTurn({
    userMessage: `turn ${i}`,
    assistantCalls: [reliabilityCall({
      timestamp: `2026-05-01T10:${String(i).padStart(2, '0')}:00Z`,
      deduplicationKey: `call-${i}`,
      ...callOverrides,
    })],
    timestamp: `2026-05-01T10:${String(i).padStart(2, '0')}:00Z`,
    sessionId: 's1',
    hasEdits: true,
    retries: 0,
    ...turnOverrides,
  })
}

function projectWithReliabilityTurns(turns: LowWorthTurn[], project = 'app'): ProjectSummary {
  return projectWithLowWorthSessions([
    lowWorthSession(1, 0, {
      turns,
      totalInputTokens: turns.length * 1000,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      apiCalls: turns.length,
    }, project),
  ], project)
}

describe('detectCapabilityReliability', () => {
  it('flags retry-heavy skills from actual Skill call metadata', () => {
    const turns = Array.from({ length: 5 }, (_, i) => reliabilityTurn(i, {
      retries: i < 3 ? 1 : 0,
      call: { tools: ['Edit', 'Skill'], skills: ['reviewer'] },
    }))

    const finding = detectCapabilityReliability([projectWithReliabilityTurns(turns)])

    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('skill')
    expect(finding!.explanation).toContain('skill reviewer')
    expect(finding!.explanation).toContain('3/5 edit turns retried (60%)')
    expect(finding!.explanation).toContain('correlation report')
    expect(finding!.tokensSaved).toBe(1500)
    expect(finding!.fix.type).toBe('paste')
    if (finding!.fix.type === 'paste') expect(finding!.fix.destination).toBe('prompt')
  })

  it('flags retry-heavy MCP servers from invoked MCP tools', () => {
    const turns = Array.from({ length: 5 }, (_, i) => reliabilityTurn(i, {
      retries: i < 3 ? 1 : 0,
      call: {
        tools: ['Edit', 'mcp__ci__run'],
        mcpTools: ['mcp__ci__run'],
      },
    }))

    const finding = detectCapabilityReliability([projectWithReliabilityTurns(turns)])

    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('MCP server')
    expect(finding!.explanation).toContain('MCP server ci')
    expect(finding!.explanation).toContain('3 retries')
  })

  it('does not flag healthy capabilities with mostly one-shot edit turns', () => {
    const turns = Array.from({ length: 5 }, (_, i) => reliabilityTurn(i, {
      retries: i === 0 ? 1 : 0,
      call: { tools: ['Edit', 'Skill'], skills: ['healthy'] },
    }))

    expect(detectCapabilityReliability([projectWithReliabilityTurns(turns)])).toBeNull()
  })

  it('does not treat subCategory alone as skill evidence', () => {
    const turns = Array.from({ length: 5 }, (_, i) => reliabilityTurn(i, {
      retries: 1,
      subCategory: 'legacy-skill-label',
      call: { tools: ['Edit'], skills: [] },
    }))

    expect(detectCapabilityReliability([projectWithReliabilityTurns(turns)])).toBeNull()
  })

  it('does not double-count the same retry-heavy turn across MCP and skill candidates', () => {
    const turns = Array.from({ length: 5 }, (_, i) => reliabilityTurn(i, {
      retries: i < 3 ? 1 : 0,
      call: {
        tools: ['Edit', 'Skill', 'mcp__ci__run'],
        mcpTools: ['mcp__ci__run'],
        skills: ['reviewer'],
      },
    }))

    const finding = detectCapabilityReliability([projectWithReliabilityTurns(turns)])

    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('2 MCP/skill capabilities')
    expect(finding!.explanation).toContain('MCP server ci')
    expect(finding!.explanation).toContain('skill reviewer')
    // Three retry-heavy turns at 1K effective tokens each, counted once at
    // the 50% recoverable ceiling even though two flagged capabilities share
    // every turn.
    expect(finding!.tokensSaved).toBe(1500)
  })

  it('ignores read-only retry turns for capability reliability', () => {
    const turns = Array.from({ length: 5 }, (_, i) => reliabilityTurn(i, {
      hasEdits: false,
      retries: 1,
      call: { tools: ['Read', 'Skill'], skills: ['reader'] },
    }))

    expect(detectCapabilityReliability([projectWithReliabilityTurns(turns)])).toBeNull()
  })
})

describe('detectSessionOutliers', () => {
  it('returns null when there are too few sessions for a project baseline', () => {
    expect(detectSessionOutliers([projectWithSessions([0.5, 4])])).toBeNull()
  })

  it('returns null when no session exceeds twice the project average', () => {
    expect(detectSessionOutliers([projectWithSessions([1, 1.2, 1.4, 1.6])])).toBeNull()
  })

  it('does not flag the exact 2x boundary', () => {
    expect(detectSessionOutliers([projectWithSessions([1, 1, 2])])).toBeNull()
  })

  it('flags sessions costing more than twice their project average', () => {
    const finding = detectSessionOutliers([projectWithSessions([1, 1, 1, 10])])
    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('high-cost session outlier')
    expect(finding!.explanation).toContain('app/s4')
    expect(finding!.impact).toBe('medium')
    expect(finding!.tokensSaved).toBeGreaterThan(0)
  })

  it('keeps estimated-cost sessions out of the peer math', () => {
    const project = projectWithSessions([1, 1, 1, 10])
    // The expensive session is priced from modelled tokens, so it is not
    // comparable against the provider-reported peers and never gets flagged.
    project.sessions[3]!.totalEstimatedCostUSD = project.sessions[3]!.totalCostUSD
    expect(detectSessionOutliers([project])).toBeNull()
  })

  it('falls back to estimated costs when nothing else is priced, and says so', () => {
    const project = projectWithSessions([1, 1, 1, 10])
    for (const s of project.sessions) s.totalEstimatedCostUSD = s.totalCostUSD
    const finding = detectSessionOutliers([project])
    expect(finding).not.toBeNull()
    expect(finding!.basis).toBe('estimated')
    expect(findingBasis(finding!)).toBe('estimated')
  })

  it('reports measured basis when every peer cost is provider-reported', () => {
    const finding = detectSessionOutliers([projectWithSessions([1, 1, 1, 10])])
    expect(finding!.basis).toBeUndefined()
    expect(findingBasis(finding!)).toBe('measured')
  })

  it('ignores tiny absolute-cost outliers', () => {
    expect(detectSessionOutliers([projectWithSessions([0.01, 0.01, 0.01, 0.2])])).toBeNull()
  })

  it('isolates baselines per project', () => {
    const finding = detectSessionOutliers([
      projectWithSessions([8, 9, 10], 'web'),
      projectWithSessions([1, 1, 1, 12], 'api'),
    ])

    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('api/s4')
    expect(finding!.explanation).not.toContain('web/')
  })

  it('excludes sessions already flagged by detectContextBloat', () => {
    const project = projectWithSessions([1, 1, 1, 10])
    const excluded = new Set(['s4'])
    expect(detectSessionOutliers([project], excluded)).toBeNull()
  })

  it('still flags cost outliers that are not context-bloat candidates', () => {
    const project = projectWithSessions([1, 1, 1, 10])
    const excluded = new Set(['some-other-session'])
    const finding = detectSessionOutliers([project], excluded)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('app/s4')
  })

  it('scanAndDetect excludes the earliest high-cost session while the project is young', async () => {
    const result = await scanAndDetect(
      [projectWithDeliveredSessions([20, 1, 1, 1])],
      optimizeDateRange(1),
    )

    const finding = result.findings.find(f => f.id === 'cost-outliers')
    expect(finding).toBeUndefined()
  })

  it('scanAndDetect still flags a later high-cost session while the project is young', async () => {
    const result = await scanAndDetect(
      [projectWithDeliveredSessions([1, 20, 1, 1])],
      optimizeDateRange(2),
    )

    const finding = result.findings.find(f => f.id === 'cost-outliers')
    expect(finding).toBeDefined()
    expect(finding!.explanation).toContain('app/s2')
  })

  it('scanAndDetect still flags the earliest high-cost session once the project is mature', async () => {
    const result = await scanAndDetect(
      [projectWithDeliveredSessions([20, 1, 1, 1, 1, 1])],
      optimizeDateRange(3),
    )

    const finding = result.findings.find(f => f.id === 'cost-outliers')
    expect(finding).toBeDefined()
    expect(finding!.explanation).toContain('app/s1')
  })
})

describe('optimize cacheKey collision resistance', () => {
  it('does not collide two datasets that share project count and api-call sum', () => {
    // The old fingerprint was projectCount + sum(api calls) only, so any two
    // datasets agreeing on those two numbers shared one cached OptimizeResult -
    // the second scan got the first's findings. Same shape, different spend must
    // now key differently.
    const a = projectWithSessions([100, 1, 1, 1]) // 4 calls, cost 103
    const b = projectWithSessions([1, 1, 1, 1])   // 4 calls, cost 4
    const range = optimizeDateRange(4)
    expect(a.totalApiCalls).toBe(b.totalApiCalls)
    expect(cacheKey([a], range)).not.toBe(cacheKey([b], range))
  })

  it('is stable for the identical dataset (still caches a genuine repeat)', () => {
    const a = projectWithSessions([5, 3, 2])
    const range = optimizeDateRange(3)
    expect(cacheKey([a], range)).toBe(cacheKey([projectWithSessions([5, 3, 2])], range))
  })

  it('separates a re-price that leaves call count unchanged', () => {
    // A dataset re-priced (cost moves, calls do not) must not serve stale findings.
    const before = projectWithSessions([10, 10])
    const after = projectWithSessions([25, 10]) // same 2 calls, higher cost
    const range = optimizeDateRange(2)
    expect(cacheKey([before], range)).not.toBe(cacheKey([after], range))
  })
})

describe('computeHealth', () => {
  it('returns A with 100 for no findings', () => {
    const { score, grade } = computeHealth([])
    expect(score).toBe(100)
    expect(grade).toBe('A')
  })

  function mockFinding(impact: 'high' | 'medium' | 'low'): WasteFinding {
    return {
      title: 't', explanation: 'e', impact, tokensSaved: 1000,
      fix: { type: 'paste', label: 'l', text: 't' },
    }
  }

  it('one low finding stays at A', () => {
    const { score, grade } = computeHealth([mockFinding('low')])
    expect(score).toBe(97)
    expect(grade).toBe('A')
  })

  it('two high findings drop to C', () => {
    const { score, grade } = computeHealth([mockFinding('high'), mockFinding('high')])
    expect(score).toBe(70)
    expect(grade).toBe('C')
  })

  it('caps penalty at 80 to prevent score below 20', () => {
    const findings = Array.from({ length: 20 }, () => mockFinding('high'))
    const { score } = computeHealth(findings)
    expect(score).toBe(20)
  })

  it('progresses grades predictably', () => {
    expect(computeHealth([mockFinding('low')]).grade).toBe('A')
    expect(computeHealth([mockFinding('medium')]).grade).toBe('A')
    expect(computeHealth([mockFinding('medium'), mockFinding('medium')]).grade).toBe('B')
    expect(computeHealth([mockFinding('high'), mockFinding('high'), mockFinding('high')]).grade).toBe('C')
    expect(computeHealth([mockFinding('high'), mockFinding('high'), mockFinding('high'), mockFinding('high'), mockFinding('high')]).grade).toBe('F')
  })
})

describe('computeTrend', () => {
  const window = 48 * 60 * 60 * 1000
  const baselineWindow = 5 * 24 * 60 * 60 * 1000

  it('returns active when no recent activity detected', () => {
    const trend = computeTrend({
      recentCount: 0, recentWindowMs: window,
      baselineCount: 100, baselineWindowMs: baselineWindow,
      hasRecentActivity: false,
    })
    expect(trend).toBe('active')
  })

  it('returns resolved when recent activity exists but zero waste in it', () => {
    const trend = computeTrend({
      recentCount: 0, recentWindowMs: window,
      baselineCount: 100, baselineWindowMs: baselineWindow,
      hasRecentActivity: true,
    })
    expect(trend).toBe('resolved')
  })

  it('returns improving when recent rate is less than half of baseline rate', () => {
    const trend = computeTrend({
      recentCount: 5, recentWindowMs: window,
      baselineCount: 100, baselineWindowMs: baselineWindow,
      hasRecentActivity: true,
    })
    expect(trend).toBe('improving')
  })

  it('returns active when recent rate matches baseline rate', () => {
    const recentRate = 100 / baselineWindow
    const recentCount = Math.ceil(recentRate * window)
    const trend = computeTrend({
      recentCount, recentWindowMs: window,
      baselineCount: 100, baselineWindowMs: baselineWindow,
      hasRecentActivity: true,
    })
    expect(trend).toBe('active')
  })

  it('returns active when baseline is empty (new finding)', () => {
    const trend = computeTrend({
      recentCount: 10, recentWindowMs: window,
      baselineCount: 0, baselineWindowMs: baselineWindow,
      hasRecentActivity: true,
    })
    expect(trend).toBe('active')
  })
})

describe('paste-fix destination tagging (issue #277)', () => {
  // Walks every emitted finding's fix and asserts that `paste`-type actions
  // declare a destination. Future detectors that ship a paste fix without a
  // destination get caught here so users never see an unlabeled "here's a
  // suggestion" block again.
  function checkAllPasteFixesHaveDestination(findings: WasteFinding[]) {
    for (const f of findings) {
      if (f.fix.type === 'paste') {
        expect(
          f.fix.destination,
          `finding "${f.title}" has paste fix without destination — pick one of: claude-md / session-opener / prompt / shell-config / manual`
        ).toBeDefined()
        expect(['claude-md', 'session-opener', 'prompt', 'shell-config', 'manual'])
          .toContain(f.fix.destination)
      }
    }
  }

  it('detectJunkReads emits a tagged paste fix', () => {
    const calls = Array.from({ length: 5 }, () => call('Read', { file_path: '/x/node_modules/a.js' }))
    checkAllPasteFixesHaveDestination([detectJunkReads(calls)!])
  })

  it('detectDuplicateReads emits a tagged paste fix', () => {
    const calls = [
      ...Array.from({ length: 6 }, () => call('Read', { file_path: '/src/a.ts' }, 's1')),
      ...Array.from({ length: 6 }, () => call('Read', { file_path: '/src/b.ts' }, 's1')),
      ...Array.from({ length: 6 }, () => call('Read', { file_path: '/src/c.ts' }, 's1')),
    ]
    checkAllPasteFixesHaveDestination([detectDuplicateReads(calls)!])
  })

  it('detectLowReadEditRatio emits a tagged paste fix', () => {
    const calls = [
      ...Array.from({ length: 5 }, () => call('Edit', { file_path: '/src/a.ts' })),
      ...Array.from({ length: 5 }, () => call('Edit', { file_path: '/src/b.ts' })),
      ...Array.from({ length: 5 }, () => call('Edit', { file_path: '/src/c.ts' })),
      ...Array.from({ length: 5 }, () => call('Edit', { file_path: '/src/d.ts' })),
      ...Array.from({ length: 5 }, () => call('Edit', { file_path: '/src/e.ts' })),
    ]
    const finding = detectLowReadEditRatio(calls)
    if (finding) checkAllPasteFixesHaveDestination([finding])
  })
})

describe('buildOptimizeJsonReport', () => {
  it('serializes setup health, savings, and fix details for integrations', () => {
    const result: OptimizeResult = {
      costRate: 0.00002,
      healthScore: 72,
      healthGrade: 'C',
      findings: [
        {
          id: 'claude-md-too-long',
          title: 'Trim stale context',
          explanation: 'Old instructions are loaded every turn.',
          impact: 'medium',
          tokensSaved: 50_000,
          trend: 'active',
          fix: {
            type: 'paste',
            label: 'Add guardrail',
            text: 'Prefer short context.',
            destination: 'claude-md',
          },
        },
      ],
    }
    const range = {
      start: new Date('2026-05-01T00:00:00.000Z'),
      end: new Date('2026-05-08T00:00:00.000Z'),
    }

    const report = buildOptimizeJsonReport(
      [projectWithSessions([3, 2])],
      '7 Days',
      result,
      range,
    )

    expect(report.period).toEqual({
      label: '7 Days',
      start: '2026-05-01T00:00:00.000Z',
      end: '2026-05-08T00:00:00.000Z',
    })
    expect(report.summary).toMatchObject({
      healthScore: 72,
      healthGrade: 'C',
      findingCount: 1,
      periodCostUSD: 5,
      sessions: 2,
      calls: 2,
      potentialSavingsTokens: 50_000,
      potentialSavingsCostUSD: 1,
      potentialSavingsPercent: 20,
      costRateUSD: 0.00002,
    })
    expect(report.summary.measuredSavingsUSD).toBe(0)
    expect(report.summary.byClass).toEqual({
      fix: { tokensSaved: 0, savingsUSD: 0, count: 0 },
      nudge: { tokensSaved: 50_000, savingsUSD: 1, count: 1 },
      keep: { tokensSaved: 0, savingsUSD: 0, count: 0 },
    })
    const classes = Object.values(report.summary.byClass)
    expect(classes.reduce((s, c) => s + c.tokensSaved, 0)).toBe(report.summary.potentialSavingsTokens)
    expect(classes.reduce((s, c) => s + c.savingsUSD, 0)).toBeCloseTo(report.summary.potentialSavingsCostUSD, 10)
    expect(classes.reduce((s, c) => s + c.count, 0)).toBe(report.summary.findingCount)
    expect(report.appliedFixes).toEqual([])
    expect(report.findings[0]).toMatchObject({
      title: 'Trim stale context',
      severity: 'medium',
      trend: 'active',
      tokensSaved: 50_000,
      estimatedSavingsUSD: 1,
      class: 'nudge',
      basis: 'estimated',
      fix: {
        type: 'paste',
        destination: 'claude-md',
      },
    })
  })
})

describe('renderOptimize grouping', () => {
  const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, '')

  function finding(id: FindingId, title: string): WasteFinding {
    return {
      id,
      title,
      explanation: 'why',
      impact: 'medium',
      tokensSaved: 1000,
      fix: { type: 'paste', destination: 'prompt', label: 'ask', text: 'ask' },
    }
  }

  it('groups findings under fix / habits / FYI with continuous numbering and a basis split', () => {
    const findings = [
      finding('bash-output-cap', 'Cap bash output'),
      finding('claude-md-too-long', 'Trim CLAUDE.md'),
      finding('context-heavy-sessions', 'Context-heavy sessions'),
    ]
    const out = plain(renderOptimize(findings, 0.00001, '7 Days', 10, 5, 100, 80, 'B', [], []))

    const headers = [
      'Fix now (apply-able) · ~1.0K tokens (~$0.010) · 1 finding — codeburn optimize --apply',
      'Habits · ~1.0K tokens (~$0.010) · 1 finding',
      'FYI · ~1.0K tokens (~$0.010) · 1 finding',
    ].map(h => out.indexOf(h))
    expect(headers.every(i => i >= 0)).toBe(true)
    expect(headers).toEqual([...headers].sort((a, b) => a - b))
    // Headline is the whole board; the apply-able slice is named separately.
    expect(out).toContain('Potential savings: ~3.0K tokens (~$0.030, ~0.3% of spend) — apply-able: ~$0.010')
    expect(out).toContain('1. Cap bash output')
    expect(out).toContain('2. Trim CLAUDE.md')
    expect(out).toContain('3. Context-heavy sessions')
    expect(out).toContain('1 measured · 2 estimated')
    expect(out).not.toContain('Estimates only.')
  })
})

describe('renderOptimize applied-fixes section', () => {
  const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, '')

  function fixture(over: Partial<AppliedFix>): AppliedFix {
    return {
      id: 'abcdef12',
      kind: 'mcp-remove',
      findingId: 'unused-mcp',
      appliedAt: '2026-05-01T00:00:00.000Z',
      ageDays: 4,
      verdict: 'worked',
      estimatedTokens: 300_000,
      realizedTokens: 280_000,
      note: '',
      undoCommand: 'codeburn act undo abcdef12',
      ...over,
    }
  }

  const findings: WasteFinding[] = [{
    id: 'bash-output-cap',
    title: 'Cap bash output',
    explanation: 'why',
    impact: 'medium',
    tokensSaved: 1000,
    fix: { type: 'paste', destination: 'prompt', label: 'ask', text: 'ask' },
  }]

  const render = (appliedFixes: AppliedFix[], f = findings): string =>
    plain(renderOptimize(f, 0.00001, '7 Days', 10, 5, 100, 80, 'B', [], [], undefined, undefined, undefined, appliedFixes))

  it('renders one line per verdict with its own glyph', () => {
    const out = render([
      fixture({}),
      fixture({ id: 'b', findingId: 'mcp-defer-threshold', verdict: 'partial', ageDays: 3, estimatedTokens: 600_000, realizedTokens: 420_000 }),
      fixture({ id: 'c', findingId: 'bash-output-cap', verdict: 'no-effect', ageDays: 5, estimatedTokens: 41_000, realizedTokens: 0, undoCommand: 'codeburn act undo cccccccc' }),
      fixture({ id: 'd', findingId: 'mcp-remove-linear', verdict: 'pending', ageDays: 1 }),
    ])

    expect(out).toContain('Applied fixes')
    expect(out).toContain('\u2713 unused-mcp (4d ago): est. 300.0K -> measured 280.0K')
    expect(out).toContain('~ mcp-defer-threshold (3d ago): est. 600.0K -> measured 420.0K (-30% vs estimate)')
    expect(out).toContain('\u2717 bash-output-cap (5d ago): est. 41.0K -> measured 0 - did not help. Revert: codeburn act undo cccccccc')
    expect(out).toContain('\u2026 mcp-remove-linear (1d ago): measuring, check back after 3 days')
  })

  it('shows the section on a clean setup too, and omits it when nothing is applied', () => {
    expect(render([fixture({})], [])).toContain('Applied fixes')
    expect(render([])).not.toContain('Applied fixes')
    expect(render([], [])).not.toContain('Applied fixes')
  })
})

describe('provider-scoped remediation copy (#1044)', () => {
  const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')

  function promptFinding(label: string): WasteFinding {
    return {
      id: 'retry-heavy-capabilities',
      title: 'retry-heavy',
      explanation: 'why',
      impact: 'medium',
      tokensSaved: 1000,
      fix: { type: 'paste', destination: 'prompt', label, text: 'audit' },
    }
  }

  function openerFinding(label: string): WasteFinding {
    return {
      id: 'low-worth-sessions',
      title: 'low-worth',
      explanation: 'why',
      impact: 'low',
      tokensSaved: 1000,
      fix: { type: 'paste', destination: 'session-opener', label, text: 'open' },
    }
  }

  it('keeps the exact shipped Claude / CLAUDE.md strings', () => {
    for (const provider of [undefined, 'all', 'claude'] as const) {
      const copy = optimizeRemediationCopy(provider)
      expect(copy).toEqual({ agent: 'Claude', instructionFile: 'CLAUDE.md' })
      expect(optimizePasteHeader('prompt', copy)).toBe('Ask Claude in the current session')
      expect(optimizePasteHeader('session-opener', copy)).toBe('One-time session opener (do NOT add to CLAUDE.md)')
      expect(sessionOpenerLabel(copy)).toBe('Paste at the start of your NEXT expensive thread (one-time, do not add to CLAUDE.md):')
      expect(askAgentLabel(copy, 'audit the retry-heavy capability before changing config'))
        .toBe('Ask Claude to audit the retry-heavy capability before changing config:')
      expect(optimizeEmptyScanLines(provider)).toEqual([
        'CodeBurn optimize scans your Claude Code sessions and config for',
        'token waste: junk directory reads, duplicate file reads, unused',
        'agents/skills/MCP servers, bloated CLAUDE.md, and more.',
      ])
      expect(optimizeTuiPasteHeader('session-opener', provider))
        .toBe('── One-time session opener (do not add to CLAUDE.md) '.padEnd(64, '─'))
      expect(optimizeTuiPasteHeader('prompt', provider))
        .toBe('── Ask Claude in the current session '.padEnd(64, '─'))
    }
    const empty = strip(renderOptimize([], 0, 'lifetime', 0, 0, 0, 100, 'A', [], []))
    expect(empty).toContain('CodeBurn optimize scans your Claude Code sessions and config for')
    expect(empty).toContain('bloated CLAUDE.md')
    expect(empty).not.toContain('Claude sessions')
  })

  it('uses Codex / AGENTS.md for --provider codex', () => {
    const copy = optimizeRemediationCopy('codex')
    expect(copy).toEqual({ agent: 'Codex', instructionFile: 'AGENTS.md' })
    expect(optimizePasteHeader('prompt', copy)).toBe('Ask Codex in the current session')
    expect(optimizePasteHeader('session-opener', copy)).toBe('One-time session opener (do NOT add to AGENTS.md)')
    expect(sessionOpenerLabel(copy)).toContain('AGENTS.md')
    expect(sessionOpenerLabel(copy)).not.toContain('CLAUDE.md')
    expect(optimizeEmptyScanLines('codex')[0]).toBe('Session-scan detectors do not cover Codex yet.')
    expect(optimizeEmptyScanLines('codex')[2]).toContain('currently scan Claude Code only')
    expect(optimizeEmptyScanLines('codex').join(' ')).not.toContain('scans your Codex')
    expect(optimizeEmptyScanLines('codex').join(' ')).not.toContain('bloated AGENTS.md')
    expect(optimizeTuiPasteHeader('prompt', 'codex')).toContain('Ask Codex in the current session')
    expect(optimizeTuiPasteHeader('session-opener', 'codex')).toContain('do NOT add to AGENTS.md')
    expect(optimizeTuiPasteHeader('session-opener', 'codex')).not.toContain('CLAUDE.md')
  })

  it('uses the canonical Provider.displayName, not a title-cased id', () => {
    expect(optimizeRemediationCopy('hermes').agent).toBe('Hermes Agent')
    expect(optimizeRemediationCopy('cursor').agent).toBe('Cursor')
    expect(optimizeRemediationCopy('cursor').instructionFile).toBe('project instructions')
    expect(optimizePasteHeader('session-opener', optimizeRemediationCopy('cursor')))
      .toBe('One-time session opener (do NOT add to project instructions)')
  })

  it('scopes every cross-provider detector label, including JSON', () => {
    const lowWorth = detectLowWorthSessions([
      projectWithLowWorthSessions([lowWorthSession(4, 0, { turns: [lowWorthTurn({ hasEdits: false })] })]),
    ], 'codex')
    const context = detectContextBloat([
      projectWithContextSessions([contextSession(0, {
        totalInputTokens: 90_000,
        totalCacheReadTokens: 30_000,
        totalOutputTokens: 2_000,
      })]),
    ], undefined, 'codex')
    const outliers = detectSessionOutliers([projectWithSessions([1, 1, 1, 10])], undefined, 'codex')
    const turns = Array.from({ length: 5 }, (_, i) => reliabilityTurn(i, {
      retries: i < 3 ? 1 : 0,
      call: { tools: ['Edit', 'Skill'], skills: ['reviewer'] },
    }))
    const retry = detectCapabilityReliability([projectWithReliabilityTurns(turns)], 'codex')

    const findings = [lowWorth, context, outliers, retry]
    expect(findings.every(Boolean)).toBe(true)
    for (const finding of findings) {
      expect(finding!.fix.label).not.toContain('Claude')
      expect(finding!.fix.label).not.toContain('CLAUDE.md')
    }
    expect(lowWorth!.fix.label).toContain('AGENTS.md')
    expect(context!.fix.label).toContain('AGENTS.md')
    expect(outliers!.fix.label).toContain('AGENTS.md')
    expect(retry!.fix.label).toBe('Ask Codex to audit the retry-heavy capability before changing config:')

    const json = buildOptimizeJsonReport(
      [projectWithSessions([1])],
      'lifetime',
      { findings: findings as WasteFinding[], costRate: 0.00001, healthScore: 80, healthGrade: 'B', modelRecommendations: [] },
    )
    expect(json.findings).toHaveLength(4)
    for (const row of json.findings) {
      expect(row.fix.label).not.toContain('Claude')
      expect(row.fix.label).not.toContain('CLAUDE.md')
    }
  })

  it('renders destination headers from the selected provider, not the finding text', () => {
    const out = strip(renderOptimize(
      [promptFinding('Ask Claude to audit the retry-heavy capability before changing config:')],
      0.00001, 'lifetime', 10, 5, 100, 80, 'B', [], [],
      undefined, undefined, undefined, [], 'codex',
    ))
    expect(out).toContain('Ask Codex in the current session')
    expect(out).not.toContain('Ask Claude in the current session')

    const opener = strip(renderOptimize(
      [openerFinding('Paste at the start of your NEXT expensive thread (one-time, do not add to CLAUDE.md):')],
      0.00001, 'lifetime', 10, 5, 100, 80, 'B', [], [],
      undefined, undefined, undefined, [], 'codex',
    ))
    expect(opener).toContain('do NOT add to AGENTS.md')
    expect(opener).not.toContain('do NOT add to CLAUDE.md')
  })
})
