// Shared-bridge goldens for the opencode-session decode family (phase 8, batch S2).
//
// Every literal array below was captured against the PRE-MIGRATION tree
// (38172892), before `session-message.ts` / `sqlite-session-parser.ts` /
// `opencode-file-parser.ts` were unified into
// `@codeburn/core/providers/opencode-session`. The goldens are the oracle: if
// the bridge disagrees, the bridge is wrong.
//
// `toEqual` ignores keys whose value is `undefined`, so the golden alone cannot
// prove a key is absent rather than present-and-undefined. The key-presence
// gates below close that gap for the arms where key SHAPE is load-bearing —
// notably the session-level fallback, which emitted no `skills`/`subagentTypes`
// keys at all pre-migration.

import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { isSqliteAvailable } from '../../src/sqlite.js'
import { createOpenCodeProvider } from '../../src/providers/opencode.js'
import { createKiloCodeProvider } from '../../src/providers/kilo-code.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpDir: string
let originalXdg: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'opencode-bridge-test-'))
  originalXdg = process.env['XDG_DATA_HOME']
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
  if (originalXdg === undefined) {
    delete process.env['XDG_DATA_HOME']
  } else {
    process.env['XDG_DATA_HOME'] = originalXdg
  }
})

// ── SQLite fixture builders (copied from opencode.test.ts) ───────────────────

function createTestDb(dir: string): string {
  const ocDir = join(dir, 'opencode')
  mkdirSync(ocDir, { recursive: true })
  const dbPath = join(ocDir, 'opencode.db')

  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER,
      time_archived INTEGER,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      model TEXT
    )
  `)
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      session_id TEXT NOT NULL, time_created INTEGER,
      time_updated INTEGER, data TEXT NOT NULL
    )
  `)
  db.close()
  return dbPath
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(dbPath)
  fn(db)
  db.close()
}

function insertSession(
  db: TestDb,
  id: string,
  opts: { directory?: string; title?: string; parentId?: string | null; archived?: number | null; timeCreated?: number } = {},
): void {
  db.prepare(`
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_archived, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'proj-1', 'slug-1', opts.directory ?? '/home/user/myproject', opts.title ?? 'My Project', '1.0', opts.timeCreated ?? 1700000000000, opts.archived ?? null, opts.parentId ?? null)
}

type MessageFixture = {
  role: string
  modelID?: string
  model?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

type PartFixture = {
  type: string
  text?: string
  tool?: string
  state?: { status: string; input: { command?: string; name?: string; subagent_type?: string } }
}

function insertMessage(db: TestDb, id: string, sessionId: string, timeCreated: number, data: MessageFixture): void {
  db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`)
    .run(id, sessionId, timeCreated, JSON.stringify(data))
}

function insertPart(db: TestDb, id: string, messageId: string, sessionId: string, data: PartFixture): void {
  db.prepare(`INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)`)
    .run(id, messageId, sessionId, JSON.stringify(data))
}

async function collectCalls(provider: ReturnType<typeof createOpenCodeProvider>, dbPath: string, sessionId: string, seenKeys?: Set<string>): Promise<ParsedProviderCall[]> {
  const source = { path: `${dbPath}:${sessionId}`, project: 'myproject', provider: provider.name }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys ?? new Set()).parse()) {
    calls.push(priceProviderCall(call))
  }
  return calls
}

// ── KiloCode SQLite fixture builder (from scratch, §7) ───────────────────────

function createKiloTestDb(dir: string): string {
  const kiloDir = join(dir, 'kilo')
  mkdirSync(kiloDir, { recursive: true })
  const dbPath = join(kiloDir, 'kilo.db')

  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER,
      time_archived INTEGER,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      model TEXT
    )
  `)
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      session_id TEXT NOT NULL, time_created INTEGER,
      time_updated INTEGER, data TEXT NOT NULL
    )
  `)
  db.close()
  return dbPath
}

async function collectKiloCalls(dbPath: string, sessionId: string, seenKeys?: Set<string>): Promise<ParsedProviderCall[]> {
  process.env['XDG_DATA_HOME'] = tmpDir
  const provider = createKiloCodeProvider()
  const source = { path: `${dbPath}:${sessionId}`, project: 'myproject', provider: provider.name }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys ?? new Set()).parse()) {
    calls.push(priceProviderCall(call))
  }
  return calls
}

// ── File-based fixture builder (copied from opencode-file.test.ts) ───────────

type Msg = { id: string; data: Record<string, unknown>; parts?: Array<Record<string, unknown>> }

