import { readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { calculateCost, getShortModelName } from '../models.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, isSqliteBusyError, type SqliteDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import type { ToolCall } from '../types.js'

type HermesSessionRow = {
  id: string
  source: string | null
  model: string | null
  billing_provider: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  api_call_count: number | null
  tool_call_count: number | null
  started_at: number | null
  ended_at: number | null
  title: string | null
}

type HermesMessageRow = {
  role: string
  content: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number | null
}

type HermesToolCall = {
  function?: {
    name?: string
    arguments?: string
  }
}

type ProfileDb = {
  dbPath: string
  profile: string
}

const toolNameMap: Record<string, string> = {
  terminal: 'Bash',
  execute_code: 'CodeExecution',
  read_file: 'Read',
  search_files: 'Grep',
  write_file: 'Write',
  patch: 'Edit',
  browser_navigate: 'Browser',
  browser_click: 'Browser',
  browser_type: 'Browser',
  browser_press: 'Browser',
  browser_scroll: 'Browser',
  browser_snapshot: 'Browser',
  browser_vision: 'Vision',
  browser_console: 'Browser',
  web_search: 'WebSearch',
  web_extract: 'WebFetch',
  todo: 'TodoWrite',
  skill_view: 'Skill',
  skill_manage: 'Skill',
  memory: 'Memory',
  session_search: 'SessionSearch',
}

function getHermesHome(override?: string): string {
  return override ?? process.env['HERMES_HOME'] ?? join(homedir(), '.hermes')
}

function sanitizeProject(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'hermes'
  return trimmed.replace(/^\//, '').replace(/\//g, '-')
}

function parseProfileName(dbPath: string, hermesHome: string): string {
  const profilesDir = join(hermesHome, 'profiles')
  const dir = dirname(dbPath)
  if (dir.startsWith(profilesDir)) return basename(dir)
  return 'default'
}

async function findStateDbs(hermesHome: string): Promise<ProfileDb[]> {
  const dbs: ProfileDb[] = []
  const rootDb = join(hermesHome, 'state.db')
  const rootStat = await stat(rootDb).catch(() => null)
  if (rootStat?.isFile()) dbs.push({ dbPath: rootDb, profile: 'default' })

  const profilesDir = join(hermesHome, 'profiles')
  const profiles = await readdir(profilesDir, { withFileTypes: true }).catch(() => [])
  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    const dbPath = join(profilesDir, entry.name, 'state.db')
    const s = await stat(dbPath).catch(() => null)
    if (s?.isFile()) dbs.push({ dbPath, profile: entry.name })
  }
  return dbs
}

function encodeSourcePath(dbPath: string, sessionId: string): string {
  return `${dbPath}#hermes-session=${encodeURIComponent(sessionId)}`
}

function decodeSourcePath(path: string): { dbPath: string; sessionId: string } | null {
  const marker = '#hermes-session='
  const idx = path.lastIndexOf(marker)
  if (idx === -1) return null
  return {
    dbPath: path.slice(0, idx),
    sessionId: decodeURIComponent(path.slice(idx + marker.length)),
  }
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query('SELECT id, model, input_tokens, output_tokens FROM sessions LIMIT 1')
    db.query('SELECT session_id, role, content, tool_calls FROM messages LIMIT 1')
    return true
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return false
  }
}

function parseTimestamp(raw: number | null): string {
  if (!raw) return ''
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function firstUserMessage(messages: HermesMessageRow[]): string {
  const msg = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0)
  return (msg?.content ?? '').slice(0, 500)
}

function mapToolName(raw: string): string {
  if (raw.startsWith('mcp_') || raw.startsWith('mcp__')) return raw
  if (raw.startsWith('mcp_composio_')) return 'MCP'
  if (raw.startsWith('browser_')) return 'Browser'
  return toolNameMap[raw] ?? raw
}

function parseToolCalls(raw: string | null): HermesToolCall[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as HermesToolCall[] : []
  } catch {
    return []
  }
}

function collectTools(messages: HermesMessageRow[]): { tools: string[]; toolSequence: ToolCall[][]; bashCommands: string[] } {
  const tools: string[] = []
  const toolSequence: ToolCall[][] = []
  const bashCommands: string[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const currentTurnTools: ToolCall[] = []
      for (const call of parseToolCalls(msg.tool_calls)) {
        const rawName = call.function?.name ?? ''
        if (!rawName) continue
        const mapped = mapToolName(rawName)
        tools.push(mapped)
        const toolCall: ToolCall = { tool: mapped }
        const rawArgs = call.function?.arguments
        if (rawArgs) {
          try {
            const args = JSON.parse(rawArgs) as Record<string, unknown>
            const file = args['path'] ?? args['file_path']
            if (typeof file === 'string') toolCall.file = file
            const command = args['command']
            if (typeof command === 'string') {
              toolCall.command = command
              bashCommands.push(command)
            }
          } catch {
            // Ignore malformed arguments from historical sessions.
          }
        }
        currentTurnTools.push(toolCall)
      }
      if (currentTurnTools.length > 0) {
        toolSequence.push(currentTurnTools)
      }
    } else if (msg.role === 'tool' && msg.tool_name) {
      tools.push(mapToolName(msg.tool_name))
    }
  }

  return {
    tools: [...new Set(tools)],
    toolSequence: toolSequence.length > 0 ? toolSequence : [],
    bashCommands,
  }
}

