// Types mirrored verbatim from the codeburn CLI (`src/*`). The renderer is a
// pure view over CLI JSON, so these shapes must match the emitters exactly.
// Do not invent fields — copy from the cited source files.

// ————— Period + IPC error contract —————

export type Period = 'today' | 'week' | '30days' | 'month' | 'all' | 'lifetime'

export type DateRange = { from: string; to: string }

export type CliErrorKind = 'not-found' | 'nonzero' | 'bad-json' | 'timeout' | 'too-large' | 'bad-args'

/** Structured failure surfaced across the IPC boundary as plain data. */
export interface CliError {
  kind: CliErrorKind
  message: string
}

export type AliasRow = { from: string; to: string }
export type ActionResult = { ok: boolean; stdout: string; stderr: string; code: number | null }

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
  /** True when the provider is in a 429 backoff window (upstream rate limit). */
  rateLimited?: boolean
}

// ————— src/menubar-json.ts —————

export type DailyModelBreakdown = {
  name: string
  cost: number
  savingsUSD: number
  calls: number
  inputTokens: number
  outputTokens: number
}

export type DailyHistoryEntry = {
  date: string
  cost: number
  savingsUSD: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  topModels: DailyModelBreakdown[]
}

export type LocalModelSavings = {
  totalUSD: number
  calls: number
  byModel: Array<{
    name: string
    calls: number
    actualUSD: number
    savingsUSD: number
    baselineModel: string
    inputTokens: number
    outputTokens: number
  }>
  byProvider: Array<{ name: string; calls: number; savingsUSD: number }>
}

export type DeviceSummary = {
  id: string
  name: string
  local: boolean
  error?: string
  cost: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  totalTokens: number
}

export type CombinedUsage = {
  perDevice: DeviceSummary[]
  combined: {
    cost: number
    calls: number
    sessions: number
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
    totalTokens: number
    deviceCount: number
    reachableCount: number
  }
}

export type ClaudeConfigOption = {
  id: string
  label: string
  path: string
}

export type ClaudeConfigSelector = {
  selectedId: string | null
  options: ClaudeConfigOption[]
}

