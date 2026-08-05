import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { createCopilotProvider } from '../../src/providers/copilot.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'copilot-bridge-'))
  // Disable OTel discovery by default; OTel scenarios override this.
  vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

// -----------------------------------------------------------------------------
// JSONL / CLI session-state fixture builders (copied from copilot.test.ts)
// -----------------------------------------------------------------------------

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

function subagentSelected(agentName: string) {
  return JSON.stringify({ type: 'subagent.selected', timestamp: '2026-04-15T10:00:12Z', data: { agentName } })
}

function assistantMessage(opts: {
  messageId: string
  outputTokens: number
  tools?: string[]
  toolArgs?: Record<string, unknown>[]
  timestamp?: string
}) {
  const toolRequests = (opts.tools ?? []).map((name, i) => ({
    name,
    toolCallId: `call-${name}`,
    type: 'function',
    ...(opts.toolArgs?.[i] ? { arguments: opts.toolArgs[i] } : {}),
  }))
  return JSON.stringify({
    type: 'assistant.message',
    timestamp: opts.timestamp ?? '2026-04-15T10:00:15Z',
    data: {
      messageId: opts.messageId,
      outputTokens: opts.outputTokens,
      interactionId: 'int-1',
      toolRequests,
    },
  })
}

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

function transcriptAssistantMessage(opts: {
  messageId: string
  content?: string
  reasoningText?: string
  toolCallIds?: string[]
  toolNames?: string[]
}) {
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

// -----------------------------------------------------------------------------
// chatSessions fixture builders (copied from copilot.test.ts)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// OTel fixture builders (copied from copilot.test.ts)
// -----------------------------------------------------------------------------

interface SpanDef {
  spanId: string
  traceId: string
  operationName: string
  startTimeMs?: number
  responseModel?: string
  attrs: Record<string, string | number>
}

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

interface TestDb {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
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

// -----------------------------------------------------------------------------
// JetBrains fixture builders (copied from copilot.test.ts)
// -----------------------------------------------------------------------------

function jbDbSource(path: string, sessionId: string, mtime = '2026-07-03T12:00:00.000Z') {
  return {
    path,
    project: 'copilot-jetbrains',
    provider: 'copilot',
    sourceType: 'jetbrains',
    sessionId,
    storeId: sessionId,
    dbPath: path,
    mtime,
  } as unknown as { path: string; project: string; provider: string; sourceType?: string }
}

function jbAssistantBlob(text: string, opts: { model?: string; errored?: boolean; files?: string[] } = {}) {
  const innerMd = { type: 'Markdown', data: JSON.stringify({ text, annotations: [] }) }
  const valueMap: Record<string, unknown> = {
    'a1b2c3d4-0000-0000-0000-000000000001': { type: 'Value', value: JSON.stringify(innerMd) },
  }
  if (opts.model) valueMap['__model__'] = { type: 'Value', value: `{"model":"${opts.model}"}` }
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
    outer['__err__'] = {
      type: 'Value',
      value: JSON.stringify({ type: 'Error', message: 'Sorry, an error occurred while generating a response' }),
    }
  }
  return JSON.stringify(outer)
}

function jbAgentBlob(rounds: string[], opts: { model?: string; userPrompt?: string; errored?: boolean } = {}) {
  const valueMap: Record<string, unknown> = {}
  let n = 0
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

function jbConversationRecord(guid: string, title: string) {
  return `$${guid}t\x00\x04namesq\x00\x01?@\x00\x00w\x00\x00t\x00value t\x00${title}t\x00\x06sourcet\x00copilotx`
}

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

function jbProjectNameField(name: string) {
  const len = Buffer.byteLength(name, 'utf8')
  const hi = String.fromCharCode((len >> 8) & 0xff)
  const lo = String.fromCharCode(len & 0xff)
  return `t\x00\x0bprojectName\x74${hi}${lo}${name}t\x00\x04usert\x00\x08dev-user`
}

function jbOldFormatDoc(rounds: Array<{ reply: string; model?: string }>, opts: { upperUuid?: boolean } = {}) {
  const cased = (u: string) => (opts.upperUuid ? u.toUpperCase() : u)
  const entries: Record<string, unknown> = {}
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
  return '\x81' + JSON.stringify(entries)
}

// -----------------------------------------------------------------------------
// Capture helper
// -----------------------------------------------------------------------------

async function capture(source: Record<string, unknown>) {
  const provider = createCopilotProvider('/nonexistent/jsonl', '/nonexistent/ws')
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source as never, seen).parse()) {
    calls.push(call)
  }
  return { calls, seen }
}

// -----------------------------------------------------------------------------
// Captured goldens (from the unmodified provider)
// -----------------------------------------------------------------------------

