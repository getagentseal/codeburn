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
  // GitHub PR URLs referenced during this turn, sorted and deduplicated. Claude
  // supplies native `pr-link` entries; every provider can contribute explicit
  // URLs from its saved user message, and correlated external sessions seed the
  // field deterministically. Drives turn-level PR spend attribution.
  prRefs?: string[]
  // Claude Code: the `tool_use` ids of the `Agent`/`Task` subagent spawns emitted
  // in this turn. A spawned sidechain session is folded back into the turn that
  // launched it by matching its resolved spawn id against these. Absent when the
  // turn spawned no subagent. Optional; Claude only.
  spawnToolUseIds?: string[]
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
  /// Claude Code: `tool_use` ids of the `Agent`/`Task` subagent-spawn blocks in
  /// this call's assistant message. Transient (built at parse time, aggregated
  /// into the turn's `spawnToolUseIds`); never cached per-call.
  spawnToolUseIds?: string[]
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
  activeDurationMs?: number
  activeGeneratedTokens?: number
  toolWaitMs?: number
  /// Supplementary accounting: this call's tokens/cost are real but the call is
  /// not a distinct behavioral request (copilot shutdown rollups and store rows
  /// that pair with an already-counted per-turn call; Hermes observation-time
  /// deltas). Aggregates keep its tokens/cost but skip it in apiCalls /
  /// model-call / turn counts. Hermes deltas persist the flag on CachedCall;
  /// Copilot remains serve-time / never cached.
  supplementaryAccounting?: boolean
  /// Copilot session-store `total_nano_aiu`. 1e9 nano-AIU = 1 credit = $0.01.
  /// Threaded from CachedCall / ParsedProviderCall so plan math can sum credits.
  /// Absent on older stores and on JSONL / shutdown-rollup siblings.
  nanoAiu?: number
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

/// Provider-recorded parent-child session lineage (CB-1, slice 1). The
/// relationship is captured ONLY when a provider writes it on disk in a
/// durable form: a child file that names its parent (Claude's
/// transcript-internal `sessionId` on a sidechain; Kimi Code's
/// `state.json` `agents[<id>].parentAgentId` for any non-`main` agent), or
/// a parent file whose spawn/child manifest names the children (Claude's
/// `agentSpawnLinks`, Kimi Code's `state.json` `agents` map listing any
/// non-`main` entry). The brief forbids inference from time adjacency or
/// directory layout: a parent whose only evidence is the child file living
/// under its directory does not yet qualify, and stays `lineage`-less. The
/// field is purely additive metadata; nothing here changes the cost/token/
/// call totals, the by-PR fold, or any other aggregation.
export type SessionLineage = {
  /// On a child session, the parent session's id (Claude:
  /// transcript-internal `sessionId`; Kimi Code: `parentAgentId === 'main'`,
  /// so this is the parent's own session id). Absent on a root session.
  parentSessionId?: string
  /// `'root'` when this session is itself a parent (provider-recorded
  /// children exist); `'child'` when it is a subagent of another session.
  /// Mutually exclusive for the providers that currently record lineage.
  role: 'root' | 'child'
  /// The single supported evidence class: the provider wrote the link
  /// durably (not inferred). `provider-recorded` is the only value this
  /// field ever holds; the discriminator exists so a future evidence class
  /// (e.g. inferred) cannot silently downgrade strictness.
  evidence: 'provider-recorded'
}

