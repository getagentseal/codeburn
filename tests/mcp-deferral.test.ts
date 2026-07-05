import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import {
  detectMcpDeferralOff,
  detectMcpAlwaysLoadHygiene,
  detectMcpDeferThreshold,
  findDeferralEnvSetting,
  type ApiCallMeta,
  type ToolCall,
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
// Test fixtures (same conventions as tests/mcp-coverage.test.ts)
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

function makeCall(opts: { tools?: string[]; provider?: string } = {}): ParsedApiCall {
  const tools = opts.tools ?? []
  return {
    provider: opts.provider ?? 'claude',
    model: 'Opus 4.7',
    usage: { ...ZERO_USAGE },
    costUSD: 0,
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
  return {
    project: 'p',
    projectPath: '/tmp/p',
    sessions,
    totalCostUSD: 0,
    totalApiCalls: sessions.reduce((s, ses) => s + ses.apiCalls, 0),
  }
}

function toolCall(name: string): ToolCall {
  return { name, input: {}, sessionId: 's1', project: 'p' }
}

function apiCall(version: string): ApiCallMeta {
  return { cacheCreationTokens: 0, version }
}

// ---------------------------------------------------------------------------
// Filesystem fixtures: every detector call injects a temp home dir and temp
// project cwds so the developer's real ~/.claude config never leaks in.
// ---------------------------------------------------------------------------

const FIXTURE_ROOTS: string[] = []

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  FIXTURE_ROOTS.push(dir)
  return dir
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, JSON.stringify(value))
}

afterAll(() => {
  for (const dir of FIXTURE_ROOTS) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A minimal Claude-provider turn: the deferral detectors count only Claude
// Code sessions (identified by turn provider), since deferral is a Claude
// Code mechanism and other providers can never carry the counter-evidence.
function claudeTurns(): ClassifiedTurn[] {
  return [makeTurn([makeCall()])]
}

// Two sessions that invoked an MCP server but never observed an inventory:
// the canonical deferral-off transcript shape.
function deferralOffSessions(): SessionSummary[] {
  const turns = [makeTurn([makeCall({ tools: ['mcp__srv__t1'] })])]
  return [
    makeSession({ sessionId: 'a', turns, mcpBreakdown: { srv: { calls: 2 } } }),
    makeSession({ sessionId: 'b', turns, mcpBreakdown: { srv: { calls: 1 } } }),
  ]
}

// ---------------------------------------------------------------------------
// findDeferralEnvSetting
// ---------------------------------------------------------------------------

describe('findDeferralEnvSetting', () => {
  it('returns null when nothing is configured', () => {
    const home = makeDir('codeburn-home-')
    expect(findDeferralEnvSetting('ENABLE_TOOL_SEARCH', [], home)).toBeNull()
  })

  it('reads settings.json env fields before shell profiles', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'false' } })
    writeFile(join(home, '.zshrc'), 'export ENABLE_TOOL_SEARCH=true\n')
    const hit = findDeferralEnvSetting('ENABLE_TOOL_SEARCH', [], home)
    expect(hit).not.toBeNull()
    expect(hit!.value).toBe('false')
    expect(hit!.scope).toBe('user settings')
  })

  it('matches shell profile lines with and without export', () => {
    const home = makeDir('codeburn-home-')
    writeFile(join(home, '.bashrc'), '# config\nENABLE_TOOL_SEARCH="auto:25"\n')
    const hit = findDeferralEnvSetting('ENABLE_TOOL_SEARCH', [], home)
    expect(hit).not.toBeNull()
    expect(hit!.value).toBe('auto:25')
    expect(hit!.scope).toBe('shell profile')
  })

  it('prefers the most-specific scope, matching effective settings precedence', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'true' } })
    writeJson(join(cwd, '.claude', 'settings.local.json'), { env: { ENABLE_TOOL_SEARCH: 'false' } })
    const hit = findDeferralEnvSetting('ENABLE_TOOL_SEARCH', [cwd], home)
    expect(hit).not.toBeNull()
    expect(hit!.value).toBe('false')
    expect(hit!.scope).toBe('project local settings')
  })
})

// ---------------------------------------------------------------------------
// detectMcpDeferralOff
// ---------------------------------------------------------------------------

