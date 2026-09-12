import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildSessionContributions, withContributions } from '../src/session-contributions.js'
import { aggregateSessions } from '../src/sessions-report.js'
import { dateKey } from '../src/day-aggregator.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary, TokenUsage } from '../src/types.js'
import { CLEARED, REDIRECTED } from './setup/env-isolation-vars.js'

function usage(input: number, output: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
}

function call(overrides: Partial<ParsedApiCall> & { costUSD: number; timestamp: string }): ParsedApiCall {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    usage: usage(100, 20),
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    bashCommands: [],
    deduplicationKey: `call-${Math.random()}`,
    ...overrides,
  } as ParsedApiCall
}

function turn(overrides: Partial<ClassifiedTurn> & { timestamp: string; assistantCalls: ParsedApiCall[] }): ClassifiedTurn {
  return {
    userMessage: 'work',
    sessionId: 'session-1',
    category: 'coding',
    retries: 0,
    hasEdits: false,
    ...overrides,
  }
}

function sessionWith(turns: ClassifiedTurn[], extra: Partial<SessionSummary> = {}): SessionSummary {
  const cost = turns.reduce((sum, t) => sum + t.assistantCalls.reduce((s, c) => s + c.costUSD, 0), 0)
  return {
    sessionId: 'session-1',
    project: 'codeburn',
    firstTimestamp: turns[0]?.timestamp ?? '',
    lastTimestamp: turns.at(-1)?.timestamp ?? '',
    totalCostUSD: cost,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.reduce((sum, t) => sum + t.assistantCalls.length, 0),
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
    ...extra,
  }
}

function projectOf(session: SessionSummary): ProjectSummary {
  return {
    project: session.project,
    projectPath: `/tmp/${session.project}`,
    sessions: [session],
    totalCostUSD: session.totalCostUSD,
    totalSavingsUSD: session.totalSavingsUSD,
    totalApiCalls: session.apiCalls,
    totalProxiedCostUSD: 0,
  }
}

const DAY1 = '2026-09-10T10:00:00.000Z'
const DAY2 = '2026-09-11T10:00:00.000Z'