function inferProject(messages: HermesMessageRow[], fallback: string): { project: string; projectPath?: string } {
  const cwdPattern = /^Current working directory:\s*(\/[^\r\n`"\\]+)/m
  for (const msg of messages) {
    const text = msg.content ?? ''
    const match = cwdPattern.exec(text)
    if (match?.[1]) {
      const projectPath = match[1].trim()
      return { project: sanitizeProject(projectPath), projectPath }
    }
  }
  return { project: fallback }
}

async function discoverFromDb(dbPath: string, profile: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    if (!validateSchema(db)) return []
    const rows = db.query<HermesSessionRow>(
      `SELECT id, title, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
       FROM sessions
       WHERE coalesce(input_tokens, 0) + coalesce(output_tokens, 0) + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0) + coalesce(reasoning_tokens, 0) > 0
       ORDER BY started_at DESC`,
    )

    return rows.map(row => ({
      path: encodeSourcePath(dbPath, row.id),
      project: sanitizeProject(profile),
      provider: 'hermes',
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>, hermesHome: string): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const decoded = decodeSourcePath(source.path)
      if (!decoded) return
      const profile = parseProfileName(decoded.dbPath, hermesHome)

      let db: SqliteDatabase
      try {
        db = openDatabase(decoded.dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open Hermes database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        if (!validateSchema(db)) return
        const rows = db.query<HermesSessionRow>(
          `SELECT id, source, model, billing_provider, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, reasoning_tokens,
                  estimated_cost_usd, actual_cost_usd, api_call_count, tool_call_count,
                  started_at, ended_at, title
           FROM sessions
           WHERE id = ?`,
          [decoded.sessionId],
        )
        const row = rows[0]
        if (!row) return

        const messages = db.query<HermesMessageRow>(
          `SELECT role, content, tool_calls, tool_name, timestamp
           FROM messages
           WHERE session_id = ?
           ORDER BY timestamp ASC, id ASC`,
          [decoded.sessionId],
        )

        const inputTokens = row.input_tokens ?? 0
        const outputTokens = row.output_tokens ?? 0
        const cacheReadTokens = row.cache_read_tokens ?? 0
        const cacheWriteTokens = row.cache_write_tokens ?? 0
        const reasoningTokens = row.reasoning_tokens ?? 0
        if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens === 0) return

        const model = row.model ?? 'unknown'
        const { tools, toolSequence, bashCommands } = collectTools(messages)
        const projectInfo = inferProject(messages, sanitizeProject(profile))
        const timestamp = parseTimestamp(row.started_at)
        const dedupKey = `hermes:${profile}:${row.id}`
        if (seenKeys.has(dedupKey)) return
        seenKeys.add(dedupKey)

        const calculatedCost = calculateCost(
          model,
          inputTokens,
          outputTokens + reasoningTokens,
          cacheWriteTokens,
          cacheReadTokens,
          0,
        )
        const actualCost = row.actual_cost_usd ?? row.estimated_cost_usd ?? 0
        const costUSD = actualCost > 0 ? actualCost : calculatedCost

        yield {
          provider: 'hermes',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: cacheWriteTokens,
          cacheReadInputTokens: cacheReadTokens,
          cachedInputTokens: cacheReadTokens,
          reasoningTokens,
          webSearchRequests: 0,
          costUSD,
          tools,
          bashCommands,
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          turnId: `${row.id}:session`,
          toolSequence: toolSequence.length > 0 ? toolSequence : undefined,
          userMessage: firstUserMessage(messages),
          sessionId: row.id,
          project: projectInfo.project,
          projectPath: projectInfo.projectPath,
        }
      } catch {
        return
      } finally {
        db.close()
      }
    },
  }
}

export function createHermesProvider(hermesHomeOverride?: string): Provider {
  const hermesHome = getHermesHome(hermesHomeOverride)
  return {
    name: 'hermes',
    displayName: 'Hermes Agent',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      const dbs = await findStateDbs(hermesHome)
      const sessions: SessionSource[] = []
      for (const { dbPath, profile } of dbs) {
        sessions.push(...await discoverFromDb(dbPath, profile))
      }
      return sessions
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys, hermesHome)
    },
  }
}

export const hermes = createHermesProvider()
