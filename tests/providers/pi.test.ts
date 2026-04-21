import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createPiProvider } from '../../src/providers/pi.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'pi-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function sessionMeta(opts: { id?: string; cwd?: string } = {}) {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: opts.id ?? 'sess-001',
    timestamp: '2026-04-14T10:00:00.000Z',
    cwd: opts.cwd ?? '/Users/test/myproject',
  })
}

function userMessage(text: string, timestamp?: string) {
  return JSON.stringify({
    type: 'message',
    id: 'msg-user-1',
    timestamp: timestamp ?? '2026-04-14T10:00:10.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: 1776023210000,
    },
  })
}

function assistantMessage(opts: {
  id?: string
  responseId?: string
  timestamp?: string
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  tools?: Array<{ name: string; command?: string }>
}) {
  const content = (opts.tools ?? []).map(t => ({
    type: 'toolCall',
    id: `call-${t.name}`,
    name: t.name,
    arguments: t.command !== undefined ? { command: t.command } : {},
  }))

  return JSON.stringify({
    type: 'message',
    id: opts.id ?? 'msg-asst-1',
    timestamp: opts.timestamp ?? '2026-04-14T10:00:30.000Z',
    message: {
      role: 'assistant',
      content,
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: opts.model ?? 'gpt-5.4',
      responseId: opts.responseId ?? 'resp-001',
      usage: {
        input: opts.input ?? 1000,
        output: opts.output ?? 200,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        totalTokens: (opts.input ?? 1000) + (opts.output ?? 200) + (opts.cacheRead ?? 0),
        cost: { input: 0.0025, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.0055 },
      },
      stopReason: 'stop',
      timestamp: 1776023230000,
    },
  })
}

async function writeSession(projectDir: string, filename: string, lines: string[]) {
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

describe('pi provider - session discovery', () => {
  it('discovers sessions grouped by project directory', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, '2026-04-14T10-00-00-000Z_sess-001.jsonl', [
      sessionMeta({ cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])

    const provider = createPiProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('pi')
    expect(sessions[0]!.project).toBe('myproject')
    expect(sessions[0]!.path).toContain('sess-001.jsonl')
  })

  it('discovers sessions across multiple project directories', async () => {
    const dir1 = join(tmpDir, '--Users-test-project-a--')
    const dir2 = join(tmpDir, '--Users-test-project-b--')
    await writeSession(dir1, 'session1.jsonl', [sessionMeta({ cwd: '/Users/test/project-a' }), assistantMessage({})])
    await writeSession(dir2, 'session2.jsonl', [sessionMeta({ cwd: '/Users/test/project-b' }), assistantMessage({})])

    const provider = createPiProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(2)
    const projects = sessions.map(s => s.project).sort()
    expect(projects).toEqual(['project-a', 'project-b'])
  })

  it('returns empty for non-existent directory', async () => {
    const provider = createPiProvider('/nonexistent/path/that/does/not/exist')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('skips files whose first line is not a session entry', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'bad.jsonl', [
      JSON.stringify({ type: 'message', id: 'x' }),
    ])

    const provider = createPiProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('skips non-jsonl files', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'notes.txt'), 'not a session')

    const provider = createPiProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })
})

describe('pi provider - JSONL parsing', () => {
  it('extracts token usage and metadata from an assistant message', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta({ id: 'sess-abc', cwd: '/Users/test/myproject' }),
      userMessage('implement the feature'),
      assistantMessage({
        responseId: 'resp-abc',
        timestamp: '2026-04-14T10:00:30.000Z',
        model: 'gpt-5.4',
        input: 2000,
        output: 400,
        cacheRead: 5000,
        cacheWrite: 100,
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('pi')
    expect(call.model).toBe('gpt-5.4')
    expect(call.inputTokens).toBe(2000)
    expect(call.outputTokens).toBe(400)
    expect(call.cacheReadInputTokens).toBe(5000)
    expect(call.cachedInputTokens).toBe(5000)
    expect(call.cacheCreationInputTokens).toBe(100)
    expect(call.sessionId).toBe('sess-abc')
    expect(call.userMessage).toBe('implement the feature')
    expect(call.timestamp).toBe('2026-04-14T10:00:30.000Z')
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.deduplicationKey).toContain('pi:')
    expect(call.deduplicationKey).toContain('resp-abc')
  })

  it('collects tool names from toolCall content items', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [
          { name: 'read' },
          { name: 'edit' },
          { name: 'bash', command: 'git status' },
        ],
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls[0]!.tools).toEqual(['Read', 'Edit', 'Bash'])
  })

  it('extracts bash commands from bash tool arguments', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [
          { name: 'bash', command: 'git status && bun test' },
        ],
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls[0]!.bashCommands).toEqual(['git', 'bun'])
  })

  it('skips assistant messages with zero tokens', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({ input: 0, output: 0 }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(0)
  })

  it('deduplicates calls seen across multiple parses', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({ responseId: 'resp-dup' }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const seenKeys = new Set<string>()

    const firstRun: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      firstRun.push(call)
    }

    const secondRun: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      secondRun.push(call)
    }

    expect(firstRun).toHaveLength(1)
    expect(secondRun).toHaveLength(0)
  })

  it('yields one call per assistant message in a multi-turn session', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta({ id: 'sess-multi' }),
      userMessage('first question'),
      assistantMessage({ responseId: 'resp-1', timestamp: '2026-04-14T10:00:30.000Z', input: 500, output: 100 }),
      userMessage('second question'),
      assistantMessage({ responseId: 'resp-2', timestamp: '2026-04-14T10:01:00.000Z', input: 600, output: 120 }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('first question')
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[1]!.userMessage).toBe('second question')
    expect(calls[1]!.inputTokens).toBe(600)
  })

  it('handles missing session file gracefully', async () => {
    const provider = createPiProvider(tmpDir)
    const source = { path: '/nonexistent/session.jsonl', project: 'test', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('pi provider - display names', () => {
  const provider = createPiProvider('/tmp')

  it('has correct name and displayName', () => {
    expect(provider.name).toBe('pi')
    expect(provider.displayName).toBe('Pi')
  })

  it('maps known models to readable names', () => {
    expect(provider.modelDisplayName('gpt-5.4')).toBe('GPT-5.4')
    expect(provider.modelDisplayName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
    expect(provider.modelDisplayName('gpt-5')).toBe('GPT-5')
  })

  it('returns raw name for unknown models', () => {
    expect(provider.modelDisplayName('some-future-model')).toBe('some-future-model')
  })

  it('normalizes tool names to capitalized form', () => {
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('read')).toBe('Read')
    expect(provider.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })
})
