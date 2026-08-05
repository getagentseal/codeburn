import { createHash } from 'crypto'
import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import { normalizeModelIdentifier } from '../../schema.js'
import type {
  AssistantMessageData,
  ChatJournalPathSegment,
  ChatSessionRequest,
  CopilotCallArm,
  CopilotDecodedCall,
  CopilotEvent,
  CopilotOtelConversationRecord,
  CopilotOtelSpanRecord,
  CopilotRecordEnvelope,
  JBConversation,
  JBDbTurn,
  ModelChangeData,
  SessionShutdownData,
  SessionStartData,
  SpanAttributes,
  SubagentSelectedData,
  ToolRequest,
  UserMessageData,
} from './types.js'

// ---------------------------------------------------------------------------
// Tool name normalisation (unchanged from original, plus OTel tool names)
// ---------------------------------------------------------------------------
export const copilotToolNameMap: Record<string, string> = {
  // JSONL session-state tool names
  bash: 'Bash',
  skill: 'Skill',
  read_file: 'Read',
  write_file: 'Edit',
  edit_file: 'Edit',
  delete_file: 'Delete',
  github_repo: 'GitHub',
  web_search: 'WebSearch',
  run_in_terminal: 'Shell',
  // JetBrains Copilot agent tool names (snake_case)
  insert_edit_into_file: 'Edit',
  create_file: 'Edit',
  get_errors: 'Diagnostics',
  file_search: 'Search',
  grep_search: 'Search',
  semantic_search: 'Search',
  list_dir: 'Search',
  fetch_webpage: 'Web',
  // OTel execute_tool span names from Copilot Chat:
  readFile: 'Read',
  writeFile: 'Edit',
  editFile: 'Edit',
  runCommand: 'Shell',
  runInTerminal: 'Shell',
  findFiles: 'Search',
  grepSearch: 'Search',
  codebaseSearch: 'Search',
  getErrors: 'Diagnostics',
  listCodeUsages: 'Search',
  createFile: 'Edit',
  deleteFile: 'Delete',
  renameOrMoveFile: 'Edit',
  fetchWebpage: 'Web',
}

/**
 * Normalise a raw tool name to its display form.
 * - Known tools are mapped via toolNameMap.
 * - MCP tools (containing both '-' and '_') are formatted as
 *   mcp__server_name__tool_name.
 * - Everything else is returned unchanged.
 */
export function normalizeCopilotTool(rawTool: string): string {
  const mapped = copilotToolNameMap[rawTool]
  if (mapped) return mapped
  // MCP tool names follow the pattern: server-name-tool_operand
  // e.g. github-mcp-server-list_issues → mcp__github_mcp_server__list_issues
  const dashIdx = rawTool.lastIndexOf('-')
  if (dashIdx > 0 && rawTool.includes('_')) {
    const server = rawTool.slice(0, dashIdx).replace(/-/g, '_')
    const tool = rawTool.slice(dashIdx + 1)
    return `mcp__${server}__${tool}`
  }
  return rawTool
}

// Tool names that represent shell/bash execution. When the AI calls one of
// these, we extract the `arguments.command` string into rawBashCommands[].
const BASH_TOOL_NAMES = new Set(['bash', 'run_in_terminal', 'runInTerminal', 'runCommand'])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert nanosecond or millisecond epoch to ISO timestamp.
 * The OTel spec uses nanoseconds, but some implementations use milliseconds.
 */
function epochToISO(epoch: number): string {
  // Guard malformed rows: new Date(NaN).toISOString() throws. Fall back to the
  // epoch (1970) so a bad timestamp is excluded from period totals, not crashing.
  if (!Number.isFinite(epoch) || epoch <= 0) return new Date(0).toISOString()
  // If the value looks like nanoseconds (> 1e15), convert to ms
  const ms = epoch > 1e15 ? Math.floor(epoch / 1e6) : epoch > 1e12 ? epoch : epoch * 1000
  return new Date(ms).toISOString()
}

function timestampToISO(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return epochToISO(raw)
  }
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return epochToISO(Number(trimmed))
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReplayContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function createReplayObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

const FORBIDDEN_CHAT_JOURNAL_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function parseChatJournalPath(rawPath: unknown, fallback?: ChatJournalPathSegment[]): ChatJournalPathSegment[] | null {
  const value = rawPath === undefined ? fallback : rawPath
  if (!Array.isArray(value)) return null

  const path: ChatJournalPathSegment[] = []
  for (const segment of value) {
    if (typeof segment === 'number') {
      if (!Number.isInteger(segment) || segment < 0) return null
      path.push(segment)
      continue
    }
    if (typeof segment === 'string') {
      if (FORBIDDEN_CHAT_JOURNAL_KEYS.has(segment)) return null
      path.push(segment)
      continue
    }
    return null
  }
  return path
}

function getReplayValue(container: object, segment: ChatJournalPathSegment): unknown {
  return (container as Record<string, unknown>)[String(segment)]
}

function setReplayValue(container: object, segment: ChatJournalPathSegment, value: unknown): void {
  ;(container as Record<string, unknown>)[String(segment)] = value
}

function createContainerForNext(segment: ChatJournalPathSegment): unknown[] | Record<string, unknown> {
  return typeof segment === 'number' ? [] : createReplayObject()
}

function ensureReplayParent(root: object, path: ChatJournalPathSegment[]): object | null {
  let current: object = root
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!
    const nextSegment = path[i + 1]!
    let child = getReplayValue(current, segment)
    if (!isReplayContainer(child)) {
      const created = createContainerForNext(nextSegment)
      setReplayValue(current, segment, created)
      current = created
      continue
    }
    current = child
  }
  return current
}

function applyChatJournalSet(root: unknown, path: ChatJournalPathSegment[], value: unknown): unknown {
  if (path.length === 0) return value

  const workingRoot = isReplayContainer(root) ? root : createReplayObject()
  const parent = ensureReplayParent(workingRoot, path)
  if (!parent) return workingRoot
  setReplayValue(parent, path[path.length - 1]!, value)
  return workingRoot
}

