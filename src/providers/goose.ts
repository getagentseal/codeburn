import { join } from 'path'
import { homedir, platform } from 'os'

import { calculateCost, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, blobToText, type SqliteDatabase } from '../sqlite.js'
import type { ToolCall } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

type SessionRow = {
  id: string
  name: string
  working_dir: string | null
  created_at: string | null
  updated_at: string | null
  accumulated_input_tokens: number | null
  accumulated_output_tokens: number | null
  provider_name: string | null
  model_config_json: Uint8Array | string | null
}

type ModelConfig = {
  model_name?: string
  reasoning?: boolean
}

type MessageRow = {
  message_id: string
  role: string
  content_json: Uint8Array | string
  created_timestamp: number
}

type ContentItem = {
  type: string
  toolCall?: { value?: { name?: string; arguments?: Record<string, unknown> } }
}

const toolNameMap: Record<string, string> = {
  developer__shell: 'Bash',
  developer__text_editor: 'Edit',
  developer__read_file: 'Read',
  developer__write_file: 'Write',
  developer__list_directory: 'LS',
  developer__search_files: 'Grep',
  computercontroller__shell: 'Bash',
}

function sanitize(dir: string): string {
  return dir.replace(/^\//, '').replace(/\//g, '-')
}

function getDbPath(): string {
  const root = process.env['GOOSE_PATH_ROOT']
  if (root) return join(root, 'data', 'sessions', 'sessions.db')

  const p = platform()
  if (p === 'darwin' || p === 'linux') {
    const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
    return join(base, 'goose', 'sessions', 'sessions.db')
  }
  return join(homedir(), 'AppData', 'Roaming', 'Block', 'goose', 'sessions', 'sessions.db')
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sessions LIMIT 1")
    db.query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM messages LIMIT 1")
    return true
  } catch {
    return false
  }
}

function parseModelConfig(raw: string | null): ModelConfig {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as ModelConfig
  } catch {
    return {}
  }
}

function extractToolsFromMessages(db: SqliteDatabase, sessionId: string): { tools: string[]; bashCommands: string[]; toolSequence: ToolCall[][] } {
  const tools: string[] = []
  const bashCommands: string[] = []
  const seen = new Set<string>()
  const toolSequence: ToolCall[][] = []

  try {
    const rows = db.query<{ content_json: Uint8Array | string }>(
      "SELECT CAST(content_json AS BLOB) AS content_json FROM messages WHERE session_id = ? AND role = 'assistant' AND content_json LIKE '%toolRequest%' ORDER BY created_timestamp ASC",
      [sessionId],
    )

    for (const row of rows) {
      let items: ContentItem[]
      try {
        items = JSON.parse(blobToText(row.content_json)) as ContentItem[]
      } catch {
        continue
      }
      const msgCalls: ToolCall[] = []
      for (const item of items) {
        if (item.type !== 'toolRequest') continue
        const rawName = item.toolCall?.value?.name ?? ''
        if (!rawName) continue
        const mapped = toolNameMap[rawName] ?? rawName.split('__').pop() ?? rawName
        if (!seen.has(mapped)) {
          seen.add(mapped)
          tools.push(mapped)
        }
        const call: ToolCall = { tool: mapped }
        const args = item.toolCall?.value?.arguments
        if (args && typeof args === 'object') {
          const fp = (args as Record<string, unknown>)['file_path']
          if (typeof fp === 'string') call.file = fp
          const cmd = (args as Record<string, unknown>)['command']
          if (typeof cmd === 'string') call.command = cmd
        }
        msgCalls.push(call)
        if (mapped === 'Bash') {
          const cmd = item.toolCall?.value?.arguments?.command
          if (typeof cmd === 'string') {
            for (const c of extractBashCommands(cmd)) {
              if (!bashCommands.includes(c)) bashCommands.push(c)
            }
          }
        }
      }
      if (msgCalls.length > 0) toolSequence.push(msgCalls)
    }
  } catch { /* best-effort */ }

  return { tools, bashCommands, toolSequence }
}

function getFirstUserMessage(db: SqliteDatabase, sessionId: string): string {
  try {
    const rows = db.query<{ content_json: Uint8Array | string }>(
      "SELECT CAST(content_json AS BLOB) AS content_json FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_timestamp ASC LIMIT 1",
      [sessionId],
    )
    if (rows.length === 0) return ''
    const items = JSON.parse(blobToText(rows[0]!.content_json)) as ContentItem[]
    const text = items.find(i => i.type === 'text') as { text?: string } | undefined
    return (text?.text ?? '').slice(0, 500)
  } catch {
    return ''
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
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
        process.stderr.write(`codeburn: cannot open Goose database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        if (!validateSchema(db)) return

        const rows = db.query<SessionRow>(
          'SELECT id, name, working_dir, created_at, updated_at, accumulated_input_tokens, accumulated_output_tokens, provider_name, CAST(model_config_json AS BLOB) AS model_config_json FROM sessions WHERE id = ?',
          [sessionId],
        )
        if (rows.length === 0) return

        const session = rows[0]!
        const inputTokens = session.accumulated_input_tokens ?? 0
        const outputTokens = session.accumulated_output_tokens ?? 0
        if (inputTokens === 0 && outputTokens === 0) return

        const dedupKey = `goose:${sessionId}`
        if (seenKeys.has(dedupKey)) return
        seenKeys.add(dedupKey)

        const config = parseModelConfig(blobToText(session.model_config_json))
        const model = config.model_name ?? 'unknown'
        const costUSD = calculateCost(model, inputTokens, outputTokens, 0, 0, 0)

        const { tools, bashCommands, toolSequence } = extractToolsFromMessages(db, sessionId)
        const userMessage = getFirstUserMessage(db, sessionId)

        const raw = session.updated_at || session.created_at || ''
        let ts = new Date(raw)
        if (isNaN(ts.getTime())) ts = new Date(raw + 'Z')
        if (isNaN(ts.getTime())) ts = new Date()

        yield {
          provider: 'goose',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools,
          bashCommands,
          toolSequence: toolSequence.length > 1 ? toolSequence : undefined,
          timestamp: ts.toISOString(),
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage,
          sessionId,
        }
      } finally {
        db.close()
      }
    },
  }
}

async function discoverFromDb(dbPath: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    const rows = db.query<SessionRow>(
      'SELECT id, name, working_dir, created_at, updated_at, accumulated_input_tokens, accumulated_output_tokens, provider_name, CAST(model_config_json AS BLOB) AS model_config_json FROM sessions ORDER BY updated_at DESC',
    )

    return rows
      .filter(r => (r.accumulated_input_tokens ?? 0) > 0 || (r.accumulated_output_tokens ?? 0) > 0)
      .map(row => ({
        path: `${dbPath}:${row.id}`,
        project: row.working_dir ? sanitize(row.working_dir) : 'goose',
        provider: 'goose',
      }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

const modelDisplayNames: Record<string, string> = {
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
}

export function createGooseProvider(): Provider {
  return {
    name: 'goose',
    displayName: 'Goose',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      const dbPath = getDbPath()
      return discoverFromDb(dbPath)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const goose = createGooseProvider()
