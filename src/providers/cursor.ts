import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { readCachedResults, writeCachedResults } from '../cursor-cache.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, blobToText, type SqliteDatabase } from '../sqlite.js'
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
  conversation_id: string | null
  user_text: Uint8Array | string | null
  text_length: number | null
  bubble_type: number | null
  code_blocks: Uint8Array | string | null
  /// Only populated on the paged scan path (BUBBLE_QUERY_PAGE) used for very
  /// large databases; undefined on the un-paged BUBBLE_QUERY_SINCE path.
  rid?: number
}

type AgentKvRow = {
  key: string
  role: string | null
  content: Uint8Array | string | null
  request_id: string | null
  content_length: number
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
      const rows = db.query<{ value: string }>(
        "SELECT value FROM ItemTable WHERE key='composer.composerData'",
      )
      if (rows.length === 0) continue
      let parsed: { allComposers?: Array<{ composerId?: string }> }
      try {
        parsed = JSON.parse(rows[0]!.value)
      } catch {
        continue
      }
      const project = sanitizeWorkspaceUri(folder)
      let added = 0
      for (const c of parsed.allComposers ?? []) {
        if (typeof c.composerId === 'string') {
          result.composerToWorkspace.set(c.composerId, folder)
          added += 1
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
    json_extract(value, '$.conversationId') as conversation_id,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
`

const AGENTKV_QUERY = `
  SELECT
    key,
    json_extract(value, '$.role') as role,
    CAST(json_extract(value, '$.content') AS BLOB) as content,
    json_extract(value, '$.providerOptions.cursor.requestId') as request_id,
    length(value) as content_length
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
    json_extract(value, '$.conversationId') as conversation_id,
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
  } catch {
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
  } catch {}
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
    } catch {
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
// Keyed by composerId so parseBubbles can credit it to the right conversation.
const COMPOSER_TOKENS_QUERY = `
  SELECT
    substr(key, 14) as composer_id,
    json_extract(value, '$.promptTokenBreakdown.totalUsedTokens') as used,
    json_extract(value, '$.contextTokensUsed') as ctx
  FROM cursorDiskKV
  WHERE key LIKE 'composerData:%'
`

function loadComposerInputTokens(db: SqliteDatabase): Map<string, number> {
  const map = new Map<string, number>()
  try {
    const rows = db.query<{ composer_id: string; used: number | null; ctx: number | null }>(COMPOSER_TOKENS_QUERY)
    for (const r of rows) {
      const tokens = r.used ?? r.ctx ?? 0
      if (r.composer_id && tokens > 0) map.set(r.composer_id, tokens)
    }
  } catch {
    /* best-effort: callers fall back to the per-bubble text estimate */
  }
  return map
}

type AgentTools = { tools: string[]; bash: string[] }

// Cursor logs the agent's tool calls (Read, Grep, Shell, ...) in agentKv blobs
// keyed by requestId. Bubbles carry the same requestId plus the composerId, so
// joining the two attributes each conversation's tools and Shell commands.
const BUBBLE_REQUESTID_QUERY = `
  SELECT key as bubble_key, json_extract(value, '$.requestId') as request_id
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%' AND json_extract(value, '$.requestId') IS NOT NULL
`

function loadAgentToolsByComposer(db: SqliteDatabase): Map<string, AgentTools> {
  const byComposer = new Map<string, AgentTools>()

  const requestToComposer = new Map<string, string>()
  try {
    const rows = db.query<{ bubble_key: string; request_id: string | null }>(BUBBLE_REQUESTID_QUERY)
    for (const r of rows) {
      const composer = parseComposerIdFromKey(r.bubble_key)
      if (composer && r.request_id) requestToComposer.set(r.request_id, composer)
    }
  } catch {
    return byComposer
  }

  let rows: AgentKvRow[]
  try {
    rows = db.query<AgentKvRow>(AGENTKV_QUERY)
  } catch {
    return byComposer
  }

  // Only the turn-opening (user) agentKv row carries the requestId; the
  // assistant rows that follow inherit it, so track it positionally.
  let currentRequestId: string | null = null
  for (const row of rows) {
    if (row.request_id) currentRequestId = row.request_id
    if (row.role !== 'assistant' || !row.content || !currentRequestId) continue
    const composer = requestToComposer.get(currentRequestId)
    if (!composer) continue
    let content: unknown
    try {
      content = JSON.parse(blobToText(row.content))
    } catch {
      continue
    }
    if (!Array.isArray(content)) continue
    const bucket = byComposer.get(composer) ?? { tools: [], bash: [] }
    for (const block of content as Array<{ type?: string; toolName?: string; args?: { command?: string } }>) {
      if (!block || block.type !== 'tool-call' || !block.toolName) continue
      bucket.tools.push(block.toolName)
      if (block.toolName === 'Shell') {
        const command = block.args?.command?.trim()
        if (command) bucket.bash.push(command)
      }
    }
    byComposer.set(composer, bucket)
  }
  return byComposer
}

function parseBubbles(
  db: SqliteDatabase,
  seenKeys: Set<string>,
  timeFloor: string,
  composerInput: Map<string, number>,
  agentTools: Map<string, AgentTools>,
): { calls: ParsedProviderCall[] } {
  const results: ParsedProviderCall[] = []
  let skipped = 0
  // Each conversation's real context is credited once (on its first turn) so a
  // multi-turn chat does not multiply the snapshot across every bubble.
  const creditedComposers = new Set<string>()

  // Build a composerId -> model map from assistant bubbles. User bubbles
  // (type=1) carry no modelInfo, so when we credit real input tokens onto a
  // user bubble we need the conversation's actual model for pricing.
  const composerModel = new Map<string, string>()
  try {
    const modelRows = db.query<{ bubble_key: string; model: string | null }>(`
      SELECT key as bubble_key, json_extract(value, '$.modelInfo.modelName') as model
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%' AND json_extract(value, '$.modelInfo.modelName') IS NOT NULL
    `)
    for (const r of modelRows) {
      const cid = parseComposerIdFromKey(r.bubble_key)
      if (cid && r.model && !composerModel.has(cid)) composerModel.set(cid, r.model)
    }
  } catch { /* best-effort */ }

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
  } catch { /* best-effort */ }

  const userMessages = buildUserMessageMap(db, timeFloor)

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
  } catch {
    return { calls: results }
  }

  for (const row of rows) {
    try {
      // The JSON `conversationId` field on bubbles is empty in current Cursor
      // builds. The real composerId lives in the row key
      // `bubbleId:<composerId>:<bubbleUuid>`. parseComposerIdFromKey returns
      // null for non-UUID composer segments (Cursor stores tool-call output
      // under `bubbleId:task-call_xxx\nfc_yyy:<bubbleUuid>` and similar shapes),
      // which are NOT standalone sessions.
      const parsedComposerId = parseComposerIdFromKey(row.bubble_key)
      if (!parsedComposerId) {
        skipped++
        continue
      }
      const conversationId = parsedComposerId

      const createdAt = row.created_at ?? ''
      if (!createdAt) continue

      let inputTokens = row.input_tokens ?? 0
      let outputTokens = row.output_tokens ?? 0
      // The conversation's tools/bash attach to the single call that carries its
      // real input (its first turn), so they are counted exactly once.
      let creditedHere = false

      // Current Cursor leaves tokenCount at {0,0}. Use the latest local
      // context-window snapshot for input, credited once per conversation; it is
      // not cumulative per-turn, so it undercounts Cursor Admin console totals.
      // Output is a reply-text estimate, and cache tokens are server-side only
      // (0 on disk). Admin-console parity requires POST
      // api.cursor.com/teams/filtered-usage-events.
      // Fall back to the visible-text estimate only when no breakdown was
      // recorded (older builds).
      if (inputTokens === 0 && outputTokens === 0) {
        const textLen = row.text_length ?? 0
        if (row.bubble_type === 1) {
          const real = composerInput.get(conversationId)
          if (real != null) {
            if (creditedComposers.has(conversationId)) {
              inputTokens = 0
            } else {
              inputTokens = real
              creditedComposers.add(conversationId)
              creditedHere = true
            }
          } else {
            inputTokens = Math.ceil(textLen / CHARS_PER_TOKEN)
          }
        } else {
          outputTokens = Math.ceil(textLen / CHARS_PER_TOKEN)
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

      // User bubbles (type=1) carry no modelInfo, so when real input tokens
      // are credited onto them, fall back to the conversation's model (found
      // on the assistant bubble) for pricing and display.
      const effectiveModel = row.model ?? composerModel.get(conversationId) ?? null
      const pricingModel = resolveModel(effectiveModel)
      const displayModel = modelForDisplay(effectiveModel)

      const costUSD = calculateCost(pricingModel, inputTokens, outputTokens, 0, 0, 0)

      const timestamp = createdAt
      const userQuestion = takeUserMessage(userMessages, conversationId)
      const assistantText = blobToText(row.user_text)
      const userText = (userQuestion + ' ' + assistantText).trim()

      const languages = extractLanguages(blobToText(row.code_blocks))
      const hasCode = languages.length > 0

      const agentTurn = creditedHere ? agentTools.get(conversationId) : undefined
      const cursorTools: string[] = [
        ...(hasCode ? ['cursor:edit', ...languages.map(l => `lang:${l}`)] : []),
        ...(agentTurn?.tools ?? []),
      ]
      const bashCommands = agentTurn?.bash ?? []

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
        bashCommands,
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
          // Real per-conversation input tokens from
          // composerData.promptTokenBreakdown supersedes the old agentKv
          // content-char estimate, which double-counted against the bubble
          // stream. agentKv is now used only for the tools/bash breakdown
          // via loadAgentToolsByComposer().
          const composerInput = loadComposerInputTokens(db)
          const agentTools = loadAgentToolsByComposer(db)
          const { calls: bubbleCalls } = parseBubbles(db, localSeen, timeFloor, composerInput, agentTools)
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