function applyChatJournalAppend(root: unknown, path: ChatJournalPathSegment[], items: unknown[]): unknown {
  const workingRoot = isReplayContainer(root) ? root : createReplayObject()

  if (path.length === 0) {
    if (Array.isArray(workingRoot)) {
      for (const item of items) workingRoot.push(item)
    }
    return workingRoot
  }

  const parent = ensureReplayParent(workingRoot, path)
  if (!parent) return workingRoot

  const last = path[path.length - 1]!
  let target = getReplayValue(parent, last)
  const targetArray: unknown[] = Array.isArray(target) ? target : []
  if (target !== targetArray) {
    setReplayValue(parent, last, targetArray)
  }
  for (const item of items) targetArray.push(item)
  return workingRoot
}

function replayChatSessionJournal(content: string): unknown {
  let root: unknown = createReplayObject()
  const lines = content.split('\n').filter((l) => l.trim())

  for (const line of lines) {
    let entry: unknown
    try {
      entry = JSON.parse(line) as unknown
    } catch {
      continue
    }
    if (!isRecord(entry)) continue

    const kind = entry['kind']
    if (kind === 0) {
      root = entry['v']
      continue
    }

    if (kind === 1) {
      const path = parseChatJournalPath(entry['k'])
      if (!path) continue
      root = applyChatJournalSet(root, path, entry['v'])
      continue
    }

    if (kind === 2) {
      const hasPath = Object.prototype.hasOwnProperty.call(entry, 'k')
      const path = parseChatJournalPath(hasPath ? entry['k'] : undefined, ['requests'])
      const items = Array.isArray(entry['v']) ? entry['v'] : []
      if (!path) continue
      root = applyChatJournalAppend(root, path, items)
    }
  }

  return root
}

function numberOrZero(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
}

function readString(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

function modelFromChatSessionRequest(req: ChatSessionRequest, metadata: Record<string, unknown>): string {
  const resolved = readString(metadata['resolvedModel'])
  if (resolved) return resolved

  const modelId = readString(req['modelId']).replace(/^copilot\//, '')
  return modelId || 'unknown'
}

function extractChatSessionTools(metadata: Record<string, unknown>): string[] {
  const rounds = metadata['toolCallRounds']
  if (!Array.isArray(rounds)) return []

  const names = new Set<string>()
  const addName = (raw: unknown): void => {
    if (typeof raw === 'string' && raw.trim()) names.add(normalizeCopilotTool(raw))
  }
  const addFromRecord = (record: Record<string, unknown>): void => {
    addName(record['toolName'])
    addName(record['name'])
    addName(record['tool'])
  }

  for (const round of rounds) {
    if (!isRecord(round)) continue
    addFromRecord(round)

    for (const key of ['tools', 'toolCalls', 'toolRequests']) {
      const entries = round[key]
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (typeof entry === 'string') {
          addName(entry)
        } else if (isRecord(entry)) {
          addFromRecord(entry)
        }
      }
    }
  }

  return [...names]
}

/**
 * Extract a shell command string from an OTel execute_tool span's
 * `gen_ai.tool.call.arguments` attribute. The attribute is a JSON-encoded
 * argument object (e.g. `{"command":"ls -la"}`); we pull out the `command`
 * field. Returns null when the attribute is absent or doesn't carry a command,
 * so callers can skip shell-command extraction cleanly.
 */
function parseToolCommand(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const command = parsed['command']
    return typeof command === 'string' ? command : null
  } catch {
    return null
  }
}

/**
 * Safely coerce a raw toolRequests value to an array of ToolRequest.
 * Non-array values (string, null, undefined) are treated as empty arrays
 * so that a corrupt event.data doesn't abort the whole file parse loop.
 */
function coerceToolRequests(raw: unknown): ToolRequest[] {
  return Array.isArray(raw) ? (raw as ToolRequest[]) : []
}

/**
 * Infer the model bucket for a VS Code transcript file by counting the
 * toolCallId prefixes across all assistant messages:
 *   call_*           → OpenAI
 *   tooluse_* / toolu_*  → Anthropic
 * The dominant prefix determines the model for the whole session.
 * Returns '' if no toolCallIds are present.
 */
function inferTranscriptModel(lines: string[]): string {
  let openaiCount = 0
  let anthropicCount = 0

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as CopilotEvent
      if (event.type !== 'assistant.message') continue
      const data = event.data as AssistantMessageData & { toolRequests?: Array<{ toolCallId?: string }> }
      const reqs = coerceToolRequests(data.toolRequests)
      for (const req of reqs) {
        const id = (req as { toolCallId?: unknown }).toolCallId
        if (typeof id !== 'string') continue
        if (id.startsWith('call_')) openaiCount++
        else if (/^tooluse_|^toolu_/.test(id)) anthropicCount++
      }
    } catch {
      continue
    }
  }

  if (openaiCount === 0 && anthropicCount === 0) return ''
  return openaiCount >= anthropicCount ? 'copilot-openai-auto' : 'copilot-anthropic-auto'
}

// ---------------------------------------------------------------------------
// JetBrains helpers
// ---------------------------------------------------------------------------

// Known JetBrains Copilot model tokens, longest-first so we match the most
// specific name (e.g. "gpt-4.1-mini" before "gpt-4.1").
const JETBRAINS_MODEL_TOKENS = [
  'claude-opus-4.5',
  'claude-opus-4.1',
  'claude-opus-4',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'gpt-5.3-codex',
  'gpt-5.3',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5-mini',
  'gpt-5',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4.1',
  'gpt-4o-mini',
  'gpt-4o',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'o3-mini',
  'o4-mini',
  'o3',
]

/**
 * Normalise a raw JetBrains model token to CodeBurn's canonical model id.
 * Claude names use dots on disk (claude-opus-4.5) but dashes in the pricing
 * tables (claude-opus-4-5); GPT/Gemini names are kept verbatim.
 */
