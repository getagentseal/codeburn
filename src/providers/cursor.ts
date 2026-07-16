import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { readCachedResults, writeCachedResults } from '../cursor-cache.js'
import { isSqliteAvailable, isSqliteBusyError, getSqliteLoadError, openDatabase, blobToText, type SqliteDatabase } from '../sqlite.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import type { DateRange } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

/** Matches cli-date.ts "all" period cap (6 months). */
const CURSOR_MAX_LOOKBACK_MONTHS = 6

export function getCursorTimeFloor(dateRange?: DateRange): string {
  const now = new Date()
  const maxStart = new Date(
    now.getFullYear(),
    now.getMonth() - CURSOR_MAX_LOOKBACK_MONTHS,
    now.getDate(),
  )
  const start = dateRange?.start ?? maxStart
  const effective = start < maxStart ? maxStart : start
  return effective.toISOString()
}

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
  request_id: string | null
  user_text: Uint8Array | string | null
  text_length: number | null
  bubble_type: number | null
  code_blocks: Uint8Array | string | null
  /// Only populated on the paged scan path (BUBBLE_QUERY_PAGE) used for very
  /// large databases; undefined on the un-paged BUBBLE_QUERY_SINCE path.
  rid?: number
}

type AgentKvRow = {
  role: string | null
  content: Uint8Array | string | null
  request_id: string | null
  model: string | null
}

