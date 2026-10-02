import { join } from 'path'
import { homedir } from 'os'

import { billableOutputTokens, calculateCost } from '../models.js'
import { isSqliteAvailable, getSqliteLoadError, isSqliteBusyError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall, ProbeRoot } from './types.js'

/// ZCode (CLI v0.14.x) records usage in a single SQLite database at
/// ~/.zcode/cli/db/db.sqlite. We read it because the other on-disk sources are
/// unusable for billing: the JSONL activity log redacts token counts, and no
/// source stores a dollar cost (GLM-5.2 runs on z.ai's start-plan subscription).
/// Tokens are exact; cost is computed from the pricing table. Schema verified
/// against db v0.14.8 on 2026-06-20.
///
/// PR attribution reads the `message`/`part` tables too: a user message's
/// `anchor.turnId` matches `model_usage.turn_id`, and its prompt text (the
/// `metadata.inputIntent.text` field, else the message's `text` parts) is what
/// the shared parser layer scans for GitHub PR references. Without it ZCode
/// sessions could never appear under attributed pull requests.

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

type MessageRow = {
  id: string
  data: string
}

type TextPartRow = {
  message_id: string
  text: string | null
}

type UserMessageData = {
  anchor?: { turnId?: string }
  metadata?: { inputIntent?: { text?: string } }
}

// Provider-neutral explicit-reference capture, mirrored from parser.ts (a
// provider cannot import the parser without a cycle). Full URLs only: a bare
// "#123" is repository-ambiguous and must never silently move spend between
// repositories.
const PR_URL_IN_TEXT_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g

function extractGithubPullUrls(text: string): string[] {
  return [...new Set(text.match(PR_URL_IN_TEXT_RE) ?? [])]
}

/// Per-turn user prompt text plus the session-wide set of GitHub PR URLs the
/// user referenced. The turn text feeds the parser layer's per-turn prRefs
/// extraction; the URL set seeds the cached file's session-level prLinks, the
/// gate every PR-attributed session must pass. Both degrade to empty on a DB
/// without `message`/`part` tables (older schema, or the test fixture), which
/// keeps usage rows exactly as they were before.
function loadPromptReferences(db: SqliteDatabase, sessionId: string): {
  turnTextByTurnId: Map<string, string>
  prLinks: string[]
} {
  const turnTextByTurnId = new Map<string, string>()
  const prUrls = new Set<string>()
  try {
    const messages = db.query<MessageRow>(
      `SELECT id, data FROM message
       WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
       ORDER BY time_created ASC, sequence ASC, id ASC`,
      [sessionId],
    )
    if (messages.length === 0) return { turnTextByTurnId, prLinks: [] }

    // Prompt text lives in `metadata.inputIntent.text` when the CLI recorded
    // it, otherwise in the message's `text` parts (queued/injected inputs).
    const partTextByMessage = new Map<string, string>()
    for (const part of db.query<TextPartRow>(
      `SELECT p.message_id as message_id, json_extract(p.data, '$.text') as text
       FROM part p
       WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'text'
         AND p.message_id IN (SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user')
       ORDER BY p.message_id, p.sequence ASC`,
      [sessionId, sessionId],
    )) {
      if (!part.text) continue
      const existing = partTextByMessage.get(part.message_id)
      partTextByMessage.set(part.message_id, existing ? `${existing}\n${part.text}` : part.text)
    }

    for (const message of messages) {
      let parsed: UserMessageData
      try {
        parsed = JSON.parse(message.data) as UserMessageData
      } catch {
        continue
      }
      const inputIntent = parsed.metadata?.inputIntent?.text
      const text = (typeof inputIntent === 'string' && inputIntent.trim()
        ? inputIntent
        : partTextByMessage.get(message.id)) ?? ''
      if (!text.trim()) continue
      for (const url of extractGithubPullUrls(text)) prUrls.add(url)
      const turnId = parsed.anchor?.turnId
      if (!turnId) continue
      const existing = turnTextByTurnId.get(turnId)
      turnTextByTurnId.set(turnId, existing ? `${existing}\n${text}` : text)
    }
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    // message/part are an optional read; usage rows still count without them.
  }
  return { turnTextByTurnId, prLinks: [...prUrls].sort() }
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

        const { turnTextByTurnId, prLinks } = loadPromptReferences(db, sessionId)

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
          // ZCode reports reasoning as a separate bucket and 'zcode' is not in
          // REASONING_INCLUDED_IN_OUTPUT, so bill it via the output-equivalent
          // (billableOutputTokens adds it back). Not doing so left reasoning
          // tokens unbilled.
          const costUSD = calculateCost(model, freshInput, billableOutputTokens('zcode', output, reasoning), cacheCreation, cacheRead, 0)

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
            userMessage: row.turn_id ? turnTextByTurnId.get(row.turn_id) ?? '' : '',
            ...(prLinks.length > 0 ? { prLinks } : {}),
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

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: dbPath, label: 'db' }]
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
