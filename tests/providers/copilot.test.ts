import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join, posix, win32 } from 'path'
import { tmpdir } from 'os'

import { copilot, createCopilotProvider, getVSCodeWorkspaceStorageDirs } from '../../src/providers/copilot.js'
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

// JetBrains (IntelliJ/DataGrip) format, added in #433. Discovery + parsing,
// the isJetBrainsFormat routing guard, and the id-less dedup fallback.
describe('copilot provider - JetBrains format', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-jb-'))
  })
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  const jbUser = (text: string) =>
    JSON.stringify({ type: 'user.message_rendered', data: { renderedMessage: text } })
  const jbTurnStart = (turnId: string) =>
    JSON.stringify({ type: 'assistant.turn_start', data: { turnId } })
  const jbToolStart = (toolName: string, toolCallId: string, path?: string) =>
    JSON.stringify({ type: 'tool.execution_start', data: { toolName, toolCallId, arguments: path ? { path } : {} } })
  const jbAssistant = (opts: { messageId?: string; text?: string; outputTokens?: number; iterationNumber?: number }) =>
    JSON.stringify({ type: 'assistant.message', data: { ...opts } })

  async function writeJbSession(workspaceId: string, lines: string[]) {
    const dir = join(tmpDir, workspaceId)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, 'chat.jsonl')
    await writeFile(filePath, lines.join('\n') + '\n')
    return filePath
  }

  async function parse(filePath: string, seen = new Set<string>()) {
    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/vscode', tmpDir)
    const source = { path: filePath, project: 'p', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
    return calls
  }

  it('discovers a JetBrains chat.jsonl under the jb dir', async () => {
    const filePath = await writeJbSession('ws-abc', [jbUser('hello'), jbAssistant({ messageId: 'm1', text: 'hi', outputTokens: 10 })])
    const provider = createCopilotProvider('/nonexistent/legacy', '/nonexistent/vscode', tmpDir)
    const sources = await provider.discoverSessions()
    expect(sources.some(s => s.path === filePath && s.provider === 'copilot')).toBe(true)
  })

  it('parses a JetBrains session into a call with the inferred model and user message', async () => {
    const filePath = await writeJbSession('ws-abc', [
      jbUser('implement the feature'),
      jbTurnStart('t1'),
      jbToolStart('read_file', 'toolu_vrtx_x'),
      jbAssistant({ messageId: 'm1', text: 'done', outputTokens: 42 }),
    ])
    const calls = await parse(filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe('copilot')
    expect(calls[0]!.model).toBe('copilot-anthropic-auto') // toolu_ prefix -> Anthropic
    expect(calls[0]!.outputTokens).toBe(42)
    expect(calls[0]!.userMessage).toBe('implement the feature')
    expect(calls[0]!.tools).toEqual(['Read'])
    expect(calls[0]!.deduplicationKey.startsWith('copilot:jb:')).toBe(true)
  })

  it('does NOT route a legacy file (first line user.message) to the JetBrains parser', async () => {
    // Regression guard: isJetBrainsFormat must not match bare user.message.
    const filePath = await writeJbSession('ws-legacy', [
      JSON.stringify({ type: 'user.message', data: { content: 'hi' } }),
      JSON.stringify({ type: 'session.model_change', data: { newModel: 'gpt-4.1' } }),
      JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', outputTokens: 5 } }),
    ])
    const calls = await parse(filePath)
    // Parsed by the legacy parser -> legacy dedup key, not a jb one.
    expect(calls.every(c => !c.deduplicationKey.startsWith('copilot:jb:'))).toBe(true)
  })

  it('does not collapse id-less assistant messages (dedup fallback)', async () => {
    const filePath = await writeJbSession('ws-noid', [
      jbUser('q1'),
      jbAssistant({ text: 'a1', outputTokens: 5 }),
      jbAssistant({ text: 'a2', outputTokens: 6 }),
    ])
    const calls = await parse(filePath)
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map(c => c.deduplicationKey)).size).toBe(2)
  })
})
