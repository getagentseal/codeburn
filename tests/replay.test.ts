import { describe, expect, it } from 'vitest'

import { buildReplayResult, findReplaySessions, renderReplayCandidates, renderReplayText } from '../src/replay.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary } from '../src/types.js'

function makeCall(model: string, costUSD: number, opts: {
  provider?: string
  tools?: string[]
  mcpTools?: string[]
  skills?: string[]
  bashCommands?: string[]
  timestamp?: string
} = {}): ParsedApiCall {
  const timestamp = opts.timestamp ?? '2026-05-06T10:00:00Z'
  return {
    provider: opts.provider ?? 'claude',
    model,
    usage: {
      inputTokens: 1000,
      outputTokens: 250,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 500,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD,
    tools: opts.tools ?? [],
    mcpTools: opts.mcpTools ?? [],
    skills: opts.skills ?? [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp,
    bashCommands: opts.bashCommands ?? [],
    deduplicationKey: `${model}:${timestamp}:${costUSD}`,
  }
}

function makeTurn(sessionId: string, index: number, userMessage: string, calls: ParsedApiCall[]): ClassifiedTurn {
  return {
    userMessage,
    assistantCalls: calls,
    timestamp: `2026-05-06T10:0${index}:00Z`,
    sessionId,
    category: index === 1 ? 'coding' : 'testing',
    retries: index === 2 ? 1 : 0,
    hasEdits: index === 1,
  }
}

function makeSession(sessionId: string, turns: ClassifiedTurn[]): SessionSummary {
  return {
    sessionId,
    project: 'api',
    firstTimestamp: turns[0]?.timestamp ?? '',
    lastTimestamp: turns[turns.length - 1]?.timestamp ?? '',
    totalCostUSD: turns.flatMap(turn => turn.assistantCalls).reduce((sum, call) => sum + call.costUSD, 0),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.reduce((sum, turn) => sum + turn.assistantCalls.length, 0),
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  }
}

function makeProject(project: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project,
    projectPath: `/work/${project}`,
    sessions,
    totalCostUSD: sessions.reduce((sum, session) => sum + session.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((sum, session) => sum + session.apiCalls, 0),
  }
}

function makeTinyProject(index: number): ProjectSummary {
  const sessionId = `ambiguous-${String(index).padStart(2, '0')}`
  return makeProject(`project-${index}`, [
    makeSession(sessionId, [
      makeTurn(sessionId, 1, `session ${index}`, [makeCall('claude-sonnet-4-5', 0.01)]),
    ]),
  ])
}

function fixtureProjects(): ProjectSummary[] {
  const session = makeSession('abcdef123456', [
    makeTurn('abcdef123456', 1, 'implement the replay command', [
      makeCall('claude-sonnet-4-5', 0.12, {
        tools: ['Read', 'Edit', 'Edit'],
        mcpTools: ['mcp__github__get_issue'],
        skills: ['planning'],
        bashCommands: ['npm test'],
      }),
    ]),
    makeTurn('abcdef123456', 2, 'run the focused tests', [
      makeCall('claude-sonnet-4-5', 0.08, {
        tools: ['Bash'],
        bashCommands: ['npx vitest run tests/replay.test.ts'],
      }),
    ]),
  ])
  return [
    makeProject('api', [session]),
    makeProject('web', [
      makeSession('abc999', [
        makeTurn('abc999', 1, 'other session', [makeCall('gpt-5.3-codex', 0.5)]),
      ]),
    ]),
  ]
}

describe('findReplaySessions', () => {
  it('matches exact session ids before prefix matches', () => {
    const matches = findReplaySessions(fixtureProjects(), 'abc999')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.project.project).toBe('web')
    expect(matches[0]?.session.sessionId).toBe('abc999')
  })

  it('finds sessions by id prefix', () => {
    const matches = findReplaySessions(fixtureProjects(), 'abcdef')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.session.sessionId).toBe('abcdef123456')
  })

  it('returns multiple prefix matches for ambiguous queries', () => {
    const matches = findReplaySessions(fixtureProjects(), 'abc')
    expect(matches.map(match => match.session.sessionId).sort()).toEqual(['abc999', 'abcdef123456'])
  })

  it('handles empty and uppercase queries', () => {
    expect(findReplaySessions(fixtureProjects(), '')).toEqual([])
    expect(findReplaySessions(fixtureProjects(), 'ABCDEF')).toHaveLength(1)
  })
})

describe('buildReplayResult', () => {
  it('builds a per-turn timeline with costs, tokens, tools, and shell commands', () => {
    const [match] = findReplaySessions(fixtureProjects(), 'abcdef')
    const result = buildReplayResult(match!, { includePrompts: true })

    expect(result.totalCostUSD).toBeCloseTo(0.2)
    expect(result.apiCalls).toBe(2)
    expect(result.turns).toHaveLength(2)
    expect(result.turns[0]).toEqual(expect.objectContaining({
      userMessage: 'implement the replay command',
      costUSD: 0.12,
      inputTokens: 1000,
      outputTokens: 250,
      cacheReadTokens: 500,
      cacheWriteTokens: 100,
      tools: { Edit: 2, Read: 1 },
      mcpTools: { mcp__github__get_issue: 1 },
      skills: { planning: 1 },
      bashCommands: ['npm test'],
    }))
  })

  it('can hide prompt text from the replay result', () => {
    const [match] = findReplaySessions(fixtureProjects(), 'abcdef')
    const result = buildReplayResult(match!, { includePrompts: false })
    expect(result.turns[0]?.userMessage).toBeNull()
  })
})

describe('renderReplayText', () => {
  it('renders a readable timeline', () => {
    const [match] = findReplaySessions(fixtureProjects(), 'abcdef')
    match!.session.turns[0]!.subCategory = 'implementation'
    const text = renderReplayText(buildReplayResult(match!, { includePrompts: true }))

    expect(text).toContain('CodeBurn session replay')
    expect(text).toContain('Coding / implementation')
    expect(text).toContain('implement the replay command')
    expect(text).toContain('claude-sonnet-4-5')
    expect(text).toContain('Edit x2')
    expect(text).toContain('npm test')
    expect(text).toContain('1 retry')
  })

  it('does not render prompt text when prompts are hidden', () => {
    const [match] = findReplaySessions(fixtureProjects(), 'abcdef')
    const text = renderReplayText(buildReplayResult(match!, { includePrompts: false }))

    expect(text).toContain('Prompt: hidden by --no-prompts')
    expect(text).not.toContain('implement the replay command')
  })
})

describe('renderReplayCandidates', () => {
  it('renders ambiguous matches with project names', () => {
    const matches = findReplaySessions(fixtureProjects(), 'abc')
    const text = renderReplayCandidates(matches, 'abc')

    expect(text).toContain('Multiple sessions matched "abc"')
    expect(text).toContain('abcdef123456')
    expect(text).toContain('abc999')
    expect(text).toContain('Use a longer session id prefix')
  })

  it('pluralizes hidden candidate counts', () => {
    const matches = findReplaySessions(Array.from({ length: 12 }, (_, index) => makeTinyProject(index)), 'ambiguous')
    const text = renderReplayCandidates(matches, 'ambiguous')

    expect(text).toContain('...and 2 more matches')
    expect(text).not.toContain('more matchs')
  })
})
