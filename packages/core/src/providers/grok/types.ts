// Raw record + rich-decode types for the Grok Build provider.
//
// Grok stores one session per directory: <grok-home>/sessions/<url-encoded-cwd>/<uuid>/
// with summary.json, signals.json, and updates.jsonl. The host reads those files
// and hands the decoder a single composite record; the decoder is pure over that
// record and carries no pricing.

export type GrokSummary = {
  info?: { id?: string; cwd?: string }
  created_at?: string
  updated_at?: string
  last_active_at?: string
  current_model_id?: string
  session_summary?: string
  generated_title?: string
}

export type GrokSignals = {
  primaryModelId?: string
  modelsUsed?: string[]
  toolsUsed?: string[]
}

export type GrokUpdate = {
  params?: {
    _meta?: { totalTokens?: number; promptId?: string }
    update?: {
      sessionUpdate?: string
      title?: string
      rawInput?: { command?: unknown; subagent_type?: unknown }
    }
  }
}

/** The composite record the host hands to the core decoder for one session. */
export type GrokSessionRecords = {
  summary: GrokSummary
  signals: GrokSignals | null
  updatesLines: string[]
  /** Absolute session directory; fingerprinted into the host-side dedup key,
   *  never emitted raw. */
  sourceDir: string
  /** Basename of the session directory, used as a session id fallback. */
  sessionName: string
  /** Project name the host derived from the session cwd. */
  project: string
}

/** The rich decode of one Grok session, pre-pricing. */
export type GrokDecodedCall = {
  provider: 'grok'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  tools: string[]
  rawBashCommands: string[]
  subagentTypes: string[]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  userMessage: string
  sessionId: string
  /** Absolute project cwd; fingerprinted before it reaches an observation. */
  projectPath: string
  /** Project name the host uses for display/breakdown. */
  project: string
}
