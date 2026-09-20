import { describe, expect, it } from 'vitest'

import { extractCallCommands, normalizedPrompt, stripCallForAggregate, stripProjectsForAggregate } from '../src/parser.js'
import type { ParsedApiCall } from '../src/types.js'
import type { ProjectSummary } from '../src/types.js'

function fullCall(): ParsedApiCall {
  return {
    provider: 'omp',
    model: 'gemini-3.8-flash',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 10,
      cachedInputTokens: 0,
      reasoningTokens: 5,
      webSearchRequests: 0,
    },
    costUSD: 0.01,
    tools: ['Edit'],
    mcpTools: ['mcp__srv__tool'],
    skills: ['s'],
    subagentTypes: ['Explore'],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-09-19T10:00:00Z',
    bashCommands: ['ls'],
    deduplicationKey: 'omp:abc123',
    workingDirectory: '/repo',
    projectPath: '/repo',
    project: 'repo',
    prLinks: ['https://github.com/o/r/pull/1'],
    toolSequence: [[{ tool: 'Bash', command: 'git status' }]],
    savingsUSD: 0.002,
    route: 'r1',
    supplementaryAccounting: undefined,
  } as unknown as ParsedApiCall
}

describe('stripCallForAggregate', () => {
  it('keeps billing scalars and drops payloads', () => {
    const lite = stripCallForAggregate(fullCall())
    expect(lite.provider).toBe('omp')
    expect(lite.model).toBe('gemini-3.8-flash')
    expect(lite.costUSD).toBe(0.01)
    expect(lite.tools).toEqual([])
    expect(lite.route).toBe('r1')
    expect(lite.toolSequence).toBeUndefined()
    expect(lite.deduplicationKey).toBe('')
    expect(lite.bashCommands).toEqual([])
    expect(lite.skills).toEqual([])
    expect(lite.mcpTools).toEqual([])
    expect(lite.subagentTypes).toEqual([])
    expect(lite).not.toHaveProperty('workingDirectory')
    expect(lite).not.toHaveProperty('projectPath')
    expect(lite).not.toHaveProperty('project')
    expect(lite).not.toHaveProperty('prLinks')
  })

  it('extracts shell commands for PR launch matching', () => {
    expect(stripCallForAggregate(fullCall()).commands).toEqual(['git status'])
    expect(extractCallCommands(fullCall())).toEqual(['git status'])
  })
  it('matches the legacy toolSequence derivation exactly', () => {
    const call = {
      ...fullCall(),
      toolSequence: [[{ tool: 'Bash', command: '  git   status  ' }, { tool: 'Edit' }, { tool: 'Bash', command: '' }, { tool: 'Bash', command: '   ' }]],
    } as unknown as ParsedApiCall
    const legacy = (call.toolSequence ?? [])
      .flat()
      .map(tool => typeof tool.command === 'string' ? normalizedPrompt(tool.command) : '')
      .filter(command => command.length > 0)
    const viaHelper = extractCallCommands(call)
      .map(command => normalizedPrompt(command))
      .filter(command => command.length > 0)
    expect(viaHelper).toEqual(legacy)
    expect(viaHelper).toEqual(['git status'])
  })
})

describe('stripProjectsForAggregate', () => {
  it('preserves totals and breakdowns while stripping turns', () => {
    const projects = [{
      project: 'repo',
      projectPath: '/repo',
      sessions: [{
        sessionId: 's1',
        project: 'repo',
        firstTimestamp: '2026-09-19T10:00:00Z',
        lastTimestamp: '2026-09-19T10:01:00Z',
        totalCostUSD: 0.01,
        totalSavingsUSD: 0,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalReasoningTokens: 5,
        totalCacheReadTokens: 10,
        totalCacheWriteTokens: 0,
        apiCalls: 1,
        turns: [{
          userMessage: 'do it',
          assistantCalls: [fullCall()],
          timestamp: '2026-09-19T10:00:00Z',
          sessionId: 's1',
          category: 'coding',
          retries: 0,
          hasEdits: false,
        }],
        modelBreakdown: {},
        toolBreakdown: { Edit: { calls: 1 } },
        mcpBreakdown: {},
        bashBreakdown: {},
        categoryBreakdown: {},
        skillBreakdown: {},
        subagentBreakdown: {},
      }],
      totalCostUSD: 0.01,
      totalSavingsUSD: 0,
      totalApiCalls: 1,
      totalProxiedCostUSD: 0,
    }] as unknown as ProjectSummary[]
    const [lite] = stripProjectsForAggregate(projects)
    expect(lite!.totalCostUSD).toBe(0.01)
    expect(lite!.sessions[0]!.toolBreakdown).toEqual({ Edit: { calls: 1 } })
    expect(lite!.sessions[0]!.turns[0]!.userMessage).toBe('do it')
    expect(lite!.sessions[0]!.turns[0]!.assistantCalls[0]!.commands).toEqual(['git status'])
    expect(lite!.sessions[0]!.turns[0]!.assistantCalls[0]!.toolSequence).toBeUndefined()
    // In-place contract: same graphs, payloads stripped (single owner, no
    // provider-wide copy transient).
    expect(lite).toBe(projects[0])
    expect(projects[0]!.sessions[0]!.turns[0]!.assistantCalls[0]!.toolSequence).toBeUndefined()
  })
})
