import type { DateRange, ToolCall } from '../types.js'

export type SessionSource = {
  path: string
  project: string
  provider: string
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
  turnId?: string
  toolSequence?: ToolCall[][]
  userMessage: string
  sessionId: string
  project?: string
  projectPath?: string
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
}
