/// Rollup of one time window (today / 7 days / 30 days / month / all) used as the canonical
/// input to the menubar payload. Built inside the CLI and also consumed by the day-aggregator
/// when hydrating per-day cache entries.
export type PeriodData = {
  label: string
  cost: number
  /// Counterfactual USD the same tokens would have cost on the paid
  /// baseline configured for each local model. Stays `0` when no
  /// `codeburn model-savings` mappings are active. Always shown
  /// separately from `cost` so the two never get summed into a "real
  /// spend" number by accident.
  savingsUSD: number
  /// Portion of `cost` priced from estimated tokens (see ParsedApiCall.isEstimated).
  /// Display/metadata only; never summed into `cost`. Optional so PeriodData
  /// producers predating the field keep compiling.
  estimatedCostUSD?: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /// Total Codex credits consumed in the period (issues #408/#495). Optional so
  /// non-menubar PeriodData producers don't have to compute it.
  codexCredits?: number
  categories: Array<{ name: string; cost: number; savingsUSD: number; turns: number; editTurns: number; oneShotTurns: number }>
  models: Array<{ name: string; cost: number; savingsUSD: number; calls: number; estimatedCostUSD?: number }>
  /// Models with usage in the period whose pricing lookup fails against the
  /// current tables (#638): their calls contribute $0 to `cost`. Optional so
  /// PeriodData producers that predate the field keep compiling.
  unpricedModels?: Array<{ model: string; calls: number; tokens: number }>
  projects?: Array<{ name: string; cost: number; savingsUSD: number; sessions: number; sessionDetails?: Array<{ cost: number; savingsUSD: number; calls: number; inputTokens: number; outputTokens: number; date: string; models: Array<{ name: string; cost: number; savingsUSD: number }> }> }>
  modelEfficiency?: Array<{ name: string; costPerEdit: number | null; oneShotRate: number | null }>
  topSessions?: Array<{ project: string; cost: number; savingsUSD: number; calls: number; date: string }>
  /// Workflow-intelligence rollups (issue: workflow intelligence). Optional so
  /// the day-aggregator PeriodData path (which has no per-turn data) can omit
  /// them; the fresh-parse payload path always sets them.
  workflow?: { corrections: number; correctionRate: number | null; medianTimeToFirstEditMs: number | null }
  /// Files most reworked by edit-family calls, relative to project root, ranked
  /// by distinct sessions then edits. Full (top 15) list; the payload basenames
  /// and trims it.
  topReworkedFiles?: ReworkedFile[]
  /// Share (0-1) of cost-bearing calls that resolved a price.
  pricingCoverage?: number
  /// Spend attributed by referenced pull request (from Claude session
  /// transcripts). Rows are by-reference — a session referencing several PRs
  /// counts toward EACH — so never sum them; `distinctCost`/`distinctSessions`
  /// are the multi-link-safe total. Absent when no PR links were observed.
  pullRequests?: PullRequestsPayload
  /// Per-branch spend, last-seen branch carried forward across each session's
  /// turns. A `null` branch is unbranched spend inside a branch-bearing session.
  /// Rows are by-reference (a session that switched branches counts toward each),
  /// so never sum them. Absent when no branch data was observed.
  byBranch?: BranchRow[]
}

export type PullRequestsPayload = {
  /// Per-PR rows, cost-descending, capped at the top 20 by the producer.
  rows: PrRow[]
  /// Distinct-session spend across every PR-linked session — the figure safe to
  /// present as a total, since the per-PR rows double-count sessions that
  /// reference more than one PR.
  distinctCost: number
  distinctSessions: number
}

export type ProviderCost = {
  /// Internal provider id (e.g. `grok`, `cursor-agent`). Round-trips back to the
  /// CLI as `--provider`, so it must stay the id, not the display name.
  name: string
  displayName: string
  cost: number
}
import type { OptimizeResult } from './optimize.js'
import { getCurrency } from './currency.js'
import type { GranularHistory } from './granular-history.js'
import type { ReworkedFile } from './workflow-insights.js'
import type { PrRow, BranchRow } from './sessions-report.js'

