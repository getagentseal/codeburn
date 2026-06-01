import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { kiro, createKiroProvider } from '../../src/providers/kiro.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

function makeChatFile(opts: {
  executionId?: string
  modelId?: string
  workflowId?: string
  startTime?: number
  endTime?: number
  userPrompt?: string
  botResponses?: string[]
}) {
  const chat = [
    { role: 'human', content: '<identity>\nYou are Kiro.\n</identity>' },
    { role: 'bot', content: '' },
    { role: 'tool', content: 'workspace tree...' },
    { role: 'bot', content: 'I will follow these instructions.' },
  ]

  if (opts.userPrompt) {
    chat.push({ role: 'human', content: opts.userPrompt })
  }

  for (const resp of opts.botResponses ?? ['Done.']) {
    chat.push({ role: 'bot', content: resp })
  }

  return JSON.stringify({
    executionId: opts.executionId ?? 'exec-001',
    actionId: 'act',
    context: [],
    validations: {},
    chat,
    metadata: {
      modelId: opts.modelId ?? 'claude-haiku-4-5',
      modelProvider: 'qdev',
      workflow: 'act',
      workflowId: opts.workflowId ?? 'wf-001',
      startTime: opts.startTime ?? 1777333000000,
      endTime: opts.endTime ?? 1777333010000,
    },
  })
}

function makeModernExecutionFile(opts: {
  executionId?: string
  sessionId?: string
  modelId?: string
  startTime?: number | string
  userPrompt?: string
  assistantResponse?: string
}) {
  const startTime = opts.startTime ?? 1777333000000
  return JSON.stringify({
    executionId: opts.executionId ?? 'exec-modern-001',
    sessionId: opts.sessionId ?? 'session-modern-001',
    workflowType: 'chat-agent',
    status: 'succeed',
    startTime,
    endTime: typeof startTime === 'number' ? startTime + 10000 : 1777333010000,
    modelId: opts.modelId ?? 'claude-sonnet-4.5',
    messages: [
      { role: 'user', content: opts.userPrompt ?? 'explain the new kiro storage layout' },
      {
        role: 'assistant',
        content: opts.assistantResponse ?? 'Done. <tool_use><name>runCommand</name></tool_use>',
        toolCalls: [{ name: 'readFile' }],
      },
    ],
  })
}

