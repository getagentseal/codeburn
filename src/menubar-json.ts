/// Rollup of one time window (today / 7 days / 30 days / month / 6 months / lifetime) used as the canonical
/// input to the menubar payload. Built inside the CLI and also consumed by the day-aggregator
/// when hydrating per-day cache entries.
export type PeriodData = {
  label: string
  cost: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  categories: Array<{ name: string; cost: number; turns: number; editTurns: number; oneShotTurns: number }>
  models: Array<{ name: string; cost: number; calls: number }>
  projects?: Array<{ name: string; cost: number; sessions: number; sessionDetails?: Array<{ cost: number; calls: number; inputTokens: number; outputTokens: number; date: string; models: Array<{ name: string; cost: number }> }> }>
  modelEfficiency?: Array<{ name: string; costPerEdit: number | null; oneShotRate: number | null }>
  topSessions?: Array<{ project: string; cost: number; calls: number; date: string }>
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
  calls: number
  inputTokens: number
  outputTokens: number
}

export type DailyHistoryEntry = {
  date: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  topModels: DailyModelBreakdown[]
}

export type IntradayHistoryEntry = {
  bucketStartHour: number
  bucketEndHour: number
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  topModels: DailyModelBreakdown[]
}

export type StatsSummaryEntry = {
  trackedSpend: number
  trackedDays: number
  mostActiveDay: string | null
  peakDaySpend: number | null
  currentStreakDays: number
  longestStreakDays: number
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
    cacheHitPercent: number
    topActivities: Array<{
      name: string
      cost: number
      turns: number
      oneShotRate: number | null
    }>
    topModels: Array<{
      name: string
      cost: number
      calls: number
    }>
    providers: Record<string, number>
    topProjects: Array<{
      name: string
      cost: number
      sessions: number
      avgCostPerSession: number
      sessionDetails: Array<{
        cost: number
        calls: number
        inputTokens: number
        outputTokens: number
        date: string
        models: Array<{ name: string; cost: number }>
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
    intraday: IntradayHistoryEntry[]
  }
  stats: StatsSummaryEntry
}

function parseLocalDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, date)
}

function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function buildStatsSummary(days: Array<Pick<DailyHistoryEntry, 'date' | 'cost'>> | undefined): StatsSummaryEntry {
  if (!days || days.length === 0) {
    return {
      trackedSpend: 0,
      trackedDays: 0,
      mostActiveDay: null,
      peakDaySpend: null,
      currentStreakDays: 0,
      longestStreakDays: 0,
    }
  }

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const trackedSpend = sorted.reduce((sum, day) => sum + day.cost, 0)
  const peakDay = sorted.reduce<Pick<DailyHistoryEntry, 'date' | 'cost'> | null>(
    (best, day) => (best === null || day.cost > best.cost ? day : best),
    null,
  )

  const costByDate = new Map(sorted.map(day => [day.date, day.cost]))
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const firstTracked = parseLocalDay(sorted[0]!.date)
  const lastTracked = parseLocalDay(sorted[sorted.length - 1]!.date)

  let currentStreakDays = 0
  let cursor = todayStart
  while (cursor >= firstTracked) {
    const dayKey = toDayKey(cursor)
    if ((costByDate.get(dayKey) ?? 0) > 0) {
      currentStreakDays += 1
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1)
      continue
    }
    break
  }

  let longestStreakDays = 0
  let runningStreak = 0
  cursor = firstTracked
  while (cursor <= lastTracked) {
    const dayKey = toDayKey(cursor)
    if ((costByDate.get(dayKey) ?? 0) > 0) {
      runningStreak += 1
      longestStreakDays = Math.max(longestStreakDays, runningStreak)
    } else {
      runningStreak = 0
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
  }

  return {
    trackedSpend,
    trackedDays: sorted.length,
    mostActiveDay: peakDay?.date ?? null,
    peakDaySpend: peakDay?.cost ?? null,
    currentStreakDays,
    longestStreakDays,
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
    turns: cat.turns,
    oneShotRate: oneShotRateFor(cat.editTurns, cat.oneShotTurns),
  }))
}

function buildTopModels(models: PeriodData['models']): MenubarPayload['current']['topModels'] {
  return models
    .filter(m => m.name !== SYNTHETIC_MODEL_NAME)
    .slice(0, TOP_MODELS_LIMIT)
    .map(m => ({ name: m.name, cost: m.cost, calls: m.calls }))
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

function buildHistory(
  daily: DailyHistoryEntry[] | undefined,
  intraday: IntradayHistoryEntry[] | undefined,
  retainFullDailyHistory = false,
): MenubarPayload['history'] {
  const dailyEntries = !daily || daily.length === 0
    ? []
    : (() => {
        const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date))
        return retainFullDailyHistory ? sorted : sorted.slice(-HISTORY_DAYS_LIMIT)
      })()
  const intradayEntries = !intraday || intraday.length === 0
    ? []
    : [...intraday].sort((a, b) => a.bucketStartHour - b.bucketStartHour)
  return { daily: dailyEntries, intraday: intradayEntries }
}

function buildTopProjects(projects: PeriodData['projects']): MenubarPayload['current']['topProjects'] {
  return (projects ?? [])
    .filter(p => p.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, TOP_PROJECTS_LIMIT)
    .map(p => ({
      name: p.name,
      cost: p.cost,
      sessions: p.sessions,
      avgCostPerSession: p.sessions > 0 ? p.cost / p.sessions : 0,
      sessionDetails: (p.sessionDetails ?? []).map(s => ({
        cost: s.cost,
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
    .sort((a, b) => b.cost - a.cost)
    .slice(0, TOP_SESSIONS_LIMIT)
    .map(s => ({ project: s.project, cost: s.cost, calls: s.calls, date: s.date }))
}

export type BreakdownArrays = {
  tools?: MenubarPayload['current']['tools']
  skills?: MenubarPayload['current']['skills']
  subagents?: MenubarPayload['current']['subagents']
  mcpServers?: MenubarPayload['current']['mcpServers']
}

export function buildMenubarPayload(
  current: PeriodData,
  providers: ProviderCost[],
  optimize: OptimizeResult | null,
  dailyHistory?: DailyHistoryEntry[],
  intradayHistory?: IntradayHistoryEntry[],
  statsHistory?: Array<Pick<DailyHistoryEntry, 'date' | 'cost'>>,
  retryTax?: MenubarPayload['current']['retryTax'],
  routingWaste?: MenubarPayload['current']['routingWaste'],
  retainFullDailyHistory = false,
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
      cacheHitPercent: cacheHitPercent(current.inputTokens, current.cacheReadTokens),
      topActivities: buildTopActivities(current.categories),
      topModels: buildTopModels(current.models),
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
    history: buildHistory(dailyHistory, intradayHistory, retainFullDailyHistory),
    stats: buildStatsSummary(statsHistory),
  }
}
