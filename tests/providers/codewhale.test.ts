import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, open, readFile, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { clearSessionCache, parseAllSessions } from '../../src/parser.js'
import { sessionCachePath } from '../../src/session-cache.js'
import { MAX_SESSION_FILE_BYTES } from '../../src/fs-utils.js'
import { codewhale, createCodeWhaleProvider } from '../../src/providers/codewhale.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string
let previousCodeWhaleHome: string | undefined
let previousCacheDir: string | undefined

type SessionOptions = {
  id?: string
  createdAt?: string
  updatedAt?: string
  totalTokens?: number
  model?: string
  modelProvider?: string
  workspace?: string
  cost?: Record<string, unknown> | null
  messages?: unknown[]
}

async function writeSession(
  sessionsDir: string,
  filename: string,
  options: SessionOptions = {},
): Promise<string> {
  await mkdir(sessionsDir, { recursive: true })
  const metadata: Record<string, unknown> = {
    id: options.id ?? filename.replace(/\.json$/, ''),
    title: 'CodeWhale test session',
    created_at: options.createdAt ?? '2026-07-14T10:00:00.000Z',
    updated_at: options.updatedAt ?? '2026-07-14T11:00:00.000Z',
    message_count: options.messages?.length ?? 0,
    total_tokens: options.totalTokens ?? 1_000,
    model: options.model ?? 'deepseek-chat',
    model_provider: options.modelProvider ?? 'deepseek',
    workspace: options.workspace ?? '/Users/test/codewhale-project',
    mode: 'agent',
  }
  if (options.cost !== null) {
    metadata.cost = options.cost ?? {
      session_cost_usd: 0.25,
      subagent_cost_usd: 0.05,
    }
  }

  const path = join(sessionsDir, filename)
  await writeFile(path, JSON.stringify({
    schema_version: 1,
    metadata,
    messages: options.messages ?? [],
    system_prompt: null,
  }))
  return path
}

async function parseOne(path: string, seenKeys = new Set<string>()): Promise<ParsedProviderCall[]> {
  const source = { path, project: 'fixture', provider: 'codewhale' }
  const calls: ParsedProviderCall[] = []
  for await (const call of codewhale.createSessionParser(source, seenKeys).parse()) {
    calls.push(call)
  }
  return calls
}

