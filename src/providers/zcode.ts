import { join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

/// ZCode (CLI v0.14.x) records usage in a single SQLite database at
/// ~/.zcode/cli/db/db.sqlite. We read it because the other on-disk sources are
/// unusable for billing: the JSONL activity log redacts token counts, and no
/// source stores a dollar cost (GLM-5.2 runs on z.ai's start-plan subscription).
/// Tokens are exact; cost is computed from the pricing table. Schema verified
/// against db v0.14.8 on 2026-06-20.

type SessionRow = {
  id: string
  directory: string
}

type UsageRow = {
  id: string
  turn_id: string | null
  model_id: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  started_at: number
  completed_at: number | null
}

type ToolRow = {
  turn_id: string | null
  tool_name: string
}

function getDbPath(override?: string): string {
  return override ?? join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
}

function sanitizeProject(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '-')
}

function epochMsToIso(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return new Date(0).toISOString()
  return new Date(ms).toISOString()
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM model_usage LIMIT 1')
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM session LIMIT 1')
    return true
  } catch {
    return false
  }
}

function discover(dbPath: string): SessionSource[] {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }
  try {
    if (!validateSchema(db)) return []
    const rows = db.query<SessionRow>(
      `SELECT DISTINCT s.id as id, s.directory as directory
       FROM session s
       JOIN model_usage m ON m.session_id = s.id
       WHERE m.input_tokens > 0 OR m.output_tokens > 0 OR m.reasoning_tokens > 0
          OR m.cache_read_input_tokens > 0 OR m.cache_creation_input_tokens > 0`,
    )
    return rows.map(row => ({
      path: `${dbPath}:${row.id}`,
      project: sanitizeProject(row.directory),
      provider: 'zcode',
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      // Source paths are `<dbPath>:<sessionId>`. Split from the right so a colon
      // in the path (Windows drive letter) doesn't corrupt the session id.
      const segments = source.path.split(':')
      const sessionId = segments[segments.length - 1]!
      const dbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(
          `codeburn: cannot open ZCode database: ${err instanceof Error ? err.message : err}\n`,
        )
        return
      }

      try {
        if (!validateSchema(db)) return

        // model_usage rows don't link to individual tool calls, only to a turn,
        // so collect each turn's tools and attach them to one request per turn
        // (below) to avoid double-counting across a turn's multiple requests.
        const toolRows = db.query<ToolRow>(
          `SELECT turn_id, tool_name FROM tool_usage
           WHERE session_id = ? AND turn_id IS NOT NULL
           ORDER BY started_at ASC`,
          [sessionId],
        )
        const toolsByTurn = new Map<string, string[]>()
        for (const tool of toolRows) {
          if (!tool.turn_id) continue
          const list = toolsByTurn.get(tool.turn_id) ?? []
          list.push(tool.tool_name)
          toolsByTurn.set(tool.turn_id, list)
        }

        const rows = db.query<UsageRow>(
          `SELECT id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens,
                  cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at
           FROM model_usage WHERE session_id = ?
           ORDER BY started_at ASC`,
          [sessionId],
        )

        const turnsWithToolsEmitted = new Set<string>()

        for (const row of rows) {
          const cacheRead = row.cache_read_input_tokens ?? 0
          const cacheCreation = row.cache_creation_input_tokens ?? 0
          const output = row.output_tokens ?? 0
          const reasoning = row.reasoning_tokens ?? 0
          // ZCode folds cached tokens into input_tokens (OpenAI-style). Split
          // them back out so fresh input bills at the input rate and cached at
          // the cache-read rate, matching the pricing table's Anthropic-style
          // semantics.
          const freshInput = Math.max(0, (row.input_tokens ?? 0) - cacheRead - cacheCreation)

          if (freshInput === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheCreation === 0) {
            continue
          }

          const dedupKey = `zcode:${row.id}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          let tools: string[] = []
          if (row.turn_id && !turnsWithToolsEmitted.has(row.turn_id)) {
            const turnTools = toolsByTurn.get(row.turn_id)
            if (turnTools && turnTools.length > 0) {
              tools = turnTools
              turnsWithToolsEmitted.add(row.turn_id)
            }
          }

          const model = row.model_id
          const costUSD = calculateCost(model, freshInput, output, cacheCreation, cacheRead, 0)

          yield {
            provider: 'zcode',
            model,
            inputTokens: freshInput,
            outputTokens: output,
            cacheCreationInputTokens: cacheCreation,
            cacheReadInputTokens: cacheRead,
            cachedInputTokens: 0,
            reasoningTokens: reasoning,
            webSearchRequests: 0,
            costUSD,
            tools,
            bashCommands: [],
            timestamp: epochMsToIso(row.completed_at ?? row.started_at),
            speed: 'standard',
            deduplicationKey: dedupKey,
            turnId: row.turn_id ?? undefined,
            userMessage: '',
            sessionId,
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

export function createZcodeProvider(dbPathOverride?: string): Provider {
  const dbPath = getDbPath(dbPathOverride)
  return {
    name: 'zcode',
    displayName: 'ZCode',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      return discover(dbPath)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const zcode = createZcodeProvider()
