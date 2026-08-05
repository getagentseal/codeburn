import { readdir } from 'fs/promises'
import { join } from 'path'

import { isSqliteAvailable, getSqliteLoadError, openDatabase, blobToText, isSqliteBusyError, type SqliteDatabase } from '../sqlite.js'
import { sanitize } from './session-message.js'
import type {
  SessionSource,
} from './types.js'

type MessageRow = {
  session_id: string
  id: string
  time_created: number
  data: Uint8Array | string
}

type PartRow = {
  message_id: string
  data: Uint8Array | string
}

type SessionRow = {
  id: string
  directory: Uint8Array | string
  title: Uint8Array | string
  time_created: number
}

type SessionTokenRow = {
  cost?: number
  tokens_input?: number
  tokens_output?: number
  tokens_reasoning?: number
  tokens_cache_read?: number
  tokens_cache_write?: number
  model?: Uint8Array | string
}

function parseSessionModel(value: Uint8Array | string | undefined): string | undefined {
  try {
    const parsed: unknown = JSON.parse(blobToText(value))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

    const model = parsed as Record<string, unknown>
    const id = typeof model['id'] === 'string' ? model['id'].trim() : ''
    const providerID = typeof model['providerID'] === 'string' ? model['providerID'].trim() : ''
    return id && providerID ? `${providerID}/${id}` : undefined
  } catch {
    return undefined
  }
}

export function tryQuerySessionTokens(db: SqliteDatabase, sessionId: string): {
  cost: number; input: number; output: number; reasoning: number
  cacheRead: number; cacheWrite: number; model: string | undefined
} | null {
  try {
    const rows = db.query<SessionTokenRow>(
      `SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
              CAST(model AS BLOB) AS model
       FROM session WHERE id = ?`,
      [sessionId],
    )
    if (rows.length === 0) return null
    const r = rows[0]!
    return {
      cost: r.cost ?? 0,
      input: r.tokens_input ?? 0,
      output: r.tokens_output ?? 0,
      reasoning: r.tokens_reasoning ?? 0,
      cacheRead: r.tokens_cache_read ?? 0,
      cacheWrite: r.tokens_cache_write ?? 0,
      model: parseSessionModel(r.model),
    }
  } catch {
    return null
  }
}

type SchemaCheckResult = { ok: true } | { ok: false; missing: string[] }

function validateSchemaDetailed(db: SqliteDatabase): SchemaCheckResult {
  const required = ['session', 'message', 'part']
  const missing: string[] = []
  for (const table of required) {
    try {
      db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table} LIMIT 1`)
    } catch (err) {
      if (isSqliteBusyError(err)) throw err
      missing.push(table)
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

const warnedSchemas = new Map<string, Set<string>>()

function warnUnrecognizedSchemaOnce(providerLabel: string, missing: string[]): void {
  const providerSet = warnedSchemas.get(providerLabel) ?? new Set()
  const key = missing.slice().sort().join(',')
  if (providerSet.has(key)) return
  providerSet.add(key)
  warnedSchemas.set(providerLabel, providerSet)
  process.stderr.write(
    `codeburn: ${providerLabel} database is missing expected tables (${missing.join(', ')}). ` +
    `Run ${providerLabel} once to apply migrations, or report at https://github.com/getagentseal/codeburn/issues if this persists.\n`
  )
}

export type SqliteProviderConfig = {
  providerName: string
  displayName: string
  dbDir: string
  dbFilePrefix: string
}

export async function readSqliteSessionRecords(
  source: SessionSource,
  config: SqliteProviderConfig,
): Promise<{ records: unknown[]; messageCount: number; partCount: number } | null> {
  if (!isSqliteAvailable()) {
    process.stderr.write(getSqliteLoadError() + '\n')
    return null
  }

  const segments = source.path.split(':')
  const sessionId = segments[segments.length - 1]!
  const dbPath = segments.slice(0, -1).join(':')

  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch (err) {
    process.stderr.write(`codeburn: cannot open ${config.displayName} database: ${err instanceof Error ? err.message : err}\n`)
    return null
  }

  try {
    const schema = validateSchemaDetailed(db)
    if (!schema.ok) {
      warnUnrecognizedSchemaOnce(config.displayName, schema.missing)
      return null
    }

    const messages = db.query<MessageRow>(
      `WITH RECURSIVE session_tree(id) AS (
        SELECT id FROM session WHERE id = ?
        UNION
        SELECT child.id
        FROM session child
        JOIN session_tree parent ON child.parent_id = parent.id
        WHERE child.time_archived IS NULL
      )
      SELECT session_id, id, time_created, CAST(data AS BLOB) AS data
      FROM message
      WHERE session_id IN (SELECT id FROM session_tree)
      ORDER BY time_created ASC, id ASC`,
      [sessionId],
    )

    const parts = db.query<PartRow>(
      `WITH RECURSIVE session_tree(id) AS (
        SELECT id FROM session WHERE id = ?
        UNION
        SELECT child.id
        FROM session child
        JOIN session_tree parent ON child.parent_id = parent.id
        WHERE child.time_archived IS NULL
      )
      SELECT message_id, CAST(data AS BLOB) AS data
      FROM part
      WHERE session_id IN (SELECT id FROM session_tree)
      ORDER BY message_id, id`,
      [sessionId],
    )

    const sessionTokens = tryQuerySessionTokens(db, sessionId)

    return {
      records: [{
        kind: 'sqlite',
        sessionId,
        messages: messages.map(m => ({
          session_id: m.session_id,
          id: m.id,
          time_created: m.time_created,
          data: blobToText(m.data),
        })),
        parts: parts.map(p => ({
          message_id: p.message_id,
          data: blobToText(p.data),
        })),
        sessionTokens,
      }],
      messageCount: messages.length,
      partCount: parts.length,
    }
  } finally {
    db.close()
  }
}

export async function discoverSqliteSessions(
  config: SqliteProviderConfig,
): Promise<SessionSource[]> {
  if (!isSqliteAvailable()) return []

  let dbPaths: string[]
  try {
    const entries = await readdir(config.dbDir)
    dbPaths = entries
      .filter((f) => f.startsWith(config.dbFilePrefix) && f.endsWith('.db'))
      .map((f) => join(config.dbDir, f))
  } catch {
    return []
  }

  if (dbPaths.length === 0) return []

  const sessions: SessionSource[] = []
  for (const dbPath of dbPaths) {
    let db: SqliteDatabase
    try {
      db = openDatabase(dbPath)
    } catch {
      continue
    }

    try {
      const schema = validateSchemaDetailed(db)
      if (!schema.ok) continue

      const rows = db.query<SessionRow>(
        'SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC',
      )

      for (const row of rows) {
        const dir = blobToText(row.directory)
        const title = blobToText(row.title)
        sessions.push({
          path: `${dbPath}:${row.id}`,
          project: dir ? sanitize(dir) : sanitize(title),
          provider: config.providerName,
        })
      }
    } catch {
      // skip this DB
    } finally {
      db.close()
    }
  }

  return sessions
}