const G1_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "sess-g1",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 150,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [
      "Read",
      "mcp__github_mcp_server__list_issues"
    ],
    "bashCommands": [],
    "subagentTypes": [
      "github.copilot.editsAgent"
    ],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g1:msg-1",
    "userMessage": "run the migration"
  },
  {
    "provider": "copilot",
    "sessionId": "sess-g1",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 80,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [
      "Bash",
      "Skill"
    ],
    "bashCommands": [
      "ls"
    ],
    "skills": [
      "refactor"
    ],
    "subagentTypes": [
      "github.copilot.editsAgent"
    ],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g1:msg-2",
    "userMessage": ""
  }
]

const G1_KEYS = [
  "copilot:sess-g1:msg-1",
  "copilot:sess-g1:msg-2"
]

const G2_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "sess-g2",
    "model": "copilot-openai-auto",
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [
      "Read"
    ],
    "bashCommands": [],
    "timestamp": "",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g2:msg-1",
    "userMessage": "mixed transcript"
  },
  {
    "provider": "copilot",
    "sessionId": "sess-g2",
    "model": "copilot-openai-auto",
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [
      "Read"
    ],
    "bashCommands": [],
    "timestamp": "",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g2:msg-2",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "sess-g2",
    "model": "copilot-openai-auto",
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [
      "Read",
      "Shell"
    ],
    "bashCommands": [],
    "timestamp": "",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g2:msg-3",
    "userMessage": ""
  }
]

const G2_KEYS = [
  "copilot:sess-g2:msg-1",
  "copilot:sess-g2:msg-2",
  "copilot:sess-g2:msg-3"
]

const G3_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "sess-g3",
    "model": "claude-sonnet-4-5",
    "inputTokens": 0,
    "outputTokens": 100,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g3:msg-1",
    "userMessage": "first"
  },
  {
    "provider": "copilot",
    "sessionId": "sess-g3",
    "model": "gpt-5",
    "inputTokens": 0,
    "outputTokens": 200,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g3:msg-2",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "sess-g3",
    "model": "claude-sonnet-4-5",
    "inputTokens": 100,
    "outputTokens": 0,
    "cacheCreationInputTokens": 2000,
    "cacheReadInputTokens": 8000,
    "cachedInputTokens": 0,
    "reasoningTokens": 15,
    "webSearchRequests": 0,
    "costUSD": 0.0102,
    "costIsEstimated": false,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:05:00Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g3:shutdown:claude-sonnet-4-5",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "sess-g3",
    "model": "gpt-5",
    "inputTokens": 50,
    "outputTokens": 0,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 5000,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costUSD": 0.0006875,
    "costIsEstimated": false,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:05:00Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g3:shutdown:gpt-5",
    "userMessage": ""
  }
]

const G3_KEYS = [
  "copilot:sess-g3:msg-1",
  "copilot:sess-g3:msg-2",
  "copilot:sess-g3:shutdown:claude-sonnet-4-5",
  "copilot:sess-g3:shutdown:gpt-5"
]

const G3_PRICED_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "sess-g3",
    "model": "claude-sonnet-4-5",
    "inputTokens": 0,
    "outputTokens": 100,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g3:msg-1",
    "userMessage": "first",
    "costUSD": 0.0015
  },
  {
    "provider": "copilot",
    "sessionId": "sess-g3",
    "model": "gpt-5",
    "inputTokens": 0,
    "outputTokens": 200,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g3:msg-2",
    "userMessage": "",
    "costUSD": 0.002
  },
  {
    "provider": "copilot",
    "sessionId": "sess-g3",
    "model": "claude-sonnet-4-5",
    "inputTokens": 100,
    "outputTokens": 0,
    "cacheCreationInputTokens": 2000,
    "cacheReadInputTokens": 8000,
    "cachedInputTokens": 0,
    "reasoningTokens": 15,
    "webSearchRequests": 0,
    "costUSD": 0.0102,
    "costIsEstimated": false,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:05:00Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g3:shutdown:claude-sonnet-4-5",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "sess-g3",
    "model": "gpt-5",
    "inputTokens": 50,
    "outputTokens": 0,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 5000,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costUSD": 0.0006875,
    "costIsEstimated": false,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:05:00Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-g3:shutdown:gpt-5",
    "userMessage": ""
  }
]

const G4_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "g4-session",
    "project": "myproject",
    "model": "claude-sonnet-4-6",
    "inputTokens": 32543,
    "outputTokens": 60,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-05-30T16:05:13.100Z",
    "speed": "standard",
    "deduplicationKey": "copilot-chatsession:g4-session:req-resolved",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "g4-session",
    "project": "myproject",
    "model": "gpt-4.1",
    "inputTokens": 1200,
    "outputTokens": 90,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-05-30T16:05:13.200Z",
    "speed": "standard",
    "deduplicationKey": "copilot-chatsession:g4-session:req-fallback",
    "userMessage": ""
  }
]

const G4_KEYS = [
  "copilot-chatsession:g4-session:req-fallback",
  "copilot-chatsession:g4-session:req-resolved"
]

