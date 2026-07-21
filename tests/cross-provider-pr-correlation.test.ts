import { describe, expect, it } from 'vitest'

import { correlateCrossProviderPrSessions, extractPrUrlsFromText } from '../src/parser.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary } from '../src/types.js'

const A = 'https://github.com/getagentseal/codeburn/pull/790'
const B = 'https://github.com/getagentseal/codeburn/pull/791'

function call(provider: string, timestamp: string, command?: string): ParsedApiCall {
  return {
    provider, model: provider === 'claude' ? 'claude-opus-4-8' : 'gpt-5.6-terra',
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
    costUSD: 1, tools: command ? ['Bash'] : [], mcpTools: [], skills: [], subagentTypes: [],
    hasAgentSpawn: false, hasPlanMode: false, speed: 'standard', timestamp,
    bashCommands: command ? ['codex'] : [], deduplicationKey: `${provider}:${timestamp}`,
    ...(command ? { toolSequence: [[{ tool: 'Bash', command }]] } : {}),
  }
}

function turn(provider: string, timestamp: string, userMessage: string, refs?: string[], command?: string): ClassifiedTurn {
  return {
    userMessage, timestamp, sessionId: `${provider}-${timestamp}`,
    assistantCalls: [call(provider, timestamp, command)], category: 'coding', retries: 0, hasEdits: false,
    ...(refs ? { prRefs: refs } : {}),
  }
}

function session(opts: { id: string; provider: string; timestamp: string; message: string; refs?: string[]; cwd?: string; command?: string; parentId?: string; agentId?: string }): SessionSummary {
  const turns = [turn(opts.provider, opts.timestamp, opts.message, opts.refs, opts.command)]
  return {
    sessionId: opts.id, project: 'codeburn', firstTimestamp: opts.timestamp, lastTimestamp: opts.timestamp,
    totalCostUSD: 1, totalSavingsUSD: 0, totalInputTokens: 1, totalOutputTokens: 1,
    totalReasoningTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, apiCalls: 1, turns,
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {}, categoryBreakdown: {}, skillBreakdown: {}, subagentBreakdown: {},
    ...(opts.refs ? { prLinks: opts.refs, prAttributionSource: 'transcript' as const } : {}),
    ...(opts.cwd ? { workingDirectory: opts.cwd } : {}),
    ...(opts.parentId ? { parentSessionId: opts.parentId } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  }
}

function project(sessions: SessionSummary[]): ProjectSummary {
  return { project: 'codeburn', projectPath: '/repo/codeburn', sessions, totalCostUSD: sessions.length, totalSavingsUSD: 0, totalApiCalls: sessions.length, totalProxiedCostUSD: 0 }
}

describe('provider-neutral PR references', () => {
  it('extracts and deduplicates full GitHub PR URLs from any provider text', () => {
    expect(extractPrUrlsFromText(`review ${A}, then ${B}; duplicate ${A}`)).toEqual([A, B])
  })
})

describe('cross-provider PR correlation', () => {
  const prompt = 'Adversarial review of the cross-provider pull-request attribution implementation with concrete failure scenarios.'

  it('links an externally launched saved session by exact prompt evidence', () => {
    const parent = session({ id: 'claude', provider: 'claude', timestamp: '2026-07-21T00:00:00Z', message: 'launch review', refs: [B], command: `codex exec '${prompt}'` })
    const child = session({ id: 'codex', provider: 'codex', timestamp: '2026-07-21T00:00:05Z', message: prompt })
    correlateCrossProviderPrSessions([project([parent, child])])
    expect(child.prLinks).toEqual([B])
    expect(child.turns[0]!.prRefs).toEqual([B])
    expect(child.prAttributionSource).toBe('launcher-prompt')
  })

  it('does not use timestamp overlap without exact prompt evidence', () => {
    const parent = session({ id: 'claude', provider: 'claude', timestamp: '2026-07-21T00:00:00Z', message: 'launch review', refs: [B], command: `codex exec '${prompt}'` })
    const unrelated = session({ id: 'codex', provider: 'codex', timestamp: '2026-07-21T00:00:05Z', message: 'Investigate a completely unrelated production database incident and prepare a detailed report.' })
    correlateCrossProviderPrSessions([project([parent, unrelated])])
    expect(unrelated.prLinks).toBeUndefined()
  })

  it('does not treat a session-level PR union as active before its first turn ref', () => {
    const parent = session({ id: 'claude', provider: 'claude', timestamp: '2026-07-21T00:00:00Z', message: 'launch', refs: [A, B], command: `codex exec '${prompt}'` })
    delete parent.turns[0]!.prRefs
    const child = session({ id: 'codex', provider: 'codex', timestamp: '2026-07-21T00:00:05Z', message: prompt })
    correlateCrossProviderPrSessions([project([parent, child])])
    expect(child.prLinks).toBeUndefined()
  })

  it('links an exact shared cwd only when it resolves to one PR set', () => {
    const cwd = '/repo/.claude/worktrees/agent-123'
    const parent = session({ id: 'claude', provider: 'claude', timestamp: '2026-07-21T00:00:00Z', message: 'work', refs: [B], cwd })
    const child = session({ id: 'gemini', provider: 'gemini', timestamp: '2026-07-21T01:00:00Z', message: 'short', cwd })
    correlateCrossProviderPrSessions([project([parent, child])])
    expect(child.prLinks).toEqual([B])
    expect(child.prAttributionSource).toBe('working-directory')
  })

  it('leaves a shared cwd unattributed when two PRs used it', () => {
    const cwd = '/repo/codeburn'
    const a = session({ id: 'a', provider: 'claude', timestamp: '2026-07-21T00:00:00Z', message: 'a', refs: [A], cwd })
    const b = session({ id: 'b', provider: 'claude', timestamp: '2026-07-21T01:00:00Z', message: 'b', refs: [B], cwd })
    const candidate = session({ id: 'c', provider: 'codex', timestamp: '2026-07-21T02:00:00Z', message: 'short', cwd })
    correlateCrossProviderPrSessions([project([a, b, candidate])])
    expect(candidate.prLinks).toBeUndefined()
  })

  it('uses Claude sidechain linkage as evidence without breaking its fold semantics', () => {
    const parent = session({ id: 'parent', provider: 'claude', timestamp: '2026-07-21T00:00:00Z', message: 'spawn', refs: [B] })
    parent.agentSpawnLinks = { child: 'spawn-1' }
    parent.spawnPrSets = { 'spawn-1': [B] }
    const child = session({ id: 'agent-child', provider: 'claude', timestamp: '2026-07-21T00:01:00Z', message: 'launch', command: `codex exec '${prompt}'`, parentId: 'parent', agentId: 'child' })
    const codex = session({ id: 'codex', provider: 'codex', timestamp: '2026-07-21T00:01:05Z', message: prompt })
    correlateCrossProviderPrSessions([project([parent, child, codex])])
    expect(child.prLinks).toBeUndefined()
    expect(codex.prLinks).toEqual([B])
    expect(codex.prAttributionSource).toBe('launcher-prompt')
  })
})
