import { readdir } from 'fs/promises'
import { join } from 'path'

import { billableOutputTokens, calculateCost } from '../models.js'
import {
  isSqliteAvailable,
  getSqliteLoadError,
  openDatabase,
  blobToText,
  isSqliteBusyError,
  isSqliteReadonlyError,
  warnSqliteReadonlyOnce,
  type SqliteDatabase,
} from '../sqlite.js'
import { buildAssistantCall, parseTimestamp, sanitize, type MessageData, type PartData } from './session-message.js'
import type {
  SessionSource,
  SessionParser,
  ParsedProviderCall,
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

type V2MessageRow = {
  session_id: string
  id: string
  type: string
  seq: number
  time_created: number
  data: Uint8Array | string
}

/**
 * OpenCode 2.x generations (issue #1293): v2 writes `session_v2` + `session_message`
 * (its FK points at `session_v2(id)`), while the legacy `session`/`message`/`part`
 * tables freeze at upgrade and stay frozen — a session created on 2.x has rows in
 * `session_message` and zero new rows in `message`. This returns the DB's
 * primary generation (v2 when present), but on an upgraded DB the frozen legacy
 * rows are NOT dead: any legacy session whose id never made it into `session_v2`
 * is real history and is unioned in (see `discoverSqliteSessions` and the
 * per-session resolution in `parse`). v2 wins for any id present in both.
 */
function detectGeneration(db: SqliteDatabase): 'v2' | 'legacy' | null {
  try {
    const v2 = db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session_message')",
    )
    if ((v2[0]?.cnt ?? 0) === 2) return 'v2'
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
  }
  return validateSchemaDetailed(db).ok ? 'legacy' : null
}

/** True when `id` exists in `session_v2` (used to prefer v2 over a legacy row of
 *  the same id, and to route a legacy-only session to the legacy reader). */
function sessionInV2(db: SqliteDatabase, id: string): boolean {
  try {
    const rows = db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM session_v2 WHERE id = ?', [id])
    return (rows[0]?.cnt ?? 0) > 0
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return false
  }
}

/**
 * Normalizes v2 `session_message` rows into the legacy message/part shape the
 * shared parse loop already consumes. v2 payloads are tagged by the `type`
 * column (no `role` field); assistant messages carry `content` inline (no part
 * table), `model` as a `{id, providerID}` ref, and `tokens` in the same
 * normalized shape legacy stored.
 */
function v2RowsToLegacyShape(rows: V2MessageRow[]): { messages: MessageRow[]; partsByMsg: Map<string, PartData[]> } {
  const messages: MessageRow[] = []
  const partsByMsg = new Map<string, PartData[]>()

  for (const row of rows) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(blobToText(row.data)) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'user') {
      messages.push({ session_id: row.session_id, id: row.id, time_created: row.time_created, data: JSON.stringify({ role: 'user' }) })
      const text = typeof payload['text'] === 'string' ? payload['text'] : ''
      if (text) partsByMsg.set(row.id, [{ type: 'text', text }])
      continue
    }
    // Compaction rows carry their own CompactionUsage (cost + tokens for the
    // compaction request itself) and counted as assistant messages on 1.x, so
    // they must keep landing here or every compacted 2.x session undercounts.
    // A `running` compaction has neither and is dropped by buildAssistantCall.
    if (row.type !== 'assistant' && row.type !== 'compaction') continue

    const model = payload['model']
    const data: MessageData = { role: 'assistant' }
    if (model !== null && typeof model === 'object' && !Array.isArray(model)) {
      const ref = model as Record<string, unknown>
      const id = typeof ref['id'] === 'string' ? ref['id'] : ''
      const providerID = typeof ref['providerID'] === 'string' ? ref['providerID'] : ''
      if (id && providerID) data.modelID = `${providerID}/${id}`
    }
    if (typeof payload['cost'] === 'number') data.cost = payload['cost']
    const tokens = payload['tokens']
    if (tokens !== null && typeof tokens === 'object' && !Array.isArray(tokens)) data.tokens = tokens as MessageData['tokens']

    const parts: PartData[] = []
    const content = payload['content']
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item === null || typeof item !== 'object') continue
        const c = item as Record<string, unknown>
        if ((c['type'] === 'text' || c['type'] === 'reasoning') && typeof c['text'] === 'string' && c['text']) {
          parts.push({ type: c['type'] as string, text: c['text'] })
        } else if (c['type'] === 'tool') {
          const state = c['state']
          const input = state !== null && typeof state === 'object' && (state as Record<string, unknown>)['input'] !== null
            && typeof (state as Record<string, unknown>)['input'] === 'object'
            ? (state as Record<string, unknown>)['input'] as Record<string, unknown>
            : {}
          parts.push({ type: 'tool', tool: typeof c['name'] === 'string' ? c['name'] : '', state: { input } })
        }
      }
    }

    messages.push({ session_id: row.session_id, id: row.id, time_created: row.time_created, data: JSON.stringify(data) })
    partsByMsg.set(row.id, parts)
  }

  return { messages, partsByMsg }
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