describe('session contribution segments', () => {
  it('reconciles a single midnight-straddling turn with daily call accounting', () => {
    const before = new Date(2026, 8, 10, 23, 59).toISOString()
    const after = new Date(2026, 8, 11, 0, 1).toISOString()
    const session = sessionWith([turn({ timestamp: before, assistantCalls: [
      call({ timestamp: before, costUSD: 3 }),
      call({ timestamp: after, costUSD: 5 }),
    ] })])
    const segments = buildSessionContributions(session).segments
    const daily = aggregateProjectsIntoDays([projectOf(session)])
    expect(segments.map(s => [s.day, s.cost, s.calls])).toEqual([
      ['2026-09-10', 3, 1], ['2026-09-11', 5, 1],
    ])
    expect(segments.map(s => [s.day, s.cost])).toEqual(daily.map(d => [d.date, d.cost]))
  })

  it('retains per-model counts independently of price and supplementary accounting', () => {
    const session = sessionWith([turn({ timestamp: DAY1, assistantCalls: [
      call({ timestamp: DAY1, model: 'claude-opus-4-6', costUSD: 9, usage: usage(100, 0) }),
      call({ timestamp: DAY1, model: 'claude-sonnet-4-5', costUSD: 1, usage: usage(900, 0) }),
      call({ timestamp: DAY1, model: 'claude-opus-4-6', costUSD: 2, usage: usage(50, 0), supplementaryAccounting: true }),
      call({ timestamp: DAY1, model: 'free-model', costUSD: 0, usage: usage(75, 0) }),
    ] })])
    const segment = buildSessionContributions(session).segments[0]!
    expect(segment.modelUsage!['Opus 4.6']).toEqual({ calls: 1, inputTokens: 150, outputTokens: 0 })
    expect(segment.modelUsage!['Sonnet 4.5']).toEqual({ calls: 1, inputTokens: 900, outputTokens: 0 })
    expect(Object.values(segment.modelUsage!).reduce((sum, value) => sum + value.calls, 0)).toBe(3)
    expect(Object.values(segment.modelUsage!).reduce((sum, value) => sum + value.inputTokens, 0)).toBe(1125)
    expect(segment.models['Opus 4.6']).toBe(11)
  })

  it('partition a session across days: sum(segments.cost) == session cost', () => {
    const session = sessionWith([
      turn({ timestamp: DAY1, category: 'coding', assistantCalls: [call({ costUSD: 0.4, timestamp: DAY1 })] }),
      turn({ timestamp: DAY2, category: 'coding', assistantCalls: [call({ costUSD: 0.6, timestamp: DAY2 })] }),
    ])
    const { segments } = buildSessionContributions(session)
    expect(segments.map(s => s.day)).toEqual([dateKey(DAY1), dateKey(DAY2)])
    expect(segments.reduce((sum, s) => sum + s.cost, 0)).toBeCloseTo(session.totalCostUSD, 10)
    // A session started on DAY1 with activity on DAY2 contributes to BOTH days.
    const day1 = segments.find(s => s.day === dateKey(DAY1))!
    expect(day1.cost).toBeCloseTo(0.4, 10)
  })

  it('carry the 100/20 category fixture: 20 of 100 belongs to the selected category', () => {
    // Session cost 1.00: 0.20 coding, 0.80 debugging. A category=coding drill
    // selection must show 0.20 for this session, never the whole 1.00.
    const session = sessionWith([
      turn({ timestamp: DAY1, category: 'coding', assistantCalls: [call({ costUSD: 0.2, timestamp: DAY1 })] }),
      turn({ timestamp: DAY1, category: 'debugging', assistantCalls: [call({ costUSD: 0.8, timestamp: DAY1 })] }),
    ])
    const { segments } = buildSessionContributions(session)
    expect(segments).toHaveLength(2)
    const coding = segments.filter(s => s.category === 'coding').reduce((sum, s) => sum + s.cost, 0)
    const debugging = segments.filter(s => s.category === 'debugging').reduce((sum, s) => sum + s.cost, 0)
    expect(coding).toBeCloseTo(0.2, 10)
    expect(debugging).toBeCloseTo(0.8, 10)
  })

  it('attribute PRs with carry-forward and keep multi-PR sets whole', () => {
    const prA = 'https://github.com/owner/repo-a/pull/123'
    const prB = 'https://github.com/owner/repo-b/pull/123'
    const session = sessionWith([
      // Before the first reference: unattributed (prs: []).
      turn({ timestamp: DAY1, assistantCalls: [call({ costUSD: 0.1, timestamp: DAY1 })] }),
      turn({ timestamp: DAY1, assistantCalls: [call({ costUSD: 0.2, timestamp: DAY1 })], prRefs: [prA] }),
      // Ref-less turn after a reference: carried forward to prA.
      turn({ timestamp: DAY1, assistantCalls: [call({ costUSD: 0.3, timestamp: DAY1 })] }),
      // Merge-sweep turn touching two PRs: listed as the whole set.
      turn({ timestamp: DAY2, assistantCalls: [call({ costUSD: 0.4, timestamp: DAY2 })], prRefs: [prA, prB] }),
    ])
    const { segments } = buildSessionContributions(session)
    // Turns 2 and 3 merge (same day/category/branch/PR set).
    expect(segments.map(s => s.prs)).toEqual([[], [prA], [prA, prB]])
    // One PR's share of the multi-PR segment is 1/len of it, not the full amount.
    const multi = segments.find(s => s.prs.length === 2)!
    expect(multi.cost / multi.prs.length).toBeCloseTo(0.2, 10)
  })

  it('seed the PR set from prRefsAtRangeStart for ref-less in-range turns', () => {
    const pr = 'https://github.com/owner/repo/pull/9'
    const session = sessionWith(
      [turn({ timestamp: DAY1, assistantCalls: [call({ costUSD: 0.5, timestamp: DAY1 })] })],
      { prRefsAtRangeStart: [pr] },
    )
    const { segments } = buildSessionContributions(session)
    expect(segments[0]!.prs).toEqual([pr])
  })

  it('carry the git branch forward across turns like aggregateByBranch', () => {
    const session = sessionWith([
      turn({ timestamp: DAY1, gitBranch: 'main', assistantCalls: [call({ costUSD: 0.1, timestamp: DAY1 })] }),
      turn({ timestamp: DAY1, assistantCalls: [call({ costUSD: 0.2, timestamp: DAY1 })] }),
      turn({ timestamp: DAY1, gitBranch: 'feat/x', assistantCalls: [call({ costUSD: 0.3, timestamp: DAY1 })] }),
    ])
    const { segments } = buildSessionContributions(session)
    // Turns 1 and 2 merge (turn 2 carries main). The carried turn's 0.2 lands
    // in the main segment: 0.1 + 0.2 = 0.3, proving the carry-forward.
    expect(segments.map(s => s.branch)).toEqual(['main', 'feat/x'])
    expect(segments[0]!.cost).toBeCloseTo(0.3, 10)
    expect(segments[1]!.cost).toBeCloseTo(0.3, 10)
  })

  it('merge consecutive same-context turns and split on any key change', () => {
    const pr = 'https://github.com/owner/repo/pull/1'
    const session = sessionWith([
      turn({ timestamp: DAY1, category: 'coding', gitBranch: 'main', assistantCalls: [call({ costUSD: 0.1, timestamp: DAY1 })], prRefs: [pr] }),
      turn({ timestamp: DAY1, category: 'coding', gitBranch: 'main', assistantCalls: [call({ costUSD: 0.1, timestamp: DAY1 })], prRefs: [] }),
      turn({ timestamp: DAY1, category: 'testing', gitBranch: 'main', assistantCalls: [call({ costUSD: 0.1, timestamp: DAY1 })] }),
    ])
    const { segments } = buildSessionContributions(session)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.cost).toBeCloseTo(0.2, 10)
    expect(segments[0]!.calls).toBe(2)
    expect(segments[1]!.category).toBe('testing')
  })

  it('key models by the modelBreakdown short-name family and reconcile to segment cost', () => {
    const session = sessionWith([
      turn({
        timestamp: DAY1,
        assistantCalls: [
          call({ costUSD: 0.3, model: 'claude-sonnet-4-5', timestamp: DAY1 }),
          call({ costUSD: 0.7, model: 'gpt-5.5-codex', provider: 'codex', timestamp: DAY1 }),
          call({ costUSD: 0.1, model: '', timestamp: DAY1 }),
        ],
      }),
    ])
    const { segments } = buildSessionContributions(session)
    const models = segments[0]!.models
    expect(Object.keys(models).sort()).toEqual(['', 'GPT-5.5', 'Sonnet 4.5'])
    const modelSum = Object.values(models).reduce((sum, value) => sum + value, 0)
    expect(modelSum).toBeCloseTo(segments[0]!.cost, 10)
  })

  it('skip genuinely empty turns but keep tokens-only turns', () => {
    const empty = call({ costUSD: 0, timestamp: DAY1 })
    empty.usage = usage(0, 0)
    const tokensOnly = call({ costUSD: 0, timestamp: DAY1 })
    tokensOnly.usage = usage(500, 0)
    const session = sessionWith([
      turn({ timestamp: DAY1, assistantCalls: [empty] }),
      turn({ timestamp: DAY1, assistantCalls: [tokensOnly] }),
    ])
    const { segments } = buildSessionContributions(session)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.cost).toBe(0)
    expect(segments[0]!.inputTokens).toBe(500)
  })

  it('keep calls behavioral-only, mirroring the row turn/call semantics', () => {
    const supplementary = call({ costUSD: 0.25, timestamp: DAY1 })
    supplementary.supplementaryAccounting = true
    const session = sessionWith([turn({ timestamp: DAY1, assistantCalls: [supplementary] })])
    const { segments } = buildSessionContributions(session)
    expect(segments[0]!.calls).toBe(0)
    expect(segments[0]!.cost).toBeCloseTo(0.25, 10)
  })

  it('keep the legacy even-split: prLinks-only sessions carry the whole set with approx', () => {
    const prA = 'https://github.com/owner/legacy/pull/7'
    const prB = 'https://github.com/owner/legacy/pull/8'
    const session = sessionWith(
      [
        turn({ timestamp: DAY1, assistantCalls: [call({ costUSD: 0.3, timestamp: DAY1 })] }),
        turn({ timestamp: DAY2, assistantCalls: [call({ costUSD: 0.7, timestamp: DAY2 })] }),
      ],
      { prLinks: [prA, prB] },
    )
    const { segments } = buildSessionContributions(session)
    expect(segments).toHaveLength(2)
    for (const segment of segments) {
      expect(segment.prs).toEqual([prA, prB])
      expect(segment.approx).toBe(true)
    }
    // One PR's share of a segment is 1/len of it, mirroring the by-PR report.
    expect(segments[0]!.cost / segments[0]!.prs.length).toBeCloseTo(0.15, 10)
  })
})

