// Serve-hole proof for #943: CachedCall.nanoAiu already survives disk.
// cachedCallToApiCall must thread it onto ParsedApiCall with no CACHE_VERSION bump.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'

import { isSqliteAvailable } from '../src/sqlite.js'
import { CACHE_VERSION, clearLoadCacheMemo } from '../src/session-cache.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

const requireForTest = createRequire(import.meta.url)
type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...p: unknown[]): void }
  close(): void
}

function collectNanoAiu(projects: Awaited<ReturnType<typeof parseAllSessions>>): number[] {
  return projects
    .flatMap(p => p.sessions)
    .flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls)
    .map(c => c.nanoAiu)
    .filter((n): n is number => typeof n === 'number')
}

describe.skipIf(!isSqliteAvailable())('cachedCallToApiCall threads nanoAiu', () => {
  let tmpHome: string
  let tmpCache: string
  let dbPath: string

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'cb-aiu-serve-home-'))
    tmpCache = await mkdtemp(join(tmpdir(), 'cb-aiu-serve-cache-'))
    dbPath = join(tmpHome, 'session-store.db')

    process.env['HOME'] = tmpHome
    process.env['USERPROFILE'] = tmpHome
    process.env['CODEBURN_CACHE_DIR'] = tmpCache
    process.env['CODEBURN_COPILOT_SESSION_STORE_DB'] = dbPath
    process.env['CODEBURN_COPILOT_DISABLE_OTEL'] = '1'
    process.env['CODEBURN_COPILOT_SESSION_STATE_DIR'] = join(tmpHome, 'no-jsonl')
    process.env['CODEBURN_COPILOT_WS_STORAGE_DIR'] = join(tmpHome, 'no-ws')
    process.env['CODEBURN_COPILOT_GLOBAL_STORAGE_DIR'] = join(tmpHome, 'no-global')
    process.env['CODEBURN_COPILOT_JETBRAINS_DIR'] = join(tmpHome, 'no-jb')

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
    db.prepare(`INSERT INTO sessions (id, cwd) VALUES ('sess-aiu', '/tmp/codeburn')`).run()
    db.prepare(
      `INSERT INTO assistant_usage_events
         (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, created_at)
       VALUES ('sess-aiu', 'claude-sonnet-4-5', 1000, 20, 600, 300, 0, 1500000000, 1.0, '2026-08-05T12:00:00.000Z')`,
    ).run()
    db.close()
  })

  afterEach(async () => {
    clearSessionCache()
    clearLoadCacheMemo()
    await rm(tmpHome, { recursive: true, force: true })
    await rm(tmpCache, { recursive: true, force: true })
  })

  it('serves nanoAiu on a cold parse and a warm cache read without a CACHE_VERSION bump', async () => {
    expect(CACHE_VERSION).toBe(10)

    clearSessionCache()
    const cold = await parseAllSessions(undefined, 'copilot')
    expect(collectNanoAiu(cold)).toEqual([1_500_000_000])

    // Drop the in-memory memo only. Disk cache now serves via cachedCallToApiCall.
    clearSessionCache()
    const warm = await parseAllSessions(undefined, 'copilot')
    expect(collectNanoAiu(warm)).toEqual([1_500_000_000])
    expect(CACHE_VERSION).toBe(10)
  })
})
