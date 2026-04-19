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

describe('auggie provider - display helpers', () => {
  it('renames the unknown-model fallback for display', () => {
    const provider = createAuggieProvider(sessionsDir)
    expect(provider.modelDisplayName('auggie-unknown')).toBe('Auggie (unknown model)')
    expect(provider.modelDisplayName('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  it('maps MCP-style tool names (<tool>_<server>-mcp) to mcp:<server>:<tool>', () => {
    const provider = createAuggieProvider(sessionsDir)
    expect(provider.toolDisplayName('read_note_workspace-mcp')).toBe('mcp:workspace:read_note')
    expect(provider.toolDisplayName('launch-process')).toBe('launch-process')
    expect(provider.toolDisplayName('view')).toBe('view')
  })
})
