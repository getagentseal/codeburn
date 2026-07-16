export type QuotaWindow = {
  label: string
  percent: number
  resetsAt: string | null
}

export type QuotaProvider = {
  provider: 'claude' | 'codex'
  connection: 'connected' | 'disconnected' | 'accessDenied' | 'loading' | 'stale' | 'transientFailure' | 'terminalFailure'
  primary: QuotaWindow | null
  details: QuotaWindow[]
  planLabel: string | null
  footerLines: string[]
  /** Set when the provider is in a 429 backoff window (rate limited by the
   *  upstream quota endpoint), so the UI can say so honestly instead of the
   *  generic "waiting" copy. */
  rateLimited?: boolean
}

export type ProviderName = QuotaProvider['provider']

