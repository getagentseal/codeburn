import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join, posix, win32 } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { copilot, createCopilotProvider, getVSCodeGlobalStorageDirs, getVSCodeWorkspaceStorageDirs } from '../../src/providers/copilot.js'
import { isSqliteAvailable, isSqliteBusyError } from '../../src/sqlite.js'
import { calculateCost } from '../../src/models.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

// The machine running this suite may itself have a real
// ~/.copilot/session-store.db, which discoverSessions would pick up by
// default and leak into every discovery test's source list. Pin the path to
// a nonexistent file globally; tests that need a store pass an explicit
// fixture path to createCopilotProvider (or re-stub the env themselves).
beforeEach(() => {
  vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', '/nonexistent/session-store.db')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

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

// A CLI session.shutdown rollup. `usage.inputTokens` is written cache-inclusive
// by the real CLI (input + cache_read + cache_write), matching the issue sample.
function shutdownEvent(opts: {
  modelMetrics: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens?: number
  }>
  timestamp?: string
}) {
  const modelMetrics: Record<string, unknown> = {}
  for (const [model, u] of Object.entries(opts.modelMetrics)) {
    modelMetrics[model] = {
      requests: { count: 1, cost: 1 },
      usage: {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        reasoningTokens: u.reasoningTokens ?? 0,
      },
    }
  }
  return JSON.stringify({
    type: 'session.shutdown',
    timestamp: opts.timestamp ?? '2026-04-15T10:05:00Z',
    data: { shutdownType: 'routine', sessionStartTime: 1784102040274, modelMetrics },
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

// Write a transcript inside the test's tmpDir sandbox, but at the production
// directory shape — {ws}/{hash}/GitHub.copilot-chat/transcripts/<id>.jsonl —
// because sessionId derivation reads the path structure (file basename for
// transcripts). Never touches the real VS Code storage.
async function createTranscriptFile(sessionId: string, lines: string[]) {
  const transcriptsDir = join(tmpDir, 'ws', 'hash1', 'GitHub.copilot-chat', 'transcripts')
  await mkdir(transcriptsDir, { recursive: true })
  const path = join(transcriptsDir, `${sessionId}.jsonl`)
  await writeFile(path, lines.join('\n') + '\n')
  return path
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

  it('attributes turns between subagent.started and subagent.completed to the subagent', async () => {
    // CLI ≥ ~1.0.7x writes subagent.started/completed (not subagent.selected);
    // event shapes from a real delegating 1.0.78 session. The label must cover
    // the subagent's turns and clear afterwards, not bleed onto the parent's.
    const eventsPath = await createSessionDir('sess-subagent-cli', [
      modelChange('claude-sonnet-5'),
      userMessage('delegate a search'),
      JSON.stringify({
        type: 'subagent.started',
        timestamp: '2026-08-07T10:00:11Z',
        data: { toolCallId: 'toolu_01SZnHjC', agentName: 'explore', agentDisplayName: 'Explore Agent' },
      }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-08-07T10:00:14Z',
        data: { messageId: 'msg-sub', model: 'claude-haiku-4.5', outputTokens: 197, toolRequests: [] },
      }),
      JSON.stringify({
        type: 'subagent.completed',
        timestamp: '2026-08-07T10:00:19Z',
        data: { toolCallId: 'toolu_01SZnHjC', agentName: 'explore', model: 'claude-haiku-4.5', totalTokens: 26435 },
      }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-08-07T10:00:22Z',
        data: { messageId: 'msg-parent', model: 'claude-sonnet-5', outputTokens: 51, toolRequests: [] },
      }),
    ])

    const calls = await collectCalls({ path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'jsonl' })
    const sub = calls.find(c => c.deduplicationKey.endsWith(':msg-sub'))!
    expect(sub.subagentTypes).toEqual(['explore'])
    expect(sub.model).toBe('claude-haiku-4.5')
    const parent = calls.find(c => c.deduplicationKey.endsWith(':msg-parent'))!
    expect(parent.subagentTypes).toBeUndefined()
  })

  it('completing a nested subagent restores the outer label, matched by toolCallId', async () => {
    const started = (id: string, name: string) =>
      JSON.stringify({ type: 'subagent.started', timestamp: '2026-08-07T10:00:11Z', data: { toolCallId: id, agentName: name } })
    const completed = (id: string) =>
      JSON.stringify({ type: 'subagent.completed', timestamp: '2026-08-07T10:00:19Z', data: { toolCallId: id, agentName: 'x' } })
    const msg = (messageId: string, outputTokens = 10) =>
      JSON.stringify({ type: 'assistant.message', timestamp: '2026-08-07T10:00:14Z', data: { messageId, model: 'claude-sonnet-5', outputTokens, toolRequests: [] } })

    const eventsPath = await createSessionDir('sess-subagent-nested', [
      modelChange('claude-sonnet-5'),
      started('call-A', 'explore'),
      started('call-B', 'plan'),
      msg('msg-inner'),      // while B runs → 'plan'
      completed('call-B'),
      msg('msg-outer'),      // B done, A still active → 'explore', NOT unlabeled
      completed('call-A'),
      msg('msg-after'),      // all done → no label
    ])

    const calls = await collectCalls({ path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'jsonl' })
    const byId = (id: string) => calls.find(c => c.deduplicationKey.endsWith(`:${id}`))!
    expect(byId('msg-inner').subagentTypes).toEqual(['plan'])
    expect(byId('msg-outer').subagentTypes).toEqual(['explore'])
    expect(byId('msg-after').subagentTypes).toBeUndefined()
  })

  it('ignores a completed event whose non-empty toolCallId matches no active run', async () => {
    // A completion for a run we never saw start must not evict an unrelated
    // active run; only a genuinely ID-less completion may pop the stack.
    const eventsPath = await createSessionDir('sess-subagent-unmatched', [
      modelChange('claude-sonnet-5'),
      JSON.stringify({
        type: 'subagent.started',
        timestamp: '2026-08-07T10:00:11Z',
        data: { toolCallId: 'call-A', agentName: 'explore' },
      }),
      JSON.stringify({
        type: 'subagent.completed',
        timestamp: '2026-08-07T10:00:12Z',
        data: { toolCallId: 'call-unknown', agentName: 'phantom' },
      }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-08-07T10:00:14Z',
        data: { messageId: 'msg-1', model: 'claude-sonnet-5', outputTokens: 10, toolRequests: [] },
      }),
      JSON.stringify({
        type: 'subagent.completed',
        timestamp: '2026-08-07T10:00:15Z',
        data: { agentName: 'legacy-no-id' },
      }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-08-07T10:00:16Z',
        data: { messageId: 'msg-2', model: 'claude-sonnet-5', outputTokens: 12, toolRequests: [] },
      }),
    ])

    const calls = await collectCalls({ path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'jsonl' })
    // The unmatched completion left 'explore' active…
    expect(calls.find(c => c.deduplicationKey.endsWith(':msg-1'))!.subagentTypes).toEqual(['explore'])
    // …and the ID-less completion (legacy shape) ended it.
    expect(calls.find(c => c.deduplicationKey.endsWith(':msg-2'))!.subagentTypes).toBeUndefined()
  })

  it('keeps subagent.selected sticky when no completed event ever arrives', async () => {
    // Older CLIs only write subagent.selected; nothing clears it.
    const eventsPath = await createSessionDir('sess-subagent-selected', [
      modelChange('claude-sonnet-5'),
      JSON.stringify({ type: 'subagent.selected', data: { agentName: 'refactor' } }),
      assistantMessage({ messageId: 'msg-1', outputTokens: 25 }),
      assistantMessage({ messageId: 'msg-2', outputTokens: 30, timestamp: '2026-04-15T10:01:00Z' }),
    ])
    const calls = await collectCalls({ path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'jsonl' })
    expect(calls.map(c => c.subagentTypes)).toEqual([['refactor'], ['refactor']])
  })

  it('infers OpenAI auto bucket for transcript toolCallId prefix call_', async () => {
    const eventsPath = await createTranscriptFile('sess-tr-call', [
      transcriptSessionStart('sess-tr-call'),
      transcriptUserMessage('check model inference'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'done',
        toolCallIds: ['call_abc123'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'transcript' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('copilot-openai-auto')
    // Each transcript is its own session, keyed by file basename — NOT the
    // shared parent dir name 'transcripts', which would collapse every
    // transcript into one session and one dedup namespace.
    expect(calls[0]!.sessionId).toBe('sess-tr-call')
  })

  it('infers Anthropic auto bucket for transcript toolCallId prefixes tooluse_/toolu_vrtx_', async () => {
    const eventsPath = await createTranscriptFile('sess-tr-claude', [
      transcriptSessionStart('sess-tr-claude'),
      transcriptUserMessage('check model inference'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'done',
        toolCallIds: ['tooluse_XY', 'toolu_vrtx_01ABC'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'transcript' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('copilot-anthropic-auto')
  })

  it('chooses the dominant inferred transcript model when prefixes are mixed', async () => {
    const eventsPath = await createTranscriptFile('sess-tr-mixed', [
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

    const source = { path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'transcript' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(3)
    expect(calls.every(c => c.model === 'copilot-openai-auto')).toBe(true)
  })

  it('parses a producerless transcript with explicit model info and no tool calls', async () => {
    // Prefix inference has nothing to work with here; the explicit
    // session.model_change must still establish the model, and the shutdown
    // rollup must stay ignored — provenance, not the producer field, gates it.
    const eventsPath = await createTranscriptFile('sess-tr-explicit', [
      JSON.stringify({ type: 'session.start', data: { sessionId: 'sess-tr-explicit' } }),
      modelChange('gpt-4.1'),
      transcriptUserMessage('hi'),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-04-15T10:00:15Z',
        data: { messageId: 'msg-1', outputTokens: 80, toolRequests: [] },
      }),
      shutdownEvent({
        modelMetrics: {
          'gpt-4.1': { inputTokens: 1000, outputTokens: 80, cacheReadTokens: 500, cacheWriteTokens: 200 },
        },
      }),
    ])

    const calls = await collectCalls({ path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'transcript' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('gpt-4.1')
    expect(calls[0]!.outputTokens).toBe(80)
    expect(calls.every(c => !c.deduplicationKey.includes(':shutdown:'))).toBe(true)
  })

  it('normalizes Copilot MCP tool names from VS Code transcripts', async () => {
    const eventsPath = await createTranscriptFile('sess-tr-mcp-tools', [
      transcriptSessionStart('sess-tr-mcp-tools'),
      transcriptUserMessage('use GitHub MCP'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'done',
        toolCallIds: ['call_abc123', 'call_def456'],
        toolNames: ['github-mcp-server-list_issues', 'read_file'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'transcript' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['mcp__github_mcp_server__list_issues', 'Read'])
  })
})

describe('copilot provider - session.shutdown token/cost rollup', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-shutdown-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('reads input/cache tokens and measured cost from session.shutdown', async () => {
    const eventsPath = await createSessionDir('sess-shutdown', [
      modelChange('claude-sonnet-4-5'),
      userMessage('do the thing'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 345 }),
      shutdownEvent({
        modelMetrics: {
          // Real sample from issue #676: inputTokens is cache-inclusive
          // (4 + 35495 + 35783 = 71282), so pure input is 4.
          'claude-sonnet-4-5': {
            inputTokens: 71282,
            outputTokens: 345,
            cacheReadTokens: 35495,
            cacheWriteTokens: 35783,
            reasoningTokens: 31,
          },
        },
      }),
    ])

    const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }
    const calls = await collectCalls(source)

    // One per-turn assistant.message call + one supplementary shutdown call.
    expect(calls).toHaveLength(2)

    const shutdown = calls.find(c => c.deduplicationKey === 'copilot:sess-shutdown:shutdown:claude-sonnet-4-5:1')
    expect(shutdown).toBeDefined()
    expect(shutdown!.model).toBe('claude-sonnet-4-5')
    expect(shutdown!.inputTokens).toBe(4)              // 71282 - 35495 - 35783
    expect(shutdown!.cacheReadInputTokens).toBe(35495)
    expect(shutdown!.cacheCreationInputTokens).toBe(35783)
    expect(shutdown!.reasoningTokens).toBe(31)
    expect(shutdown!.outputTokens).toBe(0)             // owned by the per-turn event
    expect(shutdown!.costIsEstimated).toBe(false)       // measured, not char-estimated

    const expectedShutdownCost = calculateCost('claude-sonnet-4-5', 4, 0, 35783, 35495, 0)
    expect(shutdown!.costUSD).toBeCloseTo(expectedShutdownCost, 12)
    expect(shutdown!.costUSD).toBeGreaterThan(0)

    // No dimension double-counts: output stays with the per-turn event only,
    // input/cache come only from the shutdown rollup.
    const total = (k: keyof ParsedProviderCall) =>
      calls.reduce((s, c) => s + (c[k] as number), 0)
    expect(total('outputTokens')).toBe(345)
    expect(total('inputTokens')).toBe(4)
    expect(total('cacheReadInputTokens')).toBe(35495)
    expect(total('cacheCreationInputTokens')).toBe(35783)

    // Session cost = per-turn output cost + shutdown input/cache cost = full cost.
    const perTurn = calls.find(c => c.deduplicationKey === 'copilot:sess-shutdown:msg-1')
    expect(perTurn!.costUSD).toBeCloseTo(calculateCost('claude-sonnet-4-5', 0, 345, 0, 0, 0), 12)
    const sessionCost = calls.reduce((s, c) => s + c.costUSD, 0)
    const fullCost = calculateCost('claude-sonnet-4-5', 4, 345, 35783, 35495, 0)
    expect(sessionCost).toBeCloseTo(fullCost, 12)
  })

  it('keeps output-only behavior when session.shutdown is absent', async () => {
    const eventsPath = await createSessionDir('sess-no-shutdown', [
      modelChange('claude-sonnet-4-5'),
      userMessage('no shutdown here'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 150 }),
    ])

    const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }
    const calls = await collectCalls(source)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.outputTokens).toBe(150)
    expect(call.inputTokens).toBe(0)
    expect(call.cacheReadInputTokens).toBe(0)
    expect(call.cacheCreationInputTokens).toBe(0)
    expect(call.costIsEstimated).toBeUndefined()
    expect(call.costUSD).toBeCloseTo(calculateCost('claude-sonnet-4-5', 0, 150, 0, 0, 0), 12)
  })

  it('attributes shutdown tokens and cost per model', async () => {
    const eventsPath = await createSessionDir('sess-multi', [
      modelChange('claude-sonnet-4-5'),
      userMessage('first'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 100 }),
      modelChange('gpt-5', 'claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-2', outputTokens: 200 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 10100, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 2000, reasoningTokens: 0 },
          'gpt-5': { inputTokens: 5050, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0, reasoningTokens: 12 },
        },
      }),
    ])

    const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }
    const calls = await collectCalls(source)

    const shutdownCalls = calls.filter(c => c.deduplicationKey.includes(':shutdown:'))
    expect(shutdownCalls).toHaveLength(2)

    const sonnet = shutdownCalls.find(c => c.model === 'claude-sonnet-4-5')!
    expect(sonnet.inputTokens).toBe(100)             // 10100 - 8000 - 2000
    expect(sonnet.cacheReadInputTokens).toBe(8000)
    expect(sonnet.cacheCreationInputTokens).toBe(2000)
    expect(sonnet.outputTokens).toBe(0)
    expect(sonnet.costUSD).toBeCloseTo(calculateCost('claude-sonnet-4-5', 100, 0, 2000, 8000, 0), 12)
    expect(sonnet.costUSD).toBeGreaterThan(0)

    const gpt = shutdownCalls.find(c => c.model === 'gpt-5')!
    expect(gpt.inputTokens).toBe(50)                 // 5050 - 5000 - 0
    expect(gpt.cacheReadInputTokens).toBe(5000)
    expect(gpt.cacheCreationInputTokens).toBe(0)
    expect(gpt.reasoningTokens).toBe(12)
    expect(gpt.costUSD).toBeCloseTo(calculateCost('gpt-5', 50, 0, 0, 5000, 0), 12)
  })

  it('emits per-leg deltas for a resumed session with cumulative shutdown rollups', async () => {
    // Numbers from a real resumed CLI 1.0.78 session (3 legs via --resume):
    // each leg appends a session.shutdown whose modelMetrics are CUMULATIVE.
    // Emitting deltas keyed by shutdown timestamp keeps a growing file
    // append-only under the durable union-by-key cache merge — re-parsing
    // after each resume adds only the new leg, never double-counting earlier ones.
    const legs = [
      { inputTokens: 24672, outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 24670 },
      { inputTokens: 74463, outputTokens: 149, cacheReadTokens: 49489, cacheWriteTokens: 24968 },
      { inputTokens: 124783, outputTokens: 243, cacheReadTokens: 99569, cacheWriteTokens: 25204 },
    ]
    const lines = [modelChange('claude-sonnet-5'), assistantMessage({ messageId: 'msg-1', outputTokens: 17 })]
    for (const [i, leg] of legs.entries()) {
      lines.push(shutdownEvent({ modelMetrics: { 'claude-sonnet-5': leg }, timestamp: `2026-08-0${i + 1}T10:00:00Z` }))
    }
    const eventsPath = await createSessionDir('sess-resumed', lines)
    const calls = await collectCalls({ path: eventsPath, project: 'myproject', provider: 'copilot', sourceType: 'jsonl' })

    const shutdowns = calls.filter(c => c.deduplicationKey.includes(':shutdown:'))
    expect(shutdowns.map(c => c.deduplicationKey)).toEqual([
      'copilot:sess-resumed:shutdown:claude-sonnet-5:1',
      'copilot:sess-resumed:shutdown:claude-sonnet-5:2',
      'copilot:sess-resumed:shutdown:claude-sonnet-5:3',
    ])
    // Each leg lands on its own shutdown timestamp (a resumed session can
    // span days; whole-rollup emission would collapse them onto one).
    expect(shutdowns.map(c => c.timestamp)).toEqual([
      '2026-08-01T10:00:00Z', '2026-08-02T10:00:00Z', '2026-08-03T10:00:00Z',
    ])
    // Per-leg deltas sum exactly to the final cumulative rollup.
    const sum = (k: 'inputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens') =>
      shutdowns.reduce((a, c) => a + c[k], 0)
    expect(sum('cacheReadInputTokens')).toBe(99569)
    expect(sum('cacheCreationInputTokens')).toBe(25204)
    expect(sum('inputTokens')).toBe(124783 - 99569 - 25204)

    // A later re-parse of the grown file (prior legs already cached) emits
    // only what the seen-key set lacks.
    const seen = new Set(calls.map(c => c.deduplicationKey))
    const again = await collectCalls({ path: eventsPath, project: 'myproject', provider: 'copilot', sourceType: 'jsonl' }, seen)
    expect(again).toHaveLength(0)
  })

  it('starts a fresh delta baseline when a cumulative rollup goes backwards (counter reset)', async () => {
    // Hypothetical but cheap to guard: if the CLI ever resets its counters
    // mid-session, the post-reset epoch must be billed from zero — a stale
    // high-water baseline would clamp it away (and the reset leg's real usage
    // with it).
    const eventsPath = await createSessionDir('sess-reset', [
      modelChange('claude-sonnet-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 10 }),
      shutdownEvent({
        modelMetrics: { 'claude-sonnet-5': { inputTokens: 10000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 5000 } },
        timestamp: '2026-08-01T10:00:00Z',
      }),
      // Reset: cumulative drops below the previous rollup → new epoch.
      shutdownEvent({
        modelMetrics: { 'claude-sonnet-5': { inputTokens: 2000, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 1000 } },
        timestamp: '2026-08-02T10:00:00Z',
      }),
      shutdownEvent({
        modelMetrics: { 'claude-sonnet-5': { inputTokens: 5000, outputTokens: 8, cacheReadTokens: 2000, cacheWriteTokens: 1500 } },
        timestamp: '2026-08-03T10:00:00Z',
      }),
    ])
    const calls = await collectCalls({ path: eventsPath, project: 'myproject', provider: 'copilot', sourceType: 'jsonl' })
    const shutdowns = calls.filter(c => c.deduplicationKey.includes(':shutdown:'))
    expect(shutdowns).toHaveLength(3)
    // Leg 1: epoch-1 usage in full.
    expect(shutdowns[0]!.inputTokens).toBe(5000)  // 10000 − 0 − 5000
    expect(shutdowns[0]!.cacheCreationInputTokens).toBe(5000)
    // Leg 2 (reset): billed from zero, not clamped away against the old baseline.
    expect(shutdowns[1]!.inputTokens).toBe(1000)  // 2000 − 0 − 1000
    expect(shutdowns[1]!.cacheCreationInputTokens).toBe(1000)
    // Leg 3: normal delta within the new epoch.
    expect(shutdowns[2]!.inputTokens).toBe(500)   // (5000−2000) − 2000 − 500
    expect(shutdowns[2]!.cacheReadInputTokens).toBe(2000)
    expect(shutdowns[2]!.cacheCreationInputTokens).toBe(500)
  })

  it('keeps shutdown dedup keys stable across re-parses', async () => {
    const eventsPath = await createSessionDir('sess-reparse', [
      modelChange('claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 345 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 71282, outputTokens: 345, cacheReadTokens: 35495, cacheWriteTokens: 35783, reasoningTokens: 31 },
        },
      }),
    ])
    const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }

    const seen = new Set<string>()
    const first = await collectCalls(source, seen)
    expect(first).toHaveLength(2)
    // Durable provider: re-parsing with the same seenKeys re-emits nothing.
    const second = await collectCalls(source, seen)
    expect(second).toHaveLength(0)
  })

  it('keeps three stampless shutdown legs as :n keys with lastEventTimestamp, not sessionStartTime', async () => {
    // sessionStartTime is identical on every leg. Putting it in the key (or
    // preferring it over lastEventTimestamp for the call timestamp) collapses
    // a 3-leg journal onto one row. Discovery only yields events.jsonl, so
    // two-journal fixtures are unreachable; this is the reachable class.
    const lastEvent = '2026-08-01T10:00:15Z'
    const sessionStartTime = 1784102040274
    const stamplessShutdown = (usage: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }) => JSON.stringify({
      type: 'session.shutdown',
      data: {
        shutdownType: 'routine',
        sessionStartTime,
        modelMetrics: {
          'claude-sonnet-5': {
            requests: { count: 1, cost: 1 },
            usage: { ...usage, reasoningTokens: 0 },
          },
        },
      },
    })
    const eventsPath = await createSessionDir('sess-stampless', [
      modelChange('claude-sonnet-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 10, timestamp: lastEvent }),
      stamplessShutdown({ inputTokens: 3000, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 500 }),
      stamplessShutdown({ inputTokens: 7000, outputTokens: 20, cacheReadTokens: 3000, cacheWriteTokens: 1000 }),
      stamplessShutdown({ inputTokens: 10000, outputTokens: 30, cacheReadTokens: 5000, cacheWriteTokens: 1500 }),
    ])
    const calls = await collectCalls({ path: eventsPath, project: 'myproject', provider: 'copilot', sourceType: 'jsonl' })
    const shutdowns = calls.filter(c => c.deduplicationKey.includes(':shutdown:'))
    expect(shutdowns.map(c => c.deduplicationKey)).toEqual([
      'copilot:sess-stampless:shutdown:claude-sonnet-5:1',
      'copilot:sess-stampless:shutdown:claude-sonnet-5:2',
      'copilot:sess-stampless:shutdown:claude-sonnet-5:3',
    ])
    expect(shutdowns.map(c => c.timestamp)).toEqual([lastEvent, lastEvent, lastEvent])
    expect(shutdowns[0]!.inputTokens).toBe(1500)
    expect(shutdowns[1]!.inputTokens).toBe(1500)
    expect(shutdowns[2]!.inputTokens).toBe(500)
    expect(shutdowns.reduce((a, c) => a + c.inputTokens, 0)).toBe(3500)
    expect(shutdowns.reduce((a, c) => a + c.cacheReadInputTokens, 0)).toBe(5000)
    expect(shutdowns.reduce((a, c) => a + c.cacheCreationInputTokens, 0)).toBe(1500)
  })

  it('falls back to the last stamped event when shutdown carries no timestamp at all', async () => {
    // A shutdown with neither its own timestamp nor sessionStartTime must not
    // yield an empty-timestamp call: the date-range filters in parser.ts drop
    // those silently, which would erase exactly the tokens this fix bills.
    const bareShutdown = JSON.stringify({
      type: 'session.shutdown',
      data: {
        shutdownType: 'routine',
        modelMetrics: {
          'claude-sonnet-4-5': {
            requests: { count: 1, cost: 1 },
            usage: { inputTokens: 9000, outputTokens: 300, cacheReadTokens: 4000, cacheWriteTokens: 1000, reasoningTokens: 0 },
          },
        },
      },
    })
    const eventsPath = await createSessionDir('sess-no-ts', [
      modelChange('claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 300, timestamp: '2026-04-15T10:00:15Z' }),
      bareShutdown,
    ])
    const calls = await collectCalls({ path: eventsPath, project: 'myproject', provider: 'copilot' })
    const shutdown = calls.find(c => c.deduplicationKey.includes(':shutdown:'))
    expect(shutdown).toBeDefined()
    expect(shutdown!.timestamp).toBe('2026-04-15T10:00:15Z')
  })

  it('ignores session.shutdown for VS Code transcript sessions', async () => {
    const eventsPath = await createTranscriptFile('sess-tr-shutdown', [
      transcriptSessionStart('sess-tr-shutdown'),
      transcriptUserMessage('hi'),
      transcriptAssistantMessage({ messageId: 'msg-1', content: 'done', toolCallIds: ['call_abc'] }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 71282, outputTokens: 345, cacheReadTokens: 35495, cacheWriteTokens: 35783 },
        },
      }),
    ])
    const source = { path: eventsPath, project: 'test', provider: 'copilot', sourceType: 'transcript' }
    const calls = await collectCalls(source)

    // Only the transcript assistant call; the shutdown rollup is CLI-only.
    expect(calls).toHaveLength(1)
    expect(calls.every(c => !c.deduplicationKey.includes(':shutdown:'))).toBe(true)
    expect(calls[0]!.model).toBe('copilot-openai-auto')
  })

  // Regression test for #944: events are redacted copies of a real Copilot CLI
  // 1.0.78 session. The CLI writes the same producer ('copilot-agent') as VS
  // Code transcripts, so content sniffing skipped this session's shutdown
  // rollup — reporting 100 of its 49,573 tokens and zero input/cache.
  it('parses a CLI session whose session.start carries producer copilot-agent (issue #944)', async () => {
    const eventsPath = await createSessionDir('sess-cli-producer', [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2026-08-07T17:56:35.573Z',
        data: {
          sessionId: 'sess-cli-producer',
          version: 1,
          producer: 'copilot-agent',
          copilotVersion: '1.0.78',
          startTime: '2026-08-07T17:56:35.554Z',
          context: { cwd: '/home/user/myproject' },
        },
      }),
      JSON.stringify({
        type: 'session.model_change',
        timestamp: '2026-08-07T17:56:36.725Z',
        data: { newModel: 'claude-sonnet-5', reasoningEffort: null },
      }),
      JSON.stringify({
        type: 'user.message',
        timestamp: '2026-08-07T17:56:36.732Z',
        data: { content: 'Run echo and summarize the output.' },
      }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-08-07T17:56:38.763Z',
        data: {
          messageId: 'a982a391-9ee3-4fbd-89a9-26d5af78c890',
          model: 'claude-sonnet-5',
          content: '',
          toolRequests: [{
            toolCallId: 'toolu_017eL3f5aeGiLoALignYMZEN',
            name: 'bash',
            arguments: { command: 'echo codeburn-repro-944', description: 'Echo test string' },
            type: 'function',
          }],
          turnId: '0',
          outputTokens: 81,
        },
      }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-08-07T17:56:40.417Z',
        data: {
          messageId: '8758ea51-797f-4285-972c-495911e2839f',
          model: 'claude-sonnet-5',
          content: 'The command printed the string "codeburn-repro-944".',
          toolRequests: [],
          turnId: '1',
          outputTokens: 19,
        },
      }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: '2026-08-07T17:56:40.591Z',
        data: {
          shutdownType: 'routine',
          sessionStartTime: 1786125395554,
          modelMetrics: {
            'claude-sonnet-5': {
              requests: { count: 2, cost: 1 },
              usage: { inputTokens: 49473, outputTokens: 100, cacheReadTokens: 24678, cacheWriteTokens: 24791, reasoningTokens: 0 },
            },
          },
        },
      }),
    ])

    // Discovery tags session-state files 'jsonl'; provenance, not the shared
    // producer value, must classify this as a CLI session.
    const calls = await collectCalls({ path: eventsPath, project: 'myproject', provider: 'copilot', sourceType: 'jsonl' })

    // Two per-turn output calls with the REAL model — not the
    // 'copilot-anthropic-auto' bucket transcript inference would pick from the
    // toolu_ toolCallId prefix.
    const perTurn = calls.filter(c => !c.deduplicationKey.includes(':shutdown:'))
    expect(perTurn.map(c => c.outputTokens)).toEqual([81, 19])
    expect(perTurn.every(c => c.model === 'claude-sonnet-5')).toBe(true)

    // The shutdown rollup lands: the tokens the misclassification dropped.
    const shutdown = calls.find(c => c.deduplicationKey === 'copilot:sess-cli-producer:shutdown:claude-sonnet-5:1')
    expect(shutdown).toBeDefined()
    expect(shutdown!.inputTokens).toBe(4) // 49473 − 24678 − 24791 (cache-inclusive)
    expect(shutdown!.cacheReadInputTokens).toBe(24678)
    expect(shutdown!.cacheCreationInputTokens).toBe(24791)
    expect(shutdown!.outputTokens).toBe(0) // owned by the per-turn events
    expect(shutdown!.costIsEstimated).toBe(false)
    expect(shutdown!.costUSD).toBeCloseTo(calculateCost('claude-sonnet-5', 4, 0, 24791, 24678, 0), 12)
    expect(shutdown!.costUSD).toBeGreaterThan(0)
  })

  it('treats a bare (untagged) source as CLI format, not transcript', async () => {
    // Producer sniffing must not resurface for sources without a sourceType tag
    // (the pre-tagging shape): same events, same result as the tagged parse.
    const eventsPath = await createSessionDir('sess-cli-untagged', [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2026-08-07T17:56:35.573Z',
        data: { sessionId: 'sess-cli-untagged', producer: 'copilot-agent', copilotVersion: '1.0.78' },
      }),
      modelChange('claude-sonnet-5'),
      userMessage('hello'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 42 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-5': { inputTokens: 1000, outputTokens: 42, cacheReadTokens: 600, cacheWriteTokens: 300 },
        },
      }),
    ])

    const calls = await collectCalls({ path: eventsPath, project: 'myproject', provider: 'copilot' })
    expect(calls.some(c => c.deduplicationKey.includes(':shutdown:'))).toBe(true)
    expect(calls.find(c => c.deduplicationKey.includes(':shutdown:'))!.cacheReadInputTokens).toBe(600)
  })

  it('wires discovery through parsing: a discovered CLI session keeps its shutdown rollup', async () => {
    // The full #944 pipeline: discoverSessions must tag the session-state file
    // so that the parser it hands off to keeps the shutdown tokens.
    await createSessionDir('sess-wire', [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2026-08-07T17:56:35.573Z',
        data: { sessionId: 'sess-wire', producer: 'copilot-agent', copilotVersion: '1.0.78' },
      }),
      modelChange('claude-sonnet-5'),
      userMessage('hello'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 42 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-5': { inputTokens: 5000, outputTokens: 42, cacheReadTokens: 3000, cacheWriteTokens: 1500 },
        },
      }),
    ])

    // Keep discovery hermetic: a real agent-traces.db on the host must not leak in.
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    try {
      const provider = createCopilotProvider(tmpDir, '/nonexistent/vscode', '/nonexistent/global', '/nonexistent/jetbrains')
      const sessions = await provider.discoverSessions()
      expect(sessions).toHaveLength(1)

      const calls: ParsedProviderCall[] = []
      for await (const call of provider.createSessionParser(sessions[0]!, new Set()).parse()) calls.push(call)

      const shutdown = calls.find(c => c.deduplicationKey === 'copilot:sess-wire:shutdown:claude-sonnet-5:1')
      expect(shutdown).toBeDefined()
      expect(shutdown!.inputTokens).toBe(500) // 5000 − 3000 − 1500
      expect(shutdown!.cacheReadInputTokens).toBe(3000)
      expect(shutdown!.cacheCreationInputTokens).toBe(1500)
    } finally {
      vi.unstubAllEnvs()
    }
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
    // Session-state files are tagged as CLI sources — the tag (not the file's
    // producer value) decides transcript vs CLI parsing (#944).
    expect(sessions.every(s => (s as { sourceType?: string }).sourceType === 'jsonl')).toBe(true)
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
    expect((sessions[0] as { sourceType?: string }).sourceType).toBe('transcript')
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

