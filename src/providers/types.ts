import type { BillingMode, BillingResult } from '../billing.js'

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
  /// Augment credits consumed for this call. null means no billing data available
  /// (e.g., non-Augment provider or legacy session), 0 means zero usage, positive
  /// means actual credits consumed.
  /// DEPRECATED: Use billing.creditsAugment instead. Kept for back-compat.
  credits?: number | null
  /// Session-level credit usage (fast-path). When present on any call in a session,
  /// this is Augment's authoritative session total (already deduped, includes sub-agents).
  /// The parser should prefer this over summing per-call credits for session totals.
  /// Per-call credits are still used for per-model breakdowns.
  sessionCreditUsage?: number | null
  /// Full billing result from computeBilling(). Present when billing engine is active.
  billing?: BillingResult | null
}

export type Provider = {
  name: string
  displayName: string
  modelDisplayName(model: string): string
  toolDisplayName(rawTool: string): string
  discoverSessions(): Promise<SessionSource[]>
  createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser
}
