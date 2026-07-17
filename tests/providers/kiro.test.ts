import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

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

  it('normalizes CLI-specific tool names', () => {
    expect(kiro.toolDisplayName('code')).toBe('Read')
    expect(kiro.toolDisplayName('subagent')).toBe('Agent')
    expect(kiro.toolDisplayName('web_fetch')).toBe('WebFetch')
  })

  it('passes through MCP tool names unchanged', () => {
    expect(kiro.toolDisplayName('mcp__server__searchJira')).toBe('mcp__server__searchJira')
    expect(kiro.toolDisplayName('mcp__atlassian__getIssue')).toBe('mcp__atlassian__getIssue')
  })

  it('longest-prefix match for versioned model IDs', () => {
    expect(kiro.modelDisplayName('claude-sonnet-4-5-20260101')).toBe('Sonnet 4.5')
    expect(kiro.modelDisplayName('claude-haiku-4-5-20260101')).toBe('Haiku 4.5')
  })
})

describe('kiro provider - CLI session discovery', () => {
  let cliRoot: string
  let cliDir: string

  beforeEach(async () => {
    // cliDir sits at <root>/cli so v2 discovery derives <root> (not the system tmpdir).
    cliRoot = await mkdtemp(join(tmpdir(), 'kiro-cli-test-'))
    cliDir = join(cliRoot, 'cli')
    await mkdir(cliDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(cliRoot, { recursive: true, force: true })
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
    expect(call.costUSD).toBeCloseTo(0.13 * 0.04, 4) // 0.13 credits × $0.04/credit
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
    expect(calls[1]!.costUSD).toBeCloseTo(0.06 * 0.04, 4) // 0.06 credits × $0.04/credit
  })

  it('falls back to token-estimated cost for CLI turns without metering_usage', async () => {
    const sessionId = '44444444-4444-4444-4444-444444444444'
    const jsonl = [
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm1', content: [{ kind: 'text', data: 'hi' }], meta: { timestamp: 1700000000 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm2', content: [{ kind: 'text', data: 'x'.repeat(4000) }] } }),
    ].join('\n')

    await writeFile(join(cliDir, `${sessionId}.jsonl`), jsonl)
    await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({
      session_id: sessionId,
      cwd: '/tmp/test-project',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
      session_state: {
        rts_model_state: { model_info: { model_id: 'claude-sonnet-4.6' } },
        // no conversation_metadata / metering_usage (e.g. turn still in flight)
      },
    }))

    const source = { path: join(cliDir, `${sessionId}.jsonl`), project: 'test-project', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    // Token-priced at the session's real model, not $0 — same fallback
    // contract as the v1-execution and v2 parsers.
    expect(calls[0]!.costIsEstimated).toBe(true)
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('treats an empty metering_usage array as no metering (token fallback, not frozen $0)', async () => {
    const sessionId = '55555555-5555-5555-5555-555555555555'
    const jsonl = [
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm1', content: [{ kind: 'text', data: 'hi' }], meta: { timestamp: 1700000000 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm2', content: [{ kind: 'text', data: 'x'.repeat(4000) }] } }),
    ].join('\n')

    await writeFile(join(cliDir, `${sessionId}.jsonl`), jsonl)
    await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({
      session_id: sessionId,
      cwd: '/tmp/test-project',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
      session_state: {
        rts_model_state: { model_info: { model_id: 'claude-sonnet-4.6' } },
        conversation_metadata: {
          // Observed in real sessions: the turn metadata exists but metering
          // hasn't landed yet — an empty array, which is truthy.
          user_turn_metadatas: [{ end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [] }],
        },
      },
    }))

    const source = { path: join(cliDir, `${sessionId}.jsonl`), project: 'test-project', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const call of kiro.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costIsEstimated).toBe(true)
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
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

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent/cli')
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

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent/cli')
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
    // usageSummary credits (0.5 + 1.0) price the execution at $0.04/credit
    expect(call.costUSD).toBeCloseTo(1.5 * 0.04, 8)
    expect(call.costIsEstimated).toBe(false)
  })

  it('falls back to token-estimated cost when a modern execution has no usageSummary credits', async () => {
    const file = JSON.stringify({
      executionId: 'exec-nocredits-001',
      workflowType: 'chat-agent',
      status: 'succeed',
      startTime: 1777333000000,
      chatSessionId: 'session-nocredits-001',
      modelId: 'claude-sonnet-4.6',
      context: {
        messages: [
          { role: 'human', entries: ['hello'] },
          { role: 'bot', entries: ['x'.repeat(4000)] },
        ],
      },
    })

    const wsHash = 'c'.repeat(32)
    const subDir = 'e'.repeat(32)
    await mkdir(join(tmpDir, wsHash, subDir), { recursive: true })
    await writeFile(join(tmpDir, wsHash, subDir, 'exec-nocredits-001'), file)

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent/cli')
    const sessions = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for (const source of sessions) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) {
        calls.push(call)
      }
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.costIsEstimated).toBe(true)
    expect(call.costUSD).toBeGreaterThan(0) // token-estimated at the real model
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

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent/cli')
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

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent/cli')
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

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent/cli')
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

    const provider = createKiroProvider(tmpDir, tmpDir, '/nonexistent/cli')
    const sessions = await provider.discoverSessions()
    const wsSessions = sessions.filter(s => s.path.includes('workspace-sessions'))
    expect(wsSessions).toHaveLength(0)
  })
})

