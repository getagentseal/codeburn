// =============================================================================
// copilot.ts — Modified CodeBurn Copilot provider
// =============================================================================
//
// WHAT CHANGED:
//   The original provider only reads Copilot's JSONL session-state files from
//   ~/.copilot/session-state/, which only log output tokens. Input tokens,
//   cache-read tokens, and cache-creation tokens are never written there, so
//   CodeBurn underreports Copilot costs by 60-80%.
//
//   This modified version adds VS Code sources that can carry fuller token
//   data: the OTel SQLite store (agent-traces.db), VS Code core chatSessions
//   journals, and legacy extension transcripts. OTel and chatSessions contain
//   input/output token breakdowns for Copilot Chat users; legacy JSONL remains
//   a fallback when richer sources are absent.
//
// HOW TO ENABLE THE OTEL SQLITE STORE:
//   TWO settings must both be enabled in VS Code settings.json:
//
//     {
//       "github.copilot.chat.otel.enabled": true,
//       "github.copilot.chat.otel.dbSpanExporter.enabled": true
//     }
//
//   The first enables the OTel pipeline; the second (defaults to false) enables
//   the SQLite span exporter that actually writes agent-traces.db.
//   After changing these settings, restart VS Code — the extension watches for
//   these changes and requires a reload to take effect.
//
//   Or set the environment variable before launching VS Code:
//
//     export COPILOT_OTEL_ENABLED=true
//
//   The DB file is created in VS Code's global storage directory:
//     ~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/agent-traces.db
//
// ENVIRONMENT VARIABLES:
//   CODEBURN_COPILOT_OTEL_DB    — Override the agent-traces.db path
//   CODEBURN_COPILOT_DISABLE_OTEL=1 — Skip OTel entirely, use only JSONL
//   CODEBURN_COPILOT_WS_STORAGE_DIR — Override VS Code workspaceStorage
//   CODEBURN_COPILOT_GLOBAL_STORAGE_DIR — Override VS Code globalStorage
//   CODEBURN_COPILOT_JETBRAINS_DIR — Override the JetBrains github-copilot root
//
// ARCHITECTURE:
//   discoverSessions() returns OTel sessions and legacy JSONL sessions. When
//   OTel is present, VS Code core chatSessions are skipped because they mirror
//   the same Copilot turns under different IDs. OTel sessions carry the full
//   token breakdown; JSONL sessions only carry output tokens (the original
//   behaviour, as a fallback).
//
// LIMITATIONS:
//   - The OTel DB only contains Copilot Chat and Agent mode spans. Inline
//     completions (ghost text) and Agent Host spans are NOT yet written to
//     this DB (see https://github.com/microsoft/vscode/issues/315901).
//   - The DB schema is inferred from the official OTel GenAI semantic
//     conventions and the Copilot Budget extension's approach. If VS Code
//     changes the schema, this parser will need updating.
// =============================================================================

import { readdir, stat } from 'fs/promises'
import { homedir, platform } from 'os'
import { join, basename, dirname, posix, win32 } from 'path'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { estimateTokens } from '../context-tree.js'
import type {
  Provider,
  SessionSource,
  SessionParser,
  ParsedProviderCall,
} from './types.js'

// ---------------------------------------------------------------------------
// Model display names (unchanged from original)
// ---------------------------------------------------------------------------
const modelDisplayNames: Record<string, string> = {
  'gpt-4.1-nano': 'GPT-4.1 Nano',
  'gpt-4.1-mini': 'GPT-4.1 Mini',
  'gpt-4.1': 'GPT-4.1',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5': 'GPT-5',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'copilot-openai-auto': 'Copilot (OpenAI auto)',
  'copilot-anthropic-auto': 'Copilot (Anthropic auto)',
}

