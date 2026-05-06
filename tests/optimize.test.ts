import { describe, it, expect } from 'vitest'

import {
  detectJunkReads,
  detectDuplicateReads,
  detectLowReadEditRatio,
  detectCacheBloat,
  detectBloatedClaudeMd,
  detectContextBloat,
  detectLowWorthSessions,
  detectSessionOutliers,
  computeHealth,
  computeTrend,
  type ToolCall,
  type ApiCallMeta,
  type WasteFinding,
} from '../src/optimize.js'
import type { ProjectSummary } from '../src/types.js'

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
    // sets input=output=cost*1000, so the savings ceiling is 2x cost*1000.
    expect(finding!.tokensSaved).toBe(8_000)
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

  it('uses full session tokens as the savings ceiling for no-edit sessions', () => {
    const project = projectWithLowWorthSessions([
      lowWorthSession(4, 0, { turns: [lowWorthTurn({ hasEdits: false })] }),
    ])
    const finding = detectLowWorthSessions([project])
    // No edits at all -> entire session is at risk. sessionTokenTotal = 8K.
    expect(finding!.tokensSaved).toBe(8_000)
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
