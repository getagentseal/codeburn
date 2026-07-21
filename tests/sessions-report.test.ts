import { describe, expect, it } from 'vitest'

import { aggregateSessions, renderJson, renderTable } from '../src/sessions-report.js'
import type { ClassifiedTurn, ProjectSummary, SessionSummary } from '../src/types.js'

function makeProject(): ProjectSummary {
  const turn: ClassifiedTurn = {
    userMessage: 'build it',
    timestamp: '2026-07-10T10:00:00.000Z',
    sessionId: 'session-1',
    category: 'feature',
    retries: 0,
    hasEdits: true,
    assistantCalls: [{
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 400,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
      },
      costUSD: 0.12,
      tools: [],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard',
      timestamp: '2026-07-10T10:01:00.000Z',
      bashCommands: [],
      deduplicationKey: 'call-1',
    }],
  }
  const session: SessionSummary = {
    sessionId: 'session-1',
    project: 'codeburn',
    firstTimestamp: '2026-07-10T10:00:00.000Z',
    lastTimestamp: '2026-07-10T10:05:00.000Z',
    totalCostUSD: 0.12,
    totalSavingsUSD: 0.03,
    totalInputTokens: 100,
    totalOutputTokens: 20,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 400,
    totalCacheWriteTokens: 30,
    apiCalls: 1,
    turns: [turn],
    modelBreakdown: {
      'claude-sonnet-4-5': { calls: 1, costUSD: 0.12, tokens: turn.assistantCalls[0]!.usage, savingsUSD: 0.03 },
    },
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
  }
  return {
    project: 'codeburn',
    projectPath: '/tmp/codeburn',
    sessions: [session],
    totalCostUSD: 0.12,
    totalSavingsUSD: 0.03,
    totalApiCalls: 1,
    totalProxiedCostUSD: 0,
  }
}

describe('sessions JSON emitter', () => {
  it('flattens SessionSummary fields into the exact JSON row shape', () => {
    const rows = aggregateSessions([makeProject()])
    const parsed = JSON.parse(renderJson(rows))

    expect(parsed).toEqual([{
      sessionId: 'session-1',
      title: '',
      project: 'codeburn',
      provider: 'claude',
      models: ['claude-sonnet-4-5'],
      cost: 0.12,
      savingsUSD: 0.03,
      calls: 1,
      turns: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 400,
      cacheWriteTokens: 30,
      startedAt: '2026-07-10T10:00:00.000Z',
      endedAt: '2026-07-10T10:05:00.000Z',
      durationMs: 300_000,
    }])
  })

  it('renders a simple table', () => {
    const output = renderTable(aggregateSessions([makeProject()]), { terminalWidth: 120 })
    expect(output).toContain('Session')
    expect(output).toContain('session-1')
    expect(output).toContain('Sonnet 4.5')
    expect(output).toContain('1 sessions')
  })

  it('hides home-directory slugs and renders compact agent/worktree names', () => {
    const rows = aggregateSessions([makeProject()])
    rows[0]!.sessionId = 'agent-a72cc958e305e4957'
    rows[0]!.project = '-Users-torukmakto-Projects-eywa-eywa--claude-worktrees-issue-131'
    const output = renderTable(rows, { terminalWidth: 160 })

    expect(output).toContain('Agent a72cc958')
    expect(output).toContain('eywa · issue-131')
    expect(output).not.toContain('Users-torukmakto')
  })

  it('normalizes Claude dot-worktree slugs without exposing the home directory', () => {
    const rows = aggregateSessions([makeProject()])
    rows[0]!.project = 'Users-torukmakto-codeburn-.claude-worktrees-agent-a213f7c77871f483f'
    const output = renderTable(rows, { terminalWidth: 120 })

    expect(output).toContain('codeburn · agent a213f7c7')
    expect(output).not.toContain('Users-torukmakto')
    expect(output).not.toContain('.claude-worktrees')
  })

  it('uses captured titles, sorts newest first, and fits the requested width', () => {
    const rows = aggregateSessions([makeProject()])
    const older = { ...rows[0]!, sessionId: 'old', title: 'Older task', startedAt: '2026-07-01T10:00:00.000Z' }
    const newer = {
      ...rows[0]!,
      sessionId: 'new',
      title: 'Review the authentication migration without exposing filesystem details',
      project: '-Users-private-Projects-codeburn',
      startedAt: '2026-07-20T10:00:00.000Z',
    }
    const output = renderTable([older, newer], { terminalWidth: 80 })
    const lines = output.split('\n')

    expect(output.indexOf('Review the')).toBeLessThan(output.indexOf('Older task'))
    expect(output).not.toContain('Users-private')
    expect(Math.max(...lines.slice(0, -1).map(line => line.length))).toBeLessThanOrEqual(80)
  })
})