describe('detectMcpDeferralOff', () => {
  it('returns null for users with no MCP at all', () => {
    const home = makeDir('codeburn-home-')
    const projects = [project([makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })])]
    expect(detectMcpDeferralOff([], projects, new Set(), [], home)).toBeNull()
  })

  it('returns null when ToolSearch calls prove deferral was active', () => {
    const home = makeDir('codeburn-home-')
    const calls = [toolCall('ToolSearch'), toolCall('mcp__srv__t1')]
    const projects = [project(deferralOffSessions())]
    expect(detectMcpDeferralOff(calls, projects, new Set(), [], home)).toBeNull()
  })

  it('returns null when any session observed an MCP inventory (deferral active)', () => {
    const home = makeDir('codeburn-home-')
    const sessions = [
      ...deferralOffSessions(),
      makeSession({ sessionId: 'c', inventory: ['mcp__srv__t1'] }),
    ]
    expect(detectMcpDeferralOff([], [project(sessions)], new Set(), [], home)).toBeNull()
  })

  it('returns null below the minimum MCP-evidence session count', () => {
    const home = makeDir('codeburn-home-')
    const sessions = [
      makeSession({ sessionId: 'a', turns: claudeTurns(), mcpBreakdown: { srv: { calls: 3 } } }),
      makeSession({ sessionId: 'b', turns: claudeTurns() }),
    ]
    expect(detectMcpDeferralOff([], [project(sessions)], new Set(), [], home)).toBeNull()
  })

  it('ignores MCP usage from non-Claude providers (no counter-evidence exists there)', () => {
    const home = makeDir('codeburn-home-')
    // Codex/Copilot parsers normalize MCP calls into mcpBreakdown too, but
    // those sessions can never show ToolSearch calls or an inventory, so
    // they must not count as deferral-off evidence.
    const codexTurns = [makeTurn([makeCall({ provider: 'codex', tools: ['mcp__srv__t1'] })])]
    const sessions = [
      makeSession({ sessionId: 'a', turns: codexTurns, mcpBreakdown: { srv: { calls: 4 } } }),
      makeSession({ sessionId: 'b', turns: codexTurns, mcpBreakdown: { srv: { calls: 4 } } }),
    ]
    expect(detectMcpDeferralOff([], [project(sessions)], new Set(), [], home)).toBeNull()
  })

  it('emits the generic cause when no config explains the gap', () => {
    const home = makeDir('codeburn-home-')
    const projects = [project(deferralOffSessions())]
    const finding = detectMcpDeferralOff([], projects, new Set(), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-deferral-off')
    expect(finding!.explanation).toContain('none determinable')
    expect(finding!.explanation).toContain('zero ToolSearch calls')
    // 1 server x 5 tools x 400 tokens x 2 affected sessions
    expect(finding!.tokensSaved).toBe(4000)
    // 3 invocations / 2 sessions
    expect(finding!.explanation).toContain('1.5 MCP calls/session')
  })

  it('counts every Claude session as affected when servers come from config', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { srv: { command: 'x' } } })
    const sessions = [
      makeSession({ sessionId: 'a', turns: claudeTurns() }),
      makeSession({ sessionId: 'b', turns: claudeTurns() }),
      makeSession({ sessionId: 'c', turns: claudeTurns() }),
      // Non-Claude sessions never carry the upfront schema cost.
      makeSession({ sessionId: 'd', turns: [makeTurn([makeCall({ provider: 'codex' })])] }),
    ]
    const finding = detectMcpDeferralOff([], [project(sessions)], new Set([cwd]), [], home)
    expect(finding).not.toBeNull()
    // 1 configured server x 2000 tokens x 3 Claude sessions
    expect(finding!.tokensSaved).toBe(6000)
  })

  it('excludes alwaysLoad-pinned servers: all pinned means no finding', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    // Deferral working with every server deliberately pinned: pinned tools
    // are never deferred, so no inventory and no ToolSearch calls is the
    // EXPECTED shape, not evidence of a gap.
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
    const sessions = [
      makeSession({ sessionId: 'a', turns: claudeTurns(), mcpBreakdown: { pinned: { calls: 2 } } }),
      makeSession({ sessionId: 'b', turns: claudeTurns(), mcpBreakdown: { pinned: { calls: 1 } } }),
    ]
    expect(detectMcpDeferralOff([], [project(sessions)], new Set([cwd]), [], home)).toBeNull()
  })

  it('charges only unpinned servers when pinned and unpinned coexist', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    // The pinned server's schema is mcp-alwaysload-hygiene's jurisdiction;
    // charging it here too would double-count the same tokens.
    writeJson(join(cwd, '.mcp.json'), {
      mcpServers: {
        pinned: { command: 'x', alwaysLoad: true },
        srv: { command: 'y' },
      },
    })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set([cwd]), [], home)
    expect(finding).not.toBeNull()
    // 1 unpinned server x 2000 tokens x 2 sessions (not 2 servers x ...)
    expect(finding!.tokensSaved).toBe(4000)
  })

  it('attributes ENABLE_TOOL_SEARCH=false in user settings', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'false' } })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('ENABLE_TOOL_SEARCH=false')
    expect(finding!.explanation).toContain('user settings')
    expect(finding!.fix.type).toBe('paste')
    expect((finding!.fix as { text: string }).text).toContain('Remove the ENABLE_TOOL_SEARCH=false setting')
  })

  it('attributes ENABLE_TOOL_SEARCH=false in user local settings', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.local.json'), { env: { ENABLE_TOOL_SEARCH: 'false' } })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('user local settings')
  })

  it('attributes ENABLE_TOOL_SEARCH=false in project settings, naming the path', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'false' } })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set([cwd]), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('project settings')
    expect(finding!.explanation).toContain(cwd)
  })

  it('attributes ENABLE_TOOL_SEARCH=false in project local settings, naming the path', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.claude', 'settings.local.json'), { env: { ENABLE_TOOL_SEARCH: 'false' } })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set([cwd]), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('project local settings')
    expect(finding!.explanation).toContain(cwd)
  })

  it('attributes ENABLE_TOOL_SEARCH=false in a shell profile', () => {
    const home = makeDir('codeburn-home-')
    writeFile(join(home, '.zshrc'), 'export ENABLE_TOOL_SEARCH=false\n')
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('shell profile')
  })

  it('attributes a non-first-party ANTHROPIC_BASE_URL with unknown-proxy wording', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://llm-proxy.corp.example:8443/v1' } })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('non-first-party host')
    expect(finding!.explanation).toContain('unknown')
    // Must not claim the proxy is incapable.
    expect(finding!.explanation).not.toContain('incapable')
    expect(finding!.fix.label).toContain('tool_reference')
  })

  it('treats api.anthropic.com as first-party and falls through to generic', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('none determinable')
  })

  it('attributes CLAUDE_CODE_USE_VERTEX', () => {
    const home = makeDir('codeburn-home-')
    writeFile(join(home, '.bashrc'), 'export CLAUDE_CODE_USE_VERTEX=1\n')
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('Vertex')
  })

  it('attributes Claude Code versions predating tool search default-on (v2.1.7)', () => {
    const home = makeDir('codeburn-home-')
    const apiCalls = [apiCall('2.0.14'), apiCall('2.1.6')]
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), apiCalls, home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('predates v2.1.7')
    expect(finding!.fix.type).toBe('command')
    expect((finding!.fix as { text: string }).text).toBe('claude update')
  })

  it('does not blame the version when any observed version has default-on tool search', () => {
    const home = makeDir('codeburn-home-')
    const apiCalls = [apiCall('2.0.14'), apiCall('2.1.30')]
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), apiCalls, home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('none determinable')
  })

  it('yields to the defer-threshold detector when an auto override is set', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto:50' } })
    expect(detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)).toBeNull()
  })

  it('does not re-suggest the export when ENABLE_TOOL_SEARCH=true is already set', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'true' } })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('none determinable')
    expect(finding!.explanation).toContain('ENABLE_TOOL_SEARCH=true is already set')
    expect((finding!.fix as { text: string }).text).not.toContain('export ENABLE_TOOL_SEARCH=true')
  })
})

