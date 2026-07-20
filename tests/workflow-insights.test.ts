import { describe, expect, it } from 'vitest'

import {
  scanUserCorrections,
  medianTimeToFirstEditMs,
  aggregateFileChurn,
  computePricingCoverage,
  worstOneShotCategory,
  buildCoachingNotes,
  USER_CORRECTION_PATTERNS,
} from '../src/workflow-insights.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary, TaskCategory, ToolCall } from '../src/types.js'

function call(opts: { tools?: string[]; timestamp?: string; toolSequence?: ToolCall[][]; model?: string; costUSD?: number } = {}): ParsedApiCall {
  return {
    provider: 'claude',
    model: opts.model ?? 'claude-sonnet-4-5',
    usage: {
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
    },
    costUSD: opts.costUSD ?? 0,
    tools: opts.tools ?? [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: opts.timestamp ?? '2026-05-05T00:00:00.000Z',
    bashCommands: [],
    deduplicationKey: 'k',
    ...(opts.toolSequence ? { toolSequence: opts.toolSequence } : {}),
  }
}

function turn(opts: { userMessage?: string; calls?: ParsedApiCall[]; timestamp?: string; sessionId?: string } = {}): ClassifiedTurn {
  return {
    userMessage: opts.userMessage ?? '',
    assistantCalls: opts.calls ?? [],
    timestamp: opts.timestamp ?? '2026-05-05T00:00:00.000Z',
    sessionId: opts.sessionId ?? 's1',
    category: 'coding',
    retries: 0,
    hasEdits: (opts.calls ?? []).some(c => c.tools.some(t => t === 'Edit' || t === 'Write')),
  }
}

function session(sessionId: string, turns: ClassifiedTurn[], categoryBreakdown: SessionSummary['categoryBreakdown'] = {} as SessionSummary['categoryBreakdown']): SessionSummary {
  return {
    sessionId,
    project: 'app',
    firstTimestamp: turns[0]?.timestamp ?? '2026-05-05T00:00:00.000Z',
    lastTimestamp: '2026-05-05T01:00:00.000Z',
    totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
    totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalSavingsUSD: 0,
    apiCalls: turns.reduce((s, t) => s + t.assistantCalls.length, 0),
    turns,
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown,
    skillBreakdown: {}, subagentBreakdown: {},
  }
}

function project(sessions: SessionSummary[], projectPath = '/home/u/app'): ProjectSummary {
  return {
    project: 'app', projectPath, sessions,
    totalCostUSD: 0, totalSavingsUSD: 0, totalApiCalls: 0, totalProxiedCostUSD: 0,
  }
}

function cat(editTurns: number, oneShotTurns: number): SessionSummary['categoryBreakdown'][TaskCategory] {
  return { turns: editTurns, costUSD: 0, savingsUSD: 0, retries: 0, editTurns, oneShotTurns }
}

describe('scanUserCorrections', () => {
  it('counts turns whose user message signals a correction', () => {
    const p = project([session('s1', [
      turn({ userMessage: "no, I meant the other file" }),
      turn({ userMessage: "that's not what I asked for" }),
      turn({ userMessage: "you missed the edge case" }),
      turn({ userMessage: "revert that change" }),
      turn({ userMessage: "add a new feature please" }),
    ])])
    const r = scanUserCorrections([p])
    expect(r.corrections).toBe(4)
    expect(r.userTurns).toBe(5)
    expect(r.correctionRate).toBeCloseTo(0.8)
  })

  it('does not flag praise or ordinary requests (false-positive guards)', () => {
    const phrases = [
      'you were right about that',
      "you're right, thanks",
      "that's right, ship it",
      'looks correct to me',
      'undo the migration when done',
      'the build is failing, can you fix it',
      'what went wrong here',
    ]
    const p = project([session('s1', phrases.map(m => turn({ userMessage: m })))])
    const r = scanUserCorrections([p])
    expect(r.corrections).toBe(0)
  })

  it('ignores continuation turns with no fresh prompt', () => {
    const p = project([session('s1', [
      turn({ userMessage: '' }),
      turn({ userMessage: '   ' }),
      turn({ userMessage: 'that is wrong' }),
    ])])
    const r = scanUserCorrections([p])
    expect(r.userTurns).toBe(1)
    expect(r.corrections).toBe(1)
    expect(r.correctionRate).toBe(1)
  })

  it('returns a null rate for empty input', () => {
    const r = scanUserCorrections([])
    expect(r).toEqual({ corrections: 0, userTurns: 0, correctionRate: null })
  })

  it('every pattern is case-insensitive', () => {
    for (const re of USER_CORRECTION_PATTERNS) expect(re.flags).toContain('i')
  })
})

describe('medianTimeToFirstEditMs', () => {
  const edit = (ts: string) => call({ tools: ['Edit'], timestamp: ts })

  it('measures from the first turn to the first edit call', () => {
    const s = session('s1', [
      turn({ timestamp: '2026-05-05T00:00:00.000Z', calls: [call({ tools: ['Read'], timestamp: '2026-05-05T00:00:10.000Z' })] }),
      turn({ timestamp: '2026-05-05T00:01:00.000Z', calls: [edit('2026-05-05T00:00:30.000Z')] }),
    ])
    expect(medianTimeToFirstEditMs([project([s])])).toBe(30_000)
  })

  it('excludes sessions with no edits (not counted as zero)', () => {
    const withEdit = session('s1', [turn({ timestamp: '2026-05-05T00:00:00.000Z', calls: [edit('2026-05-05T00:00:20.000Z')] })])
    const noEdit = session('s2', [turn({ timestamp: '2026-05-05T00:00:00.000Z', calls: [call({ tools: ['Read'], timestamp: '2026-05-05T00:05:00.000Z' })] })])
    expect(medianTimeToFirstEditMs([project([withEdit, noEdit])])).toBe(20_000)
  })

  it('takes the median across sessions (even count averages the middle two)', () => {
    const mk = (id: string, secs: number) => session(id, [turn({ timestamp: '2026-05-05T00:00:00.000Z', calls: [edit(new Date(Date.parse('2026-05-05T00:00:00.000Z') + secs * 1000).toISOString())] })])
    // deltas: 10, 20, 30, 40 -> median (20+30)/2 = 25s
    expect(medianTimeToFirstEditMs([project([mk('a', 10), mk('b', 20), mk('c', 30), mk('d', 40)])])).toBe(25_000)
  })

  it('clamps out-of-order timestamps to zero', () => {
    const s = session('s1', [turn({ timestamp: '2026-05-05T00:01:00.000Z', calls: [edit('2026-05-05T00:00:00.000Z')] })])
    expect(medianTimeToFirstEditMs([project([s])])).toBe(0)
  })

  it('returns null when no session has an edit', () => {
    const s = session('s1', [turn({ timestamp: '2026-05-05T00:00:00.000Z', calls: [call({ tools: ['Read'] })] })])
    expect(medianTimeToFirstEditMs([project([s])])).toBeNull()
  })
})

describe('aggregateFileChurn', () => {
  const editSeq = (file: string): ToolCall[][] => [[{ tool: 'Edit', file }]]

  it('ranks by distinct sessions then total edits, and relativizes paths', () => {
    const s1 = session('s1', [
      turn({ sessionId: 's1', calls: [call({ tools: ['Edit'], toolSequence: editSeq('/home/u/app/src/a.ts') })] }),
      turn({ sessionId: 's1', calls: [call({ tools: ['Edit'], toolSequence: editSeq('/home/u/app/src/a.ts') })] }),
      turn({ sessionId: 's1', calls: [call({ tools: ['Write'], toolSequence: [[{ tool: 'Write', file: '/home/u/app/src/b.ts' }]] })] }),
    ])
    const s2 = session('s2', [
      turn({ sessionId: 's2', calls: [call({ tools: ['Edit'], toolSequence: editSeq('/home/u/app/src/a.ts') })] }),
    ])
    const files = aggregateFileChurn([project([s1, s2])])
    expect(files[0]).toEqual({ path: 'src/a.ts', sessions: 2, edits: 3 })
    expect(files[1]).toEqual({ path: 'src/b.ts', sessions: 1, edits: 1 })
  })

  it('breaks a session-count tie by edits then path', () => {
    const s = session('s1', [
      turn({ sessionId: 's1', calls: [call({ tools: ['Edit'], toolSequence: editSeq('/home/u/app/z.ts') })] }),
      turn({ sessionId: 's1', calls: [call({ tools: ['Edit'], toolSequence: editSeq('/home/u/app/z.ts') })] }),
      turn({ sessionId: 's1', calls: [call({ tools: ['Edit'], toolSequence: editSeq('/home/u/app/a.ts') })] }),
    ])
    const files = aggregateFileChurn([project([s])])
    // both touched by 1 session; z.ts has more edits so it ranks first
    expect(files.map(f => f.path)).toEqual(['z.ts', 'a.ts'])
  })

  it('ignores non-edit tools and calls without a file path', () => {
    const s = session('s1', [
      turn({ sessionId: 's1', calls: [call({ tools: ['Read'], toolSequence: [[{ tool: 'Read', file: '/home/u/app/r.ts' }]] })] }),
      turn({ sessionId: 's1', calls: [call({ tools: ['Edit'], toolSequence: [[{ tool: 'Edit' }]] })] }),
    ])
    expect(aggregateFileChurn([project([s])])).toEqual([])
  })

  it('respects the limit', () => {
    const turns = Array.from({ length: 5 }, (_, i) =>
      turn({ sessionId: 's1', calls: [call({ tools: ['Edit'], toolSequence: editSeq(`/home/u/app/f${i}.ts`) })] }))
    const files = aggregateFileChurn([project([session('s1', turns)])], 3)
    expect(files).toHaveLength(3)
  })
})

describe('computePricingCoverage', () => {
  it('is 1 when everything is priced', () => {
    expect(computePricingCoverage(100, 0)).toBe(1)
  })
  it('is the priced share when some calls are unpriced', () => {
    expect(computePricingCoverage(100, 25)).toBe(0.75)
  })
  it('is 1 when there are no cost-bearing calls', () => {
    expect(computePricingCoverage(0, 0)).toBe(1)
  })
  it('clamps to 0 if unpriced somehow exceeds the total', () => {
    expect(computePricingCoverage(10, 20)).toBe(0)
  })
})

describe('worstOneShotCategory', () => {
  it('picks the lowest one-shot rate above the edit-turn floor', () => {
    const s = session('s1', [], {
      feature: cat(10, 3),   // 30%
      debugging: cat(8, 6),  // 75%
    } as SessionSummary['categoryBreakdown'])
    const worst = worstOneShotCategory([project([s])])
    expect(worst?.category).toBe('Feature Dev')
    expect(worst?.rate).toBe(30)
    expect(worst?.editTurns).toBe(10)
  })

  it('excludes categories below the edit-turn floor', () => {
    const s = session('s1', [], {
      feature: cat(2, 0),    // 0% but only 2 edit turns
      debugging: cat(10, 8), // 80%
    } as SessionSummary['categoryBreakdown'])
    const worst = worstOneShotCategory([project([s])])
    expect(worst?.category).toBe('Debugging')
  })

  it('returns null when nothing qualifies', () => {
    const s = session('s1', [], { feature: cat(1, 0) } as SessionSummary['categoryBreakdown'])
    expect(worstOneShotCategory([project([s])])).toBeNull()
  })
})

describe('buildCoachingNotes', () => {
  it('emits a note per strong signal and never uses em-dashes', () => {
    const notes = buildCoachingNotes({
      worstOneShot: { category: 'Feature Dev', rate: 40, editTurns: 12 },
      corrections: 6,
      correctionRate: 0.2,
      topReworkedFile: { path: 'src/a.ts', sessions: 4, edits: 20 },
      medianTimeToFirstEditMs: 6 * 60 * 1000,
    })
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.length).toBeLessThanOrEqual(3)
    for (const n of notes) expect(n).not.toContain('—')
  })

  it('caps at 3 notes even when all four signals fire', () => {
    const notes = buildCoachingNotes({
      worstOneShot: { category: 'Feature Dev', rate: 40, editTurns: 12 },
      corrections: 6,
      correctionRate: 0.2,
      topReworkedFile: { path: 'src/a.ts', sessions: 4, edits: 20 },
      medianTimeToFirstEditMs: 6 * 60 * 1000,
    })
    expect(notes).toHaveLength(3)
  })

  it('stays silent when every signal is below threshold', () => {
    const notes = buildCoachingNotes({
      worstOneShot: { category: 'Feature Dev', rate: 90, editTurns: 12 },
      corrections: 1,
      correctionRate: 0.02,
      topReworkedFile: { path: 'src/a.ts', sessions: 1, edits: 2 },
      medianTimeToFirstEditMs: 10 * 1000,
    })
    expect(notes).toEqual([])
  })

  it('requires both a high rate and a minimum count for the correction note', () => {
    const highRateLowCount = buildCoachingNotes({ correctionRate: 0.5, corrections: 1 })
    expect(highRateLowCount).toEqual([])
  })
})