export type SessionSummary = {
  sessionId: string
  project: string
  /// Exact working directory recorded by the provider before git-worktree
  /// canonicalization. Used to correlate sessions from different AI tools that
  /// worked in the same checkout. Never synthesized from timestamps.
  workingDirectory?: string
  /// How this session became associated with its PR links. Native transcript
  /// links are strongest; the other sources are deterministic cross-provider
  /// correlations performed after all saved sessions have been parsed.
  prAttributionSource?: 'transcript' | 'explicit-reference' | 'working-directory' | 'launcher-prompt'
  source?: SessionSourceMetadata
  /// Claude Code only: true when this record is a subagent (sidechain)
  /// transcript rather than a user-started parent session. Sidechain spend is
  /// real and remains in every cost/token/call aggregate; consumers that reason
  /// about human session populations may exclude it explicitly.
  isSidechain?: boolean
  // Claude Code only: agent type of a subagent transcript session
  // (`workflow-subagent`, `Explore`, `general-purpose`, …); undefined for
  // ordinary sessions. Drives the Claude-scoped agent-type breakdown.
  agentType?: string
  /// OMP nested-agent file stem. Kept separate from Claude's agentType metadata.
  agentName?: string
  /// OMP nested-agent session-header timestamp.
  agentStartedAt?: string
  /// Claude Code only: for a sidechain (subagent) transcript, the id of the
  /// session that spawned it (the transcript's internal `sessionId`, which is the
  /// parent, cross-checked against the owning directory). Lets by-PR attribution
  /// fold this session's spend into the parent turn that launched it. Undefined
  /// for ordinary (non-sidechain) sessions.
  parentSessionId?: string
  /// Claude Code only: the subagent id of a sidechain transcript (its filename
  /// basename with the `agent-` prefix stripped), matching the parent's
  /// `agentSpawnLinks` keys. Undefined for ordinary sessions.
  agentId?: string
  /// Claude Code only: on a PARENT session, maps each spawned subagent's id to the
  /// `tool_use` id of the `Agent`/`Task` block that launched it (from the spawn's
  /// `toolUseResult.agentId`). Combined with `spawnPrSets` it resolves a child to
  /// the PR the launching turn was working on. Absent when the session spawned no
  /// subagent that recorded a result.
  agentSpawnLinks?: Record<string, string>
  /// Claude Code only: on a PARENT session, maps each spawn `tool_use` id to the PR
  /// set active at the turn that emitted it, computed from the FULL (pre-date-slice)
  /// turn list. This lets a subagent fold into the right PR even when its launching
  /// turn falls outside the report's range. Empty array = spawn had no active PR
  /// (the child is then unattributed). Absent when the session spawned no subagent.
  spawnPrSets?: Record<string, string[]>
  /// Claude Code only: on a PARENT session, the agent ids whose spawn result named
  /// them (so we KNOW they were spawned here) but whose exact launching `tool_use`
  /// id could not be paired (an ambiguous multi-result record). Such a child that
  /// then lands just after the parent's last turn is folded to that turn within a
  /// grace window rather than lost. Absent when no pairing was ambiguous.
  ambiguousSpawnAgentIds?: string[]
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
  /// GitHub PR URLs captured or deterministically correlated for this session
  /// (session-level, deduplicated). Absent when none were observed.
  prLinks?: string[]
  /// The PR set active at the start of the in-range turn slice: the refs of the
  /// last turn BEFORE the report's range start that referenced any PR. Captured
  /// pre-filter (like `everHadBranch`) so per-turn PR attribution can carry a
  /// reference made before the window into its later, in-range, ref-less turns.
  /// Absent when no PR was referenced before the range (or no range filter).
  prRefsAtRangeStart?: string[]
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
  modelBreakdown: Record<string, { calls: number; costUSD: number; tokens: TokenUsage; savingsUSD: number; estimatedCostUSD?: number; activeDurationMs?: number; activeGeneratedTokens?: number; toolWaitMs?: number }>
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
  /// Provider-recorded parent/child lineage (CB-1, slice 1). Set only when
  /// the parser captured durable provider evidence (see SessionLineage);
  /// absent for sessions with no such evidence. The per-provider
  /// `parentSessionId` / `agentSpawnLinks` / `agentId` fields above remain
  /// the source of truth for by-PR subagent folding and are kept populated
  /// independently of this field.
  lineage?: SessionLineage
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
  /// Claude Code only: PR-linked parent sessions whose OWN turns all fell outside
  /// the report range but which spawned an in-range subagent. Kept ONLY as fold
  /// anchors for by-PR subagent attribution; they carry no in-range spend and are
  /// deliberately NOT in `sessions`, so they never touch session counts, averages,
  /// or any other per-session report. Consumed only by the by-PR resolver. Absent
  /// when none.
  subagentAnchors?: SessionSummary[]
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
