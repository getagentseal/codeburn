import { createHash } from 'crypto'
import { existsSync, statSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'

import { calculateCost, getShortModelName } from '../models.js'
import {
  openDatabase,
  blobToText,
  isSqliteAvailable,
  isSqliteBusyError,
  type SqliteDatabase,
} from '../sqlite.js'
import { normalizeContentBlocks } from '../content-utils.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import type {
  Provider,
  SessionSource,
  SessionParser,
  ParsedProviderCall,
  ProbeRoot,
} from './types.js'

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const CURSOR_AGENT_COST_MODEL = 'claude-sonnet-4-5'
const MAX_USER_TEXT_LENGTH = 500
const DIGITS_ONLY = /^\d+$/
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX64 = /^[0-9a-f]{64}$/i
const USER_MARKER = /^\s*user:\s*/i
const ASSISTANT_MARKER = /^\s*A:\s*/
const THINKING_MARKER = /^\s*\[Thinking\]\s*/
const TOOL_CALL_MARKER = /^\s*\[Tool call\]\s*(.+?)\s*$/i
const TOOL_RESULT_MARKER = /^\s*\[Tool result\]\b/i
const USER_QUERY_OPEN = '<user_query>'
const USER_QUERY_CLOSE = '</user_query>'

// Marker on SessionSource.path so the parser knows this is a store.db source
// rather than a transcript. The marker is a private implementation detail;
// it never appears in output.
const STORE_SOURCE_PREFIX = 'cursor-agent-store:'

// Sentinel written into seenKeys to record that a store.db was decoded
// successfully for a given session UUID. Transcript parsers check for this
// and skip themselves to prevent double-counting.
const STORE_DECODED_KEY_PREFIX = 'cursor-agent-store-decoded:'

const warnedUnrecognizedTranscripts = new Set<string>()

const CONVERSATION_SUMMARY_QUERY = `
  SELECT conversationId, model, title, updatedAt
  FROM conversation_summaries
  WHERE conversationId = ?
`

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
  default: 'Auto (Sonnet est.)',
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getCursorAgentBaseDir(baseDirOverride?: string): string {
  if (baseDirOverride) return baseDirOverride
  // Windows paths unverified; tracked as Open Question 3 in issue #55.
  return join(homedir(), '.cursor')
}

function getProjectsDir(baseDir: string): string {
  return join(baseDir, 'projects')
}

function getChatsDir(baseDir: string): string {
  return join(baseDir, 'chats')
}

