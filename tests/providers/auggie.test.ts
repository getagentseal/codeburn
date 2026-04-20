import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createAuggieProvider } from '../../src/providers/auggie.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const FIXTURE_DIR = new URL('../fixtures/auggie/', import.meta.url).pathname

let workDir: string
let sessionsDir: string
let cacheDir: string

async function collectCalls(
  sessionPath: string,
): Promise<ParsedProviderCall[]> {
  const provider = createAuggieProvider(sessionsDir)
  const sources = await provider.discoverSessions()
  const target = sources.find(s => s.path === sessionPath)
  expect(target, `source not found for ${sessionPath}`).toBeDefined()
  const parser = provider.createSessionParser(target!, new Set())
  const out: ParsedProviderCall[] = []
  for await (const call of parser.parse()) out.push(call)
  return out
}

async function stageFixture(name: string): Promise<string> {
  const dest = join(sessionsDir, name)
  await copyFile(join(FIXTURE_DIR, name), dest)
  return dest
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'codeburn-auggie-test-'))
  sessionsDir = join(workDir, 'sessions')
  cacheDir = join(workDir, 'cache')
  await mkdir(sessionsDir, { recursive: true })
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  delete process.env['CODEBURN_CACHE_DIR']
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CODEBURN_AUGGIE_')) delete process.env[k]
  }
  if (existsSync(workDir)) await rm(workDir, { recursive: true, force: true })
})

describe('auggie provider - discovery', () => {
  it('finds JSON session files and tags them with the provider name', async () => {
    await stageFixture('single-call.json')
    await stageFixture('tool-loop.json')
    const provider = createAuggieProvider(sessionsDir)
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(2)
    for (const s of sources) {
      expect(s.provider).toBe('auggie')
      expect(s.path.endsWith('.json')).toBe(true)
    }
  })

  it('excludes the credentials file (session.json) even if present in sessions dir', async () => {
    await stageFixture('single-call.json')
    await writeFile(join(sessionsDir, 'session.json'), '{"accessToken":"REDACTED"}', 'utf-8')
    const provider = createAuggieProvider(sessionsDir)
    const sources = await provider.discoverSessions()
    expect(sources.map(s => s.path).some(p => p.endsWith('session.json'))).toBe(false)
  })

  it('returns an empty list when the sessions directory does not exist', async () => {
    const provider = createAuggieProvider(join(workDir, 'does-not-exist'))
    const sources = await provider.discoverSessions()
    expect(sources).toEqual([])
  })
})

describe('auggie provider - parsing', () => {
  it('emits one ParsedProviderCall per response_node with a token_usage block', async () => {
    const path = await stageFixture('single-call.json')
    const calls = await collectCalls(path)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.provider).toBe('auggie')
    expect(call.model).toBe('claude-sonnet-4-5')
    expect(call.inputTokens).toBe(5)
    expect(call.outputTokens).toBe(120)
    expect(call.cacheCreationInputTokens).toBe(1000)
    expect(call.cacheReadInputTokens).toBe(0)
    expect(call.deduplicationKey).toBe(
      'auggie:11111111-1111-4111-8111-111111111111:req-aaaa0001:0',
    )
    expect(call.costUSD).toBeGreaterThan(0)
  })

  it('emits one call per populated response_node in a tool loop and skips the empty final node', async () => {
    const path = await stageFixture('tool-loop.json')
    const calls = await collectCalls(path)
    expect(calls).toHaveLength(3)
    expect(calls.map(c => c.deduplicationKey)).toEqual([
      'auggie:22222222-2222-4222-8222-222222222222:req-bbbb0001:0',
      'auggie:22222222-2222-4222-8222-222222222222:req-bbbb0001:1',
      'auggie:22222222-2222-4222-8222-222222222222:req-bbbb0001:2',
    ])
    expect(calls[0].tools).toEqual(['view'])
    expect(calls[1].tools).toEqual(['launch-process'])
    expect(calls[2].tools).toEqual(['read_note_workspace-mcp'])
  })

  it('extracts bash commands from launch-process tool_use input', async () => {
    const path = await stageFixture('tool-loop.json')
    const calls = await collectCalls(path)
    const launchCall = calls.find(c => c.tools.includes('launch-process'))!
    expect(launchCall.bashCommands).toEqual(expect.arrayContaining(['ls', 'echo']))
  })

  it('falls back to provider-aware default when agentState.modelId is empty', async () => {
    const path = await stageFixture('tool-loop.json')
    const calls = await collectCalls(path)
    for (const call of calls) expect(call.model).toBe('claude-sonnet-4-5')
  })

  it('respects CODEBURN_AUGGIE_DEFAULT_ANTHROPIC override', async () => {
    process.env['CODEBURN_AUGGIE_DEFAULT_ANTHROPIC'] = 'claude-haiku-4-5'
    const path = await stageFixture('tool-loop.json')
    const calls = await collectCalls(path)
    for (const call of calls) expect(call.model).toBe('claude-haiku-4-5')
  })

  it('aliases the Augment-internal "butler" model id to claude-haiku-4-5 for pricing', async () => {
    const path = await stageFixture('old-schema.json')
    const calls = await collectCalls(path)
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('claude-haiku-4-5')
    expect(calls[0].costUSD).toBeGreaterThan(0)
  })

  it('tolerates the old schema (no creditUsage / subAgentCreditsUsed / rootTaskUuid keys)', async () => {
    const path = await stageFixture('old-schema.json')
    const calls = await collectCalls(path)
    expect(calls).toHaveLength(1)
    expect(calls[0].inputTokens).toBe(10)
    expect(calls[0].outputTokens).toBe(50)
  })

  it('tags sub-agent sessions with the root task uuid in the sessionId', async () => {
    const path = await stageFixture('sub-agent.json')
    const calls = await collectCalls(path)
    expect(calls).toHaveLength(1)
    expect(calls[0].sessionId).toBe(
      '44444444-4444-4444-8444-444444444444#sub:root-task-0001',
    )
  })
})

