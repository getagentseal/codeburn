import { describe, it, expect } from 'vitest'

import {
  aggregateMcpCoverage,
  detectMcpProfileAdvisor,
  detectMcpToolCoverage,
  estimateMcpSchemaCost,
} from '../src/optimize.js'
import type {
  ClassifiedTurn,
  ParsedApiCall,
  ProjectSummary,
  SessionSummary,
  TaskCategory,
  TokenUsage,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  webSearchRequests: 0,
}

function makeCall(opts: {
  tools?: string[]
  cacheCreation?: number
  cacheRead?: number
  cost?: number
} = {}): ParsedApiCall {
  const tools = opts.tools ?? []
  return {
    provider: 'claude',
    model: 'Opus 4.7',
    usage: {
      ...ZERO_USAGE,
      cacheCreationInputTokens: opts.cacheCreation ?? 0,
      cacheReadInputTokens: opts.cacheRead ?? 0,
    },
    costUSD: opts.cost ?? 0,
    tools,
    mcpTools: tools.filter(t => t.startsWith('mcp__')),
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-05-04T00:00:00Z',
    bashCommands: [],
    deduplicationKey: 'k',
  }
}

function makeTurn(calls: ParsedApiCall[]): ClassifiedTurn {
  return {
    userMessage: '',
    assistantCalls: calls,
    timestamp: '2026-05-04T00:00:00Z',
    sessionId: 's1',
    category: 'coding',
    retries: 0,
    hasEdits: false,
  }
}

function makeSession(opts: {
  sessionId?: string
  inventory?: string[]
  turns?: ClassifiedTurn[]
  mcpBreakdown?: Record<string, { calls: number }>
}): SessionSummary {
  const turns = opts.turns ?? []
  const apiCalls = turns.reduce((s, t) => s + t.assistantCalls.length, 0)
  const emptyCategoryBreakdown = {} as Record<TaskCategory, { turns: number; costUSD: number; retries: number; editTurns: number; oneShotTurns: number }>
  return {
    sessionId: opts.sessionId ?? 's1',
    project: 'p',
    firstTimestamp: '2026-05-04T00:00:00Z',
    lastTimestamp: '2026-05-04T00:00:00Z',
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls,
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: opts.mcpBreakdown ?? {},
    bashBreakdown: {},
    categoryBreakdown: emptyCategoryBreakdown,
    skillBreakdown: {},
    ...(opts.inventory ? { mcpInventory: opts.inventory } : {}),
  }
}

function project(sessions: SessionSummary[]): ProjectSummary {
  return projectNamed('p', sessions)
}

function projectNamed(name: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project: name,
    projectPath: `/tmp/${name}`,
    sessions,
    totalCostUSD: 0,
    totalApiCalls: sessions.reduce((s, ses) => s + ses.apiCalls, 0),
  }
}

// ---------------------------------------------------------------------------
// aggregateMcpCoverage
// ---------------------------------------------------------------------------