describe('withContributions', () => {
  it('keeps same-id sessions in different providers separate regardless of row order', () => {
    const claude = sessionWith([turn({ timestamp: DAY1, assistantCalls: [call({ timestamp: DAY1, costUSD: 2, provider: 'claude' })] })])
    const codex = sessionWith([turn({ timestamp: DAY1, assistantCalls: [call({ timestamp: DAY1, costUSD: 9, provider: 'codex' })] })])
    const projects = [{ ...projectOf(claude), sessions: [claude, codex] }]
    const result = withContributions(aggregateSessions(projects).reverse(), projects)
    expect(result.map(r => [r.provider, r.cost, r.contributions!.segments[0]!.cost])).toEqual([
      ['codex', 9, 9], ['claude', 2, 2],
    ])
  })

  it('leaves ambiguous same-provider identities unannotated instead of overwriting', () => {
    const first = sessionWith([turn({ timestamp: DAY1, assistantCalls: [call({ timestamp: DAY1, costUSD: 2 })] })])
    const second = sessionWith([turn({ timestamp: DAY1, assistantCalls: [call({ timestamp: DAY1, costUSD: 9 })] })])
    const projects = [projectOf(first), { ...projectOf(second), projectPath: '/different/path' }]
    const result = withContributions(aggregateSessions(projects), projects)
    expect(result.map(r => r.cost)).toEqual([2, 9])
    expect(result.every(r => r.contributions === undefined)).toBe(true)
  })

  it('zip rows to sessions in aggregateSessions order and attach lineage fields', () => {
    const session = sessionWith(
      [turn({ timestamp: DAY1, assistantCalls: [call({ costUSD: 0.5, timestamp: DAY1 })] })],
      { sessionId: 'agent-child-1', parentSessionId: 'parent-1', agentId: 'child-1', isSidechain: true },
    )
    const projects = [projectOf(session)]
    const rows = withContributions(aggregateSessions(projects), projects)
    expect(rows[0]!.parentSessionId).toBe('parent-1')
    expect(rows[0]!.agentId).toBe('child-1')
    expect(rows[0]!.isSidechain).toBe(true)
    expect(rows[0]!.contributions!.segments[0]!.cost).toBeCloseTo(0.5, 10)
  })

  it('degrade to un-annotated rows instead of wrong attribution on drift', () => {
    const session = sessionWith([turn({ timestamp: DAY1, assistantCalls: [call({ costUSD: 0.5, timestamp: DAY1 })] })])
    const projects = [projectOf(session)]
    const rows = aggregateSessions(projects)
    // A row whose identity no longer matches any session (drift guard) must
    // come back WITHOUT contributions rather than with another session's.
    rows[0]!.sessionId = 'different-id'
    const annotated = withContributions(rows, projects)
    expect(annotated[0]!.contributions).toBeUndefined()
  })

  it('resolve the row project through the project fallback like aggregateSessions', () => {
    const session = sessionWith([turn({ timestamp: DAY1, assistantCalls: [call({ costUSD: 0.5, timestamp: DAY1 })] })])
    session.project = ''
    const projects = [projectOf(session)]
    const rows = withContributions(aggregateSessions(projects), projects)
    expect(rows[0]!.contributions).toBeDefined()
  })
})