const G5_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "485825c0-3331-46a7-acb2-c71875ad6640",
    "project": "shared-utils",
    "model": "claude-opus-4-5",
    "inputTokens": 0,
    "outputTokens": 7,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:d81513544dac:1",
    "userMessage": "Conversation B"
  },
  {
    "provider": "copilot",
    "sessionId": "485825c0-3331-46a7-acb2-c71875ad6640",
    "project": "shared-utils",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 10,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:77ecc7a691b9:1",
    "userMessage": "Conversation B"
  },
  {
    "provider": "copilot",
    "sessionId": "485825c0-3331-46a7-acb2-c71875ad6640",
    "project": "shared-utils",
    "model": "claude-opus-4-5",
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:b613679a0814:1",
    "userMessage": "Conversation B"
  },
  {
    "provider": "copilot",
    "sessionId": "485825c0-3331-46a7-acb2-c71875ad6640",
    "project": "shared-utils",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 9,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:12086ad693b4:1",
    "userMessage": "Conversation B"
  }
]

const G5_KEYS = [
  "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:12086ad693b4:1",
  "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:77ecc7a691b9:1",
  "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:b613679a0814:1",
  "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:d81513544dac:1"
]

const G6_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "17a5d71b-27f7-4937-8803-7fc2cbb705cb",
    "project": "copilot-jetbrains",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 29,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:17a5d71b-27f7-4937-8803-7fc2cbb705cb:1950183ecfb1:1",
    "userMessage": "Understanding HBase Architecture"
  }
]

const G6_KEYS = [
  "copilot:jb:17a5d71b-27f7-4937-8803-7fc2cbb705cb:1950183ecfb1:1"
]

const G7_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "conv-g7",
    "project": "copilot-chat",
    "model": "gpt-4.1",
    "inputTokens": 1200,
    "outputTokens": 150,
    "cacheCreationInputTokens": 300,
    "cacheReadInputTokens": 30000,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [
      "Shell"
    ],
    "bashCommands": [
      "echo",
      "git",
      "npm"
    ],
    "timestamp": "1970-01-01T00:16:40.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-otel:span-g7-chat-1",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "conv-g7",
    "project": "copilot-chat",
    "model": "claude-haiku-4.5",
    "inputTokens": 400,
    "outputTokens": 50,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "subagentTypes": [
      "Explore"
    ],
    "timestamp": "1970-01-01T00:35:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-otel:span-g7-sub-chat",
    "userMessage": ""
  }
]

const G7_KEYS = [
  "copilot-otel:span-g7-chat-1",
  "copilot-otel:span-g7-sub-chat",
  "copilot:conv-g7:turn-g7-1"
]

const G8_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "conv-g8-b",
    "project": "copilot-chat",
    "model": "claude-sonnet-4",
    "inputTokens": 600,
    "outputTokens": 120,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "1970-01-01T00:33:20.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-otel:span-g8-b-chat",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "conv-g8-a",
    "project": "repo",
    "model": "gpt-4.1",
    "inputTokens": 500,
    "outputTokens": 100,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "1970-01-01T00:16:40.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-otel:span-g8-a-chat",
    "userMessage": ""
  }
]

const G8_KEYS = [
  "copilot-otel:span-g8-a-chat",
  "copilot-otel:span-g8-b-chat"
]

const G9_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "sess-x1",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 42,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-x1:msg-emit",
    "userMessage": "keep me pending"
  },
  {
    "provider": "copilot",
    "sessionId": "sess-x1",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 7,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-x1:msg-after",
    "userMessage": ""
  }
]

const G9_KEYS = [
  "copilot:sess-x1:msg-after",
  "copilot:sess-x1:msg-emit"
]

const G10_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "sess-x2",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 10,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-x2:msg-1",
    "userMessage": ""
  }
]

const G10_KEYS = [
  "copilot:sess-x2:msg-1"
]

const G11_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "sess-x4",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 5,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-04-15T10:00:15Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-x4:msg-1",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "sess-x4",
    "model": "clamped",
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 50,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costUSD": 0,
    "costIsEstimated": false,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-15T07:54:00.274Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-x4:shutdown:clamped",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "sess-x4",
    "model": "gpt-4.1",
    "inputTokens": 700,
    "outputTokens": 0,
    "cacheCreationInputTokens": 100,
    "cacheReadInputTokens": 200,
    "cachedInputTokens": 0,
    "reasoningTokens": 7,
    "webSearchRequests": 0,
    "costUSD": 0.00175,
    "costIsEstimated": false,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-15T07:54:00.274Z",
    "speed": "standard",
    "deduplicationKey": "copilot:sess-x4:shutdown:gpt-4.1",
    "userMessage": ""
  }
]

const G11_KEYS = [
  "copilot:sess-x4:msg-1",
  "copilot:sess-x4:shutdown:clamped",
  "copilot:sess-x4:shutdown:gpt-4.1"
]

