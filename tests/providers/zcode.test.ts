import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { createZcodeProvider } from '../../src/providers/zcode.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'zcode-test-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

// Minimal subset of the real ZCode schema (db v0.14.8) covering only the
// columns the provider reads.
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
})
