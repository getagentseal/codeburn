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
  models: Array<{ name: string; cost: number; savingsUSD: number; calls: number }>
  projects?: Array<{ name: string; cost: number; savingsUSD: number; sessions: number; sessionDetails?: Array<{ cost: number; savingsUSD: number; calls: number; inputTokens: number; outputTokens: number; date: string; models: Array<{ name: string; cost: number; savingsUSD: number }> }> }>
  modelEfficiency?: Array<{ name: string; costPerEdit: number | null; oneShotRate: number | null }>
  topSessions?: Array<{ project: string; cost: number; savingsUSD: number; calls: number; date: string }>
}

export type ProviderCost = {
  name: string
  cost: number
}
import type { OptimizeResult } from './optimize.js'

const TOP_ACTIVITIES_LIMIT = 20
const TOP_MODELS_LIMIT = 20
const TOP_FINDINGS_LIMIT = 10
const HISTORY_DAYS_LIMIT = 365
const SYNTHETIC_MODEL_NAME = '<synthetic>'
const TOP_PROJECTS_LIMIT = 5
const TOP_SESSIONS_LIMIT = 3
const MODEL_EFFICIENCY_LIMIT = 5

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
    /// Local-model savings rollup, distinct from the routing-waste /
    /// optimize savings concepts which describe hypothetical optimization
    /// opportunities. This block tracks counterfactual spend that was
    /// already avoided because the user ran a local model mapped via
    /// `codeburn model-savings`.
    localModelSavings: LocalModelSavings
    providers: Record<string, number>
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
  combined?: CombinedUsage
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
    .map(m => ({ name: m.name, cost: m.cost, calls: m.calls, savingsUSD: m.savingsUSD, savingsBaselineModel: '' }))
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
    map[p.name.toLowerCase()] = p.cost
  }
  return map
}

function buildHistory(daily: DailyHistoryEntry[] | undefined): MenubarPayload['history'] {
  if (!daily || daily.length === 0) return { daily: [] }
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date))
  const trimmed = sorted.slice(-HISTORY_DAYS_LIMIT)
  return { daily: trimmed }
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
): MenubarPayload {
  return {
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
      topActivities: buildTopActivities(current.categories),
      topModels: buildTopModels(current.models),
      localModelSavings: breakdowns?.localModelSavings ?? { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
      providers: buildProviders(providers),
      topProjects: buildTopProjects(current.projects ?? []),
      modelEfficiency: buildModelEfficiency(current.modelEfficiency ?? []),
      topSessions: buildTopSessions(current.topSessions ?? []),
      retryTax: retryTax ?? { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: routingWaste ?? { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: breakdowns?.tools ?? [],
      skills: breakdowns?.skills ?? [],
      subagents: breakdowns?.subagents ?? [],
      mcpServers: breakdowns?.mcpServers ?? [],
    },
    optimize: buildOptimize(optimize),
    history: buildHistory(dailyHistory),
  }
}
