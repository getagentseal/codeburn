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
  costUSD: number
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