async function writeSession(opts: {
  sessionId?: string
  projectId?: string
  directory?: string
  title?: string
  root?: string
  messages: Msg[]
}) {
  const storage = join(opts.root ?? join(tmpDir, 'opencode'), 'storage')
  const sessionId = opts.sessionId ?? 'ses_test1'
  const projectId = opts.projectId ?? 'global'

  const sessionDir = join(storage, 'session', projectId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    slug: 'cosmic-engine',
    version: '1.1.65',
    projectID: projectId,
    directory: opts.directory ?? '/Users/test/myproject',
    title: opts.title ?? 'Test session',
    time: { created: 1781886356809, updated: 1781886683506 },
  }))

  const messageDir = join(storage, 'message', sessionId)
  await mkdir(messageDir, { recursive: true })
  for (const m of opts.messages) {
    await writeFile(join(messageDir, `${m.id}.json`), JSON.stringify({ id: m.id, sessionID: sessionId, ...m.data }))
    if (m.parts?.length) {
      const partDir = join(storage, 'part', m.id)
      await mkdir(partDir, { recursive: true })
      let i = 0
      for (const p of m.parts) {
        await writeFile(join(partDir, `prt_${m.id}_${String(i++).padStart(3, '0')}.json`), JSON.stringify(p))
      }
    }
  }
  return { sessionId, storage }
}

async function collectFileCalls(seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createOpenCodeProvider(tmpDir)
  const sources = await provider.discoverSessions()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) {
      calls.push(priceProviderCall(call))
    }
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

// ═════════════════════════════════════════════════════════════════════════════
// Shared builder arms (H1-H18), driven through the SQLite arm
// ═════════════════════════════════════════════════════════════════════════════

skipUnlessSqlite('shared builder H1-H3, H9, H16, H18 — token shape and precedence', () => {
  it('pins normalized tokens, usage fallback, and empty skill/subagent arrays', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'hello' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 500, write: 300 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 300,
    "cacheReadInputTokens": 500,
    "cachedInputTokens": 500,
    "costBasis": "estimated",
    "costUSD": 0.008875000000000001,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0.05,
    "inputTokens": 100,
    "model": "claude-opus-4-6",
    "outputTokens": 200,
    "provider": "opencode",
    "reasoningTokens": 50,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "hello",
    "webSearchRequests": 0,
  },
])
  })

  it('pins usage.* raw shape and precedence (tokens wins over usage)', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'usage test' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 50, write: 30 } },
        usage: { input_tokens: 999, output_tokens: 888, cache_creation_input_tokens: 777, cache_read_input_tokens: 666 },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 30,
    "cacheReadInputTokens": 50,
    "cachedInputTokens": 50,
    "costBasis": "estimated",
    "costUSD": 0.0008874999999999999,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 20,
    "provider": "opencode",
    "reasoningTokens": 5,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "usage test",
    "webSearchRequests": 0,
  },
])
  })

  it('fills null/undefined tokens from usage.*', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'fallback test' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        usage: { input_tokens: 42, output_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 9 },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 3,
    "cacheReadInputTokens": 9,
    "cachedInputTokens": 9,
    "costBasis": "estimated",
    "costUSD": 0.00040825000000000003,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0.05,
    "inputTokens": 42,
    "model": "claude-opus-4-6",
    "outputTokens": 7,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "fallback test",
    "webSearchRequests": 0,
  },
])
  })
})

skipUnlessSqlite('shared builder H4 — part type counting', () => {
  it('counts tool/tool-call/tool_call as tools and tool-result/tool_result as activity', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'parts' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-2a', 'msg-2', 'sess-1', { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } })
      insertPart(db, 'part-2b', 'msg-2', 'sess-1', { type: 'tool-call', tool: 'read', state: { status: 'completed', input: {} } })
      insertPart(db, 'part-2c', 'msg-2', 'sess-1', { type: 'tool_call', tool: 'grep', state: { status: 'completed', input: {} } })
      insertPart(db, 'part-2d', 'msg-2', 'sess-1', { type: 'tool-result', tool: 'bash', state: { status: 'completed', input: {} } })
      insertPart(db, 'part-2e', 'msg-2', 'sess-1', { type: 'tool_result', tool: 'bash', state: { status: 'completed', input: {} } })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [
      "ls",
    ],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [
      "Bash",
      "Read",
      "Grep",
    ],
    "userMessage": "parts",
    "webSearchRequests": 0,
  },
])
  })
})

skipUnlessSqlite('shared builder H5 — normalizeToolName', () => {
  it('pins builtin map, mcp__ passthrough, server_tool conversion, and underscore edge cases', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'tools' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'p-bash', 'msg-2', 'sess-1', { type: 'tool', tool: 'bash', state: { status: 'completed', input: {} } })
      insertPart(db, 'p-mcp', 'msg-2', 'sess-1', { type: 'tool', tool: 'mcp__x__y', state: { status: 'completed', input: {} } })
      insertPart(db, 'p-srv', 'msg-2', 'sess-1', { type: 'tool', tool: 'server_tool', state: { status: 'completed', input: {} } })
      insertPart(db, 'p-leading', 'msg-2', 'sess-1', { type: 'tool', tool: '_leading', state: { status: 'completed', input: {} } })
      insertPart(db, 'p-trailing', 'msg-2', 'sess-1', { type: 'tool', tool: 'trailing_', state: { status: 'completed', input: {} } })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [
      "Bash",
      "_leading",
      "mcp__x__y",
      "mcp__server__tool",
      "trailing_",
    ],
    "userMessage": "tools",
    "webSearchRequests": 0,
  },
])
  })
})

