/// Shape of the JSON returned by `codeburn status --format menubar-json`. Kept in sync with
/// `src/menubar-json.ts` (CLI) and `mac/Sources/CodeBurnMenubar/Data/MenubarPayload.swift`
/// (macOS app). Any field change there must land here too or the frontend silently drops it.
export type MenubarPayload = {
  generated: string
  current: {
    label: string
    cost: number
    calls: number
    sessions: number
    sessionCountBasis?: 'identity' | 'partial'
    oneShotRate: number | null
    inputTokens: number
    outputTokens: number
    cacheHitPercent: number
    topActivities: Activity[]
    topModels: Model[]
    /// Counterfactual spend avoided by routing calls to a local model, from the
    /// mappings `codeburn model-savings` keeps. Absent on older CLI payloads.
    localModelSavings?: LocalModelSavings
    /// What re-asking cost, and what the same edits would have cost on a cheaper model.
    /// Both absent on older CLI payloads.
    retryTax?: RetryTax
    routingWaste?: RoutingWaste
    /// Where the money went, by repository and by session. Empty on older CLI payloads.
    topProjects?: ProjectEntry[]
    topSessions?: TopSessionEntry[]
    /// Cost per accepted edit and one-shot rate per model, which is what the mac's Pulse
    /// caption names its cheapest and dearest model from. Empty on older CLI payloads.
    modelEfficiency?: Array<{ name: string; costPerEdit: number | null; oneShotRate: number | null }>
    /// What the agent reached for. Empty on older CLI payloads.
    tools?: Array<{ name: string; calls: number }>
    skills?: Array<{ name: string; turns: number; cost: number }>
    subagents?: Array<{ name: string; calls: number; cost: number }>
    mcpServers?: Array<{ name: string; calls: number }>
    /// Spend attributed to pull requests. Emitted for all-provider payloads only, so a
    /// provider-scoped view has none and the section hides.
    pullRequests?: { rows: PullRequestRow[] }
    providers: Record<string, number>
    providerDetails?: Array<{
      id: string
      label: string
      cost: number
      calls?: number
      hasUsage?: boolean
      sessions?: number
      sessionCountBasis?: 'identity' | 'partial'
    }>
  }
  optimize: {
    findingCount: number
    savingsUSD: number
    topFindings: Array<{ title: string; impact: 'high' | 'medium' | 'low'; savingsUSD: number }>
  }
  history: { daily: DailyEntry[] }
  /// Totals from every paired device, present only under `--scope combined` and only
  /// when pulling the peers worked. The CLI treats it as best-effort enrichment.
  combined?: CombinedUsage
  /// Claude config directories the CLI found. Emitted only when there is more than one,
  /// which is exactly when the picker is worth showing.
  claudeConfigs?: { selectedId?: string | null; options: ClaudeConfigOption[] }
}

export type ClaudeConfigOption = {
  id: string
  label: string
  path: string
}

export type CombinedUsage = {
  perDevice: CombinedDevice[]
  combined: {
    cost: number
    calls: number
    sessions: number
    inputTokens: number
    outputTokens: number
    deviceCount: number
    reachableCount: number
  }
}

export type CombinedDevice = {
  id: string
  name: string
  local: boolean
  error?: string | null
  cost: number
  totalTokens: number
}

export type Activity = {
  name: string
  cost: number
  turns: number
  oneShotRate: number | null
}

export type Model = {
  name: string
  cost: number
  /// What this model would have cost at its paid baseline. Zero for every paid model.
  savingsUSD?: number
  calls: number
}

export type LocalModelSavings = {
  totalUSD: number
  calls: number
}

export type PullRequestRow = {
  url: string
  label: string
  cost: number
  sessions: number
}

export type ProjectEntry = {
  name: string
  cost: number
  sessions: number
  avgCostPerSession?: number
  sessionCountBasis?: 'identity' | 'partial'
  sessionDetails?: SessionDetailEntry[]
}

export type SessionDetailEntry = {
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  date: string
  models?: Array<{ name: string; cost: number }>
}

export type TopSessionEntry = {
  project: string
  cost: number
  calls: number
  date: string
}

export type RetryTax = {
  totalUSD: number
  retries: number
  editTurns: number
  byModel: Array<{ name: string; taxUSD: number; retries: number; retriesPerEdit?: number | null }>
}

export type RoutingWaste = {
  totalSavingsUSD: number
  baselineModel: string
  baselineCostPerEdit: number
  byModel: Array<{
    name: string
    costPerEdit: number
    editTurns: number
    actualUSD: number
    counterfactualUSD: number
    savingsUSD: number
  }>
}

export type DailyModel = {
  name: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
}

export type DailyEntry = {
  date: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  topModels?: DailyModel[]
}
