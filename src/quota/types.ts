export type QuotaWindow = {
  label: string
  percent: number
  resetsAt: string | null
}

export type QuotaProvider = {
  provider: 'claude' | 'codex' | 'gemini' | 'copilot' | 'antigravity' | 'kimi' | 'cursor' | 'zai' | 'grok' | 'clinepass'
  connection: 'connected' | 'disconnected' | 'accessDenied' | 'loading' | 'stale' | 'transientFailure' | 'terminalFailure'
  primary: QuotaWindow | null
  details: QuotaWindow[]
  planLabel: string | null
  footerLines: string[]
  /** Set when the provider is in a 429 backoff window (rate limited by the
   *  upstream quota endpoint), so the UI can say so honestly instead of the
   *  generic "waiting" copy. */
  rateLimited?: boolean
  /** Facts that belong in `codeburn quota` output, not only in a hover card:
   *  a `footerLines` entry is a detail panel row, a note is printed under the
   *  provider's windows in the table and carried in `--format json`. */
  notes?: string[]
}

export type ProviderName = QuotaProvider['provider']