// SQLITE_BUSY must reach parser.ts, whose busy path skips the source without
// caching; swallowing it here would stamp a silently degraded parse into the
// results cache under an unchanged DB fingerprint (Cursor writes via WAL, so
// contention does not change the main file's stat).
function rethrowBusy(err: unknown): void {
  if (isSqliteBusyError(err)) throw err
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

function getCursorWorkspaceStorageDir(globalDbPath: string): string {
  // Sibling of globalStorage. Cursor lays out User/{globalStorage,workspaceStorage}/.
  // We derive the workspaceStorage path from the global DB path so a test or
  // override can supply both consistently from one root.
  // globalDbPath = .../User/globalStorage/state.vscdb
  // workspaceStorage = .../User/workspaceStorage
  const userDir = join(globalDbPath, '..', '..')
  return join(userDir, 'workspaceStorage')
}

/// Per-conversation workspace lookup table. Cursor stores each chat as
/// `bubbleId:<composerId>:<bubbleUuid>` rows in the GLOBAL state.vscdb but
/// does NOT carry a workspace path on the bubble itself. The mapping lives
/// in per-workspace dirs at `workspaceStorage/<hash>/`:
///   - `workspace.json` carries the folder URI (`file:///Users/me/proj`)
///   - `state.vscdb`'s `ItemTable['composer.composerData']` lists every
///     composerId opened in that workspace
/// We walk every workspace dir, pull both, and build composerId -> folder.
type WorkspaceMapping = {
  composerToWorkspace: Map<string, string>     // composerId -> folder URI
  workspaceProjectName: Map<string, string>    // folder URI -> sanitized project name
}

const ORPHAN_TAG = '__orphan__'
// Catch-all project label for composers that did not register against any
// workspace. When the user has no workspaces at all this is the only label
// shown, matching the pre-PR `cursor` project so legacy installs are not
// renamed by the breakdown change.
const ORPHAN_PROJECT = 'cursor'

function sanitizeWorkspaceUri(uri: string): string {
  // Mirrors Claude's slug convention so two providers reporting the same
  // project path produce identical project keys for cross-provider rollup.
  // file:///Users/me/myproject → -Users-me-myproject
  // vscode-remote://wsl+Ubuntu/home/me/proj → -wsl-Ubuntu-home-me-proj
  let path: string
  if (uri.startsWith('file://')) {
    path = uri.slice('file://'.length)
  } else {
    // Other URI schemes (vscode-remote://, ssh+remote://, etc.): swap "://"
    // for a leading "/" so the slugifier produces a predictable shape.
    path = uri.replace(/^[^:]+:\/\//, '/').replace(/\+/g, '-')
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // Malformed percent encoding — keep as-is rather than throw.
  }
  return path.replace(/\/+/g, '-')
}

let workspaceMapCache: WorkspaceMapping | null = null
let workspaceMapCacheRoot: string | null = null

/// Visible for tests so a fixture can rebuild the map after writing fresh
/// workspace directories.
export function clearCursorWorkspaceMapCache(): void {
  workspaceMapCache = null
  workspaceMapCacheRoot = null
}

function loadWorkspaceMap(workspaceStorageDir: string): WorkspaceMapping {
  if (workspaceMapCache && workspaceMapCacheRoot === workspaceStorageDir) {
    return workspaceMapCache
  }
  const result: WorkspaceMapping = {
    composerToWorkspace: new Map(),
    workspaceProjectName: new Map(),
  }

  let entries: string[]
  try {
    entries = readdirSync(workspaceStorageDir)
  } catch {
    workspaceMapCache = result
    workspaceMapCacheRoot = workspaceStorageDir
    return result
  }

  for (const hashDir of entries) {
    const wsJsonPath = join(workspaceStorageDir, hashDir, 'workspace.json')
    const wsDbPath = join(workspaceStorageDir, hashDir, 'state.vscdb')

    let wsJsonRaw: string
    try {
      wsJsonRaw = readFileSync(wsJsonPath, 'utf-8')
    } catch {
      continue
    }

    let folder: string | undefined
    try {
      const parsed = JSON.parse(wsJsonRaw) as { folder?: string }
      folder = parsed.folder
    } catch {
      continue
    }
    if (!folder) continue
    if (!existsSync(wsDbPath)) continue

    let db: SqliteDatabase
    try {
      db = openDatabase(wsDbPath)
    } catch {
      continue
    }
    try {
      // Cursor renamed the per-workspace composer list from
      // 'composer.composerData' to 'composer.composerHeaders' in newer builds
      // (identical { allComposers: [{ composerId }] } shape). Read both keys
      // and merge so the composer -> workspace mapping keeps working across
      // Cursor versions. Without this, on builds that only write
      // 'composer.composerHeaders' every composer falls through to the
      // 'cursor' orphan bucket and per-project attribution is lost.
      const rows = db.query<{ value: string }>(
        "SELECT value FROM ItemTable WHERE key IN ('composer.composerData', 'composer.composerHeaders')",
      )
      if (rows.length === 0) continue
      const project = sanitizeWorkspaceUri(folder)
      let added = 0
      for (const row of rows) {
        let parsed: { allComposers?: Array<{ composerId?: string }> }
        try {
          parsed = JSON.parse(row.value)
        } catch {
          continue
        }
        for (const c of parsed.allComposers ?? []) {
          if (typeof c.composerId === 'string') {
            result.composerToWorkspace.set(c.composerId, folder)
            added += 1
          }
        }
      }
      if (added > 0) {
        result.workspaceProjectName.set(folder, project)
      }
    } catch {
      // best-effort
    } finally {
      db.close()
    }
  }

  workspaceMapCache = result
  workspaceMapCacheRoot = workspaceStorageDir
  return result
}

/// Pulls the composer id out of a `bubbleId:<composerId>:<bubbleUuid>` key.
/// Returns null when the composer segment contains a CR/LF, which is the
/// signature Cursor uses for tool-call sub-composer rows in real data —
/// e.g. `bubbleId:task-call_xxxx\nfc_yyyy:<bubbleUuid>` is one key with a
/// literal newline between the `task-call_` and `fc_` halves. Those rows
/// are not standalone composers and would otherwise inflate the orphan
/// project's session count.
function parseComposerIdFromKey(key: string | undefined): string | null {
  if (!key) return null
  const firstColon = key.indexOf(':')
  if (firstColon < 0) return null
  const secondColon = key.indexOf(':', firstColon + 1)
  if (secondColon < 0) return null
  const candidate = key.slice(firstColon + 1, secondColon)
  if (!candidate) return null
  // Reject any multi-line / control-char composer id. Real composer ids
  // (UUIDs) and synthetic fixture ids are both single-line.
  if (/[\r\n\x00]/.test(candidate)) return null
  return candidate
}

// Encodes the active workspace into source.path so the parser knows which
// composers to filter for. `#cursor-ws=` is a private separator: `state.vscdb`
// does not contain `#` (we construct the path ourselves), and the literal
// token only appears in source paths emitted from this provider, so there
// is no realistic collision.
const WORKSPACE_SEP = '#cursor-ws='

function encodeSourcePath(dbPath: string, workspaceTag: string): string {
  return `${dbPath}${WORKSPACE_SEP}${workspaceTag}`
}

function decodeSourcePath(sourcePath: string): { dbPath: string; workspaceTag: string } {
  const idx = sourcePath.indexOf(WORKSPACE_SEP)
  // Backwards-compat: a bare DB path with no workspace tag means "give me
  // every call from this DB". Older cached SessionSource entries and any
  // hand-constructed source from a test land here.
  if (idx < 0) return { dbPath: sourcePath, workspaceTag: '__all__' }
  return {
    dbPath: sourcePath.slice(0, idx),
    workspaceTag: sourcePath.slice(idx + WORKSPACE_SEP.length),
  }
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
    json_extract(value, '$.requestId') as request_id,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
`

const AGENTKV_QUERY = `
  SELECT
    json_extract(value, '$.role') as role,
    CAST(json_extract(value, '$.content') AS BLOB) as content,
    json_extract(value, '$.providerOptions.cursor.requestId') as request_id,
    json_extract(value, '$.providerOptions.cursor.modelName') as model
  FROM cursorDiskKV
  WHERE key LIKE 'agentKv:blob:%'
    AND hex(substr(value, 1, 1)) = '7B'
  ORDER BY ROWID ASC
`

const USER_MESSAGES_QUERY = `
  SELECT
    key as bubble_key,
    json_extract(value, '$.createdAt') as created_at,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as text
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.type') = 1
    AND (json_extract(value, '$.createdAt') > ? OR json_extract(value, '$.createdAt') IS NULL)
  ORDER BY ROWID ASC
`

// Split into HEAD (predicates we always emit) and TAIL (ORDER BY) so the
// caller can splice in an optional `ROWID >= ?` cutoff without rewriting
// the whole template. The original combined string is preserved as
// BUBBLE_QUERY_SINCE for any caller that doesn't want the cap.
const BUBBLE_QUERY_SINCE_HEAD = BUBBLE_QUERY_BASE + `
    AND json_extract(value, '$.createdAt') IS NOT NULL
    AND json_extract(value, '$.createdAt') > ?`
const BUBBLE_QUERY_SINCE_TAIL = `
  ORDER BY ROWID ASC
`
const BUBBLE_QUERY_SINCE = BUBBLE_QUERY_SINCE_HEAD + BUBBLE_QUERY_SINCE_TAIL

// Paged variant for very large DBs: fetches one ROWID-descending page below a
// cursor. Returns ROWID and createdAt so the caller can stop once it has paged
// past the requested window floor. No date predicate here — the caller filters
// by createdAt in JS so it can see the window boundary.
const BUBBLE_QUERY_PAGE = `
  SELECT
    key as bubble_key,
    ROWID as rid,
    json_extract(value, '$.tokenCount.inputTokens') as input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') as output_tokens,
    json_extract(value, '$.modelInfo.modelName') as model,
    json_extract(value, '$.createdAt') as created_at,
    json_extract(value, '$.requestId') as request_id,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%' AND ROWID < ?
  ORDER BY ROWID DESC
  LIMIT ?
`

function validateSchema(db: SqliteDatabase): boolean {
  try {
    const rows = db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' LIMIT 1"
    )
    return rows.length > 0
  } catch (err) {
    rethrowBusy(err)
    return false
  }
}

type UserMsgRow = { bubble_key: string; created_at: string; text: Uint8Array | string }

/// Per-conversation user-message buffer. We pop messages in arrival order via
/// the `pos` cursor — a previous implementation called Array.shift() which is
/// O(n) per call on large conversations and pinned multi-GB Cursor DBs at
/// minutes-of-parse for power users. The cursor walk is O(1).
type UserMessageQueue = {
  messages: string[]
  pos: number
}

function buildUserMessageMap(db: SqliteDatabase, timeFloor: string): Map<string, UserMessageQueue> {
  const map = new Map<string, UserMessageQueue>()
  try {
    const rows = db.query<UserMsgRow>(USER_MESSAGES_QUERY, [timeFloor])
    for (const row of rows) {
      // Extract the composerId from the bubble key, matching parseBubbles().
      // The JSON `conversationId` field is empty in current Cursor builds.
      const composerId = parseComposerIdFromKey(row.bubble_key)
      if (!composerId || !row.text) continue
      const text = blobToText(row.text)
      const existing = map.get(composerId)
      if (existing) {
        existing.messages.push(text)
      } else {
        map.set(composerId, { messages: [text], pos: 0 })
      }
    }
  } catch (err) {
    rethrowBusy(err)
  }
  return map
}

function takeUserMessage(queues: Map<string, UserMessageQueue>, conversationId: string): string {
  const queue = queues.get(conversationId)
  if (!queue || queue.pos >= queue.messages.length) return ''
  const msg = queue.messages[queue.pos]
  queue.pos += 1
  return msg
}

/// Scans bubbles for very large DBs by paging ROWID-descending (newest first),
/// keeping only rows within the requested window (createdAt > timeFloor), and
/// stopping once a full page lands below the floor. A `budget` caps the number
/// of in-range bubbles collected so a genuinely enormous in-range scan can't
/// stall; `truncated` is set only when that budget is actually hit, so the
/// caller warns only when older in-range sessions were really dropped.
function scanBubblesPaged(
  db: SqliteDatabase,
  timeFloor: string,
  budget: number,
): { rows: BubbleRow[]; truncated: boolean } {
  const BATCH = 25_000
  const collected: BubbleRow[] = []
  let beforeRowId = Number.MAX_SAFE_INTEGER
  let truncated = false

  paging: while (true) {
    let batch: BubbleRow[]
    try {
      batch = db.query<BubbleRow>(BUBBLE_QUERY_PAGE, [beforeRowId, BATCH])
    } catch (err) {
      rethrowBusy(err)
      break
    }
    if (batch.length === 0) break

    for (const row of batch) {
      if (collected.length >= budget) { truncated = true; break paging }
      if (row.created_at != null && row.created_at > timeFloor) collected.push(row)
    }

    const oldest = batch[batch.length - 1]!
    beforeRowId = oldest.rid ?? 0
    if (beforeRowId <= 0) break
    if (batch.length < BATCH) break // exhausted the table
    // Pages are ROWID-descending (~chronological), so once the oldest row in a
    // full page predates the window, every older page does too.
    if (oldest.created_at != null && oldest.created_at <= timeFloor) break
  }

  // Restore ROWID-ascending order to match the un-paged query's row ordering.
  collected.sort((a, b) => (a.rid ?? 0) - (b.rid ?? 0))
  return { rows: collected, truncated }
}

// Cursor leaves the per-bubble tokenCount at {0,0} on current builds. The only
// real input figure on disk is the latest context-window snapshot, which Cursor
// records in composerData.promptTokenBreakdown.totalUsedTokens or
// contextTokensUsed (the in-app context meter). This is not cumulative per-turn,
// so local SQLite undercounts admin-console usage; parity requires the opt-in
// Cursor Admin API: POST api.cursor.com/teams/filtered-usage-events.
// The key-range predicate seeks the primary key instead of scanning the table.
const COMPOSER_META_QUERY = `
  SELECT
    substr(key, length('composerData:') + 1) as composer_id,
    json_extract(value, '$.promptTokenBreakdown.totalUsedTokens') as used,
    json_extract(value, '$.contextTokensUsed') as ctx,
    json_extract(value, '$.createdAt') as created_at
  FROM cursorDiskKV
  WHERE key >= 'composerData:' AND key < 'composerData;'
`

type ComposerMeta = { tokens: number; createdAt: number | null }

function loadComposerMeta(db: SqliteDatabase): Map<string, ComposerMeta> {
  const map = new Map<string, ComposerMeta>()
  try {
    const rows = db.query<{ composer_id: string; used: number | null; ctx: number | null; created_at: number | null }>(COMPOSER_META_QUERY)
    for (const r of rows) {
      // `||` rather than `??`: a recorded-but-zero breakdown must fall through
      // to the context meter instead of shadowing it.
      const tokens = (r.used || r.ctx) ?? 0
      if (r.composer_id && tokens > 0) map.set(r.composer_id, { tokens, createdAt: r.created_at ?? null })
    }
  } catch (err) {
    rethrowBusy(err)
    /* best-effort: callers fall back to the per-bubble text estimate */
  }
  return map
}

type AgentStream = {
  tools: string[]
  bash: string[]
  userChars: number
  contextChars: number
  assistantChars: number
  model: string | null
}

function newAgentStream(): AgentStream {
  return { tools: [], bash: [], userChars: 0, contextChars: 0, assistantChars: 0, model: null }
}

// agentKv rows store content as a plain string or a block array; count only
// the text inside blocks so the JSON envelope and non-text parts are not
// billed as prompt characters.
function contentTextLength(raw: string): number {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const blocks = Array.isArray(parsed) ? parsed : [parsed]
      let len = 0
      for (const block of blocks) {
        if (block == null || typeof block !== 'object') continue
        const b = block as { text?: unknown; content?: unknown }
        if (typeof b.text === 'string') len += b.text.length
        else if (typeof b.content === 'string') len += b.content.length
      }
      return len
    } catch {
      return raw.length
    }
  }
  return raw.length
}

// Cursor logs the agent's stream (prompt, injected context, tool calls, reply
// deltas) in agentKv blobs keyed by requestId. Bubbles carry the same
// requestId, so the map built from the scanned bubbles joins each request to
// its conversation. Requests with no matching bubble are kept separately:
// they are real sessions (background runs, older builds) that would otherwise
// vanish from totals.
function loadAgentStreams(
  db: SqliteDatabase,
  requestToComposer: Map<string, string>,
): { byComposer: Map<string, AgentStream>; unjoined: Map<string, AgentStream> } {
  const byComposer = new Map<string, AgentStream>()
  const unjoined = new Map<string, AgentStream>()

  let rows: AgentKvRow[]
  try {
    rows = db.query<AgentKvRow>(AGENTKV_QUERY)
  } catch (err) {
    rethrowBusy(err)
    return { byComposer, unjoined }
  }

  const bucketFor = (requestId: string): AgentStream => {
    const composer = requestToComposer.get(requestId)
    const map = composer ? byComposer : unjoined
    const key = composer ?? requestId
    const existing = map.get(key)
    if (existing) return existing
    const fresh = newAgentStream()
    map.set(key, fresh)
    return fresh
  }

  // Only the turn-opening (user) agentKv row carries the requestId; rows that
  // follow inherit it. Rows written BEFORE their request's id appears (the
  // system prompt and opening user prompt at a conversation start) buffer
  // until the next id, and a system row closes the previous request so
  // interleaved sessions cannot inherit across a conversation boundary.
  let currentRequestId: string | null = null
  let pendingUserChars = 0
  let pendingContextChars = 0
  for (const row of rows) {
    if (row.request_id) {
      currentRequestId = row.request_id
      if (pendingUserChars > 0 || pendingContextChars > 0) {
        const bucket = bucketFor(currentRequestId)
        bucket.userChars += pendingUserChars
        bucket.contextChars += pendingContextChars
        pendingUserChars = 0
        pendingContextChars = 0
      }
    }
    if (row.model && currentRequestId) {
      const bucket = bucketFor(currentRequestId)
      if (!bucket.model) bucket.model = row.model
    }
    if (!row.content) continue

    if (row.role === 'system') {
      pendingContextChars += contentTextLength(blobToText(row.content))
      currentRequestId = null
      continue
    }
    if (row.role === 'user') {
      const len = contentTextLength(blobToText(row.content))
      if (currentRequestId) bucketFor(currentRequestId).userChars += len
      else pendingUserChars += len
      continue
    }
    if (row.role === 'tool') {
      if (currentRequestId) bucketFor(currentRequestId).contextChars += contentTextLength(blobToText(row.content))
      continue
    }
    if (row.role !== 'assistant' || !currentRequestId) continue

    let content: unknown
    try {
      content = JSON.parse(blobToText(row.content))
    } catch {
      continue
    }
    if (!Array.isArray(content)) continue
    const bucket = bucketFor(currentRequestId)
    for (const block of content as Array<{ type?: string; text?: unknown; toolName?: unknown; args?: { command?: unknown } }>) {
      if (block == null || typeof block !== 'object') continue
      if (typeof block.text === 'string') bucket.assistantChars += block.text.length
      if (block.type !== 'tool-call' || typeof block.toolName !== 'string' || !block.toolName) continue
      // Cursor's terminal tool is 'Shell'; emit the canonical 'Bash' so the
      // cross-provider tool and command breakdowns merge.
      bucket.tools.push(block.toolName === 'Shell' ? 'Bash' : block.toolName)
      if (block.toolName === 'Shell' && typeof block.args?.command === 'string') {
        bucket.bash.push(...extractBashCommands(block.args.command))
      }
    }
  }
  return { byComposer, unjoined }
}

// What drives a conversation's input figure, decided once per conversation so
// the sources can never stack on each other:
//   bubbleTokens - some bubble carries a real tokenCount (older builds), so
//                  per-turn counts are authoritative and nothing is estimated.
//   meter        - the composerData context meter exists; one conversation
//                  record carries it.
//   stream       - no meter, but the agent stream holds the prompt/context; one
//                  conversation record carries the estimate.
//   text         - only visible bubble text exists; estimated per bubble.
type InputSource = 'bubbleTokens' | 'meter' | 'stream' | 'text'

type ComposerScan = {
  hasRealTokens: boolean
  firstBubbleTs: string | null
  assistantTextChars: number
  model: string | null
}

function parseBubbles(
  db: SqliteDatabase,
  seenKeys: Set<string>,
  timeFloor: string,
  agentKvTimestamp: string,
): { calls: ParsedProviderCall[] } {
  const results: ParsedProviderCall[] = []
  let skipped = 0

  const composerMeta = loadComposerMeta(db)

  // The bubble timestamp lives inside the JSON value (no index), so the date
  // filter forces a full JSON decode per row. Multi-GB Cursor DBs (500k+
  // bubbles) were producing 30s+ parse stalls, so the scan is bounded. The old
  // approach kept only the most-recent MAX_BUBBLES by ROWID, which dropped
  // in-range older sessions and warned even when the requested window fit
  // comfortably. Instead, for large DBs we page the requested window
  // (ROWID-descending, stopping past the window floor) and only fall back to a
  // hard budget — warning — when the in-range scan genuinely exceeds it.
  // Override the budget in tests via CODEBURN_CURSOR_MAX_BUBBLES.
  const MAX_BUBBLES = Number(process.env['CODEBURN_CURSOR_MAX_BUBBLES']) || 250_000

  let total = 0
  try {
    const countRows = db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"
    )
    total = countRows[0]?.cnt ?? 0
  } catch (err) {
    rethrowBusy(err)
  }

  let rows: BubbleRow[]
  try {
    if (total > MAX_BUBBLES) {
      const scan = scanBubblesPaged(db, timeFloor, MAX_BUBBLES)
      rows = scan.rows
      if (scan.truncated) {
        process.stderr.write(
          `codeburn: Cursor database has ${total.toLocaleString()} bubbles and the ` +
          `requested range exceeds the ${MAX_BUBBLES.toLocaleString()}-bubble scan budget; ` +
          `the oldest sessions in range may be missing from this report.\n`
        )
      }
    } else {
      rows = db.query<BubbleRow>(BUBBLE_QUERY_SINCE, [timeFloor])
    }
  } catch (err) {
    rethrowBusy(err)
    return { calls: results }
  }

  // Pre-pass: per-conversation facts the crediting decisions need, plus the
  // requestId join for the agent stream — all from the rows already fetched,
  // so no extra unbudgeted table scans.
  const scans = new Map<string, ComposerScan>()
  const requestToComposer = new Map<string, string>()
  for (const row of rows) {
    const cid = parseComposerIdFromKey(row.bubble_key)
    if (!cid) continue
    if (row.request_id) requestToComposer.set(row.request_id, cid)
    let scan = scans.get(cid)
    if (!scan) {
      scan = { hasRealTokens: false, firstBubbleTs: null, assistantTextChars: 0, model: null }
      scans.set(cid, scan)
    }
    if ((row.input_tokens ?? 0) > 0 || (row.output_tokens ?? 0) > 0) scan.hasRealTokens = true
    if (!scan.firstBubbleTs && row.created_at) scan.firstBubbleTs = row.created_at
    if (row.bubble_type !== 1) scan.assistantTextChars += row.text_length ?? 0
    if (!scan.model && row.model) scan.model = row.model
  }

  const { byComposer: agentStreams, unjoined } = loadAgentStreams(db, requestToComposer)
  const userMessages = buildUserMessageMap(db, timeFloor)
  const lastUserMsg = new Map<string, string>()

  const inputSource = (cid: string): InputSource => {
    if (scans.get(cid)?.hasRealTokens) return 'bubbleTokens'
    if (composerMeta.has(cid)) return 'meter'
    const stream = agentStreams.get(cid)
    if ((stream?.userChars ?? 0) + (stream?.contextChars ?? 0) > 0) return 'stream'
    return 'text'
  }

  const emit = (call: Omit<ParsedProviderCall, 'provider' | 'speed' | 'cacheCreationInputTokens' | 'cacheReadInputTokens' | 'cachedInputTokens' | 'reasoningTokens' | 'webSearchRequests' | 'costIsEstimated'>): void => {
    results.push({
      provider: 'cursor',
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      speed: 'standard',
      // Output is a reply-text estimate and the input meter is the latest
      // context snapshot, not a per-turn sum, so no cursor figure is exact.
      costIsEstimated: true,
      ...call,
    })
  }

  const toolsAttached = new Set<string>()
  for (const row of rows) {
    try {
      // The real composerId lives in the row key `bubbleId:<composerId>:<uuid>`
      // (the JSON conversationId field is empty in current builds).
      // parseComposerIdFromKey returns null for non-UUID composer segments
      // (tool-call output rows and similar shapes), which are NOT sessions.
      const conversationId = parseComposerIdFromKey(row.bubble_key)
      if (!conversationId) {
        skipped++
        continue
      }
      const createdAt = row.created_at
      if (!createdAt) continue

      // Pair each user turn with its own prompt (even when the turn itself
      // emits nothing) so the assistant reply that follows classifies against
      // the right question.
      if (row.bubble_type === 1) {
        lastUserMsg.set(conversationId, takeUserMessage(userMessages, conversationId))
      }

      let inputTokens = row.input_tokens ?? 0
      let outputTokens = row.output_tokens ?? 0
      if (inputTokens === 0 && outputTokens === 0) {
        const textLen = row.text_length ?? 0
        if (row.bubble_type === 1) {
          // Conversation-level input (meter or stream) is emitted once after
          // this loop; per-bubble text only counts when it is the
          // conversation's best available signal.
          if (inputSource(conversationId) === 'text' && textLen > 0) {
            inputTokens = estimateTokensFromChars(textLen)
          }
        } else {
          outputTokens = estimateTokensFromChars(textLen)
        }
        if (inputTokens === 0 && outputTokens === 0) continue
      }

      // Use the SQLite row key (bubbleId:<unique>) as the dedup key.
      // Cursor mutates token counts on the row in place when streaming
      // completes — including tokens in the dedup key (the previous
      // implementation) caused the same bubble to be counted twice once
      // its tokens stabilized.
      const dedupKey = `cursor:bubble:${row.bubble_key}`
      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      // User bubbles (type=1) carry no modelInfo, so fall back to the
      // conversation's model seen on its assistant bubbles or agent stream.
      const effectiveModel = row.model ?? scans.get(conversationId)?.model ?? agentStreams.get(conversationId)?.model ?? null
      const pricingModel = resolveModel(effectiveModel)
      const costUSD = calculateCost(pricingModel, inputTokens, outputTokens, 0, 0, 0)

      const userQuestion = lastUserMsg.get(conversationId) ?? ''
      const assistantText = blobToText(row.user_text)
      const userText = (userQuestion + ' ' + assistantText).trim()

      const languages = extractLanguages(blobToText(row.code_blocks))
      const hasCode = languages.length > 0

      // Meter/stream conversations carry their agent tools on the synthetic
      // conversation record below; the rest attach them to their first
      // emitted call so they are counted exactly once.
      let agentTurn: AgentStream | undefined
      const source = inputSource(conversationId)
      if ((source === 'text' || source === 'bubbleTokens') && !toolsAttached.has(conversationId)) {
        agentTurn = agentStreams.get(conversationId)
        if (agentTurn) toolsAttached.add(conversationId)
      }

      emit({
        model: modelForDisplay(effectiveModel),
        inputTokens,
        outputTokens,
        costUSD,
        tools: [
          ...(hasCode ? ['cursor:edit', ...languages.map(l => `lang:${l}`)] : []),
          ...(agentTurn?.tools ?? []),
        ],
        bashCommands: agentTurn?.bash ?? [],
        timestamp: createdAt,
        deduplicationKey: dedupKey,
        userMessage: userText,
        sessionId: conversationId,
      })
    } catch {
      skipped++
    }
  }

  // One conversation-level input record per metered/stream conversation,
  // anchored to the conversation's own start (composerData.createdAt) so the
  // credited day never depends on the parse window or cache state, and keyed
  // by composerId so re-parses and daily-cache gap fills dedupe instead of
  // multiplying. The meter is the LATEST context size, not a per-turn sum;
  // growth after the anchor day is finalized stays uncounted, which keeps the
  // documented undercount-vs-admin-console tradeoff but never double counts.
  for (const [cid, scan] of scans) {
    const source = inputSource(cid)
    if (source !== 'meter' && source !== 'stream') continue
    const stream = agentStreams.get(cid)
    const meta = composerMeta.get(cid)
    const inputTokens = source === 'meter'
      ? meta?.tokens ?? 0
      : estimateTokensFromChars((stream?.userChars ?? 0) + (stream?.contextChars ?? 0))
    // Reply text normally lives on assistant bubbles; count the stream's
    // reply deltas only when the bubbles carried none.
    const outputTokens = scan.assistantTextChars > 0 ? 0 : estimateTokensFromChars(stream?.assistantChars ?? 0)
    if (inputTokens === 0 && outputTokens === 0) continue

    const dedupKey = `cursor:composer-input:${cid}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    const createdAtMs = meta?.createdAt
    const timestamp = typeof createdAtMs === 'number' && createdAtMs > 0 ? new Date(createdAtMs).toISOString() : scan.firstBubbleTs
    if (!timestamp) continue

    const effectiveModel = scan.model ?? stream?.model ?? null
    emit({
      model: modelForDisplay(effectiveModel),
      inputTokens,
      outputTokens,
      costUSD: calculateCost(resolveModel(effectiveModel), inputTokens, outputTokens, 0, 0, 0),
      tools: stream?.tools ?? [],
      bashCommands: stream?.bash ?? [],
      timestamp,
      deduplicationKey: dedupKey,
      userMessage: '',
      sessionId: cid,
    })
  }

  // Sessions recorded only in the agent stream (no bubble carries their
  // requestId). agentKv stores no timestamps, so these reuse the DB file's
  // mtime as a bounded "last write" time, like the pre-composer parser did.
  for (const [requestId, stream] of unjoined) {
    const inputTokens = estimateTokensFromChars(stream.userChars + stream.contextChars)
    const outputTokens = estimateTokensFromChars(stream.assistantChars)
    if (inputTokens === 0 && outputTokens === 0) continue

    const dedupKey = `cursor:agentKv:${requestId}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    emit({
      model: modelForDisplay(stream.model),
      inputTokens,
      outputTokens,
      costUSD: calculateCost(resolveModel(stream.model), inputTokens, outputTokens, 0, 0, 0),
      tools: stream.tools,
      bashCommands: stream.bash,
      timestamp: agentKvTimestamp,
      deduplicationKey: dedupKey,
      userMessage: '',
      sessionId: requestId,
    })
  }

  if (skipped > 0) {
    process.stderr.write(`codeburn: skipped ${skipped} unreadable Cursor entries\n`)
  }

  return { calls: results }
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dateRange?: DateRange,
): SessionParser {
  const timeFloor = getCursorTimeFloor(dateRange)

  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const { dbPath, workspaceTag } = decodeSourcePath(source.path)

      // Decide which composers belong to this source. The workspace map is
      // built once per process from `workspaceStorage/*` and reused across
      // every workspace-scoped source, so we pay the directory walk cost
      // only once per CLI run regardless of how many projects the user has.
      // `composerFilter` holds the set of composers EITHER allowed (workspace
      // source) or denied (orphan source); `filterMode` says which.
      let composerFilter: Set<string> | null = null
      let filterMode: 'include' | 'exclude' = 'include'
      if (workspaceTag !== '__all__') {
        const wsMap = loadWorkspaceMap(getCursorWorkspaceStorageDir(dbPath))
        if (workspaceTag === ORPHAN_TAG) {
          // Orphan source: every composer that is mapped to SOME workspace
          // is excluded here, so unmapped composers (and any non-UUID
          // sub-composer ids that slip through) land in this bucket.
          composerFilter = new Set(wsMap.composerToWorkspace.keys())
          filterMode = 'exclude'
        } else {
          composerFilter = new Set()
          for (const [composerId, folder] of wsMap.composerToWorkspace) {
            if (folder === workspaceTag) composerFilter.add(composerId)
          }
          filterMode = 'include'
        }
      }

      // Cache is keyed on the bare DB path so multiple workspace-scoped
      // sources reuse one parsed bubble set per CLI run. Filtering happens
      // post-cache so each source emits only its own composers.
      let allCalls: ParsedProviderCall[] | null = null
      const cached = await readCachedResults(dbPath, timeFloor)
      if (cached) {
        allCalls = cached
      } else {
        let db: SqliteDatabase
        try {
          db = openDatabase(dbPath)
        } catch (err) {
          rethrowBusy(err)
          process.stderr.write(`codeburn: cannot open Cursor database: ${err instanceof Error ? err.message : err}\n`)
          return
        }
        try {
          if (!validateSchema(db)) {
            process.stderr.write('codeburn: Cursor storage format not recognized. You may need to update CodeBurn.\n')
            return
          }
          // Use a fresh local Set for intra-parse dedup so the global
          // seenKeys is not mutated by calls that the workspace filter is
          // about to drop. Cross-source dedup happens at yield time.
          const localSeen = new Set<string>()
          // agentKv rows carry no timestamps; sessions found only there get
          // the DB's last-write time.
          let agentKvTimestamp: string
          try {
            agentKvTimestamp = new Date(statSync(dbPath).mtimeMs).toISOString()
          } catch {
            agentKvTimestamp = new Date().toISOString()
          }
          const { calls: bubbleCalls } = parseBubbles(db, localSeen, timeFloor, agentKvTimestamp)
          allCalls = bubbleCalls
          await writeCachedResults(dbPath, allCalls, timeFloor)
        } finally {
          db.close()
        }
      }

      for (const call of allCalls) {
        if (composerFilter !== null) {
          const inSet = composerFilter.has(call.sessionId)
          if (filterMode === 'include' && !inSet) continue
          if (filterMode === 'exclude' && inSet) continue
        }
        if (seenKeys.has(call.deduplicationKey)) continue
        seenKeys.add(call.deduplicationKey)
        yield call
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

      const wsMap = loadWorkspaceMap(getCursorWorkspaceStorageDir(dbPath))
      const sources: SessionSource[] = []
      for (const [folder, project] of wsMap.workspaceProjectName) {
        sources.push({
          path: encodeSourcePath(dbPath, folder),
          project,
          provider: 'cursor',
        })
      }
      // Always emit a catch-all source for composers with no workspace
      // mapping. About a third of composers in real-world Cursor installs
      // are unmapped (multi-root workspaces, "no folder open" sessions,
      // deleted workspaces with surviving global rows). When the user has
      // no workspaces at all this source captures everything and the
      // dashboard looks identical to the pre-PR `cursor` project.
      sources.push({
        path: encodeSourcePath(dbPath, ORPHAN_TAG),
        project: ORPHAN_PROJECT,
        provider: 'cursor',
      })
      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>, dateRange?: DateRange): SessionParser {
      return createParser(source, seenKeys, dateRange)
    },
  }
}

export const cursor = createCursorProvider()
