import { readdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { calculateCost, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type {
  Provider,
  SessionSource,
  SessionParser,
  ParsedProviderCall,
} from './types.js'

type MessageRow = {
  id: string
  time_created: number
  data: string
}

type PartRow = {
  message_id: string
  data: string
}

type SessionRow = {
  id: string
  directory: string
  title: string
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

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM session LIMIT 1"
    )
    db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM message LIMIT 1"
    )
    return true
  } catch {
    return false
  }
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

      // Path is encoded as `${dbPath}:${sessionId}`. Session IDs are UUIDs
      // (no colons), so the last segment after splitting on ':' is always
      // the session ID. Rejoining handles Windows drive letters (C:\...).
      const segments = source.path.split(':')
      const sessionId = segments[segments.length - 1]!
      const dbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open OpenCode database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        if (!validateSchema(db)) {
          process.stderr.write('codeburn: OpenCode storage format not recognized. You may need to update CodeBurn.\n')
          return
        }

        const messages = db.query<MessageRow>(
          'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC',
          [sessionId],
        )

        const parts = db.query<PartRow>(
          'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id',
          [sessionId],
        )

        const partsByMsg = new Map<string, PartData[]>()
        for (const part of parts) {
          try {
            const parsed = JSON.parse(part.data) as PartData
            const list = partsByMsg.get(part.message_id) ?? []
            list.push(parsed)
            partsByMsg.set(part.message_id, list)
          } catch {
            // skip corrupt part data
          }
        }

        let currentUserMessage = ''

        for (const msg of messages) {
          let data: MessageData
          try {
            data = JSON.parse(msg.data) as MessageData
          } catch {
            continue
          }

          if (data.role === 'user') {
            const textParts = (partsByMsg.get(msg.id) ?? [])
              .filter((p) => p.type === 'text')
              .map((p) => p.text ?? '')
              .filter(Boolean)
            if (textParts.length > 0) {
              currentUserMessage = textParts.join(' ')
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
            .map((p) => toolNameMap[p.tool ?? ''] ?? p.tool ?? '')
            .filter(Boolean)

          const bashCommands = toolParts
            .filter((p) => p.tool === 'bash' && typeof p.state?.input?.command === 'string')
            .flatMap((p) => extractBashCommands(p.state!.input!.command!))

          const dedupKey = `opencode:${sessionId}:${msg.id}`
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
            userMessage: currentUserMessage,
            sessionId,
          }
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
      'SELECT id, directory, title, time_created FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC',
    )

    return rows.map((row) => ({
      path: `${dbPath}:${row.id}`,
      project: row.directory ? sanitize(row.directory) : sanitize(row.title),
      provider: 'opencode',
    }))
  } catch {
    return []
  } finally {
    db.close()
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

      const sessions: SessionSource[] = []
      for (const dbPath of dbPaths) {
        sessions.push(...await discoverFromDb(dbPath))
      }
      return sessions
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
