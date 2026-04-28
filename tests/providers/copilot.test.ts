import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { copilot, createCopilotProvider } from '../../src/providers/copilot.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

async function createSessionDir(sessionId: string, lines: string[], cwd = '/home/user/myproject') {
  const sessionDir = join(tmpDir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'workspace.yaml'), `id: ${sessionId}\ncwd: ${cwd}\n`)
  await writeFile(join(sessionDir, 'events.jsonl'), lines.join('\n') + '\n')
  return join(sessionDir, 'events.jsonl')
}

function modelChange(newModel: string, previousModel?: string) {
  return JSON.stringify({ type: 'session.model_change', timestamp: '2026-04-15T10:00:01Z', data: { newModel, previousModel } })
}

function userMessage(content: string) {
  return JSON.stringify({ type: 'user.message', timestamp: '2026-04-15T10:00:10Z', data: { content, interactionId: 'int-1' } })
}

function assistantMessage(opts: { messageId: string; outputTokens: number; tools?: string[]; timestamp?: string }) {
  return JSON.stringify({
    type: 'assistant.message',
    timestamp: opts.timestamp ?? '2026-04-15T10:00:15Z',
    data: {
      messageId: opts.messageId,
      outputTokens: opts.outputTokens,
      interactionId: 'int-1',
      toolRequests: (opts.tools ?? []).map(name => ({ name, toolCallId: `call-${name}`, type: 'function' })),
    },
  })
}

function transcriptSessionStart(sessionId: string) {
  return JSON.stringify({ type: 'session.start', data: { sessionId, producer: 'copilot-agent' } })
}

function transcriptUserMessage(content: string) {
  return JSON.stringify({ type: 'user.message', data: { content, attachments: [] } })
}

function transcriptAssistantMessage(opts: { messageId: string; content?: string; reasoningText?: string; toolCallIds?: string[] }) {
  return JSON.stringify({
    type: 'assistant.message',
    data: {
      messageId: opts.messageId,
      content: opts.content ?? '',
      reasoningText: opts.reasoningText ?? '',
      toolRequests: (opts.toolCallIds ?? []).map((id, i) => ({
        toolCallId: id,
        name: i === 0 ? 'read_file' : 'run_in_terminal',
        type: 'function',
      })),
    },
  })
}

