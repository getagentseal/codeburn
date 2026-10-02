import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isSqliteAvailable, isSqliteBusyError } from '../../src/sqlite.js'
import { createZcodeProvider } from '../../src/providers/zcode.js'
import { calculateCost } from '../../src/models.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

// Simulates SQLITE_BUSY on the message/part read specifically, without
// locking the whole file (SQLite has no table-level locks, so a real
// BEGIN EXCLUSIVE would also fail the earlier model_usage/tool_usage
// queries and never exercise this catch).
let simulateMessageBusy = false
vi.mock('../../src/sqlite.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sqlite.js')>()
  return {
    ...actual,
    openDatabase: (path: string) => {
      const real = actual.openDatabase(path)
      return {
        query: (sql: string, params?: unknown[]) => {
          if (simulateMessageBusy && /FROM message/.test(sql)) {
            const err = new Error('database is locked') as Error & { code: string }
            err.code = 'SQLITE_BUSY'
            throw err
          }
          return real.query(sql, params)
        },
        close: () => real.close(),
      }
    },
  }
})

const requireForTest = createRequire(import.meta.url)

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'zcode-test-'))
  simulateMessageBusy = false
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

// Minimal subset of the real ZCode schema (db v0.14.8) covering only the
// columns the provider reads. `message`/`part` are created separately (see
// createTranscriptTables) so the no-transcript tests also exercise the
// graceful degradation path.
function createZcodeDb(dir: string): string {
  const dbPath = join(dir, 'db.sqlite')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE tool_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      tool_name TEXT NOT NULL,
      started_at INTEGER NOT NULL
    )
  `)
  db.close()
  return dbPath
}

// The transcript tables PR attribution reads. Column subset of the real
// `message`/`part` schema; the provider reads role/turnId/prompt text via
// json_extract and the parts' text join.
function createTranscriptTables(dbPath: string): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      sequence INTEGER,
      data TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      sequence INTEGER,
      data TEXT NOT NULL
    )
  `)
  db.close()
}

function seedUserMessage(
  dbPath: string,
  id: string,
  sessionId: string,
  timeCreated: number,
  turnId: string | null,
  inputIntentText: string | null,
): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    const data: Record<string, unknown> = { role: 'user' }
    if (turnId) data.anchor = { turnId }
    if (inputIntentText !== null) data.metadata = { inputIntent: { text: inputIntentText } }
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, sequence, data) VALUES (?, ?, ?, ?, ?)',
    ).run(id, sessionId, timeCreated, timeCreated, JSON.stringify(data))
  } finally {
    db.close()
  }
}

function seedTextPart(dbPath: string, id: string, messageId: string, sessionId: string, sequence: number, text: string): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)',
    ).run(id, messageId, sessionId, sequence, JSON.stringify({ type: 'text', text }))
  } finally {
    db.close()
  }
}

