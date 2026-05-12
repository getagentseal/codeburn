import { existsSync, statSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { readCachedResults, writeCachedResults } from '../cursor-cache.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, blobToText, type SqliteDatabase } from '../sqlite.js'
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
  user_text: Uint8Array | string | null
  text_length: number | null
  bubble_type: number | null
  code_blocks: Uint8Array | string | null
}

type AgentKvRow = {
  key: string
  role: string | null
  content: Uint8Array | string | null
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
    json_extract(value, '$.conversationId') as conversation_id,
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

type UserMsgRow = { conversation_id: string; created_at: string; text: Uint8Array | string }

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
      if (!row.conversation_id || !row.text) continue
      const text = blobToText(row.text)
      const existing = map.get(row.conversation_id)
      if (existing) {
        existing.messages.push(text)
      } else {
        map.set(row.conversation_id, { messages: [text], pos: 0 })
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

function parseBubbles(db: SqliteDatabase, seenKeys: Set<string>): { calls: ParsedProviderCall[] } {
  const results: ParsedProviderCall[] = []
  let skipped = 0

  const LOOKBACK_DAYS = 180
  const timeFloor = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Hard cap on rows to scan. The BUBBLE_QUERY_SINCE filter relies on
  // json_extract over the value BLOB, which SQLite cannot serve from an
  // index — every row is JSON-decoded. Multi-GB Cursor DBs (power users,
  // years of usage) regularly exceed 500k bubble rows and were producing
  // 30s+ parse stalls. Compute a ROWID cutoff that limits the scan to the
  // MAX_BUBBLES most-recent bubbles when the user is over the cap, and
  // warn so they know older sessions may be missing.
  const MAX_BUBBLES = 250_000
  let rowIdCutoff = 0
  try {
    const countRows = db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"
    )
    const total = countRows[0]?.cnt ?? 0
    if (total > MAX_BUBBLES) {
      // Find the ROWID of the (MAX_BUBBLES)th most-recent bubble. Anything
      // below this rowid is older and gets skipped. Bubbles are written
      // chronologically so ROWID order ≈ insertion order.
      const cutoffRows = db.query<{ rid: number }>(
        `SELECT MIN(rid) as rid FROM (
           SELECT ROWID as rid FROM cursorDiskKV
           WHERE key LIKE 'bubbleId:%'
           ORDER BY ROWID DESC
           LIMIT ?
         )`,
        [MAX_BUBBLES]
      )
      rowIdCutoff = cutoffRows[0]?.rid ?? 0
      process.stderr.write(
        `codeburn: Cursor database has ${total.toLocaleString()} bubbles, ` +
        `scanning the most recent ${MAX_BUBBLES.toLocaleString()}. ` +
        `Older sessions may be missing from this report.\n`
      )
    }
  } catch { /* best-effort diagnostic */ }

  const userMessages = buildUserMessageMap(db, timeFloor)

  // Append the rowid cutoff when active. Empty string when not capped so the
  // query string compares identically to the un-capped version on small DBs.
  const rowIdFilter = rowIdCutoff > 0 ? ' AND ROWID >= ?' : ''
  const params: unknown[] = rowIdCutoff > 0 ? [timeFloor, rowIdCutoff] : [timeFloor]
  const cappedQuery = BUBBLE_QUERY_SINCE_HEAD + rowIdFilter + BUBBLE_QUERY_SINCE_TAIL

  let rows: BubbleRow[]
  try {
    rows = db.query<BubbleRow>(cappedQuery, params)
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
      if (!createdAt) continue
      // The JSON `conversationId` field on bubbles is empty in current
      // Cursor builds. The real composerId lives in the row key
      // `bubbleId:<composerId>:<bubbleUuid>`. Extract from the key so the
      // workspace map join works. parseComposerIdFromKey returns null for
      // non-UUID composer segments (Cursor stores tool-call output under
      // `bubbleId:task-call_xxx\nfc_yyy:<bubbleUuid>` and similar shapes —
      // those bubbles are NOT standalone sessions; their tokens are
      // already accounted for inside the parent composer's stream).
      const parsedComposerId = parseComposerIdFromKey(row.bubble_key)
      if (!parsedComposerId) {
        skipped++
        continue
      }
      const conversationId = parsedComposerId
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

      const timestamp = createdAt
      const userQuestion = takeUserMessage(userMessages, conversationId)
      const assistantText = blobToText(row.user_text)
      const userText = (userQuestion + ' ' + assistantText).trim()

      const languages = extractLanguages(blobToText(row.code_blocks))
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
    const contentText = blobToText(row.content)

    let content: AgentKvContent[]
    let plainTextLength = 0
    try {
      const parsed = JSON.parse(contentText)
      if (Array.isArray(parsed)) {
        content = parsed
      } else {
        content = []
        plainTextLength = contentText.length
      }
    } catch {
      content = []
      plainTextLength = contentText.length
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
        const text = content[0]?.text ?? contentText
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
      const cached = await readCachedResults(dbPath)
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
          const { calls: bubbleCalls } = parseBubbles(db, localSeen)
          const { calls: agentKvCalls } = parseAgentKv(db, localSeen, dbPath)
          allCalls = [...bubbleCalls, ...agentKvCalls]
          await writeCachedResults(dbPath, allCalls)
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

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const cursor = createCursorProvider()
