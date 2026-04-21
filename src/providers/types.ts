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
  tools: string[]
  bashCommands: string[]
  timestamp: string
  speed: 'standard' | 'fast'
  deduplicationKey: string
  userMessage: string
  sessionId: string
}

export type Provider = {
  name: string
  displayName: string
  modelDisplayName(model: string): string
  toolDisplayName(rawTool: string): string
  discoverSessions(): Promise<SessionSource[]>
  createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser
}
