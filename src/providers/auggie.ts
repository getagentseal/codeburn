import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readCachedCalls, writeCachedCalls } from '../auggie-cache.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getModelCosts } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { loadBillingConfig, computeBilling, type BillingConfig, type BillingResult } from '../billing.js'
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
/// on the response_node. Augment routes across Anthropic / OpenAI / Google / xAI / Minimax, so
/// the default should match the provider the call went to. Users can override any of these via env:
///   CODEBURN_AUGGIE_DEFAULT_ANTHROPIC
///   CODEBURN_AUGGIE_DEFAULT_OPENAI
///   CODEBURN_AUGGIE_DEFAULT_GEMINI
///   CODEBURN_AUGGIE_DEFAULT_XAI
///   CODEBURN_AUGGIE_DEFAULT_MINIMAX
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.1',
  gemini: 'gemini-3-pro',
  xai: 'grok-2', // TODO(billing): confirm grok-2 is the correct default for xAI provider
  minimax: 'minimax', // TODO(billing): confirm actual model name for minimax provider
}

/// Augment-internal model IDs that LiteLLM has no pricing for. The entries here are
/// best-effort aliases to the closest publicly-priced model so cost displays aren't
/// stuck at $0 for historical data. Users can override via CODEBURN_AUGGIE_ALIAS_<MODEL>.
/// Keep conservative: if a model name isn't clearly mappable, leave it unaliased and
/// accept $0 cost rather than guessing wrong.
const MODEL_ALIASES: Record<string, string> = {
  // TODO(billing): confirm public-model mapping with billing team
  'butler': 'claude-haiku-4-5',
  // TODO(billing): confirm public-model mapping with billing team — gpt-5-2-codex may map to gpt-5.3-codex
  'gpt-5-2-codex': 'gpt-5.3-codex',
  // TODO(billing): confirm public-model mapping with billing team — gpt-5-4 may map to gpt-5.4
  'gpt-5-4': 'gpt-5.4',
  // TODO(billing): confirm public-model mapping with billing team — gpt-5-2-medium may map to gpt-5 or gpt-5-mini
  'gpt-5-2-medium': 'gpt-5',
  // TODO(billing): confirm public-model mapping with billing team — claude-sonnet-4-6 is close to claude-sonnet-4-5
  'claude-sonnet-4-6': 'claude-sonnet-4-5',
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
  /// Structured MCP fields (modern sessions). When both are present, prefer these
  /// over suffix-parsing to identify MCP tools.
  mcp_server_name?: string
  mcp_tool_name?: string
}

type AuggieBillingMetadata = {
  transaction_id?: string
  credits_consumed?: number
}

