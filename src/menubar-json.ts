import type { BillingMode } from './billing.js'

/// Rollup of one time window (today / 7 days / 30 days / month / all) used as the canonical
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
  models: Array<{ name: string; cost: number; calls: number; credits?: number | null; baseCostUsd?: number | null; billedAmountUsd?: number | null }>
  // Billing mode-specific fields
  creditsAugment?: number | null
  creditsSynthesized?: number
  baseCostUsd?: number | null
  surchargeUsd?: number | null
  billedAmountUsd?: number | null
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

export type MenubarPayload = {
  generated: string
  billing?: {
    mode: BillingMode
    creditsPerDollar?: number
    surchargeRate?: number
  }
  current: {
    label: string
    cost: number | null
    calls: number
    sessions: number
    oneShotRate: number | null
    inputTokens: number
    outputTokens: number
    cacheHitPercent: number
    // Billing mode-specific fields
    creditsAugment?: number | null
    creditsSynthesized?: number
    baseCostUsd?: number | null
    surchargeUsd?: number | null
    billedAmountUsd?: number | null
    topActivities: Array<{
      name: string
      cost: number
      turns: number
      oneShotRate: number | null
    }>
    topModels: Array<{
      name: string
      cost: number | null
      calls: number
      creditsAugment?: number | null
      baseCostUsd?: number | null
      billedAmountUsd?: number | null
    }>
    providers: Record<string, number>
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
    turns: cat.turns,
    oneShotRate: oneShotRateFor(cat.editTurns, cat.oneShotTurns),
  }))
}

function buildTopModels(models: PeriodData['models'], billingMode?: BillingMode): MenubarPayload['current']['topModels'] {
  return models
    .filter(m => m.name !== SYNTHETIC_MODEL_NAME)
    .slice(0, TOP_MODELS_LIMIT)
    .map(m => {
      const base: MenubarPayload['current']['topModels'][number] = {
        name: m.name,
        cost: billingMode === 'credits' ? null : (m.billedAmountUsd ?? m.cost),
        calls: m.calls,
      }
      if (billingMode === 'credits') {
        base.creditsAugment = m.credits ?? null
      } else if (billingMode === 'token_plus') {
        base.baseCostUsd = m.baseCostUsd ?? null
        base.billedAmountUsd = m.billedAmountUsd ?? null
      }
      return base
    })
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

import { loadBillingConfig, CREDITS_PER_DOLLAR, type BillingConfig } from './billing.js'

export function buildMenubarPayload(
  current: PeriodData,
  providers: ProviderCost[],
  optimize: OptimizeResult | null,
  dailyHistory?: DailyHistoryEntry[],
  billingConfig?: BillingConfig,
): MenubarPayload {
  const config = billingConfig ?? loadBillingConfig()

  // Build billing metadata
  const billing: MenubarPayload['billing'] = {
    mode: config.mode,
  }
  if (config.mode === 'credits') {
    billing.creditsPerDollar = CREDITS_PER_DOLLAR
  } else {
    billing.surchargeRate = config.surchargeRate
  }

  // Build current section with billing-aware fields
  const currentSection: MenubarPayload['current'] = {
    label: current.label,
    cost: config.mode === 'credits' ? null : (current.billedAmountUsd ?? current.cost),
    calls: current.calls,
    sessions: current.sessions,
    oneShotRate: aggregateOneShotRate(current.categories),
    inputTokens: current.inputTokens,
    outputTokens: current.outputTokens,
    cacheHitPercent: cacheHitPercent(current.inputTokens, current.cacheReadTokens),
    topActivities: buildTopActivities(current.categories),
    topModels: buildTopModels(current.models, config.mode),
    providers: buildProviders(providers),
  }

  // Add billing mode-specific fields
  if (config.mode === 'credits') {
    currentSection.creditsAugment = current.creditsAugment ?? null
    currentSection.creditsSynthesized = current.creditsSynthesized ?? 0
  } else {
    currentSection.baseCostUsd = current.baseCostUsd ?? null
    currentSection.surchargeUsd = current.surchargeUsd ?? null
    currentSection.billedAmountUsd = current.billedAmountUsd ?? null
  }

  return {
    generated: new Date().toISOString(),
    billing,
    current: currentSection,
    optimize: buildOptimize(optimize),
    history: buildHistory(dailyHistory),
  }
}