// ---------------------------------------------------------------------------
// Session-store tests (~/.copilot/session-store.db)
//
// The Copilot CLI and the GitHub Copilot desktop app write per-request usage
// rows into assistant_usage_events. These tests verify the row → call
// contract (cache-inclusive input decomposed, output excluded), the
// discovery-time shutdown-rollup suppression for covered sessions, and the
// graceful-absence path for stores predating the table. Fixture DBs are
// built programmatically — never committed binaries.
// ---------------------------------------------------------------------------

/** Creates a minimal session-store.db schema matching the Copilot CLI store. */
function createSessionStoreDb(dbPath: string): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      repository TEXT,
      branch TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
  db.close()
}

interface UsageRowDef {
  sessionId: string
  model: string
  // Cache-INCLUSIVE, as the CLI writes it (input + cache_read + cache_write).
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  // Explicit null writes SQL NULL (exercises the timestamp fallback chain);
  // undefined gets a fixed default so unrelated tests stay deterministic.
  createdAt?: string | null
  cwd?: string
  repository?: string
  sessionCreatedAt?: string | null
}

function insertUsageRow(dbPath: string, row: UsageRowDef): void {
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const db = new DatabaseSync(dbPath)
  db.prepare(`INSERT OR IGNORE INTO sessions (id, cwd, repository, created_at) VALUES (?, ?, ?, ?)`)
    .run(row.sessionId, row.cwd ?? null, row.repository ?? null, row.sessionCreatedAt ?? null)
  db.prepare(
    `INSERT INTO assistant_usage_events
       (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.sessionId,
    row.model,
    row.inputTokens,
    row.outputTokens ?? 0,
    row.cacheReadTokens ?? 0,
    row.cacheWriteTokens ?? 0,
    row.reasoningTokens ?? 0,
    row.createdAt === undefined ? '2026-08-01T12:00:00.000Z' : row.createdAt,
  )
  db.close()
}

const storeSource = (path: string) =>
  ({ path, project: 'copilot', provider: 'copilot', sourceType: 'session-store' })

describe.skipIf(!isSqliteAvailable())('copilot provider - session-store parsing', () => {
  let dbPath: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-store-test-'))
    dbPath = join(tmpDir, 'session-store.db')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('decomposes cache-inclusive input_tokens per request row, output excluded', async () => {
    createSessionStoreDb(dbPath)
    // First two requests of a real CLI session: input_tokens is
    // cache-INCLUSIVE (24680 = 2 + 0 + 24678), confirmed by the rows' own
    // token_details_json split (tokenType:"input" holds the uncached
    // remainder). The rows carry output tokens which must NOT be emitted —
    // per-turn output is owned by the events.jsonl assistant.message calls.
    insertUsageRow(dbPath, {
      sessionId: 'sess-a', model: 'claude-sonnet-4-5',
      inputTokens: 24680, outputTokens: 81, cacheReadTokens: 0, cacheWriteTokens: 24678,
      createdAt: '2026-08-07T17:56:38.756Z', cwd: '/home/user/myproject',
    })
    insertUsageRow(dbPath, {
      sessionId: 'sess-a', model: 'claude-sonnet-4-5',
      inputTokens: 24793, outputTokens: 19, cacheReadTokens: 24678, cacheWriteTokens: 113,
      createdAt: '2026-08-07T17:56:40.414Z',
    })

    const calls = await collectCalls(storeSource(dbPath))
    expect(calls).toHaveLength(2)

    const first = calls[0]!
    // <sid>:<rowId> plus a content discriminator (created_at + token counts +
    // model, hashed) so a same-path DB reset reusing AUTOINCREMENT ids can
    // never alias a different request onto a cached key.
    expect(first.deduplicationKey).toMatch(/^copilot-store:sess-a:1:[0-9a-z]+$/)
    expect(first.model).toBe('claude-sonnet-4-5')
    expect(first.inputTokens).toBe(2)               // 24680 - 0 - 24678
    expect(first.cacheReadInputTokens).toBe(0)
    expect(first.cacheCreationInputTokens).toBe(24678)
    expect(first.outputTokens).toBe(0)
    expect(first.costIsEstimated).toBe(false)        // measured, not estimated
    expect(first.costUSD).toBeCloseTo(calculateCost('claude-sonnet-4-5', 2, 0, 24678, 0, 0), 12)
    expect(first.costUSD).toBeGreaterThan(0)
    expect(first.project).toBe('myproject')          // sessions.cwd basename
    expect(first.sessionId).toBe('sess-a')
    expect(first.timestamp).toBe('2026-08-07T17:56:38.756Z')

    const second = calls[1]!
    expect(second.deduplicationKey).toMatch(/^copilot-store:sess-a:2:[0-9a-z]+$/)
    expect(second.inputTokens).toBe(2)               // 24793 - 24678 - 113
    expect(second.cacheReadInputTokens).toBe(24678)
    expect(second.cacheCreationInputTokens).toBe(113)
  })

  it('probeRoots covers every discovery root, with the store contributing its parent directory', async () => {
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', join(tmpDir, 'store', 'session-store.db'))
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', join(tmpDir, 'state'))
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmpDir, 'ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmpDir, 'global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmpDir, 'jb'))

    const roots = await copilot.probeRoots!()
    const paths = roots.map(r => r.path)
    // The PARENT of the store DB, not the file: SQLite appends land in
    // -wal/-shm siblings a file watch would miss — and a resident watcher
    // built from these roots is what entitles the validated-reuse 'clean'
    // verdict to speak for copilot at all.
    expect(paths).toContain(join(tmpDir, 'store'))
    expect(paths).toContain(join(tmpDir, 'state'))
    expect(paths).toContain(join(tmpDir, 'ws'))
    expect(paths).toContain(join(tmpDir, 'global'))
    expect(paths).toContain(join(tmpDir, 'jb'))
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('captures total_nano_aiu and request_multiplier when the schema has them', async () => {
    // Billing-schema store (newer CLI): the optional columns ride the calls
    // as capture-only metadata — no pricing or display consumes them (#890)
    // — and stay OUT of the dedup-key content hash.
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE assistant_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        model TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        total_nano_aiu INTEGER, request_multiplier REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `)
    db.prepare(`INSERT INTO sessions (id, cwd) VALUES ('sess-aiu', '/home/user/proj')`).run()
    db.prepare(
      `INSERT INTO assistant_usage_events
         (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, created_at)
       VALUES ('sess-aiu', 'claude-sonnet-4-5', 1000, 20, 600, 300, 0, 24594000000, 15.0, '2026-08-07T18:00:00.000Z')`
    ).run()
    db.close()

    const calls = await collectCalls(storeSource(dbPath))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.nanoAiu).toBe(24594000000)
    expect(calls[0]!.requestMultiplier).toBe(15)
    expect(calls[0]!.inputTokens).toBe(100)          // 1000 - 600 - 300
  })

  it('parses identically when the billing columns are absent (older store schema)', async () => {
    createSessionStoreDb(dbPath)  // schema predates total_nano_aiu / request_multiplier
    insertUsageRow(dbPath, {
      sessionId: 'sess-old', model: 'claude-sonnet-4-5',
      inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      createdAt: '2026-08-07T18:00:00.000Z',
    })
    const calls = await collectCalls(storeSource(dbPath))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[0]!.nanoAiu).toBeUndefined()
    expect(calls[0]!.requestMultiplier).toBeUndefined()
  })

  it('bills a multi-model (delegating) session per row model', async () => {
    createSessionStoreDb(dbPath)
    // A delegating CLI session: subagent requests land as their own rows with
    // a distinct model, exactly as observed for haiku-backed subagents.
    insertUsageRow(dbPath, {
      sessionId: 'sess-multi', model: 'claude-sonnet-4-5',
      inputTokens: 10100, cacheReadTokens: 8000, cacheWriteTokens: 2000, reasoningTokens: 94,
    })
    insertUsageRow(dbPath, {
      sessionId: 'sess-multi', model: 'claude-haiku-4.5',
      inputTokens: 5050, cacheReadTokens: 5000, cacheWriteTokens: 0,
    })

    const calls = await collectCalls(storeSource(dbPath))
    expect(calls).toHaveLength(2)

    const sonnet = calls.find(c => c.model === 'claude-sonnet-4-5')!
    expect(sonnet.inputTokens).toBe(100)
    expect(sonnet.reasoningTokens).toBe(94)
    // Reasoning is metadata, never a cost line: the CLI's own
    // token_details_json prices only input/cache/output, and reasoning
    // tokens are a subset of output_tokens — billed by the per-turn
    // assistant.message call. A cost above input+cache pricing here means
    // reasoning got billed twice.
    expect(sonnet.costUSD).toBeCloseTo(calculateCost('claude-sonnet-4-5', 100, 0, 2000, 8000, 0), 12)
    const haiku = calls.find(c => c.model === 'claude-haiku-4.5')!
    expect(haiku.inputTokens).toBe(50)
    expect(haiku.cacheReadInputTokens).toBe(5000)
  })

  it('skips all-zero rows and reads SQL-default timestamps as UTC', async () => {
    createSessionStoreDb(dbPath)
    // A row with no input/cache/reasoning adds nothing over the per-turn
    // events (output is excluded by design) — no empty $0 call.
    insertUsageRow(dbPath, { sessionId: 'sess-z', model: 'gpt-5', inputTokens: 0, outputTokens: 42 })
    // created_at written by SQLite's datetime('now') default: UTC but
    // timezone-less, with and without subseconds. Neither may be read as
    // local time — that would land the request on the wrong day.
    insertUsageRow(dbPath, {
      sessionId: 'sess-z', model: 'gpt-5',
      inputTokens: 500, cacheReadTokens: 200, createdAt: '2026-08-07 17:56:38',
    })
    insertUsageRow(dbPath, {
      sessionId: 'sess-z', model: 'gpt-5',
      inputTokens: 600, cacheReadTokens: 300, createdAt: '2026-08-07 23:59:59.756',
    })

    const calls = await collectCalls(storeSource(dbPath))
    expect(calls).toHaveLength(2)
    expect(calls[0]!.timestamp).toBe('2026-08-07T17:56:38.000Z')
    expect(calls[1]!.timestamp).toBe('2026-08-07T23:59:59.756Z')
  })

  it('keeps dedup keys stable as the store grows', async () => {
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, { sessionId: 'sess-grow', model: 'gpt-5', inputTokens: 1000, cacheReadTokens: 400 })

    const seen = new Set<string>()
    const first = await collectCalls(storeSource(dbPath), seen)
    expect(first.map(c => c.deduplicationKey)).toEqual([
      expect.stringMatching(/^copilot-store:sess-grow:1:[0-9a-z]+$/),
    ])

    // Unchanged store re-parsed with the shared dedup set: nothing re-emits —
    // the key (including its content discriminator) is stable across parses.
    expect(await collectCalls(storeSource(dbPath), seen)).toHaveLength(0)

    // New request row: only it is emitted, under the next AUTOINCREMENT id —
    // the append-only shape the durable union-by-key cache merge requires.
    insertUsageRow(dbPath, { sessionId: 'sess-grow', model: 'gpt-5', inputTokens: 2000, cacheReadTokens: 900 })
    const grown = await collectCalls(storeSource(dbPath), seen)
    expect(grown.map(c => c.deduplicationKey)).toEqual([
      expect.stringMatching(/^copilot-store:sess-grow:2:[0-9a-z]+$/),
    ])
  })

  it('gives a reused row id a NEW key when the DB was recreated with different content', async () => {
    // Same path, same session, same AUTOINCREMENT id — but the store was
    // deleted and recreated, so row id 1 now describes a DIFFERENT request.
    // A bare <sid>:<rowId> key would make the durable union swallow the new
    // row as already-cached, losing its usage; the content discriminator
    // must split the two. A byte-identical re-insert (backup restore) must
    // still collapse to the SAME key.
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, {
      sessionId: 'sess-reset', model: 'gpt-5',
      inputTokens: 100, cacheReadTokens: 0, createdAt: '2026-08-07T10:00:00.000Z',
    })
    const before = await collectCalls(storeSource(dbPath))
    expect(before).toHaveLength(1)

    await rm(dbPath, { force: true })
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, {
      sessionId: 'sess-reset', model: 'gpt-5',
      inputTokens: 200, cacheReadTokens: 0, createdAt: '2026-08-08T10:00:00.000Z',
    })
    const after = await collectCalls(storeSource(dbPath))
    expect(after).toHaveLength(1)
    expect(after[0]!.deduplicationKey).not.toBe(before[0]!.deduplicationKey)
    expect(after[0]!.inputTokens).toBe(200)

    // Identical content re-inserted under the same id: the key must NOT move.
    await rm(dbPath, { force: true })
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, {
      sessionId: 'sess-reset', model: 'gpt-5',
      inputTokens: 200, cacheReadTokens: 0, createdAt: '2026-08-08T10:00:00.000Z',
    })
    const restored = await collectCalls(storeSource(dbPath))
    expect(restored[0]!.deduplicationKey).toBe(after[0]!.deduplicationKey)
  })

  it('parses BOTH the store rows and the shutdown rollup for a covered session', async () => {
    // Precedence is serve-time only: the parsers cache both representations
    // unconditionally, and parseProviderSources drops the rollup calls of
    // sessions whose store rows are being served (tests/parser.test.ts (i),
    // (k), (m)). Suppressing here would re-open the probe-to-parse races the
    // serve-time design closes, so this pins the parse-level contract: no
    // parser-side suppression, ever.
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, {
      sessionId: 'sess-covered', model: 'claude-sonnet-4-5',
      inputTokens: 10100, cacheReadTokens: 8000, cacheWriteTokens: 2000,
      cwd: '/home/user/myproject',
    })
    const eventsPath = await createSessionDir('sess-covered', [
      modelChange('claude-sonnet-4-5'),
      userMessage('do the thing'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 345 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 71282, outputTokens: 345, cacheReadTokens: 35495, cacheWriteTokens: 35783, reasoningTokens: 31 },
        },
      }),
    ])

    const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', dbPath)
    const sources = await provider.discoverSessions()
    const store = sources.find(s => (s as { sourceType?: string }).sourceType === 'session-store')
    expect(store).toBeDefined()
    const jsonl = sources.find(s => s.path === eventsPath)
    expect(jsonl).toBeDefined()

    const seen = new Set<string>()
    const collect = async (src: typeof sources[number]) => {
      const out: ParsedProviderCall[] = []
      for await (const call of provider.createSessionParser(src, seen).parse()) out.push(call)
      return out
    }
    const storeCalls = await collect(store!)
    const jsonlCalls = await collect(jsonl!)

    expect(storeCalls.map(c => c.deduplicationKey)).toEqual([
      expect.stringMatching(/^copilot-store:sess-covered:1:[0-9a-z]+$/),
    ])
    const rollup = jsonlCalls.find(c => c.deduplicationKey === 'copilot:sess-covered:shutdown:claude-sonnet-4-5:1')
    expect(rollup).toBeDefined()
    expect(rollup!.cacheReadInputTokens).toBe(35495)
    expect(storeCalls[0]!.inputTokens).toBe(100)
    expect(storeCalls[0]!.cacheReadInputTokens).toBe(8000)
  })

  it('keeps the shutdown rollup for sessions the store does not cover', async () => {
    createSessionStoreDb(dbPath)
    // The store knows about a DIFFERENT session (e.g. one run under a newer
    // CLI); sess-uncovered predates the table's rows and must keep its
    // rollup-derived input/cache.
    insertUsageRow(dbPath, { sessionId: 'sess-other', model: 'gpt-5', inputTokens: 700, cacheReadTokens: 300 })
    const eventsPath = await createSessionDir('sess-uncovered', [
      modelChange('claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 100 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 10100, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 2000 },
        },
      }),
    ])

    const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', dbPath)
    const sources = await provider.discoverSessions()
    const jsonl = sources.find(s => s.path === eventsPath)!

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(jsonl, new Set()).parse()) calls.push(call)

    const rollup = calls.find(c => c.deduplicationKey === 'copilot:sess-uncovered:shutdown:claude-sonnet-4-5:1')
    expect(rollup).toBeDefined()
    expect(rollup!.inputTokens).toBe(100)
    expect(rollup!.cacheReadInputTokens).toBe(8000)
  })

  it('a locked store still surfaces its source and never blocks session-state parsing', async () => {
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, { sessionId: 'sess-locked', model: 'gpt-5', inputTokens: 1000, cacheReadTokens: 400 })
    const eventsPath = await createSessionDir('sess-locked', [
      modelChange('claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 100 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 10100, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 2000 },
        },
      }),
    ])

    // Hold an exclusive write transaction across discovery AND both parses,
    // the shape of a CLI mid-checkpoint. A lock proves nothing about
    // absence, so the source must still surface — its path stays discovered
    // and previously cached rows keep serving (and keep suppressing at
    // serve time) — while its parse raises the busy shape
    // parseProviderSources skips-and-retries. The session-state file no
    // longer waits on the store for anything: its parse (rollup included)
    // must succeed with the store locked the whole time.
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
    const locker = new DatabaseSync(dbPath)
    locker.exec('BEGIN EXCLUSIVE')
    try {
      const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', dbPath)
      const sources = await provider.discoverSessions()
      const store = sources.find(s => (s as { sourceType?: string }).sourceType === 'session-store')
      expect(store).toBeDefined()

      const consumeStore = async () => {
        for await (const _ of provider.createSessionParser(store!, new Set()).parse()) void _
      }
      await expect(consumeStore()).rejects.toSatisfy((err: unknown) => isSqliteBusyError(err))

      const jsonl = sources.find(s => s.path === eventsPath)!
      const calls: ParsedProviderCall[] = []
      for await (const call of provider.createSessionParser(jsonl, new Set()).parse()) calls.push(call)
      expect(calls.some(c => c.deduplicationKey === 'copilot:sess-locked:shutdown:claude-sonnet-4-5:1')).toBe(true)
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
  })

  it('surfaces the source when the store path cannot be stat-ed, and defers its parse', async () => {
    // EACCES/EIO on stat must NOT read as absence: a store may exist that
    // this run cannot see. The source stays discovered — so serve-time
    // suppression keeps holding from previously cached rows — and its parse
    // raises the busy shape parseProviderSources skips-and-retries. The
    // session-state file parses normally either way.
    // Windows has no POSIX mode denial: chmod only toggles the read-only
    // attribute, so the store stays readable and there is nothing to observe.
    if (process.platform === 'win32') return
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root ignores modes
    const deniedDir = join(tmpDir, 'denied')
    await mkdir(deniedDir, { recursive: true })
    const deniedDb = join(deniedDir, 'session-store.db')
    createSessionStoreDb(deniedDb)
    const eventsPath = await createSessionDir('sess-denied', [
      modelChange('claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 10 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 5100, outputTokens: 10, cacheReadTokens: 4000, cacheWriteTokens: 1000 },
        },
      }),
    ])

    if (process.platform === 'win32') return
    const { chmod } = await import('fs/promises')
    await chmod(deniedDir, 0o000)
    try {
      const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', deniedDb)
      const sources = await provider.discoverSessions()
      const store = sources.find(s => (s as { sourceType?: string }).sourceType === 'session-store')
      expect(store).toBeDefined()
      const consumeStore = async () => {
        for await (const _ of provider.createSessionParser(store!, new Set()).parse()) void _
      }
      await expect(consumeStore()).rejects.toSatisfy((err: unknown) => isSqliteBusyError(err))

      const jsonl = sources.find(s => s.path === eventsPath)!
      const calls: ParsedProviderCall[] = []
      for await (const call of provider.createSessionParser(jsonl, new Set()).parse()) calls.push(call)
      expect(calls.some(c => c.deduplicationKey === 'copilot:sess-denied:shutdown:claude-sonnet-4-5:1')).toBe(true)
    } finally {
      await chmod(deniedDir, 0o755)
    }
  })

  it('defers the store source when the DB becomes unopenable after discovery', async () => {
    // An EACCES/CANTOPEN race between discovery and parse must defer, not
    // fall through to the generic parse-failure path — that would cache a
    // failed marker at the current fingerprint and zero the covered
    // sessions until the file next changes.
    // Windows has no POSIX mode denial: chmod only toggles the read-only
    // attribute, so the store stays readable and there is nothing to observe.
    if (process.platform === 'win32') return
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root ignores modes
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, { sessionId: 'sess-open', model: 'gpt-5', inputTokens: 1000, cacheReadTokens: 400 })

    const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', dbPath)
    const sources = await provider.discoverSessions()
    const store = sources.find(s => (s as { sourceType?: string }).sourceType === 'session-store')!

    const { chmod } = await import('fs/promises')
    await chmod(dbPath, 0o000)
    try {
      const consume = async () => {
        for await (const _ of provider.createSessionParser(store, new Set()).parse()) void _
      }
      await expect(consume()).rejects.toSatisfy((err: unknown) => isSqliteBusyError(err))
    } finally {
      await chmod(dbPath, 0o644)
    }
  })

  it('defers the store parse when the schema changes mid-run', async () => {
    // Discovery prepare-validated the schema this run, so a query failure at
    // parse time proves a mid-run migration. Falling through to the generic
    // parse-failure path would cache an EMPTY success at the current
    // fingerprint while cached rows keep suppressing rollups at serve time —
    // a silent under-count until the file next changes. Defer instead.
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, { sessionId: 'sess-migrate', model: 'gpt-5', inputTokens: 1000, cacheReadTokens: 400 })
    const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', dbPath)
    const sources = await provider.discoverSessions()
    const store = sources.find(s => (s as { sourceType?: string }).sourceType === 'session-store')!

    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
    const migrator = new DatabaseSync(dbPath)
    migrator.exec('ALTER TABLE assistant_usage_events DROP COLUMN reasoning_tokens')
    migrator.close()

    const consume = async () => {
      for await (const _ of provider.createSessionParser(store, new Set()).parse()) void _
    }
    await expect(consume()).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
  })

  it('emits billable rows with an empty model as unknown instead of dropping them', async () => {
    // TEXT NOT NULL admits '': a billable row must never be dropped for an
    // unnameable model — serve-time precedence suppresses the session's
    // rollup whenever its store rows serve, so a skipped row's tokens would
    // simply vanish. Price as 'unknown' instead.
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, {
      sessionId: 'sess-nomodel', model: '',
      inputTokens: 10100, cacheReadTokens: 8000, cacheWriteTokens: 2000,
    })

    const calls = await collectCalls(storeSource(dbPath))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('unknown')
    expect(calls[0]!.inputTokens).toBe(100)
    expect(calls[0]!.cacheReadInputTokens).toBe(8000)
  })

  it('surfaces the source when the store is corrupt, and defers its parse', async () => {
    // Corruption-class failures (SQLITE_CORRUPT/NOTADB/CANTOPEN — measured as
    // the store's realistic failure modes; WAL write locks don't even block
    // readers) must NOT read as absence: the file may be mid atomic-replace
    // and readable next run. The source stays discovered — cached rows keep
    // serving and keep suppressing at serve time — while its parse defers
    // with the busy shape. Session-state files parse normally throughout.
    await writeFile(dbPath, 'not a sqlite database at all')
    const eventsPath = await createSessionDir('sess-corrupt', [
      modelChange('claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 100 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 10100, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 2000 },
        },
      }),
    ])

    const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', dbPath)
    const sources = await provider.discoverSessions()
    const store = sources.find(s => (s as { sourceType?: string }).sourceType === 'session-store')
    expect(store).toBeDefined()
    const consumeStore = async () => {
      for await (const _ of provider.createSessionParser(store!, new Set()).parse()) void _
    }
    await expect(consumeStore()).rejects.toMatchObject({ code: 'SQLITE_BUSY' })

    const jsonl = sources.find(s => s.path === eventsPath)!
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(jsonl, new Set()).parse()) calls.push(call)
    expect(calls.some(c => c.deduplicationKey === 'copilot:sess-corrupt:shutdown:claude-sonnet-4-5:1')).toBe(true)
  })

  it('treats a store whose schema the parser cannot read as absent', async () => {
    // A schema mismatch ("no such column") is a permanent shape, not a
    // transient failure: deferring would stall CLI parsing forever, and the
    // rollups ARE the right source for a store the parser can't read. The
    // probe runs the parser's exact query, so the mismatch is caught before
    // any rollup is suppressed.
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT);
      CREATE TABLE assistant_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER
      );
      INSERT INTO assistant_usage_events (session_id, model, input_tokens) VALUES ('sess-newschema', 'gpt-5', 900);
    `)
    db.close()

    const eventsPath = await createSessionDir('sess-newschema', [
      modelChange('claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 50 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 5100, outputTokens: 50, cacheReadTokens: 4000, cacheWriteTokens: 1000 },
        },
      }),
    ])

    const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', dbPath)
    const sources = await provider.discoverSessions()
    expect(sources.some(s => (s as { sourceType?: string }).sourceType === 'session-store')).toBe(false)

    const jsonl = sources.find(s => s.path === eventsPath)!
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(jsonl, new Set()).parse()) calls.push(call)
    expect(calls.some(c => c.deduplicationKey.includes(':shutdown:'))).toBe(true)
  })

  it('treats a store without assistant_usage_events as absent', async () => {
    // Older CLI builds create session-store.db without the usage table. The
    // source must not surface (and must not throw), and no session gets its
    // shutdown rollup suppressed.
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)')
    db.close()

    const eventsPath = await createSessionDir('sess-old-cli', [
      modelChange('claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 50 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': { inputTokens: 5100, outputTokens: 50, cacheReadTokens: 4000, cacheWriteTokens: 1000 },
        },
      }),
    ])

    const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', dbPath)
    const sources = await provider.discoverSessions()
    expect(sources.some(s => (s as { sourceType?: string }).sourceType === 'session-store')).toBe(false)

    const jsonl = sources.find(s => s.path === eventsPath)!
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(jsonl, new Set()).parse()) calls.push(call)
    expect(calls.some(c => c.deduplicationKey.includes(':shutdown:'))).toBe(true)
  })

  it('never emits an empty timestamp: falls back to the previous row, then sessions.created_at', async () => {
    // A call with an empty timestamp is invisible to every date-range filter
    // — the tokens would silently vanish from daily/monthly views while the
    // session's rollup stays suppressed. Rows are id-ordered, so the nearest
    // earlier row is the closest clock reading; a NULL on the very first row
    // falls back to the session's own created_at.
    createSessionStoreDb(dbPath)
    insertUsageRow(dbPath, {
      sessionId: 'sess-nots', model: 'gpt-5',
      inputTokens: 1000, cacheReadTokens: 400, createdAt: null,
      sessionCreatedAt: '2026-08-05T09:00:00.000Z',
    })
    insertUsageRow(dbPath, {
      sessionId: 'sess-nots', model: 'gpt-5',
      inputTokens: 2000, cacheReadTokens: 900, createdAt: '2026-08-05T09:05:00.000Z',
    })
    insertUsageRow(dbPath, {
      sessionId: 'sess-nots', model: 'gpt-5',
      inputTokens: 3000, cacheReadTokens: 1400, createdAt: null,
    })

    const calls = await collectCalls(storeSource(dbPath))
    expect(calls).toHaveLength(3)
    expect(calls[0]!.timestamp).toBe('2026-08-05T09:00:00.000Z') // sessions.created_at
    expect(calls[1]!.timestamp).toBe('2026-08-05T09:05:00.000Z') // its own created_at
    expect(calls[2]!.timestamp).toBe('2026-08-05T09:05:00.000Z') // previous row's
  })

  it('attributes store rows to the jsonl-derived project, over sessions.cwd', async () => {
    // The per-turn output calls carry the workspace.yaml-derived project,
    // and the session grouping key includes project — so a store row landing
    // under any OTHER label (the sessionId fallback for a NULL cwd, or a
    // stale/differing sessions.cwd) splits one real session into two.
    // Sessions with no session-state dir keep the cwd → repository →
    // sessionId fallback chain.
    createSessionStoreDb(dbPath)
    // The review's verbatim shape: NULL cwd AND repository, jsonl present.
    insertUsageRow(dbPath, {
      sessionId: 'sess-attr-null', model: 'gpt-5',
      inputTokens: 1000, cacheReadTokens: 400,
    })
    // A present-but-differing sessions.cwd must also lose to the jsonl label.
    insertUsageRow(dbPath, {
      sessionId: 'sess-attr-stale', model: 'gpt-5',
      inputTokens: 1500, cacheReadTokens: 600, cwd: '/home/user/stale-db-cwd',
    })
    insertUsageRow(dbPath, {
      sessionId: 'sess-nojsonl', model: 'gpt-5',
      inputTokens: 2000, cacheReadTokens: 900, cwd: '/home/user/db-only-proj',
    })
    await createSessionDir('sess-attr-null', [
      modelChange('gpt-5'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 10 }),
    ], '/home/user/jsonl-proj')
    await createSessionDir('sess-attr-stale', [
      modelChange('gpt-5'),
      assistantMessage({ messageId: 'msg-2', outputTokens: 10 }),
    ], '/home/user/jsonl-proj')

    const provider = createCopilotProvider(tmpDir, '/nonexistent/ws', '/nonexistent/global', '/nonexistent/jb', dbPath)
    const sources = await provider.discoverSessions()
    const store = sources.find(s => (s as { sourceType?: string }).sourceType === 'session-store')!

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(store, new Set()).parse()) calls.push(call)
    expect(calls.find(c => c.sessionId === 'sess-attr-null')!.project).toBe('jsonl-proj')
    expect(calls.find(c => c.sessionId === 'sess-attr-stale')!.project).toBe('jsonl-proj')
    expect(calls.find(c => c.sessionId === 'sess-nojsonl')!.project).toBe('db-only-proj')
  })
})

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
  // JetBrains records VirtualFile URLs: forward slashes throughout, and a
  // leading slash ahead of a Windows drive letter (file:///C:/repo/One.ts).
  function jbFileUrl(filePath: string): string {
    const slashed = filePath.replace(/\\/g, '/')
    return `file://${slashed.startsWith('/') ? '' : '/'}${slashed}`
  }

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
        value: JSON.stringify({ type: 'References', data: opts.files.map(jbFileUrl).join(' ') }),
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

