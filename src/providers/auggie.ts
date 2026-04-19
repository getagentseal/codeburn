import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readCachedCalls, writeCachedCalls } from '../auggie-cache.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

/// Augment Code's CLI ("Auggie") writes one JSON file per conversation into ~/.augment/sessions/.
/// Each file is pretty-printed JSON (whole-file rewrite on every update). The schema evolved
/// between Aug 2025 and Apr 2026: newer sessions carry creditUsage / subAgentCreditsUsed /
/// rootTaskUuid, older ones don't. The parser tolerates both.
const SESSIONS_SUBDIR = 'sessions'
const CREDENTIALS_FILENAME = 'session.json'
const USER_MESSAGE_CAP = 500
const BASH_TOOL_NAME = 'launch-process'
const MCP_TOOL_SUFFIX = '-mcp'

/// Per-provider default model when agentState.modelId is empty. Indexed by metadata.provider
/// on the response_node. Augment routes across Anthropic / OpenAI / Google, so the default
/// should match the provider the call went to. Users can override any of these via env:
///   CODEBURN_AUGGIE_DEFAULT_ANTHROPIC
///   CODEBURN_AUGGIE_DEFAULT_OPENAI
///   CODEBURN_AUGGIE_DEFAULT_GOOGLE
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.1',
  google: 'gemini-3-pro',
}

/// Augment-internal model IDs that LiteLLM has no pricing for. The entries here are
/// best-effort aliases to the closest publicly-priced model so cost displays aren't
/// stuck at $0 for historical data. Users can override via CODEBURN_AUGGIE_ALIAS_<MODEL>.
/// Keep conservative: if a model name isn't clearly mappable, leave it unaliased and
/// accept $0 cost rather than guessing wrong.
const MODEL_ALIASES: Record<string, string> = {
  butler: 'claude-haiku-4-5',
}

type AuggieTokenUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type AuggieToolUse = {
  tool_name?: string
  name?: string
  input?: Record<string, unknown>
  arguments?: Record<string, unknown>
}

type AuggieResponseNode = {
  id?: number
  type?: number
  tool_use?: AuggieToolUse | null
  token_usage?: AuggieTokenUsage | null
  metadata?: { provider?: string | null } | null
  timestamp_ms?: number | null
}

type AuggieRequestNode = {
  id?: number
  type?: number
  ide_state_node?: {
    current_terminal?: { current_working_directory?: string }
    workspace_folders?: Array<{ repository_root?: string; folder_root?: string }>
  }
}

type AuggieExchange = {
  request_id?: string
  request_message?: string
  request_nodes?: AuggieRequestNode[]
  response_nodes?: AuggieResponseNode[]
}

type AuggieChatTurn = {
  exchange?: AuggieExchange
}

type AuggieSession = {
  sessionId?: string
  created?: string
  modified?: string
  rootTaskUuid?: string
  workspaceId?: string
  agentState?: {
    modelId?: string
  }
  chatHistory?: AuggieChatTurn[]
}

function getAugmentDir(): string {
  return process.env['AUGMENT_HOME'] || join(homedir(), '.augment')
}

function getSessionsDir(): string {
  return join(getAugmentDir(), SESSIONS_SUBDIR)
}

function resolveDefaultModel(provider: string | null | undefined): string {
  const key = (provider ?? '').toLowerCase()
  if (!key) return ''
  const envOverride = process.env[`CODEBURN_AUGGIE_DEFAULT_${key.toUpperCase()}`]
  if (envOverride) return envOverride
  return PROVIDER_DEFAULT_MODEL[key] ?? ''
}

function resolveModelAlias(modelId: string): string {
  const envOverride = process.env[`CODEBURN_AUGGIE_ALIAS_${modelId.toUpperCase()}`]
  if (envOverride) return envOverride
  return MODEL_ALIASES[modelId] ?? modelId
}