type V2Turn = {
  exec: string
  ts: string
  user: string
  say?: string
  reasoning?: string
  tools?: string[]
  toolResults?: string[]
  credits?: number
}

function makeV2Messages(turns: V2Turn[]): string {
  const lines: string[] = []
  lines.push(JSON.stringify({ id: 'sess-start', timestamp: turns[0]?.ts ?? '2026-07-14T13:39:00.000Z', payload: { type: 'session_start', agentType: 'vibe' } }))
  for (const t of turns) {
    lines.push(JSON.stringify({ id: `${t.exec}-u`, timestamp: t.ts, payload: { type: 'user', content: t.user, images: [], documents: [] } }))
    lines.push(JSON.stringify({ id: `${t.exec}-ts`, timestamp: t.ts, payload: { type: 'turn_start', executionId: t.exec } }))
    if (t.reasoning) {
      lines.push(JSON.stringify({ id: `${t.exec}-r`, timestamp: t.ts, payload: { type: 'assistant', operationType: 'Reasoning', content: t.reasoning, executionId: t.exec } }))
    }
    lines.push(JSON.stringify({ id: `${t.exec}-a`, timestamp: t.ts, payload: { type: 'assistant', operationType: 'Say', content: t.say ?? 'Done.', executionId: t.exec } }))
    for (const tool of t.tools ?? []) {
      lines.push(JSON.stringify({ id: `${t.exec}-tc`, timestamp: t.ts, payload: { type: 'tool_call', toolName: tool, toolCallId: `${t.exec}-${tool}`, executionId: t.exec } }))
    }
    for (const [i, result] of (t.toolResults ?? []).entries()) {
      lines.push(JSON.stringify({ id: `${t.exec}-tr${i}`, timestamp: t.ts, payload: { type: 'tool_result', toolCallId: `${t.exec}-tr${i}`, content: result, success: true, executionId: t.exec } }))
    }
    lines.push(JSON.stringify({ id: `${t.exec}-cm`, timestamp: t.ts, payload: { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 12.5 }, executionId: t.exec } }))
    lines.push(JSON.stringify({ id: `${t.exec}-us`, timestamp: t.ts, payload: { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: t.credits ?? 1, usedTools: t.tools ?? [] }], status: 'success', executionId: t.exec } }))
    lines.push(JSON.stringify({ id: `${t.exec}-te`, timestamp: t.ts, payload: { type: 'turn_end', stopReason: 'end_turn', executionId: t.exec } }))
  }
  return lines.join('\n')
}