const G12_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "x16-fallback",
    "project": "myproject",
    "model": "unknown",
    "inputTokens": 10,
    "outputTokens": 490,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [
      "Read",
      "Bash",
      "mcp__github_mcp_server__list_issues",
      "Shell",
      "Skill"
    ],
    "bashCommands": [],
    "timestamp": "2026-05-01T08:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-chatsession:x16-fallback:req-tools",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "x16-fallback",
    "project": "myproject",
    "model": "unknown",
    "inputTokens": 3,
    "outputTokens": 4,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-05-01T08:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-chatsession:x16-fallback:req-unknown-model",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "x16-fallback",
    "project": "myproject",
    "model": "gpt-4.1",
    "inputTokens": 5,
    "outputTokens": 6,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-05-01T08:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-chatsession:x16-fallback:request-2",
    "userMessage": ""
  }
]

const G12_KEYS = [
  "copilot-chatsession:x16-fallback:req-tools",
  "copilot-chatsession:x16-fallback:req-unknown-model",
  "copilot-chatsession:x16-fallback:request-2"
]

const G13_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "485825c0-3331-46a7-acb2-c71875ad6640",
    "project": "web-api",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 9,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:12086ad693b4:1",
    "userMessage": "Conversation X7"
  },
  {
    "provider": "copilot",
    "sessionId": "485825c0-3331-46a7-acb2-c71875ad6640",
    "project": "web-api",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 9,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:5b8342db2b62:1",
    "userMessage": "Conversation X7"
  }
]

const G13_KEYS = [
  "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:12086ad693b4:1",
  "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:5b8342db2b62:1"
]

const G14_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "485825c0-3331-46a7-acb2-c71875ad6640",
    "project": "pipe|repo",
    "model": "gpt-4.1",
    "inputTokens": 0,
    "outputTokens": 8,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:f4ee234a9585:1",
    "userMessage": "Conversation X8"
  }
]

const G14_KEYS = [
  "copilot:jb:485825c0-3331-46a7-acb2-c71875ad6640:f4ee234a9585:1"
]

const G15_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "x17-store",
    "project": "copilot-jetbrains",
    "model": "copilot-anthropic-auto",
    "inputTokens": 0,
    "outputTokens": 5,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:x17-store:84b5586a1750:1",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "x17-store",
    "project": "copilot-jetbrains",
    "model": "copilot-anthropic-auto",
    "inputTokens": 0,
    "outputTokens": 6,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "costIsEstimated": true,
    "tools": [],
    "bashCommands": [],
    "timestamp": "2026-07-03T12:00:00.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot:jb:x17-store:6e05b7ba9bf8:1",
    "userMessage": ""
  }
]

const G15_KEYS = [
  "copilot:jb:x17-store:6e05b7ba9bf8:1",
  "copilot:jb:x17-store:84b5586a1750:1"
]

const G16_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "conv-x11",
    "project": "copilot-chat",
    "model": "",
    "inputTokens": 10,
    "outputTokens": 5,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "1970-01-01T00:16:40.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-otel:span-x11",
    "userMessage": ""
  }
]

const G16_KEYS = [
  "copilot-otel:span-x11"
]

const G17_GOLDEN: ParsedProviderCall[] = [
  {
    "provider": "copilot",
    "sessionId": "conv-x12-b",
    "project": "copilot-chat",
    "model": "gpt-4.1",
    "inputTokens": 100,
    "outputTokens": 20,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "1970-01-01T00:16:40.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-otel:span-x12-shared",
    "userMessage": ""
  },
  {
    "provider": "copilot",
    "sessionId": "conv-x12-b",
    "project": "copilot-chat",
    "model": "gpt-5",
    "inputTokens": 7,
    "outputTokens": 3,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "webSearchRequests": 0,
    "costBasis": "estimated",
    "tools": [],
    "bashCommands": [],
    "timestamp": "1970-01-01T00:33:20.000Z",
    "speed": "standard",
    "deduplicationKey": "copilot-otel:span-x12-b-own",
    "userMessage": ""
  }
]

const G17_KEYS = [
  "copilot-otel:span-x12-b-own",
  "copilot-otel:span-x12-shared",
  "copilot:conv-x12-b:turn-x12"
]

// -----------------------------------------------------------------------------
// Golden scenarios
// -----------------------------------------------------------------------------

