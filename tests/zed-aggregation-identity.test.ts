import { describe, it, expect } from 'vitest'

import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { mergeProjectsByCrossProviderKey, filterProjectsByName } from '../src/parser.js'
import { normalizeProjectIdentity } from '../src/project-identity.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary } from '../src/types.js'

// Regression: aggregation must group by the stable identity, never by the
// basename display label. This test intentionally uses plain summaries so the
// identity behavior is covered even when SQLite or Zed's zstd support is not
// available on the test runner.

const TIMESTAMP = '2026-06-20T10:00:00.000Z'
const DISPLAY_NAME = 'codeburn, website'
const ALICE_IDENTITY = '/Users/alice/codeburn\n/Users/alice/website'
const BOB_IDENTITY = '/Users/bob/codeburn\n/Users/bob/website'

function makeCall(sessionId: string, inputTokens: number, outputTokens: number): ParsedApiCall {
  return {
    provider: 'zed',
    model: 'claude-opus-4-8',
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: inputTokens / 100,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: TIMESTAMP,
    bashCommands: [],
    deduplicationKey: `zed:${sessionId}:request-1`,
  }
}

function makeSession(sessionId: string, inputTokens: number, outputTokens: number): SessionSummary {
  const call = makeCall(sessionId, inputTokens, outputTokens)
  const turn: ClassifiedTurn = {
    userMessage: 'work on the project',
    assistantCalls: [call],
    timestamp: TIMESTAMP,
    sessionId,
    category: 'coding',
    retries: 0,
    hasEdits: false,
  }
  const costUSD = call.costUSD
  return {
    sessionId,
    project: DISPLAY_NAME,
    firstTimestamp: TIMESTAMP,
    lastTimestamp: TIMESTAMP,
    totalCostUSD: costUSD,
    totalSavingsUSD: 0,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [turn],
    modelBreakdown: {
      'claude-opus-4-8': {
        calls: 1,
        costUSD,
        tokens: call.usage,
        savingsUSD: 0,
      },
    },
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {
      coding: { turns: 1, costUSD, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    },
    skillBreakdown: {},
    subagentBreakdown: {},
  }
}

function makeProject(projectIdentity: string, sessionId: string, inputTokens: number, outputTokens: number): ProjectSummary {
  const session = makeSession(sessionId, inputTokens, outputTokens)
  return {
    project: DISPLAY_NAME,
    // A multi-root workspace has no single filesystem path.
    projectPath: '',
    projectIdentity,
    sessions: [session],
    totalCostUSD: session.totalCostUSD,
    totalSavingsUSD: 0,
    totalApiCalls: 1,
    totalProxiedCostUSD: 0,
  }
}

describe('Zed project identity aggregation', () => {
  it('keeps identical multi-root labels separate in daily attribution', () => {
    const projects = [
      makeProject(ALICE_IDENTITY, 'alice-session', 100, 50),
      makeProject(BOB_IDENTITY, 'bob-session', 200, 80),
    ]

    const day = aggregateProjectsIntoDays(projects)[0]!

    expect(Object.keys(day.projects ?? {})).toEqual([ALICE_IDENTITY, BOB_IDENTITY])
    expect(day.projects![ALICE_IDENTITY]).toMatchObject({
      calls: 1,
      name: DISPLAY_NAME,
    })
    expect(day.projects![BOB_IDENTITY]).toMatchObject({
      calls: 1,
      name: DISPLAY_NAME,
    })
    expect(day.projects![ALICE_IDENTITY]!.path).toBeUndefined()
    expect(day.projects![BOB_IDENTITY]!.path).toBeUndefined()
  })

  it('uses the stable identity for filters and cross-provider merging', () => {
    const projects = [
      makeProject(ALICE_IDENTITY, 'alice-session', 100, 50),
      makeProject(BOB_IDENTITY, 'bob-session', 200, 80),
    ]

    expect(filterProjectsByName(projects, ['/Users/alice'])).toEqual([projects[0]])

    const merged = mergeProjectsByCrossProviderKey([...projects, ...projects])
    expect(merged).toHaveLength(2)
    expect([...merged.values()].find(p => p.projectIdentity === ALICE_IDENTITY)?.totalCostUSD)
      .toBe(projects[0]!.totalCostUSD * 2)
    expect([...merged.values()].find(p => p.projectIdentity === BOB_IDENTITY)?.totalCostUSD)
      .toBe(projects[1]!.totalCostUSD * 2)
  })
})

describe('project identity normalization', () => {
  it('preserves case distinctions on case-sensitive filesystems', () => {
    expect(normalizeProjectIdentity('/home/A/repo', 'linux'))
      .not.toBe(normalizeProjectIdentity('/home/a/repo', 'linux'))
  })

  it('folds case for macOS, Windows, and Windows paths in foreign fixtures', () => {
    expect(normalizeProjectIdentity('/Users/A/repo', 'darwin'))
      .toBe(normalizeProjectIdentity('/Users/a/repo', 'darwin'))
    expect(normalizeProjectIdentity('C:\\Work\\Repo', 'linux'))
      .toBe(normalizeProjectIdentity('c:/work/repo', 'linux'))
  })
})