function normalizeJetBrainsModelName(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (t.startsWith('claude-')) return t.replace(/\./g, '-')
  return t
}

/** Match a known model token at an alnum boundary anywhere in a string. */
function findJetBrainsModelToken(s: string): string {
  for (const token of JETBRAINS_MODEL_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // "o3" etc. must not match inside words like "iso3166".
    if (new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(s)) {
      return normalizeJetBrainsModelName(token)
    }
  }
  return ''
}

/** Recover a model from a raw buffer by scanning for a known token. */
function inferJetBrainsModel(raw: string): string {
  return findJetBrainsModelToken(raw)
}

/**
 * Every directory a `file://` reference in this store could resolve to. The host
 * resolves each to a git repo root and hands the map back to the decoder, which
 * consults it instead of touching the filesystem.
 */
export function collectJetBrainsRepoDirCandidates(raw: string): string[] {
  const dirs = new Set<string>()
  const TAIL = /^\/[^"\\]+?(?=\\|")/
  let from = 0
  for (;;) {
    const at = raw.indexOf('file://', from)
    if (at === -1) break
    from = at + 7
    const m = TAIL.exec(raw.slice(from))
    if (!m) continue
    let p = m[0]
    try { p = decodeURIComponent(p) } catch { /* leave as-is */ }
    const dir = p.slice(0, p.lastIndexOf('/'))
    if (dir.startsWith('/')) dirs.add(dir)
  }
  return [...dirs]
}

/**
 * Infer the project (repository name) from the file:// URIs a chat referenced.
 *
 * The JetBrains store has no workspace/cwd record, and there is no reliable
 * marker inside a path for where the repo root sits (users nest repos under
 * arbitrary container dirs). So for each referenced file we walk UP the real
 * filesystem to the nearest ancestor containing a `.git` entry and use that
 * directory's basename — the true repo root. This is the one approach that
 * yields a clean, consistent name (e.g. `my-service`) instead of a deep subdir
 * or an inconsistent prose-scraped guess.
 *
 * Returns undefined when the chat referenced no files or none resolve to a repo
 * that still exists on disk (caller then falls back to a generic bucket).
 */
function inferJetBrainsProject(raw: string, repoRootByDir: ReadonlyMap<string, string>): string | undefined {
  // Capture referenced absolute paths (original case — we hit the real FS).
  const re = /file:\/\/(\/[^"\\]+?)(?:\\|")/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    // Decode %20 etc. and strip a trailing .rej/.orig suffix noise; keep the dir.
    let p = m[1]
    try { p = decodeURIComponent(p) } catch { /* leave as-is */ }
    const dir = p.slice(0, p.lastIndexOf('/'))
    if (dir.startsWith('/')) seen.add(dir)
  }
  if (seen.size === 0) return undefined

  for (const dir of seen) {
    const repo = repoRootByDir.get(dir)
    if (repo) return repo
  }
  return undefined
}

/**
 * Recover the conversation (chat-tab) records from a raw .db buffer. Each is
 * stored as `$<GUID> … name … value <title> … source copilot`. Returns the
 * GUID→title map so turns can be grouped back to the tab the user sees.
 */
function extractJetBrainsConversations(raw: string): JBConversation[] {
  // A conversation's title EVOLVES as the user chats: it starts as "New Agent
  // Session", may pass through an auto-generated name, and ends at the final
  // title shown in the UI. The same `$<GUID> … name … value <title> … source`
  // record is rewritten each time, so we collect every occurrence per GUID and
  // keep the LAST meaningful (non-default) one.
  const DEFAULT_TITLES = new Set(['New Agent Session', 'New Session', 'New Chat'])
  const byId = new Map<string, string>()
  const re = /\$([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\s\S]{0,8}name/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const id = m[1]
    const window = raw.slice(m.index, m.index + 400)
    // The title is the Java-UTF string between the `value` marker and `source`.
    const tm = window.match(/value.{1,6}?([\x20-\x7e]{3,80}?)t\x00\x06source/)
    if (!tm) continue
    const title = Buffer.from(tm[1].replace(/^[^A-Za-z0-9]*/, ''), 'latin1').toString('utf8').trim()
    if (!title) continue
    // Keep the latest non-default title; only fall back to a default if no
    // meaningful title has been seen for this conversation yet.
    const existing = byId.get(id)
    if (existing && !DEFAULT_TITLES.has(existing) && DEFAULT_TITLES.has(title)) continue
    byId.set(id, title)
  }
  return [...byId.entries()].map(([id, title]) => ({ id, title }))
}

/** Brace-match a JSON object starting at `start`, tolerating escaped quotes. */
function matchJsonObject(raw: string, start: number): { chunk: string; end: number } {
  let depth = 0
  let inStr = false
  let esc = false
  let i = start
  for (; i < raw.length; i++) {
    const c = raw[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { i++; break } }
  }
  return { chunk: raw.slice(start, i), end: i }
}

/**
 * Recover the assistant reply text from a `__first__`/Subgraph response blob.
 *
 * JetBrains Copilot has two turn shapes, both handled here:
 *
 *  - **Ask mode:** the reply is a `Markdown` record whose `data` is an escaped
 *    JSON document `{"text":"…","annotations":…}`.
 *  - **Agent mode** (e.g. PyCharm agent sessions): the reply is the `reply`
 *    field of an `AgentRound` record `{"roundId":N,"reply":"…","toolCalls":[…]}`.
 *    In agent mode the `Markdown` records hold the USER's prompts, not the
 *    reply, so we must NOT read them — the assistant output is the AgentRound
 *    reply.
 *
 * Both are read STRUCTURALLY rather than by fully unescaping the blob (which
 * would strip the reply's own quotes and make regex extraction ambiguous): we
 * locate each `data`/`reply` value, read it as a properly-delimited JSON-string
 * literal (honouring escaping), unescape one level, and `JSON.parse` to reach
 * the text. We unescape the blob one level at a time and extract at the first
 * depth that yields text, never accumulating across depths (which would union a
 * quote-truncated half-unescaped capture with the full one and garble the
 * reply, inflating the token/cost estimate).
 *
 * Steps/error/progress-only blobs (no Markdown text and no AgentRound reply)
 * yield '' and are billed as $0 upstream.
 */