describe('copilot bridge — fixture parity', () => {
  it('G1 jsonl CLI format: model_change, user message, tools, bash chain, skill, subagent', async () => {
    const eventsPath = await createSessionDir('sess-g1', [
      modelChange('gpt-4.1'),
      userMessage('run the migration'),
      subagentSelected('github.copilot.editsAgent'),
      assistantMessage({
        messageId: 'msg-1',
        outputTokens: 150,
        tools: ['read_file', 'github-mcp-server-list_issues'],
      }),
      assistantMessage({
        messageId: 'msg-2',
        outputTokens: 80,
        tools: ['bash', 'skill'],
        toolArgs: [
          { command: 'cd x && ls -la' },
          { skill: 'refactor' },
        ],
      }),
    ])
    const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }
    const { calls, seen } = await capture(source)
    expect(calls).toEqual(G1_GOLDEN)
    expect([...seen].sort()).toEqual(G1_KEYS)
  })

  it('G2 jsonl transcript: copilot-agent producer with mixed toolCallIds', async () => {
    const eventsPath = await createSessionDir('sess-g2', [
      transcriptSessionStart('sess-g2'),
      transcriptUserMessage('mixed transcript'),
      transcriptAssistantMessage({ messageId: 'msg-1', content: 'one', toolCallIds: ['call_a'] }),
      transcriptAssistantMessage({ messageId: 'msg-2', content: 'two', toolCallIds: ['tooluse_XY'] }),
      transcriptAssistantMessage({ messageId: 'msg-3', content: 'three', toolCallIds: ['call_b', 'call_c'] }),
    ])
    const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }
    const { calls, seen } = await capture(source)
    expect(calls).toEqual(G2_GOLDEN)
    expect([...seen].sort()).toEqual(G2_KEYS)
  })

  it('G3 jsonl shutdown rollup: two models, reasoning, cache-inclusive input', async () => {
    const eventsPath = await createSessionDir('sess-g3', [
      modelChange('claude-sonnet-4-5'),
      userMessage('first'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 100 }),
      modelChange('gpt-5', 'claude-sonnet-4-5'),
      assistantMessage({ messageId: 'msg-2', outputTokens: 200 }),
      shutdownEvent({
        modelMetrics: {
          'claude-sonnet-4-5': {
            inputTokens: 10100,
            outputTokens: 100,
            cacheReadTokens: 8000,
            cacheWriteTokens: 2000,
            reasoningTokens: 15,
          },
          'gpt-5': {
            inputTokens: 5050,
            outputTokens: 200,
            cacheReadTokens: 5000,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        },
      }),
    ])
    const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }
    const { calls, seen } = await capture(source)
    expect(calls).toEqual(G3_GOLDEN)
    expect([...seen].sort()).toEqual(G3_KEYS)
    expect(calls.map(priceProviderCall)).toEqual(G3_PRICED_GOLDEN)
  })

  it('G4 chatsession: kind 0/1/2 journal, resolvedModel, fallback modelId, zero-token skip', async () => {
    const filePath = join(tmpDir, 'g4.jsonl')
    await createChatSessionFile(filePath, [
      { kind: 0, v: { version: 3, creationDate: 1780157113020, sessionId: 'g4-session', requests: [] } },
      {
        kind: 1,
        k: ['requests'],
        v: [
          chatSessionSampleRequest({
            requestId: 'req-resolved',
            timestamp: 1780157113100,
          }),
        ],
      },
      {
        kind: 2,
        k: ['requests'],
        v: [
          chatSessionSampleRequest({
            requestId: 'req-fallback',
            modelId: 'copilot/gpt-4.1',
            timestamp: 1780157113200,
            result: { metadata: { promptTokens: 1200, outputTokens: 90 } },
          }),
          chatSessionSampleRequest({
            requestId: 'req-zero',
            modelId: 'copilot/gpt-4.1',
            timestamp: 1780157113300,
            completionTokens: 0,
            result: { metadata: { promptTokens: 0, outputTokens: 0 } },
          }),
        ],
      },
    ])
    const source = { path: filePath, project: 'myproject', provider: 'copilot', sourceType: 'chatsession' }
    const { calls, seen } = await capture(source)
    expect(calls).toEqual(G4_GOLDEN)
    expect([...seen].sort()).toEqual(G4_KEYS)
  })

  it('G5 jetbrains new format: ask, agent decoy, errored, two conversations, file:// repo, projectName', async () => {
    const repoDir = join(tmpDir, 'container', 'web-api')
    await mkdir(join(repoDir, '.git'), { recursive: true })
    const repoFile = join(repoDir, 'src', 'Main.java')

    const guidA = '6acf5299-f9f7-404f-812d-dbe8300e1e5b'
    const guidB = '485825c0-3331-46a7-acb2-c71875ad6640'

    const content = jbDbContent(
      [
        jbProjectNameField('shared-utils'),
        jbAssistantBlob('Ask-mode answer in markdown.', { model: 'claude-opus-4.5' }),
        jbAgentBlob(['AgentRound reply, not the user prompt.'], { model: 'gpt-4.1', userPrompt: 'summarise this repo' }),
        jbAssistantBlob('', { errored: true }),
        jbAssistantBlob('Answer referencing a real repo file.', { model: 'gpt-4.1', files: [repoFile] }),
      ],
      [
        jbConversationRecord(guidA, 'Conversation A'),
        jbConversationRecord(guidB, 'Conversation B'),
      ]
    )
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'g5-store', content)
    const { calls, seen } = await capture({ ...jbDbSource(dbPath, 'g5-store'), projectName: 'shared-utils' })
    expect(calls).toEqual(G5_GOLDEN)
    expect([...seen].sort()).toEqual(G5_KEYS)
  })

  it('G6 jetbrains old format (<=1.5.x): outer UUID-keyed Value document with AgentRound, uppercase UUIDs', async () => {
    const convGuid = '17a5d71b-27f7-4937-8803-7fc2cbb705cb'
    const oldFormatContent =
      'H:2,block:8,blockSize:1000,format:3\n' +
      'com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n' +
      jbConversationRecord(convGuid, 'Understanding HBase Architecture') + '\n' +
      jbOldFormatDoc(
        [
          { reply: "I'll scan the repository to find the top-level project structure.", model: 'gpt-4.1' },
          { reply: "Now I'll open the README to explain architecture." },
          { reply: '' },
        ],
        { upperUuid: true }
      )
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'g6-store', oldFormatContent)
    const { calls, seen } = await capture(jbDbSource(dbPath, 'g6-store'))
    expect(calls).toEqual(G6_GOLDEN)
    expect([...seen].sort()).toEqual(G6_KEYS)
  })

  it('G7 otel single conversation: tokens, multi-line shell, subagent, root agent, zero-token skip', async () => {
    if (!isSqliteAvailable()) return
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '')
    const dbPath = join(tmpDir, 'agent-traces.db')
    vi.stubEnv('CODEBURN_COPILOT_OTEL_DB', dbPath)
    createOtelDb(dbPath)

    insertSpan(dbPath, {
      spanId: 'span-g7-chat-1',
      traceId: 'trace-g7',
      operationName: 'chat',
      startTimeMs: 1000,
      responseModel: 'gpt-4.1',
      attrs: {
        'gen_ai.conversation.id': 'conv-g7',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 1200,
        'gen_ai.usage.output_tokens': 150,
        'gen_ai.usage.cache_read.input_tokens': 30000,
        'gen_ai.usage.cache_creation.input_tokens': 300,
        'github.copilot.chat.turn.id': 'turn-g7-1',
      },
    })

    insertSpan(dbPath, {
      spanId: 'span-g7-tool',
      traceId: 'trace-g7',
      operationName: 'execute_tool',
      startTimeMs: 1500,
      attrs: {
        'gen_ai.conversation.id': 'conv-g7',
        'gen_ai.tool.name': 'runInTerminal',
        'gen_ai.tool.call.arguments': JSON.stringify({
          command: 'for f in *.ts; do\n  echo "$f"\ndone\ngit status\nnpm test',
        }),
      },
    })

    insertSpan(dbPath, {
      spanId: 'span-g7-subagent',
      traceId: 'trace-g7-sub',
      operationName: 'invoke_agent',
      startTimeMs: 2000,
      attrs: {
        'gen_ai.conversation.id': 'conv-g7',
        'gen_ai.agent.name': 'Explore',
        'copilot_chat.parent_chat_session_id': 'conv-g7',
      },
    })

    insertSpan(dbPath, {
      spanId: 'span-g7-sub-chat',
      traceId: 'trace-g7-sub',
      operationName: 'chat',
      startTimeMs: 2100,
      responseModel: 'claude-haiku-4.5',
      attrs: {
        'gen_ai.conversation.id': 'conv-g7',
        'gen_ai.response.model': 'claude-haiku-4.5',
        'gen_ai.usage.input_tokens': 400,
        'gen_ai.usage.output_tokens': 50,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.cache_creation.input_tokens': 0,
      },
    })

    insertSpan(dbPath, {
      spanId: 'span-g7-root-agent',
      traceId: 'trace-g7-root',
      operationName: 'invoke_agent',
      startTimeMs: 3000,
      attrs: {
        'gen_ai.conversation.id': 'conv-g7',
        'gen_ai.agent.name': 'GitHub Copilot Chat',
      },
    })

    insertSpan(dbPath, {
      spanId: 'span-g7-zero',
      traceId: 'trace-g7-zero',
      operationName: 'chat',
      startTimeMs: 4000,
      responseModel: 'gpt-4.1',
      attrs: {
        'gen_ai.conversation.id': 'conv-g7',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        'gen_ai.usage.cache_read.input_tokens': 0,
        'gen_ai.usage.cache_creation.input_tokens': 0,
      },
    })

    const source = { path: dbPath, project: 'copilot-chat', provider: 'copilot', sourceType: 'otel' }
    const { calls, seen } = await capture(source)
    expect(calls).toEqual(G7_GOLDEN)
    expect([...seen].sort()).toEqual(G7_KEYS)
  })

  it('G8 otel two conversations in one DB: one with github.copilot.git.repository, one without', async () => {
    if (!isSqliteAvailable()) return
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '')
    const dbPath = join(tmpDir, 'agent-traces.db')
    vi.stubEnv('CODEBURN_COPILOT_OTEL_DB', dbPath)
    createOtelDb(dbPath)

    insertSpan(dbPath, {
      spanId: 'span-g8-a-chat',
      traceId: 'trace-g8-a',
      operationName: 'chat',
      startTimeMs: 1000,
      responseModel: 'gpt-4.1',
      attrs: {
        'gen_ai.conversation.id': 'conv-g8-a',
        'gen_ai.response.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 500,
        'gen_ai.usage.output_tokens': 100,
        'github.copilot.git.repository': 'file:///Users/dev/projects/web-api/repo.git',
      },
    })

    insertSpan(dbPath, {
      spanId: 'span-g8-b-chat',
      traceId: 'trace-g8-b',
      operationName: 'chat',
      startTimeMs: 2000,
      responseModel: 'claude-sonnet-4',
      attrs: {
        'gen_ai.conversation.id': 'conv-g8-b',
        'gen_ai.response.model': 'claude-sonnet-4',
        'gen_ai.usage.input_tokens': 600,
        'gen_ai.usage.output_tokens': 120,
      },
    })

    const source = { path: dbPath, project: 'copilot-chat', provider: 'copilot', sourceType: 'otel' }
    const { calls, seen } = await capture(source)
    expect(calls).toEqual(G8_GOLDEN)
    expect([...seen].sort()).toEqual(G8_KEYS)
  })

  it('G9 jsonl: pendingUserMessage survives a skipped assistant message (J31)', async () => {
    const eventsPath = await createSessionDir('sess-x1', [
      modelChange('gpt-4.1'),
      userMessage('keep me pending'),
      assistantMessage({ messageId: 'msg-skip', outputTokens: 0 }),
      assistantMessage({ messageId: 'msg-emit', outputTokens: 42 }),
      assistantMessage({ messageId: 'msg-after', outputTokens: 7 }),
    ])
    const { calls, seen } = await capture({ path: eventsPath, project: 'myproject', provider: 'copilot' })
    expect(calls).toEqual(G9_GOLDEN)
    expect([...seen].sort()).toEqual(G9_KEYS)
  })

  it('G10 jsonl: an empty-string newModel wins under ?? and blanks the model (J10/J23)', async () => {
    const eventsPath = await createSessionDir('sess-x2', [
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 10 }),
      JSON.stringify({ type: 'session.model_change', timestamp: '2026-04-15T10:00:02Z', data: { newModel: '' } }),
      assistantMessage({ messageId: 'msg-2', outputTokens: 20 }),
      JSON.stringify({ type: 'session.model_change', timestamp: '2026-04-15T10:00:03Z', data: {} }),
      assistantMessage({ messageId: 'msg-3', outputTokens: 30 }),
    ])
    const { calls, seen } = await capture({ path: eventsPath, project: 'myproject', provider: 'copilot' })
    expect(calls).toEqual(G10_GOLDEN)
    expect([...seen].sort()).toEqual(G10_KEYS)
  })

  it('G11 jsonl shutdown: skip arms, cache clamp, sessionStartTime timestamp (J14-J18)', async () => {
    const eventsPath = await createSessionDir('sess-x4', [
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 5 }),
      JSON.stringify({ type: 'session.shutdown', timestamp: '', data: { sessionStartTime: 1784102040274, modelMetrics: {
        '': { usage: { inputTokens: 10 } },
        'no-usage': {},
        'bad-usage': { usage: 'nope' },
        'all-zero': { usage: { inputTokens: 0, outputTokens: 900 } },
        'clamped': { usage: { inputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0 } },
        'gpt-4.1': { usage: { inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 7 } },
      } } }),
    ])
    const { calls, seen } = await capture({ path: eventsPath, project: 'myproject', provider: 'copilot' })
    expect(calls).toEqual(G11_GOLDEN)
    expect([...seen].sort()).toEqual(G11_KEYS)
    // The shutdown arm prices itself; the pricing pass must never see a costBasis.
    for (const call of calls.filter(c => c.deduplicationKey.includes(':shutdown:'))) {
      expect(Object.hasOwn(call, 'costBasis')).toBe(false)
      expect(call.costIsEstimated).toBe(false)
    }
  })

  it('G12 chatsession: id/model/timestamp fallbacks, completionTokens fallback, tool rounds', async () => {
    const filePath = join(tmpDir, 'x16-fallback.jsonl')
    await createChatSessionFile(filePath, [
      { kind: 0, v: { version: 3, creationDate: '2026-05-01T08:00:00.000Z', requests: [] } },
      { kind: 2, k: ['requests'], v: [
        { requestId: 'req-tools', completionTokens: 490, result: { metadata: { promptTokens: 10, outputTokens: 0, toolCallRounds: [
          { toolName: 'read_file', tools: ['bash', 'read_file'], toolCalls: [{ name: 'github-mcp-server-list_issues' }, 7], toolRequests: [{ tool: '  ' }, { toolName: 'runInTerminal' }] },
          'not-a-round',
          { name: 'skill' },
        ] } } },
        { requestId: 'req-unknown-model', result: { metadata: { promptTokens: 3, outputTokens: 4 } } },
        { modelId: 'copilot/gpt-4.1', timestamp: 'not-a-date', result: { metadata: { promptTokens: 5, outputTokens: 6 } } },
      ] },
    ])
    const { calls, seen } = await capture({ path: filePath, project: 'myproject', provider: 'copilot', sourceType: 'chatsession' })
    expect(calls).toEqual(G12_GOLDEN)
    expect([...seen].sort()).toEqual(G12_KEYS)
  })

  it('G13 jetbrains: no projectName, project comes from the file:// git repo root', async () => {
    const repoDir = join(tmpDir, 'container', 'web-api')
    await mkdir(join(repoDir, '.git'), { recursive: true })
    const repoFile = join(repoDir, 'src', 'Main.java')
    const guid = '485825c0-3331-46a7-acb2-c71875ad6640'
    const content = jbDbContent([
      jbAssistantBlob('Answer referencing a real repo file.', { model: 'gpt-4.1', files: [repoFile] }),
      jbAssistantBlob('Second turn with no file references.', { model: 'gpt-4.1' }),
    ], [jbConversationRecord(guid, 'Conversation X7')])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'x7-store', content)
    const { calls, seen } = await capture(jbDbSource(dbPath, 'x7-store'))
    expect(calls).toEqual(G13_GOLDEN)
    expect([...seen].sort()).toEqual(G13_KEYS)
    // Back-filled from the first turn (B12) via the host-resolved repo-root map.
    expect(calls.map(c => c.project)).toEqual(['web-api', 'web-api'])
  })

  it('G14 jetbrains: a pipe character inside a file:// path still resolves (B22)', async () => {
    const repoDir = join(tmpDir, 'pipe|repo')
    await mkdir(join(repoDir, '.git'), { recursive: true })
    const repoFile = join(repoDir, 'src', 'Main.java')
    const guid = '485825c0-3331-46a7-acb2-c71875ad6640'
    const content = jbDbContent([
      jbAssistantBlob('Answer referencing a piped path.', { model: 'gpt-4.1', files: [repoFile] }),
    ], [jbConversationRecord(guid, 'Conversation X8')])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'x8-store', content)
    const { calls, seen } = await capture(jbDbSource(dbPath, 'x8-store'))
    expect(calls).toEqual(G14_GOLDEN)
    expect([...seen].sort()).toEqual(G14_KEYS)
  })

  it('G15 jetbrains: no conversation record, repeated reply, empty blob, model fallback', async () => {
    const content = jbDbContent([
      jbAssistantBlob('Repeated reply body.'),
      jbAssistantBlob('Repeated reply body.'),
      jbAssistantBlob(''),
      jbAssistantBlob('Distinct second reply.'),
    ])
    const dbPath = await createJetBrainsDb(tmpDir, 'iu', 'chat-agent-sessions', 'x17-store', content)
    const { calls, seen } = await capture(jbDbSource(dbPath, 'x17-store'))
    expect(calls).toEqual(G15_GOLDEN)
    expect([...seen].sort()).toEqual(G15_KEYS)
  })

  it('G16 otel: an empty-string response_model wins under ?? (O13)', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = join(tmpDir, 'agent-traces.db')
    createOtelDb(dbPath)
    insertSpan(dbPath, {
      spanId: 'span-x11', traceId: 'trace-x11', operationName: 'chat', startTimeMs: 1000, responseModel: '',
      attrs: { 'gen_ai.conversation.id': 'conv-x11', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 5 },
    })
    const { calls, seen } = await capture({ path: dbPath, project: 'copilot-chat', provider: 'copilot', sourceType: 'otel' })
    expect(calls).toEqual(G16_GOLDEN)
    expect([...seen].sort()).toEqual(G16_KEYS)
    expect(calls[0]!.model).toBe('')
  })

  it('G17 otel: one span shared by two conversations is emitted once (O21)', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = join(tmpDir, 'agent-traces.db')
    createOtelDb(dbPath)
    insertSpan(dbPath, {
      spanId: 'span-x12-shared', traceId: 'trace-x12', operationName: 'chat', startTimeMs: 1000, responseModel: 'gpt-4.1',
      attrs: { 'gen_ai.conversation.id': 'conv-x12-a', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20, 'github.copilot.chat.turn.id': 'turn-x12' },
    })
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (p: string) => TestDb }
    const raw = new DatabaseSync(dbPath)
    raw.prepare(`INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)`).run('span-x12-shared', 'gen_ai.conversation.id', 'conv-x12-b')
    raw.close()
    insertSpan(dbPath, {
      spanId: 'span-x12-b-own', traceId: 'trace-x12', operationName: 'chat', startTimeMs: 2000, responseModel: 'gpt-5',
      attrs: { 'gen_ai.conversation.id': 'conv-x12-b', 'gen_ai.usage.input_tokens': 7, 'gen_ai.usage.output_tokens': 3 },
    })
    const { calls, seen } = await capture({ path: dbPath, project: 'copilot-chat', provider: 'copilot', sourceType: 'otel' })
    expect(calls).toEqual(G17_GOLDEN)
    expect([...seen].sort()).toEqual(G17_KEYS)
  })

})
