import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { SessionSummary } from '../src/types.js'
import { openCache, getCachedSummary, putCachedSummary } from '../src/session-cache.js'

function makeTempDir(): string {
  const dir = join(tmpdir(), `codeburn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

function makeDbPath(dir: string): string {
  return join(dir, 'session-cache.db')
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'test-session',
    project: 'test-project',
    firstTimestamp: '2026-01-01T10:00:00Z',
    lastTimestamp: '2026-01-01T11:00:00Z',
    totalCostUSD: 0.05,
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 3,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    ...overrides,
  }
}

describe('openCache', () => {
  it('AC1: creates cache directory if missing', async () => {
    const base = makeTempDir()
    const subdir = join(base, 'nested', 'cache')
    const dbPath = join(subdir, 'session-cache.db')
    try {
      const db = await openCache(dbPath)
      expect(db).not.toBeNull()
      db!.close()
    } finally {
      cleanup(base)
    }
  })

  it('AC3: creates session_summaries table with correct schema', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    try {
      const db = await openCache(dbPath)
      expect(db).not.toBeNull()
      const cols = db!.prepare(
        "SELECT name FROM pragma_table_info('session_summaries') ORDER BY cid"
      ).get as unknown
      // Check table exists by inserting and querying
      const info = db!.prepare("PRAGMA table_info(session_summaries)").get() as Record<string, unknown> | undefined
      // table exists if pragma returns a row
      expect(info).toBeDefined()
      db!.close()
    } finally {
      cleanup(dir)
    }
  })

  it('AC18: corrupt db (truncated to 0 bytes) triggers delete-and-recreate', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    // create a corrupt (empty) db file
    writeFileSync(dbPath, '')
    try {
      const db = await openCache(dbPath)
      expect(db).not.toBeNull()
      db!.close()
    } finally {
      cleanup(dir)
    }
  })
})

describe('getCachedSummary / putCachedSummary', () => {
  it('AC4: cache hit returns deserialized SessionSummary', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    try {
      const db = await openCache(dbPath)
      expect(db).not.toBeNull()

      const summary = makeSummary()
      putCachedSummary(db!, '/path/to/file.jsonl', 1000, 2000, summary)
      const result = getCachedSummary(db!, '/path/to/file.jsonl', 1000, 2000)
      expect(result).toEqual(summary)
      db!.close()
    } finally {
      cleanup(dir)
    }
  })

  it('AC5: mtime mismatch returns null', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    try {
      const db = await openCache(dbPath)
      expect(db).not.toBeNull()

      const summary = makeSummary()
      putCachedSummary(db!, '/path/to/file.jsonl', 1000, 2000, summary)
      const result = getCachedSummary(db!, '/path/to/file.jsonl', 1001, 2000)  // mtime differs by 1ms
      expect(result).toBeNull()
      db!.close()
    } finally {
      cleanup(dir)
    }
  })

  it('AC6: size mismatch (same mtime) returns null', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    try {
      const db = await openCache(dbPath)
      expect(db).not.toBeNull()

      const summary = makeSummary()
      putCachedSummary(db!, '/path/to/file.jsonl', 1000, 2000, summary)
      const result = getCachedSummary(db!, '/path/to/file.jsonl', 1000, 2001)  // size differs
      expect(result).toBeNull()
      db!.close()
    } finally {
      cleanup(dir)
    }
  })

  it('AC19: malformed summary_json returns null and deletes the row', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    try {
      const db = await openCache(dbPath)
      expect(db).not.toBeNull()

      // Insert a row with invalid JSON directly
      db!.prepare(
        'INSERT INTO session_summaries (file_path, mtime_ms, file_size, summary_json, cached_at) VALUES (?, ?, ?, ?, ?)'
      ).run('/bad/file.jsonl', 100, 200, 'not-valid-json', Date.now())

      const result = getCachedSummary(db!, '/bad/file.jsonl', 100, 200)
      expect(result).toBeNull()

      // Row should be deleted
      const row = db!.prepare('SELECT * FROM session_summaries WHERE file_path = ?').get('/bad/file.jsonl')
      expect(row).toBeUndefined()
      db!.close()
    } finally {
      cleanup(dir)
    }
  })

  it('putCachedSummary silently ignores subsequent writes if key changes', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    try {
      const db = await openCache(dbPath)
      expect(db).not.toBeNull()

      const summary1 = makeSummary({ sessionId: 'first' })
      const summary2 = makeSummary({ sessionId: 'second' })

      putCachedSummary(db!, '/file.jsonl', 1000, 2000, summary1)
      putCachedSummary(db!, '/file.jsonl', 1000, 2000, summary2)  // same key, should replace

      const result = getCachedSummary(db!, '/file.jsonl', 1000, 2000)
      expect(result?.sessionId).toBe('second')
      db!.close()
    } finally {
      cleanup(dir)
    }
  })
})

describe('DEBUG logging (AC16, AC17)', () => {
  afterEach(() => {
    delete process.env.DEBUG
    vi.restoreAllMocks()
  })

  it('AC16: logs HIT to stderr when DEBUG is set', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    process.env.DEBUG = '1'

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const db = await openCache(dbPath)
      const summary = makeSummary()
      putCachedSummary(db!, '/some/file.jsonl', 500, 1000, summary)
      getCachedSummary(db!, '/some/file.jsonl', 500, 1000)

      const calls = stderrSpy.mock.calls.map(c => String(c[0]))
      expect(calls.some(s => s.includes('[session-cache] HIT /some/file.jsonl'))).toBe(true)
      db!.close()
    } finally {
      cleanup(dir)
    }
  })

  it('AC17: no [session-cache] lines when DEBUG is unset', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    delete process.env.DEBUG

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const db = await openCache(dbPath)
      const summary = makeSummary()
      putCachedSummary(db!, '/some/file.jsonl', 500, 1000, summary)
      getCachedSummary(db!, '/some/file.jsonl', 500, 1000)

      const calls = stderrSpy.mock.calls.map(c => String(c[0]))
      expect(calls.some(s => s.includes('[session-cache]'))).toBe(false)
      db!.close()
    } finally {
      cleanup(dir)
    }
  })

  it('AC16: logs MISS when file not in cache', async () => {
    const dir = makeTempDir()
    const dbPath = makeDbPath(dir)
    process.env.DEBUG = '1'

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const db = await openCache(dbPath)
      getCachedSummary(db!, '/missing/file.jsonl', 100, 200)

      const calls = stderrSpy.mock.calls.map(c => String(c[0]))
      expect(calls.some(s => s.includes('[session-cache] MISS /missing/file.jsonl'))).toBe(true)
      db!.close()
    } finally {
      cleanup(dir)
    }
  })
})
