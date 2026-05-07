import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { readCachedResults, writeCachedResults } from '../cursor-cache.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const CURSOR_COST_MODEL = 'claude-sonnet-4-5'

const modelDisplayNames: Record<string, string> = {
  'claude-4.5-opus-high-thinking': 'Opus 4.5 (Thinking)',
  'claude-4-opus': 'Opus 4',
  'claude-4-sonnet-thinking': 'Sonnet 4 (Thinking)',
  'claude-4.5-sonnet-thinking': 'Sonnet 4.5 (Thinking)',
  'claude-4.6-sonnet': 'Sonnet 4.6',
  'composer-1': 'Composer 1',
  'grok-code-fast-1': 'Grok Code Fast',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-high': 'GPT-5.1 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4.1': 'GPT-4.1',
  'cursor-auto': 'Cursor (auto)',
}

type BubbleRow = {
  bubble_key: string
  input_tokens: number | null
  output_tokens: number | null
  model: string | null
  created_at: string | null
  conversation_id: string | null
  user_text: string | null
  text_length: number | null
  bubble_type: number | null
  code_blocks: string | null
}

type AgentKvRow = {
  key: string
  role: string | null
  content: string | null
  request_id: string | null
  content_length: number
}

type AgentKvContent = {
  type?: string
  text?: string
  providerOptions?: {
    cursor?: {
      modelName?: string
      requestId?: string
    }
  }
}

const CHARS_PER_TOKEN = 4

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
  if (!raw || raw === 'default') return CURSOR_COST_MODEL
  return raw
}

function modelForDisplay(raw: string | null): string {
  if (!raw || raw === 'default') return 'cursor-auto'
  return raw
}

const BUBBLE_QUERY_BASE = `
  SELECT
    key as bubble_key,
    json_extract(value, '$.tokenCount.inputTokens') as input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') as output_tokens,
    json_extract(value, '$.modelInfo.modelName') as model,
    json_extract(value, '$.createdAt') as created_at,
    json_extract(value, '$.conversationId') as conversation_id,
    substr(json_extract(value, '$.text'), 1, 500) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    json_extract(value, '$.codeBlocks') as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
`

const AGENTKV_QUERY = `
  SELECT
    key,
    json_extract(value, '$.role') as role,
    json_extract(value, '$.content') as content,
    json_extract(value, '$.providerOptions.cursor.requestId') as request_id,
    length(value) as content_length
  FROM cursorDiskKV
  WHERE key LIKE 'agentKv:blob:%'
    AND hex(substr(value, 1, 1)) = '7B'
  ORDER BY ROWID ASC
`

const USER_MESSAGES_QUERY = `
  SELECT
    json_extract(value, '$.conversationId') as conversation_id,
    json_extract(value, '$.createdAt') as created_at,
    substr(json_extract(value, '$.text'), 1, 500) as text
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.type') = 1
    AND (json_extract(value, '$.createdAt') > ? OR json_extract(value, '$.createdAt') IS NULL)
  ORDER BY ROWID ASC
`

