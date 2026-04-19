import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createOpenClawProvider } from '../../src/providers/openclaw.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'openclaw-test-'))
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
    cwd: opts.cwd ?? 'C:\\Users\\test\\.openclaw\\agents\\ivy\\workspace',
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
  timestamp?: string
  model?: string
  api?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  embeddedCost?: number
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
      api: opts.api ?? 'ollama',
      provider: opts.api ?? 'ollama',
      model: opts.model ?? 'qwen3.5:35b-a3b',
      stopReason: 'stop',
      usage: {
        input: opts.input ?? 1000,
        output: opts.output ?? 200,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        totalTokens: (opts.input ?? 1000) + (opts.output ?? 200),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.embeddedCost ?? 0 },
      },
      timestamp: 1776023230000,
    },
  })
}

async function writeSession(agentDir: string, filename: string, lines: string[]) {
  const sessionsDir = join(agentDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const filePath = join(sessionsDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

describe('openclaw provider - session discovery', () => {
  it('discovers sessions grouped by agent directory', async () => {
    await writeSession(join(tmpDir, 'ivy'), 'sess-001.jsonl', [
      sessionMeta(),
      assistantMessage({}),
    ])

    const provider = createOpenClawProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('openclaw')
    expect(sessions[0]!.project).toBe('ivy')
    expect(sessions[0]!.path).toContain('sess-001.jsonl')
  })

  it('discovers sessions across multiple agents', async () => {
    await writeSession(join(tmpDir, 'ivy'), 's1.jsonl', [sessionMeta(), assistantMessage({})])
    await writeSession(join(tmpDir, 'main'), 's2.jsonl', [sessionMeta(), assistantMessage({ model: 'gpt-5.4', api: 'openai' })])
    await writeSession(join(tmpDir, 'douyun'), 's3.jsonl', [sessionMeta(), assistantMessage({ model: 'moonshotai/kimi-k2.5', api: 'openai' })])

    const provider = createOpenClawProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(3)
    const projects = sessions.map(s => s.project).sort()
    expect(projects).toEqual(['douyun', 'ivy', 'main'])
  })

  it('includes .deleted. and .reset. rotated files (data is preserved, not deleted)', async () => {
    await writeSession(join(tmpDir, 'ivy'), 'live.jsonl', [sessionMeta({ id: 'live-id' }), assistantMessage({ id: 'm1' })])
    await writeSession(join(tmpDir, 'ivy'), 'old.jsonl.deleted.2026-04-01T00-00-00.000Z', [sessionMeta({ id: 'old-id' }), assistantMessage({ id: 'm2' })])
    await writeSession(join(tmpDir, 'ivy'), 'reset.jsonl.reset.2026-04-02T00-00-00.000Z', [sessionMeta({ id: 'reset-id' }), assistantMessage({ id: 'm3' })])

    const provider = createOpenClawProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(3)
  })

  it('returns empty for non-existent directory', async () => {
    const provider = createOpenClawProvider('/nonexistent/path/that/does/not/exist')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('skips agents without a sessions subdirectory', async () => {
    await mkdir(join(tmpDir, 'bare-agent'), { recursive: true })
    await writeSession(join(tmpDir, 'ivy'), 's.jsonl', [sessionMeta(), assistantMessage({})])

    const provider = createOpenClawProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('ivy')
  })
})

describe('openclaw provider - JSONL parsing', () => {
  it('extracts token usage and metadata from an assistant message', async () => {
    const filePath = await writeSession(join(tmpDir, 'ivy'), 'sess.jsonl', [
      sessionMeta({ id: 'sess-abc' }),
      userMessage('summarize the logs'),
      assistantMessage({
        id: 'msg-42',
        timestamp: '2026-04-14T10:00:30.000Z',
        model: 'qwen3.5:35b-a3b',
        api: 'ollama',
        input: 2000,
        output: 400,
        cacheRead: 100,
        cacheWrite: 50,
      }),
    ])

    const provider = createOpenClawProvider(tmpDir)
    const source = { path: filePath, project: 'ivy', provider: 'openclaw' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('openclaw')
    expect(call.model).toBe('qwen3.5:35b-a3b')
    expect(call.inputTokens).toBe(2000)
    expect(call.outputTokens).toBe(400)
    expect(call.cacheReadInputTokens).toBe(100)
    expect(call.cachedInputTokens).toBe(100)
    expect(call.cacheCreationInputTokens).toBe(50)
    expect(call.sessionId).toBe('sess-abc')
    expect(call.userMessage).toBe('summarize the logs')
    expect(call.timestamp).toBe('2026-04-14T10:00:30.000Z')
    expect(call.deduplicationKey).toBe('openclaw:sess-abc:msg-42')
  })

  it('forces zero cost for local qwen models even with embedded cost', async () => {
    const filePath = await writeSession(join(tmpDir, 'ivy'), 'sess.jsonl', [
      sessionMeta(),
      assistantMessage({
        model: 'qwen3.5:35b-a3b',
        api: 'ollama',
        input: 5000,
        output: 500,
        embeddedCost: 0.12,
      }),
    ])

    const provider = createOpenClawProvider(tmpDir)
    const source = { path: filePath, project: 'ivy', provider: 'openclaw' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls[0]!.costUSD).toBe(0)
  })

  it('computes cost via pricing for gpt-5.4', async () => {
    const filePath = await writeSession(join(tmpDir, 'main'), 'sess.jsonl', [
      sessionMeta(),
      assistantMessage({
        model: 'gpt-5.4',
        api: 'openai',
        input: 10000,
        output: 500,
      }),
    ])

    const provider = createOpenClawProvider(tmpDir)
    const source = { path: filePath, project: 'main', provider: 'openclaw' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('falls back to embedded cost when pricing lookup yields zero', async () => {
    const filePath = await writeSession(join(tmpDir, 'douyun'), 'sess.jsonl', [
      sessionMeta(),
      assistantMessage({
        model: 'some-unlisted-paid-model',
        api: 'openai',
        input: 1000,
        output: 100,
        embeddedCost: 0.0042,
      }),
    ])

    const provider = createOpenClawProvider(tmpDir)
    const source = { path: filePath, project: 'douyun', provider: 'openclaw' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls[0]!.costUSD).toBe(0.0042)
  })

  it('collects tool names and maps exec to Bash', async () => {
    const filePath = await writeSession(join(tmpDir, 'ivy'), 'sess.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [
          { name: 'read' },
          { name: 'edit' },
          { name: 'exec', command: 'git status' },
        ],
      }),
    ])

    const provider = createOpenClawProvider(tmpDir)
    const source = { path: filePath, project: 'ivy', provider: 'openclaw' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls[0]!.tools).toEqual(['Read', 'Edit', 'Bash'])
  })

  it('extracts bash commands from exec tool arguments', async () => {
    const filePath = await writeSession(join(tmpDir, 'ivy'), 'sess.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [{ name: 'exec', command: 'git status && npm test' }],
      }),
    ])

    const provider = createOpenClawProvider(tmpDir)
    const source = { path: filePath, project: 'ivy', provider: 'openclaw' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls[0]!.bashCommands).toEqual(['git', 'npm'])
  })

  it('deduplicates calls seen across multiple parses', async () => {
    const filePath = await writeSession(join(tmpDir, 'ivy'), 'sess.jsonl', [
      sessionMeta({ id: 'sess-dup' }),
      assistantMessage({ id: 'msg-dup' }),
    ])

    const provider = createOpenClawProvider(tmpDir)
    const source = { path: filePath, project: 'ivy', provider: 'openclaw' }
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
    const filePath = await writeSession(join(tmpDir, 'ivy'), 'multi.jsonl', [
      sessionMeta({ id: 'sess-multi' }),
      userMessage('first question'),
      assistantMessage({ id: 'm1', timestamp: '2026-04-14T10:00:30.000Z', input: 500, output: 100 }),
      userMessage('second question'),
      assistantMessage({ id: 'm2', timestamp: '2026-04-14T10:01:00.000Z', input: 600, output: 120 }),
    ])

    const provider = createOpenClawProvider(tmpDir)
    const source = { path: filePath, project: 'ivy', provider: 'openclaw' }
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
    const provider = createOpenClawProvider(tmpDir)
    const source = { path: '/nonexistent/session.jsonl', project: 'test', provider: 'openclaw' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('openclaw provider - display names', () => {
  const provider = createOpenClawProvider('/tmp')

  it('has correct name and displayName', () => {
    expect(provider.name).toBe('openclaw')
    expect(provider.displayName).toBe('OpenClaw')
  })

  it('maps known models to readable names', () => {
    expect(provider.modelDisplayName('qwen3.5:35b-a3b')).toBe('Qwen 3.5 35B (local)')
    expect(provider.modelDisplayName('gpt-5.4')).toBe('GPT-5.4')
    expect(provider.modelDisplayName('moonshotai/kimi-k2.5')).toBe('Kimi K2.5')
  })

  it('returns raw name for unknown models', () => {
    expect(provider.modelDisplayName('some-future-model')).toBe('some-future-model')
  })

  it('normalizes tool names to capitalized form', () => {
    expect(provider.toolDisplayName('exec')).toBe('Bash')
    expect(provider.toolDisplayName('read')).toBe('Read')
    expect(provider.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })
})