function tryQuerySessionTokens(db: SqliteDatabase, sessionId: string, generation: 'v2' | 'legacy'): {
  cost: number; input: number; output: number; reasoning: number
  cacheRead: number; cacheWrite: number; model: string | undefined
} | null {
  try {
    // Both generations expose the same token columns; only the table name moves.
    const table = generation === 'v2' ? 'session_v2' : 'session'
    const rows = db.query<SessionTokenRow>(
      `SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
              CAST(model AS BLOB) AS model
       FROM ${table} WHERE id = ?`,
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

export function createSqliteSessionParser(
  source: SessionSource,
  seenKeys: Set<string>,
  config: SqliteProviderConfig,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const segments = source.path.split(':')
      const sessionId = segments[segments.length - 1]!
      const dbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open ${config.displayName} database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        const generation = detectGeneration(db)
        if (generation === null) {
          const schema = validateSchemaDetailed(db)
          if (!schema.ok) warnUnrecognizedSchemaOnce(config.displayName, schema.missing)
          return
        }

        // On an upgraded (v2 + legacy) DB, a session id that never migrated into
        // session_v2 lives only in the frozen legacy tables and must be read as
        // legacy — reading it from session_message would find nothing and drop
        // its history. v2-only and legacy-only DBs resolve to `generation` as
        // before.
        const gen: 'v2' | 'legacy' =
          generation === 'v2' && !sessionInV2(db, sessionId) && validateSchemaDetailed(db).ok
            ? 'legacy'
            : generation

        let messages: MessageRow[]
        let partsByMsg: Map<string, PartData[]>

        if (gen === 'v2') {
          const rows = db.query<V2MessageRow>(
            `WITH RECURSIVE session_tree(id) AS (
              SELECT id FROM session_v2 WHERE id = ?
              UNION
              SELECT child.id
              FROM session_v2 child
              JOIN session_tree parent ON child.parent_id = parent.id
            )
            SELECT session_id, id, type, seq, time_created, CAST(data AS BLOB) AS data
            FROM session_message
            WHERE session_id IN (SELECT id FROM session_tree)
            ORDER BY time_created ASC, session_id ASC, seq ASC`,
            [sessionId],
          )
          const normalized = v2RowsToLegacyShape(rows)
          messages = normalized.messages
          partsByMsg = normalized.partsByMsg
        } else {
          messages = db.query<MessageRow>(
            `WITH RECURSIVE session_tree(id) AS (
              SELECT id FROM session WHERE id = ?
              UNION
              SELECT child.id
              FROM session child
              JOIN session_tree parent ON child.parent_id = parent.id
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
            )
            SELECT message_id, CAST(data AS BLOB) AS data
            FROM part
            WHERE session_id IN (SELECT id FROM session_tree)
            ORDER BY message_id, id`,
            [sessionId],
          )

          partsByMsg = new Map<string, PartData[]>()
          for (const part of parts) {
            try {
              const parsed = JSON.parse(blobToText(part.data)) as PartData
              const list = partsByMsg.get(part.message_id) ?? []
              list.push(parsed)
              partsByMsg.set(part.message_id, list)
            } catch {
              // skip corrupt part data
            }
          }
        }

        const currentUserMessageBySession = new Map<string, string>()
        let yieldCount = 0
        let parseFailCount = 0
        let roleSkipCount = 0

        for (const msg of messages) {
          let data: MessageData
          try {
            data = JSON.parse(blobToText(msg.data)) as MessageData
          } catch {
            parseFailCount++
            continue
          }

          if (data.role === 'user') {
            const textParts = (partsByMsg.get(msg.id) ?? [])
              .filter((p) => p.type === 'text')
              .map((p) => p.text ?? '')
              .filter(Boolean)
            if (textParts.length > 0) {
              currentUserMessageBySession.set(msg.session_id, textParts.join(' '))
            }
            continue
          }

          if (data.role !== 'assistant' && data.role !== 'model') {
            if (data.role !== 'user') roleSkipCount++
            continue
          }

          const dedupKey = `${config.providerName}:${msg.session_id}:${msg.id}`
          if (seenKeys.has(dedupKey)) continue

          const call = buildAssistantCall({
            providerName: config.providerName,
            dedupKey,
            sessionId,
            data,
            parts: partsByMsg.get(msg.id) ?? [],
            timeCreatedMs: msg.time_created,
            userMessage: currentUserMessageBySession.get(msg.session_id) ?? '',
          })
          if (!call) continue

          seenKeys.add(dedupKey)
          yieldCount++
          yield call
        }

        if (yieldCount === 0 && messages.length > 0) {
          const sessionTokens = tryQuerySessionTokens(db, sessionId, gen)
          if (sessionTokens && (sessionTokens.cost > 0 || sessionTokens.input > 0 || sessionTokens.output > 0)) {
            const dedupKey = `${config.providerName}:${sessionId}:session-level`
            if (!seenKeys.has(dedupKey)) {
              seenKeys.add(dedupKey)
              const model = sessionTokens.model ?? 'unknown'
              // OpenCode stores reasoning in its own session column and bills it
              // at the output rate, so it has to join the output bucket here the
              // same way the per-message path does. Routed through
              // billableOutputTokens so this fallback can never drift from the
              // per-message pricing in buildAssistantCall. (#1334)
              const outputForCost = billableOutputTokens(config.providerName, sessionTokens.output, sessionTokens.reasoning)
              let costUSD = calculateCost(model, sessionTokens.input, outputForCost, sessionTokens.cacheWrite, sessionTokens.cacheRead, 0)
              if (costUSD === 0 && sessionTokens.cost > 0) costUSD = sessionTokens.cost
              yield {
                provider: config.providerName,
                model,
                inputTokens: sessionTokens.input,
                outputTokens: sessionTokens.output,
                cacheCreationInputTokens: sessionTokens.cacheWrite,
                cacheReadInputTokens: sessionTokens.cacheRead,
                cachedInputTokens: sessionTokens.cacheRead,
                reasoningTokens: sessionTokens.reasoning,
                webSearchRequests: 0,
                costUSD,
                tools: [],
                bashCommands: [],
                timestamp: parseTimestamp(messages[0]!.time_created),
                speed: 'standard',
                deduplicationKey: dedupKey,
                userMessage: '',
                sessionId,
              }
              yieldCount++
            }
          }

          if (yieldCount === 0 && process.env['CODEBURN_VERBOSE'] === '1') {
            process.stderr.write(
              `codeburn: ${config.displayName} session ${sessionId} has ${messages.length} messages ` +
              `(${parseFailCount} unparseable, ${roleSkipCount} non-user/assistant roles) ` +
              `but yielded 0 calls.\n`
            )
          }
        }
      } finally {
        db.close()
      }
    },
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
    } catch (err) {
      if (isSqliteReadonlyError(err)) warnSqliteReadonlyOnce(dbPath)
      continue
    }

    try {
      const generation = detectGeneration(db)
      if (generation === null) continue

      // Same projection on both generations; only the table name moves.
      const table = generation === 'v2' ? 'session_v2' : 'session'
      const rows = db.query<SessionRow>(
        `SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created
         FROM ${table} WHERE parent_id IS NULL ORDER BY time_created DESC`,
      )

      // On an upgraded DB, also surface legacy top-level sessions that never
      // migrated into session_v2 — their frozen history is otherwise dropped
      // (#1293). Sessions present in both are excluded here so v2 wins.
      if (generation === 'v2' && validateSchemaDetailed(db).ok) {
        rows.push(...db.query<SessionRow>(
          `SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created
           FROM session
           WHERE parent_id IS NULL AND id NOT IN (SELECT id FROM session_v2)
           ORDER BY time_created DESC`,
        ))
      }

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