const BUBBLE_QUERY_SINCE = BUBBLE_QUERY_BASE + `
    AND (json_extract(value, '$.createdAt') > ? OR json_extract(value, '$.createdAt') IS NULL)
  ORDER BY ROWID ASC
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

  const LOOKBACK_DAYS = 180
  const timeFloor = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const userMessages = buildUserMessageMap(db, timeFloor)

  let rows: BubbleRow[]
  try {
    rows = db.query<BubbleRow>(BUBBLE_QUERY_SINCE, [timeFloor])
  } catch {
    return { calls: results }
  }

  for (const row of rows) {
    try {
      let inputTokens = row.input_tokens ?? 0
      let outputTokens = row.output_tokens ?? 0

      // Cursor v3 stores zero token counts — estimate from text length
      if (inputTokens === 0 && outputTokens === 0) {
        const textLen = row.text_length ?? 0
        if (textLen === 0) continue
        if (row.bubble_type === 1) {
          inputTokens = Math.ceil(textLen / CHARS_PER_TOKEN)
        } else {
          outputTokens = Math.ceil(textLen / CHARS_PER_TOKEN)
        }
      }

      const createdAt = row.created_at ?? ''
      const conversationId = row.conversation_id ?? 'unknown'
      // Use the SQLite row key (bubbleId:<unique>) as the dedup key.
      // Cursor mutates token counts on the row in place when streaming
      // completes — including tokens in the dedup key (the previous
      // implementation) caused the same bubble to be counted twice once
      // its tokens stabilized.
      const dedupKey = `cursor:bubble:${row.bubble_key}`

      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      const pricingModel = resolveModel(row.model)
      const displayModel = modelForDisplay(row.model)

      const costUSD = calculateCost(pricingModel, inputTokens, outputTokens, 0, 0, 0)

      const timestamp = createdAt || new Date().toISOString()
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

function extractModelFromContent(content: AgentKvContent[]): string | null {
  for (const c of content) {
    if (c.providerOptions?.cursor?.modelName) {
      return c.providerOptions.cursor.modelName
    }
  }
  return null
}

function extractTextLength(content: AgentKvContent[]): number {
  let total = 0
  for (const c of content) {
    if (c.text) total += c.text.length
  }
  return total
}

function parseAgentKv(db: SqliteDatabase, seenKeys: Set<string>, dbPath: string): { calls: ParsedProviderCall[] } {
  const results: ParsedProviderCall[] = []

  // Cursor's agentKv schema does not record per-message timestamps. Use the
  // SQLite file's mtime as a bounded "last write" timestamp for all calls;
  // it's at least honest (no future time, no always-now). Users running
  // codeburn against an idle Cursor install will see agentKv calls land at
  // the actual last activity time rather than today's date.
  let agentKvTimestamp: string
  try {
    agentKvTimestamp = new Date(statSync(dbPath).mtimeMs).toISOString()
  } catch {
    agentKvTimestamp = new Date().toISOString()
  }

  let rows: AgentKvRow[]
  try {
    rows = db.query<AgentKvRow>(AGENTKV_QUERY)
  } catch {
    return { calls: results }
  }

  const sessions: Map<string, { inputChars: number; outputChars: number; model: string | null; userText: string }> = new Map()
  let currentRequestId = 'unknown'
  let turnIndex = 0

  for (const row of rows) {
    if (!row.role || !row.content) continue

    let content: AgentKvContent[]
    let plainTextLength = 0
    try {
      const parsed = JSON.parse(row.content)
      if (Array.isArray(parsed)) {
        content = parsed
      } else {
        content = []
        plainTextLength = row.content.length
      }
    } catch {
      content = []
      plainTextLength = row.content.length
    }

    const requestId = row.request_id ?? currentRequestId
    if (requestId !== currentRequestId) {
      currentRequestId = requestId
      turnIndex = 0
    }

    const textLength = plainTextLength || extractTextLength(content)
    const model = extractModelFromContent(content)

    if (row.role === 'user') {
      const existing = sessions.get(requestId) ?? { inputChars: 0, outputChars: 0, model: null, userText: '' }
      existing.inputChars += textLength
      if (!existing.userText) {
        const text = content[0]?.text ?? row.content
        const queryMatch = text.match(/<user_query>([\s\S]*?)<\/user_query>/)
        existing.userText = queryMatch ? queryMatch[1].trim().slice(0, 500) : text.slice(0, 500)
      }
      sessions.set(requestId, existing)
    } else if (row.role === 'assistant') {
      const existing = sessions.get(requestId) ?? { inputChars: 0, outputChars: 0, model: null, userText: '' }
      existing.outputChars += textLength
      if (model) existing.model = model
      sessions.set(requestId, existing)
    } else if (row.role === 'tool' || row.role === 'system') {
      const existing = sessions.get(requestId) ?? { inputChars: 0, outputChars: 0, model: null, userText: '' }
      existing.inputChars += textLength
      sessions.set(requestId, existing)
    }
  }

  for (const [requestId, session] of sessions) {
    if (session.inputChars === 0 && session.outputChars === 0) continue

    const inputTokens = Math.ceil(session.inputChars / CHARS_PER_TOKEN)
    const outputTokens = Math.ceil(session.outputChars / CHARS_PER_TOKEN)
    const dedupKey = `cursor:agentKv:${requestId}`

    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    const pricingModel = resolveModel(session.model)
    const displayModel = modelForDisplay(session.model)
    const costUSD = calculateCost(pricingModel, inputTokens, outputTokens, 0, 0, 0)

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
      bashCommands: [],
      timestamp: agentKvTimestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: session.userText,
      sessionId: requestId,
    })
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

        const { calls: bubbleCalls } = parseBubbles(db, seenKeys)
        const { calls: agentKvCalls } = parseAgentKv(db, seenKeys, source.path)
        const calls = [...bubbleCalls, ...agentKvCalls]

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