describe('sessions --contributions CLI flag', () => {
  it('emits drill rows whose segments reconcile to the session cost', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-contributions-'))
    try {
      const cwd = '/tmp/contributions-project'
      const projectDir = join(home, '.claude', 'projects', 'project-a')
      await mkdir(projectDir, { recursive: true })
      const ts = '2026-09-10T10:00:00.000Z'
      const lines = [
        JSON.stringify({ type: 'user', sessionId: 'contrib-session', timestamp: ts, cwd, message: { role: 'user', content: 'task' } }),
        JSON.stringify({
          type: 'assistant', sessionId: 'contrib-session', timestamp: ts, cwd, gitBranch: 'main',
          message: {
            id: 'resp-1', role: 'assistant', model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1000, output_tokens: 100 },
          },
        }),
      ]
      await writeFile(join(projectDir, 'contrib-session.jsonl'), lines.join('\n') + '\n')

      const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', TZ: 'UTC', CODEBURN_PRICING_SNAPSHOT_ONLY: '1', CODEBURN_FX_NO_FETCH: '1' }
      for (const key of CLEARED) delete env[key]
      for (const key of REDIRECTED) env[key] = home
      env.CLAUDE_CONFIG_DIR = join(home, '.claude')
      env.CODEBURN_CACHE_DIR = join(home, '.cache', 'codeburn')

      const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'sessions', '--format', 'json', '--contributions', '--period', 'lifetime'], {
        cwd: process.cwd(), env, encoding: 'utf-8', timeout: 120_000,
      })
      expect(run.status).toBe(0)
      const rows = JSON.parse(run.stdout) as Array<{ sessionId: string; cost: number; contributions?: { segments: Array<{ day: string; cost: number; branch: string | null; models: Record<string, number> }> } }>
      const row = rows.find(r => r.sessionId === 'contrib-session')
      expect(row).toBeDefined()
      expect(row!.contributions).toBeDefined()
      const segments = row!.contributions!.segments
      expect(segments.reduce((sum, s) => sum + s.cost, 0)).toBeCloseTo(row!.cost, 6)
      expect(segments[0]!.day).toBe('2026-09-10')
      expect(segments[0]!.branch).toBe('main')
      expect(Object.keys(segments[0]!.models)).toContain('Sonnet 4.5')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