describe('aggregateMcpCoverage', () => {
  it('returns empty list when no session has MCP inventory', () => {
    const projects = [project([makeSession({})])]
    expect(aggregateMcpCoverage(projects)).toEqual([])
  })

  it('reports per-server tools available, invoked, and unused', () => {
    const inventory = [
      'mcp__hf__hub_repo_search',
      'mcp__hf__paper_search',
      'mcp__hf__hf_doc_search',
    ]
    const turns = [
      makeTurn([makeCall({ tools: ['mcp__hf__hub_repo_search'] })]),
    ]
    const sessions = [
      makeSession({ inventory, turns, mcpBreakdown: { hf: { calls: 1 } } }),
    ]
    const result = aggregateMcpCoverage([project(sessions)])

    expect(result).toHaveLength(1)
    expect(result[0]!.server).toBe('hf')
    expect(result[0]!.toolsAvailable).toBe(3)
    expect(result[0]!.toolsInvoked).toBe(1)
    expect(result[0]!.unusedTools).toEqual([
      'mcp__hf__hf_doc_search',
      'mcp__hf__paper_search',
    ])
    expect(result[0]!.coverageRatio).toBeCloseTo(1 / 3, 5)
    expect(result[0]!.invocations).toBe(1)
    expect(result[0]!.loadedSessions).toBe(1)
  })

  it('unions inventory across multiple sessions for the same server', () => {
    const sessions = [
      makeSession({ sessionId: 'a', inventory: ['mcp__x__a', 'mcp__x__b'] }),
      makeSession({ sessionId: 'b', inventory: ['mcp__x__b', 'mcp__x__c'] }),
    ]
    const result = aggregateMcpCoverage([project(sessions)])
    expect(result[0]!.toolsAvailable).toBe(3)
    expect(result[0]!.loadedSessions).toBe(2)
  })

  it('separates servers with similar names', () => {
    const sessions = [
      makeSession({ inventory: ['mcp__hf__a', 'mcp__hugface__a'] }),
    ]
    const result = aggregateMcpCoverage([project(sessions)])
    expect(result.map(r => r.server).sort()).toEqual(['hf', 'hugface'])
  })

  it('skips invocations without inventory (foreign server, no inventory observed)', () => {
    // A server can show up only via a call. We still report it so the
    // operator knows it was invoked, but coverage is 0/0 and it is not a
    // candidate for the unused-coverage finding.
    const turns = [makeTurn([makeCall({ tools: ['mcp__ghost__t1'] })])]
    const sessions = [
      makeSession({ turns, mcpBreakdown: { ghost: { calls: 1 } } }),
    ]
    const result = aggregateMcpCoverage([project(sessions)])
    // No inventory entry -> aggregator drops the server from the report
    // because we cannot reason about coverage without an inventory baseline.
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// estimateMcpSchemaCost — cache-aware accounting
// ---------------------------------------------------------------------------

describe('estimateMcpSchemaCost', () => {
  it('charges first cacheCreation turn at full price, subsequent turns at cache-read', () => {
    const turns = [
      makeTurn([makeCall({ cacheCreation: 50_000 })]), // first turn: write
      makeTurn([makeCall({ cacheRead: 60_000 })]),     // ongoing: read
      makeTurn([makeCall({ cacheRead: 60_000 })]),
    ]
    const sessions = [makeSession({
      inventory: Array.from({ length: 30 }, (_, i) => `mcp__svc__t${i}`),
      turns,
      mcpBreakdown: { svc: { calls: 0 } },
    })]
    // 30 unused tools * 400 token estimate = 12_000 schema tokens
    // cap by call cache buckets so we never overclaim
    const cost = estimateMcpSchemaCost(30, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(12_000) // capped by 50k creation, 12k schema fits
    expect(cost.cacheReadTokens).toBe(24_000)  // 12k + 12k across two ongoing turns
    // effective = write * 1.25 + read * 0.10 (cache pricing)
    expect(cost.effectiveInputTokens).toBeCloseTo(12_000 * 1.25 + 24_000 * 0.10, 5)
  })

  it('caps by available cache bucket so we never overclaim', () => {
    const turns = [makeTurn([makeCall({ cacheCreation: 1_000 })])]
    const sessions = [makeSession({
      inventory: Array.from({ length: 30 }, (_, i) => `mcp__svc__t${i}`),
      turns,
      mcpBreakdown: { svc: { calls: 0 } },
    })]
    // 30*400 = 12k schema tokens, but the call only had 1k cache-creation,
    // so we should not claim more than 1k of overhead for that turn.
    const cost = estimateMcpSchemaCost(30, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(1_000)
  })

  it('returns zero when no unused tools', () => {
    const sessions = [makeSession({
      inventory: ['mcp__svc__t1'],
      turns: [makeTurn([makeCall({ cacheCreation: 5000 })])],
    })]
    const cost = estimateMcpSchemaCost(0, [project(sessions)], 'svc')
    expect(cost).toEqual({ cacheWriteTokens: 0, cacheReadTokens: 0, effectiveInputTokens: 0 })
  })

  it('counts cache write AND cache read on the same call', () => {
    // A long session can have a cache rebuild mid-stream where one call
    // reports both buckets. The estimator must charge both, not skip the
    // read because of the write.
    const turns = [makeTurn([
      makeCall({ cacheCreation: 50_000, cacheRead: 30_000 }),
    ])]
    const sessions = [makeSession({
      inventory: Array.from({ length: 30 }, (_, i) => `mcp__svc__t${i}`),
      turns,
      mcpBreakdown: { svc: { calls: 0 } },
    })]
    const cost = estimateMcpSchemaCost(30, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(12_000) // capped at 50k creation
    expect(cost.cacheReadTokens).toBe(12_000)  // capped at 30k read
  })

  it('counts every cache rebuild, not just the first one', () => {
    // Sessions that span more than 5 minutes can rebuild the cache
    // multiple times. The estimator should treat every cacheCreation
    // bucket as another write.
    const turns = [makeTurn([
      makeCall({ cacheCreation: 50_000 }),
      makeCall({ cacheCreation: 50_000 }), // rebuild after cache TTL
      makeCall({ cacheRead: 60_000 }),
    ])]
    const sessions = [makeSession({
      inventory: Array.from({ length: 30 }, (_, i) => `mcp__svc__t${i}`),
      turns,
      mcpBreakdown: { svc: { calls: 0 } },
    })]
    const cost = estimateMcpSchemaCost(30, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(24_000) // both rebuilds counted
    expect(cost.cacheReadTokens).toBe(12_000)
  })

  it('skips sessions where the server was never loaded', () => {
    const turns = [makeTurn([makeCall({ cacheCreation: 100_000 })])]
    const sessions = [makeSession({
      inventory: ['mcp__other__t1'],
      turns,
    })]
    const cost = estimateMcpSchemaCost(10, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(0)
  })

  it('requires observed inventory for the server, not just invocations', () => {
    // Session invoked the server (mcpBreakdown set, mcpTools called) but
    // never reported a deferred_tools_delta for it. Cost should be 0 to
    // stay consistent with aggregateMcpCoverage's loadedSessions rule.
    const turns = [makeTurn([
      makeCall({ tools: ['mcp__svc__t1'], cacheCreation: 100_000 }),
    ])]
    const sessions = [makeSession({
      // No inventory at all
      turns,
      mcpBreakdown: { svc: { calls: 1 } },
    })]
    const cost = estimateMcpSchemaCost(10, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(0)
    expect(cost.cacheReadTokens).toBe(0)
  })

  it('caps combined unused-schema budget across multiple flagged servers', () => {
    // Two flagged servers, each with 30 unused tools (12k schema each =
    // 24k combined). One call has a 50k cache-creation bucket. The
    // combined cap means total write tokens reported is min(24k, 50k) =
    // 24k, not 24k + 24k = 48k.
    const inventory = [
      ...Array.from({ length: 30 }, (_, i) => `mcp__a__t${i}`),
      ...Array.from({ length: 30 }, (_, i) => `mcp__b__t${i}`),
    ]
    const turns = [makeTurn([makeCall({ cacheCreation: 50_000 })])]
    const sessions = [makeSession({ inventory, turns })]
    const cost = estimateMcpSchemaCost(
      { a: 30, b: 30 },
      [project(sessions)],
      ['a', 'b'],
    )
    expect(cost.cacheWriteTokens).toBe(24_000)
  })

  it('still works with the single-server signature (backward compat)', () => {
    const turns = [makeTurn([makeCall({ cacheCreation: 50_000 })])]
    const sessions = [makeSession({
      inventory: Array.from({ length: 30 }, (_, i) => `mcp__svc__t${i}`),
      turns,
    })]
    const cost = estimateMcpSchemaCost(30, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(12_000)
  })
})

// ---------------------------------------------------------------------------
// detectMcpToolCoverage — finding emission with thresholds
// ---------------------------------------------------------------------------

describe('detectMcpToolCoverage', () => {
  it('returns null when no inventory exists at all', () => {
    expect(detectMcpToolCoverage([project([makeSession({})])])).toBeNull()
  })

  it('does not flag a server with healthy coverage', () => {
    const inventory = Array.from({ length: 20 }, (_, i) => `mcp__svc__t${i}`)
    const turns = [makeTurn(
      Array.from({ length: 8 }, (_, i) => makeCall({ tools: [`mcp__svc__t${i}`] })),
    )]
    const sessions = [
      makeSession({ sessionId: 'a', inventory, turns }),
      makeSession({ sessionId: 'b', inventory, turns }),
    ]
    // 8/20 = 40% coverage, above the 20% threshold -> no finding
    expect(detectMcpToolCoverage([project(sessions)])).toBeNull()
  })

  it('does not flag a server with too few tools (signal too noisy)', () => {
    // Below MCP_COVERAGE_MIN_TOOLS=10
    const inventory = ['mcp__svc__a', 'mcp__svc__b']
    const sessions = [
      makeSession({ sessionId: 'a', inventory }),
      makeSession({ sessionId: 'b', inventory }),
    ]
    expect(detectMcpToolCoverage([project(sessions)])).toBeNull()
  })

  it('does not flag if seen in only one session (insufficient evidence)', () => {
    const inventory = Array.from({ length: 20 }, (_, i) => `mcp__svc__t${i}`)
    const sessions = [makeSession({ inventory })]
    expect(detectMcpToolCoverage([project(sessions)])).toBeNull()
  })

  it('flags a large server with low coverage across multiple sessions', () => {
    const inventory = Array.from({ length: 30 }, (_, i) => `mcp__hf__t${i}`)
    const turns = [makeTurn([
      makeCall({ tools: ['mcp__hf__t0'], cacheCreation: 100_000 }),
    ])]
    const sessions = [
      makeSession({ sessionId: 'a', inventory, turns, mcpBreakdown: { hf: { calls: 1 } } }),
      makeSession({ sessionId: 'b', inventory, turns, mcpBreakdown: { hf: { calls: 1 } } }),
    ]
    const finding = detectMcpToolCoverage([project(sessions)])
    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('1 MCP server')
    expect(finding!.title).toContain('low tool coverage')
    expect(finding!.explanation).toContain('hf')
    expect(finding!.explanation).toContain('1/30')
    expect(finding!.fix.type).toBe('command')
    expect((finding!.fix as { text: string }).text).toContain("claude mcp remove 'hf'")
    expect(finding!.tokensSaved).toBeGreaterThan(0)
  })

  it('escalates impact to high when token waste crosses the threshold', () => {
    const inventory = Array.from({ length: 60 }, (_, i) => `mcp__big__t${i}`)
    // 60 tools * 400 tokens = 24k schema. With many sessions and large
    // cache-creation buckets, total effective tokens easily clear 200k.
    const turns = [makeTurn([
      makeCall({ tools: ['mcp__big__t0'], cacheCreation: 50_000 }),
      makeCall({ cacheRead: 60_000 }),
      makeCall({ cacheRead: 60_000 }),
    ])]
    // Need enough sessions so the per-session ~28.8k effective tokens
    // (24k write + 48k read × 0.10) sum past the 200k high-impact threshold.
    const sessions = Array.from({ length: 8 }, (_, i) =>
      makeSession({ sessionId: `s${i}`, inventory, turns, mcpBreakdown: { big: { calls: 1 } } }),
    )
    const finding = detectMcpToolCoverage([project(sessions)])
    expect(finding).not.toBeNull()
    expect(finding!.impact).toBe('high')
  })

  it('does not count invocation-only sessions toward loadedSessions', () => {
    // Server `svc` has inventory in only one session, but is invoked in
    // a second session that never observed the schema. Pre-fix this
    // would have satisfied the >=2 session threshold; it must not now.
    const inventory = Array.from({ length: 20 }, (_, i) => `mcp__svc__t${i}`)
    const turns = [makeTurn([
      makeCall({ tools: ['mcp__svc__t0'], cacheCreation: 50_000 }),
    ])]
    const sessions = [
      makeSession({ sessionId: 'a', inventory, turns, mcpBreakdown: { svc: { calls: 1 } } }),
      // No inventory — this shouldn't be considered a "loaded" session.
      makeSession({ sessionId: 'b', turns, mcpBreakdown: { svc: { calls: 1 } } }),
    ]
    expect(detectMcpToolCoverage([project(sessions)])).toBeNull()
  })

  it('does not let invocations of un-inventoried tools inflate coverage', () => {
    // Inventory has 20 tools, none invoked. Calls hit a 21st tool that
    // never appeared in any deferred_tools_delta (could be a renamed/
    // removed tool from an older session config). Coverage must stay 0%
    // and unusedCount must not go negative.
    const inventory = Array.from({ length: 20 }, (_, i) => `mcp__svc__t${i}`)
    const turns = [makeTurn([makeCall({ tools: ['mcp__svc__ghost'] })])]
    const sessions = [
      makeSession({ sessionId: 'a', inventory, turns, mcpBreakdown: { svc: { calls: 1 } } }),
      makeSession({ sessionId: 'b', inventory, turns, mcpBreakdown: { svc: { calls: 1 } } }),
    ]
    const result = aggregateMcpCoverage([project(sessions)])
    expect(result[0]!.toolsAvailable).toBe(20)
    expect(result[0]!.toolsInvoked).toBe(0)
    expect(result[0]!.coverageRatio).toBe(0)
    expect(result[0]!.unusedTools).toHaveLength(20)
  })

  it('handles multiple flagged servers and pluralises the title', () => {
    const sessions: SessionSummary[] = []
    for (const server of ['svc1', 'svc2']) {
      const inventory = Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`)
      const turns = [makeTurn([
        makeCall({ tools: [`mcp__${server}__t0`], cacheCreation: 50_000 }),
      ])]
      sessions.push(
        makeSession({ sessionId: `${server}-a`, inventory, turns, mcpBreakdown: { [server]: { calls: 1 } } }),
        makeSession({ sessionId: `${server}-b`, inventory, turns, mcpBreakdown: { [server]: { calls: 1 } } }),
      )
    }
    const finding = detectMcpToolCoverage([project(sessions)])
    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('2 MCP servers')
    expect((finding!.fix as { text: string }).text.split('\n')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// detectMcpProfileAdvisor — project-scoping recommendations
// ---------------------------------------------------------------------------

describe('detectMcpProfileAdvisor', () => {
  const smallInventory = Array.from({ length: 4 }, (_, i) => `mcp__github__t${i}`)

  it('flags a server loaded across projects but invoked only in one hot project', () => {
    const hotTurns = [makeTurn([
      makeCall({ tools: ['mcp__github__t0'], cacheCreation: 10_000 }),
      makeCall({ tools: ['mcp__github__t1'], cacheCreation: 10_000 }),
    ])]
    const coldTurns = [makeTurn([makeCall({ cacheCreation: 10_000 })])]
    const projects = [
      projectNamed('api', [
        makeSession({ inventory: smallInventory, turns: hotTurns, mcpBreakdown: { github: { calls: 2 } } }),
      ]),
      projectNamed('web', [
        makeSession({ inventory: smallInventory, turns: coldTurns, mcpBreakdown: { github: { calls: 0 } } }),
      ]),
      projectNamed('docs', [
        makeSession({ inventory: smallInventory, turns: coldTurns, mcpBreakdown: { github: { calls: 0 } } }),
      ]),
    ]

    const finding = detectMcpProfileAdvisor(projects)
    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('project-scoped')
    expect(finding!.explanation).toContain('github')
    expect(finding!.explanation).toContain('/tmp/api')
    expect(finding!.explanation).toContain('/tmp/web')
    expect(finding!.explanation).toContain('/tmp/docs')
    // Cold projects each loaded 4 tools. 4 * 400 = 1,600 schema tokens;
    // cache write pricing is 1.25x, across two cold sessions = 4,000.
    expect(finding!.tokensSaved).toBe(4000)
    expect(finding!.fix.type).toBe('paste')
    if (finding!.fix.type === 'paste') {
      expect(finding!.fix.destination).toBe('prompt')
      expect(finding!.fix.text).toContain('Keep github available for /tmp/api')
      expect(finding!.fix.text).toContain('/tmp/web')
      expect(finding!.fix.text).toContain('/tmp/docs')
    }
  })

  it('does not flag servers used evenly across loaded projects', () => {
    const projects = ['api', 'web', 'docs'].map(name => projectNamed(name, [
      makeSession({
        inventory: smallInventory,
        turns: [makeTurn([makeCall({ tools: ['mcp__github__t0'], cacheCreation: 10_000 })])],
        mcpBreakdown: { github: { calls: 2 } },
      }),
    ]))

    expect(detectMcpProfileAdvisor(projects)).toBeNull()
  })

  it('allows a hot profile shared by two projects', () => {
    const projects = [
      projectNamed('api', [
        makeSession({
          inventory: smallInventory,
          turns: [makeTurn([
            makeCall({ tools: ['mcp__github__t0'], cacheCreation: 10_000 }),
            makeCall({ tools: ['mcp__github__t1'], cacheCreation: 10_000 }),
          ])],
          mcpBreakdown: { github: { calls: 2 } },
        }),
      ]),
      projectNamed('web', [
        makeSession({
          inventory: smallInventory,
          turns: [makeTurn([
            makeCall({ tools: ['mcp__github__t0'], cacheCreation: 10_000 }),
            makeCall({ tools: ['mcp__github__t1'], cacheCreation: 10_000 }),
          ])],
          mcpBreakdown: { github: { calls: 2 } },
        }),
      ]),
      projectNamed('docs', [
        makeSession({
          inventory: smallInventory,
          turns: [makeTurn([makeCall({ cacheCreation: 10_000 })])],
          mcpBreakdown: { github: { calls: 0 } },
        }),
      ]),
      projectNamed('playground', [
        makeSession({
          inventory: smallInventory,
          turns: [makeTurn([makeCall({ cacheCreation: 10_000 })])],
          mcpBreakdown: { github: { calls: 0 } },
        }),
      ]),
    ]

    const finding = detectMcpProfileAdvisor(projects)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('/tmp/api')
    expect(finding!.explanation).toContain('/tmp/web')
    expect(finding!.explanation).toContain('/tmp/docs')
    expect(finding!.explanation).toContain('/tmp/playground')
  })

  it('caps profile savings once when multiple candidate servers share cold sessions', () => {
    const githubInventory = Array.from({ length: 4 }, (_, i) => `mcp__github__t${i}`)
    const slackInventory = Array.from({ length: 4 }, (_, i) => `mcp__slack__t${i}`)
    const inventory = [...githubInventory, ...slackInventory]
    const projects = [
      projectNamed('api', [
        makeSession({
          inventory,
          turns: [makeTurn([
            makeCall({ tools: ['mcp__github__t0'] }),
            makeCall({ tools: ['mcp__github__t1'] }),
            makeCall({ tools: ['mcp__slack__t0'] }),
            makeCall({ tools: ['mcp__slack__t1'] }),
          ])],
          mcpBreakdown: { github: { calls: 2 }, slack: { calls: 2 } },
        }),
      ]),
      projectNamed('web', [
        makeSession({
          inventory,
          turns: [makeTurn([makeCall({ cacheCreation: 2_000 })])],
          mcpBreakdown: { github: { calls: 0 }, slack: { calls: 0 } },
        }),
      ]),
      projectNamed('docs', [
        makeSession({
          inventory,
          turns: [makeTurn([makeCall({ cacheCreation: 2_000 })])],
          mcpBreakdown: { github: { calls: 0 }, slack: { calls: 0 } },
        }),
      ]),
    ]

    const finding = detectMcpProfileAdvisor(projects)
    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('2 MCP servers')
    expect(finding!.explanation).toContain('github')
    expect(finding!.explanation).toContain('slack')
    // Each server has 4 tools (1,600 schema tokens), but both servers share
    // the same cold session calls. The combined budget is 3,200 per cold
    // call capped by the 2,000-token cache bucket, not 1,600 + 1,600.
    // 2 cold calls * 2,000 capped write tokens * 1.25 = 5,000.
    expect(finding!.tokensSaved).toBe(5000)
  })

  it('requires at least three loaded projects before recommending a profile', () => {
    const projects = [
      projectNamed('api', [
        makeSession({
          inventory: smallInventory,
          turns: [makeTurn([makeCall({ tools: ['mcp__github__t0'], cacheCreation: 10_000 })])],
          mcpBreakdown: { github: { calls: 2 } },
        }),
      ]),
      projectNamed('web', [
        makeSession({
          inventory: smallInventory,
          turns: [makeTurn([makeCall({ cacheCreation: 10_000 })])],
          mcpBreakdown: { github: { calls: 0 } },
        }),
      ]),
    ]

    expect(detectMcpProfileAdvisor(projects)).toBeNull()
  })

  it('does not duplicate low tool coverage findings for the same server', () => {
    const inventory = Array.from({ length: 12 }, (_, i) => `mcp__huge__t${i}`)
    const projects = [
      projectNamed('api', [
        makeSession({
          inventory,
          turns: [makeTurn([makeCall({ tools: ['mcp__huge__t0'], cacheCreation: 20_000 })])],
          mcpBreakdown: { huge: { calls: 3 } },
        }),
      ]),
      projectNamed('web', [
        makeSession({
          inventory,
          turns: [makeTurn([makeCall({ cacheCreation: 20_000 })])],
          mcpBreakdown: { huge: { calls: 0 } },
        }),
      ]),
      projectNamed('docs', [
        makeSession({
          inventory,
          turns: [makeTurn([makeCall({ cacheCreation: 20_000 })])],
          mcpBreakdown: { huge: { calls: 0 } },
        }),
      ]),
    ]
    const coverage = [{
      server: 'huge',
      toolsAvailable: 12,
      toolsInvoked: 1,
      unusedTools: Array.from({ length: 11 }, (_, i) => `mcp__huge__t${i + 1}`),
      invocations: 3,
      loadedSessions: 3,
      coverageRatio: 1 / 12,
    }]

    expect(detectMcpProfileAdvisor(projects, coverage)).toBeNull()
  })
})