describe('copilot provider - legacy JSON format', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-legacy-'))
  })
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('parses legacy JSON session with string message and markdownContent response', async () => {
    const session = {
      sessionId: 'sess-json-001',
      creationDate: 1718000000000,
      requests: [
        {
          requestId: 'req-1',
          message: 'explain quantum physics',
          modelId: 'copilot/gpt-4o',
          response: [
            {
              kind: 'markdownContent',
              content: { value: 'Quantum physics is...' }
            }
          ]
        }
      ]
    }

    const filePath = join(tmpDir, 'session-1.json')
    await writeFile(filePath, JSON.stringify(session))

    const source = { path: filePath, project: 'test-project', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe('copilot')
    expect(calls[0]!.model).toBe('gpt-4o')
    expect(calls[0]!.userMessage).toBe('explain quantum physics')
    expect(calls[0]!.inputTokens).toBeGreaterThan(0)
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
  })

  it('infers model when modelId is missing on the request', async () => {
    const session = {
      requests: [
        {
          requestId: 'req-1',
          message: 'hello',
          response: [
            {
              kind: 'toolInvocationSerialized',
              toolCallId: 'tooluse_abc123',
              toolId: 'read_file'
            }
          ]
        }
      ]
    }

    const filePath = join(tmpDir, 'session-2.json')
    await writeFile(filePath, JSON.stringify(session))

    const source = { path: filePath, project: 'test-project', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('copilot-anthropic-auto')
  })

  it('extracts thinking/reasoning text and reasoning tokens', async () => {
    const session = {
      requests: [
        {
          requestId: 'req-1',
          message: 'solve this',
          modelId: 'copilot/claude-sonnet-4.5',
          response: [
            {
              kind: 'thinking',
              value: 'Let me analyze the problem step by step.'
            },
            {
              kind: 'markdownContent',
              content: { value: 'The solution is 42.' }
            }
          ]
        }
      ]
    }

    const filePath = join(tmpDir, 'session-3.json')
    await writeFile(filePath, JSON.stringify(session))

    const source = { path: filePath, project: 'test-project', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.reasoningTokens).toBeGreaterThan(0)
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
  })

  it('extracts tool result content from serialized tool invocations', async () => {
    const base64Data = Buffer.from('simulated file read content', 'utf8').toString('base64')
    const session = {
      requests: [
        {
          requestId: 'req-1',
          message: 'read file',
          modelId: 'copilot/gpt-4o',
          response: [
            {
              kind: 'toolInvocationSerialized',
              toolId: 'read_file',
              resultDetails: {
                output: {
                  type: 'data',
                  mimeType: 'text/plain',
                  base64Data: base64Data
                }
              }
            }
          ]
        }
      ]
    }

    const filePath = join(tmpDir, 'session-4.json')
    await writeFile(filePath, JSON.stringify(session))

    const source = { path: filePath, project: 'test-project', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    // inputTokens should include the message + decoded base64 tool result (approx 7 + 7 tokens)
    expect(calls[0]!.inputTokens).toBe(10)
  })

  it('uses exact root token properties when present', async () => {
    const session = {
      requests: [
        {
          requestId: 'req-1',
          message: 'hello',
          modelId: 'copilot/gpt-4o',
          promptTokens: 100,
          completionTokens: 200
        }
      ]
    }

    const filePath = join(tmpDir, 'session-5.json')
    await writeFile(filePath, JSON.stringify(session))

    const source = { path: filePath, project: 'test-project', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(100)
    expect(calls[0]!.outputTokens).toBe(200)
    expect(calls[0]!.costIsEstimated).toBe(false)
  })
})
// ═══════════════════════════════════════════════════════════════════════════
// Dedup-key shapes are a CACHE contract, not an implementation detail
// ═══════════════════════════════════════════════════════════════════════════
// Copilot is durable: on a parse-version bump the cache is carried forward and
// the re-parse is UNIONED into it by deduplicationKey (src/parser.ts,
// getOrCreateProviderSection + the durable merge). A key that changes shape is
// therefore a key the union cannot recognise, and every call behind it is
// counted a second time — silently, permanently, on upgrade.
//
// So: changing, adding or removing any prefix below is a CACHE_VERSION bump,
// not a PROVIDER_PARSE_VERSIONS bump. Deliberately a literal list rather than
// a derived one — the point is that a diff to it is impossible to miss.
describe('copilot deduplication key prefixes (durable-union contract)', () => {
  it('pins every emitted key shape, read back out of the source', async () => {
    const { readFile } = await import('node:fs/promises')
    const here = dirname(fileURLToPath(import.meta.url))
    const read = async (rel: string): Promise<string> => readFile(join(here, '..', '..', rel), 'utf8')

    // Every dedup key this provider mints is a template literal starting with
    // `copilot`. Collapse the interpolations so the test pins the SHAPE, not
    // the variable names, and compare the whole set: a new key shape fails
    // this just as loudly as a changed one.
    const shapes = new Set<string>()
    for (const src of [await read('src/providers/copilot.ts'), await read('src/parser.ts')]) {
      for (const m of src.matchAll(/`(copilot[^`]*)`/g)) {
        const raw = m[1]!
        if (!raw.includes('${')) continue
        const shape = raw.replace(/\$\{[^}]*\}/g, '$').replace(/\s+/g, '')
        if (!shape.includes(':')) continue
        shapes.add(shape)
      }
    }

    expect([...shapes].sort()).toEqual([
      // ── minted keys ────────────────────────────────────────────────────
      'copilot-chatsession:$:$',            // VS Code core chatSessions
      'copilot-otel:$',                     // agent-traces.db span
      'copilot-store:$:$:${fnv1a64(',       // session-store row + content hash
      'copilot:$:$',                        // CLI per-turn assistant.message
      'copilot:$:shutdown-residual:$:$',    // parser.ts; <model>:<leg epoch ms>
      'copilot:$:shutdown:$:$',             // session.shutdown rollup leg
      'copilot:jb:$:$:$',                   // JetBrains nitrite conversation
      // ── discriminator prefixes, not keys ───────────────────────────────
      // parseProviderSources tells the representations apart with these, and
      // sync's rollup-vs-reconciled shape split keys off the same boundary.
      // They belong in the pin: a rollup prefix that stopped excluding
      // `shutdown-residual` would subtract a residual from itself locally, and
      // remotely would class reconciled output as the rollup it replaces.
      'copilot:$:shutdown',
      'copilot:$:shutdown:',
    ].sort())
  })

  it('keeps the shapes the reconciliation discriminates on distinguishable', () => {
    // parseProviderSources tells the three copilot representations apart by
    // prefix alone. `:shutdown:` must not also match a residual, and a store
    // row must not match either — otherwise a rollup is dropped as a row, or a
    // residual is subtracted from itself.
    const rollup = 'copilot:sess-1:shutdown:claude-sonnet-4-5:1'
    const residual = 'copilot:sess-1:shutdown-residual:claude-sonnet-4-5:1752000000000'
    const row = 'copilot-store:sess-1:7:abcdef0123456789'
    const perTurn = 'copilot:sess-1:msg-1'

    const shutdownPrefix = 'copilot:sess-1:shutdown:'
    expect(rollup.startsWith(shutdownPrefix)).toBe(true)
    expect(residual.startsWith(shutdownPrefix)).toBe(false)
    expect(row.startsWith(shutdownPrefix)).toBe(false)
    expect(perTurn.startsWith(shutdownPrefix)).toBe(false)
    expect(row.startsWith('copilot-store:')).toBe(true)
    expect(rollup.startsWith('copilot-store:')).toBe(false)
    // And sync's shape split keys off the same boundary (src/sync/push.ts):
    // the raw rollup is one shape, rows + residuals together are the other.
    expect(rollup.indexOf(':shutdown:')).toBeGreaterThan(0)
    expect(residual.indexOf(':shutdown:')).toBe(-1)
    expect(residual.includes(':shutdown-residual:')).toBe(true)
    // The residual's last segment is the leg's epoch ms, not its index — a
    // position renames under insertion, and a renamed key double-counts at a
    // receiver that was already sent the old name.
    expect(/:shutdown-residual:[^:]+:\d{13}$/.test(residual)).toBe(true)
  })
})
