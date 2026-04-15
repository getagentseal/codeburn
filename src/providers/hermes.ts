/**
 * CodeBurn Provider Plugin for Hermes Agent
 *
 * Reads Hermes session data from SQLite (state.db) and JSONL trajectory files,
 * distributes cumulative session-level tokens proportionally across assistant turns,
 * and yields ParsedProviderCall objects for the CodeBurn TUI dashboard.
 *
 * Install: copy this file into codeburn/src/providers/ and register in index.ts,
 *   or use as a standalone plugin (see README).
 */

import { readdir, readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// ---------------------------------------------------------------------------
// Model display name mappings
// ---------------------------------------------------------------------------
const modelDisplayNames: Record<string, string> = {
  'glm-5.1':                          'GLM 5.1',
  'minimax/minimax-m2.7':             'MiniMax M2.7',
  'nvidia/nemotron-3-super-120b-a12b': 'Nemotron 3 Super',
  'google/gemma-4-26b-a4b-it':        'Gemma 4 26B',
  'google/gemma-4-31b-it':           'Gemma 4 31B',
  'huihui-qwen3.5-27b-claude-4.6-opus-abliterated': 'Qwen3.5 27B Abli.',
  'anthropic/claude-opus-4.6':         'Opus 4.6',
  'anthropic/claude-sonnet-4.6':      'Sonnet 4.6',
  'anthropic/claude-sonnet-4':        'Sonnet 4',
  'anthropic/claude-haiku-4-5':       'Haiku 4.5',
  'openai/gpt-5':                     'GPT-5',
}

// ---------------------------------------------------------------------------
// Hermes tool name → CodeBurn display name mapping
// ---------------------------------------------------------------------------
const toolNameMap: Record<string, string> = {
  // File operations
  read_file:           'Read',
  write_file:          'Edit',
  patch:               'Edit',
  search_files:        'Glob',
  // Terminal / execution
  terminal:            'Bash',
  execute_code:        'Bash',
  process:             'Bash',
  // Browser
  browser_navigate:   'Browse',
  browser_click:      'Browse',
  browser_type:       'Browse',
  browser_snapshot:   'Browse',
  browser_scroll:     'Browse',
  browser_press:      'Browse',
  browser_back:       'Browse',
  browser_vision:     'Browse',
  browser_console:   'Browse',
  browser_get_images: 'Browse',
  // Web
  web_search:         'Search',
  web_extract:        'Search',
  // Delegation
  delegate_task:      'Agent',
  // Memory / skills
  memory:             'Memory',
  skill_manage:       'Skills',
  skill_view:         'Skills',
  skills_list:        'Skills',
  // Communication
  clarify:            'Clarify',
  text_to_speech:     'TTS',
  // Cron
  cronjob:            'Cron',
  // Vision
  vision_analyze:     'Vision',
  // Todo
  todo:               'Todo',
}

// ---------------------------------------------------------------------------
// SQLite helpers (lazy-loaded to fail gracefully when unavailable)
// ---------------------------------------------------------------------------

type SqliteDatabase = {
  query<T>(sql: string, params?: unknown[]): T[]
  close(): void
}

let sqliteModule: typeof import('better-sqlite3') | null = null
let sqliteLoadError: string | null = null
let sqliteLoadAttempted = false

async function loadSqlite(): Promise<void> {
  if (sqliteLoadAttempted) return
  sqliteLoadAttempted = true
  try {
    sqliteModule = await import('better-sqlite3')
  } catch (err) {
    sqliteLoadError = `codeburn: hermes provider requires better-sqlite3.\n  ${err instanceof Error ? err.message : err}`
  }
}

function isSqliteAvailable(): boolean {
  return sqliteModule !== null
}

function getSqliteLoadError(): string {
  return sqliteLoadError ?? 'codeburn: SQLite library not loaded'
}

function openDatabase(dbPath: string): SqliteDatabase {
  const mod = sqliteModule!
  if ('default' in mod && typeof mod.default === 'function') {
    const db = (mod.default as Function)(dbPath, { readonly: true })
    return {
      query<T>(sql: string, params?: unknown[]): T[] {
        if (params && params.length > 0) {
          return db.prepare(sql).bind(...params).all() as T[]
        }
        return db.prepare(sql).all() as T[]
      },
      close() { db.close() },
    }
  }
  throw new Error('better-sqlite3 not loaded correctly')
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getHermesDir(override?: string): string {
  return override ?? process.env['HERMES_HOME'] ?? join(homedir(), '.hermes')
}

function getStateDbPath(hermesDir: string): string {
  return join(hermesDir, 'state.db')
}

// ---------------------------------------------------------------------------
// Session discovery
// Reads sessions from the SQLite database; each session becomes a SessionSource
// ---------------------------------------------------------------------------

type SessionRow = {
  id: string
  source: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  message_count: number
  tool_call_count: number
  started_at: number
  ended_at: number | null
  title: string | null
}

async function discoverSessionsInDb(dbPath: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  if (!isSqliteAvailable()) return sources

  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return sources
  }

  try {
    const rows = db.query<SessionRow>(
      `SELECT id, source, model, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, reasoning_tokens, message_count, tool_call_count,
              started_at, ended_at, title
       FROM sessions
       WHERE input_tokens > 0
       ORDER BY started_at DESC`
    )

    for (const row of rows) {
      const project = row.title ?? row.source ?? 'hermes'
      sources.push({
        path: dbPath,
        project: sanitizeProject(project),
        provider: 'hermes',
      })
    }
  } catch {
    // Schema mismatch or other DB error — silently ignore
  } finally {
    db.close()
  }

  return sources
}

function sanitizeProject(name: string): string {
  return name
    .replace(/^\//, '')
    .replace(/[/\\:]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80)
}

// ---------------------------------------------------------------------------
// Message types read from SQLite
// ---------------------------------------------------------------------------

type MessageRow = {
  id: number
  session_id: string
  role: string
  content: string | null
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
}

// ---------------------------------------------------------------------------
// Session parser
// Reads messages from SQLite for a given session, groups by assistant turns,
// distributes session-level tokens proportionally across turns, and yields
// one ParsedProviderCall per assistant response (with tool calls attached to
// the preceding assistant turn).
// ---------------------------------------------------------------------------

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  hermesDir: string,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const dbPath = getStateDbPath(hermesDir)
      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(
          `codeburn: hermes: cannot open state.db: ${err instanceof Error ? err.message : err}\n`
        )
        return
      }

      try {
        // Fetch session metadata
        const sessions = db.query<SessionRow>(
          `SELECT id, source, model, input_tokens, output_tokens, cache_read_tokens,
                  cache_write_tokens, reasoning_tokens, message_count, tool_call_count,
                  started_at, ended_at, title
           FROM sessions
           WHERE input_tokens > 0
           ORDER BY started_at ASC`
        )

        for (const session of sessions) {
          // Fetch messages for this session
          const messages = db.query<MessageRow>(
            `SELECT id, session_id, role, content, tool_call_id, tool_calls,
                    tool_name, timestamp, token_count, finish_reason
             FROM messages
             WHERE session_id = ?
             ORDER BY id ASC`,
            [session.id]
          )

          if (messages.length === 0) continue

          // Build assistant turns: each assistant message + its subsequent tool messages
          const turns: {
            assistantMsg: MessageRow
            toolNames: string[]
            timestamp: number
            userMessage: string
          }[] = []

          let currentUserMessage = ''
          let pendingAssistant: MessageRow | null = null
          let pendingTools: string[] = []

          for (const msg of messages) {
            if (msg.role === 'user') {
              // Extract a short snippet from the user message for display
              const content = msg.content ?? ''
              currentUserMessage = content.slice(0, 500).replace(/\n/g, ' ').trim()
              continue
            }

            if (msg.role === 'assistant') {
              // Flush any previous pending assistant turn
              if (pendingAssistant) {
                turns.push({
                  assistantMsg: pendingAssistant,
                  toolNames: [...pendingTools],
                  timestamp: pendingAssistant.timestamp,
                  userMessage: currentUserMessage,
                })
              }
              pendingAssistant = msg
              pendingTools = []

              // Extract tool calls from this assistant message
              if (msg.tool_calls) {
                try {
                  const calls = JSON.parse(msg.tool_calls)
                  if (Array.isArray(calls)) {
                    for (const call of calls) {
                      const name = call?.function?.name ?? call?.name ?? ''
                      if (name) {
                        pendingTools.push(toolNameMap[name] ?? name)
                      }
                    }
                  }
                } catch { /* ignore parse errors */ }
              }
              continue
            }

            if (msg.role === 'tool' && pendingAssistant) {
              // Tool result messages belong to the current pending assistant turn
              const name = msg.tool_name
              if (name) {
                const displayName = toolNameMap[name] ?? name
                if (!pendingTools.includes(displayName)) {
                  pendingTools.push(displayName)
                }
              }
              continue
            }
          }

          // Flush last pending turn
          if (pendingAssistant) {
            turns.push({
              assistantMsg: pendingAssistant,
              toolNames: [...pendingTools],
              timestamp: pendingAssistant.timestamp,
              userMessage: currentUserMessage,
            })
          }

          if (turns.length === 0) continue

          // Distribute session-level tokens proportionally across turns.
          // Hermes stores cumulative totals at session level — token_count per
          // message is always NULL. We distribute proportionally based on the
          // character length of each assistant turn's content as a rough proxy
          // for output token share, and split input tokens equally (context is
          // shared across all turns).

          const sessionInputTokens     = session.input_tokens     ?? 0
          const sessionOutputTokens    = session.output_tokens    ?? 0
          const sessionCacheReadTokens  = session.cache_read_tokens  ?? 0
          const sessionCacheWriteTokens = session.cache_write_tokens ?? 0
          const sessionReasoningTokens  = session.reasoning_tokens  ?? 0

          // Calculate proportional weights using assistant content length
          const contentLengths = turns.map(t => {
            const content = t.assistantMsg.content ?? ''
            return Math.max(content.length, 1)  // minimum weight of 1
          })
          const totalContentLen = contentLengths.reduce((a, b) => a + b, 0)

          for (let i = 0; i < turns.length; i++) {
            const turn = turns[i]
            const weight = contentLengths[i] / totalContentLen

            // Input tokens split equally (all turns share the conversation context)
            const turnInputTokens = Math.round(sessionInputTokens / turns.length)
            // Output tokens split proportionally by content length
            const turnOutputTokens = Math.round(sessionOutputTokens * weight)
            // Cache read tokens split equally (context caching is session-wide)
            const turnCacheReadTokens = Math.round(sessionCacheReadTokens / turns.length)
            // Reasoning tokens split proportionally
            const turnReasoningTokens = Math.round(sessionReasoningTokens * weight)

            // Skip turns with zero tokens
            if (turnInputTokens === 0 && turnOutputTokens === 0) continue

            const timestamp = new Date(turn.timestamp * 1000).toISOString()
            const dedupKey = `hermes:${session.id}:${turn.assistantMsg.id}:${turnInputTokens}:${turnOutputTokens}`

            if (seenKeys.has(dedupKey)) continue
            seenKeys.add(dedupKey)

            // Estimate cost using CodeBurn's pricing models
            // Note: many Hermes models use custom providers with unknown pricing,
            // so cost may be $0 for unsupported models
            let costUSD = 0
            try {
              const { calculateCost } = await import('../models.js')
              costUSD = calculateCost(
                session.model,
                turnInputTokens,
                turnOutputTokens + turnReasoningTokens,
                sessionCacheWriteTokens > 0 ? Math.round(sessionCacheWriteTokens / turns.length) : 0,
                turnCacheReadTokens,
                0,
              )
            } catch { /* models.js not available — cost stays $0 */ }

            yield {
              provider: 'hermes',
              model: session.model,
              inputTokens: turnInputTokens,
              outputTokens: turnOutputTokens,
              cacheCreationInputTokens: sessionCacheWriteTokens > 0
                ? Math.round(sessionCacheWriteTokens / turns.length)
                : 0,
              cacheReadInputTokens: turnCacheReadTokens,
              cachedInputTokens: turnCacheReadTokens,
              reasoningTokens: turnReasoningTokens,
              webSearchRequests: turn.toolNames.includes('Search') ? 1 : 0,
              costUSD,
              tools: turn.toolNames,
              timestamp,
              speed: 'standard',
              deduplicationKey: dedupKey,
              userMessage: turn.userMessage,
              sessionId: session.id,
            }
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createHermesProvider(hermesDir?: string): Provider {
  const dir = getHermesDir(hermesDir)

  return {
    name: 'hermes',
    displayName: 'Hermes',

    modelDisplayName(model: string): string {
      // Strip provider prefix for display
      const stripped = model.replace(/^(anthropic|openai|google|nvidia|minimax|huihui)\//, '')
      for (const [key, name] of Object.entries(modelDisplayNames)) {
        if (model === key || stripped === key) return name
        if (model.startsWith(key) || stripped.startsWith(key)) return name
      }
      // Fallback: capitalize and shorten
      return stripped.length < model.length ? stripped : model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      await loadSqlite()
      if (!isSqliteAvailable()) return []

      const dbPath = getStateDbPath(dir)
      try {
        const s = await stat(dbPath)
        if (!s.isFile()) return []
      } catch {
        return []
      }

      return discoverSessionsInDb(dbPath)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys, dir)
    },
  }
}

export const hermes = createHermesProvider()