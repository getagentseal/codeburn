import { describe, expect, it } from 'vitest'

import { filterProjectsByBillingRoute } from '../src/billing-filter.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary, TokenUsage } from '../src/types.js'

// `--route` and `--billing` slice at the CALL, so a session that mixed doors
// contributes only its matching calls and every nested total is rebuilt from
// what survived — the same contract the date filters already meet (#1451).

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
}

function makeCall(overrides: Partial<ParsedApiCall> & { deduplicationKey: string }): ParsedApiCall {
  return {
    provider: 'hermes',
    model: 'claude-sonnet-4-5',
    usage: { ...ZERO_TOKENS, inputTokens: 1000, outputTokens: 100 },
    costUSD: 1,
    tools: ['Read'],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-09-18T12:00:00.000Z',
    bashCommands: [],
    ...overrides,
  }
}

function makeTurn(calls: ParsedApiCall[], overrides: Partial<ClassifiedTurn> = {}): ClassifiedTurn {
  return {
    userMessage: 'do the thing',
    assistantCalls: calls,
    timestamp: calls[0]!.timestamp,
    sessionId: 'sess-1',
    category: 'coding',
    retries: 0,
    hasEdits: false,
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionSummary> & { sessionId: string; turns: ClassifiedTurn[] }): SessionSummary {
  return {
    project: 'app',
    firstTimestamp: '2026-09-18T12:00:00.000Z',
    lastTimestamp: '2026-09-18T12:30:00.000Z',
    // Deliberately the WHOLE-session figures: a filtered slice must recompute
    // these from its retained calls rather than carry them through.
    totalCostUSD: 999,
    totalSavingsUSD: 0,
    totalInputTokens: 999,
    totalOutputTokens: 999,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 999,
    modelBreakdown: { 'Stale Row': { calls: 999, costUSD: 999, tokens: ZERO_TOKENS, savingsUSD: 0 } },
    toolBreakdown: { Stale: { calls: 999 } },
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
    ...overrides,
  }
}

function makeProject(sessions: SessionSummary[], overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project: 'app',
    projectPath: '/Users/gone/app',
    sessions,
    totalCostUSD: 999,
    totalSavingsUSD: 0,
    totalApiCalls: 999,
    totalProxiedCostUSD: 0,
    ...overrides,
  }
}

// One session, four doors: a Bedrock call the provider's column named, a
// direct call a subscription covered, an OpenRouter call, and a direct call
// nothing is known about.
function mixedProject(): ProjectSummary[] {
  const bedrock = makeCall({ deduplicationKey: 'bedrock', route: 'bedrock', costUSD: 4, tools: ['Bash'] })
  const covered = makeCall({ deduplicationKey: 'covered', billing: 'subscription', costUSD: 2 })
  const openrouter = makeCall({ deduplicationKey: 'openrouter', route: 'openrouter', billing: 'metered', costUSD: 1, model: 'cohere/north-mini-code:free' })
  const unknown = makeCall({ deduplicationKey: 'unknown', costUSD: 8 })
  const idShaped = makeCall({ deduplicationKey: 'id-shaped', model: 'anthropic.claude-haiku-4-5-20251001-v1:0', costUSD: 16 })
  return [makeProject([
    makeSession({
      sessionId: 'sess-1',
      turns: [makeTurn([bedrock, covered]), makeTurn([openrouter, unknown, idShaped], { category: 'testing' })],
    }),
  ])]
}

function costOf(projects: ProjectSummary[]): number {
  return projects.reduce((sum, p) => sum + p.totalCostUSD, 0)
}

function keysOf(projects: ProjectSummary[]): string[] {
  return projects.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls.map(c => c.deduplicationKey)))).sort()
}

