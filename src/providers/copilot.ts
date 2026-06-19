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
//   This modified version adds a SECOND data source: VS Code Copilot Chat's
//   OTel SQLite store (agent-traces.db). When present, it contains full
//   per-LLM-call token breakdowns (input, output, cache_read, cache_creation)
//   from the OpenTelemetry GenAI semantic conventions. We prefer OTel data
//   when available and fall back to the original JSONL parsing.
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
//
// ARCHITECTURE:
//   discoverSessions() returns BOTH OTel sessions (one per conversation_id)
//   and JSONL sessions. The OTel sessions are deduped against JSONL by
//   conversation ID so we don't double-count. OTel sessions carry the full
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
import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
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
  read_file: 'Read',
  write_file: 'Edit',
  edit_file: 'Edit',
  delete_file: 'Delete',
  github_repo: 'GitHub',
  web_search: 'WebSearch',
  run_in_terminal: 'Shell',
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

type CopilotEvent =
  | { type: 'session.start'; data: SessionStartData; timestamp?: string }
  | { type: 'session.model_change'; data: ModelChangeData; timestamp?: string }
  | { type: 'user.message'; data: UserMessageData; timestamp?: string }
  | { type: 'assistant.message'; data: AssistantMessageData; timestamp?: string }
  | { type: 'subagent.selected'; data: SubagentSelectedData; timestamp?: string }

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

      for (const line of lines) {
        let event: CopilotEvent
        try {
          event = JSON.parse(line) as CopilotEvent
        } catch {
          continue
        }

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

function isOtelSource(source: SessionSource): source is OTelSessionSource {
  return (source as OTelSessionSource).sourceType === 'otel'
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
      const transcriptsDir = join(wsDir, hashDir, 'GitHub.copilot-chat', 'transcripts')

      // Resolve project name from workspace.json
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

export function createCopilotProvider(sessionStateDir?: string, workspaceStorageDir?: string): Provider {
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

      // 1. Discover OTel sessions (preferred — full token data)
      const disableOtel = process.env['CODEBURN_COPILOT_DISABLE_OTEL'] === '1'
      if (!disableOtel) {
        const dbPath = getAgentTracesDbPath()
        if (dbPath) {
          try {
            const otelSources = await discoverOtelSessions(dbPath)
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

      // 3. Discover VS Code workspace transcript sessions
      try {
        const transcriptSources = await discoverTranscriptSessions(getWsDirs())
        sources.push(...transcriptSources)
      } catch {
        // Transcript discovery failed
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
      return createJsonlParser(source, seenKeys)
    },
  }
}

// Default export for the provider registry
export const copilot = createCopilotProvider()
