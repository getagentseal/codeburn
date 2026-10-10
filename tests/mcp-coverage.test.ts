import { describe, it, expect, vi } from 'vitest'

import {
  aggregateMcpCoverage,
  buildOptimizeJsonReport,
  classTotals,
  findingClass,
  detectMcpProfileAdvisor,
  detectMcpToolCoverage,
  estimateMcpSchemaCost,
  runOptimize,
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
    // 30 deferred tools * 9 token name lines = 270 tokens
    const cost = estimateMcpSchemaCost(30, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(270)
    expect(cost.cacheReadTokens).toBe(540)  // 270 + 270 across two ongoing turns
    // effective = write * 1.25 + read * 0.10 (cache pricing)
    expect(cost.effectiveInputTokens).toBeCloseTo(270 * 1.25 + 540 * 0.10, 5)
  })

  it('caps by available cache bucket so we never overclaim', () => {
    const turns = [makeTurn([makeCall({ cacheCreation: 100 })])]
    const sessions = [makeSession({
      inventory: Array.from({ length: 30 }, (_, i) => `mcp__svc__t${i}`),
      turns,
      mcpBreakdown: { svc: { calls: 0 } },
    })]
    // 30*9 = 270 tokens, but the call only had 100 cache-creation,
    // so we should not claim more than 100 of overhead for that turn.
    const cost = estimateMcpSchemaCost(30, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(100)
  })

  it('returns zero when no unused tools', () => {
    const sessions = [makeSession({
      inventory: ['mcp__svc__t1'],
      turns: [makeTurn([makeCall({ cacheCreation: 5000 })])],
    })]
    const cost = estimateMcpSchemaCost(0, [project(sessions)], 'svc')
    expect(cost).toEqual({ cacheWriteTokens: 0, cacheReadTokens: 0, effectiveInputTokens: 0 })
  })

  it('charges a call that read the cached prefix once, as a read', () => {
    // Agent loops write new tool output on nearly every call, so a cache
    // write next to a cache read is not a prefix rebuild: the tool lines
    // were read, not written again.
    const turns = [makeTurn([
      makeCall({ cacheCreation: 50_000, cacheRead: 30_000 }),
    ])]
    const sessions = [makeSession({
      inventory: Array.from({ length: 30 }, (_, i) => `mcp__svc__t${i}`),
      turns,
      mcpBreakdown: { svc: { calls: 0 } },
    })]
    const cost = estimateMcpSchemaCost(30, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(0)
    expect(cost.cacheReadTokens).toBe(270)
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
    expect(cost.cacheWriteTokens).toBe(540) // both rebuilds counted
    expect(cost.cacheReadTokens).toBe(270)
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
    // Two flagged servers, each with 30 unused tools (270 tokens each =
    // 540 combined). One call has a 300 cache-creation bucket. The
    // combined cap means total write tokens reported is min(540, 300) =
    // 300, not min(270, 300) per server = 540.
    const inventory = [
      ...Array.from({ length: 30 }, (_, i) => `mcp__a__t${i}`),
      ...Array.from({ length: 30 }, (_, i) => `mcp__b__t${i}`),
    ]
    const turns = [makeTurn([makeCall({ cacheCreation: 300 })])]
    const sessions = [makeSession({ inventory, turns })]
    const cost = estimateMcpSchemaCost(
      { a: 30, b: 30 },
      [project(sessions)],
      ['a', 'b'],
    )
    expect(cost.cacheWriteTokens).toBe(300)
  })

  it('does not count a duplicated server identifier twice', () => {
    const inventory = Array.from({ length: 20 }, (_, i) => `mcp__svc__t${i}`)
    const sessions = [makeSession({
      inventory,
      turns: [makeTurn([makeCall({ cacheCreation: 50_000 })])],
    })]

    const cost = estimateMcpSchemaCost(
      { svc: 20 },
      [project(sessions)],
      ['svc', 'svc'],
    )

    expect(cost.cacheWriteTokens).toBe(180)
    expect(cost.effectiveInputTokens).toBe(225)
  })

  it('still works with the single-server signature (backward compat)', () => {
    const turns = [makeTurn([makeCall({ cacheCreation: 50_000 })])]
    const sessions = [makeSession({
      inventory: Array.from({ length: 30 }, (_, i) => `mcp__svc__t${i}`),
      turns,
    })]
    const cost = estimateMcpSchemaCost(30, [project(sessions)], 'svc')
    expect(cost.cacheWriteTokens).toBe(270)
  })
})

