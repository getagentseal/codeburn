export type Impact = 'high' | 'medium' | 'low'
export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F'

/// Where a paste-style suggestion belongs. Without this, users couldn't tell
/// whether a prompt should go into CLAUDE.md (permanent rule), be pasted at
/// the start of a future session (one-time constraint), be asked of Claude
/// in the current chat (one-time prompt), or be added to a shell config file.
/// Issue #277 — users were dropping one-time session openers into CLAUDE.md
/// permanently because the destination wasn't clearly stated.
export type PasteDestination =
  | 'claude-md'        // permanent project rule, append to CLAUDE.md
  | 'session-opener'   // one-time paste at the start of a NEW session
  | 'prompt'           // one-time ask in the current Claude conversation
  | 'shell-config'     // append to ~/.zshrc / ~/.bashrc

export type WasteAction =
  | { type: 'paste'; label: string; text: string; destination?: PasteDestination }
  | { type: 'command'; label: string; text: string }
  | { type: 'file-content'; label: string; path: string; content: string }

export type Trend = 'active' | 'improving'

export type WasteFinding = {
  title: string
  explanation: string
  impact: Impact
  tokensSaved: number
  fix: WasteAction
  trend?: Trend
}

export type OptimizeResult = {
  findings: WasteFinding[]
  costRate: number
  healthScore: number
  healthGrade: HealthGrade
}

export type ToolCall = {
  name: string
  input: Record<string, unknown>
  sessionId: string
  project: string
  recent?: boolean
}

export type ApiCallMeta = {
  cacheCreationTokens: number
  version: string
  recent?: boolean
}

export type ScanData = {
  toolCalls: ToolCall[]
  projectCwds: Set<string>
  apiCalls: ApiCallMeta[]
  userMessages: string[]
}

export type ScanFileResult = {
  calls: ToolCall[]
  cwds: string[]
  apiCalls: ApiCallMeta[]
  userMessages: string[]
}

export type McpConfigEntry = { normalized: string; original: string; mtime: number }

/**
 * Per-server breakdown of MCP tool inventory vs invocations, computed from the
 * `mcpInventory` field captured by the Claude parser.
 *
 * Each session that loaded a server contributes its observed tool list to
 * the union for that server. Invocations come from the existing
 * `mcpBreakdown` per-call counts plus the parser's `call.tools` stream.
 */
export type McpServerCoverage = {
  server: string
  toolsAvailable: number
  toolsInvoked: number
  unusedTools: string[]
  invocations: number
  loadedSessions: number
  coverageRatio: number
}

export type McpSchemaCostEstimate = {
  cacheWriteTokens: number
  cacheReadTokens: number
  effectiveInputTokens: number
}

export type LowWorthCandidate = {
  project: string
  sessionId: string
  date: string
  cost: number
  tokens: number
  reasons: string[]
}

export type ContextBloatCandidate = {
  project: string
  sessionId: string
  date: string
  effectiveInputTokens: number
  outputTokens: number
  ratio: number
  excessInputTokens: number
  growthRatio: number | null
}

export type TrendInputs = {
  recentCount: number
  recentWindowMs: number
  baselineCount: number
  baselineWindowMs: number
  hasRecentActivity: boolean
}

export type CacheEntry = { data: OptimizeResult; ts: number }
