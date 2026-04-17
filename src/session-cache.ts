import { mkdirSync, unlinkSync } from 'fs'
import { statSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

import type { SessionSummary } from './types.js'

export const DEFAULT_DB_PATH = join(homedir(), '.cache', 'codeburn', 'session-cache.db')

// R2: schema
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS session_summaries (
    file_path TEXT PRIMARY KEY,
    mtime_ms INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    cached_at INTEGER NOT NULL
  )
`

type Statement = {
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): void
}

export type SessionCacheDb = {
  prepare(sql: string): Statement
  pragma(key: string, options?: Record<string, unknown>): unknown
  close(): void
}

type Constructor = new (path: string, options?: Record<string, unknown>) => SessionCacheDb

// R1, R11: open and initialize the cache database
export async function openCache(dbPath = DEFAULT_DB_PATH): Promise<SessionCacheDb | null> {
  try {
    mkdirSync(dirname(dbPath), { recursive: true })
  } catch {
    return null
  }

  let Ctor: Constructor
  try {
    const mod = await import('better-sqlite3') as { default: Constructor }
    Ctor = mod.default
  } catch {
    // C10: native addon absent - degrade gracefully
    return null
  }

  return tryInit(Ctor, dbPath, true)
}

function tryInit(Ctor: Constructor, dbPath: string, allowReset: boolean): SessionCacheDb | null {
  try {
    const db = new Ctor(dbPath)
    db.pragma('journal_mode = WAL')  // C7
    db.pragma('busy_timeout = 3000') // C7
    db.prepare(CREATE_TABLE).run()   // R2
    return db
  } catch {
    if (!allowReset) return null
    // R11: corrupt db - delete and recreate
    try { unlinkSync(dbPath) } catch {}
    return tryInit(Ctor, dbPath, false)
  }
}

// R3: cache hit requires mtime_ms AND file_size match
// R10: DEBUG logging
export function getCachedSummary(
  db: SessionCacheDb,
  filePath: string,
  mtimeMs: number,
  fileSize: number,
): SessionSummary | null {
  try {
    const row = db.prepare(
      'SELECT summary_json FROM session_summaries WHERE file_path = ? AND mtime_ms = ? AND file_size = ?'
    ).get(filePath, mtimeMs, fileSize) as { summary_json: string } | undefined

    if (!row) {
      if (process.env.DEBUG) process.stderr.write(`[session-cache] MISS ${filePath}\n`)
      return null
    }

    try {
      const summary = JSON.parse(row.summary_json) as SessionSummary
      if (process.env.DEBUG) process.stderr.write(`[session-cache] HIT ${filePath}\n`)
      return summary
    } catch {
      // R1: malformed JSON - delete corrupted row
      db.prepare('DELETE FROM session_summaries WHERE file_path = ?').run(filePath)
      if (process.env.DEBUG) process.stderr.write(`[session-cache] MISS ${filePath}\n`)
      return null
    }
  } catch {
    return null
  }
}

// R6: called after userMessage zeroing, before returning from parseSessionFile
export function putCachedSummary(
  db: SessionCacheDb,
  filePath: string,
  mtimeMs: number,
  fileSize: number,
  summary: SessionSummary,
): void {
  try {
    db.prepare(
      'INSERT OR REPLACE INTO session_summaries (file_path, mtime_ms, file_size, summary_json, cached_at) VALUES (?, ?, ?, ?, ?)'
    ).run(filePath, mtimeMs, fileSize, JSON.stringify(summary), Date.now())
  } catch {
    // C7: silently swallow write failures (busy_timeout exhausted, etc.)
  }
}

// Helper for tests and parser: stat a file and return cache-key fields
export function getFileFingerprint(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(filePath)
    return { mtimeMs: Math.floor(s.mtimeMs), size: s.size }  // R2: floor mtime
  } catch {
    return null
  }
}