describe('auggie provider - cache', () => {
  it('caches parsed calls and serves them from disk on the next parse with no file change', async () => {
    const path = await stageFixture('single-call.json')
    const first = await collectCalls(path)
    // Cache file lives under CODEBURN_CACHE_DIR/auggie/<uuid>.json
    const cacheFile = join(cacheDir, 'auggie', 'single-call.json')
    expect(existsSync(cacheFile)).toBe(false)
    // Second parse triggers the write-back via `void writeCachedCalls`; give it a moment.
    await new Promise(r => setTimeout(r, 50))
    expect(existsSync(cacheFile)).toBe(true)
    const second = await collectCalls(path)
    expect(second).toEqual(first)
  })

  it('re-parses when the session file mtime changes', async () => {
    const path = await stageFixture('single-call.json')
    await collectCalls(path)
    await new Promise(r => setTimeout(r, 50))
    // Bump mtime to force cache invalidation.
    const future = new Date(Date.now() + 60_000)
    await utimes(path, future, future)
    const calls = await collectCalls(path)
    expect(calls).toHaveLength(1)
    // Still produces the same deduplication key; just re-parsed rather than cache-hit.
    expect(calls[0].deduplicationKey).toBe(
      'auggie:11111111-1111-4111-8111-111111111111:req-aaaa0001:0',
    )
  })
})

describe('auggie provider - modern schema', () => {
  it('tools attach to first call only; subsequent calls have empty tools', async () => {
    const path = await stageFixture('modern-schema.json')
    const calls = await collectCalls(path)
    // modern-schema.json has 2 type-10 nodes, so 2 calls
    expect(calls.length).toBe(2)
    // First call should have all tools (view, launch-process)
    expect(calls[0].tools.length).toBeGreaterThan(0)
    expect(calls[0].tools).toContain('view')
    expect(calls[0].tools).toContain('launch-process')
    // Subsequent calls should have empty tools
    expect(calls[1].tools).toEqual([])
  })

  it('extracts bash commands from input_json in type-5 tool_use nodes', async () => {
    const path = await stageFixture('modern-schema.json')
    const calls = await collectCalls(path)
    // Bash commands attached to first call only
    expect(calls[0].bashCommands).toContain('npm')
    expect(calls[0].bashCommands).toContain('echo')
  })

  it('credits come from type-9 billing_metadata (or synthesized from billing engine)', async () => {
    const path = await stageFixture('modern-schema.json')
    const calls = await collectCalls(path)
    // First call should have ground-truth credits from type-9
    expect(calls[0].credits).toBe(42.5)
    // Subsequent calls have synthesized credits from billing engine (no ground-truth)
    // The billing engine always computes credits now, so this won't be null
    expect(calls[1].credits).toBeTypeOf('number')
    expect(calls[1].credits).toBeGreaterThanOrEqual(0)
    // Check billing result for more details
    expect(calls[0].billing?.synthesized).toBe(false) // ground truth
    expect(calls[1].billing?.synthesized).toBe(true) // synthesized
  })

  it('session.creditUsage fast-path: sessionCreditUsage present on first call', async () => {
    const path = await stageFixture('modern-schema.json')
    const calls = await collectCalls(path)
    // sessionCreditUsage should be on first call for session-level total
    expect(calls[0].sessionCreditUsage).toBe(42.5)
  })
})