describe('filterProjectsByBillingRoute - which calls survive', () => {
  it('returns the input untouched when neither filter is given', () => {
    const projects = mixedProject()
    expect(filterProjectsByBillingRoute(projects, {})).toBe(projects)
  })

  it('keeps one door, from either evidence source', () => {
    // The column-named Bedrock call and the Bedrock-shaped id are one door.
    expect(keysOf(filterProjectsByBillingRoute(mixedProject(), { route: 'bedrock' }))).toEqual(['bedrock', 'id-shaped'])
    expect(keysOf(filterProjectsByBillingRoute(mixedProject(), { route: 'openrouter' }))).toEqual(['openrouter'])
  })

  it('treats direct as the complement of the recognised doors, and never lets a routed call in', () => {
    // Direct is direct-or-unknown: it is what is left once every recognised
    // door is taken out, which is why the help says so rather than claiming
    // confirmed first-party billing. An id-shaped Bedrock call is recognised
    // and must not slip in here.
    expect(keysOf(filterProjectsByBillingRoute(mixedProject(), { route: 'direct' }))).toEqual(['covered', 'unknown'])
  })

  it('matches a billing mode only where the call has one', () => {
    // Unknown is not coerced: the direct estimated call answers to neither mode.
    expect(keysOf(filterProjectsByBillingRoute(mixedProject(), { billing: 'subscription' }))).toEqual(['covered'])
    expect(keysOf(filterProjectsByBillingRoute(mixedProject(), { billing: 'metered' }))).toEqual(['bedrock', 'id-shaped', 'openrouter'])
  })

  it('composes the two by AND', () => {
    expect(keysOf(filterProjectsByBillingRoute(mixedProject(), { route: 'bedrock', billing: 'metered' }))).toEqual(['bedrock', 'id-shaped'])
    expect(keysOf(filterProjectsByBillingRoute(mixedProject(), { route: 'direct', billing: 'subscription' }))).toEqual(['covered'])
    // Every OpenRouter call here is metered, so the pair selects nothing and
    // the project drops rather than surviving with zeroed totals.
    expect(filterProjectsByBillingRoute(mixedProject(), { route: 'openrouter', billing: 'subscription' })).toEqual([])
  })
})

describe('filterProjectsByBillingRoute - what the survivors add up to', () => {
  it('rebuilds project, session and turn totals from the retained calls only', () => {
    const filtered = filterProjectsByBillingRoute(mixedProject(), { route: 'bedrock' })
    const project = filtered[0]!
    const session = project.sessions[0]!
    expect(costOf(filtered)).toBe(20)
    expect(project.totalApiCalls).toBe(2)
    expect(session.totalCostUSD).toBe(20)
    expect(session.apiCalls).toBe(2)
    expect(session.totalInputTokens).toBe(2000)
    expect(session.totalOutputTokens).toBe(200)
  })

  it('re-anchors a partial turn to the first retained call', () => {
    const direct = makeCall({
      deduplicationKey: 'before-midnight',
      timestamp: '2026-09-18T23:59:00.000Z',
    })
    const openrouter = makeCall({
      deduplicationKey: 'after-midnight',
      route: 'openrouter',
      timestamp: '2026-09-19T00:01:00.000Z',
    })
    const projects = [makeProject([makeSession({
      sessionId: 'midnight',
      turns: [makeTurn([direct, openrouter], { timestamp: direct.timestamp })],
    })])]

    const turn = filterProjectsByBillingRoute(projects, { route: 'openrouter' })[0]!.sessions[0]!.turns[0]!
    expect(turn.timestamp).toBe(openrouter.timestamp)
  })

  it('rebuilds the model, tool and category breakdowns, dropping the rows nothing survived in', () => {
    const session = filterProjectsByBillingRoute(mixedProject(), { route: 'bedrock' })[0]!.sessions[0]!
    // Keyed the way every other surface keys a routed row.
    expect(Object.keys(session.modelBreakdown).sort()).toEqual(['Haiku 4.5 (Bedrock)', 'Sonnet 4.5 (Bedrock)'])
    expect(session.modelBreakdown['Sonnet 4.5 (Bedrock)']!.calls).toBe(1)
    expect(session.modelBreakdown['Stale Row']).toBeUndefined()
    expect(Object.keys(session.toolBreakdown).sort()).toEqual(['Bash', 'Read'])
    // Both turns kept a call, so both categories survive.
    expect(Object.keys(session.categoryBreakdown).sort()).toEqual(['coding', 'testing'])
  })

  it('drops a turn, a session and a project that retained nothing', () => {
    const projects = [
      makeProject([makeSession({ sessionId: 'kept', turns: [
        makeTurn([makeCall({ deduplicationKey: 'a', route: 'bedrock' })]),
        makeTurn([makeCall({ deduplicationKey: 'b' })], { category: 'testing' }),
      ] })]),
      makeProject([makeSession({ sessionId: 'gone', turns: [makeTurn([makeCall({ deduplicationKey: 'c' })])] })], { project: 'other', projectPath: '/Users/gone/other' }),
    ]
    const filtered = filterProjectsByBillingRoute(projects, { route: 'bedrock' })
    expect(filtered.map(p => p.project)).toEqual(['app'])
    expect(filtered[0]!.sessions.map(s => s.sessionId)).toEqual(['kept'])
    expect(filtered[0]!.sessions[0]!.turns).toHaveLength(1)
  })
})

