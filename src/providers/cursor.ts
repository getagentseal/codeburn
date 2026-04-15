import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { readCursorCache, writeCursorCache } from '../cursor-cache.js'
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
  created_at: number | null
  conversation_id: string | null
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
    json_extract(value, '$.conversationId') as conversation_id
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.tokenCount.inputTokens') > 0
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

function parseBubbles(db: SqliteDatabase, seenKeys: Set<string>, afterTimestamp?: number): { calls: ParsedProviderCall[]; maxCreatedAt: number } {
  const results: ParsedProviderCall[] = []
  let skipped = 0
  let maxCreatedAt = afterTimestamp ?? 0

  const DEFAULT_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000
  const timeFloor = afterTimestamp ?? (Date.now() - DEFAULT_LOOKBACK_MS)

  let rows: BubbleRow[]
  try {
    rows = db.query<BubbleRow>(BUBBLE_QUERY_SINCE, [timeFloor])
  } catch {
    return { calls: results, maxCreatedAt }
  }

  for (const row of rows) {
    try {
      const inputTokens = row.input_tokens ?? 0
      const outputTokens = row.output_tokens ?? 0
      if (inputTokens === 0 && outputTokens === 0) continue

      const createdAt = row.created_at ?? 0
      if (createdAt > maxCreatedAt) maxCreatedAt = createdAt
      const conversationId = row.conversation_id ?? 'unknown'
      const dedupKey = `cursor:${conversationId}:${createdAt}:${inputTokens}:${outputTokens}`

      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      const pricingModel = resolveModel(row.model)
      const displayModel = modelForDisplay(row.model)

      const costUSD = calculateCost(pricingModel, inputTokens, outputTokens, 0, 0, 0)

      const timestamp = createdAt > 0
        ? new Date(createdAt).toISOString()
        : ''

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
        tools: [],
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: '',
        sessionId: conversationId,
      })
    } catch {
      skipped++
    }
  }

  if (skipped > 0) {
    process.stderr.write(`codeburn: skipped ${skipped} unreadable Cursor entries\n`)
  }

  return { calls: results, maxCreatedAt }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
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

        const cache = await readCursorCache()
        let dbSize = 0
        try { dbSize = statSync(source.path).size } catch {}
        const cacheValid = cache
          && cache.lastCreatedAt > 0
          && cache.dbSizeBytes > 0
          && dbSize >= cache.dbSizeBytes
        const afterTimestamp = cacheValid ? cache.lastCreatedAt : undefined

        const { calls, maxCreatedAt } = parseBubbles(db, seenKeys, afterTimestamp)

        if (maxCreatedAt > 0) {
          await writeCursorCache(maxCreatedAt, dbSize).catch(() => {})
        }

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
