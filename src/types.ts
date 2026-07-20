export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | ToolUseBlock
  | { type: string; [key: string]: unknown }

export type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  cache_read_input_tokens?: number
  server_tool_use?: {
    web_search_requests?: number
    web_fetch_requests?: number
  }
  speed?: 'standard' | 'fast'
  // Claude Code advisor tool (/advisor): per-turn sub-usage records. A record
  // with type 'advisor_message' carries the advisor model's own tokens and is
  // NOT included in the top-level totals above; type 'message' records mirror
  // the main model and are already covered by the top-level totals.
  iterations?: ApiUsageIteration[]
}

export type ApiUsageIteration = {
  type?: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  cache_read_input_tokens?: number
  server_tool_use?: {
    web_search_requests?: number
    web_fetch_requests?: number
  }
  speed?: 'standard' | 'fast'
}

export type AssistantMessageContent = {
  model: string
  id?: string
  type: 'message'
  role: 'assistant'
  content: ContentBlock[]
  usage: ApiUsage
  stop_reason?: string
}

export type JournalEntry = {
  type: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  sessionId?: string
  cwd?: string
  version?: string
  gitBranch?: string
  promptId?: string
  message?: AssistantMessageContent | { role: 'user'; content: string | ContentBlock[] }
  isSidechain?: boolean
  [key: string]: unknown
}

export type ParsedTurn = {
  userMessage: string
  assistantCalls: ParsedApiCall[]
  timestamp: string
  sessionId: string
  // Claude Code: the git branch active for this turn (top-level `gitBranch` on
  // the turn's entries). Captured for cost-per-branch reporting; deduped at the
  // cache boundary (stored per-turn only when it changes). Optional; Claude only.
  gitBranch?: string
}

export type ParsedApiCall = {
  provider: string
  model: string
  usage: TokenUsage
  costUSD: number
  tools: string[]
  mcpTools: string[]
  skills: string[]
  subagentTypes: string[]
  hasAgentSpawn: boolean
  hasPlanMode: boolean
  speed: 'standard' | 'fast'
  timestamp: string
  bashCommands: string[]
  deduplicationKey: string
  cacheCreationOneHourTokens?: number
  toolSequence?: ToolCall[][]
  /// When set, `costUSD` is the actual local call (forced to 0) and
  /// `savingsUSD` is the counterfactual cost the same tokens would have
  /// incurred against `savingsBaselineModel`. Set by the savings
  /// normalization step in `src/parser.ts`.
  savingsUSD?: number
  savingsBaselineModel?: string
  isLocalSavings?: boolean
  /// True when this call's `costUSD` is priced from estimated token counts or
  /// otherwise synthesized by the provider (e.g. Warp/Kiro/Cursor derive tokens
  /// from content length). Carried from `ParsedProviderCall.costIsEstimated`
  /// across the parser/cache boundary. Aggregates roll the estimated portion up
  /// as `estimatedCostUSD`; it is display/metadata only and never changes totals.
  isEstimated?: boolean
  /// Lines added/removed by this call's edits, counted from tool-result diffs
  /// (Claude: `toolUseResult.structuredPatch`). Numbers only, never patch text;
  /// omitted when zero. Rich-session-capture (capture-only; no report yet).
  locAdded?: number
  locRemoved?: number
  /// True only when at least one of this call's tool results was interrupted or
  /// had its edit modified by the user (Claude `toolUseResult.interrupted` /
  /// `userModified`). Omitted when false.
  interrupted?: boolean
  userModified?: boolean
  /// Count of this call's tool results flagged `is_error` (Claude tool_result
  /// blocks). Bash stderr alone is NOT counted (warnings go there). Omitted at 0.
  toolErrors?: number
}

export type ToolCall = {
  tool: string
  file?: string
  command?: string
}

export type TaskCategory =
  | 'coding'
  | 'debugging'
  | 'feature'
  | 'refactoring'
  | 'testing'
  | 'exploration'
  | 'planning'
  | 'delegation'
  | 'git'
  | 'build/deploy'
  | 'conversation'
  | 'brainstorming'
  | 'general'