const TOP_ACTIVITIES_LIMIT = 20
const TOP_MODELS_LIMIT = 20
const TOP_FINDINGS_LIMIT = 10
const HISTORY_DAYS_LIMIT = 365
const SYNTHETIC_MODEL_NAME = '<synthetic>'
const TOP_PROJECTS_LIMIT = 5
const TOP_SESSIONS_LIMIT = 3
const MODEL_EFFICIENCY_LIMIT = 5
const TOP_REWORKED_FILES_LIMIT = 8

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
    /// Period-scoped cache token totals. Kept separate from `history.daily`
    /// (which is a 365-day backfill for the trend chart) so the web cache
    /// cards read the same range as Cost/Calls/Tokens (issue #583).
    cacheReadTokens: number
    cacheWriteTokens: number
    cacheHitPercent: number
    /// Codex credits consumed in the period; 0 when there is no Codex usage.
    codexCredits: number
    /// Portion of `cost` priced from estimated tokens (see ParsedApiCall.isEstimated).
    /// Machine-readable signal that distinguishes guessed spend from metered spend;
    /// display/metadata only, never summed into `cost`. Optional for compatibility
    /// with payloads produced before the field existed.
    estimatedCostUSD?: number
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
      /// Estimated portion of this model's `cost`; > 0 marks the row as priced
      /// from estimated tokens. Optional for payload back-compat.
      estimatedCostUSD?: number
    }>
    /// See PeriodData.unpricedModels: usage priced at $0 for lack of pricing
    /// data. Empty when every model in the period resolved a price. Optional
    /// so payload producers that predate the field stay source-compatible.
    unpricedModels?: Array<{ model: string; calls: number; tokens: number }>
    /// Local-model savings rollup, distinct from the routing-waste /
    /// optimize savings concepts which describe hypothetical optimization
    /// opportunities. This block tracks counterfactual spend that was
    /// already avoided because the user ran a local model mapped via
    /// `codeburn model-savings`.
    localModelSavings: LocalModelSavings
    providers: Record<string, number>
    /// Provider identity alongside the `providers` map: `id` is the internal
    /// provider name (round-trips as `--provider`), `label` the display name.
    /// The `providers` map keys stay lowercased display names for compatibility.
    providerDetails: Array<{ id: string; label: string; cost: number }>
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
    /// Workflow-intelligence rollup for the period. `unansweredSessions` is
    /// add-only and optional: sessions that ended with no assistant reply are
    /// not computable from the session cache (the parser drops a trailing
    /// unanswered user turn), so it stays unset until a parse-time capture lands.
    workflow: {
      corrections: number
      correctionRate: number | null
      medianTimeToFirstEditMs: number | null
      unansweredSessions?: number
    }
    /// Files most reworked by edit-family calls (top 8). Path is basename-only
    /// for privacy; distinct sessions and total edit calls per file.
    topReworkedFiles: Array<{ path: string; sessions: number; edits: number }>
    /// Share (0-1) of cost-bearing calls that resolved a price.
    /// null when not computable (no scan data on this path) — "unknown" must
    /// never render as 100% coverage.
    pricingCoverage: number | null
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
    /// Spend attributed by referenced pull request (top 20 by cost) plus the
    /// multi-link-safe distinct total. Rows are by-reference (a session
    /// referencing several PRs counts toward each), so never summed. Absent when
    /// no PR links were observed, and on payloads produced before the field
    /// existed — the client renders its empty state for both.
    pullRequests?: PullRequestsPayload
    /// Per-branch spend (top 15 by cost), last-seen branch carried forward across
    /// each session's turns; a `null` branch is unbranched spend inside a
    /// branch-bearing session. By-reference like the PR rows. Absent when no
    /// branch data was observed, and on payloads produced before the field.
    byBranch?: BranchRow[]
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
    /// Selected-period timeline for the local browser dashboard. Optional for
    /// compatibility with older peers and non-dashboard payload producers.
    timeline?: GranularHistory
  }
  /// Active display currency. Payload cost values are raw USD; the client
  /// multiplies by `rate` and prefixes `symbol` at display time. USD =
  /// { code: 'USD', symbol: '$', rate: 1 }.
  currency: { code: string; symbol: string; rate: number }
  combined?: CombinedUsage
  claudeConfigs?: ClaudeConfigSelector
}

function oneShotRateFor(editTurns: number, oneShotTurns: number): number | null {
  if (editTurns === 0) return null
  return oneShotTurns / editTurns
}

function aggregateOneShotRate(categories: PeriodData['categories']): number | null {
  let edits = 0
  let oneShots = 0
  for (const cat of categories) {
    edits += cat.editTurns
    oneShots += cat.oneShotTurns
  }
  if (edits === 0) return null
  return oneShots / edits
}

