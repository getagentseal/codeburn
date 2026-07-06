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

    const provider = createKiroProvider(tmpDir, '/nonexistent/ws')
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

    const provider = createKiroProvider(tmpDir, '/nonexistent/ws')
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

    const provider = createKiroProvider(tmpDir, workspaceStorageDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myapp')
  })

  it('returns empty when directory does not exist', async () => {
    const provider = createKiroProvider('/nonexistent/agent', '/nonexistent/ws')
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('skips non-32-char directories', async () => {
    const shortDir = join(tmpDir, 'short')
    await mkdir(shortDir, { recursive: true })
    await writeFile(join(shortDir, 'test.chat'), makeChatFile({}))

    const provider = createKiroProvider(tmpDir, '/nonexistent/ws')
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('skips files with unsupported extensions', async () => {
    const wsHash = 'c'.repeat(32)
    const wsDir = join(tmpDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(wsDir, 'index.json'), '{}')
    await writeFile(join(wsDir, 'notes.txt'), 'hello')

    const provider = createKiroProvider(tmpDir, '/nonexistent/ws')
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

describe('kiro provider - CLI session discovery', () => {
  let cliDir: string

  beforeEach(async () => {
    cliDir = await mkdtemp(join(tmpdir(), 'kiro-cli-test-'))
  })

  afterEach(async () => {
    await rm(cliDir, { recursive: true, force: true })
  })

  it('discovers .jsonl files from CLI sessions directory', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111'
    await writeFile(join(cliDir, `${sessionId}.jsonl`), '')
    await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({
      session_id: sessionId,
      cwd: '/home/user/my-project',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
    }))

    const provider = createKiroProvider('/nonexistent', '/nonexistent', cliDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('my-project')
    expect(sessions[0]!.path).toContain('.jsonl')
    expect(sessions[0]!.provider).toBe('kiro')
  })

  it('parses CLI session JSONL into calls', async () => {
    const sessionId = '22222222-2222-2222-2222-222222222222'
    const jsonl = [
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm1', content: [{ kind: 'text', data: 'hello world' }], meta: { timestamp: 1700000000 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm2', content: [{ kind: 'text', data: 'Hello! How can I help you today?' }, { kind: 'toolUse', data: { toolUseId: 't1', name: 'read', input: {} } }] } }),
      JSON.stringify({ version: '1', kind: 'ToolResults', data: { message_id: 'm3', content: [{ kind: 'text', data: 'file contents here' }], results: { t1: { output: 'ok' } } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm4', content: [{ kind: 'text', data: 'I read the file for you.' }] } }),
    ].join('\n')

    await writeFile(join(cliDir, `${sessionId}.jsonl`), jsonl)
    await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({
      session_id: sessionId,
      cwd: '/tmp/test-project',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
      session_state: {
        rts_model_state: { model_info: { model_id: 'auto' } },
        conversation_metadata: {
          user_turn_metadatas: [{
            end_timestamp: '2026-01-01T00:00:30Z',
            metering_usage: [{ value: 0.05, unit: 'credit' }, { value: 0.08, unit: 'credit' }],
          }],
        },
      },
    }))

    const source = { path: join(cliDir, `${sessionId}.jsonl`), project: 'test-project', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('kiro')
    expect(call.model).toBe('kiro-auto')
    expect(call.tools).toContain('Read')
    expect(call.userMessage).toBe('hello world')
    expect(call.costUSD).toBeCloseTo(0.13, 2)
    expect(call.deduplicationKey).toBe(`kiro-cli:${sessionId}:0`)
    expect(call.timestamp).toBe('2026-01-01T00:00:30.000Z')
    expect(call.project).toBe('test-project')
  })

  it('parses multiple turns from a CLI session', async () => {
    const sessionId = '33333333-3333-3333-3333-333333333333'
    const jsonl = [
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm1', content: [{ kind: 'text', data: 'first question' }], meta: { timestamp: 1700000000 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm2', content: [{ kind: 'text', data: 'first answer' }] } }),
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm3', content: [{ kind: 'text', data: 'second question' }], meta: { timestamp: 1700000060 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm4', content: [{ kind: 'text', data: 'second answer' }] } }),
    ].join('\n')

    await writeFile(join(cliDir, `${sessionId}.jsonl`), jsonl)
    await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({
      session_id: sessionId,
      cwd: '/tmp/multi',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:02:00Z',
      session_state: {
        rts_model_state: { model_info: { model_id: 'claude-sonnet-4' } },
        conversation_metadata: {
          user_turn_metadatas: [
            { end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [{ value: 0.04, unit: 'credit' }] },
            { end_timestamp: '2026-01-01T00:01:30Z', metering_usage: [{ value: 0.06, unit: 'credit' }] },
          ],
        },
      },
    }))

    const source = { path: join(cliDir, `${sessionId}.jsonl`), project: 'multi', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('first question')
    expect(calls[0]!.model).toBe('claude-sonnet-4')
    expect(calls[1]!.userMessage).toBe('second question')
    expect(calls[1]!.costUSD).toBeCloseTo(0.06, 2)
  })

  it('skips non-jsonl files in CLI directory', async () => {
    await writeFile(join(cliDir, 'something.json'), '{}')
    await writeFile(join(cliDir, 'something.lock'), '')

    const provider = createKiroProvider('/nonexistent', '/nonexistent', cliDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })
})