export type MenubarPayload = {
  generated: string
  current: {
    label: string
    cost: number
    calls: number
    sessions: number
    oneShotRate: number | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cacheHitPercent: number
    codexCredits: number
    topActivities: Array<{
      name: string
      cost: number
      savingsUSD: number
      turns: number
      oneShotRate: number | null
    }>
    topModels: Array<{
      name: string
      cost: number
      savingsUSD: number
      savingsBaselineModel: string
      calls: number
    }>
    unpricedModels?: Array<{ model: string; calls: number; tokens: number }>
    localModelSavings: LocalModelSavings
    providers: Record<string, number>
    // Optional: older CLIs omit it. `id` is the internal provider name (round-trips
    // as --provider), `label` the display name. Fall back to `providers` when absent.
    providerDetails?: Array<{ id: string; label: string; cost: number }>
    topProjects: Array<{
      name: string
      cost: number
      savingsUSD: number
      sessions: number
      avgCostPerSession: number
      sessionDetails: Array<{
        cost: number
        savingsUSD: number
        calls: number
        inputTokens: number
        outputTokens: number
        date: string
        models: Array<{ name: string; cost: number; savingsUSD: number }>
      }>
    }>
    modelEfficiency: Array<{
      name: string
      costPerEdit: number | null
      oneShotRate: number | null
    }>
    topSessions: Array<{
      project: string
      cost: number
      savingsUSD: number
      calls: number
      date: string
    }>
    // Workflow-intelligence rollups (src/menubar-json.ts buildWorkflow /
    // buildTopReworkedFiles). Optional: older CLIs omit them, so the Overview
    // workflow card renders only when they are present with real signal.
    workflow?: {
      corrections: number
      correctionRate: number | null
      medianTimeToFirstEditMs: number | null
    }
    // Files most reworked by edit-family calls, basename-only, ranked by
    // distinct sessions then edits (src/menubar-json.ts buildTopReworkedFiles).
    topReworkedFiles?: Array<{ path: string; sessions: number; edits: number }>
    // Share (0-1) of cost-bearing calls that resolved a price. Below 1 means some
    // usage priced against no table entry; null when not computable.
    pricingCoverage?: number | null
    retryTax: {
      totalUSD: number
      retries: number
      editTurns: number
      byModel: Array<{
        name: string
        taxUSD: number
        retries: number
        retriesPerEdit: number | null
      }>
    }
    routingWaste: {
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
    tools: Array<{ name: string; calls: number }>
    skills: Array<{ name: string; turns: number; cost: number }>
    subagents: Array<{ name: string; calls: number; cost: number }>
    mcpServers: Array<{ name: string; calls: number }>
    // Spend by referenced pull request (every PR, cost-descending), attributed at turn
    // granularity. Optional: older CLIs omit it, and it is absent when no PR links
    // were observed. Rows carry attributed cost/calls and ARE summable;
    // `attributedCost + unattributedCost === distinctCost`. `approx` marks a row
    // fed by the legacy whole-session even split (transcript expired). `models` is
    // the short model names that processed the PR (cost-desc); `categories` is the
    // per-task-category attributed cost (cost-desc), omitted for legacy rows.
    // `attributedCost`/`unattributedCost` are optional so a payload from an older
    // CLI (by-reference rows, not summable) still type-checks and can be detected.
    pullRequests?: {
      rows: Array<{
        url: string
        label: string
        cost: number
        savingsUSD: number
        sessions: number
        calls: number
        firstStarted: string
        lastEnded: string
        approx?: boolean
        models?: string[]
        categories?: Array<{ name: string; cost: number }>
      }>
      distinctCost: number
      distinctSessions: number
      // Count of subagent (sidechain) runs folded into the PR-linked parent
      // sessions. Optional (absent when none folded, or from an older producer).
      subagentSessions?: number
      attributedCost?: number
      unattributedCost?: number
    }
  }
  optimize: {
    findingCount: number
    savingsUSD: number
    topFindings: Array<{
      title: string
      impact: 'high' | 'medium' | 'low'
      savingsUSD: number
    }>
  }
  history: {
    daily: DailyHistoryEntry[]
  }
  // Active display currency. Payload costs are raw USD; the renderer multiplies by
  // `rate` and prefixes `symbol` at display time. Optional: older CLIs omit it.
  currency?: { code: string; symbol: string; rate: number }
  combined?: CombinedUsage
  claudeConfigs?: ClaudeConfigSelector
}

// ————— src/types.ts + src/models-report.ts —————

export type TaskCategory =
  | 'coding'
  | 'debugging'
  | 'feature'
  | 'refactoring'
  | 'testing'
  | 'exploration'
  | 'planning'
  | 'delegation'
  | 'git'
  | 'build/deploy'
  | 'conversation'
  | 'brainstorming'
  | 'general'

export type ModelReportRow = {
  provider: string
  providerDisplayName: string
  model: string
  modelDisplayName: string
  category: TaskCategory | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  totalTokens: number
  costUSD: number
  savingsUSD: number
  savingsBaselineModel: string
  calls: number
  credits: number | null
  topCategory?: TaskCategory
  topCategoryCost?: number
  topCategoryShare?: number
}

// ————— src/yield.ts —————

export type YieldCategory = 'productive' | 'reverted' | 'abandoned'

export type YieldBucketJson = {
  costUSD: number
  sessions: number
  costPercent: number
  sessionPercent: number
}

export type SessionYieldJson = {
  sessionId: string
  project: string
  category: YieldCategory
  commitCount: number
  costUSD: number
}

export type YieldJsonReport = {
  period: {
    label: string
    start: string
    end: string
  }
  summary: {
    productive: YieldBucketJson
    reverted: YieldBucketJson
    abandoned: YieldBucketJson
    total: { costUSD: number; sessions: number }
    productiveToRevertedCostRatio: number | null
  }
  details: SessionYieldJson[]
}

// ————— src/config.ts + src/plan-usage.ts + src/main.ts (status --format json) —————

export type PlanId =
  | 'claude-pro'
  | 'claude-max'
  | 'claude-max-5x'
  | 'cursor-pro'
  | 'supergrok'
  | 'supergrok-heavy'
  | 'custom'
  | 'none'
export type PlanProvider = 'claude' | 'codex' | 'cursor' | 'grok' | 'all'
export type PlanStatus = 'under' | 'near' | 'over'

/** Serialized plan summary from `attachPlanSummaries` (src/main.ts:90). */
export type JsonPlanSummary = {
  id: PlanId
  provider: PlanProvider
  budget: number
  spent: number
  percentUsed: number
  status: PlanStatus
  projectedMonthEnd: number
  daysUntilReset: number
  periodStart: string
  periodEnd: string
}

/** `codeburn status --format json` payload (src/main.ts:751), with plan summaries attached. */
export type StatusJson = {
  currency: string
  today: { cost: number; savings: number; calls: number }
  month: { cost: number; savings: number; calls: number }
  localModelSavings?: { today: number; month: number; callsToday: number; callsMonth: number }
  plan?: JsonPlanSummary
  plans?: Partial<Record<PlanProvider, JsonPlanSummary>>
}

// ————— T1a: src/spend-flow.ts (defined by the shared contract) —————

export type SpendFlowNode = { id: string; label: string; cost: number }
export type SpendFlowLink = { model: string; project: string; cost: number }
export type SpendFlow = {
  period: { label: string; start: string; end: string }
  models: SpendFlowNode[]
  projects: SpendFlowNode[]
  links: SpendFlowLink[]
}

// ————— src/optimize.ts —————

export type WasteAction =
  | { type: 'paste'; label: string; text: string; destination?: 'claude-md' | 'session-opener' | 'prompt' | 'shell-config' }
  | { type: 'command'; label: string; text: string }
  | { type: 'file-content'; label: string; path: string; content: string }

export type OptimizeJsonReport = {
  period: { label: string; start: string | null; end: string | null }
  summary: {
    healthScore: number
    healthGrade: 'A' | 'B' | 'C' | 'D' | 'F'
    findingCount: number
    periodCostUSD: number
    sessions: number
    calls: number
    potentialSavingsTokens: number
    potentialSavingsCostUSD: number
    potentialSavingsPercent: number | null
    costRateUSD: number
  }
  findings: Array<{
    id: string
    title: string
    explanation: string
    severity: 'high' | 'medium' | 'low'
    trend: 'active' | 'improving' | null
    tokensSaved: number
    estimatedSavingsUSD: number
    fix: WasteAction
  }>
}

// ————— T1b: src/sharing/* (defined by the shared contract) —————

export type PendingPairing = { id: string; name: string; code: string }
export type ShareStatus = {
  sharing: boolean
  name: string
  port: number
  always: boolean
  peers: number
  pending: PendingPairing[]
}

/** Public identity subset served by /api/identity (src/web-dashboard.ts:229). */
export type Identity = {
  name: string
  fingerprint: string
}

export type ScannedDevice = {
  name: string
  host: string
  port: number
  fingerprint: string
  code: string
  paired: boolean
}
export type DeviceScanResult = { found: ScannedDevice[] }

// ————— src/act/report.ts buildActReportJson —————

export type ActReportJson = {
  totals: {
    realizedCostUSD: number
    measuredActions: number
  }
}

// ————— src/sessions-report.ts —————
export type SessionRow = {
  sessionId: string
  // Captured human title (src/sessions-report.ts). Empty string when the
  // transcript produced none; optional so older CLIs that predate the field
  // render unchanged (the row falls back to the project as its primary label).
  title?: string
  project: string
  provider: string
  models: string[]
  cost: number
  savingsUSD: number
  calls: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  startedAt: string
  endedAt: string
  durationMs: number
}

// ————— src/compare-stats.ts —————
export type ModelStats = {
  model: string
  calls: number
  cost: number
  outputTokens: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTurns: number
  editTurns: number
  oneShotTurns: number
  retries: number
  selfCorrections: number
  editCost: number
  firstSeen: string
  lastSeen: string
}
export type ComparisonRow = {
  section: string
  label: string
  valueA: number | null
  valueB: number | null
  formatFn: 'cost' | 'number' | 'percent' | 'decimal'
  winner: 'a' | 'b' | 'tie' | 'none'
}
export type CategoryComparison = {
  category: string
  turnsA: number
  editTurnsA: number
  oneShotRateA: number | null
  turnsB: number
  editTurnsB: number
  oneShotRateB: number | null
  winner: 'a' | 'b' | 'tie' | 'none'
}
export type WorkingStyleRow = {
  label: string
  valueA: number | null
  valueB: number | null
  formatFn: ComparisonRow['formatFn']
}
export type CompareJsonReport = {
  period: { label: string; provider: string }
  modelA: ModelStats
  modelB: ModelStats
  metrics: ComparisonRow[]
  categories: CategoryComparison[]
  workingStyle: WorkingStyleRow[]
}

// ————— src/models.ts + src/audit-report.ts (audit --format json) —————

/** Per-token rates used for pricing (src/models.ts ModelCosts). */
export type ModelCosts = {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheWriteCostPerToken: number
  cacheReadCostPerToken: number
  webSearchCostPerRequest: number
  fastMultiplier: number
}

/** One (provider, model) audit bucket (src/audit-report.ts AuditRow): raw
 * provider token fields vs the normalized totals codeburn prices. */
export type AuditRow = {
  provider: string
  providerDisplayName: string
  model: string
  modelDisplayName: string
  calls: number
  raw: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    cachedInputTokens: number
    webSearchRequests: number
  }
  displayed: {
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
  }
  rates: ModelCosts | null
  cost: {
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
    webSearch: number
    recomputedTotalUSD: number
  }
  attributedCostUSD: number
}

