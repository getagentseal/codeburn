import type { DateRange, ToolCall } from '../types.js'

export type SessionSource = {
  path: string
  project: string
  provider: string
  sourceId?: string
  sourceLabel?: string
  sourcePath?: string
  sourceKind?: 'claude-config' | 'claude-desktop'
}

export type SessionParser = {
  parse(): AsyncGenerator<ParsedProviderCall>
}

export type ParsedProviderCall = {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  // Optional so a decoder converted to the host-side pricing pass (see
  // src/pricing-pass.ts) can omit it and emit `costBasis: 'estimated'` instead;
  // the pass fills it in from the token buckets before any consumer reads it.
  // Unconverted decoders still set it directly.
  costUSD?: number
  // Set by decoders that no longer price themselves. 'estimated' => the pricing
  // pass computes costUSD from the token buckets; 'measured' => the decoder set
  // costUSD to a provider-reported dollar figure and the pass leaves it alone.
  // Orthogonal to `costIsEstimated`, which flags estimated *tokens* (e.g. char
  // counts) regardless of how the dollar amount was derived.
  costBasis?: 'measured' | 'estimated'
  // Model to price with when it differs from the display `model` (antigravity
  // strips agent/effort suffixes and applies pricing aliases before pricing).
  // Seam extension for the pricing pass: when set, the 'estimated' path prices
  // this model instead of `model`, so the decoder no longer needs the price
  // table. Absent for every provider whose display model IS its pricing model.
  pricingModel?: string
  // Seam extension for the pricing pass: a provider-reported dollar/credit figure
  // used ONLY as a fallback when the 'estimated' table price computes to 0 (the
  // model is unpriced). Preserves the "table cost preferred, provider figure only
  // for unknown models" precedence of codebuff credits and OpenCode/Cline session
  // cost, which is the inverse of `measured` (a figure that always wins). Ignored
  // unless costBasis is 'estimated'.
  fallbackCostUSD?: number
  costIsEstimated?: boolean
  tools: string[]
  bashCommands: string[]
  // Subagent types spawned in this call (e.g. 'general-purpose'). Feeds the
  // Skills & Agents breakdown; optional since most providers don't expose it.
  subagentTypes?: string[]
  // Skill names invoked in this call (e.g. 'commit'). Feeds the Skills & Agents
  // breakdown; optional since most providers don't expose it.
  skills?: string[]
  timestamp: string
  speed: 'standard' | 'fast'
  deduplicationKey: string
  // Lines added/removed by this call's edits, counted from the provider's diff
  // records (Codex: `patch_apply_end.changes[*].unified_diff`). Numbers only;
  // omitted when zero. `editFailed` counts patches with `success === false`.
  // Rich-session-capture (capture-only; no report yet).
  locAdded?: number
  locRemoved?: number
  editFailed?: number
  turnId?: string
  toolSequence?: ToolCall[][]
  userMessage: string
  sessionId: string
  project?: string
  projectPath?: string
  // Exact provider-recorded cwd, kept separately because projectPath may later
  // canonicalize a linked worktree to its main repository.
  workingDirectory?: string
  // Tool-excluded active throughput: `activeDurationMs` is the task duration
  // minus recorded tool-wait intervals, `activeGeneratedTokens` the task's
  // generated tokens, both attributed to this call proportionally (Codex only).
  // `toolWaitMs` is the excluded wait share. Present only when the enclosing
  // task recorded both timing and generated tokens.
  activeDurationMs?: number
  activeGeneratedTokens?: number
  toolWaitMs?: number
}

// A directory or database file that a provider's discoverSessions() scans.
// Reported by `codeburn doctor` so an empty or wrong result is self-diagnosable:
// the path is resolved exactly as discovery resolves it (honoring env overrides
// and configured dirs), and the doctor checks existence separately.
export type ProbeRoot = {
  path: string
  label: string
}

export type Provider = {
  name: string
  displayName: string
  // Data comes from a live API fetch (no on-disk file). Such sources can't be
  // fingerprinted or incrementally cached, so the parser re-fetches every run.
  network?: boolean
  // Source data is managed by an external process that may prune old records
  // (e.g. VS Code's OTel agent-traces.db). Cached entries for discovered paths
  // are never evicted, and orphaned entries (paths no longer discovered) are
  // kept and included in query-time aggregation so the monthly total never drops.
  durableSources?: boolean
  modelDisplayName(model: string): string
  toolDisplayName(rawTool: string): string
  discoverSessions(): Promise<SessionSource[]>
  createSessionParser(source: SessionSource, seenKeys: Set<string>, dateRange?: DateRange): SessionParser
  // The exact directories/dbs discoverSessions() scans, resolved the same way.
  // Optional: providers that implement it let `codeburn doctor` show and
  // existence-check the probed paths even when zero sessions are found (so
  // "tool not installed" vs "wrong override" is distinguishable). Providers
  // without it fall back to the paths of whatever sessions were discovered.
  probeRoots?(): Promise<ProbeRoot[]>
}