skipUnlessSqlite('shared builder H6-H8 — bash, skill, task extraction', () => {
  it('extracts bashCommands, skills, and subagentTypes', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'do things' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'p-bash', 'msg-2', 'sess-1', { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test && git push' } } })
      insertPart(db, 'p-skill', 'msg-2', 'sess-1', { type: 'tool', tool: 'skill', state: { status: 'completed', input: { name: 'commit' } } })
      insertPart(db, 'p-task', 'msg-2', 'sess-1', { type: 'tool', tool: 'task', state: { status: 'completed', input: { subagent_type: 'general-purpose' } } })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [
      "npm",
      "git",
    ],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [
      "commit",
    ],
    "speed": "standard",
    "subagentTypes": [
      "general-purpose",
    ],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [
      "Bash",
      "Skill",
      "Agent",
    ],
    "userMessage": "do things",
    "webSearchRequests": 0,
  },
])
  })
})

skipUnlessSqlite('shared builder H10-H14 — skip semantics', () => {
  it('H10 skips all-zero tokens with falsy cost and no substantive parts', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([])
  })

  it('H11 yields zero-token assistant with non-empty text', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'prompt' })
      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-2', 'msg-2', 'sess-1', { type: 'text', text: 'I will help' })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "inputTokens": 0,
    "model": "claude-opus-4-6",
    "outputTokens": 0,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "prompt",
    "webSearchRequests": 0,
  },
])
  })

  it('H12 yields zero-token assistant with a tool-call part', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'prompt' })
      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-2', 'msg-2', 'sess-1', { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [
      "ls",
    ],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "inputTokens": 0,
    "model": "claude-opus-4-6",
    "outputTokens": 0,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [
      "Bash",
    ],
    "userMessage": "prompt",
    "webSearchRequests": 0,
  },
])
  })

  it('H13 yields zero-token assistant with reasoning or file part', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'prompt' })
      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-2', 'msg-2', 'sess-1', { type: 'reasoning' })
      insertMessage(db, 'msg-3', 'sess-1', 1700000002000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-3', 'msg-3', 'sess-1', { type: 'file' })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "inputTokens": 0,
    "model": "claude-opus-4-6",
    "outputTokens": 0,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "prompt",
    "webSearchRequests": 0,
  },
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0,
    "deduplicationKey": "opencode:sess-1:msg-3",
    "inputTokens": 0,
    "model": "claude-opus-4-6",
    "outputTokens": 0,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:22.000Z",
    "tools": [],
    "userMessage": "prompt",
    "webSearchRequests": 0,
  },
])
  })

  it('H14 yields all-zero tokens when cost > 0', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.01,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.01,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0.01,
    "inputTokens": 0,
    "model": "claude-opus-4-6",
    "outputTokens": 0,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
  })
})

skipUnlessSqlite('shared builder H15 — fallbackCostUSD guard', () => {
  it('pins fallbackCostUSD presence for cost 0 and absence for undefined cost', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'costs' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertMessage(db, 'msg-3', 'sess-1', 1700000002000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "costs",
    "webSearchRequests": 0,
  },
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:sess-1:msg-3",
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:22.000Z",
    "tools": [],
    "userMessage": "costs",
    "webSearchRequests": 0,
  },
])
    // Key-presence gate for H15: `cost: 0` must PRODUCE the key (the guard is
    // `typeof data.cost === 'number'`, not a truthy check), and an absent cost
    // must OMIT it — not set it to undefined, which `toEqual` would accept.
    expect(Object.keys(calls[0]!)).toContain('fallbackCostUSD')
    expect(Object.keys(calls[1]!)).not.toContain('fallbackCostUSD')
  })
})

skipUnlessSqlite('shared builder H16 — model precedence', () => {
  it('pins modelID -> model -> unknown precedence', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'model' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        model: 'from-model-field',
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertMessage(db, 'msg-3', 'sess-1', 1700000002000, {
        role: 'assistant',
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "inputTokens": 10,
    "model": "from-model-field",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "model",
    "webSearchRequests": 0,
  },
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0,
    "deduplicationKey": "opencode:sess-1:msg-3",
    "inputTokens": 10,
    "model": "unknown",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:22.000Z",
    "tools": [],
    "userMessage": "model",
    "webSearchRequests": 0,
  },
])
  })
})

