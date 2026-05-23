import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHermesProvider } from '../../src/providers/hermes.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hermes-provider-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function createHermesDb(homeDir: string): string {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const dbPath = join(homeDir, 'state.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      model TEXT,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      api_call_count INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      started_at REAL,
      ended_at REAL,
      title TEXT
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL
    )
  `)
  db.close()
  return dbPath
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

async function collectCalls(hermesHome: string, sourcePath: string): Promise<ParsedProviderCall[]> {
  const provider = createHermesProvider(hermesHome)
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser({ path: sourcePath, project: 'hermes', provider: 'hermes' }, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('hermes provider', () => {
  it('discovers state.db sessions with token usage', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO sessions (id, source, model, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, started_at, title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('session-1', 'cli', 'gpt-5.5', 100, 20, 50, 5, 1779549200, 'Test Project')
      db.prepare(
        `INSERT INTO sessions (id, source, model, input_tokens, output_tokens, started_at, title)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('empty', 'cli', 'gpt-5.5', 0, 0, 1779549300, 'Empty')
    })

    const provider = createHermesProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('hermes')
    expect(sessions[0]!.path).toBe(`${dbPath}#hermes-session=session-1`)
    expect(sessions[0]!.project).toBe('default')
  })

  it('parses session-level token usage and tool calls from messages', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO sessions (
          id, source, model, billing_provider, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd,
          api_call_count, tool_call_count, started_at, title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('session-1', 'tui', 'gpt-5.5', 'openai-codex', 1000, 200, 300, 40, 25, 0.12, 3, 2, 1779549200, 'Provider Work')
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('session-1', 'user', 'Add Hermes support', 1779549201)
      db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(
          'session-1',
          'assistant',
          '',
          JSON.stringify([
            { function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/file.ts' }) } },
            { function: { name: 'terminal', arguments: JSON.stringify({ command: 'npm test' }) } },
          ]),
          1779549202,
        )
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=session-1`)
    expect(calls).toHaveLength(1)
    expect(calls[0]!).toMatchObject({
      provider: 'hermes',
      model: 'gpt-5.5',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 40,
      cachedInputTokens: 300,
      reasoningTokens: 25,
      costUSD: 0.12,
      userMessage: 'Add Hermes support',
      sessionId: 'session-1',
      deduplicationKey: 'hermes:default:session-1',
    })
    expect(calls[0]!.tools).toEqual(['Read', 'Bash'])
    expect(calls[0]!.bashCommands).toEqual(['npm test'])
    expect(calls[0]!.toolSequence).toEqual([
      [{ tool: 'Read', file: '/tmp/file.ts' }],
      [{ tool: 'Bash', command: 'npm test' }],
    ])
  })
})