// ---------------------------------------------------------------------------
// Family handoff: every auto value must land in exactly one detector
// ---------------------------------------------------------------------------

describe('deferral-off / defer-threshold handoff', () => {
  it('an out-of-range auto:N produces exactly one finding from the family', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    // auto:1234 is nonsense-but-reachable: the threshold can never trigger.
    // deferral-off must yield AND defer-threshold must accept (clamping to
    // 100%), or the value would silently suppress both findings.
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto:1234' } })
    const mcpServers: Record<string, unknown> = { srv0: { command: 'x' }, srv1: { command: 'x' }, srv2: { command: 'x' } }
    writeJson(join(cwd, '.mcp.json'), { mcpServers })
    const projects = [project(deferralOffSessions())]

    const offFinding = detectMcpDeferralOff([], projects, new Set([cwd]), [], home)
    const thresholdFinding = detectMcpDeferThreshold(projects, new Set([cwd]), home)
    expect(offFinding).toBeNull()
    expect(thresholdFinding).not.toBeNull()
    expect(thresholdFinding!.id).toBe('mcp-defer-threshold')
    // Clamped to the 100% ceiling of the 200k window.
    expect(thresholdFinding!.explanation).toContain('100%')
  })
})

// ---------------------------------------------------------------------------
// detectMcpAlwaysLoadHygiene
// ---------------------------------------------------------------------------