describe('filterProjectsByBillingRoute - metadata and linkage survive the rebuild', () => {
  it('carries lineage, PR attribution, title, source and working directory onto the rebuilt session', () => {
    const projects = [makeProject([makeSession({
      sessionId: 'sess-1',
      turns: [makeTurn([makeCall({ deduplicationKey: 'a', route: 'bedrock' })], { prRefs: ['o/r#1'] })],
      title: 'Wire the billing filter',
      prLinks: ['https://github.com/o/r/pull/1'],
      prAttributionSource: 'transcript',
      workingDirectory: '/Users/gone/app',
      parentSessionId: 'parent-1',
      agentId: 'agent-1',
      agentType: 'Explore',
      agentName: 'KillSwitch',
      agentStartedAt: '2026-09-18T11:59:00.000Z',
      isSidechain: true,
      everHadBranch: true,
      lineage: { parentSessionId: 'parent-1', role: 'child', evidence: 'provider-recorded' },
      source: { id: 'default', label: 'Claude', path: '/home/u/.claude', kind: 'claude-config' },
      mcpInventory: ['mcp__server__tool'],
    })])]
    const session = filterProjectsByBillingRoute(projects, { route: 'bedrock' })[0]!.sessions[0]!
    expect(session).toMatchObject({
      title: 'Wire the billing filter',
      prLinks: ['https://github.com/o/r/pull/1'],
      prAttributionSource: 'transcript',
      workingDirectory: '/Users/gone/app',
      parentSessionId: 'parent-1',
      agentId: 'agent-1',
      agentType: 'Explore',
      agentName: 'KillSwitch',
      agentStartedAt: '2026-09-18T11:59:00.000Z',
      isSidechain: true,
      everHadBranch: true,
      lineage: { parentSessionId: 'parent-1', role: 'child', evidence: 'provider-recorded' },
      source: { id: 'default', kind: 'claude-config' },
      mcpInventory: ['mcp__server__tool'],
    })
    expect(session.turns[0]!.prRefs).toEqual(['o/r#1'])
  })

  it('keeps an existing work-unit anchor, and converts a spawn parent the filter emptied into one', () => {
    // The anchor carries no spend either way; dropping it would orphan the
    // in-slice child that folds into its PR, exactly as under a date filter.
    const anchor = makeSession({ sessionId: 'existing-anchor', turns: [], prLinks: ['https://github.com/o/r/pull/9'], spawnPrSets: { s9: ['o/r#9'] } })
    const spawnParent = makeSession({
      sessionId: 'spawn-parent',
      turns: [makeTurn([makeCall({ deduplicationKey: 'direct-only' })])],
      prLinks: ['https://github.com/o/r/pull/1'],
      spawnPrSets: { s1: ['o/r#1'] },
      agentSpawnLinks: { 'agent-1': 's1' },
    })
    const child = makeSession({ sessionId: 'child', turns: [makeTurn([makeCall({ deduplicationKey: 'bedrock', route: 'bedrock' })])], parentSessionId: 'spawn-parent', agentId: 'agent-1' })
    const projects = [makeProject([spawnParent, child], { subagentAnchors: [anchor] })]

    const filtered = filterProjectsByBillingRoute(projects, { route: 'bedrock' })
    expect(filtered[0]!.sessions.map(s => s.sessionId)).toEqual(['child'])
    expect((filtered[0]!.subagentAnchors ?? []).map(s => s.sessionId).sort()).toEqual(['existing-anchor', 'spawn-parent'])
    expect(filtered[0]!.subagentAnchors!.find(s => s.sessionId === 'spawn-parent')!.spawnPrSets).toEqual({ s1: ['o/r#1'] })
  })
})
