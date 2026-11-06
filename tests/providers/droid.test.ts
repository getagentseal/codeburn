import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createDroidProvider } from '../../src/providers/droid.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let factoryDir: string

async function writeSession(opts: {
  projectDir?: string
  sessionId?: string
  lines?: unknown[]
  settings?: unknown
  subdir?: string
}): Promise<string> {
  const sessionId = opts.sessionId ?? 'session-1'
  const projectDir = opts.projectDir ?? '/tmp/my-project'
  const subdir = opts.subdir ?? '-tmp-my-project'
  const dir = join(factoryDir, 'sessions', subdir)
  await mkdir(dir, { recursive: true })
  const jsonlPath = join(dir, `${sessionId}.jsonl`)
  const lines = opts.lines ?? [
    { type: 'session_start', id: sessionId, cwd: projectDir, title: 'Test session' },
    { type: 'message', id: 'u1', timestamp: '2026-04-20T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'build this' }] } },
    { type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ]
  await writeFile(jsonlPath, lines.map(line => JSON.stringify(line)).join('\n'))

  if (opts.settings !== undefined) {
    await writeFile(join(dir, `${sessionId}.settings.json`), JSON.stringify(opts.settings))
  }

  return jsonlPath
}

async function parseAll(filePath: string, seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createDroidProvider(factoryDir)
  const parser = provider.createSessionParser({ path: filePath, project: 'proj', provider: 'droid' }, seen)
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

describe('droid provider', () => {
  beforeEach(async () => {
    factoryDir = await mkdtemp(join(tmpdir(), 'codeburn-droid-test-'))
  })

  afterEach(async () => {
    await rm(factoryDir, { recursive: true, force: true })
  })

  it('discovers Droid JSONL sessions', async () => {
    await writeSession({ settings: { model: 'gpt-5', tokenUsage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 } } })

    const provider = createDroidProvider(factoryDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('droid')
    expect(sessions[0]!.path.endsWith('session-1.jsonl')).toBe(true)
  })

  it('parses calls and distributes session-level token usage', async () => {
    const path = await writeSession({
      lines: [
        { type: 'session_start', id: 'session-1', cwd: '/tmp/my-project' },
        { type: 'message', id: 'u1', timestamp: '2026-04-20T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'build this' }] } },
        { type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } },
        { type: 'message', id: 'a2', timestamp: '2026-04-20T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
      ],
      settings: { model: 'custom:gpt-5-[Proxy]-0', tokenUsage: { inputTokens: 101, outputTokens: 51, cacheCreationTokens: 7, cacheReadTokens: 11, thinkingTokens: 5 } },
    })

    const calls = await parseAll(path)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.provider).toBe('droid')
    expect(calls[0]!.model).toBe('gpt-5')
    expect(calls[0]!.inputTokens).toBe(50)
    expect(calls[1]!.inputTokens).toBe(51)
    expect(calls[0]!.outputTokens).toBe(25)
    expect(calls[1]!.outputTokens).toBe(26)
    expect(calls[0]!.cacheReadInputTokens).toBe(5)
    expect(calls[1]!.cacheReadInputTokens).toBe(6)
    expect(calls[0]!.userMessage).toBe('build this')
    expect(calls[0]!.sessionId).toBe('session-1')
  })

  it('extracts tools and meaningful bash command names', async () => {
    const path = await writeSession({
      lines: [
        { type: 'session_start', id: 'session-1', cwd: '/tmp/my-project' },
        { type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:01.000Z', message: { role: 'assistant', content: [
          { type: 'tool_use', name: 'Execute', input: { command: "python3 - <<'PY'\nimport os\n}\nPY" } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a' } },
          { type: 'tool_use', name: 'Task', input: { prompt: 'do work' } },
        ] } },
      ],
      settings: { model: 'gpt-5', tokenUsage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 } },
    })

    const calls = await parseAll(path)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Bash', 'Read', 'Agent'])
    expect(calls[0]!.bashCommands).toContain('python3')
    expect(calls[0]!.bashCommands).not.toContain('import')
    expect(calls[0]!.bashCommands).not.toContain('}')
  })

  it('deduplicates calls by session and message id', async () => {
    const path = await writeSession({ settings: { model: 'gpt-5', tokenUsage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 } } })
    const seen = new Set<string>()

    expect(await parseAll(path, seen)).toHaveLength(1)
    expect(await parseAll(path, seen)).toHaveLength(0)
  })

  it('keeps the minor version of an undated model id', async () => {
    const path = await writeSession({ settings: { model: 'claude-opus-4-6', tokenUsage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 } } })
    const calls = await parseAll(path)
    expect(calls[0]!.model).toBe('claude-opus-4-6')
    expect(calls[0]!.costUSD).toBeCloseTo(7.5, 6)
  })

  it('strips only a real date from an undated-looking id', () => {
    const provider = createDroidProvider(factoryDir)
    expect(provider.modelDisplayName('model-12345678')).toBe('model-12345678')
    expect(provider.modelDisplayName('model-20260301')).toBe('model')
    expect(provider.modelDisplayName('model-20260231')).toBe('model-20260231')
  })

  it('strips Droid model wrappers for display', () => {
    const provider = createDroidProvider(factoryDir)
    expect(provider.modelDisplayName('custom:GLM-5.1-[Proxy]-0')).toBe('GLM-5.1')
    expect(provider.modelDisplayName('custom:claude-sonnet-4-6-1')).toBe('Sonnet 4.6')
  })

  it('returns no calls when settings are missing', async () => {
    const path = await writeSession({})
    expect(await parseAll(path)).toHaveLength(0)
  })

  it('skips internal .factory sessions during discovery', async () => {
    await writeSession({ projectDir: factoryDir, subdir: '-internal', settings: { model: 'gpt-5', tokenUsage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 } } })

    const provider = createDroidProvider(factoryDir)
    expect(await provider.discoverSessions()).toHaveLength(0)
  })

  it('returns no calls for empty sessions', async () => {
    const path = await writeSession({
      lines: [{ type: 'session_start', id: 'empty', cwd: '/tmp/my-project' }],
      settings: { model: 'gpt-5', tokenUsage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 } },
    })

    expect(await parseAll(path)).toHaveLength(0)
  })
})
