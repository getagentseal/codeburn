import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join, posix, win32 } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { copilot, createCopilotProvider, getVSCodeGlobalStorageDirs, getVSCodeWorkspaceStorageDirs } from '../../src/providers/copilot.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
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

function transcriptAssistantMessage(opts: { messageId: string; content?: string; reasoningText?: string; toolCallIds?: string[]; toolNames?: string[] }) {
  return JSON.stringify({
    type: 'assistant.message',
    data: {
      messageId: opts.messageId,
      content: opts.content ?? '',
      reasoningText: opts.reasoningText ?? '',
      toolRequests: (opts.toolCallIds ?? []).map((id, i) => ({
        toolCallId: id,
        name: opts.toolNames?.[i] ?? (i === 0 ? 'read_file' : 'run_in_terminal'),
        type: 'function',
      })),
    },
  })
}

function chatSessionSampleRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'request_8c8ce017-6e3f-460a-9931-5a16825d231a',
    modelId: 'copilot/claude-sonnet-4.6',
    completionTokens: 490,
    result: {
      metadata: {
        promptTokens: 32543,
        outputTokens: 60,
        resolvedModel: 'claude-sonnet-4-6',
        toolCallRounds: [{ thinking: { tokens: 0 }, modelId: 'claude-sonnet-4.6' }],
        agentId: 'github.copilot.editsAgent',
      },
    },
    ...overrides,
  }
}

async function createChatSessionFile(filePath: string, entries: unknown[]) {
  await writeFile(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
}

async function collectCalls(source: { path: string; project: string; provider: string; sourceType?: string }, seenKeys = new Set<string>()) {
  const calls: ParsedProviderCall[] = []
  for await (const call of copilot.createSessionParser(source, seenKeys).parse()) calls.push(call)
  return calls
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

  it('normalizes Copilot MCP tool names from toolRequests', async () => {
    const eventsPath = await createSessionDir('sess-mcp-tools', [
      modelChange('gpt-4.1'),
      userMessage('list MCP-backed tasks and issues'),
      assistantMessage({
        messageId: 'msg-1',
        outputTokens: 60,
        tools: ['github-mcp-server-list_issues', 'cyberday-get_tasks', 'mempalace-mempalace_search', 'bash'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls[0]!.tools).toEqual([
      'mcp__github_mcp_server__list_issues',
      'mcp__cyberday__get_tasks',
      'mcp__mempalace__mempalace_search',
      'Bash',
    ])
  })

  it('does not crash on malformed toolRequests (string / null / missing)', async () => {
    // Regression guard: a corrupt session previously aborted the whole file's
    // parse loop because .map was called on a non-array. The fix coerces any
    // non-array shape (string, null, missing) to []. We mix one corrupt event
    // between two healthy events and assert both healthy events still parse.
    const corruptToolRequestsString = JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-04-15T10:00:15Z',
      data: { messageId: 'corrupt-string', outputTokens: 50, toolRequests: 'not an array' },
    })
    const corruptToolRequestsNull = JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-04-15T10:00:16Z',
      data: { messageId: 'corrupt-null', outputTokens: 50, toolRequests: null },
    })
    const eventsPath = await createSessionDir('sess-corrupt', [
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-before', outputTokens: 100 }),
      corruptToolRequestsString,
      corruptToolRequestsNull,
      assistantMessage({ messageId: 'msg-after', outputTokens: 200 }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    // The healthy messages BEFORE and AFTER the corrupt events both parse —
    // proving that the corrupt event no longer aborts the per-file parse loop.
    // Pre-fix, .map on a non-array threw and we'd see < 4 calls.
    expect(calls).toHaveLength(4)
    expect(calls.find(c => c.outputTokens === 100)).toBeDefined()  // msg-before
    expect(calls.find(c => c.outputTokens === 200)).toBeDefined()  // msg-after
    // Corrupt events produce calls with empty tools, not crashes.
    const corruptCalls = calls.filter(c => c.outputTokens === 50)
    expect(corruptCalls.length).toBe(2)
    for (const c of corruptCalls) {
      expect(c.tools).toEqual([])
    }
  })

  it('ignores malformed non-string tool names', async () => {
    const malformedToolName = JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-04-15T10:00:15Z',
      data: {
        messageId: 'malformed-tool-name',
        outputTokens: 50,
        toolRequests: [null, { name: 123, toolCallId: 'call-bad', type: 'function' }],
      },
    })
    const eventsPath = await createSessionDir('sess-malformed-tool-name', [
      modelChange('gpt-4.1'),
      malformedToolName,
      assistantMessage({ messageId: 'msg-after', outputTokens: 100, tools: ['github-mcp-server-list_issues'] }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.tools).toEqual([])
    expect(calls[1]!.tools).toEqual(['mcp__github_mcp_server__list_issues'])
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

  it('normalizes Copilot MCP tool names from VS Code transcripts', async () => {
    const eventsPath = await createSessionDir('sess-tr-mcp-tools', [
      transcriptSessionStart('sess-tr-mcp-tools'),
      transcriptUserMessage('use GitHub MCP'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'done',
        toolCallIds: ['call_abc123', 'call_def456'],
        toolNames: ['github-mcp-server-list_issues', 'read_file'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['mcp__github_mcp_server__list_issues', 'Read'])
  })
})

describe('copilot provider - chatSessions parsing', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-chatsessions-test-'))
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('parses sample journal token counts and cost', async () => {
    const filePath = join(tmpDir, 'sample.jsonl')
    await createChatSessionFile(filePath, [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'chat-session-1', requests: [] } },
      { kind: 2, k: ['requests'], v: [chatSessionSampleRequest()] },
    ])

    const calls = await collectCalls({ path: filePath, project: 'myproject', provider: 'copilot', sourceType: 'chatsession' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(32543)
    expect(calls[0]!.outputTokens).toBe(60)
    expect(calls[0]!.model).toBe('claude-sonnet-4-6')
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('returns no calls for an empty reconstructed requests array', async () => {
    const filePath = join(tmpDir, 'empty.jsonl')
    await createChatSessionFile(filePath, [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'chat-empty', requests: [] } },
    ])

    const calls = await collectCalls({ path: filePath, project: 'myproject', provider: 'copilot', sourceType: 'chatsession' })

    expect(calls).toHaveLength(0)
  })

  it('discovers and parses emptyWindowChatSessions from globalStorage', async () => {
    const globalDir = join(tmpDir, 'globalStorage')
    const emptyWindowDir = join(globalDir, 'emptyWindowChatSessions')
    await mkdir(emptyWindowDir, { recursive: true })
    const filePath = join(emptyWindowDir, 'empty-window.jsonl')
    await createChatSessionFile(filePath, [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'empty-window-session', requests: [] } },
      { kind: 2, k: ['requests'], v: [chatSessionSampleRequest()] },
    ])

    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/ws', globalDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('copilot-chat')
    expect((sessions[0] as { sourceType?: string }).sourceType).toBe('chatsession')

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, new Set()).parse()) calls.push(call)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(32543)
  })

  it('skips chatSessions discovery when an OTel source is present', async () => {
    if (!isSqliteAvailable()) return

    vi.unstubAllEnvs()
    const dbPath = join(tmpDir, 'agent-traces.db')
    vi.stubEnv('CODEBURN_COPILOT_OTEL_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '')
    createOtelDb(dbPath)
    insertSpan(dbPath, {
      spanId: 'span-chatsession-skip',
      traceId: 'trace-chatsession-skip',
      operationName: 'chat',
      startTimeMs: 1000,
      attrs: {
        'gen_ai.conversation.id': 'conv-chatsession-skip',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 10,
      },
    })

    const wsDir = join(tmpDir, 'vscode-ws')
    const hashDir = join(wsDir, 'abc123')
    const workspaceChatSessionsDir = join(hashDir, 'chatSessions')
    const globalDir = join(tmpDir, 'globalStorage')
    const emptyWindowDir = join(globalDir, 'emptyWindowChatSessions')
    await mkdir(workspaceChatSessionsDir, { recursive: true })
    await mkdir(emptyWindowDir, { recursive: true })
    await writeFile(join(hashDir, 'workspace.json'), JSON.stringify({ folder: 'file:///home/user/myapp' }))
    await createChatSessionFile(join(workspaceChatSessionsDir, 'workspace.jsonl'), [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'chat-workspace', requests: [] } },
      { kind: 2, k: ['requests'], v: [chatSessionSampleRequest()] },
    ])
    await createChatSessionFile(join(emptyWindowDir, 'empty-window.jsonl'), [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'chat-empty-window', requests: [] } },
      { kind: 2, k: ['requests'], v: [chatSessionSampleRequest({ requestId: 'request-empty-window' })] },
    ])

    const provider = createCopilotProvider('/nonexistent/legacy', wsDir, globalDir)
    const sources = await provider.discoverSessions()

    expect(sources.filter(s => (s as { sourceType?: string }).sourceType === 'otel')).toHaveLength(1)
    expect(sources.filter(s => (s as { sourceType?: string }).sourceType === 'chatsession')).toHaveLength(0)
  })

  it('applies append-then-edit journal updates', async () => {
    const filePath = join(tmpDir, 'append-edit.jsonl')
    await createChatSessionFile(filePath, [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'chat-edit', requests: [] } },
      { kind: 2, k: ['requests'], v: [chatSessionSampleRequest()] },
      { kind: 1, k: ['requests', 0, 'result', 'metadata', 'outputTokens'], v: 88 },
    ])

    const calls = await collectCalls({ path: filePath, project: 'myproject', provider: 'copilot', sourceType: 'chatsession' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBe(88)
  })

  it('deduplicates by requestId across parser runs', async () => {
    const filePath = join(tmpDir, 'dedupe.jsonl')
    await createChatSessionFile(filePath, [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'chat-dedupe', requests: [] } },
      { kind: 2, v: [chatSessionSampleRequest()] },
    ])
    const source = { path: filePath, project: 'myproject', provider: 'copilot', sourceType: 'chatsession' }
    const seenKeys = new Set<string>()

    const calls1 = await collectCalls(source, seenKeys)
    const calls2 = await collectCalls(source, seenKeys)

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(0)
  })

  it('ignores prototype-pollution journal paths without crashing', async () => {
    const filePath = join(tmpDir, 'proto.jsonl')
    await createChatSessionFile(filePath, [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'chat-proto', requests: [] } },
      { kind: 1, k: ['__proto__', 'polluted'], v: true },
      { kind: 1, k: ['constructor', 'prototype', 'polluted'], v: true },
      { kind: 2, k: ['requests'], v: [chatSessionSampleRequest()] },
    ])

    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    const calls = await collectCalls({ path: filePath, project: 'myproject', provider: 'copilot', sourceType: 'chatsession' })

    expect(calls).toHaveLength(1)
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('skips legacy transcripts for a workspace hash that has chatSessions', async () => {
    const wsDir = join(tmpDir, 'vscode-ws')
    const hashDir = join(wsDir, 'abc123')
    const chatSessionsDir = join(hashDir, 'chatSessions')
    const transcriptsDir = join(hashDir, 'GitHub.copilot-chat', 'transcripts')
    await mkdir(chatSessionsDir, { recursive: true })
    await mkdir(transcriptsDir, { recursive: true })
    await writeFile(join(hashDir, 'workspace.json'), JSON.stringify({ folder: 'file:///home/user/myapp' }))
    await createChatSessionFile(join(chatSessionsDir, 'chat.jsonl'), [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'chat-modern', requests: [] } },
      { kind: 2, k: ['requests'], v: [chatSessionSampleRequest()] },
    ])
    await writeFile(join(transcriptsDir, 'legacy.jsonl'), transcriptSessionStart('legacy') + '\n')

    const provider = createCopilotProvider('/nonexistent/legacy', wsDir, '/nonexistent/global')
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect((sessions[0] as { sourceType?: string }).sourceType).toBe('chatsession')
    expect(sessions[0]!.path).toContain(`${join('abc123', 'chatSessions')}`)
  })
})