describe('kiro provider - chat file parsing', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kiro-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('parses a basic chat file', async () => {
    const wsHash = 'a'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'abc123.chat')
    await writeFile(chatPath, makeChatFile({
      modelId: 'claude-haiku-4-5',
      userPrompt: 'explain the code',
      botResponses: ['Here is an explanation of the code structure.'],
    }))

    const source = { path: chatPath, project: 'myproject', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('kiro')
    expect(call.model).toBe('claude-haiku-4-5')
    expect(call.outputTokens).toBeGreaterThan(0)
    expect(call.userMessage).toBe('explain the code')
    expect(call.bashCommands).toEqual([])
    expect(call.costUSD).toBeGreaterThan(0)
  })

  it('stores kiro-auto when model is auto', async () => {
    const wsHash = 'b'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'abc.chat')
    await writeFile(chatPath, makeChatFile({
      modelId: 'auto',
      botResponses: ['some output'],
    }))

    const source = { path: chatPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('kiro-auto')
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('skips chat files with no bot output', async () => {
    const wsHash = 'c'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'empty.chat')
    await writeFile(chatPath, JSON.stringify({
      executionId: 'exec-empty',
      actionId: 'act',
      context: [],
      validations: {},
      chat: [
        { role: 'human', content: '<identity>\nYou are Kiro.\n</identity>' },
        { role: 'bot', content: '' },
        { role: 'human', content: 'do something' },
        { role: 'bot', content: '' },
      ],
      metadata: {
        modelId: 'claude-haiku-4-5',
        modelProvider: 'qdev',
        workflow: 'act',
        workflowId: 'wf-empty',
        startTime: 1777333000000,
        endTime: 1777333010000,
      },
    }))

    const source = { path: chatPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(0)
  })

  it('deduplicates across parser runs', async () => {
    const wsHash = 'd'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'dup.chat')
    await writeFile(chatPath, makeChatFile({ botResponses: ['hello'] }))

    const source = { path: chatPath, project: 'test', provider: 'kiro' }
    const seenKeys = new Set<string>()

    const calls1: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, seenKeys).parse()) calls1.push(call)

    const calls2: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, seenKeys).parse()) calls2.push(call)

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(0)
  })

  it('returns empty for missing file', async () => {
    const source = { path: '/nonexistent/test.chat', project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)
    expect(calls).toHaveLength(0)
  })

  it('returns empty for invalid JSON', async () => {
    const wsHash = 'e'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'bad.chat')
    await writeFile(chatPath, 'not json at all')

    const source = { path: chatPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)
    expect(calls).toHaveLength(0)
  })

  it('estimates tokens from text length', async () => {
    const wsHash = 'f'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'tokens.chat')
    const longResponse = 'x'.repeat(400)
    await writeFile(chatPath, makeChatFile({ botResponses: [longResponse] }))

    const source = { path: chatPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBe(109)
  })

  it('normalizes dot-versioned model IDs to dashes', async () => {
    const wsHash = 'h'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'dot.chat')
    await writeFile(chatPath, makeChatFile({
      modelId: 'claude-haiku-4.5',
      botResponses: ['response text here'],
    }))

    const source = { path: chatPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('claude-haiku-4-5')
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('uses workflowId as sessionId', async () => {
    const wsHash = 'g'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'sess.chat')
    await writeFile(chatPath, makeChatFile({
      workflowId: 'my-workflow-id',
      botResponses: ['ok'],
    }))

    const source = { path: chatPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('my-workflow-id')
  })

  it('parses a post-February extensionless execution file', async () => {
    const wsHash = 'i'.repeat(32)
    const sessionHash = 'session-modern'
    const wsDir = join(tmpDir, wsHash, sessionHash)
    await mkdir(wsDir, { recursive: true })
    const executionPath = join(wsDir, 'execution-modern')
    await writeFile(executionPath, makeModernExecutionFile({
      executionId: 'exec-modern',
      sessionId: 'session-modern',
      modelId: 'claude-sonnet-4.5',
      userPrompt: 'summarize this workspace',
      assistantResponse: 'I reviewed it. <tool_use><name>runCommand</name></tool_use>',
    }))

    const source = { path: executionPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('kiro')
    expect(call.model).toBe('claude-sonnet-4-5')
    expect(call.sessionId).toBe('session-modern')
    expect(call.userMessage).toBe('summarize this workspace')
    expect(call.inputTokens).toBeGreaterThan(0)
    expect(call.outputTokens).toBeGreaterThan(0)
    expect(call.tools).toEqual(['Bash', 'Read'])
    expect(call.costUSD).toBeGreaterThan(0)
  })

  it('skips session index files without conversation content', async () => {
    const wsHash = 'j'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const indexPath = join(wsDir, 'session-index')
    await writeFile(indexPath, JSON.stringify({
      executions: [{
        executionId: 'exec-indexed',
        type: 'chat-agent',
        status: 'succeed',
        startTime: 1777333000000,
        endTime: 1777333010000,
      }],
    }))

    const source = { path: indexPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(0)
  })

  it('parses direct prompt and response fields from modern execution files', async () => {
    const wsHash = 'k'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const executionPath = join(wsDir, 'execution-direct')
    await writeFile(executionPath, JSON.stringify({
      executionId: 'exec-direct',
      workflowType: 'chat-agent',
      status: 'succeed',
      startTime: 1777333000000,
      model: { id: 'auto' },
      prompt: 'make a small change',
      response: 'Changed it. <tool_use><name>writeFile</name></tool_use>',
    }))

    const source = { path: executionPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('kiro-auto')
    expect(calls[0]!.userMessage).toBe('make a small change')
    expect(calls[0]!.tools).toEqual(['Edit'])
  })

  it('accepts second-based modern timestamps', async () => {
    const wsHash = 'n'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const executionPath = join(wsDir, 'execution-seconds')
    await writeFile(executionPath, makeModernExecutionFile({
      executionId: 'exec-seconds',
      startTime: 1777333000,
    }))

    const source = { path: executionPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.timestamp).toBe('2026-04-27T23:36:40.000Z')
  })

  it('accepts numeric-string modern timestamps', async () => {
    const wsHash = 'o'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const executionPath = join(wsDir, 'execution-string-time')
    await writeFile(executionPath, makeModernExecutionFile({
      executionId: 'exec-string-time',
      startTime: '1777333000000',
    }))

    const source = { path: executionPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.timestamp).toBe('2026-04-27T23:36:40.000Z')
  })

  it('does not poison dedup keys when a modern execution has an invalid timestamp', async () => {
    const wsHash = 'p'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const invalidPath = join(wsDir, 'execution-invalid-time')
    const validPath = join(wsDir, 'execution-valid-time')
    const shared = {
      executionId: 'exec-recovered',
      sessionId: 'session-recovered',
    }
    await writeFile(invalidPath, makeModernExecutionFile({
      ...shared,
      startTime: 'not-a-timestamp',
    }))
    await writeFile(validPath, makeModernExecutionFile({
      ...shared,
      startTime: 1777333000000,
    }))

    const seenKeys = new Set<string>()
    const invalidCalls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser({ path: invalidPath, project: 'test', provider: 'kiro' }, seenKeys).parse()) {
      invalidCalls.push(call)
    }
    const validCalls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser({ path: validPath, project: 'test', provider: 'kiro' }, seenKeys).parse()) {
      validCalls.push(call)
    }

    expect(invalidCalls).toHaveLength(0)
    expect(validCalls).toHaveLength(1)
  })

  it.each(['conversation', 'chat', 'transcript', 'entries', 'events'])('parses modern execution conversation arrays from %s', async (key) => {
    const wsHash = 'q'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const executionPath = join(wsDir, `execution-${key}`)
    await writeFile(executionPath, JSON.stringify({
      executionId: `exec-${key}`,
      workflowType: 'chat-agent',
      status: 'succeed',
      startTime: 1777333000000,
      modelId: 'claude-sonnet-4.5',
      [key]: [
        { role: 'user', content: `request from ${key}` },
        { role: 'assistant', content: `response from ${key}`, toolCalls: [{ name: 'readFile' }] },
      ],
    }))

    const source = { path: executionPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe(`request from ${key}`)
    expect(calls[0]!.tools).toEqual(['Read'])
  })

  it('keeps modern executions with structured assistant tool calls and no assistant text', async () => {
    const wsHash = 'l'.repeat(32)
    const wsDir = join(tmpDir, wsHash, 'session-tools')
    await mkdir(wsDir, { recursive: true })
    const executionPath = join(wsDir, 'execution-tools')
    await writeFile(executionPath, JSON.stringify({
      executionId: 'exec-tools',
      sessionId: 'session-tools',
      workflowType: 'chat-agent',
      status: 'succeed',
      startTime: 1777333000000,
      modelId: 'claude-sonnet-4.5',
      messages: [
        { role: 'user', content: 'run the test suite' },
        { role: 'assistant', toolCalls: [{ name: 'runCommand' }] },
      ],
    }))

    const source = { path: executionPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Bash'])
    expect(calls[0]!.inputTokens).toBeGreaterThan(0)
    expect(calls[0]!.outputTokens).toBe(0)
  })

  it('keeps direct modern executions with root tool calls and no response text', async () => {
    const wsHash = 'm'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    const executionPath = join(wsDir, 'execution-root-tools')
    await writeFile(executionPath, JSON.stringify({
      executionId: 'exec-root-tools',
      workflowType: 'chat-agent',
      status: 'succeed',
      startTime: 1777333000000,
      model: { id: 'auto' },
      name: 'workflow-name',
      prompt: 'edit a file',
      toolCalls: [{ name: 'writeFile' }],
    }))

    const source = { path: executionPath, project: 'test', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Edit'])
    expect(calls[0]!.tools).not.toContain('workflow-name')
    expect(calls[0]!.outputTokens).toBe(0)
  })
})

describe('kiro provider - discoverSessions', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kiro-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('discovers chat files from workspace hash directories', async () => {
    const wsHash = 'a1b2c3d4e5f6'.padEnd(32, '0')
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(wsDir, 'session1.chat'), makeChatFile({}))
    await writeFile(join(wsDir, 'session2.chat'), makeChatFile({}))

    const provider = createKiroProvider(tmpDir, '/nonexistent/ws', '/nonexistent/cli')
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(2)
    expect(sessions.every(s => s.provider === 'kiro')).toBe(true)
    expect(sessions.every(s => s.path.endsWith('.chat'))).toBe(true)
  })

  it('discovers extensionless session index files and nested execution files', async () => {
    const wsHash = 'd'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    const sessionDir = join(wsDir, 'session-dir')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(wsDir, 'session-index'), JSON.stringify({ executions: [] }))
    await writeFile(join(wsDir, 'legacy.chat'), makeChatFile({}))
    await writeFile(join(wsDir, 'ignored.json'), '{}')
    await writeFile(join(wsDir, '.DS_Store'), 'ignored')
    await writeFile(join(sessionDir, 'execution-1'), makeModernExecutionFile({}))
    await writeFile(join(sessionDir, '.hidden'), 'ignored')
    await writeFile(join(sessionDir, 'ignored.txt'), 'hello')

    const provider = createKiroProvider(tmpDir, '/nonexistent/ws', '/nonexistent/cli')
    const sessions = await provider.discoverSessions()
    const paths = sessions.map(s => s.path).sort()

    expect(paths).toEqual([
      join(sessionDir, 'execution-1'),
      join(wsDir, 'legacy.chat'),
      join(wsDir, 'session-index'),
    ].sort())
  })

  it('reads project name from workspace.json', async () => {
    const wsHash = 'b'.repeat(32)
    const agentWsDir = join(tmpDir, wsHash)
    await mkdir(agentWsDir, { recursive: true })
    await writeFile(join(agentWsDir, 'test.chat'), makeChatFile({}))

    const workspaceStorageDir = join(tmpDir, 'ws-storage')
    const wsStorageEntry = join(workspaceStorageDir, wsHash)
    await mkdir(wsStorageEntry, { recursive: true })
    await writeFile(join(wsStorageEntry, 'workspace.json'), JSON.stringify({ folder: 'file:///home/user/myapp' }))

    const provider = createKiroProvider(tmpDir, workspaceStorageDir, '/nonexistent/cli')
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myapp')
  })

  it('returns empty when directory does not exist', async () => {
    const provider = createKiroProvider('/nonexistent/agent', '/nonexistent/ws', '/nonexistent/cli')
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('skips non-32-char directories', async () => {
    const shortDir = join(tmpDir, 'short')
    await mkdir(shortDir, { recursive: true })
    await writeFile(join(shortDir, 'test.chat'), makeChatFile({}))

    const provider = createKiroProvider(tmpDir, '/nonexistent/ws', '/nonexistent/cli')
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('skips files with unsupported extensions', async () => {
    const wsHash = 'c'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(wsDir, 'index.json'), '{}')
    await writeFile(join(wsDir, 'notes.txt'), 'hello')

    const provider = createKiroProvider(tmpDir, '/nonexistent/ws', '/nonexistent/cli')
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })
})

describe('kiro provider - metadata', () => {
  it('has correct name and displayName', () => {
    expect(kiro.name).toBe('kiro')
    expect(kiro.displayName).toBe('Kiro')
  })

  it('normalizes model display names', () => {
    expect(kiro.modelDisplayName('claude-haiku-4-5')).toBe('Haiku 4.5')
    expect(kiro.modelDisplayName('claude-sonnet-4-5')).toBe('Sonnet 4.5')
    expect(kiro.modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(kiro.modelDisplayName('unknown-model')).toBe('unknown-model')
  })

  it('normalizes tool display names', () => {
    expect(kiro.toolDisplayName('readFile')).toBe('Read')
    expect(kiro.toolDisplayName('writeFile')).toBe('Edit')
    expect(kiro.toolDisplayName('runCommand')).toBe('Bash')
    expect(kiro.toolDisplayName('searchFiles')).toBe('Grep')
    expect(kiro.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })

  it('longest-prefix match for versioned model IDs', () => {
    expect(kiro.modelDisplayName('claude-sonnet-4-5-20260101')).toBe('Sonnet 4.5')
    expect(kiro.modelDisplayName('claude-haiku-4-5-20260101')).toBe('Haiku 4.5')
  })
})

describe('kiro provider - CLI session parsing', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kiro-cli-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  function makeCliSessionMeta(opts: {
    sessionId?: string
    cwd?: string
    createdAt?: string
    modelId?: string
  }) {
    return JSON.stringify({
      session_id: opts.sessionId ?? 'cli-session-001',
      cwd: opts.cwd ?? '/home/user/myproject',
      created_at: opts.createdAt ?? '2026-05-20T14:00:00.000Z',
      updated_at: '2026-05-20T15:00:00.000Z',
      title: 'Test session',
      session_state: {
        rts_model_state: {
          model_info: { model_id: opts.modelId ?? 'auto' },
        },
      },
    })
  }

  function makeCliSessionJsonl(messages: Array<{ kind: string; content?: Array<{ kind: string; data?: unknown }> }>) {
    return messages.map(m => JSON.stringify({
      version: 'v1',
      kind: m.kind,
      data: { message_id: 'msg-' + Math.random().toString(36).slice(2), content: m.content ?? [] },
    })).join('\n')
  }

  it('parses a basic CLI JSONL session', async () => {
    const sessionId = 'cli-basic-001'
    await writeFile(join(tmpDir, `${sessionId}.json`), makeCliSessionMeta({ sessionId }))
    await writeFile(join(tmpDir, `${sessionId}.jsonl`), makeCliSessionJsonl([
      { kind: 'Prompt', content: [{ kind: 'text', data: 'explain the code' }] },
      { kind: 'AssistantMessage', content: [{ kind: 'text', data: 'Here is an explanation of the code.' }] },
    ]))

    const provider = createKiroProvider('/nonexistent/agent', '/nonexistent/ws', tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myproject')

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe('kiro')
    expect(calls[0]!.model).toBe('kiro-auto')
    expect(calls[0]!.userMessage).toBe('explain the code')
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
    expect(calls[0]!.timestamp).toBe('2026-05-20T14:00:00.000Z')
  })

  it('detects built-in tools', async () => {
    const sessionId = 'cli-tools-001'
    await writeFile(join(tmpDir, `${sessionId}.json`), makeCliSessionMeta({ sessionId }))
    await writeFile(join(tmpDir, `${sessionId}.jsonl`), makeCliSessionJsonl([
      { kind: 'Prompt', content: [{ kind: 'text', data: 'read the file' }] },
      { kind: 'AssistantMessage', content: [
        { kind: 'text', data: 'Reading...' },
        { kind: 'toolUse', data: { name: 'read', toolUseId: 't1', input: {} } },
      ] },
      { kind: 'AssistantMessage', content: [
        { kind: 'text', data: 'Done.' },
        { kind: 'toolUse', data: { name: 'shell', toolUseId: 't2', input: {} } },
      ] },
    ]))

    const provider = createKiroProvider('/nonexistent/agent', '/nonexistent/ws', tmpDir)
    const sessions = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toContain('Read')
    expect(calls[0]!.tools).toContain('Bash')
  })

  it('detects MCP tools with mcp__ prefix', async () => {
    const sessionId = 'cli-mcp-001'
    await writeFile(join(tmpDir, `${sessionId}.json`), makeCliSessionMeta({ sessionId }))
    await writeFile(join(tmpDir, `${sessionId}.jsonl`), makeCliSessionJsonl([
      { kind: 'Prompt', content: [{ kind: 'text', data: 'search jira' }] },
      { kind: 'AssistantMessage', content: [
        { kind: 'text', data: 'Searching...' },
        { kind: 'toolUse', data: { name: 'searchJiraIssuesUsingJql', toolUseId: 't1', input: {} } },
      ] },
    ]))

    const provider = createKiroProvider('/nonexistent/agent', '/nonexistent/ws', tmpDir)
    const sessions = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools.some(t => t.startsWith('mcp__'))).toBe(true)
    expect(calls[0]!.tools.some(t => t.includes('searchJiraIssuesUsingJql'))).toBe(true)
  })

  it('skips empty JSONL files', async () => {
    const sessionId = 'cli-empty-001'
    await writeFile(join(tmpDir, `${sessionId}.json`), makeCliSessionMeta({ sessionId }))
    await writeFile(join(tmpDir, `${sessionId}.jsonl`), '')

    const provider = createKiroProvider('/nonexistent/agent', '/nonexistent/ws', tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0) // stat.size === 0 is skipped
  })

  it('deduplicates CLI sessions', async () => {
    const sessionId = 'cli-dedup-001'
    await writeFile(join(tmpDir, `${sessionId}.json`), makeCliSessionMeta({ sessionId }))
    await writeFile(join(tmpDir, `${sessionId}.jsonl`), makeCliSessionJsonl([
      { kind: 'Prompt', content: [{ kind: 'text', data: 'hello' }] },
      { kind: 'AssistantMessage', content: [{ kind: 'text', data: 'hi there' }] },
    ]))

    const provider = createKiroProvider('/nonexistent/agent', '/nonexistent/ws', tmpDir)
    const sessions = await provider.discoverSessions()
    const seenKeys = new Set<string>()

    const calls1: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, seenKeys).parse()) calls1.push(call)
    const calls2: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, seenKeys).parse()) calls2.push(call)

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(0)
  })

  it('uses cwd basename as project name', async () => {
    const sessionId = 'cli-project-001'
    await writeFile(join(tmpDir, `${sessionId}.json`), makeCliSessionMeta({
      sessionId,
      cwd: '/home/user/workspace/my-cool-app',
    }))
    await writeFile(join(tmpDir, `${sessionId}.jsonl`), makeCliSessionJsonl([
      { kind: 'Prompt', content: [{ kind: 'text', data: 'test' }] },
      { kind: 'AssistantMessage', content: [{ kind: 'text', data: 'ok' }] },
    ]))

    const provider = createKiroProvider('/nonexistent/agent', '/nonexistent/ws', tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions[0]!.project).toBe('my-cool-app')
  })
})