describe('kiro provider - context.messages with entries', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kiro-ctx-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('parses context.messages using entries field', async () => {
    // Simulates the real Kiro IDE format where messages use "entries" not "content"
    const file = JSON.stringify({
      executionId: 'exec-ctx-001',
      workflowType: 'chat-agent',
      status: 'succeed',
      startTime: 1777333000000,
      chatSessionId: 'session-ctx-001',
      context: {
        messages: [
          { role: 'human', entries: ['What is the meaning of life?'] },
          { role: 'bot', entries: ['The meaning of life is 42, according to Douglas Adams.'] },
          { role: 'human', entries: ['Tell me more'] },
          { role: 'bot', entries: ['The answer comes from The Hitchhiker\'s Guide to the Galaxy.'] },
        ],
      },
    })

    const wsHash = 'a'.repeat(32)
    const subDir = 'b'.repeat(32)
    await mkdir(join(tmpDir, wsHash, subDir), { recursive: true })
    await writeFile(join(tmpDir, wsHash, subDir, 'exec-ctx-001'), file)

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent')
    const sessions = await provider.discoverSessions()
    expect(sessions.length).toBeGreaterThan(0)

    const calls: ParsedProviderCall[] = []
    for (const source of sessions) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) {
        calls.push(call)
      }
    }

    expect(calls.length).toBeGreaterThan(0)
    const call = calls[0]!
    expect(call.inputTokens).toBeGreaterThan(0)
    expect(call.outputTokens).toBeGreaterThan(0)
    expect(call.sessionId).toBe('session-ctx-001')
  })

  it('extracts tools from usageSummary', async () => {
    const file = JSON.stringify({
      executionId: 'exec-tools-001',
      workflowType: 'chat-agent',
      status: 'succeed',
      startTime: 1777333000000,
      chatSessionId: 'session-tools-001',
      context: {
        messages: [
          { role: 'human', entries: ['Search for accounts'] },
          { role: 'bot', entries: ['Found 5 accounts.'] },
        ],
      },
      usageSummary: [
        { usedTools: ['mcp_aws_sentral_mcp_search_accounts'], usage: 0.5, unit: 'credit' },
        { usedTools: ['executeBash', 'readFile'], usage: 1.0, unit: 'credit' },
      ],
    })

    const wsHash = 'c'.repeat(32)
    const subDir = 'd'.repeat(32)
    await mkdir(join(tmpDir, wsHash, subDir), { recursive: true })
    await writeFile(join(tmpDir, wsHash, subDir, 'exec-tools-001'), file)

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent')
    const sessions = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for (const source of sessions) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) {
        calls.push(call)
      }
    }

    expect(calls.length).toBeGreaterThan(0)
    const call = calls[0]!
    expect(call.tools).toContain('aws_sentral_mcp_search_accounts')
    expect(call.tools).toContain('Bash')
    expect(call.tools).toContain('Read')
  })

  it('skips execution index files with executions array', async () => {
    // The session index file has {executions: [...], version: 2}
    const indexFile = JSON.stringify({
      executions: [
        { executionId: 'exec-001', type: 'chat-agent', status: 'succeed', startTime: 1777333000000 },
      ],
      version: 2,
    })

    const wsHash = 'e'.repeat(32)
    await mkdir(join(tmpDir, wsHash), { recursive: true })
    await writeFile(join(tmpDir, wsHash, 'f'.repeat(32)), indexFile)

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent')
    const sessions = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for (const source of sessions) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) {
        calls.push(call)
      }
    }

    expect(calls).toHaveLength(0)
  })
})

