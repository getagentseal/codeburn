export type QuotaWindow = {
  label: string
  percent: number
  resetsAt: string | null
}

export type QuotaProvider = {
  provider: 'claude' | 'codex' | 'gemini' | 'copilot' | 'antigravity' | 'kimi' | 'grokbot'
  connection: 'connected' | 'disconnected' | 'accessDenied' | 'loading' | 'stale' | 'transientFailure' | 'terminalFailure'
  primary: QuotaWindow | null
  details: QuotaWindow[]
  planLabel: string | null
  footerLines: string[]
  /** Set when the provider is in a 429 backoff window (rate limited by the
   *  upstream quota endpoint), so the UI can say so honestly instead of the
   *  generic "waiting" copy. */
  rateLimited?: boolean
  /** Set when the failure is an authentication expiry the user can fix by
   *  (re)connecting — a 401/403 from the quota endpoint or an expired token —
   *  as opposed to a genuinely terminal state (retired tier, no allowance). The
   *  UI shows the Connect affordance only when this is set. */
  connectable?: boolean
}

export type ProviderName = QuotaProvider['provider']