async function makeV2Session(sessionsRoot: string, opts: {
  wsHash?: string
  sessionId?: string
  modelId?: string
  workspacePaths?: string[]
  turns: V2Turn[]
}): Promise<string> {
  const wsHash = opts.wsHash ?? '4748323122002acb'
  const sessionId = opts.sessionId ?? 'sess_test-001'
  const sessDir = join(sessionsRoot, wsHash, sessionId)
  await mkdir(sessDir, { recursive: true })
  await writeFile(join(sessDir, 'session.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    dataModelVersion: 1,
    id: sessionId,
    title: 'Test v2 session',
    agentMode: 'vibe',
    workspacePaths: opts.workspacePaths ?? ['/tmp/test-proj'],
    modelId: opts.modelId ?? 'claude-opus-4.8',
    status: 'in_progress',
  }))
  await writeFile(join(sessDir, 'messages.jsonl'), makeV2Messages(opts.turns))
  return join(sessDir, 'messages.jsonl')
}

describe('kiro provider - v2 sess_ format', () => {
  let sessionsRoot: string

  beforeEach(async () => {
    sessionsRoot = await mkdtemp(join(tmpdir(), 'kiro-v2-'))
  })

  afterEach(async () => {
    await rm(sessionsRoot, { recursive: true, force: true })
  })

  it('discovers and parses a v2 session with the real model and project', async () => {
    await makeV2Session(sessionsRoot, {
      turns: [
        { exec: 'exec-1', ts: '2026-07-14T13:39:40.000Z', user: 'What is TypeScript?', say: 'TypeScript is a typed superset of JavaScript.', tools: ['readFile'] },
        { exec: 'exec-2', ts: '2026-07-14T13:41:00.000Z', user: 'Run the build', say: 'Building now.', tools: ['executeBash'] },
      ],
    })

    // cliDir override sits at <sessionsRoot>/cli, so v2 root = dirname(cliDir) = sessionsRoot.
    const provider = createKiroProvider('/nonexistent', '/nonexistent', join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const v2 = sources.filter(s => /\/sess_[^/]+\/messages\.jsonl$/.test(s.path))
    expect(v2).toHaveLength(1)
    expect(v2[0]!.project).toBe('test-proj')

    const calls: ParsedProviderCall[] = []
    for (const source of v2) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    }

    expect(calls).toHaveLength(2)
    const first = calls[0]!
    expect(first.provider).toBe('kiro')
    expect(first.model).toBe('claude-opus-4-8')
    expect(first.sessionId).toBe('sess_test-001')
    expect(first.inputTokens).toBeGreaterThan(0)
    expect(first.outputTokens).toBeGreaterThan(0)
    expect(first.tools).toEqual(['Read'])
    expect(first.userMessage).toBe('What is TypeScript?')
    expect(first.timestamp).toBe('2026-07-14T13:39:40.000Z')
    expect(first.deduplicationKey).toBe('kiro-v2:sess_test-001:exec-1')
    // Fixture turns carry usage_summary credits (default 1 credit), so cost is
    // metered: 1 credit × $0.04/credit, not token-estimated.
    expect(first.costIsEstimated).toBe(false)
    expect(first.costUSD).toBeCloseTo(0.04, 4)
    expect(calls[1]!.tools).toEqual(['Bash'])
  })

  it('prices turns from metered credits at $0.04/credit, falling back to token estimation without credits', async () => {
    await makeV2Session(sessionsRoot, {
      turns: [
        { exec: 'exec-c', ts: '2026-07-14T13:39:40.000Z', user: 'hi', say: 'metered answer', credits: 5.25 },
        // credits: 0 -> fixture emits usage_summary with usage 0 -> token fallback
        { exec: 'exec-e', ts: '2026-07-14T13:41:00.000Z', user: 'hi again', say: 'x'.repeat(4000), credits: 0 },
      ],
    })

    const provider = createKiroProvider('/nonexistent', '/nonexistent', join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    }

    expect(calls).toHaveLength(2)
    // Metered: 5.25 credits × $0.04 = $0.21, marked as real cost
    expect(calls[0]!.costUSD).toBeCloseTo(0.21, 4)
    expect(calls[0]!.costIsEstimated).toBe(false)
    // No credits: token-estimated at the session's real model, marked estimated
    expect(calls[1]!.costIsEstimated).toBe(true)
    expect(calls[1]!.costUSD).toBeGreaterThan(0)
  })

  it('counts tool_result content as input context, scoped to its own turn', async () => {
    await makeV2Session(sessionsRoot, {
      turns: [
        // Turn 1: 8-char prompt + 400 chars of tool results -> ceil(408/4) = 102
        { exec: 'exec-1', ts: '2026-07-14T13:39:40.000Z', user: 'x'.repeat(8), say: 'done', tools: ['readFile'], toolResults: ['r'.repeat(150), 's'.repeat(250)] },
        // Turn 2: 8-char prompt, no tool results -> ceil(8/4) = 2 (no leak from turn 1)
        { exec: 'exec-2', ts: '2026-07-14T13:41:00.000Z', user: 'y'.repeat(8), say: 'ok' },
      ],
    })

    const provider = createKiroProvider('/nonexistent', '/nonexistent', join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]!.inputTokens).toBe(102)
    expect(calls[1]!.inputTokens).toBe(2)
  })

  it('keeps reasoningTokens disjoint from outputTokens (no double-count in aggregation)', async () => {
    await makeV2Session(sessionsRoot, {
      turns: [
        { exec: 'exec-r', ts: '2026-07-14T13:39:40.000Z', user: 'hi', say: 'short', reasoning: 'x'.repeat(400) },
      ],
    })

    const provider = createKiroProvider('/nonexistent', '/nonexistent', join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.reasoningTokens).toBe(100) // 400 chars / 4
    // output holds only assistant text ('short' = 5 chars -> 2 tokens);
    // downstream aggregation sums outputTokens + reasoningTokens, so reasoning
    // must NOT be folded into outputTokens here.
    expect(call.outputTokens).toBe(2)
  })

  it('deduplicates v2 turns across parser runs', async () => {
    const msgs = await makeV2Session(sessionsRoot, {
      turns: [{ exec: 'exec-1', ts: '2026-07-14T13:39:40.000Z', user: 'hello', say: 'hi there' }],
    })
    const source = { path: msgs, project: 'test-proj', provider: 'kiro' }
    const seen = new Set<string>()

    const run1: ParsedProviderCall[] = []
    for await (const c of kiro.createSessionParser(source, seen).parse()) run1.push(c)
    const run2: ParsedProviderCall[] = []
    for await (const c of kiro.createSessionParser(source, seen).parse()) run2.push(c)

    expect(run1).toHaveLength(1)
    expect(run2).toHaveLength(0)
  })

  it('routes a sess_/messages.jsonl path to the v2 parser (not the CLI parser)', async () => {
    const msgs = await makeV2Session(sessionsRoot, {
      turns: [{ exec: 'exec-1', ts: '2026-07-14T13:39:40.000Z', user: 'hello', say: 'hi', tools: ['fsWrite'] }],
    })
    const source = { path: msgs, project: 'test-proj', provider: 'kiro' }
    const calls: ParsedProviderCall[] = []
    for await (const c of kiro.createSessionParser(source, new Set()).parse()) calls.push(c)

    expect(calls).toHaveLength(1)
    // A CLI-parser misroute would yield model 'kiro-auto' with no meta; v2 gives the real model.
    expect(calls[0]!.model).toBe('claude-opus-4-8')
    expect(calls[0]!.tools).toEqual(['Edit'])
  })

  it('maps a bare-homedir workspace to a generic project label', async () => {
    await makeV2Session(sessionsRoot, {
      workspacePaths: [homedir()],
      turns: [{ exec: 'exec-1', ts: '2026-07-14T13:39:40.000Z', user: 'hello', say: 'hi' }],
    })
    const provider = createKiroProvider('/nonexistent', '/nonexistent', join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const v2 = sources.filter(s => /\/sess_[^/]+\/messages\.jsonl$/.test(s.path))
    expect(v2).toHaveLength(1)
    expect(v2[0]!.project).toBe('kiro-ide')
  })

  it('ignores a sess_ directory with no messages.jsonl', async () => {
    const sessDir = join(sessionsRoot, '4748323122002acb', 'sess_empty')
    await mkdir(sessDir, { recursive: true })
    await writeFile(join(sessDir, 'session.json'), JSON.stringify({ id: 'sess_empty', modelId: 'auto' }))

    const provider = createKiroProvider('/nonexistent', '/nonexistent', join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const v2 = sources.filter(s => /\/sess_[^/]+\/messages\.jsonl$/.test(s.path))
    expect(v2).toHaveLength(0)
  })

  it('does not descend into the cli directory when discovering v2 sessions', async () => {
    // A sess_-shaped directory inside the CLI store must not be picked up as v2.
    const trap = join(sessionsRoot, 'cli', 'sess_trap')
    await mkdir(trap, { recursive: true })
    await writeFile(join(trap, 'messages.jsonl'), makeV2Messages([
      { exec: 'exec-trap', ts: '2026-07-14T13:39:40.000Z', user: 'trap', say: 'should not appear' },
    ]))

    const provider = createKiroProvider('/nonexistent', '/nonexistent', join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const v2 = sources.filter(s => /\/sess_[^/]+\/messages\.jsonl$/.test(s.path))
    expect(v2).toHaveLength(0)
  })
})

describe('kiro provider - mixed-format coexistence (legacy + v1 + workspace-sessions + CLI + v2)', () => {
  // Simulates a machine that upgraded through Kiro versions: every historical
  // storage format has files on disk simultaneously. Verifies each source routes
  // to the right parser, the aggregate call count is exact (no double counting),
  // and dedup keys stay in their own namespaces.
  let root: string
  let agentDir: string
  let sessionsRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kiro-mixed-'))
    agentDir = join(root, 'agent')
    sessionsRoot = join(root, 'sessions')
    await mkdir(agentDir, { recursive: true })
    await mkdir(join(sessionsRoot, 'cli'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function parseAll(): Promise<ParsedProviderCall[]> {
    const provider = createKiroProvider(agentDir, join(root, 'ws-storage'), join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const seenKeys = new Set<string>()
    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) calls.push(call)
    }
    return calls
  }

  async function buildFullTree() {
    const wsHash = 'a1b2c3d4'.repeat(4)

    // 1. Legacy .chat file
    const wsDir = join(agentDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(wsDir, 'legacy.chat'), makeChatFile({
      executionId: 'exec-legacy', workflowId: 'wf-legacy',
      userPrompt: 'legacy question', botResponses: ['legacy answer'],
    }))

    // 2. v1 modern execution file (nested session dir)
    const sessDir = join(wsDir, 'session-v1')
    await mkdir(sessDir, { recursive: true })
    await writeFile(join(sessDir, 'execution-v1'), makeModernExecutionFile({
      executionId: 'exec-v1', sessionId: 'session-v1',
      userPrompt: 'v1 question', assistantResponse: 'v1 answer',
    }))

    // 3a. Workspace-session with real assistant content (counted)
    const wssDir = join(agentDir, 'workspace-sessions', 'L3RtcC9taXhlZA__')
    await mkdir(wssDir, { recursive: true })
    await writeFile(join(wssDir, 'ws-real.json'), JSON.stringify({
      sessionId: 'ws-real', selectedModel: 'claude-sonnet-4.5',
      history: [
        { message: { role: 'user', content: [{ type: 'text', text: 'ws question' }] } },
        { message: { role: 'assistant', content: 'a real standalone workspace-session answer' } },
      ],
    }))

    // 3b. Workspace-session stub referencing the v1 execution (must be skipped)
    await writeFile(join(wssDir, 'ws-stub.json'), JSON.stringify({
      sessionId: 'ws-stub', selectedModel: 'auto',
      history: [
        { message: { role: 'user', content: [{ type: 'text', text: 'v1 question' }] } },
        { message: { role: 'assistant', content: 'On it.' }, executionId: 'exec-v1' },
      ],
    }))

    // 4. CLI session
    const cliSessionId = '44444444-4444-4444-4444-444444444444'
    await writeFile(join(sessionsRoot, 'cli', `${cliSessionId}.jsonl`), [
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm1', content: [{ kind: 'text', data: 'cli question' }], meta: { timestamp: 1700000000 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm2', content: [{ kind: 'text', data: 'cli answer' }] } }),
    ].join('\n'))
    await writeFile(join(sessionsRoot, 'cli', `${cliSessionId}.json`), JSON.stringify({
      session_id: cliSessionId, cwd: '/tmp/mixed-proj',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z',
      session_state: {
        rts_model_state: { model_info: { model_id: 'claude-sonnet-4' } },
        conversation_metadata: { user_turn_metadatas: [{ end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [{ value: 0.05, unit: 'credit' }] }] },
      },
    }))

    // 5. v2 session (2 turns)
    await makeV2Session(sessionsRoot, {
      wsHash: 'a1b2c3d4e5f60718', sessionId: 'sess_mixed-001',
      turns: [
        { exec: 'exec-v2-1', ts: '2026-07-14T13:39:40.000Z', user: 'v2 first', say: 'v2 first answer', tools: ['readFile'] },
        { exec: 'exec-v2-2', ts: '2026-07-14T13:41:00.000Z', user: 'v2 second', say: 'v2 second answer' },
      ],
    })
  }

  it('routes every format to the right parser and counts each conversation exactly once', async () => {
    await buildFullTree()
    const calls = await parseAll()

    // Exact aggregate: 1 legacy + 1 v1 exec + 1 ws-session (stub skipped) + 1 CLI + 2 v2 turns
    expect(calls).toHaveLength(6)

    const byPrefix = (p: string) => calls.filter(c => c.deduplicationKey!.startsWith(p))
    expect(byPrefix('kiro-v2:')).toHaveLength(2)
    expect(byPrefix('kiro-cli:')).toHaveLength(1)
    expect(byPrefix('kiro:ws-session:')).toHaveLength(1)
    // Legacy + v1 executions share the plain kiro: namespace
    expect(byPrefix('kiro:').filter(c => !c.deduplicationKey!.startsWith('kiro:ws-session:'))).toHaveLength(2)

    // The ws-session stub for exec-v1 must not have been emitted
    expect(calls.some(c => c.deduplicationKey === 'kiro:ws-session:ws-stub')).toBe(false)
    // Each conversation's content is attributed once
    expect(calls.filter(c => c.userMessage === 'v1 question')).toHaveLength(1)

    // Dedup keys are globally unique
    const keys = calls.map(c => c.deduplicationKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('emits nothing on a second pass with shared seenKeys (cross-run dedup across all formats)', async () => {
    await buildFullTree()
    const provider = createKiroProvider(agentDir, join(root, 'ws-storage'), join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const seenKeys = new Set<string>()

    const run1: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) run1.push(call)
    }
    const run2: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) run2.push(call)
    }

    expect(run1).toHaveLength(6)
    expect(run2).toHaveLength(0)
  })

  it('discovery paths are unique across all stores', async () => {
    await buildFullTree()
    const provider = createKiroProvider(agentDir, join(root, 'ws-storage'), join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const paths = sources.map(s => s.path)
    expect(new Set(paths).size).toBe(paths.length)
  })
})
