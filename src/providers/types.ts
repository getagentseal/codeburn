import type { DateRange, ToolCall } from '../types.js'

export type SessionSource = {
  path: string
  project: string
  provider: string
  sourceId?: string
  sourceLabel?: string
  sourcePath?: string
  sourceKind?: 'claude-config' | 'claude-desktop'
  // OMP stores each crewmate transcript under its parent-session directory.
  // These fields retain that per-agent identity through the shared cache path.
  agentName?: string
  agentStartedAt?: string
  // This file IS the durable record of its provider's usage — copilot's
  // session-store.db, whose crash-only rows have no rollup to fall back to —
  // rather than a journal the provider could re-emit. Two effects:
  //   * it is parsed AFTER every other source of its provider in a pass, and
  //     one served from cache that moves mid-pass marks the pass incomplete,
  //     so a rollup is never reconciled against rows that had not landed;
  //   * it is exempt from the 90-day age-out while still discovered. Since
  //     #992 that exemption is redundant (only ORPHANS age out) — kept as the
  //     explicit statement of intent, not as the thing enforcing it.
  retainWhilePresent?: boolean
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
  // Copilot session-store rows only: the store's `initiator` column, when the
  // schema has it AND the CLI populated it. Only 'compaction' changes
  // accounting - that row is the CLI summarizing its own context, so it has no
  // assistant.message to pair with and its usage belongs to the compaction
  // that reset the rollup. Absent on older stores and on many rows of newer
  // ones, so nothing may depend on it being there.
  initiator?: string
  // Copilot shutdown rollups only: the stamp of the last SUCCESSFUL in-session
  // compaction before this leg. A compaction resets the CLI's rollup counters,
  // so the leg describes only the requests after it; serve-time reconciliation
  // starts the leg's store-row subtraction interval here instead of at the
  // previous leg. Omitted when the leg contains no compaction.
  compactedAt?: string
  // Copilot session-store billing metadata. total_nano_aiu is the request's
  // charged AI-credit amount in nano-AIU (1e9 nano-AIU = 1 credit = $0.01);
  // plan math sums finite nanoAiu. request_multiplier stays capture-only
  // (billing-grade cost rewrite is upstream #890).
  nanoAiu?: number
  requestMultiplier?: number
  turnId?: string
  toolSequence?: ToolCall[][]
  userMessage: string
  sessionId: string
  project?: string
  projectPath?: string
  // GitHub PR URLs observed in this call's transcript (Hermes and similar).
  prLinks?: string[]
  // Hermes observation-time deltas persist this flag (and reconstruct it at
  // serve time from a `:obs:` key). Copilot still assigns it only at serve time.
  supplementaryAccounting?: boolean
  // Exact provider-recorded cwd, kept separately because projectPath may later
  // canonicalize a linked worktree to its main repository.
  workingDirectory?: string
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
  // (e.g. VS Code's OTel agent-traces.db). Cached entries are never evicted on
  // ordinary refreshes, and orphaned entries (paths no longer discovered) are
  // kept and included in query-time aggregation so the monthly total never
  // drops. All entries are subject to the 90-day age-out unless their source
  // declares retainWhilePresent (see SessionSource).
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
