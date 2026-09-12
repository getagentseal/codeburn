import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { calculateCost } from '../models.js'
import { getSqliteLoadError, isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

type ConversationRow = {
  conversation_id: string
  title: string | null
  workspace_id: number | string
  context: string | null
  created_at: string | null
  updated_at: string | null
}

type DiscoveryRow = {
  conversation_id: string
  title: string | null
  workspace_id: string
}

type ContextMessage = {
  message?: {
    text?: {
      role?: unknown
      content?: unknown
      model?: unknown
      tool_calls?: unknown
    }
  }
  usage?: unknown
}

const DEFAULT_DB_PATH = join(homedir(), '.forge', '.forge.db')

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query('SELECT conversation_id, title, CAST(workspace_id AS TEXT) AS workspace_id, context, created_at, updated_at FROM conversations LIMIT 1')
    return true
  } catch {
    return false
  }
}

function sqliteTimestampToIso(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString()

  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/)
  if (match) {
    const ms = (match[3] ?? '').padEnd(3, '0').slice(0, 3)
    const parsed = new Date(`${match[1]}T${match[2]}.${ms}Z`)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
}

function actual(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  const raw = (value as Record<string, unknown>)['actual']
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

function usageActual(usage: unknown, key: string): number {
  if (!usage || typeof usage !== 'object') return 0
  return actual((usage as Record<string, unknown>)[key])
}

function mapToolName(name: string): string {
  switch (name) {
    case 'shell':
    case 'bash':
      return 'Bash'
    case 'read':
    case 'Read':
      return 'Read'
    case 'write':
    case 'Write':
      return 'Write'
    case 'patch':
    case 'Edit':
    case 'edit':
      return 'Edit'
    case 'fs_search':
    case 'grep':
      return 'Grep'
    case 'task':
    case 'dispatch_agent':
      return 'Agent'
    default:
      return name
  }
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

function toolCalls(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(v => v && typeof v === 'object') as Record<string, unknown>[] : []
}

function extractToolsAndCommands(calls: Record<string, unknown>[]): { tools: string[]; bashCommands: string[]; firstCallId?: string } {
  const tools: string[] = []
  const bashCommands: string[] = []
  let firstCallId: string | undefined

  for (const call of calls) {
    const rawName = call['name']
    if (typeof rawName !== 'string') continue
    if (!firstCallId && typeof call['call_id'] === 'string') firstCallId = call['call_id']

    const tool = mapToolName(rawName)
    pushUnique(tools, tool)

    if (tool === 'Bash') {
      const args = call['arguments']
      if (args && typeof args === 'object') {
        const command = (args as Record<string, unknown>)['command']
        if (typeof command === 'string') {
          for (const cmd of extractBashCommands(command)) pushUnique(bashCommands, cmd)
        }
      }
    }
  }

  return { tools, bashCommands, firstCallId }
}

function splitSourcePath(path: string): { dbPath: string; conversationId: string } | null {
  const idx = path.lastIndexOf(':')
  if (idx < 0) return null
  return { dbPath: path.slice(0, idx), conversationId: path.slice(idx + 1) }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const split = splitSourcePath(source.path)
      if (!split) return

      let db: SqliteDatabase
      try {
        db = openDatabase(split.dbPath)
      } catch {
        return
      }

      try {
        if (!validateSchema(db)) return
        const rows = db.query<ConversationRow>(
          `SELECT conversation_id, title, CAST(workspace_id AS TEXT) AS workspace_id, context, created_at, updated_at
           FROM conversations
           WHERE conversation_id = ?`,
          [split.conversationId],
        )
        const row = rows[0]
        if (!row?.context) return

        let parsed: unknown
        try {
          parsed = JSON.parse(row.context)
        } catch {
          return
        }
        const messages = Array.isArray((parsed as { messages?: unknown }).messages)
          ? (parsed as { messages: ContextMessage[] }).messages
          : []

        let userMessage = ''
        for (let i = 0; i < messages.length; i++) {
          const text = messages[i]?.message?.text
          const role = typeof text?.role === 'string' ? text.role.toLowerCase() : ''
          const content = typeof text?.content === 'string' ? text.content : ''

          if (role === 'user') {
            userMessage = content.length > 500 ? content.slice(0, 500) : content
            continue
          }
          if (role !== 'assistant') continue

          const promptTokens = usageActual(messages[i]?.usage, 'prompt_tokens')
          const outputTokens = usageActual(messages[i]?.usage, 'completion_tokens')
          const cachedInputTokens = usageActual(messages[i]?.usage, 'cached_tokens')
          const inputTokens = Math.max(0, promptTokens - cachedInputTokens)
          if (inputTokens === 0 && outputTokens === 0) continue

          const model = typeof text?.model === 'string' ? text.model : 'unknown'
          const calls = toolCalls(text?.tool_calls)
          const { tools, bashCommands, firstCallId } = extractToolsAndCommands(calls)
          const stableId = firstCallId ?? `${model}:${promptTokens}:${outputTokens}:${i}`
          const deduplicationKey = `forge:${row.conversation_id}:${stableId}`
          if (seenKeys.has(deduplicationKey)) continue
          seenKeys.add(deduplicationKey)
          yield {
            provider: 'forge',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cachedInputTokens,
            cachedInputTokens,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD: calculateCost(model, inputTokens, outputTokens, 0, cachedInputTokens, 0),
            tools,
            bashCommands,
            timestamp: sqliteTimestampToIso(row.updated_at ?? row.created_at),
            speed: 'standard',
            deduplicationKey,
            userMessage,
            sessionId: row.conversation_id,
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

async function discoverFromDb(dbPath: string): Promise<SessionSource[]> {
  if (!existsSync(dbPath)) return []

  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    if (!validateSchema(db)) return []
    const rows = db.query<DiscoveryRow>(
      `SELECT conversation_id, title, CAST(workspace_id AS TEXT) AS workspace_id
       FROM conversations
       WHERE context IS NOT NULL`,
    )
    return rows.map(row => ({
      path: `${dbPath}:${row.conversation_id}`,
      project: row.title ?? String(row.workspace_id),
      provider: 'forge',
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

export function createForgeProvider(dbPath = DEFAULT_DB_PATH): Provider {
  return {
    name: 'forge',
    displayName: 'Forge',

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
      return discoverFromDb(dbPath)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const forge = createForgeProvider()