function extractResponseText(blob: string): string {
  let s = blob
  for (let depth = 0; depth < 8; depth++) {
    // Decide the mode by the PRESENCE of an AgentRound record, not by whether it
    // yielded a reply. In agent mode the Markdown record holds the USER prompt,
    // so an agent blob whose reply is empty (a failed turn, or a pure tool-call
    // round) must NOT fall back to Markdown — that would bill the user's prompt
    // as the assistant's output. Ask-mode blobs have no AgentRound record and
    // use Markdown. (Verified across every observed store: the two reply shapes
    // never coexist in one blob, so this mode split is unambiguous.)
    const isAgentMode = /"type":"AgentRound"/.test(s)
    if (isAgentMode || /"type":"Markdown"/.test(s)) {
      const decoded = isAgentMode ? extractAgentRoundReplies(s) : extractMarkdownTexts(s)
      // The .db is read as latin1 (byte-stable), so multibyte UTF-8 characters
      // are split into separate code units. Re-interpret as UTF-8 so the char
      // count (→ token estimate) reflects real content length, not byte count.
      // decoded may be empty (failed/tool-only agent turn) → '' (billed $0).
      return Buffer.from(decoded.join('\n').trim(), 'latin1').toString('utf8')
    }
    // Not yet at the depth where record markers appear bare — unescape one level
    // in a single left-to-right pass so `\\` and `\"` resolve together (a
    // two-pass replace would turn `\\"` into `\"` not `\\` + `"`).
    const next = s.replace(/\\([\\"])/g, '$1')
    if (next === s) break
    s = next
  }
  return ''
}

/**
 * Collect the `text` of every `Markdown` record in `s`, treating each record's
 * `data` value as a one-level-escaped JSON string parsed structurally (so the
 * reply's own quotes never truncate it). Returns [] if `s` is not yet at the
 * right unescape depth (no bare `"type":"Markdown"` with a parseable `data`).
 * Scoping to Markdown skips `Error` (`message`) and `Steps` records — not
 * billable output. Revisions repeat a reply, so identical texts are de-duped.
 */
function extractMarkdownTexts(s: string): string[] {
  return extractRecordStrings(s, '"type":"Markdown"', '"data":"', 'text')
}

/**
 * Collect the non-empty `reply` of every `AgentRound` record (agent mode). A
 * single blob can hold several rounds (a multi-turn agent session); each round's
 * `reply` is the assistant's text for that step (empty on pure tool-call rounds).
 * Deduped in order.
 */
function extractAgentRoundReplies(s: string): string[] {
  return extractRecordStrings(s, '"type":"AgentRound"', '"data":"', 'reply')
}

/**
 * Shared structural reader: for every `<marker>` in `s`, find the following
 * `<dataKey>` string literal (a one-level-escaped JSON document), parse it, and
 * collect `doc[field]` when it is a non-empty string. Reading the value as a
 * delimited literal — not a greedy regex — means the payload's own quotes never
 * truncate it. Returns [] when `s` is not yet at the depth where the marker
 * appears bare with a parseable payload. De-dupes in order (the store keeps
 * byte-copies/revisions of each reply).
 */
function extractRecordStrings(s: string, marker: string, dataKey: string, field: string): string[] {
  const texts: string[] = []
  const seen = new Set<string>()
  const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const dk = s.indexOf(dataKey, m.index)
    if (dk === -1 || dk - m.index > 200) continue
    // The value runs from after `<dataKey>` to the first UNescaped quote (an odd
    // run of preceding backslashes escapes it).
    const start = dk + dataKey.length
    let i = start
    for (; i < s.length; i++) {
      if (s[i] !== '"') continue
      let bs = 0
      for (let j = i - 1; j >= start && s[j] === '\\'; j--) bs++
      if (bs % 2 === 0) break
    }
    const literal = s.slice(start, i)
    try {
      // Wrapping in quotes + parsing unescapes exactly one level → the inner
      // JSON document as a string; parsing THAT reaches { <field>, … }.
      const doc = JSON.parse(JSON.parse('"' + literal + '"') as string) as Record<string, unknown>
      const text = typeof doc[field] === 'string' ? (doc[field] as string) : ''
      if (text && !seen.has(text)) {
        seen.add(text)
        texts.push(text)
      }
    } catch {
      // Not the right depth (or not a matching record) — skip.
    }
  }
  return texts
}

const CHARS_PER_TOKEN = 4
function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Extract assistant turns from a raw (latin1) Nitrite .db buffer. Each turn is
 * one `{"__first__":{"type":"Subgraph"…}` blob; the per-turn model is recovered
 * from inside the blob when present, else the whole-store default. Each turn is
 * grouped back to its owning conversation (chat tab) by the nearest preceding
 * conversation GUID. Duplicate byte-copies of the same reply (the store keeps
 * several) are de-duplicated by content, per conversation.
 */
function extractJetBrainsDbTurns(raw: string, repoRootByDir: ReadonlyMap<string, string>): JBDbTurn[] {
  const conversations = extractJetBrainsConversations(raw)
  // Precompute the byte offset of each conversation GUID's full form so a turn
  // can be attributed to the conversation whose id most recently precedes it.
  const convById = new Map(conversations.map((c) => [c.id, c]))

  const turns: JBDbTurn[] = []
  const seenReplies = new Set<string>() // keyed by `${conversationId}::${reply}`
  const re = /\{"__first__":\{"type":"Subgraph"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const { chunk, end } = matchJsonObject(raw, m.index)
    re.lastIndex = end

    // Attribute this turn to the conversation whose GUID last appears before it.
    let conversationId = ''
    let conversationTitle = ''
    let bestPos = -1
    for (const c of convById.values()) {
      const p = raw.lastIndexOf(c.id, m.index)
      if (p > bestPos) {
        bestPos = p
        conversationId = c.id
        conversationTitle = c.title
      }
    }

    const replyText = extractResponseText(chunk)
    // The files this turn referenced (home-relative common dir) → project label.
    const conversationProject = inferJetBrainsProject(chunk, repoRootByDir) ?? ''
    // A per-turn model token sometimes appears inside the blob.
    const model = findJetBrainsModelToken(chunk)
    // A failed turn carries an error status / phrase AND produces no reply text.
    // Requiring empty text avoids misclassifying a genuine reply that merely
    // *discusses* an error (e.g. explaining a stack trace) as a failed turn.
    const hasErrorMarker = /error occurred|"isError":true|\\+"status\\+":\\+"(?:error|failed)\\+"/i.test(chunk)
    if (hasErrorMarker && !replyText) {
      turns.push({ replyText: '', model, errored: true, conversationId, conversationTitle, conversationProject })
      continue
    }
    if (!replyText) continue // Steps/progress-only blob — no billable output
    const dedupeKey = `${conversationId}::${replyText}`
    if (seenReplies.has(dedupeKey)) continue
    seenReplies.add(dedupeKey)
    turns.push({ replyText, model, errored: false, conversationId, conversationTitle, conversationProject })
  }

  // ---------------------------------------------------------------------------
  // Fallback: old JetBrains Copilot plugin format (≤1.5.x, e.g. 1.5.59-243)
  // ---------------------------------------------------------------------------
  // In this format ALL session turns are stored inside ONE large outer Nitrite
  // document — a binary-framed JSON object with UUID-keyed Value entries — rather
  // than the per-turn {"__first__":{"type":"Subgraph",...}} blobs used by newer
  // plugins (≥1.12.x). The AgentRound entries sit one escaping level deeper
  // inside the outer document's string values, so `extractResponseText`'s
  // depth-unescape loop handles extraction correctly once we feed it the right
  // chunk. MVStore keeps two identical copies of the collection; `seenReplies`
  // deduplicates them automatically.
  //
  // Detection heuristic: the __first__/Subgraph path produced no turns AND the
  // raw file contains bare 'AgentRound' text (meaning old-format data is present).
  if (turns.length === 0 && raw.includes('AgentRound')) {
    // The outer Nitrite document is preceded by a single binary framing byte
    // (0x81 in practice, but any non-printable/non-ASCII byte in MVStore).
    // It starts with a UUID-keyed Value entry: {"<uuid>":{"type":"Value",...}}.
    // Hex is matched case-insensitively — an uppercase UUID must not cause the
    // whole session to fall through to $0 (the exact bug this path fixes).
    const outerDocRe = /[\x00-\x1f\x7f-\xff]\{"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}":\{"type":"Value"/g
    let dm: RegExpExecArray | null
    while ((dm = outerDocRe.exec(raw))) {
      // Skip the leading binary byte; matchJsonObject starts at the '{'.
      const docStart = dm.index + 1
      const { chunk, end } = matchJsonObject(raw, docStart)
      outerDocRe.lastIndex = end

      // Skip documents that contain no AgentRound data (e.g. empty sessions).
      if (!chunk.includes('AgentRound')) continue

      // Attribute to the conversation whose GUID most recently precedes this doc.
      let conversationId = ''
      let conversationTitle = ''
      let bestPos = -1
      for (const c of convById.values()) {
        const p = raw.lastIndexOf(c.id, docStart)
        if (p > bestPos) {
          bestPos = p
          conversationId = c.id
          conversationTitle = c.title
        }
      }

      // extractResponseText handles the depth-1 unescape needed to surface the
      // AgentRound records, then calls extractAgentRoundReplies for each turn.
      // Because the outer document holds ALL turns in one blob we get back a
      // single joined string; split it on the '\n' join to yield per-turn texts.
      const allReplies = extractResponseText(chunk)
      if (!allReplies) continue

      const conversationProject = inferJetBrainsProject(chunk, repoRootByDir) ?? ''
      const storeModel = findJetBrainsModelToken(chunk)

      // extractResponseText joins multiple replies with '\n'. Since individual
      // replies can themselves span multiple lines we cannot cleanly split here —
      // instead we emit one ParsedProviderCall per outer document (one session).
      const dedupeKey = `${conversationId}::${allReplies}`
      if (seenReplies.has(dedupeKey)) continue
      seenReplies.add(dedupeKey)

      turns.push({
        replyText: allReplies,
        model: storeModel,
        errored: false,
        conversationId,
        conversationTitle,
        conversationProject,
      })
    }
  }

  // A project derived from ANY turn of a conversation applies to all its turns
  // (the files are usually referenced in the first substantive turn only).
  const projByConv = new Map<string, string>()
  for (const t of turns) {
    if (t.conversationProject && !projByConv.has(t.conversationId)) {
      projByConv.set(t.conversationId, t.conversationProject)
    }
  }
  for (const t of turns) {
    if (!t.conversationProject) t.conversationProject = projByConv.get(t.conversationId) ?? ''
  }

  return turns
}

// ---------------------------------------------------------------------------
// Decoder entry point and per-arm helpers
// ---------------------------------------------------------------------------

export type CopilotDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}
export type CopilotDecodeResult = {
  calls: CopilotDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

function pushCall(calls: CopilotDecodedCall[], arm: CopilotCallArm, base: Omit<CopilotDecodedCall, 'arm'>): void {
  calls.push({ arm, ...base } as CopilotDecodedCall)
}

function decodeJsonl(envelope: Extract<CopilotRecordEnvelope, { kind: 'jsonl' }>, seen: Set<string>, calls: CopilotDecodedCall[]): void {
  const sessionId = envelope.sessionId
  const lines = envelope.lines

  // Detect VS Code transcript format: the first session.start event has
  // { producer: 'copilot-agent' } and no outputTokens in messages.
  let isTranscript = false
  let currentModel = ''
  let pendingUserMessage = ''
  // Track the active subagent for this session (from subagent.selected events).
  // Resets when a new subagent is selected.
  let currentSubagentType: string | undefined

  // First pass: detect format and infer transcript model if needed.
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as CopilotEvent
      if (ev.type === 'session.start') {
        const data = ev.data as SessionStartData & { producer?: string }
        if (data.producer === 'copilot-agent') {
          isTranscript = true
        }
        break
      }
      if (ev.type === 'session.model_change') break // regular format
    } catch {
      continue
    }
  }

  if (isTranscript) {
    currentModel = inferTranscriptModel(lines)
    if (!currentModel) return // no toolCallIds to infer model from
  }

  // Shutdown rollups may lack their own timestamp; remember the last
  // stamped event so the supplementary call is never left with an empty
  // timestamp, which the date-range filters silently drop.
  let lastEventTimestamp = ''

  for (const line of lines) {
    let event: CopilotEvent
    try {
      event = JSON.parse(line) as CopilotEvent
    } catch {
      continue
    }
    if (typeof event.timestamp === 'string' && event.timestamp) lastEventTimestamp = event.timestamp

    if (event.type === 'session.start') {
      if (!isTranscript) {
        currentModel = (event.data as SessionStartData).selectedModel ?? currentModel
      }
      continue
    }

    if (event.type === 'session.model_change') {
      currentModel = (event.data as ModelChangeData).newModel ?? currentModel
      continue
    }

    if (event.type === 'subagent.selected') {
      currentSubagentType = (event.data as SubagentSelectedData).agentName
      continue
    }

    if (event.type === 'user.message') {
      pendingUserMessage = (event.data as UserMessageData).content ?? ''
      continue
    }

    if (event.type === 'session.shutdown') {
      // The Copilot CLI writes a per-model token/cost rollup here at
      // shutdown: the only place a CLI session records input, cache-read
      // and cache-write tokens (assistant.message events carry output
      // only). VS Code transcripts never carry this rollup, so this path
      // is gated to the CLI (non-transcript) format, leaving VS Code,
      // JetBrains and OTel sources untouched.
      //
      // We emit one supplementary call per model carrying ONLY the
      // input/cache tokens the per-turn events lack; output is excluded so
      // the assistant.message output (and its cost) is not double-counted.
      // Combined with the per-turn output cost, this yields the full,
      // CLI-measured session cost.
      if (isTranscript) continue
      const shutdownData = event.data as SessionShutdownData
      const modelMetrics = shutdownData.modelMetrics
      if (!isRecord(modelMetrics)) continue

      const shutdownTimestamp =
        (event.timestamp ?? '') || timestampToISO(shutdownData.sessionStartTime) || lastEventTimestamp

      for (const [model, metrics] of Object.entries(modelMetrics)) {
        if (!model || !isRecord(metrics)) continue
        const usage = metrics['usage']
        if (!isRecord(usage)) continue

        const cacheReadTokens = numberOrZero(usage['cacheReadTokens'])
        const cacheWriteTokens = numberOrZero(usage['cacheWriteTokens'])
        const reasoningTokens = numberOrZero(usage['reasoningTokens'])
        // usage.inputTokens is cache-INCLUSIVE (input + cache_read +
        // cache_write). calculateCost expects the uncached input alone with
        // cache tokens billed separately, so subtract the cache components.
        // Clamp at 0 in case a future schema reports input non-inclusively.
        const inputTokens = Math.max(
          0,
          numberOrZero(usage['inputTokens']) - cacheReadTokens - cacheWriteTokens
        )

        // Nothing this call would add over the per-turn events, so skip it
        // to avoid an empty $0 row (output is intentionally excluded).
        if (inputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) continue

        // The model component is normalized exactly as the observation
        // boundary normalizes `model`: the key ships on the envelope, so a
        // display-name or hostile model string from the JSONL must collapse
        // to 'unknown' inside the key, never ride it raw.
        const dedupKey = `copilot:${sessionId}:shutdown:${normalizeModelIdentifier(model)}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)

        pushCall(calls, 'jsonl-shutdown', {
          provider: 'copilot',
          sessionId,
          model,
          inputTokens,
          outputTokens: 0,
          cacheCreationInputTokens: cacheWriteTokens,
          cacheReadInputTokens: cacheReadTokens,
          cachedInputTokens: 0,
          reasoningTokens,
          webSearchRequests: 0,
          tools: [],
          rawBashCommands: [],
          timestamp: shutdownTimestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: '',
        })
      }
      continue
    }

    if (event.type === 'assistant.message') {
      const msgData = event.data as AssistantMessageData
      const { messageId, model: msgModel, outputTokens = 0 } = msgData
      const rawRequests = (msgData as { toolRequests?: unknown }).toolRequests
      const toolRequests = coerceToolRequests(rawRequests)

      // model may be carried per-message in newer copilot-agent format
      if (msgModel) currentModel = msgModel
      // Regular JSONL: skip zero-token messages; transcripts don't have tokens
      if (!isTranscript && outputTokens === 0) continue
      if (!currentModel) continue

      const dedupKey = `copilot:${sessionId}:${messageId}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      const tools = toolRequests
        .map((t) => {
          const raw = typeof t === 'object' && t !== null
            ? ((t as { name?: unknown; toolName?: unknown }).name ?? (t as { name?: unknown; toolName?: unknown }).toolName)
            : null
          return typeof raw === 'string' ? normalizeCopilotTool(raw) : null
        })
        .filter((t): t is string => t !== null)

      const skills = toolRequests.flatMap((t) => {
        if (typeof t !== 'object' || t === null) return []
        const name = (t.name ?? t.toolName) ?? ''
        if (name !== 'skill') return []
        const skill = t.arguments?.['skill']
        return typeof skill === 'string' && skill.trim().length > 0 ? [skill.trim()] : []
      })

      const rawBashCommands = toolRequests.flatMap((t) => {
        if (typeof t !== 'object' || t === null) return []
        const name = (t.name ?? t.toolName) ?? ''
        if (!BASH_TOOL_NAMES.has(name)) return []
        const cmd = t.arguments?.['command']
        return typeof cmd === 'string' ? [cmd] : []
      })

      // Copilot JSONL only logs outputTokens; inputTokens are NOT available.
      // Cost will be lower than actual API cost. This is the original
      // behaviour — OTel data (below) replaces it when available.

      pushCall(calls, 'jsonl-turn', {
        provider: 'copilot',
        sessionId,
        model: currentModel,
        inputTokens: 0,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        tools,
        rawBashCommands,
        skills: skills.length > 0 ? skills : undefined,
        subagentTypes: currentSubagentType ? [currentSubagentType] : undefined,
        timestamp: event.timestamp ?? '',
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: pendingUserMessage,
      })
      pendingUserMessage = ''
    }
  }
}

function decodeChatSession(envelope: Extract<CopilotRecordEnvelope, { kind: 'chatsession' }>, seen: Set<string>, calls: CopilotDecodedCall[]): void {
  const content = envelope.content
  const project = envelope.project
  const fallbackSessionId = envelope.fallbackSessionId

  const root = replayChatSessionJournal(content)
  if (!isRecord(root)) return

  const sessionId = readString(root['sessionId']) || fallbackSessionId
  const sessionCreatedAt = timestampToISO(root['creationDate'])
  const requests = Array.isArray(root['requests']) ? root['requests'] : []

  for (let index = 0; index < requests.length; index++) {
    const rawReq = requests[index]
    if (!isRecord(rawReq)) continue

    const result = rawReq['result']
    const resultRecord = isRecord(result) ? result : null
    const rawMetadata = resultRecord?.['metadata']
    const metadata = isRecord(rawMetadata) ? rawMetadata : createReplayObject()

    const inputTokens = numberOrZero(metadata['promptTokens'])
    const metadataOutputTokens = numberOrZero(metadata['outputTokens'])
    const outputTokens = metadataOutputTokens || numberOrZero(rawReq['completionTokens'])

    if (inputTokens === 0 && outputTokens === 0) continue

    const requestId = readString(rawReq['requestId']) || `request-${index}`
    const dedupKey = `copilot-chatsession:${sessionId}:${requestId}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const model = modelFromChatSessionRequest(rawReq, metadata)
    const timestamp = timestampToISO(rawReq['timestamp']) || sessionCreatedAt

    pushCall(calls, 'chatsession', {
      provider: 'copilot',
      sessionId,
      project,
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools: extractChatSessionTools(metadata),
      rawBashCommands: [],
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: '',
    })
  }
}

function decodeJetBrains(envelope: Extract<CopilotRecordEnvelope, { kind: 'jetbrains' }>, seen: Set<string>, calls: CopilotDecodedCall[]): void {
  const raw = envelope.raw
  const sessionId = envelope.sessionId
  const mtime = envelope.mtime
  const sourceProjectName = envelope.projectName

  const storeModel = inferJetBrainsModel(raw)
  const turns = extractJetBrainsDbTurns(raw, envelope.repoRootByDir)
  // Dedup keys derive from the reply CONTENT, not the scan position:
  // copilot is a durable provider (cached turns are never deleted and a
  // re-parse appends any key it hasn't seen), while MVStore compaction
  // can rewrite the file with blobs in a different byte order. With
  // positional keys, a rewrite that puts a new blob ahead of an old one
  // hands the new turn the old turn's key (skipped as seen) and re-emits
  // the old turn under a fresh index — double-billing it. The per-hash
  // counter keeps genuinely repeated replies and errored turns (which
  // share replyText '') distinct within a conversation.
  // Truncated unkeyed digest of reply text — a dedup identity, not a carrier:
  // the digest is bounded (12 hex chars) and one-way, so no reply content can
  // ship through this key, unlike a raw model or path. It stays unkeyed
  // because this arm receives no privacy key; threading one is tracked with
  // the copilot-bridge parity work (shape change, golden re-capture).
  const perContentIndex = new Map<string, number>()
  for (const turn of turns) {
    // One .db holds many chat tabs; group each turn under its own
    // conversation so the user sees one session per tab, not per file.
    const convId = turn.conversationId || sessionId
    const contentHash = createHash('sha256').update(turn.replyText).digest('hex').slice(0, 12)
    const nth = (perContentIndex.get(`${convId}:${contentHash}`) ?? 0) + 1
    perContentIndex.set(`${convId}:${contentHash}`, nth)
    const dedupKey = `copilot:jb:${convId}:${contentHash}:${nth}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    // Prefer the per-turn model, else the store default, else a generic
    // Copilot bucket so a real reply is never mis-priced as free.
    const model = turn.model || storeModel || 'copilot-anthropic-auto'
    // Errored turns (failed generation) contribute no billable output.
    const outputTokens = turn.errored ? 0 : estimateTokensFromChars(turn.replyText.length)
    // Project resolution precedence:
    //   1. projectName — the plugin's own recorded label (1.12+),
    //      joined across kind dirs by store id. Authoritative.
    //   2. the git repo root of a file:// path the chat referenced
    //      (older plugins / when projectName is absent).
    //   3. one honest bucket when neither signal exists.
    // The conversation TITLE is a chat-thread name, NOT a project, and is
    // kept out of `project` (it would otherwise pollute By-Project).
    const project = sourceProjectName || turn.conversationProject || 'copilot-jetbrains'

    pushCall(calls, 'jetbrains', {
      provider: 'copilot',
      sessionId: convId,
      project,
      model,
      inputTokens: 0,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools: [],
      rawBashCommands: [],
      timestamp: mtime,
      speed: 'standard',
      deduplicationKey: dedupKey,
      // Surface the chat-thread name here (it is the session's label, not
      // a project) so it remains visible in session-level views.
      userMessage: turn.conversationTitle,
    })
  }
}

function decodeOtel(envelope: Extract<CopilotRecordEnvelope, { kind: 'otel' }>, seen: Set<string>, calls: CopilotDecodedCall[]): void {
  for (const conversation of envelope.conversations) {
    const conversationId = conversation.conversationId
    const project = conversation.project

    // Collect tool names, shell commands and subagent names from the
    // execute_tool / invoke_agent spans for each trace. These mirror the
    // metadata the JSONL path captures, so the OTel source stays
    // equivalent (tools + bashCommands + subagentTypes are all first-class
    // call metadata per types.ts).
    //
    // Subagent attribution: VS Code records a subagent run as an
    // invoke_agent span carrying copilot_chat.parent_chat_session_id. The
    // root turn agent (gen_ai.agent.name = 'GitHub Copilot Chat') has NO
    // parent session and is intentionally excluded, otherwise it would
    // surface as a bogus 'GitHub Copilot Chat' entry in the agents view.
    // A subagent's invoke_agent span lives in the same trace as that
    // subagent's own chat spans, so attributing the agent name per-trace
    // labels exactly the subagent's calls.
    const toolsByTrace = new Map<string, string[]>()
    const bashByTrace = new Map<string, string[]>()
    const subagentsByTrace = new Map<string, string[]>()
    const chatSpanIds: string[] = []
    const spanMetaById = new Map<string, { trace_id: string; start_time_ms: number; response_model: string | null }>()
    // Stands in for the original's per-chat-span `loadSpanAttributesFromTable`
    // read: the host loaded each bag once, so a lookup by span id is the same bag.
    const attrsBySpanId = new Map<string, SpanAttributes>()

    for (const span of conversation.spans) {
      const opName = span.operationName
      spanMetaById.set(span.spanId, { trace_id: span.traceId, start_time_ms: span.startTimeMs, response_model: span.responseModel })
      if (span.attrs) attrsBySpanId.set(span.spanId, span.attrs)

      if (opName === 'chat') {
        chatSpanIds.push(span.spanId)
        continue
      }

      if (opName === 'execute_tool') {
        const attrs = span.attrs
        if (attrs) {
          const rawToolName = attrs['gen_ai.tool.name'] as string | undefined
          if (rawToolName) {
            const existing = toolsByTrace.get(span.traceId) ?? []
            existing.push(normalizeCopilotTool(rawToolName))
            toolsByTrace.set(span.traceId, existing)

            if (BASH_TOOL_NAMES.has(rawToolName)) {
              const command = parseToolCommand(attrs['gen_ai.tool.call.arguments'])
              if (command) {
                const bash = bashByTrace.get(span.traceId) ?? []
                bash.push(command)
                bashByTrace.set(span.traceId, bash)
              }
            }
          }
        }
        continue
      }

      if (opName === 'invoke_agent') {
        const attrs = span.attrs
        if (attrs) {
          const parentSession = attrs['copilot_chat.parent_chat_session_id']
          const agentName = attrs['gen_ai.agent.name'] as string | undefined
          if (parentSession && agentName) {
            const subs = subagentsByTrace.get(span.traceId) ?? []
            subs.push(agentName)
            subagentsByTrace.set(span.traceId, subs)
          }
        }
      }
    }

    // Yield one CopilotDecodedCall per chat span
    for (const spanId of chatSpanIds) {
      const spanMetadata = spanMetaById.get(spanId)
      if (!spanMetadata) continue

      const attrs = attrsBySpanId.get(spanId)

      const model =
        (attrs?.['gen_ai.response.model'] as string | undefined) ??
        (attrs?.['gen_ai.request.model'] as string | undefined) ??
        spanMetadata.response_model ??
        'unknown'

      const inputTokens = Number(attrs?.['gen_ai.usage.input_tokens'] ?? 0)
      const outputTokens = Number(attrs?.['gen_ai.usage.output_tokens'] ?? 0)
      const cacheReadTokens = Number(attrs?.['gen_ai.usage.cache_read.input_tokens'] ?? 0)
      const cacheCreationTokens = Number(attrs?.['gen_ai.usage.cache_creation.input_tokens'] ?? 0)

      if (inputTokens === 0 && outputTokens === 0) continue

      // Dedup key uses span_id which is globally unique
      const dedupKey = `copilot-otel:${spanId}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      // Also add a JSONL-style dedupKey pattern so that if the same
      // interaction appears in both OTel and JSONL, we don't double-count.
      // We use the turn ID from Copilot attributes if available.
      const turnId = attrs?.['github.copilot.chat.turn.id'] as string | undefined
      if (turnId) {
        const jsonlDedupKey = `copilot:${conversationId}:${turnId}`
        seen.add(jsonlDedupKey)
      }

      const tools = toolsByTrace.get(spanMetadata.trace_id) ?? []
      const rawBashCommands = bashByTrace.get(spanMetadata.trace_id) ?? []
      const subagentTypes = subagentsByTrace.get(spanMetadata.trace_id)
      const timestamp = epochToISO(spanMetadata.start_time_ms)

      pushCall(calls, 'otel', {
        provider: 'copilot',
        sessionId: conversationId,
        project,
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: cacheCreationTokens,
        cacheReadInputTokens: cacheReadTokens,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        tools,
        rawBashCommands,
        subagentTypes: subagentTypes && subagentTypes.length > 0 ? subagentTypes : undefined,
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: '',
      })
    }
  }
}

export function decodeCopilot(input: CopilotDecodeInput): CopilotDecodeResult {
  const seen = input.seenKeys ?? new Set<string>()
  const calls: CopilotDecodedCall[] = []
  const envelope = input.records[0] as CopilotRecordEnvelope | undefined
  if (!envelope) return { calls, diagnostics: [] }
  switch (envelope.kind) {
    case 'jsonl':       decodeJsonl(envelope, seen, calls); break
    case 'chatsession': decodeChatSession(envelope, seen, calls); break
    case 'jetbrains':   decodeJetBrains(envelope, seen, calls); break
    case 'otel':        decodeOtel(envelope, seen, calls); break
  }
  return { calls, diagnostics: [] }
}