function getAttributionDbPath(baseDir: string): string {
  return join(baseDir, 'ai-tracking', 'ai-code-tracking.db')
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

type ConversationSummary = {
  conversationId: string
  model: string | null
  title: string | null
  updatedAt: string | null
}

type AssistantTurn = {
  body: string
  reasoning: string
  tools: string[]
}

type ParsedTurn = {
  userMessage: string
  assistant: AssistantTurn
}

/** Decoded root metadata from meta table key '0'. */
type StoreRootMeta = {
  agentId: string
  latestRootBlobId: string
  name: string | null
  mode: string | null
  createdAt: number | null
  lastUsedModel: string | null
  // blobEncryptionKey is intentionally excluded — it must never be stored,
  // logged, cached, exported, or appear in any emitted value.
}

/** Provenance tag for token counts. */
type TokenProvenance = 'exact' | 'estimated'

/** One reconstructed request/turn from the blob graph. */
type BlobTurn = {
  userMessage: string
  outputText: string
  reasoningText: string
  tools: string[]
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  inputProvenance: TokenProvenance
  outputProvenance: TokenProvenance
  timestamp: string | null
  requestId: string | null
  model: string | null
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function estimateTokens(charCount: number): number {
  if (charCount <= 0) return 0
  return estimateTokensFromChars(charCount)
}

function parseToolName(raw: string): string {
  const clean = raw.trim()
  if (clean.length === 0) return 'unknown'
  return clean.toLowerCase().replace(/\s+/g, '-')
}

/**
 * Normalizes a raw timestamp value to ISO string.
 * Accepts: ISO strings, numeric epoch-ms, numeric epoch-s (< 1e12).
 * Returns null for missing or invalid inputs.
 */
function normalizeTimestamp(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    if (DIGITS_ONLY.test(trimmed)) {
      const num = Number(trimmed)
      if (!Number.isNaN(num)) {
        const ms = num < 1e12 ? num * 1000 : num
        return new Date(ms).toISOString()
      }
    }
    const parsed = new Date(trimmed)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
    return null
  }

  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function prettifyProjectId(raw: string): string {
  if (!raw) return raw

  if (DIGITS_ONLY.test(raw)) {
    const num = Number(raw)
    if (!Number.isNaN(num) && raw.length >= 13) {
      const iso = new Date(num).toISOString()
      return `cursor-agent:${iso}`
    }
  }

  const withoutPrefix = raw.replace(/^-Users-/, '')
  const parts = withoutPrefix.split('-').filter(Boolean)
  if (parts.length > 0) return parts[parts.length - 1]!

  return raw
}

function resolveModel(raw: string | null | undefined): string {
  if (!raw || raw === 'default') return 'cursor-agent-auto'
  return raw
}

function costModel(model: string): string {
  return model === 'cursor-agent-auto' ? CURSOR_AGENT_COST_MODEL : model
}

function transcriptStem(transcriptPath: string): string {
  const name = basename(transcriptPath)
  if (name.endsWith('.jsonl')) return name.slice(0, -'.jsonl'.length)
  if (name.endsWith('.txt')) return name.slice(0, -'.txt'.length)
  return name
}

function toConversationId(transcriptPath: string): string {
  const filename = transcriptStem(transcriptPath)
  if (filename.length === 36 && UUID_LIKE.test(filename)) return filename
  return createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// store.db: schema validation
// ---------------------------------------------------------------------------

/**
 * Validates that the given database has the expected meta and blobs tables.
 * Throws SQLITE_BUSY errors so they propagate to the busy-handling path upstream.
 */
function validateStoreSchema(db: SqliteDatabase): boolean {
  for (const table of ['meta', 'blobs']) {
    try {
      db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table} LIMIT 1`)
    } catch (err) {
      if (isSqliteBusyError(err)) throw err
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// store.db: root metadata decoding
// ---------------------------------------------------------------------------

/**
 * Reads meta['0'] from the store and decodes it from hex-encoded UTF-8 JSON.
 * blobEncryptionKey is explicitly stripped from the result before returning.
 * Returns null when the row is absent, the hex decode fails, or required
 * fields are missing/invalid.
 */
function decodeStoreMeta(db: SqliteDatabase): StoreRootMeta | null {
  let rows: Array<{ value: Uint8Array | string | null }>
  try {
    rows = db.query<{ value: Uint8Array | string | null }>(
      "SELECT CAST(value AS BLOB) AS value FROM meta WHERE key = '0' LIMIT 1",
    )
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return null
  }
  if (rows.length === 0) return null

  const raw = blobToText(rows[0]!.value)
  if (!raw) return null

  // The value is hex-encoded UTF-8 JSON. Each pair of hex digits is one byte.
  let jsonStr: string
  try {
    if (!/^[0-9a-f]+$/i.test(raw.trim())) {
      // Not hex — try treating as plain JSON (defensive for format variations)
      jsonStr = raw
    } else {
      const hex = raw.trim()
      if (hex.length % 2 !== 0) return null
      const bytes = new Uint8Array(hex.length / 2)
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
      }
      jsonStr = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    }
  } catch {
    return null
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  } catch {
    return null
  }

  const agentId = typeof parsed['agentId'] === 'string' ? parsed['agentId'] : null
  const latestRootBlobId = typeof parsed['latestRootBlobId'] === 'string' ? parsed['latestRootBlobId'] : null

  // Both are required for graph reconstruction.
  if (!agentId || !latestRootBlobId) return null
  if (!HEX64.test(latestRootBlobId)) return null

  const name = typeof parsed['name'] === 'string' ? parsed['name'] : null
  const mode = typeof parsed['mode'] === 'string' ? parsed['mode'] : null
  const lastUsedModel = typeof parsed['lastUsedModel'] === 'string' ? parsed['lastUsedModel'] : null
  const createdAt =
    typeof parsed['createdAt'] === 'number'
      ? parsed['createdAt']
      : typeof parsed['createdAt'] === 'string'
        ? Number(parsed['createdAt']) || null
        : null

  // Explicitly do NOT include blobEncryptionKey in the returned object.
  // It must never appear in any log, cache, export, or emitted value.
  return { agentId, latestRootBlobId, name, mode, createdAt, lastUsedModel }
}

// ---------------------------------------------------------------------------
// store.db: blob graph reconstruction
// ---------------------------------------------------------------------------

/**
 * Fetches a blob's raw data by ID. Returns null when the blob is absent or
 * its data cannot be parsed as JSON. Unknown fields are silently ignored.
 */
function fetchBlob(db: SqliteDatabase, blobId: string): Record<string, unknown> | null {
  let rows: Array<{ data: Uint8Array | string | null }>
  try {
    rows = db.query<{ data: Uint8Array | string | null }>(
      'SELECT CAST(data AS BLOB) AS data FROM blobs WHERE id = ? LIMIT 1',
      [blobId],
    )
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return null
  }
  if (rows.length === 0) return null
  const text = blobToText(rows[0]!.data)
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Safely reads a string field from a parsed blob object. */
function blobStr(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Safely reads a number field. */
function blobNum(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Extracts text content from a blob's 'content' or 'text' field.
 * Handles both plain strings and arrays of content blocks
 * (e.g. [{type:'text', text:'...'}, ...]).
 * Unknown block types are silently skipped (forward-compatible).
 */
function extractBlobText(obj: Record<string, unknown>): string {
  const direct = obj['text'] ?? obj['content']
  if (typeof direct === 'string') return direct

  if (Array.isArray(direct)) {
    return direct
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null && !Array.isArray(b))
      .filter(b => b['type'] === 'text' || b['type'] === undefined)
      .map(b => (typeof b['text'] === 'string' ? b['text'] : ''))
      .join('')
  }

  return ''
}

/**
 * Extracts tool calls from a blob. Returns an array of tool name strings.
 * Handles both a direct 'toolCalls' array and 'content' blocks with
 * type 'tool_use'. Unknown formats are silently ignored.
 */
function extractBlobTools(obj: Record<string, unknown>): string[] {
  const tools: string[] = []

  // Format A: toolCalls: [{name: string}]
  const toolCalls = obj['toolCalls']
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (typeof tc === 'object' && tc !== null && !Array.isArray(tc)) {
        const name = (tc as Record<string, unknown>)['name']
        if (typeof name === 'string' && name.length > 0) {
          tools.push(`cursor:${parseToolName(name)}`)
        }
      }
    }
  }

  // Format B: content blocks with type 'tool_use'
  const content = obj['content']
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
        const b = block as Record<string, unknown>
        if (b['type'] === 'tool_use') {
          const name = b['name']
          if (typeof name === 'string' && name.length > 0) {
            tools.push(`cursor:${parseToolName(name)}`)
          }
        }
      }
    }
  }

  return tools
}

/**
 * Determines whether a numeric token count is a plausible exact billed
 * count vs. a running context-window gauge.
 *
 * A gauge is a monotonically increasing context-window snapshot that is NOT
 * a per-request delta. We reject values that are impossibly large for a
 * single request (> 2_000_000 tokens) as gauges. Values ≤ 0 are also
 * rejected. This is a heuristic; the issue spec calls for trusting
 * explicitly labelled fields over this.
 */
function isPlausibleExactCount(n: number | null): boolean {
  if (n === null || !Number.isFinite(n) || n < 0) return false
  // 0 is valid (e.g. a turn with no output). Counts above 2M are extremely
  // unlikely to be per-request deltas and more likely context-window gauges.
  return n <= 2_000_000
}

/**
 * Walks the blob graph starting at rootBlobId, reconstructing a sequence of
 * conversation turns. Returns an ordered array of BlobTurn objects.
 *
 * The graph is a linked-list-like structure: each blob may carry a
 * 'nextBlobId' / 'parentBlobId' / 'childBlobIds' reference. We follow
 * 'nextBlobId' linearly and fall back to children arrays.
 *
 * Unknown protobuf-style fields in blobs are silently ignored for forward
 * compatibility (issue requirement 5).
 */
function reconstructBlobGraph(
  db: SqliteDatabase,
  rootBlobId: string,
  sessionTimestampFallback: string | null,
): BlobTurn[] {
  const turns: BlobTurn[] = []
  const visited = new Set<string>()

  // Collect blobs in traversal order. We walk 'nextBlobId' chains from root.
  // Each blob can be: a message blob (role='user'|'assistant'), a request
  // wrapper blob, or a container blob with childBlobIds. We do a BFS and
  // classify each blob by its fields.
  const queue: string[] = [rootBlobId]
  const orderedBlobs: Array<Record<string, unknown>> = []

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)

    const blob = fetchBlob(db, id)
    if (!blob) continue
    orderedBlobs.push(blob)

    // Follow the linear chain first (most common layout)
    const next = blobStr(blob, 'nextBlobId')
    if (next && HEX64.test(next) && !visited.has(next)) {
      queue.unshift(next) // maintain ordering: next before children
    }

    // Follow child blobs (branching structure)
    const children = blob['childBlobIds']
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === 'string' && HEX64.test(child) && !visited.has(child)) {
          queue.push(child)
        }
      }
    }
  }

  // Now group into user/assistant pairs. We scan for 'role' fields.
  // A request blob typically has: role='user' for the prompt, and
  // role='assistant' (or role='model') for the response, plus token fields.
  let pendingUser = ''
  let pendingUserTs: string | null = null

  for (const blob of orderedBlobs) {
    const role = blobStr(blob, 'role')

    if (role === 'user') {
      const text = extractBlobText(blob).slice(0, MAX_USER_TEXT_LENGTH)
      if (text) {
        pendingUser = text
        pendingUserTs = normalizeTimestamp(blobNum(blob, 'timestamp') ?? blobNum(blob, 'createdAt') ?? blobStr(blob, 'timestamp'))
      }
      continue
    }

    if (role === 'assistant' || role === 'model' || role === 'request') {
      const outputText = role === 'request' ? '' : extractBlobText(blob)

      // --- Reasoning text ---
      const reasoningText = (() => {
        const r = blob['reasoning'] ?? blob['thinkingContent']
        if (typeof r === 'string') return r
        if (Array.isArray(r)) {
          return r
            .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
            .map(b => (typeof b['text'] === 'string' ? b['text'] : ''))
            .join('')
        }
        return ''
      })()

      // --- Tools ---
      const tools = extractBlobTools(blob)

      // --- Timestamp: prefer request-level; fall back to session-level ---
      const ts = normalizeTimestamp(
        blobNum(blob, 'timestamp') ??
        blobNum(blob, 'createdAt') ??
        blobStr(blob, 'timestamp') ??
        blobStr(blob, 'createdAt') ??
        pendingUserTs ??
        blobNum(blob, 'requestTimestamp'),
      ) ?? sessionTimestampFallback

      // --- Token counts with provenance ---
      // Prefer per-request input/output fields. Reject implausibly large
      // context-window gauges (issue requirement 8-9).
      const rawInput =
        blobNum(blob, 'inputTokenCount') ??
        blobNum(blob, 'inputTokens') ??
        blobNum(blob, 'promptTokens') ??
        blobNum(blob, 'tokensInput')

      const rawOutput =
        blobNum(blob, 'outputTokenCount') ??
        blobNum(blob, 'outputTokens') ??
        blobNum(blob, 'completionTokens') ??
        blobNum(blob, 'tokensOutput')

      const rawCacheCreate =
        blobNum(blob, 'cacheCreationInputTokens') ??
        blobNum(blob, 'cacheWriteTokens') ?? 0

      const rawCacheRead =
        blobNum(blob, 'cacheReadInputTokens') ??
        blobNum(blob, 'cacheReadTokens') ?? 0

      const hasExactInput = isPlausibleExactCount(rawInput)
      const hasExactOutput = isPlausibleExactCount(rawOutput)

      const inputTokens = hasExactInput
        ? rawInput!
        : estimateTokens(pendingUser.length)
      const outputTokens = hasExactOutput
        ? rawOutput!
        : estimateTokens(outputText.length)
      const reasoningTokens = estimateTokens(reasoningText.length)

      const cacheCreationTokens = isPlausibleExactCount(rawCacheCreate ?? null) ? (rawCacheCreate ?? 0) : 0
      const cacheReadTokens = isPlausibleExactCount(rawCacheRead ?? null) ? (rawCacheRead ?? 0) : 0

      // --- Request ID ---
      const requestId = blobStr(blob, 'requestId') ?? blobStr(blob, 'id')

      // --- Model ---
      const model = blobStr(blob, 'model') ?? blobStr(blob, 'modelId')

      if (outputText || inputTokens > 0 || outputTokens > 0) {
        turns.push({
          userMessage: pendingUser,
          outputText,
          reasoningText,
          tools,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheCreationTokens,
          cacheReadTokens,
          inputProvenance: hasExactInput ? 'exact' : 'estimated',
          outputProvenance: hasExactOutput ? 'exact' : 'estimated',
          timestamp: ts,
          requestId,
          model,
        })
        pendingUser = ''
        pendingUserTs = null
      }
      continue
    }

    // Container blobs with no role (purely structural). Their children
    // are already queued above; nothing to emit here.
  }

  return turns
}

// ---------------------------------------------------------------------------
// store.db: WAL-aware fingerprinting for cache invalidation
// ---------------------------------------------------------------------------

type StoreFingerprint = {
  mtimeMs: number
  sizeBytes: number
}

/**
 * Returns the combined fingerprint of the store.db and its WAL sidecar.
 * Cursor writes via WAL, so the main file's mtime does not change on writes;
 * we must include the WAL in the fingerprint to detect active sessions.
 */
function fingerprintStore(storePath: string): StoreFingerprint | null {
  try {
    const main = statSync(storePath)
    let walMtime = main.mtimeMs
    let walSize = 0
    try {
      const wal = statSync(storePath + '-wal')
      walMtime = Math.max(walMtime, wal.mtimeMs)
      walSize = wal.size
    } catch {
      // No WAL — quiescent database, fine.
    }
    return {
      mtimeMs: walMtime,
      sizeBytes: main.size + walSize,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// store.db: session-level result cache
// ---------------------------------------------------------------------------

// Keyed by session UUID. Entries are invalidated when the store.db fingerprint
// changes (WAL-aware, so active sessions always refresh).
type StoreCacheEntry = {
  fp: StoreFingerprint
  turns: BlobTurn[]
}

// ---------------------------------------------------------------------------
// store.db: parser creation
// ---------------------------------------------------------------------------

/**
 * Creates a SessionParser for a single store.db source.
 *
 * Source path format: "cursor-agent-store:<dbPath>:<sessionUUID>"
 *
 * Precedence (issue requirement 11):
 *   store.db (this parser) > JSONL transcript > TXT transcript
 *
 * If the store decodes successfully, we record a sentinel in seenKeys so the
 * transcript parsers for the same session UUID skip themselves.
 */
function createStoreParser(
  source: SessionSource,
  seenKeys: Set<string>,
  storeCache: Map<string, StoreCacheEntry>,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) return

      // Decode the source path
      const rest = source.path.slice(STORE_SOURCE_PREFIX.length)
      const lastColon = rest.lastIndexOf(':')
      if (lastColon < 0) return
      const dbPath = rest.slice(0, lastColon)
      const sessionUUID = rest.slice(lastColon + 1)
      if (!sessionUUID || !dbPath) return

      const fp = fingerprintStore(dbPath)
      if (!fp) return

      // Check cache: hit when fingerprint matches
      const cached = storeCache.get(sessionUUID)
      let turns: BlobTurn[]
      let storeDecodedOk = false

      if (cached && cached.fp.mtimeMs === fp.mtimeMs && cached.fp.sizeBytes === fp.sizeBytes) {
        turns = cached.turns
        storeDecodedOk = true
      } else {
        // Parse the store
        let db: SqliteDatabase
        try {
          db = openDatabase(dbPath)
        } catch (err) {
          if (isSqliteBusyError(err)) throw err
          process.stderr.write(
            `codeburn: cannot open Cursor store database ${dbPath}: ${err instanceof Error ? err.message : err}\n`,
          )
          return
        }

        try {
          if (!validateStoreSchema(db)) {
            process.stderr.write(
              `codeburn: Cursor store.db ${dbPath} is missing expected tables (meta, blobs). Skipping.\n`,
            )
            return
          }

          const meta = decodeStoreMeta(db)
          if (!meta) {
            process.stderr.write(
              `codeburn: Cursor store.db ${dbPath}: could not decode root metadata. Skipping.\n`,
            )
            return
          }

          // Verify agentId matches the session UUID from the directory path.
          // A mismatch indicates a copy or corrupt layout; skip to avoid
          // misattributed sessions.
          if (meta.agentId.toLowerCase() !== sessionUUID.toLowerCase()) {
            process.stderr.write(
              `codeburn: Cursor store.db agentId mismatch (${meta.agentId} vs ${sessionUUID}). Skipping.\n`,
            )
            return
          }

          const sessionTs = meta.createdAt ? normalizeTimestamp(meta.createdAt) : null

          turns = reconstructBlobGraph(db, meta.latestRootBlobId, sessionTs)
          storeDecodedOk = true

          // Populate cache
          storeCache.set(sessionUUID, { fp, turns })
        } finally {
          db.close()
        }
      }

      if (!storeDecodedOk || turns.length === 0) return

      // Mark the store as decoded for this session. Transcript parsers for the
      // same session UUID will check this and skip themselves.
      const storeDecodedSentinel = `${STORE_DECODED_KEY_PREFIX}${sessionUUID.toLowerCase()}`
      seenKeys.add(storeDecodedSentinel)

      const sessionModel = resolveModel(
        turns.find(t => t.model)?.model ?? source.project ?? null,
      )

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]!
        // Stable dedup key: store-path hash + turn index
        const dbHash = createHash('sha1').update(dbPath).digest('hex').slice(0, 12)
        const dedupKey = `cursor-agent-store:${sessionUUID}:${dbHash}:${i}`
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const model = resolveModel(turn.model ?? sessionModel)
        const costIsEstimated = turn.inputProvenance === 'estimated' || turn.outputProvenance === 'estimated'

        const costUSD = calculateCost(
          costModel(model),
          turn.inputTokens,
          turn.outputTokens + turn.reasoningTokens,
          turn.cacheCreationTokens,
          turn.cacheReadTokens,
          0,
        )

        // Timestamp: prefer turn-level; fall back to session createdAt.
        // Never use file mtime as an exact request timestamp (issue req 7).
        const timestamp = turn.timestamp ?? normalizeTimestamp(source.project) ?? new Date().toISOString()

        yield {
          provider: 'cursor-agent',
          model,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheCreationInputTokens: turn.cacheCreationTokens,
          cacheReadInputTokens: turn.cacheReadTokens,
          cachedInputTokens: turn.cacheReadTokens,
          reasoningTokens: turn.reasoningTokens,
          webSearchRequests: 0,
          costUSD,
          costIsEstimated: costIsEstimated ? true : undefined,
          tools: turn.tools,
          bashCommands: [],
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: turn.userMessage,
          sessionId: sessionUUID,
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// store.db: discovery helper
// ---------------------------------------------------------------------------

/**
 * Scans ~/.cursor/chats/<hash>/<session-id>/store.db for each session.
 * Does not follow symlinks beyond the first two directory levels.
 * Returns SessionSource entries with path = "cursor-agent-store:<dbPath>:<sessionUUID>".
 */
async function appendStoreSources(
  chatsDir: string,
  sources: SessionSource[],
): Promise<void> {
  let hashDirs: Awaited<ReturnType<typeof readdir>>
  try {
    hashDirs = await readdir(chatsDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const hashEntry of hashDirs) {
    // Only process real directories at this level; skip symlinks.
    if (!hashEntry.isDirectory()) continue

    const hashDir = join(chatsDir, hashEntry.name)
    let sessionDirs: Awaited<ReturnType<typeof readdir>>
    try {
      sessionDirs = await readdir(hashDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const sessionEntry of sessionDirs) {
      // Session directories are named by UUID.
      if (!sessionEntry.isDirectory()) continue
      if (!UUID_LIKE.test(sessionEntry.name)) continue

      const sessionUUID = sessionEntry.name
      const storePath = join(hashDir, sessionEntry.name, 'store.db')
      if (!existsSync(storePath)) continue

      sources.push({
        path: `${STORE_SOURCE_PREFIX}${storePath}:${sessionUUID}`,
        project: sessionUUID, // refined by metadata at parse time
        provider: 'cursor-agent',
        sourceKind: undefined, // no special sourceKind needed
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Transcript: discovery helper
// ---------------------------------------------------------------------------

async function appendTranscriptSources(
  scanDir: string,
  projectId: string,
  sources: SessionSource[],
): Promise<void> {
  const transcriptEntries = await readdir(scanDir, { withFileTypes: true })
  for (const transcript of transcriptEntries) {
    // Legacy format: .txt files directly in the scan dir
    if (transcript.isFile() && transcript.name.endsWith('.txt')) {
      sources.push({
        path: join(scanDir, transcript.name),
        project: projectId,
        provider: 'cursor-agent',
      })
      continue
    }

    // Composer 2 format: UUID subdirectories with .jsonl files
    if (transcript.isDirectory() && UUID_LIKE.test(transcript.name)) {
      const subdir = join(scanDir, transcript.name)
      const subEntries = await readdir(subdir, { withFileTypes: true }).catch(() => [])
      const transcriptFilesByStem = new Map<string, { jsonl?: string; txt?: string }>()

      for (const sub of subEntries) {
        if (sub.isFile() && (sub.name.endsWith('.jsonl') || sub.name.endsWith('.txt'))) {
          const stem = transcriptStem(sub.name)
          const existing = transcriptFilesByStem.get(stem) ?? {}
          if (sub.name.endsWith('.jsonl')) {
            transcriptFilesByStem.set(stem, { ...existing, jsonl: sub.name })
          } else {
            transcriptFilesByStem.set(stem, { ...existing, txt: sub.name })
          }
          continue
        }

        // Subagent transcripts inside a subagents/ directory
        if (sub.isDirectory() && sub.name === 'subagents') {
          const subagentEntries = await readdir(join(subdir, sub.name), { withFileTypes: true }).catch(() => [])
          for (const sa of subagentEntries) {
            if (!sa.isFile()) continue
            if (!sa.name.endsWith('.jsonl') && !sa.name.endsWith('.txt')) continue
            sources.push({
              path: join(subdir, sub.name, sa.name),
              project: projectId,
              provider: 'cursor-agent',
            })
          }
        }
      }

      for (const files of transcriptFilesByStem.values()) {
        const selectedName = files.jsonl ?? files.txt
        if (selectedName) {
          sources.push({
            path: join(subdir, selectedName),
            project: projectId,
            provider: 'cursor-agent',
          })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Transcript text extraction helpers
// ---------------------------------------------------------------------------

function extractUserQuery(userBlock: string): string {
  const chunks: string[] = []
  let cursor = 0

  while (cursor < userBlock.length) {
    const openIndex = userBlock.indexOf(USER_QUERY_OPEN, cursor)
    if (openIndex === -1) break
    const start = openIndex + USER_QUERY_OPEN.length
    const closeIndex = userBlock.indexOf(USER_QUERY_CLOSE, start)
    if (closeIndex === -1) {
      chunks.push(userBlock.slice(start).trim())
      break
    }
    chunks.push(userBlock.slice(start, closeIndex).trim())
    cursor = closeIndex + USER_QUERY_CLOSE.length
  }

  const combined = chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return combined.slice(0, MAX_USER_TEXT_LENGTH)
}

function parseJsonlTranscript(raw: string): { turns: ParsedTurn[]; recognized: boolean } {
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  if (lines.length === 0) return { turns: [], recognized: false }

  const turns: ParsedTurn[] = []
  let currentUserMessage = ''

  for (const line of lines) {
    let entry: { role?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string }> } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry.role === 'user') {
      const texts = normalizeContentBlocks(entry.message?.content)
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
      const combined = texts.join(' ')
      currentUserMessage = extractUserQuery(combined) || combined.slice(0, MAX_USER_TEXT_LENGTH)
      continue
    }

    if (entry.role === 'assistant' && currentUserMessage) {
      const content = normalizeContentBlocks(entry.message?.content)
      const bodyParts: string[] = []
      const tools: string[] = []

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          bodyParts.push(block.text)
        } else if (block.type === 'tool_use' && block.name) {
          tools.push(`cursor:${block.name.toLowerCase()}`)
        }
      }

      turns.push({
        userMessage: currentUserMessage,
        assistant: {
          body: bodyParts.join('\n').trim(),
          reasoning: '',
          tools,
        },
      })
      currentUserMessage = ''
    }
  }

  return { turns, recognized: turns.length > 0 }
}

function parseTranscript(raw: string): { turns: ParsedTurn[]; recognized: boolean } {
  const lines = raw.split(/\r?\n/)
  let recognized = false

  const pendingUsers: string[] = []
  const turns: ParsedTurn[] = []

  let active: 'none' | 'user' | 'assistant' = 'none'
  let userLines: string[] = []
  let assistantLines: string[] = []

  const flushUser = () => {
    if (userLines.length === 0) return
    const userQuery = extractUserQuery(userLines.join('\n'))
    if (userQuery.length > 0) pendingUsers.push(userQuery)
    userLines = []
  }

  const flushAssistant = () => {
    if (assistantLines.length === 0) return

    let output = ''
    let reasoning = ''
    const toolsByTurn = new Map<string, true>()

    for (const line of assistantLines) {
      if (TOOL_RESULT_MARKER.test(line)) continue

      const thinkingMatch = line.match(THINKING_MARKER)
      if (thinkingMatch) {
        const body = line.replace(THINKING_MARKER, '').trim()
        if (body.length > 0) reasoning += `${body}\n`
        continue
      }

      const toolMatch = line.match(TOOL_CALL_MARKER)
      if (toolMatch) {
        const parsedTool = parseToolName(toolMatch[1] ?? '')
        const toolKey = `cursor:${parsedTool}`
        toolsByTurn.set(toolKey, true)
        continue
      }

      output += `${line}\n`
    }

    if (pendingUsers.length > 0) {
      const userMessage = pendingUsers.shift()!
      const tools = Array.from(toolsByTurn.keys())
      turns.push({
        userMessage,
        assistant: {
          body: output.trim(),
          reasoning: reasoning.trim(),
          tools,
        },
      })
    }

    assistantLines = []
  }

  for (const line of lines) {
    if (USER_MARKER.test(line)) {
      recognized = true
      if (active === 'user') flushUser()
      if (active === 'assistant') flushAssistant()
      active = 'user'
      userLines = [line.replace(USER_MARKER, '')]
      continue
    }

    if (ASSISTANT_MARKER.test(line)) {
      recognized = true
      if (active === 'user') flushUser()
      if (active === 'assistant') flushAssistant()
      active = 'assistant'
      assistantLines = [line.replace(ASSISTANT_MARKER, '')]
      continue
    }

    if (active === 'user') {
      userLines.push(line)
      continue
    }

    if (active === 'assistant') {
      assistantLines.push(line)
    }
  }

  if (active === 'user') flushUser()
  if (active === 'assistant') flushAssistant()

  return { turns, recognized }
}

// ---------------------------------------------------------------------------
// Transcript: parser creation
// ---------------------------------------------------------------------------

function createTranscriptParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dbPath: string,
  summariesByConversationId: Map<string, ConversationSummary>,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const conversationId = toConversationId(source.path)

      // Precedence: if a store.db for this session UUID was decoded
      // successfully, skip the transcript entirely to avoid double-counting.
      const storeDecodedSentinel = `${STORE_DECODED_KEY_PREFIX}${conversationId.toLowerCase()}`
      if (seenKeys.has(storeDecodedSentinel)) return

      let summary = summariesByConversationId.get(conversationId)
      let db: SqliteDatabase | null = null

      try {
        if (!summary) {
          if (existsSync(dbPath)) {
            try {
              db = openDatabase(dbPath)
              const rows = db.query<{
                conversationId: string
                model: string | null
                title: string | null
                updatedAt: string | number | null
              }>(CONVERSATION_SUMMARY_QUERY, [conversationId])

              if (rows.length > 0) {
                const row = rows[0]!
                summary = {
                  conversationId: row.conversationId,
                  model: row.model,
                  title: row.title,
                  updatedAt: normalizeTimestamp(row.updatedAt),
                }
                summariesByConversationId.set(conversationId, summary)
              }
            } catch {
              summary = undefined
            }
          }
        }

        const transcript = await readFile(source.path, 'utf-8')
        const isJsonl = source.path.endsWith('.jsonl')
        const parsed = isJsonl ? parseJsonlTranscript(transcript) : parseTranscript(transcript)

        if (!parsed.recognized) {
          if (!warnedUnrecognizedTranscripts.has(source.path)) {
            warnedUnrecognizedTranscripts.add(source.path)
            process.stderr.write(`codeburn: skipped ${basename(source.path)}: unrecognized cursor-agent transcript format\n`)
          }
          return
        }

        let timestamp = summary?.updatedAt ?? null
        if (!timestamp) {
          const fileStat = await stat(source.path)
          timestamp = fileStat.mtime.toISOString()
        }

        const model = resolveModel(summary?.model ?? null)

        for (let turnIndex = 0; turnIndex < parsed.turns.length; turnIndex++) {
          const turn = parsed.turns[turnIndex]!
          const inputTokens = estimateTokens(turn.userMessage.length)
          const outputTokens = estimateTokens(turn.assistant.body.length)
          const reasoningTokens = estimateTokens(turn.assistant.reasoning.length)
          const deduplicationKey = `cursor-agent:${conversationId}:${turnIndex}`

          if (seenKeys.has(deduplicationKey)) continue
          seenKeys.add(deduplicationKey)

          const costUSD = calculateCost(
            costModel(model),
            inputTokens,
            outputTokens + reasoningTokens,
            0,
            0,
            0,
          )

          yield {
            provider: 'cursor-agent',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens,
            webSearchRequests: 0,
            costUSD,
            tools: turn.assistant.tools,
            bashCommands: [],
            timestamp,
            speed: 'standard',
            deduplicationKey,
            userMessage: turn.userMessage,
            sessionId: conversationId,
          }
        }
      } finally {
        db?.close()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createCursorAgentProvider(baseDirOverride?: string): Provider {
  const baseDir = getCursorAgentBaseDir(baseDirOverride)
  const projectsDir = getProjectsDir(baseDir)
  const chatsDir = getChatsDir(baseDir)
  const dbPath = getAttributionDbPath(baseDir)
  const summariesByConversationId = new Map<string, ConversationSummary>()

  // Per-session blob-graph cache: keyed by session UUID.
  // Entries are invalidated when the store.db WAL-aware fingerprint changes.
  const storeCache = new Map<string, StoreCacheEntry>()

  return {
    name: 'cursor-agent',
    displayName: 'Cursor Agent',

    modelDisplayName(model: string): string {
      if (model === 'cursor-agent-auto') return 'Cursor (auto)'
      const label = modelDisplayNames[model] ?? getShortModelName(model)
      return `${label} (est.)`
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [
        { path: projectsDir, label: 'projects' },
        { path: chatsDir, label: 'chats' },
        { path: dbPath, label: 'db' },
      ]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []

      // 1. store.db sources (highest precedence). Discovered first so their
      //    sentinel keys are set before transcript parsers run.
      await appendStoreSources(chatsDir, sources)

      // 2. Transcript sources (JSONL and TXT).
      if (existsSync(projectsDir)) {
        const projectEntries = await readdir(projectsDir, { withFileTypes: true })

        for (const entry of projectEntries) {
          if (!entry.isDirectory()) continue

          const projectId = prettifyProjectId(entry.name)
          const projectDir = join(projectsDir, entry.name)
          if (entry.name === 'agent-transcripts') {
            await appendTranscriptSources(projectDir, projectId, sources)
            continue
          }

          const transcriptDir = join(projectDir, 'agent-transcripts')
          if (!existsSync(transcriptDir)) continue
          await appendTranscriptSources(transcriptDir, projectId, sources)
        }
      }

      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      if (source.path.startsWith(STORE_SOURCE_PREFIX)) {
        return createStoreParser(source, seenKeys, storeCache)
      }
      return createTranscriptParser(source, seenKeys, dbPath, summariesByConversationId)
    },
  }
}

export const cursor_agent = createCursorAgentProvider()