/// Picks the model name used for pricing and display. Preference order:
///   1. `agentState.modelId` when populated -> resolved through the alias table
///   2. provider-aware default keyed off `response_node.metadata.provider`
///   3. `auggie-unknown` as a terminal fallback; priced at $0
function selectModel(session: AuggieSession, nodeProvider: string | null | undefined): string {
  const raw = session.agentState?.modelId?.trim()
  if (raw) return resolveModelAlias(raw)
  const providerDefault = resolveDefaultModel(nodeProvider)
  if (providerDefault) return providerDefault
  return 'auggie-unknown'
}

/// `tool_use.name` at the response_node level takes a few shapes:
///   - bash / shell: "launch-process"
///   - built-in editors: "view", "str-replace-editor", "codebase-retrieval", ...
///   - MCP tools: "<tool>_<server>-mcp" (e.g. "read_note_workspace-mcp")
/// For the tool breakdown we keep the raw name. For the MCP panel we parse off the `-mcp`
/// suffix and treat the trailing segment as the server (matching how parser.ts groups MCP
/// tools for the other providers via mcp__server__tool).
function toolNameOf(toolUse: AuggieToolUse | null | undefined): string {
  if (!toolUse) return ''
  return toolUse.tool_name ?? toolUse.name ?? ''
}

function toolInputOf(toolUse: AuggieToolUse | null | undefined): Record<string, unknown> {
  if (!toolUse) return {}
  return toolUse.input ?? toolUse.arguments ?? {}
}

/// Extracts a project label from the exchange's request_nodes. Preference:
///   1. workspace_folders[0].repository_root (stable across a project session)
///   2. current_terminal.current_working_directory (falls back to the shell cwd)
/// Returns the last two path segments ("sweet-roadrunner/repo") so projects are
/// disambiguated without leaking the user's home directory into the display.
function projectLabelFromExchange(ex: AuggieExchange): string {
  const requestNodes = ex.request_nodes ?? []
  for (const node of requestNodes) {
    const ide = node.ide_state_node
    if (!ide) continue
    const repoRoot = ide.workspace_folders?.[0]?.repository_root
    if (repoRoot) return lastTwoSegments(repoRoot)
    const cwd = ide.current_terminal?.current_working_directory
    if (cwd) return lastTwoSegments(cwd)
  }
  return ''
}

function lastTwoSegments(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]!
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function extractUserMessage(ex: AuggieExchange): string {
  const raw = ex.request_message ?? ''
  if (raw.length <= USER_MESSAGE_CAP) return raw
  return raw.slice(0, USER_MESSAGE_CAP)
}

function totalTokens(usage: AuggieTokenUsage): number {
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}