// ---------------------------------------------------------------------------
// Tool name normalisation (unchanged from original, plus OTel tool names)
// ---------------------------------------------------------------------------
const toolNameMap: Record<string, string> = {
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
function normalizeTool(rawTool: string): string {
  const mapped = toolNameMap[rawTool]
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

const modelDisplayEntries = Object.entries(modelDisplayNames).sort(
  (a, b) => b[0].length - a[0].length
)

// Tool names that represent shell/bash execution. When the AI calls one of
// these, we extract the `arguments.command` string into bashCommands[].
const BASH_TOOL_NAMES = new Set(['bash', 'run_in_terminal', 'runInTerminal', 'runCommand'])

// ---------------------------------------------------------------------------
// Types for JSONL session state events (unchanged from original)
// ---------------------------------------------------------------------------
type ToolRequest = {
  toolName?: string  // older format
  name?: string      // newer format (copilot-agent)
  arguments?: Record<string, unknown>
}

type SessionStartData = {
  selectedModel?: string
}

type ModelChangeData = {
  newModel: string
  previousModel?: string
}

type UserMessageData = {
  content: string
  interactionId?: string
}

type AssistantMessageData = {
  messageId: string
  model?: string       // present in newer copilot-agent format
  outputTokens: number
  interactionId?: string
  toolRequests?: ToolRequest[]
}

type SubagentSelectedData = {
  agentName: string
  agentDisplayName?: string
  tools?: string[]
}

// Per-model usage rollup the CLI writes into session.shutdown. inputTokens is
// cache-INCLUSIVE (input + cache_read + cache_write); see the shutdown handler.
type ShutdownModelUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

type SessionShutdownData = {
  modelMetrics?: Record<string, { usage?: ShutdownModelUsage }>
  sessionStartTime?: number
}

type CopilotEvent =
  | { type: 'session.start'; data: SessionStartData; timestamp?: string }
  | { type: 'session.model_change'; data: ModelChangeData; timestamp?: string }
  | { type: 'user.message'; data: UserMessageData; timestamp?: string }
  | { type: 'assistant.message'; data: AssistantMessageData; timestamp?: string }
  | { type: 'subagent.selected'; data: SubagentSelectedData; timestamp?: string }
  | { type: 'session.shutdown'; data: SessionShutdownData; timestamp?: string }

type ChatJournalPathSegment = string | number
type ChatSessionRequest = Record<string, unknown>

// ---------------------------------------------------------------------------
// Types for OTel span rows from agent-traces.db
// ---------------------------------------------------------------------------

// The OTel SQLite store schema uses a spans table where attributes are stored
// either as a JSON blob or as individual columns. We handle both patterns.
// The Copilot Budget extension reads from this same DB and uses per-span
// token counts, confirming this schema is stable enough to depend on.

// Parsed attribute bag from a span
interface SpanAttributes {
  'gen_ai.operation.name'?: string
  'gen_ai.response.model'?: string
  'gen_ai.request.model'?: string
  'gen_ai.usage.input_tokens'?: number
  'gen_ai.usage.output_tokens'?: number
  'gen_ai.usage.cache_read.input_tokens'?: number
  'gen_ai.usage.cache_creation.input_tokens'?: number
  'gen_ai.conversation.id'?: string
  'gen_ai.agent.name'?: string
  'gen_ai.tool.name'?: string
  'gen_ai.tool.call.arguments'?: string
  'copilot_chat.parent_chat_session_id'?: string
  'github.copilot.chat.turn.id'?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getCopilotSessionStateDir(override?: string): string {
  return override ?? process.env['CODEBURN_COPILOT_SESSION_STATE_DIR'] ?? join(homedir(), '.copilot', 'session-state')
}

/**
 * Locate the agent-traces.db file.
 *
 * Priority:
 *   1. CODEBURN_COPILOT_OTEL_DB env var
 *   2. Platform-specific default VS Code global storage path
 *   3. VSCodium variant paths
 */
function getAgentTracesDbPath(): string | null {
  // Allow explicit override
  const envOverride = process.env['CODEBURN_COPILOT_OTEL_DB']
  if (envOverride) {
    return existsSync(envOverride) ? envOverride : null
  }

  const home = homedir()
  const candidates: string[] = []

  const p = platform()
  if (p === 'darwin') {
    // macOS: VS Code, VS Code Insiders, VSCodium
    candidates.push(
      join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  } else if (p === 'linux') {
    // Linux: VS Code, VS Code Insiders, VSCodium
    candidates.push(
      join(home, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  } else if (p === 'win32') {
    // Windows
    const appdata = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    candidates.push(
      join(appdata, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(appdata, 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(appdata, 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Locate the GitHub Copilot config root used by the JetBrains IDE plugin
 * (IntelliJ IDEA, PyCharm, RubyMine, …). The JetBrains Copilot agent persists
 * chat/agent sessions here — a location none of the VS Code or CLI sources
 * touch, so this is the only way JetBrains-driven Copilot usage becomes
 * visible to CodeBurn.
 *
 * The path mirrors the plugin's own `getXdgConfigPath` logic (observed in the
 * bundled copilot-agent language server):
 *   - $XDG_CONFIG_HOME/github-copilot (when set to an absolute path)
 *   - macOS / Linux: ~/.config/github-copilot
 *   - Windows:       %USERPROFILE%\AppData\Local\github-copilot
 *
 * Under this root, each IDE has its own subdir (e.g. `iu` for IntelliJ IDEA
 * Ultimate, `intellij` for the community edition) containing
 * chat-agent-sessions/, chat-sessions/, and chat-edit-sessions/.
 */
function getJetBrainsCopilotRoot(override?: string): string {
  const envOverride = override ?? process.env['CODEBURN_COPILOT_JETBRAINS_DIR']
  if (envOverride) return envOverride

  const xdg = process.env['XDG_CONFIG_HOME']
  if (xdg && (posix.isAbsolute(xdg) || win32.isAbsolute(xdg))) {
    return join(xdg, 'github-copilot')
  }

  if (platform() === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    return join(local, 'github-copilot')
  }

  return join(homedir(), '.config', 'github-copilot')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCwd(yaml: string): string | null {
  const match = yaml.match(/^cwd:\s*(.+)$/m)
  if (!match?.[1]) return null
  let raw = match[1].trim()
  // Strip inline YAML comments (# preceded by optional whitespace)
  raw = raw.replace(/\s*#.*$/, '')
  // Strip surrounding single/double quotes
  raw = raw.replace(/^['"]|['"]$/g, '').trim()
  return raw || null
}

/**
 * Load span attributes from the span_attributes table (key-value pairs).
 * This handles the modern VS Code Copilot Chat schema where attributes
 * are stored as separate key-value rows rather than a JSON blob.
 */
function loadSpanAttributesFromTable(
  db: ReturnType<typeof import('../sqlite.js')['openDatabase']>,
  spanId: string
): SpanAttributes {
  try {
    const rows = db.query<{ key: string; value: string | null }>(
      `SELECT key, value FROM span_attributes WHERE span_id = ?`,
      [spanId]
    )
    const attrs: SpanAttributes = {}
    for (const row of rows) {
      if (row.key && row.value) {
        try {
          // Try to parse numeric values
          const numValue = Number(row.value)
          attrs[row.key as keyof SpanAttributes] = Number.isNaN(numValue) 
            ? row.value
            : numValue
        } catch {
          attrs[row.key as keyof SpanAttributes] = row.value
        }
      }
    }
    return attrs
  } catch {
    return {}
  }
}

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
    if (typeof raw === 'string' && raw.trim()) names.add(normalizeTool(raw))
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

// Shell control-flow keywords. These lead a statement but are not commands, so
// they must never be reported as bash commands.
const OTEL_SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function', 'in', 'time', 'coproc',
])

/**
 * Normalise an OTEL shell command before command-name extraction.
 *
 * Unlike the Copilot CLI / VS Code JSONL logs — which record a single command
 * per tool call (e.g. `cd x && python3 y`) — the OTEL store records the FULL
 * multi-line script the agent ran (heredocs, for/if blocks, newline-separated
 * statements). The shared extractBashCommands helper only splits on `;`/`&&`/`|`
 * and has no concept of shell keywords, so those scripts leak control-flow words
 * (`for`, `do`, `if`, `then`, …) and collapse newline-separated statements.
 *
 * Normalising here — rather than in the shared helper — keeps every other
 * provider's behaviour unchanged. We (1) turn newlines into `;` so each
 * statement is its own segment, then (2) drop shell control-flow keywords.
 */
function extractOtelBashCommands(command: string): string[] {
  const normalized = command.replace(/\r?\n/g, '; ')
  return extractBashCommands(normalized).filter(c => !OTEL_SHELL_KEYWORDS.has(c))
}

// ---------------------------------------------------------------------------
// Helpers for JSONL / transcript parsing
// ---------------------------------------------------------------------------

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
// JSONL parser (handles both regular session-state events and VS Code
// transcript format via session.start { producer: 'copilot-agent' })
// ---------------------------------------------------------------------------

function createJsonlParser(
  source: SessionSource,
  seenKeys: Set<string>
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (!content) return
      const sessionId = basename(dirname(source.path))
      const lines = content.split('\n').filter((l) => l.trim())

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

            const dedupKey = `copilot:${sessionId}:shutdown:${model}`
            if (seenKeys.has(dedupKey)) continue
            seenKeys.add(dedupKey)

            // Tokens are real counts written by the CLI, so this cost is
            // measured, not char-estimated: costIsEstimated is false.
            const costUSD = calculateCost(model, inputTokens, 0, cacheWriteTokens, cacheReadTokens, 0)

            yield {
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
              costUSD,
              costIsEstimated: false,
              tools: [],
              bashCommands: [],
              timestamp: shutdownTimestamp,
              speed: 'standard' as const,
              deduplicationKey: dedupKey,
              userMessage: '',
            }
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
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const tools = toolRequests
            .map((t) => {
              const raw = typeof t === 'object' && t !== null
                ? ((t as { name?: unknown; toolName?: unknown }).name ?? (t as { name?: unknown; toolName?: unknown }).toolName)
                : null
              return typeof raw === 'string' ? normalizeTool(raw) : null
            })
            .filter((t): t is string => t !== null)

          const skills = toolRequests.flatMap((t) => {
            if (typeof t !== 'object' || t === null) return []
            const name = (t.name ?? t.toolName) ?? ''
            if (name !== 'skill') return []
            const skill = t.arguments?.['skill']
            return typeof skill === 'string' && skill.trim().length > 0 ? [skill.trim()] : []
          })

          // Extract base command names from bash-type tool requests, routing the
          // raw command through the shared extractBashCommands helper so chained
          // commands are normalised the same way as every other provider
          // (see bash-utils.ts, parser.ts, forge.ts, grok.ts, etc.).
          const bashCommands = toolRequests.flatMap((t) => {
            if (typeof t !== 'object' || t === null) return []
            const name = (t.name ?? t.toolName) ?? ''
            if (!BASH_TOOL_NAMES.has(name)) return []
            const cmd = t.arguments?.['command']
            return typeof cmd === 'string' ? extractBashCommands(cmd) : []
          })

          // Copilot JSONL only logs outputTokens; inputTokens are NOT available.
          // Cost will be lower than actual API cost. This is the original
          // behaviour — OTel data (below) replaces it when available.
          const costUSD = calculateCost(currentModel, 0, outputTokens, 0, 0, 0)

          yield {
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
            costUSD,
            tools,
            bashCommands,
            skills: skills.length > 0 ? skills : undefined,
            subagentTypes: currentSubagentType ? [currentSubagentType] : undefined,
            timestamp: event.timestamp ?? '',
            speed: 'standard' as const,
            deduplicationKey: dedupKey,
            userMessage: pendingUserMessage,
          }
          pendingUserMessage = ''
        }
      }
    },
  }
}

function createChatSessionParser(
  source: SessionSource,
  seenKeys: Set<string>
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (!content) return

      const root = replayChatSessionJournal(content)
      if (!isRecord(root)) return

      const sessionId = readString(root['sessionId']) || basename(source.path, '.jsonl')
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
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const model = modelFromChatSessionRequest(rawReq, metadata)
        const costUSD = calculateCost(model, inputTokens, outputTokens, 0, 0, 0)
        const timestamp = timestampToISO(rawReq['timestamp']) || sessionCreatedAt

        yield {
          provider: 'copilot',
          sessionId,
          project: source.project,
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools: extractChatSessionTools(metadata),
          bashCommands: [],
          timestamp,
          speed: 'standard' as const,
          deduplicationKey: dedupKey,
          userMessage: '',
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// JetBrains parser (Nitrite .db from ~/.config/github-copilot)
// ---------------------------------------------------------------------------
//
// The JetBrains Copilot plugin stores each chat/agent session in a Nitrite
// (H2 MVStore) .db of Java-serialized documents. There is NO token accounting
// anywhere in the store, so we estimate output tokens from the assistant reply
// text (the same char-count approach CodeBurn already uses for Cursor and
// legacy Copilot JSONL). Cost is therefore marked costIsEstimated.
//
// The model (e.g. "claude-opus-4.5", "gpt-4.1") is not always tagged on each
// turn, so we recover it by scanning the raw buffer for a known model token.

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
function inferJetBrainsProject(raw: string): string | undefined {
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
    const repo = findGitRepoRoot(dir)
    if (repo) return repo
  }
  return undefined
}

/** Walk up from `dir` to the nearest ancestor containing `.git`; return its basename. */
function findGitRepoRoot(dir: string): string | undefined {
  let cur = dir
  // Bound the walk to avoid pathological loops; repos are never this deep.
  for (let i = 0; i < 40 && cur && cur !== '/'; i++) {
    if (existsSync(join(cur, '.git'))) {
      const name = basename(cur)
      return name || undefined
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * Recover the plugin-recorded project label from a Nitrite .db.
 *
 * JetBrains Copilot 1.12+ serialises a `projectName` field on the session doc
 * (e.g. `my-service`, `codeburn`). It is the plugin's OWN authoritative
 * label — the JetBrains analogue of the OTel source's
 * `github.copilot.git.repository` — so it is preferred over the file-path
 * git-walk heuristic when present.
 *
 * The field is a Java-serialized string: the key bytes `projectName` are
 * followed immediately by TC_STRING framing `0x74 <u16 big-endian length>
 * <UTF-8 bytes>`. We read exactly `length` bytes (so an embedded newline or
 * quote can't truncate it) and accept the first occurrence whose value is a
 * plausible short, printable repo name. Older plugins that don't write the
 * field simply yield undefined (callers fall back to the git-walk).
 *
 * Note: the field lives on the session doc, which the plugin writes into the
 * `chat-sessions` / `chat-edit-sessions` stores — often NOT the
 * `chat-agent-sessions` store where the billable turns live. Discovery joins
 * the two by store id; see resolveJetBrainsProjectNames.
 */
function extractJetBrainsProjectName(raw: string): string | undefined {
  const re = /projectName\x74([\x00-\xff])([\x00-\xff])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const len = (m[1]!.charCodeAt(0) << 8) | m[2]!.charCodeAt(0)
    // Repo names are short; a huge length means we matched a schema/key
    // occurrence rather than a value-bearing one — skip it.
    if (len < 1 || len > 128) continue
    const start = m.index + m[0].length
    // The .db is read as latin1, so re-interpret the length-delimited bytes as
    // UTF-8 (repo names can contain non-ASCII). Reject only if the decoded value
    // holds control chars — a sign we matched a non-value occurrence, not a name.
    const val = Buffer.from(raw.slice(start, start + len), 'latin1').toString('utf8')
    // eslint-disable-next-line no-control-regex
    if (val.length > 0 && !/[\x00-\x1f]/.test(val)) return val
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Nitrite .db (H2 MVStore) extraction
// ---------------------------------------------------------------------------
//
// JetBrains Copilot sessions store their conversation in the Nitrite .db
// (copilot-*-nitrite.db). One .db holds many conversations. Assistant replies
// are stored as a distinct blob shape:
//
//   {"__first__":{"type":"Subgraph","value":"..."}, ...}
//
// which is more deeply escaped than the user-message value-maps. The reply text
// is recovered by progressive unescaping and collecting "text":"..." fields.
// Failed turns ("Sorry, an error occurred …") carry an error status and no reply
// text — they are detected and billed as $0.

// One assistant turn recovered from a .db.
type JBDbTurn = {
  replyText: string
  model: string
  errored: boolean
  // The owning conversation (chat tab): its internal GUID and title. One .db
  // holds many conversations; turns are grouped back to their tab by this id.
  conversationId: string
  conversationTitle: string
  // The file path this conversation referenced (home-relative common dir), or
  // '' if the chat touched no files. Used as the project label.
  conversationProject: string
}

// A conversation (chat tab) recovered from a .db: internal GUID → title.
type JBConversation = { id: string; title: string }

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

/**
 * Extract assistant turns from a raw (latin1) Nitrite .db buffer. Each turn is
 * one `{"__first__":{"type":"Subgraph"…}` blob; the per-turn model is recovered
 * from inside the blob when present, else the whole-store default. Each turn is
 * grouped back to its owning conversation (chat tab) by the nearest preceding
 * conversation GUID. Duplicate byte-copies of the same reply (the store keeps
 * several) are de-duplicated by content, per conversation.
 */
function extractJetBrainsDbTurns(raw: string): JBDbTurn[] {
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
    const conversationProject = inferJetBrainsProject(chunk) ?? ''
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

      const conversationProject = inferJetBrainsProject(chunk) ?? ''
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
// JetBrains parser: one ParsedProviderCall per assistant turn in the .db
// ---------------------------------------------------------------------------

function createJetBrainsParser(
  source: JetBrainsSessionSource,
  seenKeys: Set<string>
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const sessionId = source.sessionId

      // Nitrite .db (the store's authoritative session content). Read as latin1
      // so byte offsets are stable through the binary MVStore framing.
      if (source.dbPath) {
        let dbRaw: string | null = null
        try {
          dbRaw = await readSessionFile(source.dbPath, 'latin1')
        } catch {
          dbRaw = null
        }
        if (dbRaw) {
          const storeModel = inferJetBrainsModel(dbRaw)
          const turns = extractJetBrainsDbTurns(dbRaw)
          // Dedup keys derive from the reply CONTENT, not the scan position:
          // copilot is a durable provider (cached turns are never deleted and a
          // re-parse appends any key it hasn't seen), while MVStore compaction
          // can rewrite the file with blobs in a different byte order. With
          // positional keys, a rewrite that puts a new blob ahead of an old one
          // hands the new turn the old turn's key (skipped as seen) and re-emits
          // the old turn under a fresh index — double-billing it. The per-hash
          // counter keeps genuinely repeated replies and errored turns (which
          // share replyText '') distinct within a conversation.
          const perContentIndex = new Map<string, number>()
          for (const turn of turns) {
            // One .db holds many chat tabs; group each turn under its own
            // conversation so the user sees one session per tab, not per file.
            const convId = turn.conversationId || sessionId
            const contentHash = createHash('sha256').update(turn.replyText).digest('hex').slice(0, 12)
            const nth = (perContentIndex.get(`${convId}:${contentHash}`) ?? 0) + 1
            perContentIndex.set(`${convId}:${contentHash}`, nth)
            const dedupKey = `copilot:jb:${convId}:${contentHash}:${nth}`
            if (seenKeys.has(dedupKey)) continue
            seenKeys.add(dedupKey)

            // Prefer the per-turn model, else the store default, else a generic
            // Copilot bucket so a real reply is never mis-priced as free.
            const model = turn.model || storeModel || 'copilot-anthropic-auto'
            // Errored turns (failed generation) contribute no billable output.
            const outputTokens = turn.errored ? 0 : estimateTokens(turn.replyText)
            const costUSD = outputTokens > 0 ? calculateCost(model, 0, outputTokens, 0, 0, 0) : 0
            // Project resolution precedence:
            //   1. projectName — the plugin's own recorded label (1.12+),
            //      joined across kind dirs by store id. Authoritative.
            //   2. the git repo root of a file:// path the chat referenced
            //      (older plugins / when projectName is absent).
            //   3. one honest bucket when neither signal exists.
            // The conversation TITLE is a chat-thread name, NOT a project, and is
            // kept out of `project` (it would otherwise pollute By-Project).
            const project =
              source.projectName || turn.conversationProject || 'copilot-jetbrains'

            yield {
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
              costUSD,
              costIsEstimated: true,
              tools: [],
              bashCommands: [],
              timestamp: source.mtime,
              speed: 'standard' as const,
              deduplicationKey: dedupKey,
              // Surface the chat-thread name here (it is the session's label, not
              // a project) so it remains visible in session-level views.
              userMessage: turn.conversationTitle,
            }
          }
        }
      }

    },
  }
}

// ---------------------------------------------------------------------------
// OTel SQLite parser — reads agent-traces.db for FULL token data
// ---------------------------------------------------------------------------

function createOtelParser(
  source: SessionSource,
  seenKeys: Set<string>
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // Lazy-load the SQLite module (same pattern as Cursor/OpenCode providers)
      const { openDatabase } = await import('../sqlite.js')

      // One DB open handles ALL conversations — avoids N opens for N conversations.
      const db = openDatabase(source.path)

      try {
        // ---------------------------------------------------------------
        // Get all distinct conversations in the DB with their project names.
        // ---------------------------------------------------------------
        const conversationRows = db.query<{
          conversation_id: string
          project: string | null
          min_start: number
        }>(
          `SELECT DISTINCT
             sa_conv.value AS conversation_id,
             COALESCE(sa_repo.value, 'copilot-chat') AS project,
             MIN(s.start_time_ms) AS min_start
           FROM spans s
           LEFT JOIN span_attributes sa_conv
             ON s.span_id = sa_conv.span_id AND sa_conv.key = 'gen_ai.conversation.id'
           LEFT JOIN span_attributes sa_repo
             ON s.span_id = sa_repo.span_id AND sa_repo.key = 'github.copilot.git.repository'
           WHERE sa_conv.value IS NOT NULL
           GROUP BY sa_conv.value
           ORDER BY min_start DESC`
        )

        for (const convRow of conversationRows) {
          const conversationId = convRow.conversation_id
          if (!conversationId) continue

          let project = convRow.project ?? 'copilot-chat'
          if (project.includes('/')) {
            project = basename(project.replace(/\.git$/, ''))
          }

          // -----------------------------------------------------------
          // Query all 'chat' spans for this conversation.
          // -----------------------------------------------------------

          const spanIdRows = db.query<{ span_id: string; trace_id: string }>(
            `SELECT DISTINCT s.span_id, s.trace_id
             FROM spans s
             INNER JOIN span_attributes sa 
               ON s.span_id = sa.span_id AND sa.key = 'gen_ai.conversation.id' AND sa.value = ?
             ORDER BY s.start_time_ms ASC`,
            [conversationId]
          )

          // Collect trace IDs and span IDs belonging to this conversation
          const traceIds = new Set<string>()
          for (const row of spanIdRows) {
            traceIds.add(row.trace_id)
          }

          if (traceIds.size === 0) {
            continue
          }

          // Now query all spans within those traces to find chat and tool spans.
          // Pull the metadata columns in the same query so we don't re-query the
          // spans table once per chat span below (avoids an N+1).
          const traceIdArr = [...traceIds]
          const tracePlaceholders = traceIdArr.map(() => '?').join(',')
          const traceSpans = db.query<{
            span_id: string
            trace_id: string
            operation_name: string | null
            start_time_ms: number
            response_model: string | null
          }>(
            `SELECT span_id, trace_id, operation_name, start_time_ms, response_model FROM spans WHERE trace_id IN (${tracePlaceholders})`,
            traceIdArr
          )

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

          for (const span of traceSpans) {
            const opName = span.operation_name || ''
            spanMetaById.set(span.span_id, span)

            if (opName === 'chat') {
              chatSpanIds.push(span.span_id)
              continue
            }

            if (opName === 'execute_tool') {
              // Load tool name from attributes and normalise to display form
              const attrs = loadSpanAttributesFromTable(db, span.span_id)
              const rawToolName = attrs['gen_ai.tool.name'] as string | undefined
              if (rawToolName) {
                const existing = toolsByTrace.get(span.trace_id) ?? []
                existing.push(normalizeTool(rawToolName))
                toolsByTrace.set(span.trace_id, existing)

                // For shell tools, extract command names via the OTEL-specific
                // normaliser (handles the full multi-line scripts the OTEL store
                // records; see extractOtelBashCommands).
                if (BASH_TOOL_NAMES.has(rawToolName)) {
                  const command = parseToolCommand(attrs['gen_ai.tool.call.arguments'])
                  if (command) {
                    const bash = bashByTrace.get(span.trace_id) ?? []
                    bash.push(...extractOtelBashCommands(command))
                    bashByTrace.set(span.trace_id, bash)
                  }
                }
              }
              continue
            }

            // Genuine subagent invocation: an invoke_agent span with a parent
            // chat session. The root turn agent ('GitHub Copilot Chat') has no
            // parent session and is skipped to avoid a bogus agents-view entry.
            if (opName === 'invoke_agent') {
              const attrs = loadSpanAttributesFromTable(db, span.span_id)
              const parentSession = attrs['copilot_chat.parent_chat_session_id']
              const agentName = attrs['gen_ai.agent.name'] as string | undefined
              if (parentSession && agentName) {
                const subs = subagentsByTrace.get(span.trace_id) ?? []
                subs.push(agentName)
                subagentsByTrace.set(span.trace_id, subs)
              }
            }
          }

          // Yield one ParsedProviderCall per chat span
          for (const spanId of chatSpanIds) {
            const attrs = loadSpanAttributesFromTable(db, spanId)

            const spanMetadata = spanMetaById.get(spanId)
            if (!spanMetadata) continue

            const model =
              (attrs['gen_ai.response.model'] as string | undefined) ??
              (attrs['gen_ai.request.model'] as string | undefined) ??
              spanMetadata.response_model ??
              'unknown'

            const inputTokens = Number(attrs['gen_ai.usage.input_tokens'] ?? 0)
            const outputTokens = Number(attrs['gen_ai.usage.output_tokens'] ?? 0)
            const cacheReadTokens = Number(attrs['gen_ai.usage.cache_read.input_tokens'] ?? 0)
            const cacheCreationTokens = Number(attrs['gen_ai.usage.cache_creation.input_tokens'] ?? 0)

            if (inputTokens === 0 && outputTokens === 0) {
              continue
            }

            // Dedup key uses span_id which is globally unique
            const dedupKey = `copilot-otel:${spanId}`
            if (seenKeys.has(dedupKey)) continue
            seenKeys.add(dedupKey)

            // Also add a JSONL-style dedupKey pattern so that if the same
            // interaction appears in both OTel and JSONL, we don't double-count.
            // We use the turn ID from Copilot attributes if available.
            const turnId = attrs['github.copilot.chat.turn.id'] as string | undefined
            if (turnId) {
              const jsonlDedupKey = `copilot:${conversationId}:${turnId}`
              seenKeys.add(jsonlDedupKey)
            }

            const tools = toolsByTrace.get(spanMetadata.trace_id) ?? []
            const bashCommands = bashByTrace.get(spanMetadata.trace_id) ?? []
            const subagentTypes = subagentsByTrace.get(spanMetadata.trace_id)
            const timestamp = epochToISO(spanMetadata.start_time_ms)

            // calculateCost with FULL token data — this is the key improvement.
            const costUSD = calculateCost(
              model,
              inputTokens,
              outputTokens,
              cacheCreationTokens,
              cacheReadTokens,
              0 // reasoningTokens — not exposed in current OTel schema
            )

            yield {
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
              costUSD,
              tools,
              bashCommands,
              subagentTypes: subagentTypes && subagentTypes.length > 0 ? subagentTypes : undefined,
              timestamp,
              speed: 'standard' as const,
              deduplicationKey: dedupKey,
              userMessage: '', // Not available in OTel spans by default
            }
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Extended SessionSource for OTel sessions
// ---------------------------------------------------------------------------

interface OTelSessionSource extends SessionSource {
  conversationId?: string
  sourceType: 'otel'
}

interface JsonlSessionSource extends SessionSource {
  sourceType: 'jsonl'
}

interface ChatSessionSource extends SessionSource {
  sourceType: 'chatsession'
}

interface JetBrainsSessionSource extends SessionSource {
  sourceType: 'jetbrains'
  // Fallback conversation id for turns whose own GUID can't be recovered (the
  // on-disk store dir name). Normally each turn is grouped by its own tab GUID.
  sessionId: string
  // On-disk store directory name — the join key for the projectName lookup
  // across sibling kind dirs (chat-sessions / chat-edit-sessions).
  storeId: string
  // Nitrite .db (copilot-*-nitrite.db) — the store's session content.
  dbPath: string
  // File mtime (ISO). The store has no reliable per-turn timestamp, so this
  // places every turn on a day — without it, calls fall outside date ranges.
  mtime: string
  // Plugin-recorded project label (JetBrains Copilot 1.12+), resolved across
  // all kind dirs by store id. The billable turns live in chat-agent-sessions,
  // but the projectName field is usually written only into the sibling
  // chat-sessions / chat-edit-sessions store, so discovery joins them by id.
  // Undefined for older plugins that don't record it.
  projectName?: string
}

function isOtelSource(source: SessionSource): source is OTelSessionSource {
  return (source as OTelSessionSource).sourceType === 'otel'
}

function isChatSessionSource(source: SessionSource): source is ChatSessionSource {
  return (source as ChatSessionSource).sourceType === 'chatsession'
}

function isJetBrainsSource(source: SessionSource): source is JetBrainsSessionSource {
  return (source as JetBrainsSessionSource).sourceType === 'jetbrains'
}

// ---------------------------------------------------------------------------
// Session discovery: JSONL (original)
// ---------------------------------------------------------------------------

async function discoverJsonlSessions(
  sessionStateDir: string
): Promise<JsonlSessionSource[]> {
  const sources: JsonlSessionSource[] = []

  let sessionDirs: string[]
  try {
    sessionDirs = await readdir(sessionStateDir)
  } catch {
    return sources
  }

  for (const sessionId of sessionDirs) {
    const eventsPath = join(sessionStateDir, sessionId, 'events.jsonl')
    const s = await stat(eventsPath).catch(() => null)
    if (!s?.isFile()) continue

    let project = sessionId
    try {
      const yaml = await readSessionFile(
        join(sessionStateDir, sessionId, 'workspace.yaml')
      )
      const cwd = parseCwd(yaml ?? '')
      if (cwd) project = basename(cwd)
    } catch {
      // workspace.yaml may not exist
    }

    sources.push({
      path: eventsPath,
      project,
      provider: 'copilot',
      sourceType: 'jsonl',
    })
  }

  return sources
}

// ---------------------------------------------------------------------------
// Session discovery: OTel SQLite
// ---------------------------------------------------------------------------

async function discoverOtelSessions(
  dbPath: string
): Promise<OTelSessionSource[]> {
  // Verify the DB file exists. Return one source per DB file; the parser
  // opens the DB once and iterates all conversations in a single DB open,
  // which is far more efficient than one source (and one DB open) per conversation.
  try {
    await stat(dbPath)
  } catch {
    return []
  }
  return [{ path: dbPath, project: 'copilot-chat', provider: 'copilot', sourceType: 'otel' }]
}

// ---------------------------------------------------------------------------
// Session discovery: JetBrains (IntelliJ IDEA, PyCharm, …)
// ---------------------------------------------------------------------------

// The three JetBrains Copilot session kinds (agent / ask / edit mode). Each
// store directory holds a Nitrite .db with that kind's session content.
const JETBRAINS_SESSION_KINDS = ['chat-agent-sessions', 'chat-sessions', 'chat-edit-sessions']

// Candidate Nitrite .db filenames per kind, plus a generic fallback.
const JETBRAINS_DB_NAMES: Record<string, string> = {
  'chat-agent-sessions': 'copilot-agent-sessions-nitrite.db',
  'chat-sessions': 'copilot-chat-nitrite.db',
  'chat-edit-sessions': 'copilot-edit-sessions-nitrite.db',
}

/** Locate the Nitrite .db in a store dir (known name, else any *-nitrite.db). */
async function findNitriteDbPath(storeDir: string, kind: string): Promise<string | null> {
  const known = JETBRAINS_DB_NAMES[kind]
  if (known) {
    const p = join(storeDir, known)
    if ((await stat(p).catch(() => null))?.isFile()) return p
  }
  let files: string[]
  try {
    files = await readdir(storeDir)
  } catch {
    return null
  }
  const db = files.find((f) => f.endsWith('-nitrite.db'))
  return db ? join(storeDir, db) : null
}

/**
 * Discover JetBrains Copilot sessions under the github-copilot config root.
 *
 * Layout: <root>/<ide>/<kind>/<storeId>/copilot-*-nitrite.db
 *   <ide>  — per-IDE dir (iu, intellij, PyCharm2025.2, …)
 *   <kind> — one of JETBRAINS_SESSION_KINDS
 *
 * Emits one source per store directory that has a Nitrite .db. The store
 * records no token counts, so the parser estimates output tokens from the
 * assistant reply text (see createJetBrainsParser).
 */
async function discoverJetBrainsSessions(
  root: string
): Promise<JetBrainsSessionSource[]> {
  const sources: JetBrainsSessionSource[] = []

  let ideDirs: string[]
  try {
    ideDirs = await readdir(root)
  } catch {
    return sources
  }

  for (const ide of ideDirs) {
    for (const kind of JETBRAINS_SESSION_KINDS) {
      const kindDir = join(root, ide, kind)
      let storeDirs: string[]
      try {
        storeDirs = await readdir(kindDir)
      } catch {
        continue // this IDE doesn't have this session kind
      }

      for (const storeId of storeDirs) {
        const storeDir = join(kindDir, storeId)
        const dbPath = await findNitriteDbPath(storeDir, kind)
        if (!dbPath) continue

        const dbStat = await stat(dbPath).catch(() => null)
        const mtime = (dbStat?.mtime ?? new Date(0)).toISOString()

        sources.push({
          path: dbPath,
          project: 'copilot-jetbrains',
          provider: 'copilot',
          sourceType: 'jetbrains',
          sessionId: storeId,
          storeId,
          dbPath,
          mtime,
        })
      }
    }
  }

  // Join projectName across kinds by store id. The plugin records the label on
  // the session doc, which usually lands in the chat-sessions/chat-edit-sessions
  // store — NOT the chat-agent-sessions store where the billable turns live.
  // Without this join, every current agent session falls to the generic bucket
  // even though its repo name is sitting one store dir over.
  await resolveJetBrainsProjectNames(sources)

  return sources
}

/**
 * Populate each source's `projectName` from whichever store dir (of the same
 * store id) actually recorded it. Reads each source's .db once; a store whose
 * own .db lacks the field inherits it from a sibling-kind store with the same
 * id. Best-effort — read/parse failures leave projectName undefined.
 */
async function resolveJetBrainsProjectNames(
  sources: JetBrainsSessionSource[]
): Promise<void> {
  const byStore = new Map<string, string>()
  for (const src of sources) {
    // Already found this store's name via a sibling-kind source — skip the read.
    if (!src.dbPath || byStore.has(src.storeId)) continue
    let raw: string | null = null
    try {
      raw = await readSessionFile(src.dbPath, 'latin1')
    } catch {
      raw = null
    }
    if (!raw) continue
    const name = extractJetBrainsProjectName(raw)
    if (name) byStore.set(src.storeId, name)
  }
  for (const src of sources) {
    const name = byStore.get(src.storeId)
    if (name) src.projectName = name
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Returns the VS Code workspaceStorage directories for all VS Code variants
 * (Code, Code Insiders, VSCodium) on the given platform. Used to discover
 * transcript sessions written by the Copilot Chat extension.
 *
 * Accepts explicit `home` and `os` arguments so callers (and tests) can pass
 * custom values without relying on process-level globals.
 */
export function getVSCodeWorkspaceStorageDirs(home: string, os: string): string[] {
  const j = os === 'win32' ? win32.join : posix.join
  if (os === 'darwin') {
    return [
      j(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
      j(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
      j(home, 'Library', 'Application Support', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  if (os === 'linux') {
    return [
      j(home, '.config', 'Code', 'User', 'workspaceStorage'),
      j(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
      j(home, '.config', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  // win32
  return [
    j(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
    j(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'workspaceStorage'),
    j(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'workspaceStorage'),
  ]
}

export function getVSCodeGlobalStorageDirs(home: string, os: string): string[] {
  const j = os === 'win32' ? win32.join : posix.join
  if (os === 'darwin') {
    return [
      j(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
      j(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage'),
      j(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage'),
    ]
  }
  if (os === 'linux') {
    return [
      j(home, '.config', 'Code', 'User', 'globalStorage'),
      j(home, '.config', 'Code - Insiders', 'User', 'globalStorage'),
      j(home, '.config', 'VSCodium', 'User', 'globalStorage'),
    ]
  }
  return [
    j(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
    j(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage'),
    j(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'globalStorage'),
  ]
}

async function resolveWorkspaceProject(wsDir: string, hashDir: string): Promise<string> {
  let project = hashDir
  try {
    const wsJson = await readSessionFile(join(wsDir, hashDir, 'workspace.json'))
    if (wsJson) {
      const data = JSON.parse(wsJson) as { folder?: string }
      if (typeof data.folder === 'string') {
        // folder is a URI like 'file:///home/user/myapp' or 'file:///C:/Users/...'
        const folder = data.folder.replace(/^file:\/\//, '').replace(/\/+$/, '')
        const name = basename(folder)
        if (name) project = name
      }
    }
  } catch {
    // workspace.json may be absent or malformed
  }
  return project
}

async function hasChatSessionFiles(chatSessionsDir: string): Promise<boolean> {
  let files: string[]
  try {
    files = await readdir(chatSessionsDir)
  } catch {
    return false
  }

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const s = await stat(join(chatSessionsDir, file)).catch(() => null)
    if (s?.isFile()) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Session discovery: VS Code core chatSessions
// ---------------------------------------------------------------------------

async function discoverWorkspaceChatSessions(
  workspaceStorageDirs: string[]
): Promise<ChatSessionSource[]> {
  const sources: ChatSessionSource[] = []

  for (const wsDir of workspaceStorageDirs) {
    let hashDirs: string[]
    try {
      hashDirs = await readdir(wsDir)
    } catch {
      continue
    }

    for (const hashDir of hashDirs) {
      const chatSessionsDir = join(wsDir, hashDir, 'chatSessions')
      let files: string[]
      try {
        files = await readdir(chatSessionsDir)
      } catch {
        continue
      }

      const project = await resolveWorkspaceProject(wsDir, hashDir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const path = join(chatSessionsDir, file)
        const s = await stat(path).catch(() => null)
        if (!s?.isFile()) continue
        sources.push({
          path,
          project,
          provider: 'copilot',
          sourceType: 'chatsession',
        })
      }
    }
  }

  return sources
}

async function discoverEmptyWindowChatSessions(
  globalStorageDirs: string[]
): Promise<ChatSessionSource[]> {
  const sources: ChatSessionSource[] = []

  for (const globalDir of globalStorageDirs) {
    const chatSessionsDir = join(globalDir, 'emptyWindowChatSessions')
    let files: string[]
    try {
      files = await readdir(chatSessionsDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(chatSessionsDir, file)
      const s = await stat(path).catch(() => null)
      if (!s?.isFile()) continue
      sources.push({
        path,
        project: 'copilot-chat',
        provider: 'copilot',
        sourceType: 'chatsession',
      })
    }
  }

  return sources
}

// ---------------------------------------------------------------------------
// Session discovery: VS Code workspace transcripts
// ---------------------------------------------------------------------------

/**
 * Discover Copilot Chat transcript sessions stored in VS Code workspaceStorage.
 * Structure: {wsDir}/{hash}/GitHub.copilot-chat/transcripts/{session}.jsonl
 * Project is read from {wsDir}/{hash}/workspace.json (folder URI).
 */
async function discoverTranscriptSessions(
  workspaceStorageDirs: string[]
): Promise<JsonlSessionSource[]> {
  const sources: JsonlSessionSource[] = []

  for (const wsDir of workspaceStorageDirs) {
    let hashDirs: string[]
    try {
      hashDirs = await readdir(wsDir)
    } catch {
      continue
    }

    for (const hashDir of hashDirs) {
      const chatSessionsDir = join(wsDir, hashDir, 'chatSessions')
      if (await hasChatSessionFiles(chatSessionsDir)) continue

      const transcriptsDir = join(wsDir, hashDir, 'GitHub.copilot-chat', 'transcripts')
      const project = await resolveWorkspaceProject(wsDir, hashDir)

      let transcriptFiles: string[]
      try {
        transcriptFiles = await readdir(transcriptsDir)
      } catch {
        continue
      }

      for (const file of transcriptFiles) {
        if (!file.endsWith('.jsonl')) continue
        const s = await stat(join(transcriptsDir, file)).catch(() => null)
        if (!s?.isFile()) continue
        sources.push({
          path: join(transcriptsDir, file),
          project,
          provider: 'copilot',
          sourceType: 'jsonl',
        })
      }
    }
  }

  return sources
}

export function createCopilotProvider(
  sessionStateDir?: string,
  workspaceStorageDir?: string,
  globalStorageDir?: string,
  jetbrainsDir?: string
): Provider {
  // jsonlDir is resolved lazily inside discoverSessions so that env-var
  // overrides set after module load (e.g. in tests) are respected.

  /**
   * Returns the workspaceStorage directories to scan for transcript sessions.
   * When workspaceStorageDir is explicitly provided (e.g. in tests), that single
   * directory is used. The CODEBURN_COPILOT_WS_STORAGE_DIR env var provides a
   * single-dir override (useful for tests). Otherwise all platform-default VS
   * Code variant paths are returned.
   */
  function getWsDirs(): string[] {
    if (workspaceStorageDir !== undefined) return [workspaceStorageDir]
    const envDir = process.env['CODEBURN_COPILOT_WS_STORAGE_DIR']
    if (envDir) return [envDir]
    return getVSCodeWorkspaceStorageDirs(homedir(), platform())
  }

  function getGlobalDirs(): string[] {
    if (globalStorageDir !== undefined) return [globalStorageDir]
    const envDir = process.env['CODEBURN_COPILOT_GLOBAL_STORAGE_DIR']
    if (envDir) return [envDir]
    return getVSCodeGlobalStorageDirs(homedir(), platform())
  }

  return {
    name: 'copilot',
    displayName: 'Copilot',
    durableSources: true,

    modelDisplayName(model: string): string {
      for (const [key, display] of modelDisplayEntries) {
        if (model.includes(key)) return display
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return normalizeTool(rawTool)
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []
      let discoveredOtel = false

      // 1. Discover OTel sessions (preferred — full token data)
      const disableOtel = process.env['CODEBURN_COPILOT_DISABLE_OTEL'] === '1'
      if (!disableOtel) {
        const dbPath = getAgentTracesDbPath()
        if (dbPath) {
          try {
            const otelSources = await discoverOtelSessions(dbPath)
            discoveredOtel = otelSources.length > 0
            sources.push(...otelSources)
          } catch {
            // OTel discovery failed — fall through to JSONL
          }
        }
      }

      // 2. Discover JSONL sessions (fallback — output tokens only)
      try {
        const jsonlDir = getCopilotSessionStateDir(sessionStateDir)
        const jsonlSources = await discoverJsonlSessions(jsonlDir)
        sources.push(...jsonlSources)
      } catch {
        // JSONL discovery failed
      }

      // Prefer OTel over chatSessions: they can mirror the same turns under
      // incompatible IDs, and OTel carries richer token/cache data.
      if (!discoveredOtel) {
        // 3. Discover VS Code core chatSessions journals
        try {
          const chatSessionSources = await discoverWorkspaceChatSessions(getWsDirs())
          sources.push(...chatSessionSources)
        } catch {
          // Workspace chatSessions discovery failed
        }

        // 4. Discover VS Code empty-window chatSessions journals
        try {
          const emptyWindowSources = await discoverEmptyWindowChatSessions(getGlobalDirs())
          sources.push(...emptyWindowSources)
        } catch {
          // Empty-window chatSessions discovery failed
        }
      }

      // 5. Discover VS Code workspace transcript sessions
      try {
        const transcriptSources = await discoverTranscriptSessions(getWsDirs())
        sources.push(...transcriptSources)
      } catch {
        // Transcript discovery failed
      }

      // 6. Discover JetBrains IDE sessions (IntelliJ, PyCharm, …). These live
      // in a store none of the VS Code / CLI sources touch, so there is no
      // overlap to dedupe against; the shared seenKeys set still guards it.
      try {
        const jetbrainsSources = await discoverJetBrainsSessions(
          getJetBrainsCopilotRoot(jetbrainsDir)
        )
        sources.push(...jetbrainsSources)
      } catch {
        // JetBrains discovery failed
      }

      return sources
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>
    ): SessionParser {
      // Route to the correct parser based on source type.
      // The dedup key set (seenKeys) is shared across both parsers,
      // so if OTel already yielded a span, the JSONL parser will skip
      // the matching assistant.message (and vice versa).
      if (isOtelSource(source)) {
        return createOtelParser(source, seenKeys)
      }
      if (isChatSessionSource(source)) {
        return createChatSessionParser(source, seenKeys)
      }
      if (isJetBrainsSource(source)) {
        return createJetBrainsParser(source, seenKeys)
      }
      return createJsonlParser(source, seenKeys)
    },
  }
}

// Default export for the provider registry
export const copilot = createCopilotProvider()