// ————— src/main.ts (price-override --list --format json) —————

/** Rates are USD per 1,000,000 tokens; cache rates are optional. */
export type PriceOverrideRow = {
  model: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM?: number
  cacheCreationPerM?: number
}
export type PriceOverrideList = { overrides: PriceOverrideRow[]; configPath: string }
/** A partial set of the four price-override rates, USD per 1M tokens. */
export type PriceRates = { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }

// ————— IPC surface (preload contextBridge → window.codeburn) —————

/** Anonymous-telemetry consent state (app/electron/telemetry.ts). Null when
 * telemetry is unavailable in the main process. */
export type TelemetryStatus = {
  installId: string
  country: string | null
  enabled: boolean
  defaultEnabled: boolean
  onboarded: boolean
}

/** Cold-start scan progress streamed from the CLI warmup (src/parser.ts).
 * `cold` (on the `providers` event) is true only for a genuine full hydration;
 * a warm launch's incremental re-parse emits the same events without it. */
export type ScanProgressEvent =
  | { kind: 'providers'; providers: string[]; cold?: boolean }
  | { kind: 'provider'; provider: string; state: 'start' | 'done' | 'skipped'; files?: number }
  | { kind: 'tick'; provider: string; done: number; total: number }
  | { kind: 'done' }