describe('copilot provider - discoverSessions', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-test-'))
    // Disable OTel discovery so tests aren't contaminated by real sessions
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
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

  it('includes VSCodium workspaceStorage paths on all supported platforms', () => {
    expect(getVSCodeWorkspaceStorageDirs('/Users/test', 'darwin')).toContain(
      posix.join('/Users/test', 'Library', 'Application Support', 'VSCodium', 'User', 'workspaceStorage'),
    )
    expect(getVSCodeWorkspaceStorageDirs('C:\\Users\\test', 'win32')).toContain(
      win32.join('C:\\Users\\test', 'AppData', 'Roaming', 'VSCodium', 'User', 'workspaceStorage'),
    )
    expect(getVSCodeWorkspaceStorageDirs('/home/test', 'linux')).toContain(
      posix.join('/home/test', '.config', 'VSCodium', 'User', 'workspaceStorage'),
    )
  })

  it('includes VSCodium globalStorage paths on all supported platforms', () => {
    expect(getVSCodeGlobalStorageDirs('/Users/test', 'darwin')).toContain(
      posix.join('/Users/test', 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage'),
    )
    expect(getVSCodeGlobalStorageDirs('C:\\Users\\test', 'win32')).toContain(
      win32.join('C:\\Users\\test', 'AppData', 'Roaming', 'VSCodium', 'User', 'globalStorage'),
    )
    expect(getVSCodeGlobalStorageDirs('/home/test', 'linux')).toContain(
      posix.join('/home/test', '.config', 'VSCodium', 'User', 'globalStorage'),
    )
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
    expect(copilot.toolDisplayName('github-mcp-server-list_issues')).toBe('mcp__github_mcp_server__list_issues')
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

// ---------------------------------------------------------------------------
// OTel cache token tests
//
// These tests verify that the OTel SQLite parser correctly extracts
// cacheReadInputTokens and cacheCreationInputTokens from the agent-traces.db
// schema, and that multiple conversations from the same DB file are each
// parsed independently with their full cache token data intact.
//
// This is the regression guard for the bug documented in DEBUG_HANDOFF.md:
// cache tokens were extracted during parsing but lost in aggregation because
// all conversations shared the same file path key in the session cache.
// ---------------------------------------------------------------------------

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

/** Creates a minimal agent-traces.db schema matching the VS Code Copilot Chat OTel store. */
function createOtelDb(dbPath: string): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE spans (
      span_id      TEXT PRIMARY KEY NOT NULL,
      trace_id     TEXT NOT NULL,
      operation_name TEXT,
      start_time_ms INTEGER NOT NULL DEFAULT 0,
      response_model TEXT
    );
    CREATE TABLE span_attributes (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      span_id TEXT NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT
    );
  `)
  db.close()
}

interface SpanDef {
  spanId: string
  traceId: string
  operationName: string
  startTimeMs?: number
  responseModel?: string
  attrs: Record<string, string | number>
}

function insertSpan(dbPath: string, span: SpanDef): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const db = new DatabaseSync(dbPath)
  db.prepare(
    `INSERT INTO spans (span_id, trace_id, operation_name, start_time_ms, response_model)
     VALUES (?, ?, ?, ?, ?)`
  ).run(span.spanId, span.traceId, span.operationName, span.startTimeMs ?? 0, span.responseModel ?? null)
  const attrStmt = db.prepare(
    `INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)`
  )
  for (const [key, value] of Object.entries(span.attrs)) {
    attrStmt.run(span.spanId, key, String(value))
  }
  db.close()
}

describe('copilot provider - OTel cache token parsing', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-otel-test-'))
    dbPath = join(tmpDir, 'agent-traces.db')
    vi.stubEnv('CODEBURN_COPILOT_OTEL_DB', dbPath)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('skips tests when node:sqlite is unavailable', () => {
    if (!isSqliteAvailable()) return
    // Placeholder — subsequent tests use isSqliteAvailable guard
  })

  it('extracts cache tokens from a single OTel conversation', async () => {
    if (!isSqliteAvailable()) return

    createOtelDb(dbPath)
    insertSpan(dbPath, {
      spanId: 'span-001',
      traceId: 'trace-001',
      operationName: 'chat',
      startTimeMs: 1000,
      responseModel: 'gpt-4.1',
      attrs: {
        'gen_ai.conversation.id': 'conv-001',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 1000,
        'gen_ai.usage.output_tokens': 200,
        'gen_ai.usage.cache_read.input_tokens': 50000,
        'gen_ai.usage.cache_creation.input_tokens': 500,
      },
    })

    const provider = createCopilotProvider('/nonexistent/jsonl', '/nonexistent/ws')
    const sources = await provider.discoverSessions()

    const otelSources = sources.filter(s => s.path.startsWith(dbPath))
    expect(otelSources).toHaveLength(1)
    expect(otelSources[0]!.provider).toBe('copilot')

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(otelSources[0]!, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.model).toBe('gpt-4.1')
    expect(call.inputTokens).toBe(1000)
    expect(call.outputTokens).toBe(200)
    expect(call.cacheReadInputTokens).toBe(50000)
    expect(call.cacheCreationInputTokens).toBe(500)
    expect(call.costUSD).toBeGreaterThan(0)
  })

  it('discovers one source per OTel DB file (not per conversation)', async () => {
    if (!isSqliteAvailable()) return

    createOtelDb(dbPath)

    // Two independent conversations in the same DB
    insertSpan(dbPath, {
      spanId: 'span-a1', traceId: 'trace-a', operationName: 'chat', startTimeMs: 1000,
      attrs: {
        'gen_ai.conversation.id': 'conv-alpha',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 800,
        'gen_ai.usage.output_tokens': 100,
        'gen_ai.usage.cache_read.input_tokens': 40000,
        'gen_ai.usage.cache_creation.input_tokens': 400,
      },
    })
    insertSpan(dbPath, {
      spanId: 'span-b1', traceId: 'trace-b', operationName: 'chat', startTimeMs: 2000,
      attrs: {
        'gen_ai.conversation.id': 'conv-beta',
        'gen_ai.response.model': 'claude-sonnet-4',
        'gen_ai.usage.input_tokens': 600,
        'gen_ai.usage.output_tokens': 80,
        'gen_ai.usage.cache_read.input_tokens': 30000,
        'gen_ai.usage.cache_creation.input_tokens': 300,
      },
    })

    const provider = createCopilotProvider('/nonexistent/jsonl', '/nonexistent/ws')
    const sources = await provider.discoverSessions()

    // One source per DB file (not per conversation)
    const otelSources = sources.filter(s => s.path === dbPath)
    expect(otelSources).toHaveLength(1)
    expect(otelSources[0]!.path).toBe(dbPath)

    // But the parser still yields calls from BOTH conversations
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(otelSources[0]!, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(2)
    const sessionIds = new Set(calls.map(c => c.sessionId))
    expect(sessionIds.size).toBe(2)
  })

  it('preserves cache tokens when parsing multiple conversations from one DB', async () => {
    if (!isSqliteAvailable()) return

    createOtelDb(dbPath)

    insertSpan(dbPath, {
      spanId: 'span-c1', traceId: 'trace-c', operationName: 'chat', startTimeMs: 1000,
      attrs: {
        'gen_ai.conversation.id': 'conv-c',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 500,
        'gen_ai.usage.output_tokens': 100,
        'gen_ai.usage.cache_read.input_tokens': 20000,
        'gen_ai.usage.cache_creation.input_tokens': 200,
      },
    })
    insertSpan(dbPath, {
      spanId: 'span-d1', traceId: 'trace-d', operationName: 'chat', startTimeMs: 2000,
      attrs: {
        'gen_ai.conversation.id': 'conv-d',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 700,
        'gen_ai.usage.output_tokens': 150,
        'gen_ai.usage.cache_read.input_tokens': 35000,
        'gen_ai.usage.cache_creation.input_tokens': 350,
      },
    })

    const provider = createCopilotProvider('/nonexistent/jsonl', '/nonexistent/ws')
    const sources = await provider.discoverSessions()
    // One source per DB file — the parser iterates all conversations internally
    const otelSource = sources.find(s => s.path === dbPath)
    expect(otelSource).toBeDefined()
    const allCalls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(otelSource!, new Set()).parse()) {
      allCalls.push(call)
    }

    expect(allCalls).toHaveLength(2)

    const totalCacheRead = allCalls.reduce((sum, c) => sum + c.cacheReadInputTokens, 0)
    const totalCacheCreate = allCalls.reduce((sum, c) => sum + c.cacheCreationInputTokens, 0)

    // Both conversations' cache tokens must survive end-to-end
    expect(totalCacheRead).toBe(55000)   // 20000 + 35000
    expect(totalCacheCreate).toBe(550)   // 200 + 350
  })

  it('includes tool names from execute_tool spans in the same trace', async () => {
    if (!isSqliteAvailable()) return

    createOtelDb(dbPath)
    // chat span
    insertSpan(dbPath, {
      spanId: 'span-e1', traceId: 'trace-e', operationName: 'chat', startTimeMs: 1000,
      attrs: {
        'gen_ai.conversation.id': 'conv-e',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 300,
        'gen_ai.usage.output_tokens': 50,
        'gen_ai.usage.cache_read.input_tokens': 10000,
        'gen_ai.usage.cache_creation.input_tokens': 100,
      },
    })
    // execute_tool span in the same trace
    insertSpan(dbPath, {
      spanId: 'span-e2', traceId: 'trace-e', operationName: 'execute_tool', startTimeMs: 1500,
      attrs: {
        'gen_ai.tool.name': 'readFile',
      },
    })

    const provider = createCopilotProvider('/nonexistent/jsonl', '/nonexistent/ws')
    const sources = await provider.discoverSessions()
    const src = sources.find(s => s.path.startsWith(dbPath))
    expect(src).toBeDefined()

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(src!, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toContain('Read')
    expect(calls[0]!.cacheReadInputTokens).toBe(10000)
  })

  it('skips OTel spans with zero input and output tokens', async () => {
    if (!isSqliteAvailable()) return

    createOtelDb(dbPath)
    insertSpan(dbPath, {
      spanId: 'span-f1', traceId: 'trace-f', operationName: 'chat', startTimeMs: 1000,
      attrs: {
        'gen_ai.conversation.id': 'conv-f',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        'gen_ai.usage.cache_read.input_tokens': 50000,
        'gen_ai.usage.cache_creation.input_tokens': 500,
      },
    })

    const provider = createCopilotProvider('/nonexistent/jsonl', '/nonexistent/ws')
    const sources = await provider.discoverSessions()
    const src = sources.find(s => s.path.startsWith(dbPath))
    expect(src).toBeDefined()

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(src!, new Set()).parse()) {
      calls.push(call)
    }
    // Span with zero input AND output tokens is skipped
    expect(calls).toHaveLength(0)
  })

  it('OTel source path equals the plain DB file path and durableSources is true', async () => {
    if (!isSqliteAvailable()) return

    createOtelDb(dbPath)
    insertSpan(dbPath, {
      spanId: 'span-g1', traceId: 'trace-g', operationName: 'chat', startTimeMs: 1000,
      attrs: {
        'gen_ai.conversation.id': 'conv-g',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 10,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.cache_creation.input_tokens': 0,
      },
    })

    const provider = createCopilotProvider('/nonexistent/jsonl', '/nonexistent/ws')

    // durableSources must be true on the copilot provider
    expect(provider.durableSources).toBe(true)

    const sources = await provider.discoverSessions()
    const otelSrc = sources.find(s => s.path.startsWith(dbPath))
    expect(otelSrc).toBeDefined()

    // Path is the plain DB file path (no #otel-conv= compound suffix)
    expect(otelSrc!.path).toBe(dbPath)

    // Parser must open the DB and produce results for all conversations
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(otelSrc!, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(100)
  })

  it('attributes genuine subagents but excludes the root agent', async () => {
    if (!isSqliteAvailable()) return

    createOtelDb(dbPath)

    // Root agent turn: chat span + invoke_agent WITHOUT a parent session.
    insertSpan(dbPath, {
      spanId: 'span-root-chat', traceId: 'trace-root', operationName: 'chat', startTimeMs: 1000,
      attrs: {
        'gen_ai.conversation.id': 'conv-h',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 400,
        'gen_ai.usage.output_tokens': 60,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.cache_creation.input_tokens': 0,
      },
    })
    insertSpan(dbPath, {
      spanId: 'span-root-agent', traceId: 'trace-root', operationName: 'invoke_agent', startTimeMs: 1010,
      attrs: {
        'gen_ai.conversation.id': 'conv-h',
        'gen_ai.agent.name': 'GitHub Copilot Chat',
      },
    })

    // Genuine subagent: its own trace holds the subagent's chat span plus an
    // invoke_agent span carrying copilot_chat.parent_chat_session_id.
    insertSpan(dbPath, {
      spanId: 'span-sub-chat', traceId: 'trace-sub', operationName: 'chat', startTimeMs: 2000,
      attrs: {
        'gen_ai.conversation.id': 'conv-h',
        'gen_ai.response.model': 'claude-haiku-4.5',
        'gen_ai.usage.input_tokens': 250,
        'gen_ai.usage.output_tokens': 30,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.cache_creation.input_tokens': 0,
      },
    })
    insertSpan(dbPath, {
      spanId: 'span-sub-agent', traceId: 'trace-sub', operationName: 'invoke_agent', startTimeMs: 2010,
      attrs: {
        'gen_ai.conversation.id': 'conv-h',
        'gen_ai.agent.name': 'Explore',
        'copilot_chat.parent_chat_session_id': 'conv-h',
      },
    })

    const provider = createCopilotProvider('/nonexistent/jsonl', '/nonexistent/ws')
    const sources = await provider.discoverSessions()
    const src = sources.find(s => s.path.startsWith(dbPath))
    expect(src).toBeDefined()

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(src!, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(2)
    const rootCall = calls.find(c => c.model === 'gpt-4.1')!
    const subCall = calls.find(c => c.model === 'claude-haiku-4.5')!

    // Root agent must NOT surface as a subagent
    expect(rootCall.subagentTypes ?? []).not.toContain('GitHub Copilot Chat')
    expect(rootCall.subagentTypes ?? []).toHaveLength(0)

    // Genuine subagent is attributed to its own call
    expect(subCall.subagentTypes).toEqual(['Explore'])
  })

  it('normalises multi-line OTel shell scripts, dropping control-flow keywords', async () => {
    if (!isSqliteAvailable()) return

    createOtelDb(dbPath)
    insertSpan(dbPath, {
      spanId: 'span-sh-chat', traceId: 'trace-sh', operationName: 'chat', startTimeMs: 1000,
      attrs: {
        'gen_ai.conversation.id': 'conv-sh',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 10,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.cache_creation.input_tokens': 0,
      },
    })
    // A full multi-line script with control flow and newline-separated commands,
    // exactly as the OTel store records it.
    insertSpan(dbPath, {
      spanId: 'span-sh-tool', traceId: 'trace-sh', operationName: 'execute_tool', startTimeMs: 1500,
      attrs: {
        'gen_ai.tool.name': 'run_in_terminal',
        'gen_ai.tool.call.arguments': JSON.stringify({
          command: 'for f in *.ts; do\n  echo "$f"\ndone\ngit status\nnpm test',
        }),
      },
    })

    const provider = createCopilotProvider('/nonexistent/jsonl', '/nonexistent/ws')
    const sources = await provider.discoverSessions()
    const src = sources.find(s => s.path.startsWith(dbPath))
    expect(src).toBeDefined()

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(src!, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const bash = calls[0]!.bashCommands
    // Real commands separated by newlines/`;` are captured
    expect(bash).toEqual(expect.arrayContaining(['echo', 'git', 'npm']))
    // Control-flow keywords are NOT reported as commands
    for (const kw of ['for', 'do', 'done']) {
      expect(bash).not.toContain(kw)
    }
  })
})

// ---------------------------------------------------------------------------
// JetBrains (IntelliJ / PyCharm / …) session parsing
// ---------------------------------------------------------------------------
//
// The JetBrains Copilot plugin persists sessions to a Nitrite (H2 MVStore) .db
// (~/.config/github-copilot/<ide>/<kind>/<storeId>/copilot-*-nitrite.db) of
// Java-serialized documents. Assistant replies are nested-escaped
// {"__first__":{"type":"Subgraph",…}} blobs; the model and projectName are
// separate serialized fields. These helpers reproduce that on-disk shape so
// tests exercise the real regex/scan extraction path.

describe('copilot provider - JetBrains parsing', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-jetbrains-test-'))
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  // A JetBrains source: session content lives in the Nitrite .db.
  function jbDbSource(path: string, sessionId: string, mtime = '2026-07-03T12:00:00.000Z') {
    return {
      path, project: 'copilot-jetbrains', provider: 'copilot', sourceType: 'jetbrains',
      sessionId, storeId: sessionId, dbPath: path, mtime,
    } as unknown as { path: string; project: string; provider: string; sourceType?: string }
  }

  // ---- Nitrite .db parsing ----

  // Build an assistant response blob in the real nested-escaped shape:
  // {"__first__":{"type":"Subgraph","value":"{\"<uuid>\":{\"type\":\"Value\",
  //   \"value\":\"{\\\"type\\\":\\\"Markdown\\\",\\\"data\\\":\\\"{\\\\\\\"text\\\\\\\":...}\"}"}}
  function jbAssistantBlob(text: string, opts: { model?: string; errored?: boolean; files?: string[] } = {}) {
    const innerMd = { type: 'Markdown', data: JSON.stringify({ text, annotations: [] }) }
    const valueMap: Record<string, unknown> = {
      'a1b2c3d4-0000-0000-0000-000000000001': { type: 'Value', value: JSON.stringify(innerMd) },
    }
    if (opts.model) valueMap['__model__'] = { type: 'Value', value: `{"model":"${opts.model}"}` }
    // Files the turn referenced — project is derived from these file:// paths.
    if (opts.files) {
      valueMap['__refs__'] = {
        type: 'Value',
        value: JSON.stringify({ type: 'References', data: opts.files.map((f) => `file://${f}`).join(' ') }),
      }
    }
    const outer: Record<string, unknown> = {
      __first__: { type: 'Subgraph', value: JSON.stringify(valueMap) },
    }
    if (opts.errored) {
      // Real failed turns store the error under a type:"Error" record with a
      // `message` field (NOT a Markdown `text`), so it is not billable output.
      outer['__err__'] = {
        type: 'Value',
        value: JSON.stringify({ type: 'Error', message: 'Sorry, an error occurred while generating a response' }),
      }
    }
    return JSON.stringify(outer)
  }

  // An AGENT-MODE assistant blob: the reply lives in an AgentRound record, and
  // (as in real agent sessions) the Markdown record holds the USER's prompt,
  // which must NOT be counted as the reply. `rounds` is a list of AgentRound
  // replies (a single blob can carry several); a pure tool-call round has ''.
  function jbAgentBlob(rounds: string[], opts: { model?: string; userPrompt?: string; errored?: boolean } = {}) {
    const valueMap: Record<string, unknown> = {}
    let n = 0
    // The user prompt as a Markdown record — a decoy the reply extractor must
    // skip in agent mode (real stores put the prompt here, not the answer).
    if (opts.userPrompt !== undefined) {
      const md = { type: 'Markdown', data: JSON.stringify({ text: opts.userPrompt, annotations: [] }) }
      valueMap[`u0000000-0000-0000-0000-00000000000${n++}`] = { type: 'Value', value: JSON.stringify(md) }
    }
    for (const reply of rounds) {
      const ar = { type: 'AgentRound', data: JSON.stringify({ roundId: n, reply, toolCalls: [] }) }
      valueMap[`a0000000-0000-0000-0000-00000000000${n++}`] = { type: 'Value', value: JSON.stringify(ar) }
    }
    if (opts.model) valueMap['__model__'] = { type: 'Value', value: `{"model":"${opts.model}"}` }
    const outer: Record<string, unknown> = { __first__: { type: 'Subgraph', value: JSON.stringify(valueMap) } }
    if (opts.errored) {
      outer['__err__'] = {
        type: 'Value',
        value: JSON.stringify({ type: 'Error', message: 'Sorry, an error occurred while generating a response' }),
      }
    }
    return JSON.stringify(outer)
  }

  // A conversation title record in the real framing: `$<GUID>…name…value<TITLE>t\x00\x06source`.
  function jbConversationRecord(guid: string, title: string) {
    return `$${guid}t\x00\x04namesq\x00\x01?@\x00\x00w\x00\x00t\x00value t\x00${title}t\x00\x06sourcet\x00copilotx`
  }

  // Assemble a minimal Nitrite-.db-shaped buffer: MVStore header + entity-class
  // anchor + optional conversation records + assistant blobs. When a blob is
  // preceded by a conversation record, turns attribute to that conversation.
  function jbDbContent(blobs: string[], conversations: string[] = []) {
    return (
      'H:2,block:9,blockSize:1000,format:3\n' +
      'com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n' +
      conversations.join('\n') + '\n' +
      blobs.join('\nt\x00\x00model\n') +
      '\n'
    )
  }

  async function createJetBrainsDb(root: string, ide: string, kind: string, storeId: string, content: string) {
    const dir = join(root, ide, kind, storeId)
    await mkdir(dir, { recursive: true })
    const dbName =
      kind === 'chat-agent-sessions'
        ? 'copilot-agent-sessions-nitrite.db'
        : kind === 'chat-edit-sessions'
          ? 'copilot-edit-sessions-nitrite.db'
          : 'copilot-chat-nitrite.db'
    await writeFile(join(dir, dbName), content)
    return join(dir, dbName)
  }

  // The plugin-recorded project label, in the real Java-serialized framing:
  // the field key `projectName` followed by TC_STRING `0x74 <u16 len> <value>`,
  // then the sibling `user` field. This is what extractJetBrainsProjectName reads.
  function jbProjectNameField(name: string) {
    // TC_STRING length is the UTF-8 BYTE count (the .db is written UTF-8 and
    // read back as latin1), not the JS UTF-16 code-unit count.
    const len = Buffer.byteLength(name, 'utf8')
    const hi = String.fromCharCode((len >> 8) & 0xff)
    const lo = String.fromCharCode(len & 0xff)
    return `t\x00\x0bprojectName\x74${hi}${lo}${name}t\x00\x04usert\x00\x08dev-user`
  }

  it('parses assistant turns from a Nitrite .db and estimates cost', async () => {
    const content = jbDbContent([
      jbAssistantBlob('Hello! How can I help you today?'),
      jbAssistantBlob('Here is a longer architecture overview with plenty of detail.', { model: 'claude-opus-4.5' }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-1', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'conv-1'))
    expect(calls).toHaveLength(2)
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
    expect(calls[0]!.costIsEstimated).toBe(true)
    expect(calls[0]!.inputTokens).toBe(0)
    // Per-turn model recovered from inside the blob, normalised dots→dashes.
    expect(calls[1]!.model).toBe('claude-opus-4-5')
    expect(calls[1]!.costUSD).toBeGreaterThan(0)
    // Dedup keys are conversation-scoped, content-derived, and distinct.
    expect(calls[0]!.deduplicationKey).toMatch(/^copilot:jb:conv-1:[0-9a-f]{12}:1$/)
    expect(calls[1]!.deduplicationKey).toMatch(/^copilot:jb:conv-1:[0-9a-f]{12}:1$/)
    expect(calls[0]!.deduplicationKey).not.toBe(calls[1]!.deduplicationKey)
  })

  it('recovers a reply containing quotes without garbling or duplicating it', async () => {
    // Regression: the unescape loop must run extraction ONLY on the final,
    // fully-unescaped form. Accumulating matches at every depth would union a
    // half-unescaped (quote-truncated) capture with the full one, producing a
    // garbled duplicate and inflating the token/cost estimate.
    const reply = 'Use `printf "%s"` to print, then check "status" here.'
    const content = jbDbContent([jbAssistantBlob(reply, { model: 'claude-opus-4.5' })])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-quote', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'conv-quote'))
    expect(calls).toHaveLength(1)
    // Token estimate reflects the true reply length (CHARS_PER_TOKEN = 4), not
    // an inflated garbled copy.
    expect(calls[0]!.outputTokens).toBe(Math.ceil(reply.length / 4))
  })

  it('counts a multibyte UTF-8 reply by codepoints, not latin1 bytes', async () => {
    // The .db is read as latin1; the parser must re-decode to UTF-8 so a
    // multibyte char counts as one codepoint for the token estimate.
    const reply = 'café ☕ déjà vu — naïve façade' // several multibyte chars
    const content = jbDbContent([jbAssistantBlob(reply, { model: 'claude-opus-4.5' })])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-utf8', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'conv-utf8'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBe(Math.ceil(reply.length / 4))
  })

  it('extracts agent-mode replies from AgentRound (not the user prompt Markdown)', async () => {
    // Agent-mode sessions (e.g. PyCharm) store the reply in an AgentRound record;
    // the Markdown record holds the USER prompt. The reply extractor must read
    // the AgentRound reply and ignore the prompt — otherwise the turn bills $0
    // (reply never found) or bills the user's words as output.
    const reply = "Here's a quick summary of this repo: it does X, Y, and Z."
    const content = jbDbContent([
      jbAgentBlob([reply], { model: 'claude-opus-4.5', userPrompt: 'summarise this repo' }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'py', 'chat-agent-sessions', 'conv-agent', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'conv-agent'))
    expect(calls).toHaveLength(1)
    // Priced from the AgentRound reply, not the (shorter) user prompt.
    expect(calls[0]!.outputTokens).toBe(Math.ceil(reply.length / 4))
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
    expect(calls[0]!.model).toBe('claude-opus-4-5')
  })

  it('skips pure tool-call agent rounds (empty reply → no billable output)', async () => {
    // A round that only issued tool calls has reply:'' — it contributes nothing,
    // exactly like a Steps-only ask-mode blob.
    const content = jbDbContent([jbAgentBlob([''], { model: 'claude-opus-4.5' })])
    const dbPath = await createJetBrainsDb(tmpDir, 'py', 'chat-agent-sessions', 'conv-toolonly', content)
    const calls = await collectCalls(jbDbSource(dbPath, 'conv-toolonly'))
    expect(calls).toHaveLength(0)
  })

  it('a failed agent turn bills $0 and never counts the user prompt as the reply', async () => {
    // Failed agent turn: empty AgentRound reply + an error marker + a user-prompt
    // Markdown record. The parser must NOT fall back to the Markdown (that would
    // bill the user's words); an agent blob is agent mode regardless of whether
    // its reply is empty, so this is an errored turn → $0.
    const content = jbDbContent([
      jbAgentBlob([''], { model: 'claude-opus-4.5', userPrompt: 'do the thing', errored: true }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'py', 'chat-agent-sessions', 'conv-agenterr', content)
    const calls = await collectCalls(jbDbSource(dbPath, 'conv-agenterr'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBe(0)
    expect(calls[0]!.costUSD).toBe(0)
  })

  it('collects multiple AgentRound replies within one blob', async () => {
    // A multi-round agent turn: the first round explores (tool call, empty
    // reply), the second answers. Both non-empty replies are joined.
    const content = jbDbContent([
      jbAgentBlob(['Let me explore the project.', '', 'Done — here is what it does.'], {
        model: 'claude-opus-4.5',
      }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'py', 'chat-agent-sessions', 'conv-multiround', content)
    const calls = await collectCalls(jbDbSource(dbPath, 'conv-multiround'))
    expect(calls).toHaveLength(1)
    const joined = 'Let me explore the project.\nDone — here is what it does.'
    expect(calls[0]!.outputTokens).toBe(Math.ceil(joined.length / 4))
  })

  it('treats errored turns as $0 (failed generation, no billable output)', async () => {
    const content = jbDbContent([
      jbAssistantBlob('', { errored: true }),
      jbAssistantBlob('A real successful reply.', { model: 'claude-opus-4.5' }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-err', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'conv-err'))
    expect(calls).toHaveLength(2)
    const errored = calls.find((c) => c.outputTokens === 0)
    const good = calls.find((c) => c.outputTokens > 0)
    expect(errored).toBeDefined()
    expect(errored!.costUSD).toBe(0)
    expect(good).toBeDefined()
    expect(good!.costUSD).toBeGreaterThan(0)
  })

  it('de-duplicates repeated byte-copies of the same reply within a .db', async () => {
    const content = jbDbContent([
      jbAssistantBlob('identical reply text stored twice'),
      jbAssistantBlob('identical reply text stored twice'),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-dup', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'conv-dup'))
    expect(calls).toHaveLength(1)
  })

  it('skips Steps/progress-only assistant blobs (no billable text)', async () => {
    const stepsBlob = JSON.stringify({
      __first__: {
        type: 'Subgraph',
        value: JSON.stringify({ x: { type: 'Value', value: JSON.stringify({ type: 'Steps', data: '[]' }) } }),
      },
    })
    const content = jbDbContent([stepsBlob, jbAssistantBlob('The only real answer.')])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-steps', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'conv-steps'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
  })

  it('per-turn model differences within one .db (opus vs gpt) are priced separately', async () => {
    const content = jbDbContent([
      jbAssistantBlob('Opus answer with enough words to score tokens.', { model: 'claude-opus-4.5' }),
      jbAssistantBlob('GPT answer with enough words to score tokens.', { model: 'gpt-5.3' }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-multi', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'conv-multi'))
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.model).sort()).toEqual(['claude-opus-4-5', 'gpt-5.3'])
  })

  it('splits one .db into sessions by conversation; project = repo, title = session label', async () => {
    const guidA = '6acf5299-f9f7-404f-812d-dbe8300e1e5b'
    const guidB = '485825c0-3331-46a7-acb2-c71875ad6640'
    // Conversation A references a file in a real git repo; B touches no files.
    const repoDir = join(tmpDir, 'container', 'web-api')
    await mkdir(join(repoDir, '.git'), { recursive: true })
    await mkdir(join(repoDir, 'src'), { recursive: true })
    const fileA = join(repoDir, 'src', 'Main.java')
    // Interleave each conversation record before its own turns (turns attribute
    // to the nearest preceding conversation GUID). Title evolves default→final.
    const content =
      'H:2,block:9,blockSize:1000,format:3\n' +
      'com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n' +
      jbConversationRecord(guidA, 'New Agent Session') + '\n' +
      jbConversationRecord(guidA, 'Understanding the API Architecture') + '\n' +
      jbAssistantBlob('Answer about the web API.', { model: 'claude-opus-4.5', files: [fileA] }) + '\n' +
      jbConversationRecord(guidB, 'Exploring the Controller Layer in Spring Boot') + '\n' +
      jbAssistantBlob('Answer about the controller layer breakdown.', { model: 'gpt-5.3' }) + '\n'
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'multi-conv', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'multi-conv'))
    expect(calls).toHaveLength(2)
    const bySession = new Map(calls.map((c) => [c.sessionId, c]))
    // Sessions are split by conversation GUID.
    expect(bySession.has(guidA)).toBe(true)
    expect(bySession.has(guidB)).toBe(true)
    // Project = the git repo root of the referenced file; else the generic
    // bucket when the chat touched no files.
    expect(bySession.get(guidA)!.project).toBe('web-api')
    expect(bySession.get(guidB)!.project).toBe('copilot-jetbrains')
    // The conversation TITLE is the session label (userMessage), NOT the project.
    expect(bySession.get(guidA)!.userMessage).toBe('Understanding the API Architecture')
    expect(bySession.get(guidB)!.userMessage).toBe('Exploring the Controller Layer in Spring Boot')
    // Titles must never appear as project names (they are chat threads).
    expect(calls.map((c) => c.project)).not.toContain('Understanding the API Architecture')
  })

  it('is idempotent across re-parses of the same .db (shared seenKeys)', async () => {
    const content = jbDbContent([jbAssistantBlob('first reply'), jbAssistantBlob('second reply')])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-idem', content)

    const seen = new Set<string>()
    const first = await collectCalls(jbDbSource(dbPath, 'conv-idem'), seen)
    const second = await collectCalls(jbDbSource(dbPath, 'conv-idem'), seen)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(0)
  })

  it('discovers a store dir with a Nitrite .db', async () => {
    const content = jbDbContent([jbAssistantBlob('hi there')])
    await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'db-only', content)

    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/ws', '/nonexistent/global', tmpDir)
    const sessions = await provider.discoverSessions()
    const jb = sessions.filter((s) => (s as { sourceType?: string }).sourceType === 'jetbrains')
    expect(jb).toHaveLength(1)
    expect((jb[0] as { dbPath?: string }).dbPath).toContain('copilot-agent-sessions-nitrite.db')
  })

  it('infers project as the git repo root of a referenced file (deep subdir → repo root)', async () => {
    // Create a real git repo on disk so the .git walk-up can resolve it.
    const repoDir = join(tmpDir, 'container', 'myapp')
    await mkdir(join(repoDir, '.git'), { recursive: true })
    await mkdir(join(repoDir, 'src', 'a'), { recursive: true })
    const fileA = join(repoDir, 'src', 'a', 'One.ts')
    const content = jbDbContent([
      jbAssistantBlob('Editing files in a real repo.', { model: 'gpt-4.1', files: [fileA] }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-gitwalk', content)

    const calls = await collectCalls(jbDbSource(dbPath, 'conv-gitwalk'))
    expect(calls).toHaveLength(1)
    // Project = basename of the nearest ancestor with .git (the repo root
    // 'myapp'), NOT the deep subdir 'a'/'src' or the container dir.
    expect(calls[0]!.project).toBe('myapp')
    expect(calls[0]!.model).toBe('gpt-4.1')
  })

  it('falls back to copilot-jetbrains when no referenced file resolves to a git repo', async () => {
    const content = jbDbContent([
      jbAssistantBlob('Editing a file outside any repo.', {
        model: 'gpt-4.1',
        files: ['/nonexistent/no-repo-here/src/One.ts'],
      }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-norepo', content)
    const calls = await collectCalls(jbDbSource(dbPath, 'conv-norepo'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.project).toBe('copilot-jetbrains')
  })

  it('resolves a git repo whose name contains a space', async () => {
    const repoDir = join(tmpDir, 'My Project')
    await mkdir(join(repoDir, '.git'), { recursive: true })
    await mkdir(join(repoDir, 'src'), { recursive: true })
    const file = join(repoDir, 'src', 'One.ts')
    const content = jbDbContent([
      jbAssistantBlob('Reading a file in a spaced repo.', { model: 'gpt-4.1', files: [file] }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-space', content)
    const calls = await collectCalls(jbDbSource(dbPath, 'conv-space'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.project).toBe('My Project')
  })

  it('discovers JetBrains sessions across IDE dirs and session kinds', async () => {
    const content = jbDbContent([jbAssistantBlob('Hello from agent mode.', { model: 'claude-opus-4.5' })])
    await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'a1', content)
    await createJetBrainsDb(tmpDir, 'intellij', 'chat-agent-sessions', 'b1', content)

    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/ws', '/nonexistent/global', tmpDir)
    const sessions = await provider.discoverSessions()
    const jb = sessions.filter((s) => (s as { sourceType?: string }).sourceType === 'jetbrains')
    expect(jb.map((s) => (s as { sessionId?: string }).sessionId).sort()).toEqual(['a1', 'b1'])
  })

  it('does not crash on a corrupt/truncated .db', async () => {
    const dbPath = await createJetBrainsDb(
      tmpDir,
      'iu',
      'chat-agent-sessions',
      'conv-corrupt',
      'H:2,block:9\ncom.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n{"__first__":{"type":"Subgraph"' // truncated, unbalanced
    )
    const calls = await collectCalls(jbDbSource(dbPath, 'conv-corrupt'))
    expect(Array.isArray(calls)).toBe(true) // no throw; may be empty
  })

  // ---- projectName field (JetBrains Copilot 1.12+) ----

  it('uses the plugin-recorded projectName over the file-path git-walk', async () => {
    // Same store carries both a projectName AND a file ref; projectName wins.
    const repoDir = join(tmpDir, 'container', 'walkable-repo')
    await mkdir(join(repoDir, '.git'), { recursive: true })
    const file = join(repoDir, 'Main.java')
    const content = jbDbContent([
      jbProjectNameField('shared-utils'),
      jbAssistantBlob('An answer referencing a file in a real git repo.', {
        model: 'claude-opus-4.5',
        files: [file],
      }),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-pn', content)
    // discoverSessions populates source.projectName; feed the resolved source.
    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/ws', '/nonexistent/global', tmpDir)
    const sessions = await provider.discoverSessions()
    const src = sessions.find((s) => (s as { storeId?: string }).storeId === 'conv-pn')!
    expect((src as { projectName?: string }).projectName).toBe('shared-utils')
    const calls = await collectCalls(src as never)
    expect(calls.length).toBeGreaterThan(0)
    // projectName beats the git-walk result (`walkable-repo`).
    expect(calls.every((c) => c.project === 'shared-utils')).toBe(true)
  })

  it('joins projectName across kind dirs by store id (turns in agent, name in edit)', async () => {
    // The billable turns live in chat-agent-sessions but carry NO projectName;
    // the sibling chat-edit-sessions store (same id) records it. Discovery must
    // join them so the agent session is labelled with the real repo.
    const storeId = 'store-xyz-123'
    const agentContent = jbDbContent([
      jbAssistantBlob('Architecture overview of the repo, no file refs at all.', { model: 'claude-opus-4.5' }),
    ])
    await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', storeId, agentContent)
    // Edit-kind store: has the projectName, but no billable turns.
    const editContent = jbDbContent([], []) + jbProjectNameField('web-api')
    await createJetBrainsDb(tmpDir, 'iu', 'chat-edit-sessions', storeId, editContent)

    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/ws', '/nonexistent/global', tmpDir)
    const sessions = await provider.discoverSessions()
    const jb = sessions.filter((s) => (s as { sourceType?: string }).sourceType === 'jetbrains')
    // Every source for this store id inherits the sibling-recorded name.
    for (const s of jb) {
      expect((s as { projectName?: string }).projectName).toBe('web-api')
    }
    const agentSrc = jb.find((s) => ((s as { dbPath?: string }).dbPath ?? '').includes('chat-agent-sessions'))!
    const calls = await collectCalls(agentSrc as never)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.project === 'web-api')).toBe(true)
  })

  it('falls back to git-walk then bucket when no projectName is recorded', async () => {
    // No projectName, no file refs → the honest generic bucket (older plugins).
    const content = jbDbContent([jbAssistantBlob('A reply with no project signal at all.')])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'conv-nopn', content)
    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/ws', '/nonexistent/global', tmpDir)
    const sessions = await provider.discoverSessions()
    const src = sessions.find((s) => (s as { storeId?: string }).storeId === 'conv-nopn')!
    expect((src as { projectName?: string }).projectName).toBeUndefined()
    const calls = await collectCalls(src as never)
    expect(calls.every((c) => c.project === 'copilot-jetbrains')).toBe(true)
  })

  it('extractJetBrainsProjectName reads the length-prefixed value, immune to embedded quotes', async () => {
    // A value containing a quote/newline must not truncate: length-prefixed read.
    const tricky = 'weird"name'
    const raw = jbDbContent([jbAssistantBlob('x')]) + jbProjectNameField(tricky)
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-sessions', 'conv-tricky', raw)
    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/ws', '/nonexistent/global', tmpDir)
    const sessions = await provider.discoverSessions()
    const src = sessions.find((s) => (s as { storeId?: string }).storeId === 'conv-tricky')!
    expect((src as { projectName?: string }).projectName).toBe(tricky)
  })

  it('reads a non-ASCII (multibyte UTF-8) projectName', async () => {
    // The value is length-delimited in UTF-8 bytes and re-decoded latin1→utf8,
    // so a repo name with multibyte characters must round-trip intact.
    const name = 'проект-café'
    const raw = jbDbContent([jbAssistantBlob('x')]) + jbProjectNameField(name)
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-sessions', 'conv-utf8name', raw)
    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/ws', '/nonexistent/global', tmpDir)
    const sessions = await provider.discoverSessions()
    const src = sessions.find((s) => (s as { storeId?: string }).storeId === 'conv-utf8name')!
    expect((src as { projectName?: string }).projectName).toBe(name)
  })

  // ---------------------------------------------------------------------------
  // Old plugin format (≤1.5.x, e.g. 1.5.59-243)
  // ---------------------------------------------------------------------------
  // In the old plugin all session turns live inside ONE large binary-framed
  // outer Nitrite document. Each turn's response is stored as a UUID-keyed
  // Value entry containing an AgentRound record (one escaping level deeper than
  // the __first__/Subgraph format used by plugins ≥1.12.x).

  /**
   * Build an outer Nitrite document in the old plugin format.
   * The document is preceded by a single binary byte (0x81) and starts with a
   * UUID-keyed Value entry. Each AgentRound is stored as a Value whose value
   * field is a JSON string containing {\"type\":\"AgentRound\",\"data\":\"...\"}
   * (one level of JSON-string escaping from the document root).
   */
  function jbOldFormatDoc(rounds: Array<{ reply: string; model?: string }>, opts: { upperUuid?: boolean } = {}) {
    const cased = (u: string) => (opts.upperUuid ? u.toUpperCase() : u)
    const entries: Record<string, unknown> = {}
    // Lead entry (mimics the References record always present in real DBs)
    entries[cased('0f383f5c-f169-4fee-9115-c06d4dd8985f')] = {
      type: 'Value',
      value: JSON.stringify({ type: 'References', data: '[]' }),
    }
    rounds.forEach((r, i) => {
      const uuid = cased(`ccadf30b-fa34-4387-9f14-0a5f63457d${String(i).padStart(2, '0')}`)
      const agentRoundData = JSON.stringify({ roundId: i + 1, reply: r.reply, toolCalls: [] })
      const agentRoundValue = JSON.stringify({ type: 'AgentRound', data: agentRoundData })
      entries[uuid] = { type: 'Value', value: agentRoundValue }
      if (r.model) {
        const modelUuid = cased(`bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb${String(i).padStart(4, '0')}`)
        entries[modelUuid] = { type: 'Value', value: `{"model":"${r.model}"}` }
      }
    })
    // Binary framing byte (0x81) followed by the JSON document
    return '\x81' + JSON.stringify(entries)
  }

  it('parses agent turns from old plugin format (≤1.5.x, no __first__ blobs)', async () => {
    // The old plugin stores all turns in one big outer Nitrite document with a
    // binary framing byte. The fallback path must find and parse it.
    const convGuid = '17a5d71b-27f7-4937-8803-7fc2cbb705cb'
    const convRecord = jbConversationRecord(convGuid, 'Understanding HBase Architecture')
    const oldFormatContent =
      'H:2,block:8,blockSize:1000,format:3\n' +
      'com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n' +
      convRecord + '\n' +
      jbOldFormatDoc([
        { reply: "I'll scan the repository to find the top-level project structure.", model: 'gpt-4.1' },
        { reply: "Now I'll open the README to explain architecture." },
        { reply: '' }, // empty reply (pure tool-call round) — must not produce a call
      ])

    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'old-fmt-1', oldFormatContent)
    const calls = await collectCalls(jbDbSource(dbPath, 'old-fmt-1'))

    // The fallback emits one call per outer document (all replies joined).
    expect(calls).toHaveLength(1)
    expect(calls[0]!.costIsEstimated).toBe(true)
    // The two NON-EMPTY rounds are captured and joined; the empty (tool-call)
    // round contributes nothing. Assert the exact combined token count so the
    // test fails if either reply is dropped or the empty round leaks in.
    const joined =
      "I'll scan the repository to find the top-level project structure.\n" +
      "Now I'll open the README to explain architecture."
    expect(calls[0]!.outputTokens).toBe(Math.ceil(joined.length / 4))
    // The session label is the conversation TITLE, not the reply text.
    expect(calls[0]!.userMessage).toBe('Understanding HBase Architecture')
  })

  it('parses old plugin format when the outer-doc UUIDs are uppercase hex', async () => {
    // The outer-doc detection must be case-insensitive: an uppercase UUID must
    // not make the whole session fall through to $0.
    const convRecord = jbConversationRecord('27b6e82c-38f8-4048-9914-8fd3dcc816dc', 'Conv Upper')
    const content =
      'H:2,block:8,blockSize:1000,format:3\n' +
      'com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n' +
      convRecord + '\n' +
      jbOldFormatDoc([{ reply: 'An uppercase-UUID reply with enough words to score.' }], { upperUuid: true })
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'old-fmt-upper', content)
    const calls = await collectCalls(jbDbSource(dbPath, 'old-fmt-upper'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
  })

  it('old plugin format: does not parse when __first__ blobs already yield turns (no double-count)', async () => {
    // When the newer __first__/Subgraph path finds turns, the old-format fallback
    // must not run (turns.length > 0 prevents it).
    const content = jbDbContent([
      jbAgentBlob(['A reply from the new format.']),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'new-fmt-guard', content)
    const calls = await collectCalls(jbDbSource(dbPath, 'new-fmt-guard'))
    // Only the one Subgraph-format turn — no old-format duplicates
    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
  })
})

describe('copilot provider - JetBrains dedup key stability across store rewrites', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-jetbrains-dedup-'))
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  function jbDedupSource(path: string, sessionId: string) {
    return {
      path, project: 'copilot-jetbrains', provider: 'copilot', sourceType: 'jetbrains',
      sessionId, storeId: sessionId, dbPath: path, mtime: '2026-07-03T12:00:00.000Z',
    } as unknown as { path: string; project: string; provider: string; sourceType?: string }
  }

  function blobFor(text: string) {
    const innerMd = { type: 'Markdown', data: JSON.stringify({ text, annotations: [] }) }
    const valueMap = { 'a1b2c3d4-0000-0000-0000-000000000001': { type: 'Value', value: JSON.stringify(innerMd) } }
    return JSON.stringify({ __first__: { type: 'Subgraph', value: JSON.stringify(valueMap) } })
  }

  function dbContent(blobs: string[]) {
    return (
      'H:2,block:9,blockSize:1000,format:3\n' +
      'com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n' +
      '\n' + blobs.join('\nt\x00\x00model\n') + '\n'
    )
  }

  it('a compaction that moves a new blob ahead of an old one must not re-bill the old turn', async () => {
    // copilot is a durable provider: cached turns are never deleted, and a
    // re-parse appends any dedup key it has not seen. MVStore compaction can
    // rewrite the file with blobs in a different byte order. If dedup keys were
    // positional (conversation + scan index), a rewrite that puts a NEW turn
    // before an OLD one would hand the new turn the old turn's key (skipped as
    // already-seen) and re-emit the old turn under a fresh index — billing it
    // twice and never billing the new turn. Content-derived keys are immune.
    const oldReply = 'The original answer, long enough to carry a token estimate.'
    const newReply = 'A fresh answer written after the compaction happened.'

    const dir = join(tmpDir, 'iu', 'chat-agent-sessions', 'conv-rewrite')
    await mkdir(dir, { recursive: true })
    const dbPath = join(dir, 'copilot-agent-sessions-nitrite.db')

    const seen = new Set<string>()

    // Scan 1: the store holds only the old turn.
    await writeFile(dbPath, dbContent([blobFor(oldReply)]))
    const first = await collectCalls(jbDedupSource(dbPath, 'conv-rewrite'), seen)
    expect(first).toHaveLength(1)
    expect(first[0]!.outputTokens).toBe(Math.ceil(oldReply.length / 4))

    // Scan 2: compaction rewrote the file — the new turn now sits BEFORE the
    // old one in byte order.
    await writeFile(dbPath, dbContent([blobFor(newReply), blobFor(oldReply)]))
    const second = await collectCalls(jbDedupSource(dbPath, 'conv-rewrite'), seen)

    // Exactly the new turn must be billed — once, at its own length. The old
    // turn is already cached and must not re-enter under a different key.
    expect(second).toHaveLength(1)
    expect(second[0]!.outputTokens).toBe(Math.ceil(newReply.length / 4))
  })
})