type AuggieResponseNode = {
  id?: number
  type?: number
  tool_use?: AuggieToolUse | null
  token_usage?: AuggieTokenUsage | null
  metadata?: { provider?: string | null } | null
  timestamp_ms?: number | null
  /// Type-9 BILLING_METADATA nodes carry credits info
  billing_metadata?: AuggieBillingMetadata | null
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
  /// Session-level credit usage (newer sessions, Apr 2026+). When present, this is the
  /// authoritative total for the session. Per-exchange credits are still parsed for
  /// breakdown purposes but the session total should use this when available.
  creditUsage?: number | null
  /// Credits consumed by sub-agents spawned from this session.
  subAgentCreditsUsed?: number | null
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
///   2. provider-aware default keyed off the first non-null provider from response_nodes
///   3. `auggie-legacy` when modelId is empty AND no provider hint can be derived
///      (pre-Nov-2025 sessions with no recoverable model information)
///   4. `auggie-unknown` when modelId is set but not found in alias table (shouldn't happen
///      after step 1, but kept for future model IDs we haven't aliased yet)
///
/// Sentinel distinction:
///   - `auggie-unknown`: we have a modelId but it isn't in the alias table yet
///   - `auggie-legacy`: pre-Nov-2025 session with no modelId, unrecoverable
function selectModel(session: AuggieSession, nodeProvider: string | null | undefined): string {
  const raw = session.agentState?.modelId?.trim()
  if (raw) return resolveModelAlias(raw)
  const providerDefault = resolveDefaultModel(nodeProvider)
  if (providerDefault) return providerDefault
  // No modelId AND no provider hint: this is a pre-Nov-2025 legacy session
  return 'auggie-legacy'
}

/// Scans response_nodes (in particular type-8 ASSISTANT_CHAT_RESULT nodes) to find
/// the first non-null `metadata.provider`. Type-10 billing nodes often have null
/// provider even when type-8 nodes in the same exchange have it populated.
function extractProviderHint(responseNodes: AuggieResponseNode[]): string | null {
  for (const node of responseNodes) {
    // Type-8 nodes (legacy THINKING / ASSISTANT_CHAT_RESULT) reliably carry provider
    if (node.type === NODE_TYPE_ASSISTANT_RESULT) {
      const provider = node.metadata?.provider
      if (provider) return provider
    }
  }
  // Fallback: scan all nodes in case type-5 or type-10 has it
  for (const node of responseNodes) {
    const provider = node.metadata?.provider
    if (provider) return provider
  }
  return null
}

/// `tool_use.name` at the response_node level takes a few shapes:
///   - bash / shell: "launch-process"
///   - built-in editors: "view", "str-replace-editor", "codebase-retrieval", ...
///   - MCP tools: "<tool>_<server>-mcp" (e.g. "read_note_workspace-mcp")
/// For the tool breakdown we keep the raw name. For the MCP panel we parse off the `-mcp`
/// suffix and treat the trailing segment as the server (matching how parser.ts groups MCP
/// tools for the other providers via mcp__server__tool).
///
/// Structured MCP field preference: When both mcp_server_name and mcp_tool_name are
/// present (modern sessions), we emit a canonical name in the Auggie suffix format:
/// `${mcp_tool_name}_${mcp_server_name}-mcp`. This ensures downstream extractMcpTools
/// in parser.ts picks it up via the `-mcp` suffix path.
function toolNameOf(toolUse: AuggieToolUse | null | undefined): string {
  if (!toolUse) return ''
  // Prefer structured MCP fields when both are present
  const mcpServer = toolUse.mcp_server_name
  const mcpTool = toolUse.mcp_tool_name
  if (mcpServer && mcpTool) {
    return `${mcpTool}_${mcpServer}-mcp`
  }
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

/// ChatResultNodeType enum constants (from Auggie schema):
///   5 = TOOL_USE (has tool_use, no token_usage)
///   8 = ASSISTANT_CHAT_RESULT (legacy "THINKING" nodes — carry both tool_use and token_usage)
///   9 = BILLING_METADATA (credits info with transaction_id for deduplication)
///  10 = TOKEN_USAGE (has token_usage, no tool_use — billing boundary)
const NODE_TYPE_TOOL_USE = 5
const NODE_TYPE_ASSISTANT_RESULT = 8
const NODE_TYPE_BILLING_METADATA = 9
const NODE_TYPE_TOKEN_USAGE = 10

/// Parse a tool_use.input_json string into a record. Auggie serializes tool inputs as JSON
/// strings; we need to parse to extract command fields for bash extraction.
function parseToolInputJson(inputJson: string | null | undefined): Record<string, unknown> {
  if (!inputJson) return {}
  try {
    const parsed = JSON.parse(inputJson) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch { /* malformed JSON, ignore */ }
  return {}
}

/// Extract credits from type-9 BILLING_METADATA nodes, deduplicating by transaction_id.
/// This matches Augment's calculateCreditsFromHistory approach: each transaction should
/// only be counted once even if it appears in multiple nodes.
///
/// Returns null if no billing nodes were found (legacy session / no billing data),
/// otherwise returns the sum of credits_consumed across unique transactions.
function extractCreditsFromNodes(
  responseNodes: AuggieResponseNode[],
  seenTransactionIds: Set<string>,
): number | null {
  let hasAnyBillingNode = false
  let credits = 0

  for (const node of responseNodes) {
    if (node.type !== NODE_TYPE_BILLING_METADATA) continue
    const billing = node.billing_metadata
    if (!billing) continue

    hasAnyBillingNode = true
    const txId = billing.transaction_id
    const consumed = billing.credits_consumed ?? 0

    // Dedupe by transaction_id to prevent double-counting
    if (txId) {
      if (seenTransactionIds.has(txId)) continue
      seenTransactionIds.add(txId)
    }

    credits += consumed
  }

  // Return null if no billing nodes found (no billing data available)
  // Return 0 if billing nodes exist but sum to zero
  return hasAnyBillingNode ? credits : null
}

/// Turn a single Auggie exchange into zero-or-more ParsedProviderCalls.
///
/// Auggie has two data formats:
///   1. Legacy (type-8): Each node carries BOTH tool_use AND token_usage together.
///      Treat each node independently — one tool per call.
///   2. Modern (type-5 + type-10): Tool_use on type-5 nodes, token_usage on type-10.
///      Aggregate all tools across the exchange, emit with first type-10 node only.
///
/// This prevents tool-count inflation: a tool invoked once should be counted once,
/// not once per token_usage node.
///
/// Credits are extracted from type-9 BILLING_METADATA nodes and attached to the first
/// ParsedProviderCall emitted for this exchange. Transaction IDs are tracked across the
/// session to prevent double-counting the same billing transaction.
///
/// Billing: Each call is run through computeBilling() to attach the full BillingResult.
/// The `credits` field is preserved for back-compat (derived from BillingResult.creditsAugment).
function* parseExchange(
  session: AuggieSession,
  exchange: AuggieExchange,
  sessionId: string,
  projectLabel: string,
  seenKeys: Set<string>,
  seenTransactionIds: Set<string>,
  billingConfig: BillingConfig,
): Generator<ParsedProviderCall> {
  const userMessage = extractUserMessage(exchange)
  const requestId = exchange.request_id ?? ''
  const responseNodes = exchange.response_nodes ?? []

  // Extract provider hint once at the exchange level. This scans ALL type-8 nodes
  // (ASSISTANT_CHAT_RESULT / THINKING) for metadata.provider because billing nodes
  // (type-10) often have null provider while type-8 nodes have it populated.
  const exchangeProviderHint = extractProviderHint(responseNodes)

  // Extract credits from type-9 BILLING_METADATA nodes for this exchange.
  // Deduplication happens via seenTransactionIds which persists across the session.
  const exchangeCredits = extractCreditsFromNodes(responseNodes, seenTransactionIds)

  // Detect whether this exchange uses modern schema (has type-10 TOKEN_USAGE nodes)
  // or legacy schema (type-8 nodes with both tool_use and token_usage)
  const hasModernTokenNodes = responseNodes.some(n => n.type === NODE_TYPE_TOKEN_USAGE)

  if (hasModernTokenNodes) {
    // ─────────────────────────────────────────────────────────────────────────
    // Modern schema: Aggregate tools from type-5, emit with first type-10
    // ─────────────────────────────────────────────────────────────────────────
    const allTools: string[] = []
    const allBashCommands: string[] = []

    // Collect tools from type-5 TOOL_USE nodes
    for (const node of responseNodes) {
      if (node.type === NODE_TYPE_TOOL_USE) {
        const rawToolName = toolNameOf(node.tool_use)
        if (rawToolName) {
          allTools.push(rawToolName)
          if (rawToolName === BASH_TOOL_NAME) {
            const toolUse = node.tool_use as AuggieToolUse & { input_json?: string }
            const inputRecord = toolUse?.input_json
              ? parseToolInputJson(toolUse.input_json)
              : toolInputOf(node.tool_use)
            const cmd = inputRecord['command']
            if (typeof cmd === 'string') {
              allBashCommands.push(...extractBashCommands(cmd))
            }
          }
        }
      }
    }

    // Emit calls for type-10 TOKEN_USAGE nodes
    let firstEmitted = false
    let tokenNodeIndex = 0

    for (const node of responseNodes) {
      if (node.type !== NODE_TYPE_TOKEN_USAGE) continue
      const usage = node.token_usage
      if (!usage) continue

      const input = usage.input_tokens ?? 0
      const output = usage.output_tokens ?? 0
      const cacheRead = usage.cache_read_input_tokens ?? 0
      const cacheWrite = usage.cache_creation_input_tokens ?? 0
      if (totalTokens(usage) === 0) continue

      // Modern type-10 nodes may have duplicate ids, so use incrementing index
      const dedupKey = `auggie:${sessionId}:${requestId}:t${tokenNodeIndex++}`
      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      // Use exchange-level provider hint (from type-8 nodes) rather than per-node,
      // because type-10 billing nodes often have null provider.
      const model = selectModel(session, exchangeProviderHint)
      const costUSD = calculateCost(model, input, output, cacheWrite, cacheRead, 0)
      const timestamp = isoFromMs(node.timestamp_ms) ?? session.modified ?? session.created ?? ''

      // Attach tools and credits only to first call to prevent inflation
      const tools = firstEmitted ? [] : allTools
      const bashCommands = firstEmitted ? [] : allBashCommands
      const groundTruthCredits = firstEmitted ? null : exchangeCredits
      firstEmitted = true

      // Compute billing using the billing engine
      const modelCosts = getModelCosts(model)
      const billingResult = computeBilling(
        { input, output, cacheRead, cacheWrite },
        modelCosts,
        billingConfig,
        groundTruthCredits,
      )

      // Derive `credits` from BillingResult.creditsAugment for back-compat
      const credits = billingResult.creditsAugment

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
        credits,
        billing: billingResult,
      }
    }
  } else {
    // ─────────────────────────────────────────────────────────────────────────
    // Legacy schema (type-8): Each node is self-contained with its own tool
    // ─────────────────────────────────────────────────────────────────────────
    let firstEmitted = false
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

      // Use exchange-level provider hint (extracted once from all type-8 nodes).
      // For legacy schema, type-8 nodes usually have provider, but we use the
      // exchange-level extraction for consistency.
      const model = selectModel(session, exchangeProviderHint)
      const costUSD = calculateCost(model, input, output, cacheWrite, cacheRead, 0)
      const timestamp = isoFromMs(node.timestamp_ms) ?? session.modified ?? session.created ?? ''

      // Legacy: extract tool from the same node
      const rawToolName = toolNameOf(node.tool_use)
      const tools = rawToolName ? [rawToolName] : []
      const bashCommands: string[] = []
      if (rawToolName === BASH_TOOL_NAME) {
        const inputRecord = toolInputOf(node.tool_use)
        const cmd = inputRecord['command']
        if (typeof cmd === 'string') bashCommands.push(...extractBashCommands(cmd))
      }

      // Attach credits only to first call to prevent inflation
      const groundTruthCredits = firstEmitted ? null : exchangeCredits
      firstEmitted = true

      // Compute billing using the billing engine
      const modelCosts = getModelCosts(model)
      const billingResult = computeBilling(
        { input, output, cacheRead, cacheWrite },
        modelCosts,
        billingConfig,
        groundTruthCredits,
      )

      // Derive `credits` from BillingResult.creditsAugment for back-compat
      const credits = billingResult.creditsAugment

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
        credits,
        billing: billingResult,
      }
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
  // Load billing config once per parser (per session file).
  // Config is env-var driven so this is deterministic for the lifetime of the process.
  const billingConfig = loadBillingConfig()

  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // Cache hit: the session file is unchanged since the last run (same mtime + size).
      // Yield the cached calls directly -- this is the happy path for most of the 700+
      // sessions on a typical install.
      // NOTE: Cached calls may have billing computed under a different config.
      // This is acceptable since the cache is keyed by mtime+size, so if the user
      // changes billing mode, they can touch/edit the session files to invalidate.
      // In practice, billing mode rarely changes mid-flight.
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

      // Track seen transaction_ids to dedupe billing metadata across exchanges.
      // This matches Augment's calculateCreditsFromHistory approach.
      const seenTransactionIds = new Set<string>()

      // Session-level creditUsage fast-path: Newer sessions (Apr 2026+) may have
      // session.creditUsage set. When present, this is Augment's authoritative
      // session total (already deduped, includes sub-agents); prefer it over
      // per-node summation for session totals. Per-exchange credits are still
      // parsed for per-model breakdowns.
      const sessionCreditUsage = session.creditUsage ?? null

      const fresh: ParsedProviderCall[] = []
      let isFirstCall = true
      for (const turn of chatHistory) {
        const ex = turn.exchange
        if (!ex) continue
        for (const call of parseExchange(session, ex, sessionId, projectLabel, seenKeys, seenTransactionIds, billingConfig)) {
          // Attach session-level creditUsage to the first call so the parser can use it.
          if (isFirstCall && sessionCreditUsage !== null) {
            call.sessionCreditUsage = sessionCreditUsage
            isFirstCall = false
          }
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
      if (model === 'auggie-legacy') return 'Auggie (legacy session)'
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