function cacheHitPercent(inputTokens: number, cacheReadTokens: number): number {
  const denom = inputTokens + cacheReadTokens
  if (denom === 0) return 0
  return (cacheReadTokens / denom) * 100
}

function buildTopActivities(categories: PeriodData['categories']): MenubarPayload['current']['topActivities'] {
  return categories.slice(0, TOP_ACTIVITIES_LIMIT).map(cat => ({
    name: cat.name,
    cost: cat.cost,
    savingsUSD: cat.savingsUSD,
    turns: cat.turns,
    oneShotRate: oneShotRateFor(cat.editTurns, cat.oneShotTurns),
  }))
}

function buildTopModels(models: PeriodData['models']): MenubarPayload['current']['topModels'] {
  return models
    .filter(m => m.name !== SYNTHETIC_MODEL_NAME)
    .slice(0, TOP_MODELS_LIMIT)
    .map(m => ({ name: m.name, cost: m.cost, calls: m.calls, savingsUSD: m.savingsUSD, savingsBaselineModel: '', estimatedCostUSD: m.estimatedCostUSD ?? 0 }))
}

function buildOptimize(optimize: OptimizeResult | null): MenubarPayload['optimize'] {
  if (!optimize || optimize.findings.length === 0) {
    return { findingCount: 0, savingsUSD: 0, topFindings: [] }
  }
  const { findings, costRate } = optimize
  const totalSavingsUSD = findings.reduce((s, f) => s + f.tokensSaved * costRate, 0)
  const topFindings = findings.slice(0, TOP_FINDINGS_LIMIT).map(f => ({
    title: f.title,
    impact: f.impact,
    savingsUSD: f.tokensSaved * costRate,
  }))
  return {
    findingCount: findings.length,
    savingsUSD: totalSavingsUSD,
    topFindings,
  }
}

function buildProviders(providers: ProviderCost[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const p of providers) {
    if (p.cost < 0) continue
    map[p.displayName.toLowerCase()] = p.cost
  }
  return map
}

function buildProviderDetails(providers: ProviderCost[]): MenubarPayload['current']['providerDetails'] {
  return providers
    .filter(p => p.cost >= 0)
    .map(p => ({ id: p.name, label: p.displayName, cost: p.cost }))
}

function buildHistory(daily: DailyHistoryEntry[] | undefined, timeline?: GranularHistory): MenubarPayload['history'] {
  if (!daily || daily.length === 0) return { daily: [], ...(timeline ? { timeline } : {}) }
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date))
  const trimmed = sorted.slice(-HISTORY_DAYS_LIMIT)
  return { daily: trimmed, ...(timeline ? { timeline } : {}) }
}

function buildTopProjects(projects: PeriodData['projects']): MenubarPayload['current']['topProjects'] {
  return (projects ?? [])
    .filter(p => p.cost > 0 || p.savingsUSD > 0)
    .sort((a, b) => (b.cost + b.savingsUSD) - (a.cost + a.savingsUSD))
    .slice(0, TOP_PROJECTS_LIMIT)
    .map(p => ({
      name: p.name,
      cost: p.cost,
      savingsUSD: p.savingsUSD,
      sessions: p.sessions,
      avgCostPerSession: p.sessions > 0 ? p.cost / p.sessions : 0,
      sessionDetails: (p.sessionDetails ?? []).map(s => ({
        cost: s.cost,
        savingsUSD: s.savingsUSD,
        calls: s.calls,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        date: s.date,
        models: s.models,
      })),
    }))
}

function buildModelEfficiency(models: PeriodData['modelEfficiency']): MenubarPayload['current']['modelEfficiency'] {
  return (models ?? [])
    .filter(m => m.costPerEdit !== null)
    .sort((a, b) => (a.costPerEdit ?? Infinity) - (b.costPerEdit ?? Infinity))
    .slice(0, MODEL_EFFICIENCY_LIMIT)
    .map(m => ({ name: m.name, costPerEdit: m.costPerEdit, oneShotRate: m.oneShotRate }))
}

function buildWorkflow(workflow: PeriodData['workflow']): MenubarPayload['current']['workflow'] {
  return {
    corrections: workflow?.corrections ?? 0,
    correctionRate: workflow?.correctionRate ?? null,
    medianTimeToFirstEditMs: workflow?.medianTimeToFirstEditMs ?? null,
  }
}