describe('codewhale provider', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codewhale-test-'))
    previousCodeWhaleHome = process.env['CODEWHALE_HOME']
    previousCacheDir = process.env['CODEBURN_CACHE_DIR']
    clearSessionCache()
  })

  afterEach(async () => {
    clearSessionCache()
    if (previousCodeWhaleHome === undefined) delete process.env['CODEWHALE_HOME']
    else process.env['CODEWHALE_HOME'] = previousCodeWhaleHome
    if (previousCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
    else process.env['CODEBURN_CACHE_DIR'] = previousCacheDir
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('discovers primary and legacy sessions while the primary id wins collisions', async () => {
    const primary = join(tmpDir, 'primary')
    const legacy = join(tmpDir, 'legacy')
    const primaryDuplicate = await writeSession(primary, 'primary-copy.json', {
      id: 'same-session',
      workspace: '/repos/primary-project',
    })
    await writeSession(legacy, 'legacy-copy.json', {
      id: 'same-session',
      workspace: '/repos/legacy-project',
    })
    const legacyOnly = await writeSession(legacy, 'legacy-only.json', {
      id: 'legacy-only',
      workspace: 'C:\\repos\\windows-project',
    })
    await writeFile(join(primary, 'malformed.json'), '{not-json')
    await writeFile(join(primary, 'not-a-session.json'), JSON.stringify({ metadata: { title: 'missing id' } }))
    await mkdir(join(primary, 'checkpoints'), { recursive: true })
    await writeFile(join(primary, 'checkpoints', 'latest.json'), '{}')

    const sessions = await createCodeWhaleProvider([primary, legacy]).discoverSessions()

    expect(sessions).toEqual([
      { path: primaryDuplicate, project: 'primary-project', provider: 'codewhale' },
      { path: legacyOnly, project: 'windows-project', provider: 'codewhale' },
    ])
  })

  it('treats CODEWHALE_HOME as the exact home and scans its sessions child', async () => {
    const home = join(tmpDir, 'custom-home')
    const session = await writeSession(join(home, 'sessions'), 'custom.json')
    await writeSession(join(home, '.codewhale', 'sessions'), 'wrongly-nested.json')
    process.env['CODEWHALE_HOME'] = home

    const sessions = await createCodeWhaleProvider().discoverSessions()

    expect(sessions.map(source => source.path)).toEqual([session])
  })

  it('parses one cumulative record without inventing an input/output split', async () => {
    const path = await writeSession(join(tmpDir, 'sessions'), 'full.json', {
      id: 'session-full',
      totalTokens: 12_345,
      model: 'anthropic/claude-sonnet-4-6',
      workspace: '/Users/alice/codewhale-demo',
      updatedAt: '2026-07-15T12:34:56.000Z',
      cost: {
        session_cost_usd: 0.75,
        subagent_cost_usd: 0.20,
        displayed_cost_high_water_usd: 2,
      },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Implement the parser' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '...' },
            { type: 'tool_use', id: 't1', name: 'read_file', input: { file_path: 'src/app.ts' } },
            { type: 'tool_use', id: 't2', name: 'exec_shell', input: { command: 'npm test && git status' } },
            { type: 'tool_use', id: 't3', name: 'edit_file', input: { path: 'src/app.ts' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't4', name: 'load_skill', input: { name: 'typescript' } },
            { type: 'tool_use', id: 't5', name: 'agent', input: { type: 'reviewer' } },
            { type: 'server_tool_use', id: 't6', name: 'web_search', input: { query: 'CodeWhale' } },
          ],
        },
      ],
    })

    const [call] = await parseOne(path)

    expect(call).toMatchObject({
      provider: 'codewhale',
      model: 'anthropic/claude-sonnet-4-6',
      inputTokens: 12_345,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 1,
      costUSD: 0.95,
      costIsEstimated: false,
      timestamp: '2026-07-15T12:34:56.000Z',
      userMessage: 'Implement the parser',
      sessionId: 'session-full',
      project: 'codewhale-demo',
      projectPath: '/Users/alice/codewhale-demo',
      tools: ['Read', 'Bash', 'Edit', 'Skill', 'Agent', 'WebSearch'],
      bashCommands: ['npm', 'git'],
      skills: ['typescript'],
      subagentTypes: ['reviewer'],
      deduplicationKey: 'codewhale:session-full',
    })
    expect(call!.toolSequence).toEqual([
      [
        { tool: 'Read', file: 'src/app.ts' },
        { tool: 'Bash', command: 'npm test && git status' },
        { tool: 'Edit', file: 'src/app.ts' },
      ],
      [
        { tool: 'Skill' },
        { tool: 'Agent' },
        { tool: 'WebSearch' },
      ],
    ])
  })

  it('uses model pricing only when CodeWhale did not persist a cost snapshot', async () => {
    const estimatedPath = await writeSession(join(tmpDir, 'sessions'), 'estimated.json', {
      totalTokens: 1_000_000,
      model: 'gpt-4o-mini',
      cost: null,
    })
    const exactZeroPath = await writeSession(join(tmpDir, 'sessions'), 'exact-zero.json', {
      totalTokens: 1_000_000,
      model: 'gpt-4o-mini',
      cost: { session_cost_usd: 0, subagent_cost_usd: 0 },
    })

    const [estimated] = await parseOne(estimatedPath)
    const [exactZero] = await parseOne(exactZeroPath)

    expect(estimated!.costUSD).toBeGreaterThan(0)
    expect(estimated!.costIsEstimated).toBe(true)
    expect(exactZero!.costUSD).toBe(0)
    expect(exactZero!.costIsEstimated).toBe(false)
  })

  it('falls back to file mtime for malformed timestamps and deduplicates by session id', async () => {
    const path = await writeSession(join(tmpDir, 'sessions'), 'mtime.json', {
      id: 'mtime-session',
      createdAt: 'invalid',
      updatedAt: 'also-invalid',
    })
    const fallback = new Date('2026-07-13T08:30:00.000Z')
    await utimes(path, fallback, fallback)
    const seen = new Set<string>()

    const first = await parseOne(path, seen)
    const second = await parseOne(path, seen)

    expect(first[0]!.timestamp).toBe(fallback.toISOString())
    expect(second).toEqual([])
  })

  it('keeps authoritative aggregate usage when a transcript exceeds the full-read cap', async () => {
    const path = await writeSession(join(tmpDir, 'sessions'), 'oversize.json', {
      id: 'oversize-session',
      totalTokens: 98_765,
      cost: { session_cost_usd: 1.2, subagent_cost_usd: 0.3 },
    })
    const handle = await open(path, 'r+')
    await handle.truncate(MAX_SESSION_FILE_BYTES + 1)
    await handle.close()

    const [call] = await parseOne(path)

    expect(call).toMatchObject({
      sessionId: 'oversize-session',
      inputTokens: 98_765,
      costUSD: 1.5,
      tools: [],
    })
  })

  it('preserves CodeWhale-reported cost after the shared disk-cache round trip', async () => {
    const home = join(tmpDir, 'home')
    const cacheDir = join(tmpDir, 'cache')
    await writeSession(join(home, 'sessions'), 'cached.json', {
      id: 'cached-session',
      totalTokens: 1_000_000,
      model: 'gpt-4o-mini',
      cost: { session_cost_usd: 0.7, subagent_cost_usd: 0.05 },
    })
    process.env['CODEWHALE_HOME'] = home
    process.env['CODEBURN_CACHE_DIR'] = cacheDir

    const first = await parseAllSessions(undefined, 'codewhale')
    clearSessionCache()
    const second = await parseAllSessions(undefined, 'codewhale')

    expect(first).toHaveLength(1)
    expect(first[0]!.totalCostUSD).toBeCloseTo(0.75)
    expect(second[0]!.totalCostUSD).toBeCloseTo(0.75)

    const cache = JSON.parse(await readFile(sessionCachePath(), 'utf-8')) as {
      providers: { codewhale: { envFingerprint: string } }
    }
    expect(cache.providers.codewhale.envFingerprint).toMatch(/^[a-f0-9]{16}$/)
  })

  it('exposes canonical model and tool display names', () => {
    expect(codewhale.name).toBe('codewhale')
    expect(codewhale.displayName).toBe('CodeWhale')
    expect(codewhale.modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(codewhale.toolDisplayName('apply_patch')).toBe('Edit')
    expect(codewhale.toolDisplayName('custom_plugin_tool')).toBe('custom_plugin_tool')
    expect(codewhale.toolDisplayName('__proto__')).toBe('__proto__')
  })
})