/** Update-availability status from the main process (app/electron/updates.ts). */
export type UpdateStatus = {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  tag: string | null
}

export interface CodeburnBridge {
  /** Subscribe to cold-start scan progress; returns an unsubscribe fn. */
  onProgress(cb: (event: ScanProgressEvent) => void): () => void
  /** Read the cached update-availability status (launch + 24h background check). */
  getUpdateStatus(): Promise<UpdateStatus>
  /** Subscribe to pushed update-availability status; returns an unsubscribe fn. */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
  getQuota(force?: boolean): Promise<QuotaProvider[]>
  // `background` (prefetch only) requests background CLI-spawn priority; optional
  // so an older preload that ignores it degrades to interactive priority.
  getOverview(period: Period, provider: string, range?: DateRange, configSource?: string | null, background?: boolean): Promise<MenubarPayload>
  getPlans(period: Period): Promise<StatusJson>
  getActReport(): Promise<ActReportJson>
  readonly platform: string
  /** Node process.arch of the host ('arm64', 'x64', ...). Absent on preloads
   *  that predate the direct-download update link. */
  readonly arch?: string
  getModels(period: Period, provider: string, byTask: boolean, range?: DateRange): Promise<ModelReportRow[]>
  getSessions(period: Period, provider: string, range?: DateRange): Promise<SessionRow[]>
  getCompareModels(period: Period, provider: string): Promise<ModelStats[]>
  getCompare(period: Period, provider: string, modelA: string, modelB: string): Promise<CompareJsonReport>
  getYield(period: Period, provider: string, range?: DateRange): Promise<YieldJsonReport>
  getSpendFlow(period: Period, provider: string, range?: DateRange): Promise<SpendFlow>
  getOptimizeReport(period: Period, provider: string, range?: DateRange): Promise<OptimizeJsonReport>
  getDevices(period: Period): Promise<CombinedUsage>
  getDevicesScan(): Promise<DeviceScanResult>
  getShareStatus(): Promise<ShareStatus>
  getIdentity(): Promise<Identity>
  getAliases(): Promise<AliasRow[]>
  getProxyPaths(): Promise<string[]>
  getAudit(period: Period, provider: string, range?: DateRange): Promise<AuditRow[]>
  getPriceOverrides(): Promise<PriceOverrideList>
  setPriceOverride(model: string, rates: PriceRates): Promise<ActionResult>
  removePriceOverride(model: string): Promise<ActionResult>
  setCurrency(code: string): Promise<ActionResult>
  resetCurrency(): Promise<ActionResult>
  addAlias(from: string, to: string): Promise<ActionResult>
  removeAlias(from: string): Promise<ActionResult>
  removeDevice(name: string): Promise<ActionResult>
  setPlan(id: string, provider: string): Promise<ActionResult>
  resetPlan(provider: string): Promise<ActionResult>
  exportData(format: string, provider: string, outPath: string): Promise<ActionResult>
  chooseDirectory(): Promise<string | null>
  cliStatus(): Promise<{ found: boolean; path: string | null; error?: string }>
  telemetryStatus(): Promise<TelemetryStatus | null>
  setTelemetryEnabled(enabled: boolean): Promise<TelemetryStatus | null>
  completeOnboarding(enabled: boolean): Promise<TelemetryStatus | null>
  telemetryTrack(name: string, props?: Record<string, unknown>): Promise<boolean>
  openExternal(url: string): Promise<void>
}
