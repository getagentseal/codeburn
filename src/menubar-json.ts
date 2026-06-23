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
  reasoningTokens?: number
  cacheReadTokens: number
  cacheWriteTokens: number
  categories: Array<{ name: string; cost: number; savingsUSD: number; turns: number; editTurns: number; oneShotTurns: number }>
  models: Array<{ name: string; cost: number; savingsUSD: number; calls: number }>
  projects?: Array<{ name: string; cost: number; savingsUSD: number; sessions: number; inputTokens: number; outputTokens: number; reasoningTokens?: number; cacheReadTokens: number; cacheWriteTokens: number; sessionDetails?: Array<{ cost: number; savingsUSD: number; calls: number; inputTokens: number; outputTokens: number; reasoningTokens?: number; date: string; models: Array<{ name: string; cost: number; savingsUSD: number }> }> }>
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
const TOP_PROJECTS_LIMIT = 5000
const TOP_SESSIONS_LIMIT = 5000
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

export type SubscriptionPlanCost = {
  provider: string
  mode: 'amortized' | 'actual-payments'
  monthlyUsd: number
  allocatedCost: number
  apiEquivalentCost: number
  periodStart: string
  periodEnd: string
}

export type SubscriptionTopUpCost = {
  id: string
  provider: string
  amountUsd: number
  purchasedAt: string
  tokens: number | null
  note: string
}

export type CodexChatsReport = {
  label: string
  provider: 'codex'
  hours: number
  totalChats: number
  returnedChats: number
  totals: {
    calls: number
    cost: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    totalTokens: number
  }
  chats: Array<{
    project: string
    projectDisplayName: string
    projectPath: string
    sessionId: string
    sessionDisplayId: string
    chatTitle: string
    startedAt: string
    lastSeenAt: string
    calls: number
    cost: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    totalTokens: number
    models: Array<{
      name: string
      calls: number
      cost: number
      inputTokens: number
      outputTokens: number
      reasoningTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }>
  }>
}

export type MenubarPayload = {
  generated: string
  current: {
    label: string
    apiEquivalentCost: number
    cost: number
    subscriptionCost: number
    subscriptionCostMode: 'api-equivalent' | 'amortized' | 'actual-payments'
    subscriptionPlans: SubscriptionPlanCost[]
    subscriptionTopUps: SubscriptionTopUpCost[]
    calls: number
    sessions: number
    oneShotRate: number | null
    inputTokens: number
    outputTokens: number
    cacheHitPercent: number
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
      inputTokens: number
      outputTokens: number
      reasoningTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      totalTokens: number
      avgCostPerSession: number
      sessionDetails: Array<{
        cost: number
        savingsUSD: number
        calls: number
        inputTokens: number
        outputTokens: number
        reasoningTokens?: number
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
    codexChats48h: CodexChatsReport
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
  const grouped = new Map<
    string,
    NonNullable<PeriodData['projects']>[number]
  >()
  for (const project of projects ?? []) {
    if (project.sessions <= 0) continue
    const existing = grouped.get(project.name)
    if (existing) {
      existing.cost += project.cost
      existing.savingsUSD += project.savingsUSD
      existing.sessions += project.sessions
      existing.inputTokens += project.inputTokens
      existing.outputTokens += project.outputTokens
      existing.reasoningTokens = (existing.reasoningTokens ?? 0) + (project.reasoningTokens ?? 0)
      existing.cacheReadTokens += project.cacheReadTokens
      existing.cacheWriteTokens += project.cacheWriteTokens
      existing.sessionDetails = [
        ...(existing.sessionDetails ?? []),
        ...(project.sessionDetails ?? []),
      ]
    } else {
      grouped.set(project.name, {
        ...project,
        sessionDetails: [...(project.sessionDetails ?? [])],
      })
    }
  }
  return [...grouped.values()]
    .sort((a, b) => (b.cost + b.savingsUSD) - (a.cost + a.savingsUSD))
    .slice(0, TOP_PROJECTS_LIMIT)
    .map(p => ({
      name: p.name,
      cost: p.cost,
      savingsUSD: p.savingsUSD,
      sessions: p.sessions,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      reasoningTokens: p.reasoningTokens ?? 0,
      cacheReadTokens: p.cacheReadTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      totalTokens: p.inputTokens + p.outputTokens + (p.reasoningTokens ?? 0) + p.cacheReadTokens + p.cacheWriteTokens,
      avgCostPerSession: p.sessions > 0 ? p.cost / p.sessions : 0,
      sessionDetails: (p.sessionDetails ?? []).map(s => ({
        cost: s.cost,
        savingsUSD: s.savingsUSD,
        calls: s.calls,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        reasoningTokens: s.reasoningTokens ?? 0,
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
  codexChats48h?: CodexChatsReport
  apiEquivalentCost?: number
  subscriptionCost?: number
  subscriptionCostMode?: 'api-equivalent' | 'amortized' | 'actual-payments'
  subscriptionPlans?: SubscriptionPlanCost[]
  subscriptionTopUps?: SubscriptionTopUpCost[]
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
      apiEquivalentCost: breakdowns?.apiEquivalentCost ?? current.cost,
      cost: current.cost,
      subscriptionCost: breakdowns?.subscriptionCost ?? 0,
      subscriptionCostMode: breakdowns?.subscriptionCostMode ?? 'api-equivalent',
      subscriptionPlans: breakdowns?.subscriptionPlans ?? [],
      subscriptionTopUps: breakdowns?.subscriptionTopUps ?? [],
      calls: current.calls,
      sessions: current.sessions,
      oneShotRate: aggregateOneShotRate(current.categories),
      inputTokens: current.inputTokens,
      outputTokens: current.outputTokens,
      cacheHitPercent: cacheHitPercent(current.inputTokens, current.cacheReadTokens),
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
      codexChats48h: breakdowns?.codexChats48h ?? {
        label: 'Last 48 hours',
        provider: 'codex',
        hours: 48,
        totalChats: 0,
        returnedChats: 0,
        totals: { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
        chats: [],
      },
    },
    optimize: buildOptimize(optimize),
    history: buildHistory(dailyHistory),
  }
}