describe('detectMcpAlwaysLoadHygiene', () => {
  function fiveSessions(callsForPinned: number): SessionSummary[] {
    return Array.from({ length: 5 }, (_, i) => makeSession({
      sessionId: `s${i}`,
      mcpBreakdown: i === 0 && callsForPinned > 0 ? { pinned: { calls: callsForPinned } } : {},
    }))
  }

  it('returns null when no server sets alwaysLoad', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x' } } })
    expect(detectMcpAlwaysLoadHygiene([project(fiveSessions(0))], new Set([cwd]), [], undefined, home)).toBeNull()
  })

  it('flags an alwaysLoad server with usage below one call per five sessions', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
    const finding = detectMcpAlwaysLoadHygiene([project(fiveSessions(0))], new Set([cwd]), [], undefined, home)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-alwaysload-hygiene')
    expect(finding!.explanation).toContain('pinned: 0 calls across 5 sessions')
    // No inventory -> 5 tools x 400 tokens fallback, charged in all 5 sessions
    expect(finding!.tokensSaved).toBe(10_000)
    expect((finding!.fix as { text: string }).text).toContain('"alwaysLoad": true')
    expect((finding!.fix as { text: string }).text).toContain('.mcp.json')
  })

  it('does not flag an alwaysLoad server at or above the call-rate threshold', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
    // 1 call / 5 sessions = 0.2 exactly; the threshold flags only strictly below.
    expect(detectMcpAlwaysLoadHygiene([project(fiveSessions(1))], new Set([cwd]), [], undefined, home)).toBeNull()
  })

  it('prefers observed inventory tool counts and loaded sessions when available', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
    const inventory = Array.from({ length: 8 }, (_, i) => `mcp__pinned__t${i}`)
    const sessions = [
      makeSession({ sessionId: 'a', inventory }),
      makeSession({ sessionId: 'b', inventory }),
      makeSession({ sessionId: 'c' }),
      makeSession({ sessionId: 'd' }),
      makeSession({ sessionId: 'e' }),
    ]
    const finding = detectMcpAlwaysLoadHygiene([project(sessions)], new Set([cwd]), [], undefined, home)
    expect(finding).not.toBeNull()
    // 8 tools x 400 tokens x 2 loaded sessions
    expect(finding!.tokensSaved).toBe(6400)
  })

  it('does not flag an alwaysLoad server clearly over the call-rate threshold', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
    // 5 calls / 5 sessions = 1.0, well over the 0.2 threshold.
    expect(detectMcpAlwaysLoadHygiene([project(fiveSessions(5))], new Set([cwd]), [], undefined, home)).toBeNull()
  })

  it('returns null when there are no sessions in the window', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
    expect(detectMcpAlwaysLoadHygiene([], new Set([cwd]), [], undefined, home)).toBeNull()
  })

  it('returns null when every observed version predates server-level alwaysLoad (v2.1.121)', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
    // On these versions the key is inert: tools defer normally, no cost.
    const apiCalls = [apiCall('2.1.100'), apiCall('2.1.120')]
    expect(detectMcpAlwaysLoadHygiene([project(fiveSessions(0))], new Set([cwd]), apiCalls, undefined, home)).toBeNull()
  })

  it('still flags when any observed version supports alwaysLoad', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
    const apiCalls = [apiCall('2.1.100'), apiCall('2.1.121')]
    expect(detectMcpAlwaysLoadHygiene([project(fiveSessions(0))], new Set([cwd]), apiCalls, undefined, home)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// detectMcpDeferThreshold
// ---------------------------------------------------------------------------

describe('detectMcpDeferThreshold', () => {
  function mcpJsonWithServers(count: number): Record<string, unknown> {
    const mcpServers: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) mcpServers[`srv${i}`] = { command: 'x' }
    return { mcpServers }
  }

  it('returns null when ENABLE_TOOL_SEARCH is not configured', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), mcpJsonWithServers(3))
    expect(detectMcpDeferThreshold([project([makeSession({ turns: claudeTurns() })])], new Set([cwd]), home)).toBeNull()
  })

  it('returns null for non-auto values like true or false', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), mcpJsonWithServers(3))
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'true' } })
    expect(detectMcpDeferThreshold([project([makeSession({ turns: claudeTurns() })])], new Set([cwd]), home)).toBeNull()
  })

  it('flags an auto threshold that the estimated defs fit under', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    // 3 servers x 5 tools x 400 tokens = 6k defs/session, under the default
    // 10% of 200k (20k) but over the 5k substantial-cost floor.
    writeJson(join(cwd, '.mcp.json'), mcpJsonWithServers(3))
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto' } })
    const sessions = [
      makeSession({ sessionId: 'a', turns: claudeTurns() }),
      makeSession({ sessionId: 'b', turns: claudeTurns() }),
    ]
    const finding = detectMcpDeferThreshold([project(sessions)], new Set([cwd]), home)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-defer-threshold')
    expect(finding!.impact).toBe('low')
    // 6k defs/session x 2 sessions
    expect(finding!.tokensSaved).toBe(12_000)
    // Largest N where 6k defs still exceed N% of 200k: N=2 (6000 > 4000)
    expect((finding!.fix as { text: string }).text).toContain('ENABLE_TOOL_SEARCH=auto:2')
  })

  it('returns null when defs exceed the configured threshold (auto already defers)', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    // 6k defs/session vs auto:2 threshold of 4k -> deferral kicks in.
    writeJson(join(cwd, '.mcp.json'), mcpJsonWithServers(3))
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto:2' } })
    expect(detectMcpDeferThreshold([project([makeSession({ turns: claudeTurns() })])], new Set([cwd]), home)).toBeNull()
  })

  it('returns null when the upfront defs are not substantial', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    // 2 servers = 4k defs/session, under the 5k floor.
    writeJson(join(cwd, '.mcp.json'), mcpJsonWithServers(2))
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto' } })
    expect(detectMcpDeferThreshold([project([makeSession({ turns: claudeTurns() })])], new Set([cwd]), home)).toBeNull()
  })

  it('returns null when an inventory shows deferral already working', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), mcpJsonWithServers(3))
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto' } })
    const sessions = [makeSession({ inventory: ['mcp__srv0__t1'] })]
    expect(detectMcpDeferThreshold([project(sessions)], new Set([cwd]), home)).toBeNull()
  })

  it('recommends removing the override when defs already exceed the default 10%', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    // 15 servers = 30k defs/session: fits under auto:50 (100k) but exceeds
    // the default 10% (20k), so dropping the override is enough.
    writeJson(join(cwd, '.mcp.json'), mcpJsonWithServers(15))
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto:50' } })
    const finding = detectMcpDeferThreshold([project([makeSession({ turns: claudeTurns() })])], new Set([cwd]), home)
    expect(finding).not.toBeNull()
    expect((finding!.fix as { text: string }).text).toContain('Remove the ENABLE_TOOL_SEARCH=auto:50 override')
  })

  it('returns null for users with no MCP servers at all', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto' } })
    expect(detectMcpDeferThreshold([project([makeSession({ turns: claudeTurns() })])], new Set(), home)).toBeNull()
  })

  it('returns null when there are no sessions in the window', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), mcpJsonWithServers(3))
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto' } })
    // Configured servers but zero sessions: no phantom "all 0 sessions"
    // finding and no fabricated tokensSaved.
    expect(detectMcpDeferThreshold([project([])], new Set([cwd]), home)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Apply payloads: the machine data src/act/plans.ts turns into defer-enable /
// defer-alwaysload / defer-threshold plans (#614 commit 2). Human-facing
// explanation/fix text is covered above and must not change.
// ---------------------------------------------------------------------------

describe('deferral finding apply payloads', () => {
  it('env-false carries a defer-enable payload naming the settings file, scope, and value', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'false' } })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding!.apply).toEqual({
      kind: 'defer-enable',
      cause: 'env-false',
      settingPath: join(home, '.claude', 'settings.json'),
      settingScope: 'user settings',
      value: 'false',
    })
  })

  it('env-false in a shell profile keeps the shell-profile scope so the plan layer can refuse', () => {
    const home = makeDir('codeburn-home-')
    writeFile(join(home, '.zshrc'), 'export ENABLE_TOOL_SEARCH=false\n')
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding!.apply).toMatchObject({ kind: 'defer-enable', cause: 'env-false', settingScope: 'shell profile' })
  })

  it('an unknown proxy carries cause proxy-unknown pointing at the base-URL setting', () => {
    const home = makeDir('codeburn-home-')
    writeJson(join(home, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: 'https://llm-proxy.corp.example' } })
    const finding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(finding!.apply).toMatchObject({
      kind: 'defer-enable',
      cause: 'proxy-unknown',
      settingPath: join(home, '.claude', 'settings.json'),
    })
  })

  it('Vertex and old-version carry their refusal causes', () => {
    const homeVertex = makeDir('codeburn-home-')
    writeFile(join(homeVertex, '.bashrc'), 'export CLAUDE_CODE_USE_VERTEX=1\n')
    const vertexFinding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], homeVertex)
    expect(vertexFinding!.apply).toMatchObject({ kind: 'defer-enable', cause: 'vertex' })

    const homeOld = makeDir('codeburn-home-')
    const oldFinding = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [apiCall('2.0.14')], homeOld)
    expect(oldFinding!.apply).toEqual({ kind: 'defer-enable', cause: 'old-version' })
  })

  it('the generic none-determinable causes carry no payload (nothing appliable)', () => {
    const home = makeDir('codeburn-home-')
    const generic = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], home)
    expect(generic!.apply).toBeUndefined()

    const homeTrue = makeDir('codeburn-home-')
    writeJson(join(homeTrue, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'true' } })
    const alreadyOn = detectMcpDeferralOff([], [project(deferralOffSessions())], new Set(), [], homeTrue)
    expect(alreadyOn!.apply).toBeUndefined()
  })

  it('alwaysload-hygiene payload names each flagged server and the exact files carrying the pin', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    writeJson(join(cwd, '.mcp.json'), { mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
    const sessions = Array.from({ length: 5 }, (_, i) => makeSession({ sessionId: `s${i}` }))
    const finding = detectMcpAlwaysLoadHygiene([project(sessions)], new Set([cwd]), [], undefined, home)
    expect(finding!.apply).toEqual({
      kind: 'defer-alwaysload',
      servers: [{ server: 'pinned', paths: [join(cwd, '.mcp.json')] }],
    })
  })

  it('defer-threshold payload carries the override location, tightened N, and removal flag', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    const mcpServers: Record<string, unknown> = {}
    for (let i = 0; i < 3; i++) mcpServers[`srv${i}`] = { command: 'x' }
    writeJson(join(cwd, '.mcp.json'), { mcpServers })
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto' } })
    const finding = detectMcpDeferThreshold([project([makeSession({ turns: claudeTurns() })])], new Set([cwd]), home)
    expect(finding!.apply).toEqual({
      kind: 'defer-threshold',
      settingPath: join(home, '.claude', 'settings.json'),
      settingScope: 'user settings',
      value: 'auto',
      recommendedPercent: 2,
      removeOverride: false,
    })
  })

  it('defer-threshold payload sets removeOverride when the default threshold already defers', () => {
    const home = makeDir('codeburn-home-')
    const cwd = makeDir('codeburn-cwd-')
    const mcpServers: Record<string, unknown> = {}
    for (let i = 0; i < 15; i++) mcpServers[`srv${i}`] = { command: 'x' }
    writeJson(join(cwd, '.mcp.json'), { mcpServers })
    writeJson(join(home, '.claude', 'settings.json'), { env: { ENABLE_TOOL_SEARCH: 'auto:50' } })
    const finding = detectMcpDeferThreshold([project([makeSession({ turns: claudeTurns() })])], new Set([cwd]), home)
    expect(finding!.apply).toMatchObject({ kind: 'defer-threshold', value: 'auto:50', removeOverride: true })
  })
})