export type ClassifiedTurn = ParsedTurn & {
  category: TaskCategory
  subCategory?: string
  retries: number
  hasEdits: boolean
}

export type SessionSourceMetadata = {
  id: string
  label: string
  path: string
  kind: 'claude-config' | 'claude-desktop'
}

export type SessionSummary = {
  sessionId: string
  project: string
  source?: SessionSourceMetadata
  // Claude Code only: agent type of a subagent transcript session
  // (`workflow-subagent`, `Explore`, `general-purpose`, …); undefined for
  // ordinary sessions. Drives the Claude-scoped agent-type breakdown.
  agentType?: string
  firstTimestamp: string
  lastTimestamp: string
  totalCostUSD: number
  totalSavingsUSD: number
  /// Portion of `totalCostUSD` contributed by calls whose price is estimated
  /// (see `ParsedApiCall.isEstimated`). Optional so SessionSummary fixtures and
  /// producers predating the field keep compiling; the parser always sets it.
  totalEstimatedCostUSD?: number
  totalInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  apiCalls: number
  turns: ClassifiedTurn[]
  /// GitHub PR URLs captured from the session transcript (session-level,
  /// deduplicated). Absent when none were observed.
  prLinks?: string[]
  /// Human session title captured from the transcript (last ai-title entry).
  /// Absent when the transcript never produced one.
  title?: string
  /// True when the session observed a git branch on ANY turn of its FULL
  /// (pre-date-filter) transcript. Set before turns are sliced to a range so the
  /// by-branch report can still tell a branch-bearing Claude session (whose
  /// in-range turns may all predate its first branch → the `null` bucket) apart
  /// from a provider that never captures branches (→ contributes nothing).
  /// Claude only; absent otherwise.
  everHadBranch?: boolean
  modelBreakdown: Record<string, { calls: number; costUSD: number; tokens: TokenUsage; savingsUSD: number; estimatedCostUSD?: number }>
  toolBreakdown: Record<string, { calls: number }>
  mcpBreakdown: Record<string, { calls: number }>
  bashBreakdown: Record<string, { calls: number }>
  categoryBreakdown: Record<TaskCategory, { turns: number; costUSD: number; savingsUSD: number; retries: number; editTurns: number; oneShotTurns: number }>
  skillBreakdown: Record<string, { turns: number; costUSD: number; savingsUSD: number; editTurns: number; oneShotTurns: number }>
  subagentBreakdown: Record<string, { calls: number; costUSD: number; savingsUSD: number }>
  // Observed MCP tools available in this session, captured from
  // `attachment.deferred_tools_delta.addedNames` entries. Union across all
  // turns. Each name is a fully-qualified `mcp__<server>__<tool>` identifier.
  // Built-in tools (Bash, Edit, etc.) are filtered out. Provider-agnostic field;
  // currently populated only by the Claude parser.
  mcpInventory?: string[]
}

export type ProjectSummary = {
  project: string
  projectPath: string
  sessions: SessionSummary[]
  totalCostUSD: number
  totalSavingsUSD: number
  /// Portion of `totalCostUSD` priced from estimated tokens (see
  /// `SessionSummary.totalEstimatedCostUSD`). Optional for the same reason.
  totalEstimatedCostUSD?: number
  totalApiCalls: number
  // Portion of `totalCostUSD` served through a subscription-backed proxy
  // (config `proxyPaths`). `totalCostUSD` is left at the full API rate (the
  // billable / would-be figure); this is the subscription-covered amount, so
  // net out-of-pocket for the project is `totalCostUSD - totalProxiedCostUSD`.
  // 0 when the project is not under a configured proxy path.
  totalProxiedCostUSD: number
}

export type DateRange = {
  start: Date
  end: Date
}

export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  coding: 'Coding',
  debugging: 'Debugging',
  feature: 'Feature Dev',
  refactoring: 'Refactoring',
  testing: 'Testing',
  exploration: 'Exploration',
  planning: 'Planning',
  delegation: 'Delegation',
  git: 'Git Ops',
  'build/deploy': 'Build/Deploy',
  conversation: 'Conversation',
  brainstorming: 'Brainstorming',
  general: 'General',
}