skipUnlessSqlite('shared builder H17 — parseTimestamp', () => {
  it('pins <1e12 seconds and >=1e12 ms handling', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'ts' })
      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "ts",
    "webSearchRequests": 0,
  },
])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SQLite-only arms (S1-S12)
// ═════════════════════════════════════════════════════════════════════════════

skipUnlessSqlite('SQLite arm S1-S2 — session_tree CTE and archived exclusion', () => {
  it('pins child and grandchild calls attributed to root, excluding archived', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'root', { timeCreated: 1700000000000 })
      insertSession(db, 'child', { parentId: 'root', timeCreated: 1700000000100 })
      insertSession(db, 'grandchild', { parentId: 'child', timeCreated: 1700000000200 })
      insertSession(db, 'archived', { parentId: 'root', archived: 1700000000300, timeCreated: 1700000000300 })

      // user in root
      insertMessage(db, 'm-root-user', 'root', 1700000000001, { role: 'user' })
      insertPart(db, 'p-root-user', 'm-root-user', 'root', { type: 'text', text: 'root prompt' })

      // assistant in child
      insertMessage(db, 'm-child', 'child', 1700000000101, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      // assistant in grandchild
      insertMessage(db, 'm-grandchild', 'grandchild', 1700000000201, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 20, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      // assistant in archived (should not appear)
      insertMessage(db, 'm-archived', 'archived', 1700000000301, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 99, output: 99, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'root')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:child:m-child",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "root",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:20.101Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.0006000000000000001,
    "deduplicationKey": "opencode:grandchild:m-grandchild",
    "fallbackCostUSD": 0.05,
    "inputTokens": 20,
    "model": "claude-opus-4-6",
    "outputTokens": 20,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "root",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:20.201Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
    // Key-presence gate for a SQLite message-arm call: skills/subagentTypes are
    // emitted unconditionally (session-message.ts:147-148), never as undefined.
    for (const call of calls) {
      const keys = Object.keys(call)
      expect(keys).toContain('skills')
      expect(keys).toContain('subagentTypes')
      expect(keys).toContain('bashCommands')
      expect(keys).toContain('fallbackCostUSD')
      expect(keys).not.toContain('project')
      expect(keys).not.toContain('projectPath')
    }
  })
})