// ---------------------------------------------------------------------------
// detectMcpToolCoverage — finding emission with thresholds
// ---------------------------------------------------------------------------

describe('detectMcpToolCoverage', () => {
  it('returns null when no inventory exists at all', () => {
    expect(detectMcpToolCoverage([project([makeSession({})])])).toBeNull()
  })

  it('keeps claude.ai connector evidence but emits manual guidance instead of a local remove command', () => {
    const server = 'claude_ai_Netlify'
    const inventory = Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`)
    const turns = [makeTurn([makeCall({ cacheCreation: 50_000 })])]
    const sessions = [
      makeSession({ sessionId: 'a', inventory, turns }),
      makeSession({ sessionId: 'b', inventory, turns }),
    ]

    const finding = detectMcpToolCoverage([project(sessions)])

    expect(finding).not.toBeNull()
    expect(finding!.tokensSaved).toBe(450)
    // Keep the transcript namespace as evidence, but name the connector the
    // way users actually see it in /mcp and claude.ai Settings.
    expect(finding!.explanation).toContain(server)
    expect(finding!.explanation).toContain('claude.ai Netlify')
    expect(finding!.explanation).toContain('/mcp')
    expect(finding!.explanation).toContain('claude.ai Settings > Connectors')
    expect(finding!.fix.type).toBe('paste')
    if (finding!.fix.type === 'paste') {
      expect(finding!.fix.destination).toBe('manual')
      expect(finding!.fix.text).toContain('/mcp')
      expect(finding!.fix.text).toContain('claude.ai Netlify')
      expect(finding!.fix.text).not.toContain(server)
      expect(finding!.fix.text).toContain('claude.ai Settings > Connectors')
    }
    expect(JSON.stringify(finding)).not.toContain('claude mcp remove')
    expect(finding!.apply).toBeUndefined()
  })

  it('renders connector-only remediation as a manual action, never an Ask Claude prompt', async () => {
    const server = 'claude_ai_Google_Calendar'
    const inventory = Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`)
    const turns = [makeTurn([makeCall({ cacheCreation: 50_000 })])]
    const projects = [project([
      makeSession({ sessionId: 'a', inventory, turns }),
      makeSession({ sessionId: 'b', inventory, turns }),
    ])]
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await runOptimize(projects, 'Test period')
      const output = log.mock.calls.map(args => args.join(' ')).join('\n')
      expect(output).toContain('Manual action')
      expect(output).toContain('claude.ai Google Calendar')
      expect(output).not.toContain('Ask Claude in the current session')
    } finally {
      log.mockRestore()
    }
  })

  it('keeps the public optimize JSON envelope while marking connector guidance manual', () => {
    const server = 'claude_ai_Slack'
    const coverage = [{
      server,
      toolsAvailable: 20,
      toolsInvoked: 0,
      unusedTools: Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`),
      invocations: 0,
      loadedSessions: 2,
      coverageRatio: 0,
    }]
    const finding = detectMcpToolCoverage([], coverage)!

    const report = buildOptimizeJsonReport([], 'Test period', {
      findings: [finding],
      costRate: 0,
      healthScore: 90,
      healthGrade: 'A',
    })

    expect(report.findings[0]).toMatchObject({
      id: 'mcp-low-coverage',
      tokensSaved: 0,
      fix: {
        type: 'paste',
        destination: 'manual',
        text: expect.stringContaining('claude.ai Slack'),
      },
    })
    expect(report.findings[0]).not.toHaveProperty('apply')
    expect(report.findings[0]).not.toHaveProperty('applyTokensSaved')
    expect(report.findings[0]).not.toHaveProperty('applyTokensSavedByServer')
    expect(report.findings[0]).not.toHaveProperty('manualFollowUp')
  })

  it('intersects globally unused tool identities with each session inventory', () => {
    const server = 'filesystem'
    const coverage = [{
      server,
      toolsAvailable: 20,
      toolsInvoked: 0,
      unusedTools: Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`),
      invocations: 0,
      loadedSessions: 2,
      coverageRatio: 0,
    }]
    const sessions = [5, 20].map((count, index) => makeSession({
      sessionId: `s${index}`,
      inventory: Array.from({ length: count }, (_, i) => `mcp__${server}__t${i}`),
      turns: [makeTurn([makeCall({ cacheCreation: 50_000 })])],
    }))

    const finding = detectMcpToolCoverage([project(sessions)], coverage)

    // 5*9 and 20*9 name-line tokens, each at 1.25x cache-write pricing.
    expect(finding).toMatchObject({ tokensSaved: 281 })
    expect(finding!.applyTokensSavedByServer?.filesystem).toBe(281.25)
  })

  it('conserves a capped cache-read bucket with fractional shares', () => {
    const inventory = [
      ...Array.from({ length: 15 }, (_, i) => `mcp__filesystem__t${i}`),
      ...Array.from({ length: 11 }, (_, i) => `mcp__claude_ai_Slack__t${i}`),
    ]
    const coverage: McpServerCoverage[] = [
      {
        server: 'filesystem', toolsAvailable: 15, toolsInvoked: 0,
        unusedTools: inventory.slice(0, 15), invocations: 0, loadedSessions: 2, coverageRatio: 0,
      },
      {
        server: 'claude_ai_Slack', toolsAvailable: 11, toolsInvoked: 0,
        unusedTools: inventory.slice(15), invocations: 0, loadedSessions: 2, coverageRatio: 0,
      },
    ]
    // Duplicate inventory entries must not increase the schema share.
    const sessionInventory = [...inventory, inventory[0]!, inventory[15]!]
    const sessions = ['a', 'b'].map(sessionId => makeSession({
      sessionId,
      inventory: sessionInventory,
      turns: [makeTurn([makeCall({ cacheCreation: 5_001, cacheRead: 101 })])],
    }))

    const finding = detectMcpToolCoverage([project(sessions)], coverage)!
    // 26 tools * 9 = 234 tokens, capped at the 101-token read; the call read
    // the prefix, so its cache write is new content, not the tool lines.
    const total = 2 * 101 * 0.10
    const local = total * (15 / 26)

    expect(finding.tokensSaved).toBe(Math.round(total))
    expect(finding.applyTokensSaved).toBe(Math.round(local))
    expect(finding.applyTokensSavedByServer?.filesystem).toBeCloseTo(local, 8)
  })

  it('pluralises manual guidance when only claude.ai connectors are flagged', () => {
    const coverage = ['claude_ai_Slack', 'claude_ai_Google_Calendar'].map(server => ({
      server,
      toolsAvailable: 20,
      toolsInvoked: 0,
      unusedTools: Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`),
      invocations: 0,
      loadedSessions: 2,
      coverageRatio: 0,
    }))

    const finding = detectMcpToolCoverage([], coverage)

    expect(finding).not.toBeNull()
    expect(finding!.fix).toMatchObject({
      type: 'paste',
      destination: 'manual',
      label: 'Manage the underused claude.ai connectors where they load:',
    })
    if (finding!.fix.type === 'paste') {
      expect(finding!.fix.text).toContain('manage them in claude.ai Settings > Connectors')
    }
    expect(finding!.apply).toBeUndefined()
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
    expect(finding!.apply).toEqual({ kind: 'mcp-remove', servers: ['hf'] })
    expect(finding!.tokensSaved).toBeGreaterThan(0)
  })

  it('keeps mixed connector guidance visible while making only the local server executable', () => {
    const inventory = ['filesystem', 'claude_ai_Slack'].flatMap(server =>
      Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`),
    )
    const sessions: SessionSummary[] = [
      makeSession({ sessionId: 'mixed-a', inventory, turns: [makeTurn([makeCall({ cacheCreation: 50_000 })])] }),
      makeSession({ sessionId: 'mixed-b', inventory, turns: [makeTurn([makeCall({ cacheCreation: 50_000 })])] }),
    ]

    const finding = detectMcpToolCoverage([project(sessions)])

    expect(finding).not.toBeNull()
    // The finding describes both opportunities: 40 unused tool lines across
    // two sessions = 900 effective tokens. The automatic mutation owns only
    // the 20 local lines = 450; the connector portion remains manual.
    expect(finding).toMatchObject({ tokensSaved: 900, applyTokensSaved: 450 })
    expect(finding!.explanation).toContain('claude_ai_Slack')
    expect(finding!.explanation).toContain('/mcp')
    expect(finding!.explanation).toContain('claude.ai Settings > Connectors')
    expect(finding!.fix).toEqual({
      type: 'command',
      label: 'Remove the underused local server, or trim its tools in your MCP config:',
      text: "claude mcp remove 'filesystem'",
    })
    expect(finding!.apply).toEqual({ kind: 'mcp-remove', servers: ['filesystem'] })
  })

  it('attributes a capped mixed cache bucket proportionally to the local action', () => {
    const inventory = ['filesystem', 'claude_ai_Slack'].flatMap(server =>
      Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`),
    )
    const sessions = ['a', 'b'].map(sessionId => makeSession({
      sessionId,
      inventory,
      turns: [makeTurn([makeCall({ cacheCreation: 200 })])],
    }))

    const finding = detectMcpToolCoverage([project(sessions)])

    // Each call's 200-token cache bucket is shared evenly by two 180-token
    // tool lists. Total: 2 * 200 * 1.25 = 500. The local mutation owns half.
    expect(finding).toMatchObject({ tokensSaved: 500, applyTokensSaved: 250 })
  })

  it('charges only the flagged servers actually loaded in each session', () => {
    const sessions = ['filesystem', 'claude_ai_Slack'].flatMap(server =>
      ['a', 'b'].map(suffix => makeSession({
        sessionId: `${server}-${suffix}`,
        inventory: Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`),
        turns: [makeTurn([makeCall({ cacheCreation: 50_000 })])],
      })),
    )

    const finding = detectMcpToolCoverage([project(sessions)])

    // Four sessions each load one 180-token tool list. The combined finding
    // must not charge both to every session merely because both are flagged.
    expect(finding).toMatchObject({ tokensSaved: 900, applyTokensSaved: 450 })
  })

  it('disambiguates a claude.ai connector from a similarly named local server', () => {
    const sessions: SessionSummary[] = []
    for (const server of ['claude_ai_Netlify', 'netlify']) {
      const inventory = Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`)
      sessions.push(
        makeSession({ sessionId: `${server}-a`, inventory }),
        makeSession({ sessionId: `${server}-b`, inventory }),
      )
    }

    const finding = detectMcpToolCoverage([project(sessions)])

    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('claude_ai_Netlify')
    expect(finding!.explanation).toContain('separate from any similarly named local MCP server')
    expect(finding!.fix.type).toBe('command')
    if (finding!.fix.type === 'command') {
      expect(finding!.fix.text).toBe("claude mcp remove 'netlify'")
      expect(finding!.fix.text).not.toContain('claude_ai_Netlify')
    }
    expect(finding!.apply).toEqual({ kind: 'mcp-remove', servers: ['netlify'] })
  })

  it('escalates impact to high when token waste crosses the threshold', () => {
    const inventory = Array.from({ length: 200 }, (_, i) => `mcp__big__t${i}`)
    // 200 tools * 9 tokens = 1,800 per call: one write (2,250 effective) and
    // 100 reads (18,000 effective) is ~20k per session, so ten sessions clear
    // the 200k high-impact threshold.
    const turns = [makeTurn([
      makeCall({ tools: ['mcp__big__t0'], cacheCreation: 50_000 }),
      ...Array.from({ length: 100 }, () => makeCall({ cacheRead: 60_000 })),
    ])]
    const sessions = Array.from({ length: 10 }, (_, i) =>
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
    expect(finding!.tokensSaved).toBe(90)
    expect(finding!.fix.type).toBe('paste')
    if (finding!.fix.type === 'paste') {
      expect(finding!.fix.destination).toBe('prompt')
      expect(finding!.fix.text).toContain('Keep github available for /tmp/api')
      expect(finding!.fix.text).toContain('/tmp/web')
      expect(finding!.fix.text).toContain('/tmp/docs')
    }
  })

  it('scopes the remediation label to --provider codex', () => {
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
    const finding = detectMcpProfileAdvisor(projects, undefined, 'codex')
    expect(finding!.fix.label).toBe('Ask Codex to turn this into a project-scoped MCP profile:')
    expect(finding!.fix.label).not.toContain('Claude')
    expect(finding!.fix.label).not.toContain('CLAUDE.md')
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
          turns: [makeTurn([makeCall({ cacheCreation: 50 })])],
          mcpBreakdown: { github: { calls: 0 }, slack: { calls: 0 } },
        }),
      ]),
      projectNamed('docs', [
        makeSession({
          inventory,
          turns: [makeTurn([makeCall({ cacheCreation: 50 })])],
          mcpBreakdown: { github: { calls: 0 }, slack: { calls: 0 } },
        }),
      ]),
    ]

    const finding = detectMcpProfileAdvisor(projects)
    expect(finding).not.toBeNull()
    expect(finding!.title).toContain('2 MCP servers')
    expect(finding!.explanation).toContain('github')
    expect(finding!.explanation).toContain('slack')
    // 2 * 36 tool-line tokens capped once at the 50-token bucket, per cold
    // session: 2 * 50 * 1.25.
    expect(finding!.tokensSaved).toBe(125)
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

// ---------------------------------------------------------------------------
// Connector findings under the fix/nudge/keep classification (#1019)
// ---------------------------------------------------------------------------

describe('connector findings and finding class', () => {
  const inventoryFor = (servers: string[]) => servers.flatMap(server =>
    Array.from({ length: 20 }, (_, i) => `mcp__${server}__t${i}`),
  )
  const twoSessions = (servers: string[]) => ['a', 'b'].map(sessionId => makeSession({
    sessionId,
    inventory: inventoryFor(servers),
    turns: [makeTurn([makeCall({ cacheCreation: 50_000 })])],
  }))

  it('classifies a connector-only finding as a nudge, since nothing is appliable', () => {
    const finding = detectMcpToolCoverage([project(twoSessions(['claude_ai_Gmail']))])

    expect(finding).not.toBeNull()
    expect(finding!.apply).toBeUndefined()
    expect(findingClass(finding!)).toBe('nudge')
    expect(finding!.tokensSaved).toBeGreaterThan(0)
    // Never lands in the "apply-able" subtotal.
    expect(classTotals([finding!], 0.00002).fix).toEqual({ tokensSaved: 0, savingsUSD: 0, count: 0 })
  })

  it('counts only the local subset of a mixed finding towards the apply-able subtotal', () => {
    const finding = detectMcpToolCoverage([project(twoSessions(['filesystem', 'claude_ai_Slack']))])

    expect(finding).not.toBeNull()
    expect(findingClass(finding!)).toBe('fix')
    expect(finding).toMatchObject({ tokensSaved: 900, applyTokensSaved: 450 })
    expect(classTotals([finding!], 0.00002).fix).toEqual({ tokensSaved: 450, savingsUSD: expect.closeTo(0.009, 10), count: 1 })
  })

  it("leaves a local-only finding's subtotal at its full estimate", () => {
    const finding = detectMcpToolCoverage([project(twoSessions(['filesystem']))])

    expect(finding).not.toBeNull()
    expect(finding!.applyTokensSaved).toBeUndefined()
    expect(classTotals([finding!], 0.00002).fix.tokensSaved).toBe(finding!.tokensSaved)
  })

  it('charges each session only for the local schemas it actually loaded', () => {
    // Same per-session scoping the connector split relies on, with no
    // connector in play: two flagged local servers in disjoint sessions are
    // charged one schema each, not both schemas everywhere.
    const sessions = ['filesystem', 'playwright'].flatMap(server =>
      ['a', 'b'].map(suffix => makeSession({
        sessionId: `${server}-${suffix}`,
        inventory: inventoryFor([server]),
        turns: [makeTurn([makeCall({ cacheCreation: 50_000 })])],
      })),
    )

    const finding = detectMcpToolCoverage([project(sessions)])

    expect(finding).toMatchObject({ tokensSaved: 900 })
    expect(finding!.applyTokensSaved).toBeUndefined()
    expect(classTotals([finding!], 0.00002).fix.tokensSaved).toBe(900)
  })

  it('treats a claude_ai_* name owned by local config as a local server', () => {
    const finding = detectMcpToolCoverage(
      [project(twoSessions(['claude_ai_homegrown']))],
      undefined,
      new Set(['claude_ai_homegrown']),
    )

    expect(finding!.fix).toEqual({
      type: 'command',
      label: 'Remove the underused local server, or trim its tools in your MCP config:',
      text: "claude mcp remove 'claude_ai_homegrown'",
    })
    expect(finding!.apply).toEqual({ kind: 'mcp-remove', servers: ['claude_ai_homegrown'] })
    expect(findingClass(finding!)).toBe('fix')
    // Local config owns the name, so the finding must not claim it is a connector.
    expect(finding!.explanation).not.toContain('is a claude.ai connector namespace')
    // ...but the transcript cannot rule out a same-name connector.
    expect(finding!.explanation).toContain('If you also use a claude.ai connector named claude_ai_homegrown')
    expect(finding!.manualFollowUp?.label).toBe('Check for a same-name claude.ai connector:')
    // The whole estimate is appliable: nothing is reserved for a connector.
    expect(finding!.applyTokensSaved).toBeUndefined()
    expect(classTotals([finding!], 0.00002).fix.tokensSaved).toBe(finding!.tokensSaved)
  })

  it('keeps a claude_ai_* name absent from local config a connector', () => {
    const finding = detectMcpToolCoverage(
      [project(twoSessions(['claude_ai_Gmail']))],
      undefined,
      new Set(['filesystem', 'playwright']),
    )

    expect(finding!.fix.type).toBe('paste')
    expect(finding!.apply).toBeUndefined()
    expect(findingClass(finding!)).toBe('nudge')
    expect(finding!.explanation).toContain('is a claude.ai connector namespace')
  })

  it('falls back to prefix-only when no local config could be read', () => {
    // Unreadable or absent config contributes no names, which leaves every
    // claude_ai_* namespace on the conservative connector path.
    const finding = detectMcpToolCoverage([project(twoSessions(['claude_ai_homegrown']))])

    expect(finding!.fix.type).toBe('paste')
    expect(finding!.apply).toBeUndefined()
    expect(findingClass(finding!)).toBe('nudge')
  })

  it('applies the local entry and notes the connector when a name collides', () => {
    const finding = detectMcpToolCoverage(
      [project(twoSessions(['filesystem', 'claude_ai_Slack']))],
      undefined,
      new Set(['filesystem', 'claude_ai_Slack']),
    )

    // Both are local: the removal owns both entries and nothing is deferred.
    expect(finding!.apply).toEqual({ kind: 'mcp-remove', servers: ['filesystem', 'claude_ai_Slack'] })
    expect(finding!.applyTokensSaved).toBeUndefined()
    expect(classTotals([finding!], 0.00002).fix.tokensSaved).toBe(900)
    expect(finding!.explanation).not.toContain('is a claude.ai connector namespace')
    expect(finding!.manualFollowUp?.text)
      .toBe('If you also use a claude.ai connector named claude_ai_Slack, manage it with /mcp or in claude.ai Settings > Connectors.')
  })
})