describe('copilot provider - JSONL parsing', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('parses a basic assistant message', async () => {
    const eventsPath = await createSessionDir('sess-001', [
      modelChange('gpt-4.1'),
      userMessage('write a function'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 150 }),
    ])

    const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('copilot')
    expect(call.model).toBe('gpt-4.1')
    expect(call.outputTokens).toBe(150)
    expect(call.inputTokens).toBe(0)
    expect(call.userMessage).toBe('write a function')
    expect(call.sessionId).toBe('sess-001')
    expect(call.bashCommands).toEqual([])
    expect(call.costUSD).toBeGreaterThan(0)
  })

  it('tracks model changes mid-session', async () => {
    const eventsPath = await createSessionDir('sess-002', [
      modelChange('gpt-5-mini'),
      userMessage('first'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 50, timestamp: '2026-04-15T10:00:10Z' }),
      modelChange('gpt-4.1', 'gpt-5-mini'),
      userMessage('second'),
      assistantMessage({ messageId: 'msg-2', outputTokens: 80, timestamp: '2026-04-15T10:01:00Z' }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.model).toBe('gpt-5-mini')
    expect(calls[1]!.model).toBe('gpt-4.1')
  })

  it('extracts tool names from toolRequests', async () => {
    const eventsPath = await createSessionDir('sess-003', [
      modelChange('gpt-4.1'),
      userMessage('run tests'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 60, tools: ['bash', 'read_file', 'write_file'] }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls[0]!.tools).toEqual(['Bash', 'Read', 'Edit'])
  })

  it('skips assistant messages with zero outputTokens', async () => {
    const eventsPath = await createSessionDir('sess-004', [
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-empty', outputTokens: 0 }),
      assistantMessage({ messageId: 'msg-real', outputTokens: 42 }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBe(42)
  })

  it('deduplicates messages across parser runs', async () => {
    const eventsPath = await createSessionDir('sess-005', [
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-dup', outputTokens: 100 }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const seenKeys = new Set<string>()

    const calls1: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, seenKeys).parse()) calls1.push(call)

    const calls2: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, seenKeys).parse()) calls2.push(call)

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(0)
  })

  it('returns empty for missing file', async () => {
    const source = { path: '/nonexistent/events.jsonl', project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)
    expect(calls).toHaveLength(0)
  })

  it('skips assistant messages before the first model_change event', async () => {
    const eventsPath = await createSessionDir('sess-no-model', [
      assistantMessage({ messageId: 'msg-early', outputTokens: 50 }),
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-after', outputTokens: 80 }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBe(80)
    expect(calls[0]!.model).toBe('gpt-4.1')
  })

  it('infers OpenAI auto bucket for transcript toolCallId prefix call_', async () => {
    const eventsPath = await createSessionDir('sess-tr-call', [
      transcriptSessionStart('sess-tr-call'),
      transcriptUserMessage('check model inference'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'done',
        toolCallIds: ['call_abc123'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('copilot-openai-auto')
  })

  it('infers Anthropic auto bucket for transcript toolCallId prefixes tooluse_/toolu_vrtx_', async () => {
    const eventsPath = await createSessionDir('sess-tr-claude', [
      transcriptSessionStart('sess-tr-claude'),
      transcriptUserMessage('check model inference'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'done',
        toolCallIds: ['tooluse_XY', 'toolu_vrtx_01ABC'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('copilot-anthropic-auto')
  })

  it('chooses the dominant inferred transcript model when prefixes are mixed', async () => {
    const eventsPath = await createSessionDir('sess-tr-mixed', [
      transcriptSessionStart('sess-tr-mixed'),
      transcriptUserMessage('mixed'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'one',
        toolCallIds: ['toolu_bdrk_123'],
      }),
      transcriptAssistantMessage({
        messageId: 'msg-2',
        content: 'two',
        toolCallIds: ['call_1'],
      }),
      transcriptAssistantMessage({
        messageId: 'msg-3',
        content: 'three',
        toolCallIds: ['call_2'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(3)
    expect(calls.every(c => c.model === 'copilot-openai-auto')).toBe(true)
  })
})

describe('copilot provider - discoverSessions', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('discovers sessions from directory', async () => {
    await createSessionDir('sess-disc-001', [modelChange('gpt-4.1')])
    await createSessionDir('sess-disc-002', [modelChange('gpt-4.1')])

    const provider = createCopilotProvider(tmpDir, '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(2)
    expect(sessions.every(s => s.provider === 'copilot')).toBe(true)
    expect(sessions.every(s => s.path.endsWith('events.jsonl'))).toBe(true)
  })

  it('reads project name from workspace.yaml cwd', async () => {
    await createSessionDir('sess-disc-003', [modelChange('gpt-4.1')], '/home/user/myapp')

    const provider = createCopilotProvider(tmpDir, '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myapp')
  })

  it('strips quotes and trailing comments from workspace.yaml cwd', async () => {
    const sessionDir = join(tmpDir, 'sess-quoted')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'workspace.yaml'), 'cwd: "/home/user/myapp"  # project root\n')
    await writeFile(join(sessionDir, 'events.jsonl'), '\n')

    const provider = createCopilotProvider(tmpDir, '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myapp')
  })

  it('returns empty when directory does not exist', async () => {
    const provider = createCopilotProvider('/nonexistent/path', '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('skips entries without events.jsonl', async () => {
    const emptyDir = join(tmpDir, 'empty-session')
    await mkdir(emptyDir, { recursive: true })

    const provider = createCopilotProvider(tmpDir, '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('discovers VS Code workspace transcripts', async () => {
    const wsDir = join(tmpDir, 'vscode-ws')
    const transcriptsDir = join(wsDir, 'abc123', 'GitHub.copilot-chat', 'transcripts')
    await mkdir(transcriptsDir, { recursive: true })
    await writeFile(join(wsDir, 'abc123', 'workspace.json'), JSON.stringify({ folder: 'file:///home/user/myapp' }))
    await writeFile(join(transcriptsDir, 'session-1.jsonl'), JSON.stringify({ type: 'session.start', data: { sessionId: 's1', producer: 'copilot-agent' } }) + '\n')

    const provider = createCopilotProvider('/nonexistent/legacy', wsDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myapp')
    expect(sessions[0]!.path).toContain('session-1.jsonl')
  })
})

describe('copilot provider - metadata', () => {
  it('has correct name and displayName', () => {
    expect(copilot.name).toBe('copilot')
    expect(copilot.displayName).toBe('Copilot')
  })

  it('normalizes tool display names', () => {
    expect(copilot.toolDisplayName('bash')).toBe('Bash')
    expect(copilot.toolDisplayName('read_file')).toBe('Read')
    expect(copilot.toolDisplayName('write_file')).toBe('Edit')
    expect(copilot.toolDisplayName('web_search')).toBe('WebSearch')
    expect(copilot.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })

  it('normalizes model display names', () => {
    expect(copilot.modelDisplayName('gpt-4.1')).toBe('GPT-4.1')
    expect(copilot.modelDisplayName('gpt-4.1-mini')).toBe('GPT-4.1 Mini')
    expect(copilot.modelDisplayName('gpt-4.1-nano')).toBe('GPT-4.1 Nano')
    expect(copilot.modelDisplayName('gpt-5-mini')).toBe('GPT-5 Mini')
    expect(copilot.modelDisplayName('o3')).toBe('o3')
    expect(copilot.modelDisplayName('o4-mini')).toBe('o4-mini')
    expect(copilot.modelDisplayName('copilot-openai-auto')).toBe('Copilot (OpenAI auto)')
    expect(copilot.modelDisplayName('copilot-anthropic-auto')).toBe('Copilot (Anthropic auto)')
    expect(copilot.modelDisplayName('unknown-model-xyz')).toBe('unknown-model-xyz')
  })

  it('longest-prefix match wins for versioned model IDs', () => {
    // gpt-5-mini-2026-01-01 must match gpt-5-mini, not gpt-5
    expect(copilot.modelDisplayName('gpt-5-mini-2026-01-01')).toBe('GPT-5 Mini')
    expect(copilot.modelDisplayName('gpt-4.1-mini-2026-01-01')).toBe('GPT-4.1 Mini')
  })
})
