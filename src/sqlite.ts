import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

type Row = Record<string, unknown>

export type SqliteDatabase = {
  query<T extends Row = Row>(sql: string, params?: unknown[]): T[]
  close(): void
}

let BetterSqlite3: unknown = null
let loadAttempted = false
let loadError: string | null = null

function loadDriver(): boolean {
  if (loadAttempted) return BetterSqlite3 !== null
  loadAttempted = true
  try {
    BetterSqlite3 = require('better-sqlite3')
    return true
  } catch {
    loadError = 'SQLite-based providers (Cursor, OpenCode) require the better-sqlite3 package.\n' +
      'Install it with: npm install -g better-sqlite3\n' +
      'Then run codeburn again.'
    return false
  }
}

export function isSqliteAvailable(): boolean {
  return loadDriver()
}

export function getSqliteLoadError(): string {
  return loadError ?? 'SQLite driver not available'
}

export function openDatabase(path: string): SqliteDatabase {
  if (!loadDriver()) {
    throw new Error(getSqliteLoadError())
  }

  const Database = BetterSqlite3 as new (path: string, options?: Record<string, unknown>) => {
    prepare(sql: string): { all(...params: unknown[]): Row[] }
    close(): void
  }

  const db = new Database(path, { readonly: true, fileMustExist: true })

  return {
    query<T extends Row = Row>(sql: string, params: unknown[] = []): T[] {
      return db.prepare(sql).all(...params) as T[]
    },
    close() {
      db.close()
    },
  }
}