describe('auggie provider - legacy schema', () => {
  it('session with empty modelId and no provider hint buckets as auggie-legacy', async () => {
    // legacy-no-provider.json: empty modelId AND no metadata.provider on any node
    const path = await stageFixture('legacy-no-provider.json')
    const calls = await collectCalls(path)
    expect(calls.length).toBe(1)
    expect(calls[0].model).toBe('auggie-legacy')
  })

  it('provider hint from type-8 THINKING node is used when modelId empty', async () => {
    // legacy-empty-modelid.json: has metadata.provider: "openai" on second node
    const path = await stageFixture('legacy-empty-modelid.json')
    const calls = await collectCalls(path)
    expect(calls.length).toBe(2)
    // extractProviderHint scans all type-8 nodes and finds "openai", returns gpt-5.1 default
    for (const call of calls) {
      expect(call.model).toBe('gpt-5.1')
    }
  })
})

describe('auggie provider - MCP routing', () => {
  it('MCP structured fields: mcp_server_name + mcp_tool_name route to MCP panel', async () => {
    const path = await stageFixture('mcp-structured.json')
    const calls = await collectCalls(path)
    expect(calls.length).toBe(1)
    // Structured MCP: mcp_server_name: "workspace", mcp_tool_name: "read_note"
    // Should emit "read_note_workspace-mcp" format for downstream MCP detection
    expect(calls[0].tools).toContain('read_note_workspace-mcp')
  })

  it('MCP suffix-only fallback: _server-mcp routes to MCP panel', async () => {
    const path = await stageFixture('mcp-suffix-only.json')
    const calls = await collectCalls(path)
    expect(calls.length).toBe(1)
    // tool_name: "read_note_workspace-mcp" directly in tool_use
    expect(calls[0].tools).toContain('read_note_workspace-mcp')
  })
})

describe('auggie provider - credits deduplication', () => {
  it('duplicate transaction_id across exchanges counts once', async () => {
    const path = await stageFixture('credits-dedup.json')
    const calls = await collectCalls(path)
    // credits-dedup.json has 2 exchanges with same transaction_id "txn-dedup-shared"
    // Each exchange emits 10.0 credits, but dedup should make total 10.0
    expect(calls.length).toBe(2)
    // First call gets the credits (10.0), second gets 0 (billing node exists but deduped)
    expect(calls[0].credits).toBe(10.0)
    expect(calls[1].credits).toBe(0) // 0 because billing node exists but was deduped
    // Total credits across all calls should sum to 10.0, not 20.0
    const totalCredits = calls.reduce((sum, c) => sum + (c.credits ?? 0), 0)
    expect(totalCredits).toBe(10.0)
  })
})

describe('auggie provider - display helpers', () => {
  it('renames sentinel model fallbacks for display', () => {
    const provider = createAuggieProvider(sessionsDir)
    expect(provider.modelDisplayName('auggie-unknown')).toBe('Auggie (unknown model)')
    expect(provider.modelDisplayName('auggie-legacy')).toBe('Auggie (legacy session)')
    expect(provider.modelDisplayName('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  it('maps MCP-style tool names (<tool>_<server>-mcp) to mcp:<server>:<tool>', () => {
    const provider = createAuggieProvider(sessionsDir)
    expect(provider.toolDisplayName('read_note_workspace-mcp')).toBe('mcp:workspace:read_note')
    expect(provider.toolDisplayName('launch-process')).toBe('launch-process')
    expect(provider.toolDisplayName('view')).toBe('view')
  })
})