skipUnlessSqlite('SQLite arm S3-S4 — corrupt JSON handling', () => {
  it('skips corrupt message data and corrupt part data, keeping siblings', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'prompt' })

      // corrupt message JSON
      db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`)
        .run('msg-bad', 'sess-1', 1700000000500, 'not-json')

      // assistant with one corrupt part and one good part
      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      db.prepare(`INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)`)
        .run('part-bad', 'msg-2', 'sess-1', 'not-json')
      insertPart(db, 'part-good', 'msg-2', 'sess-1', { type: 'tool', tool: 'read', state: { status: 'completed', input: {} } })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [
      "Read",
    ],
    "userMessage": "prompt",
    "webSearchRequests": 0,
  },
])
  })
})

skipUnlessSqlite('SQLite arm S5-S7 — role handling', () => {
  it('pins user message accumulation, model alias, and role skip counting', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      // user with two text parts
      insertMessage(db, 'msg-user', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'p-user-1', 'msg-user', 'sess-1', { type: 'text', text: 'first' })
      insertPart(db, 'p-user-2', 'msg-user', 'sess-1', { type: 'text', text: 'second' })

      // system role skipped
      insertMessage(db, 'msg-system', 'sess-1', 1700000000200, { role: 'system' })

      // model role accepted as assistant
      insertMessage(db, 'msg-model', 'sess-1', 1700000001000, {
        role: 'model',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:sess-1:msg-model",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "first second",
    "webSearchRequests": 0,
  },
])
  })
})

skipUnlessSqlite('SQLite arm S8 — dedup adds after successful build', () => {
  it('does not add dedup key when buildAssistantCall returns null', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      // first message skipped (no tokens, no cost, no activity)
      insertMessage(db, 'msg-skip', 'sess-1', 1700000000000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      // a second, independently-keyed message still yields
      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:sess-1:msg-2",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
  })

  // The arm above is not discriminating on its own: `msg-skip` and `msg-2` have
  // DIFFERENT dedup keys, so hoisting `seenKeys.add` above the build would not
  // change its output. This one pins the actual semantic — a null build must
  // leave its key UNCLAIMED, the opposite of the vscode-cline arm, which burns
  // the key before deciding to skip.
  it('leaves the dedup key unclaimed when the build returns null, so a later run can yield it', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const provider = createOpenCodeProvider(tmpDir)
    const seen = new Set<string>()
    expect(await collectCalls(provider, dbPath, 'sess-1', seen)).toEqual([])
    expect(seen.has('opencode:sess-1:msg-1')).toBe(false)

    // The same message now carries tokens. Because the skipped build never
    // claimed the key, the second pass over the shared seenKeys set yields it.
    withTestDb(dbPath, (db) => {
      db.prepare(`UPDATE message SET data = ? WHERE id = ?`).run(
        JSON.stringify({
          role: 'assistant',
          modelID: 'claude-opus-4-6',
          cost: 0.05,
          tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        'msg-1',
      )
    })

    const second = await collectCalls(provider, dbPath, 'sess-1', seen)
    expect(second).toHaveLength(1)
    expect(second[0]!.deduplicationKey).toBe('opencode:sess-1:msg-1')
    expect(seen.has('opencode:sess-1:msg-1')).toBe(true)
  })
})

skipUnlessSqlite('SQLite arm S9-S12 — session-level fallback', () => {
  it('S9 emits session-level fallback when zero calls but session row has tokens/cost', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-user', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'p-user', 'msg-user', 'sess-1', { type: 'text', text: 'hello' })
      // session row rollup — model is the real-schema JSON object
      db.prepare(`UPDATE session SET cost=1, tokens_input=100, tokens_output=50, tokens_reasoning=5, tokens_cache_read=10, tokens_cache_write=20, model=? WHERE id=?`)
        .run(JSON.stringify({ providerID: 'test-provider', id: 'session-model' }), 'sess-1')
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 20,
    "cacheReadInputTokens": 10,
    "cachedInputTokens": 10,
    "costBasis": "estimated",
    "costUSD": 1,
    "deduplicationKey": "opencode:sess-1:session-level",
    "fallbackCostUSD": 1,
    "inputTokens": 100,
    "model": "test-provider/session-model",
    "outputTokens": 50,
    "provider": "opencode",
    "reasoningTokens": 5,
    "sessionId": "sess-1",
    "speed": "standard",
    "timestamp": "2023-11-14T22:13:20.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
    // Key-presence gate: pre-migration the session-level call emitted NO
    // skills/subagentTypes keys (sqlite-session-parser.ts:234-253), unlike the
    // message arm. `toEqual` would accept `skills: undefined` here, so assert
    // absence directly.
    const keys = Object.keys(calls[0]!)
    expect(keys).not.toContain('skills')
    expect(keys).not.toContain('subagentTypes')
    expect(keys).toContain('tools')
    expect(keys).toContain('bashCommands')
    expect(keys).toContain('fallbackCostUSD')
    expect(keys).toContain('costBasis')
  })

  it('S10/S11 omits fallback when session row is all zeros, omits fallbackCostUSD when cost is 0', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-user', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'p-user', 'msg-user', 'sess-1', { type: 'text', text: 'hello' })
      // all zeros
      db.prepare(`UPDATE session SET cost=0, tokens_input=0, tokens_output=0, tokens_reasoning=0, tokens_cache_read=0, tokens_cache_write=0 WHERE id=?`)
        .run('sess-1')
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([])
  })

  it('S12 yields nothing for session with only user messages and no session rollup', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-user', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'p-user', 'msg-user', 'sess-1', { type: 'text', text: 'hello' })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// File arm (F1-F9)
// ═════════════════════════════════════════════════════════════════════════════

describe('file arm F1-F9', () => {
  it('F1-F3 pins message ordering, id fallback, and sorted parts', async () => {
    await writeSession({
      messages: [
        {
          id: 'msg_b',
          data: { role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2 } },
          parts: [
            { type: 'text', text: 'b-first' },
            { type: 'text', text: 'b-second' },
          ],
        },
        {
          id: 'msg_a',
          data: { role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05, tokens: { input: 20, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2 } },
          parts: [{ type: 'text', text: 'a-wins-tie' }],
        },
        {
          id: 'msg_c',
          data: { role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05, tokens: { input: 30, output: 30, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 3 } },
          parts: [{ type: 'text', text: 'c-latest' }],
        },
      ],
    })

    const calls = await collectFileCalls()
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.0006000000000000001,
    "deduplicationKey": "opencode:ses_test1:msg_a",
    "fallbackCostUSD": 0.05,
    "inputTokens": 20,
    "model": "claude-opus-4-6",
    "outputTokens": 20,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "ses_test1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "1970-01-01T00:00:02.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:ses_test1:msg_b",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "ses_test1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "1970-01-01T00:00:02.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.0009,
    "deduplicationKey": "opencode:ses_test1:msg_c",
    "fallbackCostUSD": 0.05,
    "inputTokens": 30,
    "model": "claude-opus-4-6",
    "outputTokens": 30,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "ses_test1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "1970-01-01T00:00:03.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
    // Key-presence gate for a file message-arm call.
    for (const call of calls) {
      const keys = Object.keys(call)
      expect(keys).toContain('skills')
      expect(keys).toContain('subagentTypes')
      expect(keys).toContain('bashCommands')
      expect(keys).toContain('fallbackCostUSD')
      expect(keys).not.toContain('project')
      expect(keys).not.toContain('projectPath')
    }
  })

  it('F2 falls back message id to filename minus .json', async () => {
    await writeSession({
      messages: [
        {
          id: 'from_filename',
          data: { role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1 } },
          parts: [{ type: 'text', text: 'fallback id' }],
        },
      ],
    })

    const calls = await collectFileCalls()
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:ses_test1:from_filename",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "ses_test1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "1970-01-01T00:00:01.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
  })

  it('F3 skips non-json part files and F4 skips unparseable part files', async () => {
    await writeSession({
      messages: [
        {
          id: 'msg_a',
          data: { role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1 } },
          parts: [{ type: 'text', text: 'ok' }],
        },
      ],
    })

    // Write extra non-json and corrupt json files directly into the part dir
    const partDir = join(tmpDir, 'opencode', 'storage', 'part', 'msg_a')
    await writeFile(join(partDir, 'ignored.txt'), 'not json')
    await writeFile(join(partDir, 'corrupt.json'), 'not-json')

    const calls = await collectFileCalls()
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:ses_test1:msg_a",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "ses_test1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "1970-01-01T00:00:01.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
  })

  it('F5 timeCreatedMs precedence: data.time.created -> meta.time.created -> 0', async () => {
    await writeSession({
      messages: [
        {
          id: 'msg_no_time',
          data: { role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } },
          parts: [{ type: 'text', text: 'uses meta time' }],
        },
      ],
    })

    const calls = await collectFileCalls()
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:ses_test1:msg_no_time",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "ses_test1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2026-06-19T16:25:56.809Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
  })

  it('F6 missing session meta id yields nothing', async () => {
    const storage = join(tmpDir, 'opencode', 'storage')
    const sessionDir = join(storage, 'session', 'global')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'bad.json'), JSON.stringify({ directory: '/x', title: 'y' }))

    const provider = createOpenCodeProvider(tmpDir)
    const sources = await provider.discoverSessions()
    expect(sources).toEqual([])
    expect(await collectFileCalls()).toEqual([])
  })

  it('F7 missing message directory yields nothing', async () => {
    await writeSession({ messages: [] })
    // remove the message directory
    await rm(join(tmpDir, 'opencode', 'storage', 'message', 'ses_test1'), { recursive: true, force: true })

    const calls = await collectFileCalls()
    expect(calls).toEqual([])
  })

  it('F8 currentUserMessage is only overwritten by non-empty joined text', async () => {
    await writeSession({
      messages: [
        {
          id: 'msg_user1',
          data: { role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'first prompt' }],
        },
        {
          id: 'msg_user2_empty',
          data: { role: 'user', time: { created: 2 } },
          parts: [{ type: 'text', text: '' }],
        },
        {
          id: 'msg_assistant',
          data: { role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 3 } },
          parts: [{ type: 'text', text: 'reply' }],
        },
      ],
    })

    const calls = await collectFileCalls()
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:ses_test1:msg_assistant",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "ses_test1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "1970-01-01T00:00:03.000Z",
    "tools": [],
    "userMessage": "first prompt",
    "webSearchRequests": 0,
  },
])
  })

  // Two distinct message FILES that resolve to the same message id (`data.id`
  // overrides the filename), so both produce the dedup key
  // `opencode:ses_test1:msg_skip`. The earlier one builds to null. If
  // `seenKeys.add` were hoisted above the build, the later one would be skipped
  // and this would yield []. The original writes the id into both files but
  // under distinct filenames — writing the same filename twice would silently
  // overwrite and test nothing.
  it('F9 dedup adds only after successful build', async () => {
    await writeSession({
      messages: [
        {
          id: 'file_a',
          data: { id: 'msg_skip', role: 'assistant', modelID: 'claude-opus-4-6', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1 } },
        },
        {
          id: 'file_b',
          data: { id: 'msg_skip', role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2 } },
        },
      ],
    })

    const calls = await collectFileCalls()
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "cachedInputTokens": 0,
    "costBasis": "estimated",
    "costUSD": 0.00030000000000000003,
    "deduplicationKey": "opencode:ses_test1:msg_skip",
    "fallbackCostUSD": 0.05,
    "inputTokens": 10,
    "model": "claude-opus-4-6",
    "outputTokens": 10,
    "provider": "opencode",
    "reasoningTokens": 0,
    "sessionId": "ses_test1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "1970-01-01T00:00:02.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Cross-run dedup
// ═════════════════════════════════════════════════════════════════════════════

skipUnlessSqlite('cross-run dedup — SQLite', () => {
  it('second parse with shared seenKeys yields empty', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const provider = createOpenCodeProvider(tmpDir)
    const seen = new Set<string>()
    const first = await collectCalls(provider, dbPath, 'sess-1', seen)
    expect(first).toHaveLength(1)
    const second = await collectCalls(provider, dbPath, 'sess-1', seen)
    expect(second).toEqual([])
  })
})

describe('cross-run dedup — file', () => {
  it('second parse with shared seenKeys yields empty', async () => {
    await writeSession({
      messages: [
        {
          id: 'msg_a',
          data: { role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1 } },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    })

    const provider = createOpenCodeProvider(tmpDir)
    const seen = new Set<string>()
    const sources = await provider.discoverSessions()
    const first: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) first.push(priceProviderCall(call))
    }
    expect(first).toHaveLength(1)
    const second: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) second.push(priceProviderCall(call))
    }
    expect(second).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// KiloCode SQLite arm (from-scratch fixture, §7)
// ═════════════════════════════════════════════════════════════════════════════

skipUnlessSqlite('kilo-code SQLite arm golden', () => {
  it('pins the full-object output from an unmodified kilo-code SQLite session', async () => {
    const dbPath = createKiloTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'kilo-sess-1', { directory: '/home/user/kiloproject', title: 'Kilo Session' })

      insertMessage(db, 'msg-user', 'kilo-sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'p-user', 'msg-user', 'kilo-sess-1', { type: 'text', text: 'kilocode prompt' })

      insertMessage(db, 'msg-1', 'kilo-sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 500, write: 300 } },
      })
      insertPart(db, 'p-bash', 'msg-1', 'kilo-sess-1', { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' } } })
    })

    const calls = await collectKiloCalls(dbPath, 'kilo-sess-1')
    expect(calls).toEqual([
  {
    "bashCommands": [
      "npm",
    ],
    "cacheCreationInputTokens": 300,
    "cacheReadInputTokens": 500,
    "cachedInputTokens": 500,
    "costBasis": "estimated",
    "costUSD": 0.008875000000000001,
    "deduplicationKey": "kilo-code:kilo-sess-1:msg-1",
    "fallbackCostUSD": 0.05,
    "inputTokens": 100,
    "model": "claude-opus-4-6",
    "outputTokens": 200,
    "provider": "kilo-code",
    "reasoningTokens": 50,
    "sessionId": "kilo-sess-1",
    "skills": [],
    "speed": "standard",
    "subagentTypes": [],
    "timestamp": "2023-11-14T22:13:21.000Z",
    "tools": [
      "Bash",
    ],
    "userMessage": "kilocode prompt",
    "webSearchRequests": 0,
  },
])
    // Key-presence gate: kilo-code's SQLite arm goes through the same
    // toOpenCodeProviderCall as opencode, so the message-arm key shape must match.
    const keys = Object.keys(calls[0]!)
    expect(keys).toContain('skills')
    expect(keys).toContain('subagentTypes')
    expect(keys).toContain('bashCommands')
    expect(keys).not.toContain('project')
    expect(keys).not.toContain('projectPath')
  })
})

// Kilo-code mirror of the opencode S9 case (SQLite arm, §7). The opencode and
// kilo-code SQLite arms share readSqliteSessionRecords + decodeOpenCodeSession,
// so the session-level fallback must resolve `model` the same way for kilo.
// The kilo golden and the zero-yield stderr case never populate a session
// rollup, so this is the only kilo test that pins the fallback call end to end.

skipUnlessSqlite('kilo-code SQLite arm S9 mirror — session-level fallback', () => {
  it('emits the session-level fallback with the model resolved from the real `model` column', async () => {
    const dbPath = createKiloTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'kilo-sess-s9')
      insertMessage(db, 'msg-user', 'kilo-sess-s9', 1700000000000, { role: 'user' })
      insertPart(db, 'p-user', 'msg-user', 'kilo-sess-s9', { type: 'text', text: 'hello' })
      // session row rollup — model is the real-schema JSON object (same as S9)
      db.prepare(`UPDATE session SET cost=1, tokens_input=100, tokens_output=50, tokens_reasoning=5, tokens_cache_read=10, tokens_cache_write=20, model=? WHERE id=?`)
        .run(JSON.stringify({ providerID: 'test-provider', id: 'session-model' }), 'kilo-sess-s9')
    })

    const calls = await collectKiloCalls(dbPath, 'kilo-sess-s9')
    expect(calls).toEqual([
  {
    "bashCommands": [],
    "cacheCreationInputTokens": 20,
    "cacheReadInputTokens": 10,
    "cachedInputTokens": 10,
    "costBasis": "estimated",
    "costUSD": 1,
    "deduplicationKey": "kilo-code:kilo-sess-s9:session-level",
    "fallbackCostUSD": 1,
    "inputTokens": 100,
    "model": "test-provider/session-model",
    "outputTokens": 50,
    "provider": "kilo-code",
    "reasoningTokens": 5,
    "sessionId": "kilo-sess-s9",
    "speed": "standard",
    "timestamp": "2023-11-14T22:13:20.000Z",
    "tools": [],
    "userMessage": "",
    "webSearchRequests": 0,
  },
])
    // Key-presence gate, mirroring S9: the session-level arm emits NO
    // skills/subagentTypes keys for kilo-code either.
    const keys = Object.keys(calls[0]!)
    expect(keys).not.toContain('skills')
    expect(keys).not.toContain('subagentTypes')
    expect(keys).toContain('tools')
    expect(keys).toContain('bashCommands')
    expect(keys).toContain('fallbackCostUSD')
    expect(keys).toContain('costBasis')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CODEBURN_VERBOSE stderr parity
// ═════════════════════════════════════════════════════════════════════════════

skipUnlessSqlite('CODEBURN_VERBOSE stderr parity', () => {
  it('OpenCode emits the exact pre-migration stderr line on zero-yield SQLite session', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-verbose')
      // user-only messages => zero yield
      insertMessage(db, 'msg-user1', 'sess-verbose', 1700000000000, { role: 'user' })
      insertPart(db, 'p-user1', 'msg-user1', 'sess-verbose', { type: 'text', text: 'hello' })
      insertMessage(db, 'msg-system', 'sess-verbose', 1700000000100, { role: 'system' })
      insertMessage(db, 'msg-bad', 'sess-verbose', 1700000000200, { role: 'assistant' })
      // corrupt part data to exercise parseFail/part count path
      db.prepare(`INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)`)
        .run('part-bad', 'msg-bad', 'sess-verbose', 'not-json')
    })

    const provider = createOpenCodeProvider(tmpDir)
    const source = { path: `${dbPath}:sess-verbose`, project: 'myproject', provider: 'opencode' }
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const prev = process.env['CODEBURN_VERBOSE']
    process.env['CODEBURN_VERBOSE'] = '1'
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }
    process.env['CODEBURN_VERBOSE'] = prev

    expect(calls).toEqual([])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toEqual('codeburn: OpenCode session sess-verbose has 3 messages (0 unparseable, 1 non-user/assistant roles) but yielded 0 calls. Parts: 2.\n')
    spy.mockRestore()
  })

  it('KiloCode emits the exact pre-migration stderr line on zero-yield SQLite session', async () => {
    const dbPath = createKiloTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'kilo-sess-verbose')
      insertMessage(db, 'msg-user1', 'kilo-sess-verbose', 1700000000000, { role: 'user' })
      insertPart(db, 'p-user1', 'msg-user1', 'kilo-sess-verbose', { type: 'text', text: 'hello' })
      insertMessage(db, 'msg-system', 'kilo-sess-verbose', 1700000000100, { role: 'system' })
    })

    process.env['XDG_DATA_HOME'] = tmpDir
    const provider = createKiloCodeProvider()
    const source = { path: `${dbPath}:kilo-sess-verbose`, project: 'myproject', provider: provider.name }
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const prev = process.env['CODEBURN_VERBOSE']
    process.env['CODEBURN_VERBOSE'] = '1'
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }
    process.env['CODEBURN_VERBOSE'] = prev

    expect(calls).toEqual([])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toEqual('codeburn: KiloCode session kilo-sess-verbose has 2 messages (0 unparseable, 1 non-user/assistant roles) but yielded 0 calls. Parts: 1.\n')
    spy.mockRestore()
  })

  // The verbose notice belongs to the SQLite arm only. opencode serves both arms
  // from one provider instance, so the message/part counts handed from
  // readRecords to decode must not survive into a subsequent file-arm source.
  it('does not emit the SQLite verbose line for a zero-yield file session after a SQLite source', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-db')
      insertMessage(db, 'msg-1', 'sess-db', 1700000000000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })
    // A file session with only a user message yields nothing.
    await writeSession({
      sessionId: 'ses_fileonly',
      messages: [
        { id: 'msg_u', data: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
      ],
    })

    const provider = createOpenCodeProvider(tmpDir)
    const seen = new Set<string>()
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const prev = process.env['CODEBURN_VERBOSE']
    process.env['CODEBURN_VERBOSE'] = '1'
    const calls: ParsedProviderCall[] = []
    const sqliteSource = { path: `${dbPath}:sess-db`, project: 'myproject', provider: 'opencode' }
    for await (const call of provider.createSessionParser(sqliteSource, seen).parse()) calls.push(call)
    const fileSource = { path: join(tmpDir, 'opencode', 'storage', 'session', 'global', 'ses_fileonly.json'), project: 'myproject', provider: 'opencode' }
    for await (const call of provider.createSessionParser(fileSource, seen).parse()) calls.push(call)
    process.env['CODEBURN_VERBOSE'] = prev

    const writes = spy.mock.calls.map(c => String(c[0]))
    spy.mockRestore()
    expect(calls).toHaveLength(1)
    expect(writes.filter(w => w.includes('yielded 0 calls'))).toEqual([])
  })
})