function buildTopReworkedFiles(files: PeriodData['topReworkedFiles']): MenubarPayload['current']['topReworkedFiles'] {
  return (files ?? [])
    .slice(0, TOP_REWORKED_FILES_LIMIT)
    // Basename only: the menubar/web payload can leave the machine, so drop the
    // directory path and keep just the file name.
    .map(f => ({ path: f.path.split('/').pop() || f.path, sessions: f.sessions, edits: f.edits }))
}

function buildTopSessions(sessions: PeriodData['topSessions']): MenubarPayload['current']['topSessions'] {
  return (sessions ?? [])
    .sort((a, b) => (b.cost + b.savingsUSD) - (a.cost + a.savingsUSD))
    .slice(0, TOP_SESSIONS_LIMIT)
    .map(s => ({ project: s.project, cost: s.cost, savingsUSD: s.savingsUSD, calls: s.calls, date: s.date }))
}

export type BreakdownArrays = {
  tools?: MenubarPayload['current']['tools']
  skills?: MenubarPayload['current']['skills']
  subagents?: MenubarPayload['current']['subagents']
  mcpServers?: MenubarPayload['current']['mcpServers']
  /// Optional rollup of per-model and per-provider local-model savings.
  /// Computed by the CLI from the parsed projects (we have raw token
  /// + baseline info there, not in `PeriodData`). When omitted, the
  /// menubar payload defaults to an empty savings block — keeping the
  /// schema stable for consumers that don't care about local savings.
  localModelSavings?: LocalModelSavings
}

export function buildMenubarPayload(
  current: PeriodData,
  providers: ProviderCost[],
  optimize: OptimizeResult | null,
  dailyHistory?: DailyHistoryEntry[],
  retryTax?: MenubarPayload['current']['retryTax'],
  routingWaste?: MenubarPayload['current']['routingWaste'],
  breakdowns?: BreakdownArrays,
  claudeConfigs?: ClaudeConfigSelector,
  granularHistory?: GranularHistory,
): MenubarPayload {
  const payload: MenubarPayload = {
    generated: new Date().toISOString(),
    current: {
      label: current.label,
      cost: current.cost,
      calls: current.calls,
      sessions: current.sessions,
      oneShotRate: aggregateOneShotRate(current.categories),
      inputTokens: current.inputTokens,
      outputTokens: current.outputTokens,
      cacheReadTokens: current.cacheReadTokens,
      cacheWriteTokens: current.cacheWriteTokens,
      cacheHitPercent: cacheHitPercent(current.inputTokens, current.cacheReadTokens),
      codexCredits: current.codexCredits ?? 0,
      estimatedCostUSD: current.estimatedCostUSD ?? 0,
      topActivities: buildTopActivities(current.categories),
      topModels: buildTopModels(current.models),
      unpricedModels: current.unpricedModels ?? [],
      localModelSavings: breakdowns?.localModelSavings ?? { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
      providers: buildProviders(providers),
      providerDetails: buildProviderDetails(providers),
      topProjects: buildTopProjects(current.projects ?? []),
      modelEfficiency: buildModelEfficiency(current.modelEfficiency ?? []),
      topSessions: buildTopSessions(current.topSessions ?? []),
      workflow: buildWorkflow(current.workflow),
      topReworkedFiles: buildTopReworkedFiles(current.topReworkedFiles),
      pricingCoverage: current.pricingCoverage ?? null,
      retryTax: retryTax ?? { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: routingWaste ?? { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: breakdowns?.tools ?? [],
      skills: breakdowns?.skills ?? [],
      subagents: breakdowns?.subagents ?? [],
      mcpServers: breakdowns?.mcpServers ?? [],
      // Add-only: emitted only when the producer computed them (all-provider
      // path), omitted otherwise so the schema stays stable for consumers that
      // predate the fields.
      ...(current.pullRequests ? { pullRequests: current.pullRequests } : {}),
      ...(current.byBranch ? { byBranch: current.byBranch } : {}),
    },
    optimize: buildOptimize(optimize),
    history: buildHistory(dailyHistory, granularHistory),
    currency: (() => {
      const c = getCurrency()
      return { code: c.code, symbol: c.symbol, rate: c.rate }
    })(),
  }
  if (claudeConfigs && claudeConfigs.options.length > 1) {
    payload.claudeConfigs = claudeConfigs
  }
  return payload
}