/// Turn a single Auggie exchange into zero-or-more ParsedProviderCalls. Each response_node
/// that carries a populated token_usage is one LLM API call; a tool-loop turn produces
/// multiple. request_id is stable per exchange, response_node.id indexes within the exchange.
function* parseExchange(
  session: AuggieSession,
  exchange: AuggieExchange,
  sessionId: string,
  projectLabel: string,
  seenKeys: Set<string>,
): Generator<ParsedProviderCall> {
  const userMessage = extractUserMessage(exchange)
  const requestId = exchange.request_id ?? ''
  const responseNodes = exchange.response_nodes ?? []

  for (const node of responseNodes) {
    const usage = node.token_usage
    if (!usage) continue

    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheWrite = usage.cache_creation_input_tokens ?? 0
    if (totalTokens(usage) === 0) continue

    const nodeId = node.id ?? 0
    const dedupKey = `auggie:${sessionId}:${requestId}:${nodeId}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    const providerHint = node.metadata?.provider ?? null
    const model = selectModel(session, providerHint)
    const costUSD = calculateCost(model, input, output, cacheWrite, cacheRead, 0)

    const rawToolName = toolNameOf(node.tool_use)
    const tools = rawToolName ? [rawToolName] : []
    const bashCommands: string[] = []
    if (rawToolName === BASH_TOOL_NAME) {
      const input = toolInputOf(node.tool_use)
      const cmd = input['command']
      if (typeof cmd === 'string') bashCommands.push(...extractBashCommands(cmd))
    }

    const timestamp = isoFromMs(node.timestamp_ms) ?? session.modified ?? session.created ?? ''

    yield {
      provider: 'auggie',
      model,
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: cacheWrite,
      cacheReadInputTokens: cacheRead,
      cachedInputTokens: cacheRead,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD,
      tools,
      bashCommands,
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage,
      sessionId,
    }
  }
}

function isoFromMs(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null
  if (!Number.isFinite(ms) || ms <= 0) return null
  try {
    return new Date(ms).toISOString()
  } catch {
    return null
  }
}

async function discoverSessionFiles(sessionsDir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch {
    return []
  }
  return entries.filter(name => name.endsWith('.json')).map(name => join(sessionsDir, name))
}

function parseSession(content: string): AuggieSession | null {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as AuggieSession
  } catch {
    return null
  }
}

/// Sub-agent sessions carry a rootTaskUuid pointing at their parent's task UUID. We preserve
/// the session as an independent source (so the data is visible) but tag the sessionId to
/// make the relationship obvious in downstream rollups. If the parent isn't resolvable
/// locally, behaviour degrades to treating the sub-agent as a normal session — same total
/// numbers, just counted separately.
function taggedSessionId(session: AuggieSession): string {
  const id = session.sessionId ?? ''
  if (session.rootTaskUuid) return `${id}#sub:${session.rootTaskUuid}`
  return id
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // Cache hit: the session file is unchanged since the last run (same mtime + size).
      // Yield the cached calls directly -- this is the happy path for most of the 700+
      // sessions on a typical install.
      const cached = await readCachedCalls(source.path)
      if (cached) {
        for (const call of cached) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      const content = await readSessionFile(source.path)
      if (content === null) return
      const session = parseSession(content)
      if (!session) return

      const sessionId = taggedSessionId(session)
      const chatHistory = session.chatHistory ?? []

      let projectLabel = source.project
      for (const turn of chatHistory) {
        const ex = turn.exchange
        if (!ex) continue
        const discovered = projectLabelFromExchange(ex)
        if (discovered) {
          projectLabel = discovered
          break
        }
      }

      const fresh: ParsedProviderCall[] = []
      for (const turn of chatHistory) {
        const ex = turn.exchange
        if (!ex) continue
        for (const call of parseExchange(session, ex, sessionId, projectLabel, seenKeys)) {
          fresh.push(call)
          yield call
        }
      }
      // Persist the parsed calls so the next run short-circuits via readCachedCalls.
      // Fire and forget -- cache-write failures are non-fatal.
      void writeCachedCalls(source.path, fresh)
    },
  }
}

async function discoverSessions(sessionsDir: string): Promise<SessionSource[]> {
  const files = await discoverSessionFiles(sessionsDir)
  const sources: SessionSource[] = []
  for (const filePath of files) {
    // Defense in depth: the credentials file lives at ~/.augment/session.json, a sibling of
    // the sessions/ directory, not inside it. The endsWith check guards against any future
    // Auggie change that might drop it here.
    if (basename(filePath) === CREDENTIALS_FILENAME) continue
    const fileStat = await stat(filePath).catch(() => null)
    if (!fileStat?.isFile()) continue
    const fallbackProject = basename(filePath, '.json')
    sources.push({ path: filePath, project: fallbackProject, provider: 'auggie' })
  }
  return sources
}

export function createAuggieProvider(sessionsDirOverride?: string): Provider {
  const sessionsDir = sessionsDirOverride ?? getSessionsDir()
  return {
    name: 'auggie',
    displayName: 'Auggie',

    modelDisplayName(model: string): string {
      if (model === 'auggie-unknown') return 'Auggie (unknown model)'
      return model
    },

    toolDisplayName(rawTool: string): string {
      if (rawTool.endsWith(MCP_TOOL_SUFFIX)) {
        const withoutSuffix = rawTool.slice(0, -MCP_TOOL_SUFFIX.length)
        const lastUnderscore = withoutSuffix.lastIndexOf('_')
        if (lastUnderscore > 0) {
          const tool = withoutSuffix.slice(0, lastUnderscore)
          const server = withoutSuffix.slice(lastUnderscore + 1)
          return `mcp:${server}:${tool}`
        }
      }
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessions(sessionsDir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const auggie = createAuggieProvider()
