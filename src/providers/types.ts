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
  timestamp: string
  speed: 'standard' | 'fast'
  deduplicationKey: string
  turnId?: string
  toolSequence?: ToolCall[][]
  userMessage: string
  sessionId: string
  chatTitle?: string
  projectTitle?: string
  project?: string
  projectPath?: string
  metadataOnly?: boolean
}

export type Provider = {
  name: string
  displayName: string
  // Data comes from a live API fetch (no on-disk file). Such sources can't be
  // fingerprinted or incrementally cached, so the parser re-fetches every run.
  network?: boolean
  modelDisplayName(model: string): string
  toolDisplayName(rawTool: string): string
  discoverSessions(): Promise<SessionSource[]>
  createSessionParser(source: SessionSource, seenKeys: Set<string>, dateRange?: DateRange): SessionParser
}
