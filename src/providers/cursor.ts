import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { readCachedResults, writeCachedResults } from '../cursor-cache.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const CURSOR_DEFAULT_MODEL = 'claude-sonnet-4-5'

const modelDisplayNames: Record<string, string> = {
  'claude-4.5-opus-high-thinking': 'Opus 4.5 (Thinking)',
  'claude-4-opus': 'Opus 4',
  'claude-4-sonnet-thinking': 'Sonnet 4 (Thinking)',
  'claude-4.5-sonnet-thinking': 'Sonnet 4.5 (Thinking)',
  'claude-4.6-sonnet': 'Sonnet 4.6',
  'composer-1': 'Composer 1',
  'grok-code-fast-1': 'Grok Code Fast',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.1-codex-high': 'GPT-5.1 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4.1': 'GPT-4.1',
  'default': 'Auto (Sonnet est.)',
}

type BubbleRow = {
  input_tokens: number | null
  output_tokens: number | null
  model: string | null
  created_at: string | null
  conversation_id: string | null
  user_text: string | null
  code_blocks: string | null
}

function getCursorDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

type CodeBlock = { languageId?: string }

function extractLanguages(codeBlocksJson: string | null): string[] {
  if (!codeBlocksJson) return []
  try {
    const blocks = JSON.parse(codeBlocksJson) as CodeBlock[]
    if (!Array.isArray(blocks)) return []
    const langs = new Set<string>()
    for (const block of blocks) {
      if (block.languageId && block.languageId !== 'plaintext') {
        langs.add(block.languageId)
      }
    }
    return [...langs]
  } catch {
    return []
  }
}

function resolveModel(raw: string | null): string {
  if (!raw || raw === 'default') return CURSOR_DEFAULT_MODEL
  return raw
}

function modelForDisplay(raw: string | null): string {
  if (!raw || raw === 'default') return 'default'
  return raw
}

const BUBBLE_QUERY_BASE = `
  SELECT
    json_extract(value, '$.tokenCount.inputTokens') as input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') as output_tokens,
    json_extract(value, '$.modelInfo.modelName') as model,
    json_extract(value, '$.createdAt') as created_at,
    json_extract(value, '$.conversationId') as conversation_id,
    substr(json_extract(value, '$.text'), 1, 500) as user_text,
    json_extract(value, '$.codeBlocks') as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.tokenCount.inputTokens') > 0
`

const USER_MESSAGES_QUERY = `
  SELECT
    json_extract(value, '$.conversationId') as conversation_id,
    json_extract(value, '$.createdAt') as created_at,
    substr(json_extract(value, '$.text'), 1, 500) as text
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.type') = 1
    AND json_extract(value, '$.createdAt') > ?
  ORDER BY json_extract(value, '$.createdAt') ASC
`

const BUBBLE_QUERY_SINCE = BUBBLE_QUERY_BASE + `
    AND json_extract(value, '$.createdAt') > ?
  ORDER BY json_extract(value, '$.createdAt') ASC
`

function validateSchema(db: SqliteDatabase): boolean {
  try {
    const rows = db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' LIMIT 1"
    )
    return rows.length > 0
  } catch {
    return false
  }
}

type UserMsgRow = { conversation_id: string; created_at: string; text: string }

function buildUserMessageMap(db: SqliteDatabase, timeFloor: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  try {
    const rows = db.query<UserMsgRow>(USER_MESSAGES_QUERY, [timeFloor])
    for (const row of rows) {
      if (!row.conversation_id || !row.text) continue
      const existing = map.get(row.conversation_id) ?? []
      existing.push(row.text)
      map.set(row.conversation_id, existing)
    }
  } catch {}
  return map
}

function parseBubbles(db: SqliteDatabase, seenKeys: Set<string>): { calls: ParsedProviderCall[] } {
  const results: ParsedProviderCall[] = []
  let skipped = 0

  const DEFAULT_LOOKBACK_DAYS = 35
  const timeFloor = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const userMessages = buildUserMessageMap(db, timeFloor)

  let rows: BubbleRow[]
  try {
    rows = db.query<BubbleRow>(BUBBLE_QUERY_SINCE, [timeFloor])
  } catch {
    return { calls: results }
  }

  for (const row of rows) {
    try {
      const inputTokens = row.input_tokens ?? 0
      const outputTokens = row.output_tokens ?? 0
      if (inputTokens === 0 && outputTokens === 0) continue

      const createdAt = row.created_at ?? ''
      const conversationId = row.conversation_id ?? 'unknown'
      const dedupKey = `cursor:${conversationId}:${createdAt}:${inputTokens}:${outputTokens}`

      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      const pricingModel = resolveModel(row.model)
      const displayModel = modelForDisplay(row.model)

      const costUSD = calculateCost(pricingModel, inputTokens, outputTokens, 0, 0, 0)

      const timestamp = createdAt || ''
      const convMessages = userMessages.get(conversationId) ?? []
      const userQuestion = convMessages.length > 0 ? convMessages.shift()! : ''
      const assistantText = row.user_text ?? ''
      const userText = (userQuestion + ' ' + assistantText).trim()

      const languages = extractLanguages(row.code_blocks)
      const hasCode = languages.length > 0

      const cursorTools: string[] = hasCode ? ['cursor:edit', ...languages.map(l => `lang:${l}`)] : []

      results.push({
        provider: 'cursor',
        model: displayModel,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD,
        tools: cursorTools,
        bashCommands: [],
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: userText,
        sessionId: conversationId,
      })
    } catch {
      skipped++
    }
  }

  if (skipped > 0) {
    process.stderr.write(`codeburn: skipped ${skipped} unreadable Cursor entries\n`)
  }

  return { calls: results }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const cached = await readCachedResults(source.path)
      if (cached) {
        for (const call of cached) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      let db: SqliteDatabase
      try {
        db = openDatabase(source.path)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open Cursor database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        if (!validateSchema(db)) {
          process.stderr.write('codeburn: Cursor storage format not recognized. You may need to update CodeBurn.\n')
          return
        }

        const { calls } = parseBubbles(db, seenKeys)

        await writeCachedResults(source.path, calls)

        for (const call of calls) {
          yield call
        }
      } finally {
        db.close()
      }
    },
  }
}

export function createCursorProvider(dbPathOverride?: string): Provider {
  return {
    name: 'cursor',
    displayName: 'Cursor',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []

      const dbPath = dbPathOverride ?? getCursorDbPath()
      if (!existsSync(dbPath)) return []

      return [{ path: dbPath, project: 'cursor', provider: 'cursor' }]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const cursor = createCursorProvider()
