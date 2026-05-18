import { readdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { calculateCost, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, blobToText, isSqliteBusyError, type SqliteDatabase } from '../sqlite.js'
import type {
  Provider,
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

type MessageData = {
  role: string
  modelID?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

type PartData = {
  type: string
  text?: string
  tool?: string
  state?: { input?: { command?: string } }
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  skill: 'Skill',
  patch: 'Patch',
}

function normalizeToolName(rawTool?: string): string {
  if (!rawTool) return ''
  if (rawTool.startsWith('mcp__')) return rawTool

  const builtIn = toolNameMap[rawTool]
  if (builtIn) return builtIn

  // OpenCode stores MCP calls as `<server>_<tool>` with no separate server field.
  // Built-ins are handled above, and server ids are assumed not to contain `_`.
  const serverSeparator = rawTool.indexOf('_')
  if (serverSeparator > 0 && serverSeparator < rawTool.length - 1) {
    const server = rawTool.slice(0, serverSeparator)
    const tool = rawTool.slice(serverSeparator + 1)
    return `mcp__${server}__${tool}`
  }

  return rawTool
}

function sanitize(dir: string): string {
  return dir.replace(/^\//, '').replace(/\//g, '-')
}

function getDataDir(dataDir?: string): string {
  const base =
    dataDir ??
    process.env['XDG_DATA_HOME'] ??
    join(homedir(), '.local', 'share')
  return join(base, 'opencode')
}

async function findDbFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries
      .filter((f) => f.startsWith('opencode') && f.endsWith('.db'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

function parseTimestamp(raw: number): string {
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function projectFromSession(row: SessionRow): string {
  const dir = blobToText(row.directory)
  const title = blobToText(row.title)
  return dir ? sanitize(dir) : sanitize(title)
}

function parseSourcePath(path: string): { dbPath: string; rootSessionId?: string } {
  const segments = path.split(':')
  if (segments.length > 1) {
    const rootSessionId = segments[segments.length - 1]
    const dbPath = segments.slice(0, -1).join(':')
    if (rootSessionId && dbPath.endsWith('.db')) return { dbPath, rootSessionId }
  }
  return { dbPath: path }
}

function getRootSessions(db: SqliteDatabase, rootSessionId?: string): SessionRow[] {
  const select =
    'SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created FROM session'
  if (rootSessionId) {
    return db.query<SessionRow>(
      `${select} WHERE id = ? AND time_archived IS NULL ORDER BY time_created DESC`,
      [rootSessionId],
    )
  }
  return db.query<SessionRow>(
    `${select} WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC`,
  )
}

type SchemaCheckResult =
  | { ok: true }
  | { ok: false; missing: string[] }

/// Inspects OpenCode's SQLite schema. Returns the list of expected tables that
/// are missing rather than just a boolean so the caller can produce an actionable
/// warning ("missing 'part' table") instead of a generic "format not recognized".
/// Only emits the warning when meaningful tables are absent — a brand-new
/// OpenCode install with an empty DB but valid schema does NOT trigger it.
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

function validateSchema(db: SqliteDatabase): boolean {
  return validateSchemaDetailed(db).ok
}

const warnedOpenCodeSchemas = new Set<string>()

function warnUnrecognizedOpenCodeSchemaOnce(missing: string[]): void {
  const key = missing.slice().sort().join(',')
  if (warnedOpenCodeSchemas.has(key)) return
  warnedOpenCodeSchemas.add(key)
  process.stderr.write(
    `codeburn: OpenCode database is missing expected tables (${missing.join(', ')}). ` +
    `Run OpenCode once to apply migrations, or report at https://github.com/getagentseal/codeburn/issues if this persists on a current OpenCode install.\n`
  )
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const { dbPath, rootSessionId } = parseSourcePath(source.path)

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open OpenCode database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        const schema = validateSchemaDetailed(db)
        if (!schema.ok) {
          // Warn at most once per process per missing-table set so a directory
          // with a half-migrated OpenCode DB doesn't spam stderr on every
          // session iteration. Show which tables we couldn't find so the
          // user (or a triage agent) knows whether to re-run OpenCode's
          // migration or report a CodeBurn schema gap.
          warnUnrecognizedOpenCodeSchemaOnce(schema.missing)
          return
        }

        const roots = getRootSessions(db, rootSessionId)
        for (const root of roots) {
          const sessionId = root.id
          const project = projectFromSession(root) || source.project

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

          const partsByMsg = new Map<string, PartData[]>()
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

          const currentUserMessageBySession = new Map<string, string>()

          for (const msg of messages) {
            let data: MessageData
            try {
              data = JSON.parse(blobToText(msg.data)) as MessageData
            } catch {
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

            if (data.role !== 'assistant') continue

            const tokens = {
              input: data.tokens?.input ?? 0,
              output: data.tokens?.output ?? 0,
              reasoning: data.tokens?.reasoning ?? 0,
              cacheRead: data.tokens?.cache?.read ?? 0,
              cacheWrite: data.tokens?.cache?.write ?? 0,
            }

            const allZero =
              tokens.input === 0 &&
              tokens.output === 0 &&
              tokens.reasoning === 0 &&
              tokens.cacheRead === 0 &&
              tokens.cacheWrite === 0
            if (allZero && (data.cost ?? 0) === 0) continue

            const msgParts = partsByMsg.get(msg.id) ?? []
            const toolParts = msgParts.filter((p) => p.type === 'tool')
            const tools = toolParts
              .map((p) => normalizeToolName(p.tool))
              .filter(Boolean)

            const bashCommands = toolParts
              .filter((p) => p.tool === 'bash' && typeof p.state?.input?.command === 'string')
              .flatMap((p) => extractBashCommands(p.state!.input!.command!))

            const dedupKey = `opencode:${msg.session_id}:${msg.id}`
            if (seenKeys.has(dedupKey)) continue
            seenKeys.add(dedupKey)

            const model = data.modelID ?? 'unknown'
            let costUSD = calculateCost(
              model,
              tokens.input,
              tokens.output + tokens.reasoning,
              tokens.cacheWrite,
              tokens.cacheRead,
              0,
            )

            if (costUSD === 0 && typeof data.cost === 'number' && data.cost > 0) {
              costUSD = data.cost
            }

            yield {
              provider: 'opencode',
              model,
              inputTokens: tokens.input,
              outputTokens: tokens.output,
              cacheCreationInputTokens: tokens.cacheWrite,
              cacheReadInputTokens: tokens.cacheRead,
              cachedInputTokens: tokens.cacheRead,
              reasoningTokens: tokens.reasoning,
              webSearchRequests: 0,
              costUSD,
              tools,
              bashCommands,
              timestamp: parseTimestamp(msg.time_created),
              speed: 'standard',
              deduplicationKey: dedupKey,
              userMessage: currentUserMessageBySession.get(msg.session_id) ?? '',
              sessionId,
              project,
            }
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

export function createOpenCodeProvider(dataDir?: string): Provider {
  const dir = getDataDir(dataDir)

  return {
    name: 'opencode',
    displayName: 'OpenCode',

    modelDisplayName(model: string): string {
      const stripped = model.replace(/^[^/]+\//, '')
      return getShortModelName(stripped)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []

      const dbPaths = await findDbFiles(dir)
      if (dbPaths.length === 0) return []

      return dbPaths.map((dbPath) => ({
        path: dbPath,
        project: 'opencode',
        provider: 'opencode',
      }))
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
    ): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const opencode = createOpenCodeProvider()