describe('kiro provider - workspace-sessions format', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kiro-wss-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('discovers and parses workspace-sessions files', async () => {
    // Create workspace-sessions/<base64>/<sessionId>.json
    const wsSessionsDir = join(tmpDir, 'workspace-sessions', 'L3RtcC90ZXN0')
    await mkdir(wsSessionsDir, { recursive: true })

    const sessionFile = JSON.stringify({
      sessionId: 'ws-session-001',
      title: 'Test session',
      selectedModel: 'claude-opus-4.8',
      workspaceDirectory: '/tmp/test',
      history: [
        { message: { role: 'user', content: [{ type: 'text', text: 'What is TypeScript?' }] } },
        { message: { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' } },
        { message: { role: 'user', content: [{ type: 'text', text: 'How do I use generics?' }] } },
        { message: { role: 'assistant', content: 'Generics allow you to create reusable components.' } },
      ],
    })

    await writeFile(join(wsSessionsDir, 'ws-session-001.json'), sessionFile)
    // Also need sessions.json (should be skipped)
    await writeFile(join(wsSessionsDir, 'sessions.json'), '[]')

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent')
    const sessions = await provider.discoverSessions()

    const wsSessions = sessions.filter(s => s.path.includes('workspace-sessions'))
    expect(wsSessions).toHaveLength(1)
    expect(wsSessions[0]!.path).toContain('ws-session-001.json')

    const calls: ParsedProviderCall[] = []
    for (const source of wsSessions) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) {
        calls.push(call)
      }
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.model).toBe('claude-opus-4-8')
    expect(call.sessionId).toBe('ws-session-001')
    expect(call.inputTokens).toBeGreaterThan(0)
    expect(call.outputTokens).toBeGreaterThan(0)
    expect(call.deduplicationKey).toBe('kiro:ws-session:ws-session-001')
  })

  it('skips workspace-sessions with only stub assistant replies referencing execution files', async () => {
    const wsSessionsDir = join(tmpDir, 'workspace-sessions', 'L3RtcC90ZXN0')
    await mkdir(wsSessionsDir, { recursive: true })

    // Session where assistant only says "On it." with executionId refs
    // (real output is in execution files — skip to avoid double-counting)
    const sessionFile = JSON.stringify({
      sessionId: 'ws-session-stub',
      selectedModel: 'auto',
      workspaceDirectory: '/tmp/test',
      history: [
        { message: { role: 'user', content: [{ type: 'text', text: 'Deploy the stack' }] } },
        { message: { role: 'assistant', content: 'On it.' }, executionId: 'exec-ref-001' },
      ],
    })

    await writeFile(join(wsSessionsDir, 'ws-session-stub.json'), sessionFile)

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent')
    const sessions = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for (const source of sessions) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) {
        calls.push(call)
      }
    }

    // Should be skipped: has executionId refs but no real assistant content
    expect(calls).toHaveLength(0)
  })

  it('skips sessions.json file in workspace-sessions', async () => {
    const wsSessionsDir = join(tmpDir, 'workspace-sessions', 'L3RtcC90ZXN0')
    await mkdir(wsSessionsDir, { recursive: true })
    await writeFile(join(wsSessionsDir, 'sessions.json'), '[]')

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent')
    const sessions = await provider.discoverSessions()
    const wsSessions = sessions.filter(s => s.path.includes('workspace-sessions'))
    expect(wsSessions).toHaveLength(0)
  })
})