// Seeds one session with a single GLM-5.2 request whose 9125 input tokens
// include 8064 cached, plus two tool calls in the same turn.
function seed(dbPath: string): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('sess-1', '/Users/me/proj')
    db.prepare(
      `INSERT INTO model_usage
       (id, session_id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mu-1', 'sess-1', 'turn-1', 'GLM-5.2', 9125, 27, 0, 0, 8064, 1781981181862, 1781981202412)
    db.prepare(
      'INSERT INTO tool_usage (id, session_id, turn_id, tool_name, started_at) VALUES (?, ?, ?, ?, ?)',
    ).run('tu-1', 'sess-1', 'turn-1', 'Bash', 1781981299176)
    db.prepare(
      'INSERT INTO tool_usage (id, session_id, turn_id, tool_name, started_at) VALUES (?, ?, ?, ?, ?)',
    ).run('tu-2', 'sess-1', 'turn-1', 'Read', 1781981315829)
  } finally {
    db.close()
  }
}

async function collect(parser: { parse(): AsyncGenerator<ParsedProviderCall> }): Promise<ParsedProviderCall[]> {
  const out: ParsedProviderCall[] = []
  for await (const call of parser.parse()) out.push(call)
  return out
}

describe('zcode provider', () => {
  it('discovers sessions that have usage', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createZcodeDb(tmpRoot)
    seed(dbPath)

    const provider = createZcodeProvider(dbPath)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.provider).toBe('zcode')
    expect(sessions[0]?.project).toBe('Users-me-proj')
  })

  it('splits cached tokens out of input and prices via the GLM-5.2 alias', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createZcodeDb(tmpRoot)
    seed(dbPath)

    const provider = createZcodeProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls = await collect(provider.createSessionParser(source!, new Set<string>()))

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.model).toBe('GLM-5.2')
    expect(call.inputTokens).toBe(1061) // 9125 - 8064 cached
    expect(call.cacheReadInputTokens).toBe(8064)
    expect(call.outputTokens).toBe(27)
    expect(call.tools).toEqual(['Bash', 'Read'])
    expect(call.costUSD).toBeGreaterThan(0)
  })

  it('bills reasoning tokens into the cost (GLM is reasoning-exclusive)', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createZcodeDb(tmpRoot)
    const { DatabaseSync: Database } = requireForTest('node:sqlite')
    const db = new Database(dbPath)
    try {
      db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('sess-r', '/Users/me/proj')
      // 5000 input (2000 cached), 300 output, 1500 reasoning.
      db.prepare(
        `INSERT INTO model_usage
         (id, session_id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('mu-r', 'sess-r', 'turn-r', 'GLM-5.2', 5000, 300, 1500, 0, 2000, 1781981181862, 1781981202412)
    } finally {
      db.close()
    }

    const provider = createZcodeProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls = await collect(provider.createSessionParser(source!, new Set<string>()))

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.reasoningTokens).toBe(1500)
    const freshInput = 5000 - 2000
    const withReasoning = calculateCost('GLM-5.2', freshInput, 300 + 1500, 0, 2000, 0)
    const withoutReasoning = calculateCost('GLM-5.2', freshInput, 300, 0, 2000, 0)
    expect(withReasoning).toBeGreaterThan(withoutReasoning)
    expect(call.costUSD).toBeCloseTo(withReasoning, 10)
  })

  it('does not re-emit rows already in the seen set', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createZcodeDb(tmpRoot)
    seed(dbPath)

    const provider = createZcodeProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const seen = new Set<string>()

    const first = await collect(provider.createSessionParser(source!, seen))
    const second = await collect(provider.createSessionParser(source!, seen))

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('carries turn prompt text and session PR links for attribution', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createZcodeDb(tmpRoot)
    createTranscriptTables(dbPath)
    const { DatabaseSync: Database } = requireForTest('node:sqlite')
    const db = new Database(dbPath)
    try {
      db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('sess-pr', '/Users/me/proj')
      const insertUsage = db.prepare(
        `INSERT INTO model_usage
         (id, session_id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      insertUsage.run('mu-p1', 'sess-pr', 'turn-1', 'GLM-5.2', 100, 10, 0, 0, 0, 1781981181862, 1781981202412)
      insertUsage.run('mu-p2', 'sess-pr', 'turn-2', 'GLM-5.2', 100, 10, 0, 0, 0, 1781981300000, 1781981310000)
    } finally {
      db.close()
    }
    // Turn 1: prompt text recorded in inputIntent. Turn 2: text only in the
    // message's parts. A turnless user message contributes to the session-wide
    // PR set but lands on no turn.
    seedUserMessage(dbPath, 'm-1', 'sess-pr', 1781981180000, 'turn-1',
      'review https://github.com/getagentseal/codeburn/pull/1264 and merge it')
    seedUserMessage(dbPath, 'm-2', 'sess-pr', 1781981290000, 'turn-2', null)
    seedTextPart(dbPath, 'p-2a', 'm-2', 'sess-pr', 1, 'fix the flaky test in https://github.com/getagentseal/codeburn/pull/1300')
    seedUserMessage(dbPath, 'm-3', 'sess-pr', 1781981400000, null,
      'also tracked by https://github.com/getagentseal/codeburn/pull/1400')

    const provider = createZcodeProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls = await collect(provider.createSessionParser(source!, new Set<string>()))

    expect(calls).toHaveLength(2)
    const byTurn = new Map(calls.map(c => [c.turnId, c]))
    expect(byTurn.get('turn-1')?.userMessage).toContain('pull/1264')
    expect(byTurn.get('turn-2')?.userMessage).toContain('pull/1300')
    // Session-wide set: every user-referenced PR URL, on every call, so the
    // cache's session-level prLinks gate sees all of them.
    for (const call of calls) {
      expect(call.prLinks).toEqual([
        'https://github.com/getagentseal/codeburn/pull/1264',
        'https://github.com/getagentseal/codeburn/pull/1300',
        'https://github.com/getagentseal/codeburn/pull/1400',
      ])
    }
  })

  it('propagates a busy message/part read instead of silently dropping it', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createZcodeDb(tmpRoot)
    createTranscriptTables(dbPath)
    seed(dbPath)
    seedUserMessage(dbPath, 'm-1', 'sess-1', 1781981180000, 'turn-1', 'see https://github.com/getagentseal/codeburn/pull/1264')

    simulateMessageBusy = true
    const provider = createZcodeProvider(dbPath)
    const [source] = await provider.discoverSessions()
    await expect(collect(provider.createSessionParser(source!, new Set<string>())))
      .rejects.toSatisfy((err: unknown) => isSqliteBusyError(err))
  })

  it('parses usage rows unchanged when the transcript tables are absent', async () => {
    if (!isSqliteAvailable()) return
    const dbPath = createZcodeDb(tmpRoot)
    seed(dbPath)

    const provider = createZcodeProvider(dbPath)
    const [source] = await provider.discoverSessions()
    const calls = await collect(provider.createSessionParser(source!, new Set<string>()))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe('')
    expect(calls[0]!.prLinks).toBeUndefined()
  })
})
