import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join, posix, win32 } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { copilot, createCopilotProvider, getVSCodeWorkspaceStorageDirs } from '../../src/providers/copilot.js'
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
